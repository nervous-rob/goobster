'use strict';

/**
 * The release index: layer 2 of the artifact verification contract
 * (documentation/release.md, issue #341, ADR 0013 decisions 7, 11 and 13).
 *
 * Layer 1 is the per-payload manifest and its detached signature
 * (scripts/lib/payloadStage.js, #328), unchanged. Layer 2 is one
 * `release-index.json` per release channel that lists every artifact the
 * release published - each with its SHA-256, size, target and signing state -
 * plus the provenance a person auditing it needs, and a detached Ed25519
 * `release-index.sig` over the canonical bytes, made with the same key family
 * and the same key-id rule as the payload manifest.
 *
 * `verifyIndex` is the one policy function. `production` demands a valid
 * signature from a trusted key and refuses every artifact that is not signed;
 * `development` accepts an unsigned development build and labels the result
 * exactly as `verifyPayload` does. Nothing here downloads, applies or updates
 * anything (that is #342), and nothing reads or writes a private key: the
 * signing helpers take a key the caller already holds.
 *
 * Node built-ins and payloadStage only, so the release workflow runs it with
 * no install step.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const stage = require('./payloadStage');

const INDEX_VERSION = 1;
const INDEX_FILE = 'release-index.json';
const SIGNATURE_FILE = 'release-index.sig';
const INVENTORY_PREFIX = 'dependency-inventory-';
const KEY_LIST_FILE = path.join(__dirname, '..', 'release-keys.json');

const CHANNELS = Object.freeze(['stable', 'prerelease']);
const TARGETS = Object.freeze(['linux-x64', 'linux-arm64', 'win32-x64', 'darwin-x64', 'darwin-arm64']);
const KINDS = Object.freeze(['bootstrap', 'payload', 'appimage', 'pkg', 'tarball', 'exe', 'msi']);
const SIGNING_STATUSES = Object.freeze(['signed', 'unsigned-dev']);
const SIGNING_METHODS = Object.freeze(['authenticode', 'apple-notarized', 'ed25519-only']);
const KEY_STATUSES = Object.freeze(['active', 'retired', 'revoked']);
const POLICIES = Object.freeze(['production', 'development']);
const LABEL_UNSIGNED = 'UNSIGNED DEVELOPMENT BUILD';

const CODES = Object.freeze({
    INDEX_INVALID: 'INDEX_INVALID',
    INDEX_UNSIGNED: 'INDEX_UNSIGNED',
    INDEX_BAD_SIGNATURE: 'INDEX_BAD_SIGNATURE',
    UNTRUSTED_KEY: 'UNTRUSTED_KEY',
    ARTIFACT_UNSIGNED: 'ARTIFACT_UNSIGNED',
    TARGET_MISMATCH: 'TARGET_MISMATCH',
    ABI_MISMATCH: 'ABI_MISMATCH',
    DOWNGRADE: 'DOWNGRADE',
    VERSION_INCOMPATIBLE: 'VERSION_INCOMPATIBLE',
    ARTIFACT_DIGEST_MISMATCH: 'ARTIFACT_DIGEST_MISMATCH',
    ARTIFACT_MISSING: 'ARTIFACT_MISSING',
    KEY_LIST_INVALID: 'KEY_LIST_INVALID',
    TAG_INVALID: 'TAG_INVALID',
    BAD_OPTION: 'BAD_OPTION'
});

/**
 * @typedef {Object} ArtifactSigning
 * @property {'signed'|'unsigned-dev'} status
 * @property {'authenticode'|'apple-notarized'|'ed25519-only'} [method]  how a `signed` artifact is signed
 * @property {string} [identity]  a certificate thumbprint, an Apple team id or an Ed25519 key id; never a secret
 * @property {string} [reason]    why an artifact is `unsigned-dev` (a short code)
 */

/**
 * @typedef {Object} IndexArtifact
 * @property {string} target       `linux-x64`, `linux-arm64`, `win32-x64`, `darwin-x64` or `darwin-arm64`
 * @property {'bootstrap'|'payload'|'appimage'|'pkg'|'tarball'|'exe'|'msi'} kind
 * @property {string} file         a bare file name beside the index
 * @property {string} sha256
 * @property {number} size
 * @property {ArtifactSigning} signing
 * @property {string} [payloadKeyId]  the key that signed the payload manifest the artifact carries
 */

