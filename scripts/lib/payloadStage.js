'use strict';

/**
 * Verify, stage and activate payloads (documentation/packaging.md, issue #328).
 *
 * Node built-ins only: the payload ships this file next to
 * scripts/package-smoke.js, and the manager (#323) calls it from a
 * `payload.*` operation. Nothing here imports the manager or packages/core.
 *
 * A payload directory holds the signed release manifest
 * (`payload-manifest.json`, the catalogue of every file the release has, each
 * with its owner), its Ed25519 signature (`payload-manifest.sig`, base64 over
 * the canonical manifest bytes) and an unsigned local `payload-selection.json`
 * naming the features this copy carries. The selection can only pick groups
 * the signed manifest defines, and verification then expects exactly their
 * files: every selected file present with the signed size and SHA-256, every
 * other file absent. No selection file means every group.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_VERSION = 1;
const CORE = 'core';
const MANIFEST_FILE = 'payload-manifest.json';
const SIGNATURE_FILE = 'payload-manifest.sig';
const SELECTION_FILE = 'payload-selection.json';
const INSTALLED_FEATURES_FILE = 'app/apps/web/dist/installed-features.json';
/** Written per copy from the selection, so they are not in the signed catalogue. */
const LOCAL_FILES = [MANIFEST_FILE, SIGNATURE_FILE, SELECTION_FILE, INSTALLED_FEATURES_FILE];
const PARTIAL_SUFFIX = '.partial';
const DEV_UNSIGNED_ENV = 'GOOBSTER_PAYLOAD_DEV_UNSIGNED';
const SAMPLE = 5;

const CODES = Object.freeze({
    MANIFEST_MISSING: 'MANIFEST_MISSING',
    MANIFEST_INVALID: 'MANIFEST_INVALID',
    SIGNATURE_MISSING: 'SIGNATURE_MISSING',
    SIGNATURE_INVALID: 'SIGNATURE_INVALID',
    UNSIGNED_DEV_ONLY: 'UNSIGNED_DEV_ONLY',
    PATH_TRAVERSAL: 'PATH_TRAVERSAL',
    LINK_ESCAPES_ROOT: 'LINK_ESCAPES_ROOT',
    TARGET_MISMATCH: 'TARGET_MISMATCH',
    ABI_MISMATCH: 'ABI_MISMATCH',
    INCOMPLETE: 'INCOMPLETE',
    EXTRA_FILE: 'EXTRA_FILE',
    VERSION_INCOMPATIBLE: 'VERSION_INCOMPATIBLE',
    SELECTION_UNAVAILABLE: 'SELECTION_UNAVAILABLE',
    ACTIVATE_FAILED: 'ACTIVATE_FAILED'
});

/**
 * @typedef {Object} ReleaseManifest
 * @property {1} version
 * @property {{ core: string, compatibleCore: string }} release
 * @property {{ id: string, platform: string, arch: string }} target
 * @property {{ version: string, abi: string }} node
 * @property {Object<string, { files: string[], dependencies: string[], requires?: string[],
 *   frontend?: string[], system: Array<{ name: string, kind: string }>, compatibleCore?: string }>} groups
 * @property {Array<{ path: string, size: number, sha256: string, owner: string, dependency?: string }>} files
 * @property {Array<{ name: string, path: string|null, owners: string[], exclusive: boolean }>} dependencies
 * @property {{ chunks: Array<{ file: string, feature: string }> }} frontend
 * @property {{ algorithm: 'ed25519', keyId: string }} [signing]
 */

/**
 * @typedef {Object} Selection
 * @property {string[]} features   feature ids; `core` and every `requires` are added
 * @property {string} [profile]    a label (`minimal`, `full`, `custom`)
 */

/**
 * @typedef {Object} VerifyOptions
 * @property {string} [expectedTarget]  e.g. `linux-x64`
 * @property {string|number} [nodeAbi]  e.g. process.versions.modules
 * @property {string} [coreVersion]     the core version that will run the features
 * @property {string|crypto.KeyObject|Array<string|crypto.KeyObject>} [publicKey]  trusted Ed25519 key(s), PEM or KeyObject
 * @property {boolean} [devMode]        accept an unsigned payload; defaults to GOOBSTER_PAYLOAD_DEV_UNSIGNED=1
 * @property {boolean} [hash]           compare SHA-256 as well as size (default true)
 */

/**
 * @typedef {Object} VerifyResult
 * @property {true} ok
 * @property {string} releaseId
 * @property {boolean} signed
 * @property {boolean} devMode      true when the payload was accepted without a checked signature
 * @property {string|null} keyId
 * @property {string} target
 * @property {string} abi
 * @property {string} core
 * @property {string[]} features
 * @property {string|null} profile
 * @property {number} files
 * @property {number} bytes
 */

