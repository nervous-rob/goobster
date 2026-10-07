/**
 * The manager's environment overlay: `<managerStore>/environment.json`.
 *
 * Today `GOOBSTER_DB_URL` reaches the application only through the process
 * environment, which nothing persists. The overlay is the one manager-owned,
 * persistent place for such a value (a migration writes the new connection
 * here; later provisioning and service registration read it). It holds only
 * the keys in ALLOWED_KEYS, is written by atomic rename with mode 0600, and
 * is merged *beneath* the process environment: a value set in the process
 * environment (a unit file, a shell) wins, and the preflight reports
 * `ENV_OVERRIDES_OVERLAY` when the two differ.
 *
 * It is a secret store. Its values are never printed, journaled, audited,
 * put in the installation record or archived by a backup (the manager store
 * is not a backup file set); `install.uninstall` removes it with the store.
 * Requiring this module touches nothing on disk.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('./store/files');

const FILE_NAME = 'environment.json';
const VERSION = 1;
const ALLOWED_KEYS = Object.freeze(['GOOBSTER_DB_URL']);

const fileFor = (storeDir) => path.join(storeDir, FILE_NAME);

function sanitize(values) {
    const out = {};
    if (!files.isPlainObject(values)) return out;
    for (const key of ALLOWED_KEYS) {
        if (typeof values[key] === 'string' && values[key].length > 0 && values[key].length <= 4096 && !values[key].includes('\0')) out[key] = values[key];
    }
    return out;
}

/** @returns {{ present: boolean, values: Record<string, string>, problem: string|null }} never throws */
function read(storeDir, fs = nodeFs) {
    const result = files.readJson(fileFor(storeDir), fs);
    if (!result.exists) return { present: false, values: {}, problem: null };
    if (result.problem) return { present: true, values: {}, problem: result.problem };
    const doc = result.value;
    if (!files.isPlainObject(doc) || doc.version !== VERSION || !files.isPlainObject(doc.values)) {
        return { present: true, values: {}, problem: 'INVALID' };
    }
    return { present: true, values: sanitize(doc.values), problem: null };
}

/** Replace the overlay's values (only allow-listed keys are kept). One atomic rename, mode 0600. */
function write(storeDir, values, { fs = nodeFs, now = () => new Date() } = {}) {
    const kept = sanitize(values);
    files.ensureDir(storeDir, fs);
    files.writeJsonAtomic(fileFor(storeDir), { version: VERSION, values: kept, updatedAt: now().toISOString() }, fs);
    return Object.keys(kept);
}

function remove(storeDir, fs = nodeFs) {
    return files.removeIfPresent(fileFor(storeDir), fs);
}

/**
 * The environment the manager and its workers see: overlay values beneath
 * `env`. The same object comes back when there is nothing to add.
 */
function merge(env, values) {
    const add = {};
    for (const key of ALLOWED_KEYS) {
        if (values[key] !== undefined && (env[key] === undefined || env[key] === '')) add[key] = values[key];
    }
    return Object.keys(add).length === 0 ? env : { ...env, ...add };
}

/** Names only: which overlay keys the process environment overrides with a different value. */
function overridden(env, values) {
    return ALLOWED_KEYS.filter(key => values[key] !== undefined && env[key] !== undefined && env[key] !== '' && env[key] !== values[key]);
}

/** Make a running manager's settings see a new overlay (after a cutover). */
function apply(settings, values) {
    const merged = merge(settings.processEnv || settings.env, values);
    settings.env = merged;
    settings.dbUrl = merged.GOOBSTER_DB_URL || null;
    settings.environment = { overlayKeys: Object.keys(sanitize(values)), overridden: overridden(settings.processEnv || {}, values) };
    return settings;
}

module.exports = { ALLOWED_KEYS, FILE_NAME, fileFor, read, write, remove, merge, overridden, apply };