/**
 * @typedef {Object} ReleaseIndex
 * @property {1} version
 * @property {{ core: string, manager: string, channel: 'stable'|'prerelease', tag: string,
 *   sourceRevision: string, lockfileSha256: string, builtAt: string }} release
 * @property {{ version: string, abi: string }} node
 * @property {{ minUpgradeFrom: string, compatibleCore: string }} compatibility
 * @property {IndexArtifact[]} artifacts
 * @property {{ nodePin?: Object, tools?: Object }} [provenance]  the inputs that were pinned for this build
 * @property {Array<{ target: string, file: string, sha256: string }>} [inventories]  per-target dependency inventories
 * @property {{ algorithm: 'ed25519', keyId: string }} [signing]  set by signIndex; part of the signed bytes
 */

/**
 * @typedef {Object} KeyListEntry
 * @property {string} keyId
 * @property {string} publicKeyPem
 * @property {'active'|'retired'|'revoked'} status
 * @property {string} since
 * @property {string} note
 */

/**
 * @typedef {Object} IndexVerifyOptions
 * @property {'production'|'development'} [policy]  default `production`
 * @property {string|crypto.KeyObject|Array<string|crypto.KeyObject>} [publicKey]  trusted Ed25519 key(s), PEM or KeyObject
 * @property {{ version: number, keys: KeyListEntry[] }} [keyList]  the parsed scripts/release-keys.json; `revoked` entries are untrusted
 * @property {string} [expectedTarget]  e.g. `linux-x64`; scopes the artifacts that are checked and must be among them
 * @property {string|number} [nodeAbi]
 * @property {string} [currentVersion]  the core version installed now
 * @property {boolean} [allowDowngrade]  explicit opt-in to an older release
 * @property {string} [artifactDir]  where the artifact files are (default: the index directory)
 * @property {boolean} [requireFiles]  an in-scope artifact file that is absent is ARTIFACT_MISSING
 * @property {string[]} [kinds]  scope the check to these artifact kinds
 */

class ReleaseIndexError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ReleaseIndexError';
        this.code = code;
        this.details = details;
    }
}

function fail(code, message, details) {
    throw new ReleaseIndexError(code, message, details);
}

// ---------------------------------------------------------------------------
// versions and tags
// ---------------------------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;
const PRERELEASE_TAG = /^v(\d+\.\d+\.\d+-(?:rc|beta|alpha)\.\d+)$/;
const LOOSE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

function parseSemver(text) {
    const match = SEMVER.exec(String(text).trim());
    if (!match) return null;
    return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : null };
}

function comparePrerelease(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i] === undefined) return -1;
        if (b[i] === undefined) return 1;
        const aNumeric = /^\d+$/.test(a[i]);
        const bNumeric = /^\d+$/.test(b[i]);
        if (aNumeric && bNumeric) {
            const diff = Number(a[i]) - Number(b[i]);
            if (diff !== 0) return diff < 0 ? -1 : 1;
        } else if (aNumeric !== bNumeric) {
            return aNumeric ? -1 : 1;
        } else if (a[i] !== b[i]) {
            return a[i] < b[i] ? -1 : 1;
        }
    }
    return 0;
}

/** -1, 0 or 1 by semver precedence (`1.0.0-rc.2` < `1.0.0-rc.10` < `1.0.0`); null when either side is not a version. */
function compareVersions(left, right) {
    const a = parseSemver(left);
    const b = parseSemver(right);
    if (!a || !b) return null;
    for (let i = 0; i < 3; i += 1) if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
    return comparePrerelease(a.pre, b.pre);
}

/**
 * The channel a tag belongs to. `v1.2.3` is `stable`; `v1.2.3-rc.N`, `-beta.N` and `-alpha.N` are
 * `prerelease`; a `workflow_dispatch` build is always `prerelease` whatever it is tagged. Any other tag is
 * TAG_INVALID, so a typo can never publish to the stable channel.
 * @returns {{ channel: 'stable'|'prerelease', version: string }}
 */