class PayloadError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PayloadError';
        this.code = code;
        this.details = details;
    }
}

function fail(code, message, details) {
    throw new PayloadError(code, message, details);
}

/** Canonical JSON: object keys sorted, two-space indent, LF, trailing newline. */
function canonicalJson(value) {
    const normalize = (item) => {
        if (Array.isArray(item)) return item.map(normalize);
        if (item && typeof item === 'object') {
            const out = {};
            for (const key of Object.keys(item).sort()) {
                if (item[key] !== undefined) out[key] = normalize(item[key]);
            }
            return out;
        }
        return item;
    };
    return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function canonicalBytes(manifest) {
    return Buffer.from(canonicalJson(manifest), 'utf8');
}

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

function parseVersion(text) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim());
    if (!match) return null;
    return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || null };
}

function compareParsed(a, b) {
    for (let i = 0; i < 3; i += 1) if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
    if (a.pre === b.pre) return 0;
    if (!a.pre) return 1;
    if (!b.pre) return -1;
    return a.pre < b.pre ? -1 : 1;
}

/** `version` satisfies `range` (space-separated `>=`, `>`, `<=`, `<`, `=` comparators; `||` alternatives). */
function satisfies(version, range) {
    const parsed = parseVersion(version);
    if (!parsed || typeof range !== 'string' || !range.trim()) return false;
    return range.split('||').some((alternative) => {
        const comparators = alternative.trim().split(/\s+/).filter(Boolean);
        if (!comparators.length) return false;
        return comparators.every((comparator) => {
            const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator);
            const bound = match && parseVersion(match[2]);
            if (!bound) return false;
            const order = compareParsed(parsed, bound);
            switch (match[1] || '=') {
            case '>=': return order >= 0;
            case '>': return order > 0;
            case '<=': return order <= 0;
            case '<': return order < 0;
            default: return order === 0;
            }
        });
    });
}

// ---------------------------------------------------------------------------
// manifest shape and paths
// ---------------------------------------------------------------------------

/** Why `rel` is not a safe payload-relative POSIX path, or null. */
function unsafePathReason(rel) {
    if (typeof rel !== 'string' || rel.length === 0) return 'empty or not a string';
    if (rel.includes('\0')) return 'contains NUL';
    if (rel.includes('\\')) return 'contains a backslash';
    if (rel.startsWith('/')) return 'absolute';
    if (/^[A-Za-z]:/.test(rel)) return 'drive letter';
    const parts = rel.split('/');
    if (parts.some(part => part === '..')) return 'parent segment';
    if (parts.some(part => part === '' || part === '.')) return 'empty or dot segment';
    return null;
}

function validateManifest(manifest) {
    const problems = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) problems.push('not an object');
    else {
        if (manifest.version !== MANIFEST_VERSION) problems.push(`version ${JSON.stringify(manifest.version)} is not ${MANIFEST_VERSION}`);
        if (!manifest.release || typeof manifest.release.core !== 'string' || typeof manifest.release.compatibleCore !== 'string') problems.push('release.core / release.compatibleCore');
        if (!manifest.target || typeof manifest.target.id !== 'string') problems.push('target.id');
        if (!manifest.node || manifest.node.abi === undefined || manifest.node.abi === null) problems.push('node.abi');
        if (!manifest.groups || typeof manifest.groups !== 'object' || !manifest.groups[CORE]) problems.push('groups.core');
        if (!Array.isArray(manifest.files)) problems.push('files');
        if (!Array.isArray(manifest.dependencies)) problems.push('dependencies');
        if (!manifest.frontend || !Array.isArray(manifest.frontend.chunks)) problems.push('frontend.chunks');
        if (manifest.signing !== undefined && (manifest.signing?.algorithm !== 'ed25519' || typeof manifest.signing?.keyId !== 'string')) problems.push('signing');
    }
    if (problems.length) fail(CODES.MANIFEST_INVALID, `payload-manifest.json is not a v${MANIFEST_VERSION} release manifest: ${problems.join(', ')}`, { problems });

    const seen = new Set();
    for (const file of manifest.files) {
        if (!file || typeof file.size !== 'number' || typeof file.sha256 !== 'string' || typeof file.owner !== 'string') {
            fail(CODES.MANIFEST_INVALID, 'a files[] entry lacks size, sha256 or owner');
        }
        const reason = unsafePathReason(file.path);
        if (reason) fail(CODES.PATH_TRAVERSAL, `manifest path rejected (${reason})`, { path: String(file.path).replace(/\0/g, '\\0') });
        if (LOCAL_FILES.includes(file.path)) fail(CODES.MANIFEST_INVALID, `${file.path} is a local file and cannot be in the catalogue`);
        if (seen.has(file.path)) fail(CODES.MANIFEST_INVALID, `duplicate manifest path ${file.path}`);
        seen.add(file.path);
        if (!manifest.groups[file.owner]) fail(CODES.MANIFEST_INVALID, `${file.path} is owned by unknown group ${file.owner}`);
    }
    for (const dep of manifest.dependencies) {
        if (dep.path !== null && dep.path !== undefined) {
            const reason = unsafePathReason(dep.path);
            if (reason) fail(CODES.PATH_TRAVERSAL, `dependency path rejected (${reason})`, { path: String(dep.path) });
        }
    }
    for (const chunk of manifest.frontend.chunks) {
        const reason = unsafePathReason(chunk.file);
        if (reason) fail(CODES.PATH_TRAVERSAL, `chunk path rejected (${reason})`, { path: String(chunk.file) });
    }
    return manifest;
}

