/**
 * `<store>/docker-postgres.json`: what the manager knows about the Docker
 * Postgres instance it owns (documentation/docker_postgres.md) - enough to
 * resume or clean up an interrupted creation and to repair a missing
 * container over the same storage. It holds names, ports, paths, the step
 * reached and flags. It holds no password and no URL: those live in the
 * operation's private input and, once the role exists, in the overlay
 * (environment.js). Mode 0600 like every file of the store.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('../store/files');

const FILE_NAME = 'docker-postgres.json';
const VERSION = 1;
const STEPS = Object.freeze(['planned', 'network', 'volume', 'container', 'healthy', 'provisioned', 'schema', 'verified']);
const BIND = /^(127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\]|(?:\d{1,3}\.){3}\d{1,3})$/;

const fileFor = (storeDir) => path.join(storeDir, FILE_NAME);

function sanitize(doc) {
    if (!files.isPlainObject(doc) || doc.version !== VERSION) return null;
    const request = files.isPlainObject(doc.request) ? doc.request : null;
    if (!request || !Number.isInteger(request.port) || typeof request.bind !== 'string' || !BIND.test(request.bind)) return null;
    const storage = files.isPlainObject(request.storage) ? request.storage : { kind: 'volume' };
    if (!['volume', 'path'].includes(storage.kind) || (storage.kind === 'path' && (typeof storage.path !== 'string' || !path.isAbsolute(storage.path)))) return null;
    if (typeof doc.installationId !== 'string' || !STEPS.includes(doc.step)) return null;
    return {
        version: VERSION,
        installationId: doc.installationId,
        image: { reference: String((doc.image && doc.image.reference) || ''), major: Number(doc.image && doc.image.major) || null, minor: (doc.image && doc.image.minor) || null },
        request: {
            port: request.port,
            bind: request.bind,
            storage: storage.kind === 'path' ? { kind: 'path', path: storage.path } : { kind: 'volume' },
            role: String(request.role || 'goobster'),
            database: String(request.database || 'goobster'),
            memoryMb: Number.isInteger(request.memoryMb) ? request.memoryMb : null
        },
        step: doc.step,
        created: { network: doc.created && doc.created.network === true, volume: doc.created && doc.created.volume === true, container: doc.created && doc.created.container === true },
        dataInitialised: doc.dataInitialised === true,
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
    if (!clean) throw new Error('the Docker instance record is not valid');
    const stamp = now().toISOString();
    const out = { ...clean, createdAt: clean.createdAt || stamp, updatedAt: stamp };
    files.ensureDir(storeDir, fs);
    files.writeJsonAtomic(fileFor(storeDir), out, fs);
    return out;
}

/** Merge `patch` into the record (created on first call from `base`). */
function update(storeDir, patch, { base = null, fs = nodeFs, now } = {}) {
    const current = read(storeDir, fs).doc || base;
    if (!current) throw new Error('there is no Docker instance record to update');
    const next = { ...current, ...patch, request: { ...current.request, ...(patch.request || {}) }, created: { ...current.created, ...(patch.created || {}) }, image: { ...current.image, ...(patch.image || {}) } };
    return write(storeDir, next, { fs, now });
}

function remove(storeDir, fs = nodeFs) {
    return files.removeIfPresent(fileFor(storeDir), fs);
}

const rank = (step) => STEPS.indexOf(step);

module.exports = { FILE_NAME, VERSION, STEPS, fileFor, read, write, update, remove, rank };