function deriveChannel(tag, { dispatch = false } = {}) {
    const text = typeof tag === 'string' ? tag : '';
    if (dispatch) {
        const loose = LOOSE_TAG.exec(text);
        if (!loose) fail(CODES.TAG_INVALID, `"${text.slice(0, 64)}" is not a version tag (v<major>.<minor>.<patch>[-<label>])`);
        return { channel: 'prerelease', version: loose[1] };
    }
    const stable = STABLE_TAG.exec(text);
    if (stable) return { channel: 'stable', version: stable[1] };
    const pre = PRERELEASE_TAG.exec(text);
    if (pre) return { channel: 'prerelease', version: pre[1] };
    return fail(CODES.TAG_INVALID, `"${text.slice(0, 64)}" is neither v<semver> (stable) nor v<semver>-<rc|beta|alpha>.N (prerelease)`);
}

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{7,64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEY_BLOCK = /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE|PUBLIC KEY)-----/;

/** Is `name` a bare file name (no directory part, no traversal, no control characters)? */
function bareFileName(name) {
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[/\\\u0000-\u001f]/.test(name) && name !== '.' && name !== '..';
}

function stringsOf(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(item => stringsOf(item, out));
    else if (value && typeof value === 'object') Object.values(value).forEach(item => stringsOf(item, out));
    return out;
}

function validateSigning(signing, where, problems) {
    if (!signing || typeof signing !== 'object' || Array.isArray(signing)) {
        problems.push(`${where}.signing`);
        return;
    }
    if (!SIGNING_STATUSES.includes(signing.status)) problems.push(`${where}.signing.status`);
    if (signing.status === 'signed' && !SIGNING_METHODS.includes(signing.method)) problems.push(`${where}.signing.method`);
    if (signing.status === 'unsigned-dev' && signing.method !== undefined) problems.push(`${where}.signing.method (an unsigned-dev artifact has no signing method)`);
    if (signing.method !== undefined && !SIGNING_METHODS.includes(signing.method)) problems.push(`${where}.signing.method`);
    if (signing.identity !== undefined && !(typeof signing.identity === 'string' && IDENTITY.test(signing.identity))) problems.push(`${where}.signing.identity`);
    if (signing.reason !== undefined && !(typeof signing.reason === 'string' && REASON.test(signing.reason))) problems.push(`${where}.signing.reason`);
}

/**
 * Check the shape of an index (signed or not). Throws INDEX_INVALID naming every problem; returns the
 * index. A key or certificate block anywhere in it is refused: the index is public and must never carry one.
 * @param {*} index
 * @returns {ReleaseIndex}
 */
