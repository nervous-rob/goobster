/**
 * The process side of the maintenance barrier (documentation/maintenance_barrier.md).
 *
 * Maintenance is a durable, fenced state of the whole installation in which
 * no application process writes to the database or the data tree. The
 * manager owns it (`<store>/maintenance.json`); every application process
 * carries a *fence* mirroring it:
 *
 *   admission   closed as soon as the process is asked to drain: new
 *               interactive work (HTTP writes, Discord commands, chat
 *               turns, WebSocket upgrades) is refused with MAINTENANCE.
 *   database    set once in-flight work settled: the database facade
 *               refuses `run`, `insert` and `transaction`
 *               (`MaintenanceError`, code `MAINTENANCE`) and the adapter
 *               moves to its engine-level read-only mode.
 *
 * It is not the operator *paused* flag (`instanceStateService`): paused is a
 * durable scheduling decision in the database; the fence lives in the
 * manager store and in process memory, and needs no database to be read.
 *
 * Requiring this module touches nothing on disk.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const revisionAck = require('./revisionAck');

const MAINTENANCE_VERSION = 1;
const FENCE_ACK_VERSION = 1;
const RETRY_AFTER_SECONDS = 30;
const POST_TIMEOUT_MS = 2000;

class MaintenanceError extends Error {
    constructor(message = 'Goobster is in maintenance: writes are refused until the operator releases it.') {
        super(message);
        this.name = 'MaintenanceError';
        this.code = 'MAINTENANCE';
        this.status = 503;
    }
}

const state = { admission: false, dbFenced: false, fence: null, unreadable: false, since: null };
const listeners = new Set();

function snapshot() {
    return {
        active: state.admission,
        phase: state.dbFenced ? 'fenced' : (state.admission ? 'draining' : null),
        fence: state.fence,
        unreadable: state.unreadable,
        since: state.since,
        retryAfter: RETRY_AFTER_SECONDS
    };
}

function emit() {
    const view = snapshot();
    for (const listener of [...listeners]) {
        try { listener(view); } catch { }
    }
}

/** New interactive work is refused from here on. Idempotent per fence. */
function begin(fence, { unreadable = false } = {}) {
    if (state.admission && state.fence === fence) return false;
    state.admission = true;
    state.fence = fence;
    state.unreadable = Boolean(unreadable);
    if (!state.since) state.since = new Date().toISOString();
    emit();
    return true;
}

/** In-flight work settled: the database refuses writes from here on. */
function fenceDb(fence) {
    if (!state.admission) begin(fence);
    if (state.dbFenced && state.fence === fence) return false;
    state.fence = fence;
    state.dbFenced = true;
    emit();
    return true;
}

/**
 * Clear the fence. `fence` must match the one held (the manager releases
 * the fence it set); a process that fenced itself from an unreadable store
 * clears on any release.
 * @returns {boolean} whether anything was cleared
 */
function release(fence = null) {
    if (!state.admission && !state.dbFenced) return false;
    if (fence !== null && state.fence !== null && state.fence !== fence && !state.unreadable) return false;
    state.admission = false;
    state.dbFenced = false;
    state.fence = null;
    state.unreadable = false;
    state.since = null;
    emit();
    return true;
}

const isActive = () => state.admission;
const isFenced = () => state.dbFenced;
const currentFence = () => state.fence;

/** Throws MaintenanceError while the database fence is set (the facade's backstop). */
function assertWritable() {
    if (state.dbFenced) throw new MaintenanceError();
}

function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function maintenanceFile(env = process.env) {
    return path.join(revisionAck.managerStateDir(env), 'maintenance.json');
}

/**
 * The manager store's verdict, read synchronously and without the
 * application database. A file that exists but cannot be read counts as
 * active (fail closed): the manager reports it and an operator fixes it.
 * @returns {{ status: 'absent'|'inactive'|'active'|'unreadable', fence: number|null, phase: string|null, operationId: string|null }}
 */
function readStore({ env = process.env, fs = nodeFs } = {}) {
    let text;
    try {
        text = fs.readFileSync(maintenanceFile(env), 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return { status: 'absent', fence: null, phase: null, operationId: null };
        return { status: 'unreadable', fence: null, phase: null, operationId: null };
    }
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        return { status: 'unreadable', fence: null, phase: null, operationId: null };
    }
    if (!doc || typeof doc !== 'object' || doc.version !== MAINTENANCE_VERSION || !Number.isInteger(doc.fence) || doc.fence < 0) {
        return { status: 'unreadable', fence: null, phase: null, operationId: null };
    }
    return {
        status: doc.active === true ? 'active' : 'inactive',
        fence: doc.fence,
        phase: typeof doc.phase === 'string' ? doc.phase : null,
        operationId: typeof doc.operationId === 'string' ? doc.operationId : null
    };
}