function releaseIdOf(manifest) {
    const digest = crypto.createHash('sha256').update(canonicalBytes(manifest)).digest('hex').slice(0, 12);
    return `${manifest.release.core}-${manifest.target.id}-${digest}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

/** `ids` plus everything they require, from the manifest's own groups. */
function closeOverRequires(manifest, ids) {
    const wanted = new Set([CORE]);
    const add = (id) => {
        if (!manifest.groups[id]) throw Object.assign(new Error(`Unknown feature "${id}"`), { code: 'UNKNOWN_FEATURE' });
        if (wanted.has(id)) return;
        wanted.add(id);
        for (const dep of manifest.groups[id].requires || []) add(dep);
    };
    for (const id of ids) if (id !== CORE) add(id);
    return wanted;
}

/**
 * Resolve a selection against a release manifest. A dependency directory is
 * kept while any of its owners is selected; a file inside one follows it.
 * @param {ReleaseManifest} manifest
 * @param {{ features?: string[] }} selection
 * @returns {{ features: string[], files: string[], dependencies: string[], chunks: string[],
 *   excluded: { features: string[], files: string[], dependencies: string[], chunks: string[] } }}
 *   feature lists are `core` first, then alphabetical; dependencies are payload
 *   directories; chunks are dist-relative files
 */
function selectPayload(manifest, { features = [] } = {}) {
    const selected = closeOverRequires(manifest, features);
    const keepDep = new Map();
    const depsByName = new Map();
    for (const dep of manifest.dependencies) {
        keepDep.set(dep.path, dep.owners.some(owner => selected.has(owner)));
        if (!depsByName.has(dep.name)) depsByName.set(dep.name, []);
        depsByName.get(dep.name).push(dep);
    }
    for (const list of depsByName.values()) list.sort((a, b) => (b.path || '').length - (a.path || '').length);
    const keepFile = (file) => {
        if (file.dependency) {
            const dep = (depsByName.get(file.dependency) || []).find(item => item.path && file.path.startsWith(`${item.path}/`));
            return dep ? keepDep.get(dep.path) : true;
        }
        return selected.has(file.owner);
    };
    const files = { keep: [], drop: [] };
    for (const file of manifest.files) (keepFile(file) ? files.keep : files.drop).push(file.path);
    const deps = { keep: [], drop: [] };
    for (const dep of manifest.dependencies) (keepDep.get(dep.path) ? deps.keep : deps.drop).push(dep.path);
    const chunks = { keep: [], drop: [] };
    for (const chunk of manifest.frontend.chunks) (selected.has(chunk.feature) ? chunks.keep : chunks.drop).push(chunk.file);
    const ids = [CORE, ...Object.keys(manifest.groups).filter(id => id !== CORE).sort()];
    return {
        features: ids.filter(id => selected.has(id)),
        files: files.keep,
        dependencies: deps.keep,
        chunks: chunks.keep,
        excluded: {
            features: ids.filter(id => !selected.has(id)),
            files: files.drop,
            dependencies: deps.drop,
            chunks: chunks.drop
        }
    };
}

function readJson(file, code, label) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        fail(code, `${label} is unreadable (${error.code || 'error'})`);
    }
    try {
        return JSON.parse(text);
    } catch {
        return fail(code, `${label} is not valid JSON`);
    }
}

/** The payload's selection file, or null when it carries every group. */
function readSelection(dir) {
    const selection = readJson(path.join(dir, SELECTION_FILE), CODES.MANIFEST_INVALID, SELECTION_FILE);
    if (selection === undefined) return null;
    if (!selection || selection.version !== 1 || !Array.isArray(selection.features) || selection.features.some(id => typeof id !== 'string')) {
        fail(CODES.MANIFEST_INVALID, `${SELECTION_FILE} is not a v1 selection`);
    }
    return { features: selection.features, profile: typeof selection.profile === 'string' ? selection.profile : null };
}

function selectionDocument(resolved, profile) {
    return { version: 1, profile: profile || null, features: resolved.features };
}

/** `installed-features.json` for the portal: the selected feature ids, core excluded (frontendChunks.pruneDist's format). */
function installedFeaturesDocument(resolved) {
    return { version: 1, features: resolved.features.filter(id => id !== CORE).sort() };
}

function resolveSelection(manifest, selection) {
    try {
        return selectPayload(manifest, { features: selection ? selection.features : Object.keys(manifest.groups) });
    } catch (error) {
        if (error.code === 'UNKNOWN_FEATURE') fail(CODES.MANIFEST_INVALID, `the selection names a feature the manifest does not define: ${error.message}`);
        throw error;
    }
}

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

function toPublicKey(key) {
    if (key instanceof crypto.KeyObject) return key.type === 'public' ? key : crypto.createPublicKey(key);
    return crypto.createPublicKey(key);
}

/** Short stable id of an Ed25519 public key: the first 16 hex of SHA-256 over its SPKI DER. */
function keyIdOf(key) {
    const der = toPublicKey(key).export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/**
 * Sign a manifest. Returns the manifest with `signing` set (part of the signed
 * bytes) and the base64 signature for `payload-manifest.sig`.
 * @param {ReleaseManifest} manifest
 * @param {string|crypto.KeyObject} privateKey  Ed25519, PEM or KeyObject
 */
function signManifest(manifest, privateKey) {
    const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key must be Ed25519');
    const signed = { ...manifest, signing: { algorithm: 'ed25519', keyId: keyIdOf(crypto.createPublicKey(key)) } };
    const signature = crypto.sign(null, canonicalBytes(signed), key).toString('base64');
    return { manifest: signed, signature };
}

/** Write the canonical manifest (and the signature when given) into `dir`. */
function writeManifest(dir, manifest, signature = null) {
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), canonicalJson(manifest));
    if (signature) fs.writeFileSync(path.join(dir, SIGNATURE_FILE), `${signature}\n`);
    else fs.rmSync(path.join(dir, SIGNATURE_FILE), { force: true });
}

/** Generate an Ed25519 development keypair under `dir` (private key 0o600, never logged). */
function generateDevKeyPair(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const privatePath = path.join(dir, 'payload-dev-key.pem');
    const publicPath = path.join(dir, 'payload-dev-key.pub.pem');
    for (const file of [privatePath, publicPath]) {
        if (fs.existsSync(file)) throw new Error(`${path.basename(file)} already exists in that directory; refusing to overwrite a key`);
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    fs.chmodSync(privatePath, 0o600);
    fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
    return { privateKeyPath: privatePath, publicKeyPath: publicPath, keyId: keyIdOf(publicKey) };
}

function checkSignature(dir, manifest, { publicKey, devMode }) {
    const sigPath = path.join(dir, SIGNATURE_FILE);
    let signature = null;
    try {
        signature = fs.readFileSync(sigPath, 'utf8').trim();
    } catch (error) {
        if (error.code !== 'ENOENT') fail(CODES.SIGNATURE_INVALID, `${SIGNATURE_FILE} is unreadable (${error.code || 'error'})`);
    }
    const trusted = (publicKey === undefined || publicKey === null ? [] : Array.isArray(publicKey) ? publicKey : [publicKey]).map(toPublicKey);

    if (!signature) {
        if (devMode) return { signed: false, devMode: true, keyId: null };
        if (manifest.signing) fail(CODES.SIGNATURE_MISSING, `the manifest says it is signed by key ${manifest.signing.keyId} but ${SIGNATURE_FILE} is missing`);
        return fail(CODES.UNSIGNED_DEV_ONLY, `this payload is unsigned; it is accepted only in development mode (${DEV_UNSIGNED_ENV}=1)`);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) fail(CODES.SIGNATURE_INVALID, `${SIGNATURE_FILE} is not base64`);
    if (!manifest.signing) fail(CODES.SIGNATURE_INVALID, `${SIGNATURE_FILE} is present but the manifest names no signing key`);
    if (!trusted.length) {
        if (devMode) return { signed: false, devMode: true, keyId: manifest.signing.keyId };
        return fail(CODES.SIGNATURE_INVALID, `signed by key ${manifest.signing.keyId}, but no trusted public key was supplied`);
    }
    const key = trusted.find(candidate => keyIdOf(candidate) === manifest.signing.keyId);
    if (!key) fail(CODES.SIGNATURE_INVALID, `signed by key ${manifest.signing.keyId}, which is not one of the trusted keys`);
    if (!crypto.verify(null, canonicalBytes(manifest), key, Buffer.from(signature, 'base64'))) {
        fail(CODES.SIGNATURE_INVALID, 'the signature does not match the manifest');
    }
    return { signed: true, devMode: false, keyId: manifest.signing.keyId };
}

// ---------------------------------------------------------------------------
// the tree
// ---------------------------------------------------------------------------

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!read) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Every entry under `root` without following links. */
function walkTree(root) {
    const files = new Map();
    const links = [];
    const other = [];
    const visit = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const stat = fs.lstatSync(full);
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (stat.isSymbolicLink()) {
                let target = fs.readlinkSync(full);
                target = path.resolve(path.dirname(full), target);
                let real = target;
                try { real = fs.realpathSync(full); } catch { /* dangling: judge the literal target */ }
                links.push({ rel, escapes: !inside(root, target) || !inside(root, real) });
            } else if (stat.isDirectory()) visit(full);
            else if (stat.isFile()) files.set(rel, { size: stat.size, full, mode: stat.mode & 0o777 });
            else other.push(rel);
        }
    };
    visit(root);
    return { files, links, other };
}

function sample(list) {
    return list.slice(0, SAMPLE);
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

function loadManifest(dir) {
    const manifest = readJson(path.join(dir, MANIFEST_FILE), CODES.MANIFEST_INVALID, MANIFEST_FILE);
    if (manifest === undefined) fail(CODES.MANIFEST_MISSING, `${MANIFEST_FILE} not found in the payload`);
    return validateManifest(manifest);
}

function checkCompatibility(manifest, resolved, { expectedTarget, nodeAbi, coreVersion }) {
    if (expectedTarget !== undefined && expectedTarget !== null && manifest.target.id !== expectedTarget) {
        fail(CODES.TARGET_MISMATCH, `payload target ${manifest.target.id} is not ${expectedTarget}`, { target: manifest.target.id, expected: expectedTarget });
    }
    if (nodeAbi !== undefined && nodeAbi !== null && String(manifest.node.abi) !== String(nodeAbi)) {
        fail(CODES.ABI_MISMATCH, `payload Node ABI ${manifest.node.abi} is not ${nodeAbi}`, { abi: String(manifest.node.abi), expected: String(nodeAbi) });
    }
    if (!satisfies(manifest.release.core, manifest.release.compatibleCore)) {
        fail(CODES.VERSION_INCOMPATIBLE, `release core ${manifest.release.core} is outside its own compatible range ${manifest.release.compatibleCore}`);
    }
    const core = coreVersion || manifest.release.core;
    if (coreVersion && !satisfies(coreVersion, manifest.release.compatibleCore)) {
        fail(CODES.VERSION_INCOMPATIBLE, `core ${coreVersion} is outside this release's compatible range ${manifest.release.compatibleCore}`);
    }
    for (const id of resolved.features) {
        const range = manifest.groups[id].compatibleCore;
        if (range && !satisfies(core, range)) {
            fail(CODES.VERSION_INCOMPATIBLE, `feature ${id} needs core ${range}, not ${core}`, { feature: id });
        }
    }
}