function validateIndex(index) {
    const problems = [];
    if (!index || typeof index !== 'object' || Array.isArray(index)) problems.push('not an object');
    else {
        if (index.version !== INDEX_VERSION) problems.push(`version ${JSON.stringify(index.version)} is not ${INDEX_VERSION}`);
        const release = index.release;
        if (!release || typeof release !== 'object') problems.push('release');
        else {
            if (!parseSemver(release.core)) problems.push('release.core');
            if (typeof release.manager !== 'string' || !parseSemver(release.manager)) problems.push('release.manager');
            if (!CHANNELS.includes(release.channel)) problems.push('release.channel');
            if (typeof release.tag !== 'string' || !LOOSE_TAG.test(release.tag)) problems.push('release.tag');
            else if (parseSemver(release.core) && !release.tag.startsWith(`v${release.core}`)) problems.push('release.tag does not carry release.core');
            else if (release.channel === 'stable' && release.tag !== `v${release.core}`) problems.push('release.tag of a stable release must be exactly v<core>');
            else if (release.channel === 'stable' && parseSemver(release.core) && parseSemver(release.core).pre) problems.push('a stable release cannot have a prerelease core version');
            if (typeof release.sourceRevision !== 'string' || !REVISION.test(release.sourceRevision)) problems.push('release.sourceRevision');
            if (typeof release.lockfileSha256 !== 'string' || !HEX64.test(release.lockfileSha256)) problems.push('release.lockfileSha256');
            if (typeof release.builtAt !== 'string' || Number.isNaN(Date.parse(release.builtAt))) problems.push('release.builtAt');
        }
        if (!index.node || typeof index.node.version !== 'string' || index.node.abi === undefined || index.node.abi === null || String(index.node.abi) === '') problems.push('node.version / node.abi');
        const compat = index.compatibility;
        if (!compat || typeof compat !== 'object') problems.push('compatibility');
        else {
            if (!parseSemver(compat.minUpgradeFrom)) problems.push('compatibility.minUpgradeFrom');
            if (typeof compat.compatibleCore !== 'string' || !compat.compatibleCore.trim()) problems.push('compatibility.compatibleCore');
            else if (release && parseSemver(release.core) && !stage.satisfies(release.core, compat.compatibleCore)) problems.push('release.core is outside compatibility.compatibleCore');
            if (parseSemver(compat.minUpgradeFrom) && release && parseSemver(release.core) && compareVersions(compat.minUpgradeFrom, release.core) > 0) problems.push('compatibility.minUpgradeFrom is newer than release.core');
        }
        if (!Array.isArray(index.artifacts) || index.artifacts.length === 0) problems.push('artifacts');
        else {
            const names = new Set();
            index.artifacts.forEach((artifact, i) => {
                const where = `artifacts[${i}]`;
                if (!artifact || typeof artifact !== 'object') {
                    problems.push(where);
                    return;
                }
                if (!TARGETS.includes(artifact.target)) problems.push(`${where}.target`);
                if (!KINDS.includes(artifact.kind)) problems.push(`${where}.kind`);
                if (!bareFileName(artifact.file)) problems.push(`${where}.file`);
                else if (names.has(artifact.file)) problems.push(`${where}.file duplicates ${artifact.file}`);
                else names.add(artifact.file);
                if (typeof artifact.sha256 !== 'string' || !HEX64.test(artifact.sha256)) problems.push(`${where}.sha256`);
                if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) problems.push(`${where}.size`);
                validateSigning(artifact.signing, where, problems);
                if (artifact.payloadKeyId !== undefined && !(typeof artifact.payloadKeyId === 'string' && KEY_ID.test(artifact.payloadKeyId))) problems.push(`${where}.payloadKeyId`);
            });
        }
        if (index.inventories !== undefined) {
            if (!Array.isArray(index.inventories)) problems.push('inventories');
            else {
                index.inventories.forEach((item, i) => {
                    if (!item || !TARGETS.includes(item.target) || !bareFileName(item.file) || !HEX64.test(String(item.sha256))) problems.push(`inventories[${i}]`);
                });
            }
        }
        if (index.provenance !== undefined && (!index.provenance || typeof index.provenance !== 'object' || Array.isArray(index.provenance))) problems.push('provenance');
        if (index.signing !== undefined && (!index.signing || index.signing.algorithm !== 'ed25519' || typeof index.signing.keyId !== 'string' || !KEY_ID.test(index.signing.keyId))) problems.push('signing');
        if (stringsOf(index).some(text => KEY_BLOCK.test(text))) problems.push('a key or certificate block (the index is public)');
    }
    if (problems.length) fail(CODES.INDEX_INVALID, `release-index.json is not a v${INDEX_VERSION} release index: ${problems.slice(0, 8).join(', ')}`, { problems: problems.slice(0, 20) });
    return index;
}

function sortArtifacts(artifacts) {
    return [...artifacts].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))));
}

/**
 * Assemble an unsigned index from its parts. Artifacts are sorted (target, kind, file) so two builds from
 * the same entries give the same bytes; the result is validated.
 * @param {{ release: Object, node: Object, compatibility: Object, artifacts: IndexArtifact[], provenance?: Object, inventories?: Array }} input
 * @returns {ReleaseIndex}
 */
function buildIndex(input) {
    const index = {
        version: INDEX_VERSION,
        release: { ...input.release },
        node: { version: input.node && input.node.version, abi: input.node && input.node.abi !== undefined ? String(input.node.abi) : undefined },
        compatibility: { ...input.compatibility },
        artifacts: sortArtifacts((input.artifacts || []).map(artifact => ({ ...artifact, signing: artifact.signing && { ...artifact.signing } })))
    };
    if (input.provenance) index.provenance = input.provenance;
    if (input.inventories && input.inventories.length) index.inventories = [...input.inventories].sort((a, b) => (a.target < b.target ? -1 : 1));
    return validateIndex(JSON.parse(stage.canonicalJson(index)));
}

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

