/**
 * The maintenance barrier's state machine (documentation/maintenance_barrier.md).
 *
 *   plan → preflight → backup → quiesce → mutate → verify → cutover → release
 *   └──────── cancel-safe ─────────┘└──── irreversible once begun ────┘
 *
 * Phase 4.1 implements plan, preflight, quiesce, verification of the
 * quiescence and release. `backup`, `mutate`, `cutover` are the named hooks
 * a later kind fills through `advance()`; the journal, the boundaries and the
 * recovery rules around them are complete now.
 *
 * Every durable boundary is one atomic write of `<store>/maintenance.json`
 * (store.js): the fence and `active: true` are persisted *before* any writer
 * is asked to stop, and `active: false` is persisted *before* any writer is
 * told to resume, so a manager that dies between any two records leaves a
 * state the processes already act on and `recover` documents.
 *
 * Writers are reached through their control files and answer through the
 * fence acknowledgement files (packages/core/runtime/maintenance.js); the
 * HTTP echo to POST /maintenance/ack is a second record of the same fact.
 * Nothing here logs or journals a path, a secret or a row.
 */

const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const { ManagerError } = require('../errors');
const registry = require('../lifecycle/registry');
const { createLifecycleStore } = require('../lifecycle/store');
const { checkHealth: defaultCheckHealth } = require('../lifecycle/health');
const { resolveTargets } = require('./targets');
const {
    createMaintenanceStore,
    describe,
    summarize,
    isStale,
    PROCESS_BOOT_ID,
    defaultIsProcessAlive
} = require('./store');

const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 600;

/** Forward moves a later kind may make, by current phase. `quiesced` is the resting state after `quiesce`. */
const NEXT_PHASES = Object.freeze({
    quiesced: ['backup', 'mutate'],
    backup: ['quiesced', 'mutate'],
    mutate: ['verify'],
    verify: ['cutover'],
    cutover: []
});

const DEFAULT_TUNING = Object.freeze({
    timeoutScale: 1,
    pollMs: 200,
    downGraceMs: 3000,
    resumeWaitMs: 10_000
});

/** Test seam: per-store timing overrides, like the supervisor registry. */
const tuning = new Map();

function tune(storeDir, overrides) {
    if (overrides) tuning.set(storeDir, overrides);
    else tuning.delete(storeDir);
}

/**
 * A wait the process must survive: the CLI (`restore`, `reset`, `migrate`) waits for a writer's
 * acknowledgement here with nothing else holding its event loop, so an unref'd timer lets the process
 * end silently (exit 1, no message) in the middle of the barrier.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Object} params
 * @param {Object} params.settings
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 * @param {Object} [params.logger]
 * @param {string} [params.bootId] this manager process; a different one makes an active barrier stale
 * @param {(pid: number) => boolean} [params.isProcessAlive]
 * @param {(url: string) => Promise<boolean>} [params.checkHealth]
 * @param {Object} [params.timing] overrides of DEFAULT_TUNING
 */
