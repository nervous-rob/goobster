/**
 * The supervisor: runs the workers of the installation's layout through an
 * adapter and performs the staged restart of the apply flow
 * (documentation/manager_lifecycle.md).
 *
 * Per worker ("slot"):
 *   starting  spawned, waiting for /health
 *   running   healthy; the revision acknowledgement is recorded when it arrives
 *   backoff   exited unexpectedly; restarting after BACKOFF_MS[n]
 *   crash-loop  CRASH_LIMIT exits inside CRASH_WINDOW_MS: not restarted until
 *             an operator `lifecycle.restart`
 *   conflict  something already answers the worker's health URL: not spawned
 *   stopping / stopped / external
 *
 * Exit 75 from a worker that was healthy is a requested restart: at once,
 * not a crash. Every start carries GOOBSTER_REVISION = the revision it runs:
 * `current` from lifecycle.json, except inside a commit.
 *
 * The commit (deadline reached or restart-now), holding the manager lock:
 *   stage → stop new work → stop → start at n+1 (staged) → health + ack from
 *   every worker → promote features.json → current = n+1
 * and on any failure: restart at n, features.json untouched, `rolled_back`.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const revisionAck = require('@goobster/core/runtime/revisionAck');
const { ManagerError } = require('../errors');
const files = require('../store/files');
const { readConfigJson } = require('../manager');
const { createLifecycleStore } = require('./store');
const layouts = require('./layouts');
const stage = require('./stage');
const { checkHealth: defaultCheckHealth } = require('./health');
const { noteWorkerStart } = require('../migration/state');

const DEFAULT_POLICY = Object.freeze({
    backoffMs: layouts.BACKOFF_MS,
    crashLimit: 5,
    crashWindowMs: 5 * 60_000,
    stableMs: 60_000,
    healthTimeoutMs: 60_000,
    readyTimeoutMs: 120_000,
    pollMs: 500,
    lockWaitMs: 30_000,
    lockRetryMs: 250,
    conflictRetryMs: 5_000,
    databaseWaitMs: 60_000,
    databasePollMs: 1000,
    drainSeconds: coreLifecycle.DRAIN_BOUND_SECONDS,
    stopTimeoutMs: null
});

const STATUS_EVENTS = 20;

function sleep(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

function tokenEquals(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * @param {Object} params
 * @param {ReturnType<import('../manager').createManager>} params.manager
 * @param {Object} params.adapter              child adapter (or a test fake): { start, run? }
 * @param {Object} [params.external]           external adapter, used when `settings.workersMode === 'external'`
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 * @param {Object} [params.logger]
 * @param {(url: string) => Promise<boolean>} [params.checkHealth]
 * @param {(worker: string) => Object|null} [params.readAck]
 * @param {() => boolean} [params.sandboxActive]
 * @param {Partial<typeof DEFAULT_POLICY>} [params.policy]
 * @param {number} [params.managerPid]
 */