/**
 * Sign an index with an Ed25519 key. Returns the index with `signing` set (part of the signed bytes)
 * and the base64 signature for `release-index.sig`. The signed bytes are the canonical JSON, exactly the
 * rule the payload manifest uses, and the key id is the same `keyIdOf`.
 * @param {ReleaseIndex} index
 * @param {string|crypto.KeyObject} privateKey
 */
function signIndex(index, privateKey) {
    const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key must be Ed25519');
    const unsigned = { ...index };
    delete unsigned.signing;
    validateIndex(unsigned);
    const signed = { ...unsigned, signing: { algorithm: 'ed25519', keyId: stage.keyIdOf(crypto.createPublicKey(key)) } };
    const signature = crypto.sign(null, stage.canonicalBytes(signed), key).toString('base64');
    return { index: signed, signature };
}

/** Write the canonical index (and the signature when given) into `dir`. */
function writeIndex(dir, index, signature = null) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, INDEX_FILE), stage.canonicalJson(index));
    if (signature) fs.writeFileSync(path.join(dir, SIGNATURE_FILE), `${signature}\n`);
    else fs.rmSync(path.join(dir, SIGNATURE_FILE), { force: true });
}

/**
 * Read `release-index.json` and its signature from `dir`. Parses only; nothing is checked.
 * @returns {{ index: Object, signature: string|null }}
 */
function readIndex(dir) {
    let text;
    try {
        text = fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8');
    } catch (error) {
        return fail(CODES.INDEX_INVALID, `${INDEX_FILE} is ${error.code === 'ENOENT' ? 'missing' : 'unreadable'}`);
    }
    let index;
    try {
        index = JSON.parse(text);
    } catch {
        return fail(CODES.INDEX_INVALID, `${INDEX_FILE} is not valid JSON`);
    }
    let signature = null;
    try {
        signature = fs.readFileSync(path.join(dir, SIGNATURE_FILE), 'utf8').trim() || null;
    } catch (error) {
        if (error.code !== 'ENOENT') fail(CODES.INDEX_BAD_SIGNATURE, `${SIGNATURE_FILE} is unreadable`);
    }
    return { index, signature };
}

// ---------------------------------------------------------------------------
// the trusted key list
// ---------------------------------------------------------------------------

/**
 * Validate a parsed `scripts/release-keys.json`. A private key anywhere in it is refused outright;
 * each entry's `keyId` must be what its public key hashes to.
 * @returns {{ version: 1, keys: KeyListEntry[] }}
 */
function validateKeyList(doc) {
    const problems = [];
    if (!doc || typeof doc !== 'object' || doc.version !== 1 || !Array.isArray(doc.keys)) problems.push('not a version 1 key list');
    else {
        if (stringsOf(doc).some(text => /PRIVATE KEY/.test(text))) problems.push('a private key block (never commit one)');
        const seen = new Set();
        doc.keys.forEach((entry, i) => {
            const where = `keys[${i}]`;
            if (!entry || typeof entry !== 'object') {
                problems.push(where);
                return;
            }
            if (!KEY_STATUSES.includes(entry.status)) problems.push(`${where}.status`);
            if (typeof entry.since !== 'string' || Number.isNaN(Date.parse(entry.since))) problems.push(`${where}.since`);
            if (typeof entry.note !== 'string') problems.push(`${where}.note`);
            if (typeof entry.keyId !== 'string' || !KEY_ID.test(entry.keyId)) problems.push(`${where}.keyId`);
            else if (seen.has(entry.keyId)) problems.push(`${where}.keyId duplicates ${entry.keyId}`);
            else seen.add(entry.keyId);
            try {
                const key = crypto.createPublicKey(entry.publicKeyPem);
                if (key.asymmetricKeyType !== 'ed25519') problems.push(`${where}.publicKeyPem is not Ed25519`);
                else if (stage.keyIdOf(key) !== entry.keyId) problems.push(`${where}.keyId is not the id of its publicKeyPem`);
            } catch {
                problems.push(`${where}.publicKeyPem`);
            }
        });
    }
    if (problems.length) fail(CODES.KEY_LIST_INVALID, `release-keys.json is invalid: ${problems.slice(0, 6).join(', ')}`, { problems });
    return doc;
}