function createBarrier({
    settings,
    fs = nodeFs,
    now = () => new Date(),
    logger = console,
    bootId = PROCESS_BOOT_ID,
    isProcessAlive = defaultIsProcessAlive,
    checkHealth = null,
    timing = null
}) {
    const storeDir = settings.storeDir;
    const store = createMaintenanceStore({ storeDir, fs, now });
    const lifecycleStore = createLifecycleStore({ storeDir, fs, now });
    const controlEnv = { GOOBSTER_MANAGER_STATE_DIR: storeDir };
    const staleOptions = { bootId, isProcessAlive };
    const cfg = { ...DEFAULT_TUNING, ...(tuning.get(storeDir) || {}), ...(timing || {}) };
    const iso = () => now().toISOString();

    const probe = (url) => {
        const supervisor = registry.get(storeDir);
        const check = checkHealth || (supervisor && supervisor.checkHealth) || defaultCheckHealth;
        return check(url);
    };

    /* --------------------------------------------------------------- reads */

    function view() {
        return describe(store.read(), staleOptions);
    }

    function summary() {
        return summarize(store.read(), staleOptions);
    }

    function readDoc() {
        const { doc, problem } = store.read();
        if (problem) {
            throw new ManagerError(409, 'MAINTENANCE_STATE_UNREADABLE',
                'maintenance.json in the manager store cannot be read; it was left as it is and the workers treat it as active. Fix or remove it, then retry.', { problem });
        }
        return doc;
    }

    /** What `maintenance.enter` checks at plan, validate and again inside the lock. */
    function assertEnterable() {
        const doc = readDoc();
        if (doc.active) {
            if (isStale(doc, staleOptions)) {
                throw new ManagerError(409, 'STALE_MAINTENANCE',
                    'A maintenance barrier left by an earlier manager process is still up. Inspect it (GET /manager/api/maintenance), then release it with force.',
                    { fence: doc.fence, operationId: doc.operationId, phase: doc.phase });
            }
            throw new ManagerError(409, 'MAINTENANCE_ACTIVE', 'Maintenance is already active; two maintenance operations never run at once.',
                { fence: doc.fence, operationId: doc.operationId, phase: doc.phase });
        }
        const lifecycle = lifecycleStore.read();
        if (lifecycle.problem) {
            throw new ManagerError(409, 'LIFECYCLE_STATE_UNREADABLE', 'lifecycle.json in the manager store cannot be read; fix or remove it, then retry.');
        }
        const running = registry.get(storeDir);
        if (lifecycle.doc.pending || (running && running.committing)) {
            throw new ManagerError(409, 'RESTART_PENDING', 'A staged restart is scheduled or under way; maintenance cannot begin until it finishes or is cancelled.',
                { revision: lifecycle.doc.pending ? lifecycle.doc.pending.revision : null });
        }
        return doc;
    }

    /** The writers maintenance would fence (names only), for the plan. */
    function plannedWriters(ctx) {
        const resolved = resolveTargets({
            settings,
            fs,
            supervisor: registry.get(storeDir),
            sandboxFeatureActive: () => ctx.createFeatureState().isActive('sandbox')
        });
        return resolved.targets.map(target => target.name);
    }

    /* -------------------------------------------------------------- refusal */

    function refuse({ code, message, details = {}, actor = null, phase = 'preflight' }) {
        try {
            store.update((doc) => {
                if (doc.active) return doc;
                store.record(doc, { phase, outcome: 'refused', action: 'maintenance.enter', code, actor });
                doc.lastOutcome = { operationId: null, fence: doc.fence, outcome: 'refused', code, at: iso() };
                return doc;
            });
        } catch { }
        return new ManagerError(409, code, message, details);
    }

    /* ------------------------------------------------------------ preflight */

    /**
     * Resolve the writers and refuse what cannot be fenced: a layout the
     * manager cannot resolve, a writer outside its reach, an unknown process
     * answering a worker's health URL.
     */
    async function preflight({ actor = null, ctx }) {
        assertEnterable();
        const resolved = resolveTargets({
            settings,
            fs,
            supervisor: registry.get(storeDir),
            sandboxFeatureActive: () => ctx.createFeatureState().isActive('sandbox')
        });
        if (resolved.error) {
            throw refuse({
                code: 'LAYOUT_UNRESOLVED',
                message: 'The installation layout cannot be resolved, so the writers cannot be enumerated; maintenance was refused.',
                details: { reason: resolved.error }, actor
            });
        }
        if (resolved.targets.length === 0) {
            throw refuse({ code: 'LAYOUT_UNRESOLVED', message: 'The layout names no worker, so the writers cannot be enumerated; maintenance was refused.', actor });
        }
        if (resolved.unfenceable.length > 0) {
            throw refuse({
                code: 'WRITER_UNFENCEABLE',
                message: 'A writer runs where the manager cannot reach it (a remote sandbox runner); maintenance was refused instead of fencing best effort.',
                details: { writers: resolved.unfenceable }, actor
            });
        }
        const unknown = [];
        for (const target of resolved.targets) {
            if (target.external || (target.running && target.state !== 'conflict')) continue;
            if (await probe(target.healthUrl)) unknown.push(target.name);
        }
        if (unknown.length > 0) {
            throw refuse({
                code: 'UNKNOWN_WRITER',
                message: 'A process the manager did not start answers a worker\'s health route; it cannot be fenced, so maintenance was refused.',
                details: { writers: unknown }, actor
            });
        }
        return resolved;
    }

    /* ---------------------------------------------------------------- enter */

    /** Persist the fence and `active: true`, phase `quiesce`, before any writer is asked to stop. */
    function begin({ operationId, actor = null, via = null, reason = null }) {
        assertEnterable();
        let fence = null;
        store.update((doc) => {
            if (doc.active) {
                throw new ManagerError(409, 'MAINTENANCE_ACTIVE', 'Maintenance is already active; two maintenance operations never run at once.');
            }
            fence = doc.fence + 1;
            doc.fence = fence;
            doc.active = true;
            doc.operationId = operationId;
            doc.phase = 'quiesce';
            doc.enteredAt = iso();
            doc.quiescedAt = null;
            doc.reason = reason;
            doc.actor = actor;
            doc.via = via;
            doc.owner = { pid: process.pid, bootId };
            doc.mutateBegun = false;
            doc.writers = {};
            store.record(doc, { phase: 'plan', outcome: 'ok', action: 'maintenance.enter', actor, fence });
            store.record(doc, { phase: 'preflight', outcome: 'ok', action: 'maintenance.enter', actor, fence });
            store.record(doc, { phase: 'quiesce', outcome: 'started', action: 'maintenance.enter', actor, fence });
            return doc;
        });
        return { fence };
    }

    function sendControl(name, request) {
        const current = coreLifecycle.readControl(name, { env: controlEnv, fs });
        coreLifecycle.writeControl(name, {
            boot: current ? current.boot : null,
            request: { id: crypto.randomUUID(), revision: null, at: iso(), ...request }
        }, { env: controlEnv, fs });
    }

    /** The acknowledgement of `fence` by this target's process, or null. */
    function matchAck(target, fence) {
        const file = coreMaintenance.readFenceAck(target.name, { env: controlEnv, fs });
        if (file && file.fence === fence && file.state === 'fenced' && (!target.pid || file.pid === target.pid)) {
            return { at: file.at, pid: file.pid };
        }
        const echo = target.fenceAck;
        if (target.pid && echo && echo.fence === fence && echo.state === 'fenced' && echo.pid === target.pid) {
            return { at: echo.at, pid: echo.pid };
        }
        return null;
    }

    /** Undo an entry that failed: `active: false` first, then tell the writers to resume. */
    function abort({ operationId, fence, code, writers = [], sent = [], actor = null }) {
        let stored = true;
        try {
            store.update((doc) => {
                if (!doc.active || doc.operationId !== operationId || doc.fence !== fence) return doc;
                store.record(doc, { phase: 'quiesce', outcome: 'refused', action: 'maintenance.enter', code, actor, fence });
                doc.lastOutcome = { operationId, fence, outcome: 'refused', code, at: iso(), ...(writers.length ? { writers } : {}) };
                doc.active = false;
                doc.phase = null;
                doc.operationId = null;
                doc.owner = null;
                doc.writers = {};
                doc.reason = null;
                doc.enteredAt = null;
                doc.quiescedAt = null;
                return doc;
            });
        } catch (error) {
            stored = false;
            logger.error?.(`[manager] could not record the refused maintenance entry: ${error && (error.code || error.name)}; the barrier stays up until it is released`);
        }
        if (stored) {
            for (const name of sent) {
                try { sendControl(name, { type: 'resume', drainSeconds: 0, fence }); } catch { }
            }
        }
        return stored;
    }

    /**
     * Ask every writer to stop and drain, and wait for each to acknowledge
     * *this* fence. Resolves with the per-writer record; on any failure the
     * entry is undone and a ManagerError is thrown.
     */
    async function quiesce({ operationId, fence, resolved, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, actor = null }) {
        const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000 * cfg.timeoutScale));
        const deadline = Date.now() + timeoutMs;
        const drainSeconds = Math.max(1, Math.min(timeoutSeconds, coreLifecycle.DRAIN_BOUND_SECONDS));
        const writers = {};
        const sent = [];
        const waiting = new Map();
        const fail = (code, message, names = []) => {
            abort({ operationId, fence, code, writers: names, sent, actor });
            return new ManagerError(409, code, message, { writers: names, fence });
        };
        try {
            for (const target of resolved.refresh()) {
                if (!target.external && !target.running) {
                    writers[target.name] = { acked: true, at: iso(), pid: null, note: 'not-running' };
                    continue;
                }
                try {
                    sendControl(target.name, { type: 'maintenance', drainSeconds, fence });
                } catch {
                    throw fail('CONTROL_WRITE_FAILED', 'The manager could not write a writer\'s control file, so it could not be asked to stop.', [target.name]);
                }
                sent.push(target.name);
                waiting.set(target.name, { downSince: null });
            }
            for (;;) {
                const byName = new Map(resolved.refresh().map(target => [target.name, target]));
                for (const [name, state] of [...waiting]) {
                    const target = byName.get(name);
                    if (!target) continue;
                    const ack = matchAck(target, fence);
                    if (ack) {
                        writers[name] = { acked: true, at: ack.at, pid: ack.pid };
                        waiting.delete(name);
                    } else if (!target.external && !target.running) {
                        writers[name] = { acked: true, at: iso(), pid: null, note: 'exited' };
                        waiting.delete(name);
                    } else if (target.external) {
                        if (await probe(target.healthUrl)) {
                            state.downSince = null;
                        } else {
                            state.downSince = state.downSince || Date.now();
                            if (Date.now() - state.downSince >= cfg.downGraceMs) {
                                writers[name] = { acked: true, at: iso(), pid: null, note: 'not-running' };
                                waiting.delete(name);
                            }
                        }
                    }
                }
                if (waiting.size === 0) break;
                if (Date.now() >= deadline) {
                    throw fail('WRITER_UNACKNOWLEDGED', 'A writer did not acknowledge the fence in time, so maintenance was refused.', [...waiting.keys()]);
                }
                await sleep(cfg.pollMs);
            }
        } catch (error) {
            if (error instanceof ManagerError) throw error;
            throw fail('QUIESCE_FAILED', 'The writers could not be quiesced; maintenance was refused.');
        }
        return { writers, sent };
    }

    /**
     * Verification of the quiescence: every acknowledgement still stands and
     * nothing answers where no writer was found. Persists `quiesced`.
     */
    async function verify({ operationId, fence, resolved, writers, sent = [], actor = null }) {
        const fail = (code, message, names) => {
            abort({ operationId, fence, code, writers: names, sent, actor });
            return new ManagerError(409, code, message, { writers: names, fence });
        };
        const lost = [];
        const byName = new Map(resolved.refresh().map(target => [target.name, target]));
        for (const [name, info] of Object.entries(writers)) {
            const target = byName.get(name);
            if (!target) continue;
            if (info.note) {
                if (await probe(target.healthUrl) && !matchAck(target, fence)) lost.push(name);
            } else if (!matchAck(target, fence)) {
                lost.push(name);
            }
        }
        if (lost.length > 0) {
            throw fail('QUIESCE_LOST', 'A writer is no longer fenced after it acknowledged; maintenance was refused.', lost);
        }
        try {
            store.update((doc) => {
                if (!doc.active || doc.operationId !== operationId || doc.fence !== fence) {
                    throw new ManagerError(409, 'FENCE_MISMATCH', 'The barrier changed while it was being entered.');
                }
                doc.phase = 'quiesced';
                doc.quiescedAt = iso();
                doc.writers = writers;
                store.record(doc, { phase: 'quiesce', outcome: 'ok', action: 'maintenance.enter', actor, fence });
                return doc;
            });
        } catch (error) {
            if (error instanceof ManagerError) throw error;
            throw fail('QUIESCE_FAILED', 'The quiescence could not be recorded; maintenance was refused.');
        }
        return view();
    }

    /* -------------------------------------------------------------- release */

    function assertReleasable(doc, { operationId, fence, force, acknowledgeMutation }) {
        if (!doc.active) throw new ManagerError(409, 'MAINTENANCE_NOT_ACTIVE', 'Maintenance is not active.');
        if (doc.operationId !== operationId || doc.fence !== fence) {
            throw new ManagerError(409, 'FENCE_MISMATCH', 'The operation id and fence do not match the active barrier; read GET /manager/api/maintenance.',
                { fence: doc.fence });
        }
        if (isStale(doc, staleOptions) && !force) {
            throw new ManagerError(409, 'STALE_MAINTENANCE',
                'This barrier was left by an earlier manager process; inspect it, then release it with force.', { fence: doc.fence, phase: doc.phase });
        }
        if (doc.mutateBegun && doc.phase !== 'cutover' && !acknowledgeMutation) {
            throw new ManagerError(409, 'MUTATION_NOT_COMPLETE',
                'The irreversible phase began and did not finish; inspect the installation, then release with acknowledgeMutation.', { phase: doc.phase });
        }
    }

    /** Check what release would do, without changing anything (plan and validate). */
    function checkRelease(args) {
        assertReleasable(readDoc(), args);
    }

    /**
     * Persist `active: false` (the durable truth every writer reconciles
     * from), then tell the writers to resume. Not un-pausing: the instance's
     * paused flag is never touched.
     */
    async function release({ operationId, fence, force = false, acknowledgeMutation = false, actor = null }) {
        let outcome = null;
        let writers = {};
        store.update((doc) => {
            assertReleasable(doc, { operationId, fence, force, acknowledgeMutation });
            outcome = doc.mutateBegun ? (doc.phase === 'cutover' ? 'completed' : 'abandoned') : 'released';
            writers = doc.writers || {};
            store.record(doc, { phase: 'release', outcome, action: 'maintenance.release', code: force ? 'FORCED' : null, actor, fence });
            doc.lastOutcome = { operationId, fence, outcome, at: iso(), ...(force ? { forced: true } : {}) };
            doc.active = false;
            doc.phase = null;
            doc.operationId = null;
            doc.owner = null;
            doc.writers = {};
            doc.reason = null;
            doc.enteredAt = null;
            doc.quiescedAt = null;
            doc.mutateBegun = false;
            return doc;
        });
        const resumed = await resume({ fence, expect: Object.keys(writers).filter(name => writers[name] && !writers[name].note) });
        return { outcome, fence, forced: Boolean(force), ...resumed };
    }

    /** Tell every writer to resume and wait (bounded) for the ones that had fenced to say so. Never throws. */
    async function resume({ fence, expect = [] }) {
        let names = expect;
        try {
            const resolved = resolveTargets({
                settings, fs, supervisor: registry.get(storeDir), sandboxFeatureActive: () => true
            });
            names = [...new Set([...expect, ...resolved.targets.map(target => target.name)])];
        } catch { }
        for (const name of names) {
            try { sendControl(name, { type: 'resume', drainSeconds: 0, fence }); } catch { }
        }
        const pending = new Set(expect);
        const deadline = Date.now() + cfg.resumeWaitMs;
        while (pending.size > 0) {
            for (const name of [...pending]) {
                const ack = coreMaintenance.readFenceAck(name, { env: controlEnv, fs });
                if (ack && ack.fence === fence && ack.state === 'resumed') pending.delete(name);
            }
            if (pending.size === 0 || Date.now() >= deadline) break;
            await sleep(cfg.pollMs);
        }
        return { resumed: expect.filter(name => !pending.has(name)), unconfirmed: [...pending] };
    }

    /* -------------------------------------------------------------- advance */

    /**
     * The hook a later kind (restore, reset, migration) uses to move the
     * barrier through `backup`, `mutate`, `verify`, `cutover`. `mutate` is
     * the irreversible boundary and is journaled before it begins.
     */
    function advance({ operationId, fence, to, actor = null }) {
        let from = null;
        const next = store.update((doc) => {
            if (!doc.active) throw new ManagerError(409, 'MAINTENANCE_NOT_ACTIVE', 'Maintenance is not active.');
            if (doc.operationId !== operationId || doc.fence !== fence) {
                throw new ManagerError(409, 'FENCE_MISMATCH', 'The operation id and fence do not match the active barrier.', { fence: doc.fence });
            }
            if (isStale(doc, staleOptions)) {
                throw new ManagerError(409, 'STALE_MAINTENANCE', 'This barrier was left by an earlier manager process and is never resumed automatically.', { fence: doc.fence });
            }
            from = doc.phase;
            if (!(NEXT_PHASES[doc.phase] || []).includes(to)) {
                throw new ManagerError(409, 'PHASE_NOT_ALLOWED', `The barrier cannot move from ${doc.phase} to ${to}.`, { from: doc.phase, to });
            }
            store.record(doc, { phase: to, outcome: 'started', action: 'maintenance.advance', actor, fence });
            if (to === 'mutate') doc.mutateBegun = true;
            doc.phase = to;
            return doc;
        });
        return { from, phase: next.phase, boundary: next.mutateBegun ? 'irreversible' : 'cancel-safe' };
    }

    /** Record how the current phase ended (`ok`, `failed`) with a code; the phase does not change. */
    function settle({ operationId, fence, outcome, code = null, actor = null }) {
        store.update((doc) => {
            if (!doc.active || doc.operationId !== operationId || doc.fence !== fence) {
                throw new ManagerError(409, 'FENCE_MISMATCH', 'The operation id and fence do not match the active barrier.', { fence: doc.fence });
            }
            store.record(doc, { phase: doc.phase, outcome, action: 'maintenance.advance', code, actor, fence });
            return doc;
        });
    }

    /**
     * Take over a barrier a handoff left with the previous manager process: the same operation and
     * fence the caller holds the record of (the update's handoff file), re-owned by this process.
     * Nothing else about the barrier changes. A barrier of another operation is never taken.
     */
    function adopt({ operationId, fence, actor = null }) {
        let from = null;
        store.update((doc) => {
            if (!doc.active) throw new ManagerError(409, 'MAINTENANCE_NOT_ACTIVE', 'Maintenance is not active.');
            if (doc.operationId !== operationId || doc.fence !== fence) {
                throw new ManagerError(409, 'FENCE_MISMATCH', 'The operation id and fence do not match the active barrier.', { fence: doc.fence });
            }
            from = doc.phase;
            doc.owner = { pid: process.pid, bootId };
            store.record(doc, { phase: doc.phase, outcome: 'adopted', action: 'maintenance.adopt', actor, fence });
            return doc;
        });
        return { phase: from };
    }

    return {
        store,
        view,
        summary,
        assertEnterable,
        plannedWriters,
        preflight,
        begin,
        quiesce,
        verify,
        abort,
        checkRelease,
        release,
        advance,
        settle,
        adopt,
        get timing() { return { ...cfg }; }
    };
}

module.exports = {
    createBarrier,
    tune,
    DEFAULT_TIMEOUT_SECONDS,
    MIN_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
    NEXT_PHASES
};
