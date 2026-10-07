/**
 * `<store>/native-postgres.json`: what the manager knows about the native
 * PostgreSQL cluster it owns (documentation/native_postgres.md) - enough to
 * resume or clean up an interrupted creation, to repair a missing service
 * definition and to finish or undo a relocation. It holds names, ports, paths,
 * the step reached and flags. It holds no password, no URL and no verifier:
 * the password lives in an operation's private input and, once the role
 * exists, in the overlay (environment.js). Mode 0600 like every file of the
 * store.
 *
 * The privileged helper reads this file as root before it touches a cluster
 * (`cluster.name`, `cluster.dataDirectory`, `cluster.port`, `relocation`): a
 * cluster, a data directory or a relocation the record does not name is
 * refused. The manager writes the record BEFORE it asks for the change.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('../store/files');

const FILE_NAME = 'native-postgres.json';
const VERSION = 1;
const STEPS = Object.freeze(['planned', 'packages', 'cluster', 'provisioned', 'schema', 'verified']);
const RELOCATION_STEPS = Object.freeze(['planned', 'backup', 'copied', 'switched', 'verified']);
const BIND = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const CLUSTER = /^goobster(-[0-9a-f]{8})?$/;
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const FAMILIES = ['debian', 'rhel'];

const fileFor = (storeDir) => path.join(storeDir, FILE_NAME);
const absolute = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && path.isAbsolute(value) && !value.includes('\0');

function sanitizeRelocation(value) {
    if (!files.isPlainObject(value) || !absolute(value.from) || !absolute(value.to) || !RELOCATION_STEPS.includes(value.step)) return null;
    return { from: value.from, to: value.to, step: value.step, backupVerified: value.backupVerified === true };
}

function sanitize(doc) {
    if (!files.isPlainObject(doc) || doc.version !== VERSION) return null;
    const cluster = files.isPlainObject(doc.cluster) ? doc.cluster : null;
    if (!cluster || typeof cluster.name !== 'string' || !CLUSTER.test(cluster.name) || !absolute(cluster.dataDirectory)) return null;
    if (!Number.isInteger(cluster.port) || typeof cluster.bind !== 'string' || !BIND.test(cluster.bind)) return null;
    if (typeof doc.installationId !== 'string' || !STEPS.includes(doc.step) || !FAMILIES.includes(doc.family)) return null;
    const created = files.isPlainObject(doc.created) ? doc.created : {};
    return {
        version: VERSION,
        installationId: doc.installationId,
        family: doc.family,
        distro: { id: String((doc.distro && doc.distro.id) || '').slice(0, 40), version: String((doc.distro && doc.distro.version) || '').slice(0, 40) },
        major: Number.isInteger(doc.major) ? doc.major : 17,
        cluster: {
            name: cluster.name,
            service: String(cluster.service || '').slice(0, 120),
            dataDirectory: cluster.dataDirectory,
            configDirectory: absolute(cluster.configDirectory) ? cluster.configDirectory : null,
            port: cluster.port,
            bind: cluster.bind,
            role: typeof cluster.role === 'string' && NAME.test(cluster.role) ? cluster.role : 'goobster',
            database: typeof cluster.database === 'string' && NAME.test(cluster.database) ? cluster.database : 'goobster'
        },
        step: doc.step,
        created: { cluster: created.cluster === true, packages: Array.isArray(created.packages) ? created.packages.filter(item => typeof item === 'string' && /^[a-z0-9][a-z0-9_.+-]{0,63}$/.test(item)).slice(0, 32) : [] },
        relocation: sanitizeRelocation(doc.relocation),
        operationId: typeof doc.operationId === 'string' ? doc.operationId.slice(0, 64) : null,
        createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : null,
        updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null
    };
}

/** @returns {{ present: boolean, doc: Object|null, problem: string|null }} never throws */
function read(storeDir, fs = nodeFs) {
    const result = files.readJson(fileFor(storeDir), fs);
    if (!result.exists) return { present: false, doc: null, problem: null };
    if (result.problem) return { present: true, doc: null, problem: result.problem };
    const doc = sanitize(result.value);
    return doc ? { present: true, doc, problem: null } : { present: true, doc: null, problem: 'INVALID' };
}

function write(storeDir, doc, { fs = nodeFs, now = () => new Date() } = {}) {
    const clean = sanitize({ ...doc, version: VERSION });
    if (!clean) throw new Error('the native instance record is not valid');
    const stamp = now().toISOString();
    const out = { ...clean, createdAt: clean.createdAt || stamp, updatedAt: stamp };
    files.ensureDir(storeDir, fs);
    files.writeJsonAtomic(fileFor(storeDir), out, fs);
    return out;
}

/** Merge `patch` into the record (created on first call from `base`). A `relocation` of `null` clears it. */
function update(storeDir, patch, { base = null, fs = nodeFs, now } = {}) {
    const current = read(storeDir, fs).doc || base;
    if (!current) throw new Error('there is no native instance record to update');
    const next = {
        ...current,
        ...patch,
        cluster: { ...current.cluster, ...(patch.cluster || {}) },
        created: { ...current.created, ...(patch.created || {}) },
        relocation: Object.prototype.hasOwnProperty.call(patch, 'relocation') ? patch.relocation : current.relocation
    };
    return write(storeDir, next, { fs, now });
}

function remove(storeDir, fs = nodeFs) {
    return files.removeIfPresent(fileFor(storeDir), fs);
}

const rank = (step) => STEPS.indexOf(step);

module.exports = { FILE_NAME, VERSION, STEPS, RELOCATION_STEPS, fileFor, read, write, update, remove, rank };
