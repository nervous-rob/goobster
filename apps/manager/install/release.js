/**
 * The release a payload carries: manifest, selection, size, verification.
 * A thin layer over scripts/lib/payloadStage.js (Node built-ins only, shipped
 * in every payload). The source of an install is a local directory that
 * verifyPayload accepts; downloading one is the named hook
 * `DOWNLOAD_HOOK` below, not implemented here.
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

module.exports = { DOWNLOAD_HOOK, payloadStage, mapPayloadError, verifyOptions, loadManifest, selection, carriesRuntime };
