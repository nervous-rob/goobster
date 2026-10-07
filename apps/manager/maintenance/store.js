/**
 * `<store>/maintenance.json`: the durable half of the maintenance barrier
 * (documentation/maintenance_barrier.md). Written atomically through
 * store/files.js; read with a problem code instead of a throw.
 *
 *   active        the barrier is up
 *   fence         monotonically increasing integer; every entry increments
 *                 it and an inactive document keeps the last one
 *   operationId   the maintenance operation holding the barrier
 *   phase         null | 'quiesce' | 'quiesced' | 'backup' | 'mutate' |
 *                 'verify' | 'cutover'
 *   mutateBegun   `mutate` was entered: the irreversible boundary
 *   owner         { pid, bootId } of the manager that entered
 *   writers       per worker { acked, at, pid, note? }
 *   journal       the last JOURNAL_LIMIT phase records
 *   lastOutcome   how the previous barrier ended
 *
 * Ids, numbers, codes and times only: never a path, an argument, an
 * environment value, a token or a row. The worker processes read this file
 * themselves (packages/core/runtime/maintenance.js `readStore`), which only
 * trusts `version`, `active` and `fence`.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const files = require('../store/files');
const { ManagerError } = require('../errors');
const coreMaintenance = require('@goobster/core/runtime/maintenance');

const MAINTENANCE_VERSION = coreMaintenance.MAINTENANCE_VERSION;
const JOURNAL_LIMIT = 100;
const PROCESS_BOOT_ID = crypto.randomUUID();

/** The phases in order. `plan`..`quiesce` are cancel-safe; `mutate` onward is not. */
const PHASES = Object.freeze(['plan', 'preflight', 'backup', 'quiesce', 'mutate', 'verify', 'cutover', 'release']);
const CANCEL_SAFE_THROUGH = 'quiesce';
const IRREVERSIBLE_FROM = 'mutate';
const RESTING_PHASES = Object.freeze(['quiesce', 'quiesced', 'backup', 'mutate', 'verify', 'cutover']);
const OUTCOMES = Object.freeze(['refused', 'released', 'completed', 'abandoned']);

function emptyDoc() {
    return {
        version: MAINTENANCE_VERSION,
        active: false,
        operationId: null,
        fence: 0,
        phase: null,
        revision: 0,
        enteredAt: null,
        quiescedAt: null,
        reason: null,
        actor: null,
        via: null,
        owner: null,
        mutateBegun: false,
        writers: {},
        journal: [],
        lastOutcome: null,
        updatedAt: null
    };
}

function validate(value) {
    if (!files.isPlainObject(value) || value.version !== MAINTENANCE_VERSION) return null;
    if (typeof value.active !== 'boolean' || !Number.isInteger(value.fence) || value.fence < 0) return null;
    if (!Number.isInteger(value.revision) || value.revision < 0) return null;
    if (value.active && (typeof value.operationId !== 'string' || !RESTING_PHASES.includes(value.phase))) return null;
    if (value.owner !== null && value.owner !== undefined
        && !(files.isPlainObject(value.owner) && Number.isInteger(value.owner.pid) && typeof value.owner.bootId === 'string')) return null;
    if (!files.isPlainObject(value.writers || {}) || !Array.isArray(value.journal || [])) return null;
    if (value.lastOutcome !== null && value.lastOutcome !== undefined && !files.isPlainObject(value.lastOutcome)) return null;
    return {
        ...emptyDoc(),
        version: MAINTENANCE_VERSION,
        active: value.active,
        operationId: typeof value.operationId === 'string' ? value.operationId : null,
        fence: value.fence,
        phase: typeof value.phase === 'string' ? value.phase : null,
        revision: value.revision,
        enteredAt: typeof value.enteredAt === 'string' ? value.enteredAt : null,
        quiescedAt: typeof value.quiescedAt === 'string' ? value.quiescedAt : null,
        reason: typeof value.reason === 'string' ? value.reason : null,
        actor: typeof value.actor === 'string' ? value.actor : null,
        via: typeof value.via === 'string' ? value.via : null,
        owner: value.owner ? { pid: value.owner.pid, bootId: value.owner.bootId } : null,
        mutateBegun: value.mutateBegun === true,
        writers: JSON.parse(JSON.stringify(value.writers || {})),
        journal: (value.journal || []).filter(files.isPlainObject).slice(-JOURNAL_LIMIT),
        lastOutcome: value.lastOutcome ? { ...value.lastOutcome } : null,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null
    };
}

function defaultIsProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return Boolean(error && error.code === 'EPERM');
    }
}

