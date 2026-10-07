/**
 * The manager store root and `installation.json`, the installation's
 * identity and owner claim. It lives outside the application database so
 * that losing, resetting or corrupting that database can never reopen
 * first-time setup. Spec: documentation/manager.md.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const files = require('./files');

const INSTALLATION_VERSION = 1;
const ORIGINS = ['claim', 'adopt'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function storePaths(root) {
    return {
        root,
        installation: path.join(root, 'installation.json'),
        bootstrap: path.join(root, 'bootstrap.json'),
        bootstrapCredential: path.join(root, 'bootstrap-credential'),
        recovery: path.join(root, 'recovery.json'),
        recoveryCredential: path.join(root, 'recovery-credential'),
        bridgeKey: path.join(root, 'bridge-key'),
        lock: path.join(root, 'lock'),
        operations: path.join(root, 'operations'),
        audit: path.join(root, 'operations', 'audit.jsonl')
    };
}

const isTimestamp = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isOptionalTimestamp = (value) => value === null || isTimestamp(value);
const isOptionalText = (value) => value === null || (typeof value === 'string' && value.length <= 200);

/** @returns {{ ok: true, doc: Object } | { ok: false, problem: 'CORRUPT'|'UNSUPPORTED' }} */
function validateInstallation(raw) {
    if (!files.isPlainObject(raw) || typeof raw.version !== 'number') return { ok: false, problem: 'CORRUPT' };
    if (raw.version !== INSTALLATION_VERSION) return { ok: false, problem: 'UNSUPPORTED' };
    const valid = typeof raw.installationId === 'string' && UUID_RE.test(raw.installationId)
        && isTimestamp(raw.createdAt)
        && isOptionalTimestamp(raw.claimedAt)
        && isOptionalText(raw.ownerPrincipalId)
        && isOptionalText(raw.ownerLabel)
        && Number.isInteger(raw.revision) && raw.revision >= 1
        && (raw.origin === undefined || ORIGINS.includes(raw.origin));
    if (!valid) return { ok: false, problem: 'CORRUPT' };
    return {
        ok: true,
        doc: {
            version: raw.version,
            installationId: raw.installationId,
            createdAt: raw.createdAt,
            claimedAt: raw.claimedAt,
            ownerPrincipalId: raw.ownerPrincipalId,
            ownerLabel: raw.ownerLabel,
            revision: raw.revision,
            origin: raw.origin || 'claim'
        }
    };
}

/**
 * @param {Object} params
 * @param {string} params.root
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 */
function createStore({ root, fs = nodeFs, now = () => new Date() }) {
    const paths = storePaths(root);

    /** Create the root and operations directory with owner-only permissions. Never touches a file. */
    function init() {
        try {
            files.ensureDir(paths.root, fs);
            files.ensureDir(paths.operations, fs);
            return { ok: true };
        } catch (error) {
            return { ok: false, problem: 'UNWRITABLE', errno: error && error.code ? String(error.code) : null };
        }
    }

    /**
     * @returns {{ status: 'missing'|'ok'|'corrupt'|'unsupported'|'unreadable', doc: Object|null }}
     */
    function readInstallation() {
        const read = files.readJson(paths.installation, fs);
        if (!read.exists) return { status: 'missing', doc: null };
        if (read.problem === 'UNREADABLE') return { status: 'unreadable', doc: null };
        if (read.problem === 'CORRUPT') return { status: 'corrupt', doc: null };
        const checked = validateInstallation(read.value);
        if (!checked.ok) return { status: checked.problem === 'UNSUPPORTED' ? 'unsupported' : 'corrupt', doc: null };
        return { status: 'ok', doc: checked.doc };
    }

    /**
     * Write a brand-new installation identity. Refuses to overwrite: an
     * existing file (readable or not) must be moved aside explicitly first.
     */
    function createInstallation({ ownerPrincipalId = null, ownerLabel = null, origin }) {
        if (!ORIGINS.includes(origin)) throw new Error(`unknown installation origin ${origin}`);
        const at = now().toISOString();
        const doc = {
            version: INSTALLATION_VERSION,
            installationId: crypto.randomUUID(),
            createdAt: at,
            claimedAt: at,
            ownerPrincipalId,
            ownerLabel,
            revision: 1,
            origin
        };
        files.writeExclusive(paths.installation, `${JSON.stringify(doc, null, 2)}\n`, fs);
        return doc;
    }

    /** Rename a damaged store file out of the way, keeping it for the operator. Returns the new name. */
    function moveAside(file) {
        const stamp = now().toISOString().replace(/[:.]/g, '-');
        const target = `${file}.unreadable-${stamp}`;
        fs.renameSync(file, target);
        files.fsyncDir(path.dirname(file), fs);
        return path.basename(target);
    }

    return { root, paths, init, readInstallation, createInstallation, moveAside };
}

module.exports = { INSTALLATION_VERSION, createStore, storePaths, validateInstallation };