/**
 * Verify a payload directory against its manifest, signature and selection.
 * Throws a PayloadError whose `code` is one of CODES; never activates anything.
 * @param {string} dir
 * @param {VerifyOptions} [options]
 * @returns {VerifyResult}
 */
function verifyPayload(dir, options = {}) {
    const devMode = options.devMode === undefined ? process.env[DEV_UNSIGNED_ENV] === '1' : options.devMode === true;
    const hash = options.hash !== false;
    let root;
    try {
        root = fs.realpathSync(dir);
    } catch {
        return fail(CODES.MANIFEST_MISSING, 'the payload directory does not exist');
    }
    const manifest = loadManifest(root);
    const signature = checkSignature(root, manifest, { publicKey: options.publicKey, devMode });
    const selection = readSelection(root);
    const resolved = resolveSelection(manifest, selection);
    checkCompatibility(manifest, resolved, options);

    const tree = walkTree(root);
    const escaping = tree.links.filter(link => link.escapes).map(link => link.rel);
    if (escaping.length) fail(CODES.LINK_ESCAPES_ROOT, `${escaping.length} link(s) resolve outside the payload, e.g. ${escaping[0]}`, { links: sample(escaping) });

    const byPath = new Map(manifest.files.map(file => [file.path, file]));
    const expected = new Set(resolved.files);
    const missing = [];
    const changed = [];
    let bytes = 0;
    for (const relPath of resolved.files) {
        const entry = byPath.get(relPath);
        const found = tree.files.get(relPath);
        if (!found) {
            missing.push(relPath);
            continue;
        }
        if (found.size !== entry.size || (hash && sha256File(found.full) !== entry.sha256)) changed.push(relPath);
        bytes += found.size;
    }
    if (missing.length || changed.length) {
        const first = missing[0] ? `${missing[0]} is missing` : `${changed[0]} differs from the manifest`;
        fail(CODES.INCOMPLETE, `${missing.length} missing and ${changed.length} changed file(s): ${first}`, { missing: sample(missing), changed: sample(changed), missingCount: missing.length, changedCount: changed.length });
    }

    const extra = [...tree.links.map(link => link.rel), ...tree.other];
    for (const relPath of tree.files.keys()) if (!expected.has(relPath) && !LOCAL_FILES.includes(relPath)) extra.push(relPath);
    if (extra.length) {
        const listed = extra.filter(relPath => byPath.has(relPath)).length;
        fail(CODES.EXTRA_FILE, `${extra.length} file(s) not in this selection, e.g. ${extra[0]}${listed ? ` (${listed} belong to features this copy does not carry)` : ''}`, { extra: sample(extra), extraCount: extra.length });
    }
    const installed = tree.files.get(INSTALLED_FEATURES_FILE);
    if (installed) {
        const recorded = readJson(installed.full, CODES.MANIFEST_INVALID, INSTALLED_FEATURES_FILE);
        if (canonicalJson(recorded) !== canonicalJson(installedFeaturesDocument(resolved))) {
            fail(CODES.MANIFEST_INVALID, `${INSTALLED_FEATURES_FILE} does not match the selection`);
        }
    }

    return {
        ok: true,
        releaseId: releaseIdOf(manifest),
        signed: signature.signed,
        devMode: signature.devMode,
        keyId: signature.keyId,
        target: manifest.target.id,
        abi: String(manifest.node.abi),
        core: manifest.release.core,
        features: resolved.features,
        profile: selection ? selection.profile : null,
        files: resolved.files.length,
        bytes
    };
}

