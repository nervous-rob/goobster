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

const model = require('../install/model');

/** The version a record with the engine's install section is written at; plain claim/adopt records stay at 1. */
const INSTALLATION_VERSION = 2;
const LEGACY_VERSION = 1;
const SEAL_VERSION = 1;
const ORIGINS = model.ORIGINS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function storePaths(root) {
    return {
        root,
        installation: path.join(root, 'installation.json'),
        seal: path.join(root, 'installation.seal'),
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
    if (raw.version !== INSTALLATION_VERSION && raw.version !== LEGACY_VERSION) return { ok: false, problem: 'UNSUPPORTED' };
    const valid = typeof raw.installationId === 'string' && UUID_RE.test(raw.installationId)
        && isTimestamp(raw.createdAt)
        && isOptionalTimestamp(raw.claimedAt)
        && isOptionalText(raw.ownerPrincipalId)
        && isOptionalText(raw.ownerLabel)
        && Number.isInteger(raw.revision) && raw.revision >= 1
        && (raw.origin === undefined || ORIGINS.includes(raw.origin));
    if (!valid) return { ok: false, problem: 'CORRUPT' };
    const fields = raw.version === LEGACY_VERSION ? { ok: true, install: model.emptyInstall() } : model.readInstallFields(raw);
    if (!fields.ok) return { ok: false, problem: 'CORRUPT' };
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
            origin: raw.origin || 'claim',
            ...fields.install
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

    const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

    function serialize(doc) {
        return `${JSON.stringify(doc, null, 2)}\n`;
    }

    function readSeal() {
        const read = files.readJson(paths.seal, fs);
        if (!read.exists) return null;
        const value = read.value;
        if (read.problem || !files.isPlainObject(value) || value.version !== SEAL_VERSION || !Number.isInteger(value.revision)) return { invalid: true };
        return value;
    }

    /**
     * Compare installation.json with its seal (`installation.seal`: the
     * revision and SHA-256 of the bytes the manager last wrote). A version 2
     * record without a matching seal was changed by something other than the
     * manager. A version 1 record has no seal and is `legacy`, accepted.
     * @returns {{ state: 'ok'|'legacy'|'tampered'|'missing', reason: string|null }}
     */
    function verifySeal() {
        let bytes;
        try {
            bytes = fs.readFileSync(paths.installation, 'utf8');
        } catch {
            return { state: 'missing', reason: null };
        }
        let doc;
        try {
            doc = JSON.parse(bytes);
        } catch {
            return { state: 'tampered', reason: 'UNPARSABLE' };
        }
        const seal = readSeal();
        if (!doc || doc.version === LEGACY_VERSION) return { state: 'legacy', reason: null };
        if (!seal || seal.invalid) return { state: 'tampered', reason: 'SEAL_MISSING' };
        const digest = sha256(bytes);
        if (digest !== seal.sha256 && digest !== seal.next) return { state: 'tampered', reason: 'HASH_MISMATCH' };
        if (doc.revision !== seal.revision) return { state: 'tampered', reason: 'REVISION_MISMATCH' };
        return { state: 'ok', reason: null };
    }

    /**
     * Replace installation.json and its seal. The seal first names the hash
     * about to be written (`next`), so a crash between the two writes leaves
     * a record that still verifies.
     */
    function sealedWrite(doc) {
        const text = serialize(doc);
        const previous = readSeal();
        files.writeJsonAtomic(paths.seal, {
            version: SEAL_VERSION,
            revision: doc.revision,
            sha256: previous && !previous.invalid && previous.next ? previous.next : (previous && !previous.invalid ? previous.sha256 : sha256(text)),
            next: sha256(text)
        }, fs);
        files.writeAtomic(paths.installation, text, fs);
        files.writeJsonAtomic(paths.seal, { version: SEAL_VERSION, revision: doc.revision, sha256: sha256(text) }, fs);
        return doc;
    }

    /**
     * Write a brand-new installation identity. Refuses to overwrite: an
     * existing file (readable or not) must be moved aside explicitly first.
     * With `install` the record is version 2 and sealed; without it the
     * #323 version 1 shape is kept.
     */
    function createInstallation({ ownerPrincipalId = null, ownerLabel = null, origin, install = null }) {
        if (!ORIGINS.includes(origin)) throw new Error(`unknown installation origin ${origin}`);
        const at = now().toISOString();
        const base = {
            version: install ? INSTALLATION_VERSION : LEGACY_VERSION,
            installationId: crypto.randomUUID(),
            createdAt: at,
            claimedAt: at,
            ownerPrincipalId,
            ownerLabel,
            revision: 1,
            origin
        };
        const doc = install ? { ...base, ...install, updatedAt: at } : base;
        if (install) {
            const checked = validateInstallation(JSON.parse(serialize(doc)));
            if (!checked.ok) throw new Error('the installation record is not valid');
            files.writeExclusive(paths.installation, serialize(doc), fs);
            files.writeJsonAtomic(paths.seal, { version: SEAL_VERSION, revision: doc.revision, sha256: sha256(serialize(doc)) }, fs);
        } else {
            files.writeExclusive(paths.installation, serialize(doc), fs);
            files.removeIfPresent(paths.seal, fs);
        }
        return doc;
    }

    /**
     * Replace the record with `change(copy)`, raising the revision. Refuses a
     * stale `expectedRevision` (`REVISION_CONFLICT`) and a record that does
     * not verify (`OWNERSHIP_TAMPERED`). The result is version 2 and sealed.
     */
    function updateInstallation(change, { expectedRevision = null } = {}) {
        const current = readInstallation();
        if (current.status !== 'ok') {
            const error = new Error('installation.json cannot be updated');
            error.code = 'INSTALLATION_UNAVAILABLE';
            throw error;
        }
        const seal = verifySeal();
        if (seal.state === 'tampered') {
            const error = new Error('installation.json does not match its seal');
            error.code = 'OWNERSHIP_TAMPERED';
            throw error;
        }
        if (expectedRevision !== null && current.doc.revision !== expectedRevision) {
            const error = new Error('installation.json changed');
            error.code = 'REVISION_CONFLICT';
            throw error;
        }
        const draft = change(JSON.parse(JSON.stringify(current.doc)));
        const next = { ...draft, version: INSTALLATION_VERSION, revision: current.doc.revision + 1, updatedAt: now().toISOString() };
        const checked = validateInstallation(JSON.parse(serialize(next)));
        if (!checked.ok) throw new Error('the installation record is not valid');
        return sealedWrite(next);
    }

    /** Remove the ownership record and its seal (uninstall). The operations journal stays. */
    function removeInstallation() {
        const removedRecord = files.removeIfPresent(paths.installation, fs);
        const removedSeal = files.removeIfPresent(paths.seal, fs);
        return removedRecord || removedSeal;
    }

    /** Rename a damaged store file out of the way, keeping it for the operator. Returns the new name. */
    function moveAside(file) {
        const stamp = now().toISOString().replace(/[:.]/g, '-');
        const target = `${file}.unreadable-${stamp}`;
        fs.renameSync(file, target);
        files.fsyncDir(path.dirname(file), fs);
        return path.basename(target);
    }

    return { root, paths, init, readInstallation, createInstallation, updateInstallation, removeInstallation, verifySeal, moveAside };
}

module.exports = { INSTALLATION_VERSION, LEGACY_VERSION, createStore, storePaths, validateInstallation };
