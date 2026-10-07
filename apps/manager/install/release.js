/**
 * The release a payload carries: manifest, selection, size, verification.
 * A thin layer over scripts/lib/payloadStage.js (Node built-ins only, shipped
 * in every payload). The source of an install is a local directory that
 * verifyPayload accepts; downloading one is the named hook
 * `DOWNLOAD_HOOK` below, not implemented here (that, and any update check,
 * is #342). `verifyReleaseIndex` exposes the release index verifier
 * (scripts/lib/releaseIndex.js, documentation/release.md) and nothing
 * more: it reads a directory it is handed.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { ManagerError } = require('../errors');

const DOWNLOAD_HOOK = 'release-download';

let stage = null;
const payloadStage = () => {
    if (!stage) stage = require('../../../scripts/lib/payloadStage');
    return stage;
};

let indexModule = null;
const releaseIndex = () => {
    if (!indexModule) indexModule = require('../../../scripts/lib/releaseIndex');
    return indexModule;
};

const DEV_UNSIGNED_ENV = 'GOOBSTER_PAYLOAD_DEV_UNSIGNED';

const PAYLOAD_CODES = new Set(['MANIFEST_MISSING', 'MANIFEST_INVALID', 'SIGNATURE_MISSING', 'SIGNATURE_INVALID', 'UNSIGNED_DEV_ONLY',
    'PATH_TRAVERSAL', 'LINK_ESCAPES_ROOT', 'TARGET_MISMATCH', 'ABI_MISMATCH', 'INCOMPLETE', 'EXTRA_FILE', 'VERSION_INCOMPATIBLE',
    'SELECTION_UNAVAILABLE', 'ACTIVATE_FAILED']);

/** Turn a PayloadError into a ManagerError with the payload's own code (they carry no path outside the payload). */
function mapPayloadError(error, status = 409) {
    if (error && error.name === 'PayloadError' && PAYLOAD_CODES.has(error.code)) {
        return new ManagerError(status, error.code, error.message);
    }
    if (error && (error.code === 'UNKNOWN_FEATURE')) return new ManagerError(400, 'UNKNOWN_FEATURE', 'The selection names a feature the release does not define.');
    return error;
}

const INDEX_CODES = new Set(['INDEX_INVALID', 'INDEX_UNSIGNED', 'INDEX_BAD_SIGNATURE', 'UNTRUSTED_KEY', 'ARTIFACT_UNSIGNED', 'TARGET_MISMATCH',
    'ABI_MISMATCH', 'DOWNGRADE', 'VERSION_INCOMPATIBLE', 'ARTIFACT_DIGEST_MISMATCH', 'ARTIFACT_MISSING', 'KEY_LIST_INVALID']);

/** Turn a ReleaseIndexError into a ManagerError with the index's own code (its messages name artifacts by bare file name only). */
function mapIndexError(error, status = 409) {
    if (error && error.name === 'ReleaseIndexError' && INDEX_CODES.has(error.code)) return new ManagerError(status, error.code, error.message);
    return error;
}

function readPublicKeys(files, fs = nodeFs) {
    const keys = [];
    for (const file of files || []) {
        try {
            keys.push(fs.readFileSync(file, 'utf8'));
        } catch {
            throw new ManagerError(400, 'PUBLIC_KEY_UNREADABLE', 'A trusted public key file cannot be read.');
        }
    }
    return keys;
}

/**
 * The trusted keys a bootstrapper hands the wizard (a signed .run/AppImage
 * names its embedded key in GOOBSTER_RELEASE_PUBLIC_KEY_FILE); an install
 * input that names keys of its own wins.
 */
function verifyOptions(release, fs = nodeFs, env = process.env) {
    const options = {};
    const named = release && Array.isArray(release.publicKeyFiles) && release.publicKeyFiles.length > 0;
    const files = named ? release.publicKeyFiles : (env.GOOBSTER_RELEASE_PUBLIC_KEY_FILE ? [env.GOOBSTER_RELEASE_PUBLIC_KEY_FILE] : []);
    const keys = readPublicKeys(files, fs);
    if (keys.length) options.publicKey = keys;
    if (release && release.allowUnsigned === true) options.devMode = true;
    else if (release && release.allowUnsigned === false) options.devMode = false;
    return options;
}

/**
 * The verification policy an install runs under: `production` unless the install input says
 * `allowUnsigned: true` or GOOBSTER_PAYLOAD_DEV_UNSIGNED=1 is set. An explicit `allowUnsigned: false`
 * wins over the environment.
 * @returns {'production'|'development'}
 */
