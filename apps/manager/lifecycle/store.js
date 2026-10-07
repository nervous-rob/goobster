/**
 * `<store>/lifecycle.json`: the durable half of the supervisor
 * (documentation/manager_lifecycle.md). Written atomically through
 * store/files.js; read with a problem code instead of a throw.
 *
 *   current      the revision every required worker acknowledged last
 *   pending      the scheduled change: { revision, operationId, changeRef,
 *                changeKind, actor, via, announcedAt, deadline,
 *                graceSeconds, phase: 'countdown'|'committing', onExpired,
 *                committedAt?, restartOperationId? } or null
 *   lastOutcome  { revision, outcome: 'applied'|'failed', code, at, restartOperationId }
 *   workers      per worker: { lastExit, crashes: [iso], crashLoop, backoffMs, ackedRevision, restarts }
 *   events       the last EVENT_LIMIT `{ at, type, revision?, worker?, code? }`
 *
 * Names, revisions, codes and times only: never a path, an argument, an
 * environment value or a token.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const files = require('../store/files');
const { ManagerError } = require('../errors');

const LIFECYCLE_VERSION = 1;
const EVENT_LIMIT = 50;
const emitters = new Map();

function emptyDoc() {
    return { version: LIFECYCLE_VERSION, current: 0, pending: null, lastOutcome: null, workers: {}, events: [] };
}

function validate(value) {
    if (!files.isPlainObject(value) || value.version !== LIFECYCLE_VERSION) return null;
    if (!Number.isInteger(value.current) || value.current < 0) return null;
    if (value.pending !== null && !files.isPlainObject(value.pending)) return null;
    if (value.pending && (!Number.isInteger(value.pending.revision) || !['countdown', 'committing'].includes(value.pending.phase))) return null;
    if (value.lastOutcome !== null && value.lastOutcome !== undefined && !files.isPlainObject(value.lastOutcome)) return null;
    if (!files.isPlainObject(value.workers || {}) || !Array.isArray(value.events || [])) return null;
    return {
        version: LIFECYCLE_VERSION,
        current: value.current,
        pending: value.pending ? { ...value.pending } : null,
        lastOutcome: value.lastOutcome ? { ...value.lastOutcome } : null,
        workers: JSON.parse(JSON.stringify(value.workers || {})),
        events: (value.events || []).filter(files.isPlainObject).slice(-EVENT_LIMIT)
    };
}

/**
 * @param {Object} params
 * @param {string} params.storeDir
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 */
function createLifecycleStore({ storeDir, fs = nodeFs, now = () => new Date() }) {
    const file = path.join(storeDir, 'lifecycle.json');
    if (!emitters.has(file)) emitters.set(file, new EventEmitter());
    const emitter = emitters.get(file);

    /** @returns {{ doc: Object, problem: null|'UNREADABLE'|'CORRUPT' }} a missing file reads as the empty document */
    function read() {
        const result = files.readJson(file, fs);
        if (!result.exists) return { doc: emptyDoc(), problem: null };
        if (result.problem) return { doc: emptyDoc(), problem: result.problem };
        const doc = validate(result.value);
        return doc ? { doc, problem: null } : { doc: emptyDoc(), problem: 'CORRUPT' };
    }

    /** Read, change and replace. Refuses to overwrite a file it cannot read. */
    function update(change) {
        const { doc, problem } = read();
        if (problem) {
            throw new ManagerError(409, 'LIFECYCLE_STATE_UNREADABLE',
                'lifecycle.json in the manager store cannot be read; it was left as it is. Fix or remove it, then retry.', { problem });
        }
        const next = change(doc) || doc;
        next.updatedAt = now().toISOString();
        next.events = (next.events || []).slice(-EVENT_LIMIT);
        files.ensureDir(storeDir, fs);
        files.writeJsonAtomic(file, next, fs);
        emitter.emit('change', next);
        return next;
    }

    function event(doc, type, fields = {}) {
        doc.events = doc.events || [];
        doc.events.push({ at: now().toISOString(), type, ...fields });
        return doc;
    }

    function onChange(listener) {
        emitter.on('change', listener);
        return () => emitter.off('change', listener);
    }

    return { file, read, update, event, onChange };
}

module.exports = { createLifecycleStore, LIFECYCLE_VERSION, EVENT_LIMIT, emptyDoc };