// ---------------------------------------------------------------------------
// stage and activate
// ---------------------------------------------------------------------------

function fsyncPath(target) {
    let fd;
    try {
        fd = fs.openSync(target, 'r');
        fs.fsyncSync(fd);
    } catch { /* directories cannot be fsynced on every platform (Windows) */ } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
}

/** Copy one file, hashing what was read, and fsync it. Returns the SHA-256 of the bytes written. */
function copyVerified(from, to, mode) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const hash = crypto.createHash('sha256');
    const input = fs.openSync(from, 'r');
    const output = fs.openSync(to, 'wx', mode);
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        for (;;) {
            const read = fs.readSync(input, buffer, 0, buffer.length, null);
            if (!read) break;
            hash.update(buffer.subarray(0, read));
            let written = 0;
            while (written < read) written += fs.writeSync(output, buffer, written, read - written);
        }
        fs.fsyncSync(output);
    } finally {
        fs.closeSync(input);
        fs.closeSync(output);
    }
    fs.chmodSync(to, mode);
    return hash.digest('hex');
}

/**
 * Copy the files of `selection` out of one or more verified payloads into a
 * new staging directory, verify the copy, and return it. The copy is built in
 * `<stagingRoot>/<releaseId>-<random>.partial/` and renamed to drop the suffix
 * only once it verifies, so an interrupted stage is recognisable (cleanStaging
 * removes it) and is never mistaken for a ready one.
 * @param {string|string[]} sources  payload directories, searched in order for each file
 * @param {string} stagingRoot
 * @param {Selection} selection
 * @param {VerifyOptions & { onFile?: (path: string, index: number, total: number) => void }} [options]
 * @returns {{ stagingDir: string, releaseId: string, features: string[], files: number, bytes: number, verified: VerifyResult }}
 */