/**
 * @param {Object} params
 * @param {string} params.storeDir
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 */
function createMaintenanceStore({ storeDir, fs = nodeFs, now = () => new Date() }) {
    const file = path.join(storeDir, 'maintenance.json');

    /** @returns {{ doc: Object, problem: null|'UNREADABLE'|'CORRUPT' }} a missing file reads as the empty, inactive document */
    function read() {
        const result = files.readJson(file, fs);
        if (!result.exists) return { doc: emptyDoc(), problem: null };
        if (result.problem) return { doc: emptyDoc(), problem: result.problem };
        const doc = validate(result.value);
        return doc ? { doc, problem: null } : { doc: emptyDoc(), problem: 'CORRUPT' };
    }

    /**
     * Read, change and replace, bumping `revision`. Refuses to overwrite a
     * file it cannot read: an unreadable barrier stays up (workers fail
     * closed on it) until an operator fixes or removes it.
     */
    function update(change) {
        const { doc, problem } = read();
        if (problem) {
            throw new ManagerError(409, 'MAINTENANCE_STATE_UNREADABLE',
                'maintenance.json in the manager store cannot be read; it was left as it is. Fix or remove it, then retry.', { problem });
        }
        const next = change(doc) || doc;
        next.revision = doc.revision + 1;
        next.updatedAt = now().toISOString();
        next.journal = (next.journal || []).slice(-JOURNAL_LIMIT);
        files.ensureDir(storeDir, fs);
        files.writeJsonAtomic(file, next, fs);
        return next;
    }

    /** Append one sanitized phase record: ids, codes and outcomes. */
    function record(doc, { phase, outcome, action, code = null, actor = null, fence = doc.fence }) {
        doc.journal = doc.journal || [];
        doc.journal.push({
            at: now().toISOString(),
            phase,
            outcome,
            action,
            fence,
            actor: actor === undefined ? null : actor,
            ...(code ? { code } : {})
        });
        return doc;
    }

    return { file, read, update, record };
}

/** `cancel-safe` through `quiesce`, `irreversible` once `mutate` began, null while inactive. */
function boundaryOf(doc) {
    if (!doc.active) return null;
    return doc.mutateBegun ? 'irreversible' : 'cancel-safe';
}

/**
 * A barrier whose owner is not this manager process (another boot id, or a
 * process that is gone) is stale: reported, never silently taken over.
 */
function isStale(doc, { bootId = PROCESS_BOOT_ID, isProcessAlive = defaultIsProcessAlive } = {}) {
    if (!doc.active) return false;
    if (!doc.owner) return true;
    if (doc.owner.bootId !== bootId) return true;
    return !isProcessAlive(doc.owner.pid);
}

/** `GET /status`: read from the store only, so it works with the application database offline. */
function summarize({ doc, problem }, options = {}) {
    if (problem) {
        return { active: true, phase: null, fence: null, since: null, stale: false, problem };
    }
    return {
        active: doc.active,
        phase: doc.active ? doc.phase : null,
        fence: doc.fence,
        since: doc.active ? doc.enteredAt : null,
        stale: isStale(doc, options),
        problem: null
    };
}

/** `GET /maintenance`: the whole sanitized state. */
function describe({ doc, problem }, options = {}) {
    if (problem) {
        return { ...summarize({ doc, problem }), operationId: null, reason: null, boundary: null, mutateBegun: false, revision: null, writers: {}, journal: [], lastOutcome: null };
    }
    const writers = {};
    for (const [name, info] of Object.entries(doc.writers || {})) {
        writers[name] = {
            acked: info.acked === true,
            at: info.at || null,
            pid: Number.isInteger(info.pid) ? info.pid : null,
            ...(info.note ? { note: String(info.note) } : {})
        };
    }
    return {
        ...summarize({ doc, problem }, options),
        operationId: doc.active ? doc.operationId : null,
        reason: doc.active ? doc.reason : null,
        boundary: boundaryOf(doc),
        mutateBegun: doc.mutateBegun,
        revision: doc.revision,
        enteredAt: doc.enteredAt,
        quiescedAt: doc.quiescedAt,
        writers,
        journal: doc.journal.slice(-20),
        lastOutcome: doc.lastOutcome
    };
}

/**
 * Boot-time recovery. An active barrier is honoured as it is: never lifted,
 * never resumed (a `mutate` phase least of all). A barrier whose owner is
 * gone is journaled once as recovered so the record shows the restart.
 * @returns {{ active: boolean, stale: boolean, problem: string|null, phase: string|null, fence: number|null, mutateBegun: boolean }}
 */
function recoverOnStart(store, options = {}) {
    const read = store.read();
    if (read.problem) return { active: true, stale: false, problem: read.problem, phase: null, fence: null, mutateBegun: false };
    const { doc } = read;
    if (!doc.active) return { active: false, stale: false, problem: null, phase: null, fence: doc.fence, mutateBegun: false };
    const stale = isStale(doc, options);
    const last = doc.journal[doc.journal.length - 1];
    if (stale && !(last && last.action === 'maintenance.recover' && last.fence === doc.fence)) {
        try {
            store.update((next) => {
                store.record(next, {
                    phase: next.phase,
                    outcome: 'recovered',
                    action: 'maintenance.recover',
                    code: next.mutateBegun ? 'MUTATE_NOT_RESUMED' : 'HONOURED',
                    fence: next.fence
                });
                return next;
            });
        } catch { }
    }
    return { active: true, stale, problem: null, phase: doc.phase, fence: doc.fence, mutateBegun: doc.mutateBegun };
}

module.exports = {
    MAINTENANCE_VERSION,
    JOURNAL_LIMIT,
    PROCESS_BOOT_ID,
    PHASES,
    CANCEL_SAFE_THROUGH,
    IRREVERSIBLE_FROM,
    RESTING_PHASES,
    OUTCOMES,
    emptyDoc,
    createMaintenanceStore,
    boundaryOf,
    isStale,
    summarize,
    describe,
    recoverOnStart,
    defaultIsProcessAlive
};