function trustPolicy(release, env = process.env) {
    if (release && release.allowUnsigned === true) return 'development';
    if (release && release.allowUnsigned === false) return 'production';
    return env[DEV_UNSIGNED_ENV] === '1' ? 'development' : 'production';
}

/**
 * Verify a release index directory under the install's trust policy. The trusted keys are the install's
 * (`release.publicKeyFiles` or GOOBSTER_RELEASE_PUBLIC_KEY_FILE) plus, when given, a key list. Nothing is
 * downloaded or applied; a refusal is a ManagerError carrying the index's code.
 * @param {string} dir  a directory holding release-index.json and release-index.sig
 * @param {{ release?: Object, env?: Object, fs?: Object, keyList?: Object, expectedTarget?: string,
 *   nodeAbi?: string|number, currentVersion?: string, allowDowngrade?: boolean, requireFiles?: boolean }} [options]
 */
function verifyReleaseIndex(dir, options = {}) {
    const fs = options.fs || nodeFs;
    const env = options.env || process.env;
    const verify = { policy: trustPolicy(options.release, env) };
    const keys = verifyOptions(options.release, fs, env).publicKey;
    if (keys) verify.publicKey = keys;
    for (const name of ['keyList', 'expectedTarget', 'nodeAbi', 'currentVersion', 'allowDowngrade', 'requireFiles']) {
        if (options[name] !== undefined) verify[name] = options[name];
    }
    try {
        return releaseIndex().verifyIndex(dir, verify);
    } catch (error) {
        throw mapIndexError(error) || error;
    }
}

/**
 * What the installed payload says about itself: whether it carries a signature (not whether it verifies;
 * install and repair do that), the key that signed it, and its channel (a prerelease core version is on
 * the prerelease channel; the release index is authoritative). Nulls when there is no readable manifest.
 */
function installedTrust(codeRoot, fs = nodeFs) {
    const none = { signed: null, keyId: null, channel: null };
    if (!codeRoot) return none;
    const current = path.join(codeRoot, 'current');
    try {
        const ps = payloadStage();
        const manifest = JSON.parse(fs.readFileSync(path.join(current, ps.MANIFEST_FILE), 'utf8'));
        const signature = fs.existsSync(path.join(current, ps.SIGNATURE_FILE));
        const core = manifest && manifest.release && manifest.release.core;
        const isVersion = typeof core === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(core);
        return {
            signed: Boolean(manifest.signing) && signature,
            keyId: manifest.signing && typeof manifest.signing.keyId === 'string' ? manifest.signing.keyId : null,
            channel: isVersion ? (core.includes('-') ? 'prerelease' : 'stable') : null
        };
    } catch {
        return none;
    }
}

/**
 * Read a source payload's manifest (no hashing).
 * @returns {{ manifest: Object, releaseId: string, dir: string }}
 */
function loadManifest(dir, fs = nodeFs) {
    const ps = payloadStage();
    let real;
    try {
        real = fs.realpathSync(dir);
    } catch {
        throw new ManagerError(400, 'SOURCE_MISSING', 'The release source directory does not exist.');
    }
    let text;
    try {
        text = fs.readFileSync(path.join(real, ps.MANIFEST_FILE), 'utf8');
    } catch {
        throw new ManagerError(400, 'MANIFEST_MISSING', 'The release source has no payload-manifest.json.');
    }
    try {
        const manifest = ps.validateManifest(JSON.parse(text));
        return { manifest, releaseId: ps.releaseIdOf(manifest), dir: real };
    } catch (error) {
        throw mapPayloadError(error) || error;
    }
}

/** The resolved selection for `features` (closed over `requires`) and its size. */
function selection(manifest, features) {
    const ps = payloadStage();
    let resolved;
    try {
        resolved = ps.selectPayload(manifest, { features });
    } catch (error) {
        throw mapPayloadError(error);
    }
    const sizes = new Map(manifest.files.map(file => [file.path, file.size]));
    const bytes = resolved.files.reduce((sum, rel) => sum + (sizes.get(rel) || 0), 0);
    return { resolved, bytes, files: resolved.files.length };
}

/** Does the payload bring its own Node runtime (so the manager's ABI is not the application's)? */
function carriesRuntime(manifest) {
    return manifest.files.some(file => /^runtime\/(bin\/node|node(\.exe)?)$/.test(file.path));
}

module.exports = {
    DOWNLOAD_HOOK,
    DEV_UNSIGNED_ENV,
    payloadStage,
    releaseIndex,
    mapPayloadError,
    mapIndexError,
    verifyOptions,
    trustPolicy,
    verifyReleaseIndex,
    installedTrust,
    loadManifest,
    selection,
    carriesRuntime
};