/** Read and validate a key list file (default: scripts/release-keys.json). */
function loadKeyList(file = KEY_LIST_FILE) {
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fail(CODES.KEY_LIST_INVALID, 'the release key list is missing or is not JSON');
    }
    return validateKeyList(doc);
}

/** Keys that may sign a new release: `active` only. `retired` verifies old releases; `revoked` verifies nothing. */
function signingKeys(keyList) {
    return validateKeyList(keyList).keys.filter(entry => entry.status === 'active');
}

/** Resolve the trust the caller supplied: usable keys by id, and the set of revoked ids. */
function resolveTrust({ publicKey, keyList } = {}) {
    const usable = new Map();
    const revoked = new Set();
    const direct = publicKey === undefined || publicKey === null ? [] : Array.isArray(publicKey) ? publicKey : [publicKey];
    for (const key of direct) {
        const object = key instanceof crypto.KeyObject ? (key.type === 'public' ? key : crypto.createPublicKey(key)) : crypto.createPublicKey(key);
        if (object.asymmetricKeyType !== 'ed25519') throw new ReleaseIndexError(CODES.BAD_OPTION, 'a trusted key must be Ed25519');
        usable.set(stage.keyIdOf(object), { keyId: stage.keyIdOf(object), key: object, status: 'active' });
    }
    if (keyList) {
        for (const entry of validateKeyList(keyList).keys) {
            if (entry.status === 'revoked') revoked.add(entry.keyId);
            else usable.set(entry.keyId, { keyId: entry.keyId, key: crypto.createPublicKey(entry.publicKeyPem), status: entry.status });
        }
    }
    for (const id of revoked) usable.delete(id);
    return { usable, revoked, supplied: usable.size > 0 || revoked.size > 0 };
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

function checkSignature(index, signature, trust, policy) {
    if (!signature) {
        if (policy === 'development') return { signed: false, devMode: true, keyId: index.signing ? index.signing.keyId : null, keyStatus: null };
        return fail(CODES.INDEX_UNSIGNED, `${SIGNATURE_FILE} is missing; a production verification needs a signed release index`);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) fail(CODES.INDEX_BAD_SIGNATURE, `${SIGNATURE_FILE} is not base64`);
    if (!index.signing || index.signing.algorithm !== 'ed25519' || typeof index.signing.keyId !== 'string') {
        fail(CODES.INDEX_BAD_SIGNATURE, `${SIGNATURE_FILE} is present but the index names no signing key`);
    }
    const keyId = index.signing.keyId;
    if (trust.revoked.has(keyId)) fail(CODES.UNTRUSTED_KEY, `the index is signed by key ${keyId}, which has been revoked`, { keyId, revoked: true });
    if (!trust.usable.size) {
        if (policy === 'development') return { signed: false, devMode: true, keyId, keyStatus: null };
        return fail(CODES.UNTRUSTED_KEY, `the index is signed by key ${keyId}, but no trusted public key was supplied`, { keyId });
    }
    const trusted = trust.usable.get(keyId);
    if (!trusted) fail(CODES.UNTRUSTED_KEY, `the index is signed by key ${keyId}, which is not one of the trusted keys`, { keyId });
    let valid;
    try {
        valid = crypto.verify(null, stage.canonicalBytes(index), trusted.key, Buffer.from(signature, 'base64'));
    } catch {
        valid = false;
    }
    if (!valid) fail(CODES.INDEX_BAD_SIGNATURE, 'the signature does not match the index', { keyId });
    return { signed: true, devMode: false, keyId, keyStatus: trusted.status };
}

function toList(value) {
    return value === undefined || value === null ? [] : value;
}

/**
 * Verify a release index against a policy. Throws a ReleaseIndexError whose `code` is one of CODES;
 * returns a summary on success. Order: signature, shape, target, Node ABI, version policy, artifact
 * signing state, artifact digests (for every in-scope file that is present).
 * @param {string|{ index: Object, signature?: string|null, dir?: string }} input  a directory holding the index, or the parsed parts
 * @param {IndexVerifyOptions} [options]
 */
function verifyIndex(input, options = {}) {
    const policy = options.policy === undefined ? 'production' : options.policy;
    if (!POLICIES.includes(policy)) throw new ReleaseIndexError(CODES.BAD_OPTION, `policy must be one of ${POLICIES.join(', ')}`);
    if (options.currentVersion !== undefined && !parseSemver(options.currentVersion)) throw new ReleaseIndexError(CODES.BAD_OPTION, 'currentVersion is not a version');
    if (options.expectedTarget !== undefined && !TARGETS.includes(options.expectedTarget)) throw new ReleaseIndexError(CODES.TARGET_MISMATCH, `${options.expectedTarget} is not a target this release format knows`, { expected: options.expectedTarget });

    let parsed;
    let dir = options.artifactDir || null;
    if (typeof input === 'string') {
        parsed = readIndex(input);
        dir = dir || input;
    } else {
        parsed = { index: input.index, signature: input.signature || null };
        dir = dir || input.dir || null;
    }
    const { index, signature } = parsed;
    if (!index || typeof index !== 'object' || Array.isArray(index)) fail(CODES.INDEX_INVALID, 'the release index is not an object');

    const trust = resolveTrust({ publicKey: options.publicKey, keyList: options.keyList });
    const verdict = checkSignature(index, signature, trust, policy);
    validateIndex(index);

    const present = [...new Set(index.artifacts.map(artifact => artifact.target))].sort();
    if (options.expectedTarget && !present.includes(options.expectedTarget)) {
        fail(CODES.TARGET_MISMATCH, `this release has no artifact for ${options.expectedTarget} (it carries ${present.join(', ')})`, { expected: options.expectedTarget, targets: present });
    }
    if (options.nodeAbi !== undefined && options.nodeAbi !== null && String(index.node.abi) !== String(options.nodeAbi)) {
        fail(CODES.ABI_MISMATCH, `the release is built for Node ABI ${index.node.abi}, not ${options.nodeAbi}`, { abi: String(index.node.abi), expected: String(options.nodeAbi) });
    }
    if (options.currentVersion !== undefined) {
        if (compareVersions(index.release.core, options.currentVersion) < 0 && options.allowDowngrade !== true) {
            fail(CODES.DOWNGRADE, `release ${index.release.core} is older than the installed ${options.currentVersion}; a downgrade needs an explicit allowDowngrade`, { release: index.release.core, current: options.currentVersion });
        }
        if (compareVersions(options.currentVersion, index.compatibility.minUpgradeFrom) < 0) {
            fail(CODES.VERSION_INCOMPATIBLE, `release ${index.release.core} cannot be installed over ${options.currentVersion}; the oldest version it upgrades is ${index.compatibility.minUpgradeFrom}`, { current: options.currentVersion, minUpgradeFrom: index.compatibility.minUpgradeFrom });
        }
    }

    const kinds = toList(options.kinds);
    const scope = index.artifacts.filter(artifact => (!options.expectedTarget || artifact.target === options.expectedTarget) && (!kinds.length || kinds.includes(artifact.kind)));
    const unsigned = scope.filter(artifact => artifact.signing.status !== 'signed');
    if (policy === 'production' && unsigned.length) {
        fail(CODES.ARTIFACT_UNSIGNED, `${unsigned.length} artifact(s) are unsigned development builds, e.g. ${unsigned[0].file}`, { files: unsigned.slice(0, 5).map(artifact => artifact.file) });
    }

    const missing = [];
    let checked = 0;
    if (dir) {
        for (const artifact of scope) {
            const full = path.join(dir, artifact.file);
            let stat;
            try {
                stat = fs.lstatSync(full);
            } catch {
                missing.push(artifact.file);
                continue;
            }
            if (!stat.isFile() || stat.size !== artifact.size || stage.sha256File(full) !== artifact.sha256) {
                fail(CODES.ARTIFACT_DIGEST_MISMATCH, `${artifact.file} does not match the size and SHA-256 the index records`, { file: artifact.file });
            }
            checked += 1;
        }
        if (options.requireFiles && missing.length) fail(CODES.ARTIFACT_MISSING, `${missing.length} artifact file(s) are not beside the index, e.g. ${missing[0]}`, { files: missing.slice(0, 5) });
    }

    const signed = verdict.signed && unsigned.length === 0;
    return {
        ok: true,
        policy,
        signed,
        devMode: !signed,
        label: signed ? 'release' : LABEL_UNSIGNED,
        keyId: verdict.keyId,
        keyStatus: verdict.keyStatus,
        channel: index.release.channel,
        core: index.release.core,
        tag: index.release.tag,
        target: options.expectedTarget || null,
        targets: present,
        abi: String(index.node.abi),
        artifacts: scope.map(artifact => artifact.file),
        unsigned: unsigned.map(artifact => artifact.file),
        checked,
        missing
    };
}

// ---------------------------------------------------------------------------
// building entries from what a build produced
// ---------------------------------------------------------------------------

/** What platform signing a target's artifact needs besides the payload signature, or null. */
function platformRequirement(target, kind) {
    if (target.startsWith('win32-') && (kind === 'exe' || kind === 'msi')) return 'authenticode';
    if (target.startsWith('darwin-') && kind === 'pkg') return 'apple-notarized';
    return null;
}

/**
 * The signing block of one artifact. An artifact is `signed` only when the payload it carries is signed
 * by a real key and, where the platform asks for it (Authenticode for a Windows installer, Developer ID
 * signing plus notarization for a macOS package), that was done and verified too. Anything else is an
 * `unsigned-dev` build and says why.
 * @param {{ target: string, kind: string, payloadSigned: boolean, payloadKeyId?: string|null,
 *   platform?: { method: 'authenticode'|'apple-notarized', identity?: string }|null }} facts
 * @returns {ArtifactSigning}
 */
function decideSigning({ target, kind, payloadSigned, payloadKeyId = null, platform = null }) {
    if (!payloadSigned) return { status: 'unsigned-dev', reason: 'DEV_PAYLOAD' };
    const needed = platformRequirement(target, kind);
    if (needed) {
        if (!platform || platform.method !== needed) return { status: 'unsigned-dev', reason: needed === 'authenticode' ? 'NO_AUTHENTICODE' : 'NOT_NOTARIZED' };
        return platform.identity ? { status: 'signed', method: needed, identity: platform.identity } : { status: 'signed', method: needed };
    }
    return payloadKeyId ? { status: 'signed', method: 'ed25519-only', identity: payloadKeyId } : { status: 'signed', method: 'ed25519-only' };
}

/** One index entry for an artifact file already on disk. */
function artifactEntry({ file, kind, target, signing, payloadKeyId }) {
    const stat = fs.statSync(file);
    const entry = { target, kind, file: path.basename(file), sha256: stage.sha256File(file), size: stat.size, signing };
    if (payloadKeyId) entry.payloadKeyId = payloadKeyId;
    return entry;
}

/**
 * The dependency inventory of one payload: what the signed manifest already records (name, version,
 * licence, ownership). No new licence scanning happens here.
 * @param {Object} manifest  a validated payload manifest
 */
function dependencyInventory(manifest) {
    const licenses = manifest.licenses || { total: 0, nonPermissive: [] };
    return {
        version: 1,
        target: manifest.target.id,
        release: manifest.release.core,
        node: { version: manifest.node.version, abi: String(manifest.node.abi) },
        licenses: { total: licenses.total, nonPermissive: licenses.nonPermissive || [] },
        dependencies: [...manifest.dependencies]
            .map(dep => ({ name: dep.name, version: dep.version || null, license: dep.license || null, exclusive: dep.exclusive === true, owners: [...(dep.owners || [])].sort() }))
            .sort((a, b) => (a.name + a.version < b.name + b.version ? -1 : 1))
    };
}

module.exports = {
    INDEX_VERSION,
    INDEX_FILE,
    SIGNATURE_FILE,
    INVENTORY_PREFIX,
    KEY_LIST_FILE,
    CHANNELS,
    TARGETS,
    KINDS,
    SIGNING_STATUSES,
    SIGNING_METHODS,
    KEY_STATUSES,
    POLICIES,
    LABEL_UNSIGNED,
    CODES,
    ReleaseIndexError,
    parseSemver,
    compareVersions,
    deriveChannel,
    bareFileName,
    validateIndex,
    buildIndex,
    signIndex,
    writeIndex,
    readIndex,
    validateKeyList,
    loadKeyList,
    signingKeys,
    resolveTrust,
    verifyIndex,
    platformRequirement,
    decideSigning,
    artifactEntry,
    dependencyInventory
};