function stageSelection(sources, stagingRoot, selection, options = {}) {
    const dirs = (Array.isArray(sources) ? sources : [sources]).map(dir => fs.realpathSync(dir));
    const verifyOptions = { ...options };
    delete verifyOptions.onFile;
    const verified = dirs.map(dir => ({ dir, result: verifyPayload(dir, verifyOptions), manifest: loadManifest(dir) }));
    const reference = canonicalJson(verified[0].manifest);
    for (const item of verified.slice(1)) {
        if (canonicalJson(item.manifest) !== reference) fail(CODES.MANIFEST_INVALID, 'the sources are copies of different releases');
    }
    const manifest = verified[0].manifest;
    const resolved = resolveSelection(manifest, selection);
    const byPath = new Map(manifest.files.map(file => [file.path, file]));
    const carried = verified.map(item => new Set(resolveSelection(manifest, readSelection(item.dir)).files));
    const unavailable = resolved.files.filter(relPath => !carried.some(set => set.has(relPath)));
    if (unavailable.length) {
        fail(CODES.SELECTION_UNAVAILABLE, `${unavailable.length} selected file(s) are in none of the source payloads, e.g. ${unavailable[0]}`, { missing: sample(unavailable) });
    }

    fs.mkdirSync(stagingRoot, { recursive: true });
    const name = `${releaseIdOf(manifest)}-${crypto.randomBytes(4).toString('hex')}`;
    const partial = path.join(stagingRoot, `${name}${PARTIAL_SUFFIX}`);
    fs.mkdirSync(partial);
    let bytes = 0;
    try {
        resolved.files.forEach((relPath, index) => {
            if (options.onFile) options.onFile(relPath, index, resolved.files.length);
            const source = dirs[carried.findIndex(set => set.has(relPath))];
            const from = path.join(source, ...relPath.split('/'));
            const mode = fs.statSync(from).mode & 0o777;
            const written = copyVerified(from, path.join(partial, ...relPath.split('/')), mode);
            if (written !== byPath.get(relPath).sha256) {
                fail(CODES.INCOMPLETE, `${relPath} changed in the source while it was staged`, { changed: [relPath] });
            }
            bytes += byPath.get(relPath).size;
        });
        fs.copyFileSync(path.join(dirs[0], MANIFEST_FILE), path.join(partial, MANIFEST_FILE));
        if (fs.existsSync(path.join(dirs[0], SIGNATURE_FILE))) fs.copyFileSync(path.join(dirs[0], SIGNATURE_FILE), path.join(partial, SIGNATURE_FILE));
        fs.writeFileSync(path.join(partial, SELECTION_FILE), canonicalJson(selectionDocument(resolved, selection.profile)));
        if (resolved.files.some(relPath => relPath.startsWith('app/apps/web/dist/'))) {
            const target = path.join(partial, ...INSTALLED_FEATURES_FILE.split('/'));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, canonicalJson(installedFeaturesDocument(resolved)));
        }
        for (const file of [MANIFEST_FILE, SIGNATURE_FILE, SELECTION_FILE]) if (fs.existsSync(path.join(partial, file))) fsyncPath(path.join(partial, file));
        const dirsToSync = new Set(resolved.files.map(relPath => path.dirname(path.join(partial, ...relPath.split('/')))));
        for (const dir of dirsToSync) fsyncPath(dir);
        fsyncPath(partial);
    } catch (error) {
        if (error instanceof PayloadError) error.details.stagingDir = partial;
        else error.stagingDir = partial;
        throw error;
    }
    const result = verifyPayload(partial, verifyOptions);
    const stagingDir = path.join(stagingRoot, name);
    fs.renameSync(partial, stagingDir);
    fsyncPath(stagingRoot);
    return { stagingDir, releaseId: result.releaseId, features: result.features, files: result.files, bytes, verified: result };
}

