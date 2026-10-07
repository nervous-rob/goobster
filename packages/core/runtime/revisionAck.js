/**
 * Startup revision acknowledgement (documentation/manager_lifecycle.md).
 *
 * A worker the manager started with `GOOBSTER_REVISION=<n>` reports, once
 * it is ready to serve, that it runs revision n. The record is one small
 * file per worker under `<manager store>/ack/<worker>.json`:
 *
 *   { "version": 1, "worker": "bot", "revision": 3, "pid": 4242, "at": "2026-10-07T04:00:00.000Z" }
 *
 * written atomically (temp file + rename, owner-only). It never holds a
 * secret, a path, an environment value or anything a user sent. When
 * `GOOBSTER_MANAGER_URL` is set the same fields are also POSTed to the
 * manager's loopback ack route with the per-start token the manager put in
 * `GOOBSTER_MANAGER_ACK_TOKEN`; the file stays the record either way.
 *
 * Requiring this module touches nothing on disk.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ACK_VERSION = 1;
const WORKER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_REVISION = 2 ** 31 - 1;
const POST_TIMEOUT_MS = 2000;

/** The manager store directory as a worker sees it (same default as apps/manager/settings.js). */
function managerStateDir(env = process.env) {
    if (env.GOOBSTER_MANAGER_STATE_DIR) return env.GOOBSTER_MANAGER_STATE_DIR;
    const dataDir = env.GOOBSTER_DATA_DIR || require('../runtimePaths').dataDir;
    return path.join(dataDir, 'manager');
}

function ackDir(env = process.env) {
    return path.join(managerStateDir(env), 'ack');
}

function isWorkerName(name) {
    return typeof name === 'string' && WORKER_NAME.test(name);
}

function ackFile(worker, env = process.env) {
    if (!isWorkerName(worker)) throw new Error('revisionAck: invalid worker name');
    return path.join(ackDir(env), `${worker}.json`);
}

/** A non-negative integer revision from text, or null. */
function parseRevision(raw) {
    if (raw === undefined || raw === null) return null;
    const text = String(raw).trim();
    if (!/^\d{1,10}$/.test(text)) return null;
    const value = Number(text);
    return value <= MAX_REVISION ? value : null;
}

function writeAtomic(file, text, fs) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.unlinkSync(tmp); } catch { }
        throw error;
    }
}

/**
 * @param {Object} params
 * @param {string} params.worker
 * @param {number} params.revision
 * @param {number} [params.pid]
 * @param {Object} [params.env]
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 * @returns {{ version: number, worker: string, revision: number, pid: number, at: string }}
 */
function writeAck({ worker, revision, pid = process.pid, env = process.env, fs = nodeFs, now = () => new Date() }) {
    if (!Number.isInteger(revision) || revision < 0 || revision > MAX_REVISION) {
        throw new Error('revisionAck: revision must be a non-negative integer');
    }
    const record = { version: ACK_VERSION, worker, revision, pid, at: now().toISOString() };
    writeAtomic(ackFile(worker, env), `${JSON.stringify(record)}\n`, fs);
    return record;
}

/** Validated shape of an ack record, or null. */
function normalizeAck(value, worker) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.version !== ACK_VERSION || value.worker !== worker) return null;
    if (!Number.isInteger(value.revision) || value.revision < 0) return null;
    if (!Number.isInteger(value.pid) || value.pid <= 0) return null;
    if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return null;
    return { version: value.version, worker: value.worker, revision: value.revision, pid: value.pid, at: value.at };
}

/** The current ack for `worker`, or null when there is none or it does not parse. */
function readAck(worker, { env = process.env, fs = nodeFs } = {}) {
    let text;
    try {
        text = fs.readFileSync(ackFile(worker, env), 'utf8');
    } catch {
        return null;
    }
    try {
        return normalizeAck(JSON.parse(text), worker);
    } catch {
        return null;
    }
}

function clearAck(worker, { env = process.env, fs = nodeFs } = {}) {
    try { fs.unlinkSync(ackFile(worker, env)); } catch { }
}

/** POST the ack to the manager's loopback route. Never throws. */
function postAck({ url, worker, revision, pid, token, timeoutMs = POST_TIMEOUT_MS }) {
    return new Promise((resolve) => {
        let target;
        try {
            target = new URL('/manager/api/lifecycle/ack', url);
        } catch {
            resolve({ ok: false, error: 'BAD_URL' });
            return;
        }
        const transport = target.protocol === 'https:' ? require('node:https') : require('node:http');
        const body = JSON.stringify({ worker, revision, pid });
        const request = transport.request(target, {
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'x-goobster-ack-token': String(token || '')
            }
        }, (response) => {
            response.resume();
            resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode });
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', () => resolve({ ok: false, error: 'POST_FAILED' }));
        request.end(body);
    });
}

/**
 * Acknowledge `revision` for `worker`: the file first, then the optional
 * HTTP echo. Returns `{ skipped: true }` when there is no revision to
 * acknowledge (a worker started outside the manager). Never throws.
 */
async function acknowledge({ worker, revision, env = process.env, fs = nodeFs, logger = console }) {
    if (revision === null || revision === undefined) return { skipped: true };
    let record;
    try {
        record = writeAck({ worker, revision, env, fs });
    } catch (error) {
        logger.warn?.(`[lifecycle] could not write the revision acknowledgement: ${error && (error.code || error.name)}`);
        return { ok: false, error: 'ACK_WRITE_FAILED' };
    }
    if (env.GOOBSTER_MANAGER_URL) {
        const posted = await postAck({
            url: env.GOOBSTER_MANAGER_URL,
            worker,
            revision,
            pid: record.pid,
            token: env.GOOBSTER_MANAGER_ACK_TOKEN
        });
        return { ok: true, record, posted: posted.ok };
    }
    return { ok: true, record };
}

module.exports = {
    ACK_VERSION,
    managerStateDir,
    ackDir,
    ackFile,
    isWorkerName,
    parseRevision,
    writeAck,
    readAck,
    clearAck,
    normalizeAck,
    postAck,
    acknowledge
};