function createSupervisor({
    manager,
    adapter,
    external = null,
    fs = nodeFs,
    now = () => new Date(),
    logger = console,
    checkHealth = defaultCheckHealth,
    readAck = null,
    sandboxActive = null,
    policy: policyOverrides = {},
    managerPid = process.pid
}) {
    const settings = manager.settings;
    const policy = { ...DEFAULT_POLICY, ...policyOverrides };
    const store = createLifecycleStore({ storeDir: settings.storeDir, fs, now });
    const ackEnv = { GOOBSTER_MANAGER_STATE_DIR: settings.storeDir };
    const ackOf = readAck || ((worker) => revisionAck.readAck(worker, { env: ackEnv, fs }));
    const externalMode = settings.workersMode === 'external';
    const slots = new Map();
    let plan = { layout: null, error: null, workers: [] };
    let started = false;
    let stopping = false;
    let abandoned = false;
    let committing = null;
    let countdownTimer = null;
    let unsubscribe = null;
    let stateProblem = null;
    const timers = new Set();

    const ms = () => now().getTime();

    function later(fn, delay) {
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (!abandoned && !stopping) fn();
        }, Math.max(0, delay));
        timer.unref?.();
        timers.add(timer);
        return timer;
    }

    function cancelTimer(timer) {
        if (!timer) return;
        clearTimeout(timer);
        timers.delete(timer);
    }

    function readDoc() {
        const { doc, problem } = store.read();
        stateProblem = problem;
        return doc;
    }

    /** Update lifecycle.json; a file that cannot be read is left alone and logged once per call site. */
    function safeUpdate(change) {
        try {
            return store.update(change);
        } catch (error) {
            if (error instanceof ManagerError && error.code === 'LIFECYCLE_STATE_UNREADABLE') {
                stateProblem = error.details?.problem || 'CORRUPT';
                logger.warn?.('[manager] lifecycle.json cannot be read; lifecycle state is kept in memory only until it is fixed');
                return null;
            }
            throw error;
        }
    }

    function config() {
        return readConfigJson(settings.configPath, fs).config;
    }

    /** The worker set; `stagedRevision` reads the sandbox feature from that revision's staged document. */
    function resolvePlan({ stagedRevision = null } = {}) {
        const cfg = config();
        let active = false;
        try {
            if (sandboxActive) {
                active = Boolean(sandboxActive({ stagedRevision }));
            } else if (stagedRevision !== null) {
                const doc = coreLifecycle.readStagedFeatures({ revision: stagedRevision, env: ackEnv, fs });
                active = Boolean(doc && doc.features && doc.features.sandbox && doc.features.sandbox.active);
            } else {
                active = Boolean(manager.createFeatureState().isActive('sandbox'));
            }
        } catch { }
        const resolved = layouts.workersFor({ settings, config: cfg, env: settings.env || {}, sandboxActive: active, drainSeconds: policy.drainSeconds });
        resolved.workers = resolved.workers.map(worker => ({
            ...worker,
            ...(externalMode ? { external: true } : {}),
            ...(policy.stopTimeoutMs ? { stopTimeoutMs: policy.stopTimeoutMs } : {})
        }));
        return resolved;
    }

    function slotFor(worker) {
        if (!slots.has(worker.name)) {
            slots.set(worker.name, {
                worker,
                handle: null,
                state: 'stopped',
                generation: 0,
                revision: null,
                staged: false,
                token: null,
                startedAt: null,
                healthy: false,
                healthyAt: null,
                ackedRevision: null,
                crashes: [],
                consecutive: 0,
                backoffMs: 0,
                restarts: 0,
                lastExit: null,
                crashLoop: false,
                hold: false,
                intentional: false,
                timer: null,
                stableTimer: null,
                lastCode: null
            });
        }
        const slot = slots.get(worker.name);
        slot.worker = worker;
        return slot;
    }

    function persistWorker(slot, eventType, fields = {}) {
        safeUpdate((doc) => {
            doc.workers[slot.worker.name] = {
                lastExit: slot.lastExit,
                crashes: slot.crashes.map(t => new Date(t).toISOString()),
                crashLoop: slot.crashLoop,
                backoffMs: slot.backoffMs,
                ackedRevision: slot.ackedRevision,
                restarts: slot.restarts
            };
            if (eventType) store.event(doc, eventType, { worker: slot.worker.name, ...fields });
            return doc;
        });
    }

    function currentRevision() {
        return readDoc().current;
    }

    /** A Docker or native Postgres database this manager owns must answer before a worker starts into it (documentation/docker_postgres.md, documentation/native_postgres.md); any other installation passes at once. */
    async function databaseGate() {
        if (policy.databaseGate) return policy.databaseGate();
        try {
            return await require('../docker/readiness').createReadiness({ settings, fs, now, logger }).waitReady({ timeoutMs: policy.databaseWaitMs, pollMs: policy.databasePollMs });
        } catch {
            return { owned: false, ready: true, code: null, reason: null };
        }
    }

    /**
     * Start one worker at `revision`. Resolves once the process is spawned
     * (or refused); readiness is watched separately.
     */
    async function launch(slot, { revision, staged = false, requestId = null } = {}) {
        const worker = slot.worker;
        cancelTimer(slot.timer);
        slot.timer = null;
        slot.generation += 1;
        const generation = slot.generation;
        slot.revision = revision;
        slot.staged = Boolean(staged);
        slot.healthy = false;
        slot.healthyAt = null;
        slot.ackedRevision = null;
        slot.intentional = false;
        slot.startedAt = ms();
        slot.lastCode = null;
        slot.fenceAck = null;

        if (worker.external) {
            const ext = external;
            if (!ext) {
                slot.state = 'conflict';
                slot.lastCode = 'NO_EXTERNAL_ADAPTER';
                return generation;
            }
            slot.handle = requestId
                ? ext.start(worker, { revision, staged, drainSeconds: policy.drainSeconds, id: requestId })
                : ext.attach(worker, { revision });
            slot.state = 'external';
            slot.token = null;
            watch(slot, generation);
            return generation;
        }

        noteWorkerStart({ storeDir: settings.storeDir, fs, now });

        const database = await databaseGate();
        if (!database.ready) {
            slot.state = 'conflict';
            slot.lastCode = database.code;
            logger.warn?.(`[manager] the managed database is not ready (${database.reason}); not starting ${worker.name} until it answers`);
            if (!slot.hold) slot.timer = later(() => launch(slot, { revision: currentRevision() }), policy.conflictRetryMs);
            return generation;
        }

        if (await checkHealth(worker.healthUrl)) {
            slot.state = 'conflict';
            slot.lastCode = 'WORKER_ALREADY_RUNNING';
            logger.warn?.(`[manager] something already answers the ${worker.name} health route; not starting a second copy`);
            if (!slot.hold) slot.timer = later(() => launch(slot, { revision: currentRevision() }), policy.conflictRetryMs);
            return generation;
        }

        const extra = layouts.startEnv({ revision, staged, managerPid });
        slot.token = extra.GOOBSTER_MANAGER_ACK_TOKEN;
        const env = { ...(settings.env || {}), ...worker.env, ...extra };
        revisionAck.clearAck(worker.name, { env: ackEnv, fs });
        slot.state = 'starting';
        if (worker.preStart && typeof adapter.run === 'function') {
            try {
                const outcome = await adapter.run(worker.preStart, { env });
                if (outcome.timedOut || outcome.code !== 0) {
                    logger.warn?.(`[manager] ${worker.preStart.name} for ${worker.name} did not finish cleanly (${outcome.timedOut ? 'timed out' : `exit ${outcome.code}`}); starting the worker anyway`);
                }
            } catch {
                logger.warn?.(`[manager] ${worker.preStart.name} for ${worker.name} could not run; starting the worker anyway`);
            }
            if (generation !== slot.generation || stopping || abandoned) return generation;
        }
        let handle;
        try {
            handle = adapter.start(worker, { env });
        } catch (error) {
            slot.handle = null;
            onExit(slot, generation, { code: null, signal: null, error: error.code || 'SPAWN_FAILED' });
            return generation;
        }
        slot.handle = handle;
        handle.exited.then(exit => onExit(slot, generation, exit));
        watch(slot, generation);
        return generation;
    }

    /** Health and ack polling for one start; resolves with readiness for callers that wait. */
    function watch(slot, generation) {
        const startedAt = ms();
        const healthDeadline = startedAt + (slot.hold ? policy.readyTimeoutMs : policy.healthTimeoutMs);
        const ackDeadline = startedAt + policy.readyTimeoutMs;
        slot.ready = (async () => {
            for (;;) {
                if (abandoned || stopping || generation !== slot.generation) return { ok: false, code: 'SUPERSEDED' };
                if (slot.handle && !slot.handle.external && !slot.handle.running()) return { ok: false, code: 'EXITED_BEFORE_READY' };
                if (!slot.healthy && await checkHealth(slot.worker.healthUrl)) {
                    if (generation !== slot.generation) return { ok: false, code: 'SUPERSEDED' };
                    slot.healthy = true;
                    slot.healthyAt = ms();
                    if (slot.state === 'starting') slot.state = 'running';
                    cancelTimer(slot.stableTimer);
                    slot.stableTimer = later(() => { slot.consecutive = 0; }, policy.stableMs);
                }
                if (slot.ackedRevision !== slot.revision || slot.ackGeneration !== generation) noteFileAck(slot, generation);
                const acked = slot.ackGeneration === generation && slot.ackedRevision === slot.revision;
                if (slot.healthy && acked) return { ok: true, code: null };
                if (!slot.healthy && ms() >= healthDeadline) return { ok: false, code: 'HEALTH_TIMEOUT' };
                if (ms() >= ackDeadline) return { ok: false, code: 'ACK_TIMEOUT' };
                await sleep(policy.pollMs);
            }
        })();
        if (!slot.hold && !slot.worker.external) {
            slot.ready.then((ready) => {
                if (ready.ok || ready.code === 'SUPERSEDED' || generation !== slot.generation || slot.hold) return;
                if (ready.code === 'ACK_TIMEOUT') return;
                if (ready.code === 'HEALTH_TIMEOUT') failStart(slot, generation, 'HEALTH_TIMEOUT');
            });
        }
        return slot.ready;
    }

    function noteFileAck(slot, generation) {
        const ack = ackOf(slot.worker.name);
        if (!ack || ack.revision !== slot.revision) return;
        if (slot.handle && slot.handle.external) {
            if (slot.handle.requestedAt && ack.at < slot.handle.requestedAt) return;
        } else if (!slot.handle || ack.pid !== slot.handle.pid) {
            return;
        }
        acknowledge(slot, generation, ack.revision);
    }

    function acknowledge(slot, generation, revision) {
        const fresh = slot.ackGeneration !== generation || slot.ackedRevision !== revision;
        slot.ackedRevision = revision;
        slot.ackGeneration = generation;
        if (fresh) persistWorker(slot, 'acked', { revision });
    }

    /** A start that never became healthy: stop it and count it like a crash. */
    async function failStart(slot, generation, code) {
        if (generation !== slot.generation || !slot.handle) return;
        slot.lastCode = code;
        slot.intentional = true;
        slot.state = 'stopping';
        const outcome = await slot.handle.stop({ timeoutMs: slot.worker.stopTimeoutMs });
        if (generation !== slot.generation) return;
        recordCrash(slot, { ...(outcome.exit || { code: null, signal: null }), reason: code });
    }

    function onExit(slot, generation, exit) {
        if (generation !== slot.generation) return;
        const healthyBefore = slot.healthy;
        slot.healthy = false;
        cancelTimer(slot.stableTimer);
        if (abandoned) return;
        const reason = exit.error
            ? exit.error
            : (exit.code === coreLifecycle.EXIT_RESTART && healthyBefore ? 'RESTART_REQUESTED'
                : (healthyBefore ? 'EXITED' : 'EXITED_BEFORE_HEALTHY'));
        slot.lastExit = { code: exit.code ?? null, signal: exit.signal || null, reason, at: now().toISOString() };
        if (slot.intentional || stopping) {
            slot.state = 'stopped';
            return;
        }
        if (slot.hold) {
            slot.state = 'exited';
            return;
        }
        if (reason === 'RESTART_REQUESTED') {
            slot.restarts += 1;
            persistWorker(slot, 'restart-requested', { revision: slot.revision });
            launch(slot, { revision: currentRevision() });
            return;
        }
        recordCrash(slot, slot.lastExit);
    }

    function recordCrash(slot, exit) {
        const t = ms();
        slot.lastExit = { code: exit.code ?? null, signal: exit.signal || null, reason: exit.reason || 'EXITED', at: new Date(t).toISOString() };
        slot.crashes = slot.crashes.filter(at => t - at < policy.crashWindowMs);
        slot.crashes.push(t);
        if (slot.crashes.length >= policy.crashLimit) {
            slot.crashLoop = true;
            slot.state = 'crash-loop';
            slot.backoffMs = 0;
            logger.error?.(`[manager] ${slot.worker.name} exited ${slot.crashes.length} times in ${Math.round(policy.crashWindowMs / 1000)} s: CRASH_LOOP, not restarting until an operator restart`);
            persistWorker(slot, 'crash-loop', { code: 'CRASH_LOOP' });
            return;
        }
        const steps = policy.backoffMs;
        slot.backoffMs = steps[Math.min(slot.consecutive, steps.length - 1)];
        slot.consecutive += 1;
        slot.state = 'backoff';
        logger.warn?.(`[manager] ${slot.worker.name} exited (${slot.lastExit.reason}${exit.code !== null && exit.code !== undefined ? `, code ${exit.code}` : ''}${exit.signal ? `, ${exit.signal}` : ''}); restarting in ${slot.backoffMs / 1000} s`);
        persistWorker(slot, 'crash', { code: slot.lastExit.reason, backoffMs: slot.backoffMs });
        slot.timer = later(() => {
            if (slot.hold || slot.state !== 'backoff') return;
            launch(slot, { revision: currentRevision() });
        }, slot.backoffMs);
    }

    async function stopSlot(slot, { requestId = null } = {}) {
        cancelTimer(slot.timer);
        slot.timer = null;
        cancelTimer(slot.stableTimer);
        if (!slot.handle || slot.handle.external) return { forced: false };
        if (!slot.handle.running()) {
            slot.state = 'stopped';
            return { forced: false };
        }
        slot.intentional = true;
        slot.state = 'stopping';
        const outcome = await slot.handle.stop({ timeoutMs: slot.worker.stopTimeoutMs, id: requestId });
        slot.state = 'stopped';
        if (outcome.forced) {
            safeUpdate(doc => store.event(doc, 'forced-stop', { worker: slot.worker.name }));
        }
        return outcome;
    }

    /* ------------------------------------------------------------ countdown */

    function arm() {
        if (abandoned || stopping || !started) return;
        const doc = readDoc();
        cancelTimer(countdownTimer);
        countdownTimer = null;
        const pending = doc.pending;
        if (!pending) return;
        if (pending.phase === 'committing') {
            if (!committing) commit();
            return;
        }
        const delay = Date.parse(pending.deadline) - ms();
        countdownTimer = later(() => {
            countdownTimer = null;
            commit();
        }, delay);
    }

    /* --------------------------------------------------------------- commit */

    async function acquireLock(restartId, operationId) {
        const deadline = ms() + policy.lockWaitMs;
        for (;;) {
            const pending = readDoc().pending;
            if (!pending || pending.operationId !== operationId) return { held: null, gone: true };
            try {
                return { held: manager.lock.acquire(restartId), gone: false };
            } catch (error) {
                if (!(error instanceof ManagerError) || error.code !== 'OPERATION_IN_PROGRESS') throw error;
                if (ms() >= deadline) return { held: null, gone: false };
            }
            await sleep(policy.lockRetryMs);
        }
    }

    function restartRecord(pending, { cause, from, to }) {
        const record = manager.journal.create({
            kind: 'lifecycle.restart',
            actor: pending ? pending.actor ?? null : null,
            via: pending ? pending.via : 'manager',
            plan: {
                cause,
                changeRef: pending ? pending.changeRef : null,
                applyOperationId: pending ? pending.operationId : null,
                from,
                to,
                workers: plan.workers.map(worker => worker.name)
            },
            revision: from
        });
        return manager.journal.update(record.id, (r) => {
            r.status = 'applying';
            return r;
        });
    }

    async function finishRecord(record, status, code) {
        manager.journal.update(record.id, (r) => {
            r.status = status;
            if (code) r.error = { code, message: `The restart ended with ${code}.` };
            return r;
        });
        try {
            await manager.journal.appendAudit({
                action: 'manager.lifecycle.restart',
                actor: record.actor,
                operationId: record.id,
                outcome: status,
                via: record.via
            });
            if (settings.reconcile) manager.reconcile();
        } catch {
            logger.error?.(`[manager] could not append the audit record for operation ${record.id}`);
        }
    }

    /**
     * Committed: every running worker stops admitting work first (so none
     * takes new work while another drains), then all stop together, each
     * bounded by its stopTimeoutMs. External workers are left to their unit.
     */
    async function stopEverything({ revision, requestId, announce = true }) {
        const all = [...slots.values()];
        for (const slot of all) {
            slot.hold = true;
            cancelTimer(slot.timer);
            slot.timer = null;
            if (announce && slot.handle && slot.handle.running()) {
                slot.handle.stopNewWork({ revision, drainSeconds: policy.drainSeconds, id: requestId });
            }
        }
        if (!externalMode) await Promise.all(all.map(slot => stopSlot(slot, { requestId })));
    }

    function adoptPlan(next) {
        plan = next;
        for (const name of [...slots.keys()]) {
            if (!plan.workers.some(worker => worker.name === name)) slots.delete(name);
        }
    }

    /** Start every worker of the plan at `revision` and wait for health + ack from all of them. */
    async function startAll(revision, { staged, requestId }) {
        const ordered = plan.workers.map(worker => slotFor(worker));
        for (const slot of ordered) {
            slot.hold = true;
            await launch(slot, { revision, staged, requestId });
        }
        const results = await Promise.all(ordered.map(async (slot) => {
            if (slot.state === 'conflict') return { name: slot.worker.name, ok: false, code: slot.lastCode };
            const ready = slot.ready ? await slot.ready : { ok: false, code: 'NOT_STARTED' };
            return { name: slot.worker.name, ...ready };
        }));
        const failed = results.find(result => !result.ok);
        return failed ? { ok: false, code: failed.code, worker: failed.name } : { ok: true };
    }

    function releaseHolds() {
        for (const slot of slots.values()) {
            slot.hold = false;
            if (slot.worker.external || stopping || abandoned) continue;
            if (slot.state === 'exited' || (slot.handle && !slot.handle.running() && !['crash-loop', 'backoff'].includes(slot.state))) {
                recordCrash(slot, slot.lastExit || { code: null, signal: null, reason: 'EXITED' });
            } else if (slot.state === 'starting' && !slot.healthy) {
                failStart(slot, slot.generation, 'HEALTH_TIMEOUT');
            }
        }
    }

    function previousConfigFile(changeRef) {
        return path.join(manager.store.paths.operations, `${changeRef}.previous-config.json`);
    }

    /**
     * Config recovery on rollback: only for a configuration change whose
     * previous config.json bytes the config kind (#324) saved beside the
     * journal. Never the database.
     */
    function recoverConfig(pending) {
        if (pending.changeKind !== 'config.set') return null;
        if (!manager.journal.isId(pending.changeRef)) return 'NO_PREVIOUS_CONFIG';
        const read = files.readJson(previousConfigFile(pending.changeRef), fs);
        if (!read.exists || read.problem || !files.isPlainObject(read.value)) return 'NO_PREVIOUS_CONFIG';
        try {
            files.writeJsonAtomic(settings.configPath, read.value, fs);
            return 'RESTORED';
        } catch {
            return 'RESTORE_FAILED';
        }
    }

    function commit() {
        if (committing) return committing;
        let done;
        committing = new Promise((resolve) => { done = resolve; });
        const current = committing;
        Promise.resolve()
            .then(runCommit)
            .catch((error) => {
                logger.error?.(`[manager] the staged restart failed unexpectedly: ${error && (error.code || error.name)}`);
            })
            .finally(() => {
                if (committing === current) committing = null;
                done();
            });
        return current;
    }

    async function runCommit() {
        const doc = readDoc();
        const pending = doc.pending;
        if (!pending || abandoned || stopping) return;
        const from = doc.current;
        const to = pending.revision;
        const record = restartRecord(pending, { cause: 'apply', from, to });
        const { held, gone } = await acquireLock(record.id, pending.operationId);
        if (!held) {
            if (gone) {
                manager.journal.update(record.id, (r) => { r.status = 'cancelled'; return r; });
                return;
            }
            safeUpdate((next) => {
                next.pending = null;
                next.lastOutcome = { revision: to, outcome: 'failed', code: 'OPERATION_IN_PROGRESS', at: now().toISOString(), restartOperationId: record.id };
                store.event(next, 'failed', { revision: to, code: 'OPERATION_IN_PROGRESS' });
                return next;
            });
            await finishRecord(record, 'failed', 'OPERATION_IN_PROGRESS');
            return;
        }
        const progress = { touched: false };
        let outcome;
        try {
            outcome = await attemptCommit({ pending, to, record, progress });
        } catch (error) {
            logger.error?.(`[manager] the staged restart failed unexpectedly: ${error && (error.code || error.name)}`);
            outcome = { ok: false, code: 'INTERNAL' };
        }
        try {
            if (outcome.ok) {
                safeUpdate((next) => {
                    next.current = to;
                    next.pending = null;
                    next.lastOutcome = { revision: to, outcome: 'applied', code: null, at: now().toISOString(), restartOperationId: record.id };
                    for (const slot of slots.values()) {
                        if (next.workers[slot.worker.name]) next.workers[slot.worker.name].ackedRevision = slot.ackedRevision;
                    }
                    store.event(next, 'promoted', { revision: to });
                    return next;
                });
                releaseHolds();
                held.release();
                await finishRecord(record, 'applied', null);
            } else if (outcome.code === 'CANCELLED') {
                manager.journal.update(record.id, (r) => { r.status = 'cancelled'; return r; });
            } else if (!abandoned) {
                await rollback({ pending, from, to, record, code: outcome.code, worker: outcome.worker, touched: progress.touched });
            }
        } finally {
            held.release();
        }
    }

    /** One commit attempt, inside the lock. Returns the outcome; never promotes on a failure. */
    async function attemptCommit({ pending, to, record, progress }) {
        const committed = safeUpdate((next) => {
            if (!next.pending || next.pending.operationId !== pending.operationId) return next;
            next.pending = { ...next.pending, phase: 'committing', committedAt: now().toISOString(), restartOperationId: record.id };
            store.event(next, 'committed', { revision: to });
            return next;
        });
        if (!committed || !committed.pending || committed.pending.operationId !== pending.operationId) {
            return { ok: false, code: committed ? 'CANCELLED' : 'LIFECYCLE_STATE_UNREADABLE' };
        }
        const staged = pending.changeKind === 'features.set';
        let fromFeatures = null;
        try {
            await stage.stagePayload(pending.selection || []);
            if (staged) {
                fromFeatures = (await stage.stageFeatures({
                    featureState: manager.createFeatureState(), revision: to, storeDir: settings.storeDir, fs, now
                })).fromRevision;
            }
        } catch (error) {
            return { ok: false, code: error.code || 'STAGE_FAILED' };
        }
        const nextPlan = resolvePlan({ stagedRevision: staged ? to : null });
        if (nextPlan.error) return { ok: false, code: nextPlan.error };
        progress.touched = true;
        const requestId = record.id;
        await stopEverything({ revision: to, requestId });
        adoptPlan(nextPlan);
        if (abandoned || stopping) return { ok: false, code: 'INTERRUPTED' };
        const ready = await startAll(to, { staged, requestId });
        if (!ready.ok) return ready;
        if (staged) {
            try {
                await stage.promoteFeatures({ featureState: manager.createFeatureState(), fromRevision: fromFeatures });
            } catch (error) {
                return { ok: false, code: error.code || 'PROMOTE_FAILED' };
            }
        }
        return { ok: true, code: null };
    }

    async function rollback({ pending, from, to, record, code, worker, touched }) {
        logger.warn?.(`[manager] the staged restart to revision ${to} failed (${code}${worker ? `, ${worker}` : ''}); restarting at revision ${from}`);
        const configRecovery = touched ? recoverConfig(pending) : null;
        let rollbackReady = null;
        if (touched && !stopping) {
            await stopEverything({ revision: from, requestId: record.id, announce: false });
            adoptPlan(resolvePlan());
            const restored = await startAll(from, { staged: false, requestId: externalMode ? crypto.randomUUID() : null });
            rollbackReady = restored.ok;
        }
        safeUpdate((next) => {
            next.pending = null;
            next.lastOutcome = {
                revision: to,
                outcome: touched ? 'rolled_back' : 'failed',
                code,
                ...(worker ? { worker } : {}),
                ...(configRecovery ? { configRecovery } : {}),
                ...(rollbackReady === null ? {} : { previousRevisionReady: rollbackReady }),
                at: now().toISOString(),
                restartOperationId: record.id
            };
            store.event(next, touched ? 'rolled-back' : 'failed', { revision: to, code });
            return next;
        });
        releaseHolds();
        await finishRecord(record, 'failed', code);
    }

    /* ----------------------------------------------------------- operator */

    /** Skip what is left of the countdown. */
    function restartNow() {
        const doc = readDoc();
        if (!doc.pending) throw new ManagerError(409, 'NOTHING_PENDING', 'There is no scheduled restart.');
        if (doc.pending.phase !== 'countdown' || committing) {
            throw new ManagerError(409, 'ALREADY_COMMITTED', 'The restart is already under way.');
        }
        const next = store.update((d) => {
            if (!d.pending || d.pending.operationId !== doc.pending.operationId) return d;
            d.pending.deadline = now().toISOString();
            store.event(d, 'restart-now', { revision: d.pending.revision });
            return d;
        });
        return next.pending;
    }

    /** Restart every worker at the current revision (out of a crash loop, or on request). */
    function operatorRestart() {
        if (committing || readDoc().pending?.phase === 'committing') {
            throw new ManagerError(409, 'ALREADY_COMMITTED', 'A staged restart is under way; wait for it to finish.');
        }
        const revision = currentRevision();
        const names = [];
        for (const worker of plan.workers) {
            const slot = slotFor(worker);
            slot.crashes = [];
            slot.crashLoop = false;
            slot.consecutive = 0;
            slot.backoffMs = 0;
            names.push(worker.name);
            persistWorker(slot, 'operator-restart', { revision });
            (async () => {
                await stopSlot(slot);
                if (!stopping && !abandoned) await launch(slot, { revision, requestId: externalMode ? crypto.randomUUID() : null });
            })().catch(() => {});
        }
        return { workers: names, revision };
    }

    /** The HTTP ack path: the per-start token and the pid must match the running start. */
    function ack({ worker, revision, pid, token }) {
        const slot = slots.get(worker);
        if (!slot || !slot.handle || slot.handle.external || !slot.token) return false;
        if (!tokenEquals(token, slot.token) || pid !== slot.handle.pid || revision !== slot.revision) return false;
        acknowledge(slot, slot.generation, revision);
        return true;
    }

    /* ----------------------------------------------------------- lifecycle */

    async function start() {
        if (started) return status();
        started = true;
        let doc = readDoc();
        if (stateProblem) {
            logger.warn?.('[manager] lifecycle.json cannot be read; running the workers at revision 0 and refusing staged restarts until it is fixed');
        }
        plan = resolvePlan();
        for (const worker of plan.workers) {
            const info = doc.workers && doc.workers[worker.name];
            if (!files.isPlainObject(info)) continue;
            const slot = slotFor(worker);
            slot.crashes = Array.isArray(info.crashes) ? info.crashes.map(t => Date.parse(t)).filter(Number.isFinite) : [];
            slot.restarts = Number.isInteger(info.restarts) ? info.restarts : 0;
            slot.lastExit = files.isPlainObject(info.lastExit) ? info.lastExit : null;
        }
        if (plan.error) {
            logger.error?.(`[manager] the ${plan.layout} layout cannot start: ${plan.error}`);
        }
        if (doc.pending) {
            const pending = doc.pending;
            const expired = pending.phase === 'countdown' && Date.parse(pending.deadline) <= ms();
            doc = safeUpdate((next) => {
                if (!next.pending || next.pending.operationId !== pending.operationId) return next;
                if (expired && next.pending.onExpired === 'cancel') {
                    next.lastOutcome = { revision: pending.revision, outcome: 'cancelled', code: 'DEADLINE_PASSED', at: now().toISOString() };
                    next.pending = null;
                    store.event(next, 'expired', { revision: pending.revision, code: 'DEADLINE_PASSED' });
                } else {
                    store.event(next, 'resumed', { revision: pending.revision, ...(expired ? { code: 'DEADLINE_PASSED' } : {}) });
                }
                return next;
            }) || doc;
        }
        unsubscribe = store.onChange(() => arm());
        if (doc.pending && doc.pending.phase === 'committing') {
            commit();
            return status();
        }
        if (!plan.error) {
            for (const worker of plan.workers) {
                await launch(slotFor(worker), { revision: doc.current });
            }
        }
        arm();
        return status();
    }

    /** Stop every worker (stopSignal, bounded, then SIGKILL) and wait until each is reaped or its bound passed. */
    async function stop() {
        if (stopping) return { workers: [] };
        stopping = true;
        cancelTimer(countdownTimer);
        if (unsubscribe) unsubscribe();
        for (const timer of [...timers]) cancelTimer(timer);
        const results = await Promise.all([...slots.values()].map(async (slot) => {
            const outcome = await stopSlot(slot);
            return { name: slot.worker.name, forced: Boolean(outcome.forced), timedOut: Boolean(outcome.timedOut) };
        }));
        if (committing) await committing;
        return { workers: results };
    }

    /** Drop everything without stopping a process: what a crashed manager leaves behind (tests). */
    function abandon() {
        abandoned = true;
        cancelTimer(countdownTimer);
        if (unsubscribe) unsubscribe();
        for (const timer of [...timers]) cancelTimer(timer);
    }

    function pendingView(pending) {
        if (!pending) return null;
        const left = Math.max(0, Math.ceil((Date.parse(pending.deadline) - ms()) / 1000));
        return {
            revision: pending.revision,
            operationId: pending.operationId,
            changeRef: pending.changeRef,
            changeKind: pending.changeKind,
            phase: pending.phase,
            announcedAt: pending.announcedAt,
            deadline: pending.deadline,
            graceSeconds: pending.graceSeconds,
            onExpired: pending.onExpired,
            secondsLeft: pending.phase === 'countdown' ? left : 0,
            ...(pending.committedAt ? { committedAt: pending.committedAt } : {})
        };
    }

    function workerView(slot, { healthy } = {}) {
        const t = ms();
        return {
            name: slot.worker.name,
            state: slot.state,
            supervised: !slot.worker.external,
            pid: slot.handle && slot.handle.pid ? slot.handle.pid : null,
            revision: slot.revision,
            staged: slot.staged,
            healthy: healthy === undefined ? slot.healthy : healthy,
            ackedRevision: slot.ackedRevision,
            restarts: slot.restarts,
            crashes: slot.crashes.filter(at => t - at < policy.crashWindowMs).length,
            crashLoop: slot.crashLoop,
            backoffMs: slot.state === 'backoff' ? slot.backoffMs : 0,
            code: slot.lastCode,
            lastExit: slot.lastExit
        };
    }

    /** The lifecycle view: names, states, revisions, codes and times only. */
    async function status({ probe = false } = {}) {
        const doc = readDoc();
        const ordered = plan.workers.map(worker => slotFor(worker));
        const health = probe
            ? await Promise.all(ordered.map(slot => checkHealth(slot.worker.healthUrl)))
            : ordered.map(() => undefined);
        const workers = ordered.map((slot, index) => workerView(slot, { healthy: health[index] }));
        const acked = {};
        for (const worker of workers) acked[worker.name] = worker.ackedRevision;
        return {
            supervising: started && !stopping && !abandoned,
            mode: externalMode ? 'external' : 'child',
            layout: plan.layout,
            layoutError: plan.error,
            stateProblem,
            current: doc.current,
            pending: pendingView(doc.pending),
            committing: Boolean(committing) || doc.pending?.phase === 'committing',
            lastOutcome: doc.lastOutcome,
            acked,
            workers,
            events: doc.events.slice(-STATUS_EVENTS)
        };
    }

    /** The short form for GET /status. */
    function summary() {
        return {
            supervising: started && !stopping && !abandoned,
            layout: plan.layout,
            workers: plan.workers.map(worker => {
                const slot = slotFor(worker);
                return { name: worker.name, state: slot.state, ackedRevision: slot.ackedRevision };
            })
        };
    }

    /**
     * What the maintenance barrier fences (documentation/maintenance_barrier.md):
     * names, health URLs, the pid this supervisor started and the last
     * fence acknowledgement echoed over HTTP. Nothing else.
     */
    function fenceTargets() {
        return {
            started: started && !stopping && !abandoned,
            layout: plan.layout,
            error: plan.error,
            workers: plan.workers.map((worker) => {
                const slot = slotFor(worker);
                const external = Boolean(worker.external || (slot.handle && slot.handle.external));
                return {
                    name: worker.name,
                    healthUrl: worker.healthUrl,
                    external,
                    pid: !external && slot.handle && slot.handle.pid ? slot.handle.pid : null,
                    running: external ? true : Boolean(slot.handle && slot.handle.running()),
                    state: slot.state,
                    fenceAck: slot.fenceAck || null
                };
            })
        };
    }

    /** The HTTP echo of a worker's fence acknowledgement: the same token and pid checks as `ack`. */
    function fenceAck({ worker, fence, state, pid, token }) {
        const slot = slots.get(worker);
        if (!slot || !slot.handle || slot.handle.external || !slot.token) return false;
        if (!tokenEquals(token, slot.token) || pid !== slot.handle.pid) return false;
        slot.fenceAck = { fence, state, pid, at: now().toISOString() };
        return true;
    }

    return {
        start,
        stop,
        abandon,
        status,
        summary,
        commit,
        restartNow,
        operatorRestart,
        ack,
        fenceTargets,
        fenceAck,
        checkHealth,
        store,
        get stateProblem() { return stateProblem; },
        get committing() { return Boolean(committing); },
        whenIdle: () => committing || Promise.resolve()
    };
}

module.exports = { createSupervisor, DEFAULT_POLICY };