/** Staging directories under `stagingRoot`: the ready ones and the interrupted (`.partial`) ones. */
function listStaging(stagingRoot) {
    if (!fs.existsSync(stagingRoot)) return { ready: [], partial: [] };
    const ready = [];
    const partial = [];
    for (const name of fs.readdirSync(stagingRoot).sort()) {
        if (!fs.lstatSync(path.join(stagingRoot, name)).isDirectory()) continue;
        (name.endsWith(PARTIAL_SUFFIX) ? partial : ready).push(path.join(stagingRoot, name));
    }
    return { ready, partial };
}

/** Remove interrupted stages; returns what was removed. */
function cleanStaging(stagingRoot) {
    const { partial } = listStaging(stagingRoot);
    for (const dir of partial) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return partial;
}

/**
 * Finish an activation a crash interrupted between its two renames: with no
 * `current` but a `previous`, the previous payload comes back.
 * @returns {'ok'|'restored-previous'|'empty'}
 */
function recoverInstall(installRoot) {
    const current = path.join(installRoot, 'current');
    const previous = path.join(installRoot, 'previous');
    if (fs.existsSync(current)) return 'ok';
    if (fs.existsSync(previous)) {
        fs.renameSync(previous, current);
        fsyncPath(installRoot);
        return 'restored-previous';
    }
    return 'empty';
}