/**
 * A process that starts while the store says maintenance is active never
 * starts a writer: both the admission and the database fence are set before
 * anything else runs.
 * @returns {{ engaged: boolean, fence: number|null, status: string }}
 */
function engageFromStore({ env = process.env, fs = nodeFs } = {}) {
    const stored = readStore({ env, fs });
    if (stored.status === 'active') {
        begin(stored.fence);
        fenceDb(stored.fence);
        return { engaged: true, fence: stored.fence, status: stored.status };
    }
    if (stored.status === 'unreadable') {
        begin(0, { unreadable: true });
        fenceDb(0);
        return { engaged: true, fence: 0, status: stored.status };
    }
    return { engaged: false, fence: null, status: stored.status };
}

function ackDir(env = process.env) {
    return path.join(revisionAck.managerStateDir(env), 'maintenance-ack');
}

function fenceAckFile(worker, env = process.env) {
    if (!revisionAck.isWorkerName(worker)) throw new Error('maintenance: invalid worker name');
    return path.join(ackDir(env), `${worker}.json`);
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

/** `fenced` = stopped and drained for `fence`; `resumed` = running again after it. Ids, numbers and times only. */
function writeFenceAck({ worker, fence, state: ackState = 'fenced', pid = process.pid, env = process.env, fs = nodeFs, now = () => new Date() }) {
    if (!Number.isInteger(fence) || fence < 0) throw new Error('maintenance: fence must be a non-negative integer');
    if (!['fenced', 'resumed'].includes(ackState)) throw new Error('maintenance: bad ack state');
    const record = { version: FENCE_ACK_VERSION, worker, fence, state: ackState, pid, at: now().toISOString() };
    writeAtomic(fenceAckFile(worker, env), `${JSON.stringify(record)}\n`, fs);
    return record;
}

function readFenceAck(worker, { env = process.env, fs = nodeFs } = {}) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(fenceAckFile(worker, env), 'utf8'));
    } catch {
        return null;
    }
    if (!value || typeof value !== 'object' || value.version !== FENCE_ACK_VERSION || value.worker !== worker) return null;
    if (!Number.isInteger(value.fence) || value.fence < 0 || !['fenced', 'resumed'].includes(value.state)) return null;
    if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return null;
    return { version: value.version, worker: value.worker, fence: value.fence, state: value.state, pid: value.pid, at: value.at };
}

function clearFenceAck(worker, { env = process.env, fs = nodeFs } = {}) {
    try { fs.unlinkSync(fenceAckFile(worker, env)); } catch { }
}

/** Echo the ack to the manager's loopback route (the file stays the record). Never throws. */
function postFenceAck({ url, worker, fence, state: ackState, pid, token, timeoutMs = POST_TIMEOUT_MS }) {
    return new Promise((resolve) => {
        let target;
        try {
            target = new URL('/manager/api/lifecycle/ack', url);
        } catch {
            resolve({ ok: false, error: 'BAD_URL' });
            return;
        }
        const transport = target.protocol === 'https:' ? require('node:https') : require('node:http');
        const body = JSON.stringify({ worker, fence, state: ackState, pid });
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

/** File first, then the optional HTTP echo. Never throws. */
async function acknowledgeFence({ worker, fence, state: ackState = 'fenced', env = process.env, fs = nodeFs, logger = console }) {
    if (!worker) return { skipped: true };
    let record;
    try {
        record = writeFenceAck({ worker, fence, state: ackState, env, fs });
    } catch (error) {
        logger.warn?.(`[maintenance] could not write the fence acknowledgement: ${error && (error.code || error.name)}`);
        return { ok: false, error: 'ACK_WRITE_FAILED' };
    }
    if (env.GOOBSTER_MANAGER_URL) {
        const posted = await postFenceAck({
            url: env.GOOBSTER_MANAGER_URL, worker, fence, state: ackState, pid: record.pid, token: env.GOOBSTER_MANAGER_ACK_TOKEN
        });
        return { ok: true, record, posted: posted.ok };
    }
    return { ok: true, record };
}

/** Tests: forget everything this process holds. */
function _reset() {
    state.admission = false;
    state.dbFenced = false;
    state.fence = null;
    state.unreadable = false;
    state.since = null;
    emit();
}

module.exports = {
    MAINTENANCE_VERSION,
    FENCE_ACK_VERSION,
    RETRY_AFTER_SECONDS,
    MaintenanceError,
    snapshot,
    begin,
    fenceDb,
    release,
    isActive,
    isFenced,
    currentFence,
    assertWritable,
    onChange,
    maintenanceFile,
    readStore,
    engageFromStore,
    ackDir,
    fenceAckFile,
    writeFenceAck,
    readFenceAck,
    clearFenceAck,
    postFenceAck,
    acknowledgeFence,
    _reset
};