/**
 * Make a verified staging directory the installation's `current` payload:
 * the old `current` becomes `previous` (the one before is dropped), then the
 * staged directory is renamed into place. Both renames stay on one
 * filesystem; if the second fails the first is undone, so `current` is either
 * the old payload or the new one, never a mix. The staged copy is verified
 * again first unless `verify: false`.
 * @param {string} stagingDir
 * @param {string} installRoot
 * @param {VerifyOptions & { verify?: boolean }} [options]
 * @returns {{ current: string, previous: string|null, verified: VerifyResult|null }}
 */
function activate(stagingDir, installRoot, options = {}) {
    if (stagingDir.endsWith(PARTIAL_SUFFIX)) fail(CODES.ACTIVATE_FAILED, 'refusing to activate an interrupted (.partial) stage');
    const verifyOptions = { ...options };
    delete verifyOptions.verify;
    const verified = options.verify === false ? null : verifyPayload(stagingDir, verifyOptions);
    fs.mkdirSync(installRoot, { recursive: true });
    recoverInstall(installRoot);
    const current = path.join(installRoot, 'current');
    const previous = path.join(installRoot, 'previous');
    const hadCurrent = fs.existsSync(current);
    if (hadCurrent && fs.existsSync(previous)) {
        const retired = path.join(installRoot, `.retired-${crypto.randomBytes(4).toString('hex')}`);
        fs.renameSync(previous, retired);
        fs.rmSync(retired, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (hadCurrent) fs.renameSync(current, previous);
    try {
        fs.renameSync(stagingDir, current);
    } catch (error) {
        if (hadCurrent) fs.renameSync(previous, current);
        fail(CODES.ACTIVATE_FAILED, `could not move the staged payload into place (${error.code || 'error'}); the previous payload is still current`, { cause: error.code || null });
    }
    fsyncPath(installRoot);
    return { current, previous: hadCurrent ? previous : null, verified };
}

module.exports = {
    MANIFEST_VERSION,
    CORE,
    CODES,
    MANIFEST_FILE,
    SIGNATURE_FILE,
    SELECTION_FILE,
    INSTALLED_FEATURES_FILE,
    LOCAL_FILES,
    PARTIAL_SUFFIX,
    DEV_UNSIGNED_ENV,
    PayloadError,
    canonicalJson,
    canonicalBytes,
    satisfies,
    unsafePathReason,
    validateManifest,
    releaseIdOf,
    closeOverRequires,
    selectPayload,
    readSelection,
    selectionDocument,
    installedFeaturesDocument,
    keyIdOf,
    signManifest,
    writeManifest,
    generateDevKeyPair,
    sha256File,
    walkTree,
    verifyPayload,
    stageSelection,
    listStaging,
    cleanStaging,
    recoverInstall,
    activate,
    verifyCli
};

/**
 * `node scripts/lib/payloadStage.js verify <dir> [--target <id>] [--abi <n>]
 * [--core <version>] [--public-key <pem>] [--dev]` prints `{ ok, code, message }`
 * plus the verification summary as JSON; exit 0 when the payload verifies, 2
 * when it is refused, 1 on a usage error.
 */
function verifyCli(argv, { stdout = process.stdout } = {}) {
    const [command, dir, ...rest] = argv;
    if (command !== 'verify' || !dir) {
        stdout.write('usage: payloadStage.js verify <dir> [--target <id>] [--abi <n>] [--core <version>] [--public-key <pem>] [--dev]\n');
        return 1;
    }
    const options = { devMode: false };
    const value = (flag, index) => {
        if (rest[index + 1] === undefined) throw new Error(`${flag} needs a value`);
        return rest[index + 1];
    };
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '--target') options.expectedTarget = value(arg, i++);
        else if (arg === '--abi') options.nodeAbi = value(arg, i++);
        else if (arg === '--core') options.coreVersion = value(arg, i++);
        else if (arg === '--public-key') options.publicKey = fs.readFileSync(value(arg, i++), 'utf8');
        else if (arg === '--dev') options.devMode = true;
        else {
            stdout.write(`unknown option: ${arg}\n`);
            return 1;
        }
    }
    try {
        const result = verifyPayload(dir, options);
        stdout.write(`${JSON.stringify({ ok: true, code: null, message: 'verified', ...result }, null, 2)}\n`);
        return 0;
    } catch (error) {
        if (!(error instanceof PayloadError)) throw error;
        stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2)}\n`);
        return 2;
    }
}

if (require.main === module) process.exitCode = verifyCli(process.argv.slice(2));
