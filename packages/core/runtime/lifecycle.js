/**
 * The worker side of the manager's lifecycle contract
 * (documentation/manager_lifecycle.md). `apps/bot`, `apps/api` and
 * `apps/sandbox` call into this module; the manager reads the same
 * constants and file formats, so the two sides cannot drift.
 *
 *   exit code 75 (EX_TEMPFAIL)  "restart me": the supervisor restarts the
 *                               worker at once and does not count a crash
 *   SIGUSR2 (POSIX child)       stop new work: the restart is committed
 *   <store>/control/<w>.json    the same requests for workers the manager
 *                               did not spawn (systemd/PM2/Docker units)
 *                               and for children on Windows
 *   GOOBSTER_REVISION=<n>       the revision a worker runs; it acknowledges
 *                               it once ready (./revisionAck.js)
 *   GOOBSTER_FEATURES_STAGED=1  run the staged feature document of that
 *                               revision instead of data/features.json
 *
 * "Stop new work" is not the operator *paused* flag
 * (instanceStateService): pausing is a durable operator decision shared by
 * every process; stopping new work is this process getting ready to exit.
 * The maintenance barrier (#334) builds on `pauseNewWork()`.
 *
 * Requiring this module installs nothing; `install()` does.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const revisionAck = require('./revisionAck');

const EXIT_RESTART = 75;
const STOP_NEW_WORK_SIGNAL = 'SIGUSR2';
const CONTROL_VERSION = 1;
const STAGED_VERSION = 1;
const SUPERVISORS = ['manager', 'systemd', 'pm2', 'docker', 'none'];
const CONTROL_POLL_MS = 1000;
const PARENT_POLL_MS = 2000;
const OFF_WORDS = new Set(['0', 'false', 'no', 'off']);

/**
 * Declared shutdown contract per kind of long-running work (audit L1).
 * `boundSeconds` is how long a restart waits for the contract before the
 * process goes down anyway; the grace period never promises completion.
 *   checkpoint  finish the current stage, record where it stopped, resume after restart
 *   cancel      stop now, record INTERRUPTED, never replay
 *   drain       let the in-flight unit finish inside the bound; nothing new starts
 *   none        nothing in flight survives a process; durable rows carry the state
 */
const CONTRACTS = Object.freeze([
    { kind: 'expedition', contract: 'checkpoint', boundSeconds: 45 },
    { kind: 'sandboxRun', contract: 'cancel', boundSeconds: 35 },
    { kind: 'voiceSession', contract: 'cancel', boundSeconds: 5 },
    { kind: 'musicPlayback', contract: 'cancel', boundSeconds: 5 },
    { kind: 'gbaSession', contract: 'none', boundSeconds: 0 },
    { kind: 'observatoryJob', contract: 'checkpoint', boundSeconds: 0 },
    { kind: 'missionStep', contract: 'none', boundSeconds: 0 },
    { kind: 'integrationAction', contract: 'drain', boundSeconds: 15 },
    { kind: 'attentionSweep', contract: 'drain', boundSeconds: 15 },
    { kind: 'runtimeStep', contract: 'drain', boundSeconds: 15 }
].map(Object.freeze));

/** The longest bound any in-process contract declares: the drain window of a restart. */
const DRAIN_BOUND_SECONDS = Math.max(...CONTRACTS.map(entry => entry.boundSeconds));

/** A contract's own bound, never longer than the drain window this shutdown has. */
function contractBoundMs(kind, drainMs) {
    const entry = CONTRACTS.find(item => item.kind === kind);
    if (!entry) throw new Error(`lifecycle: unknown work kind "${kind}"`);
    return Math.max(0, Math.min(entry.boundSeconds * 1000, drainMs));
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Who restarts this process when it exits: the manager (it spawned us and
 * said so), an OS/process manager unit that runs us directly, or nobody.
 * An explicit `GOOBSTER_SUPERVISOR` wins, so a child of a manager that runs
 * under systemd is not mistaken for a systemd unit through the inherited
 * `INVOCATION_ID`.
 */
function detectSupervisor({ env = process.env, fs = nodeFs } = {}) {
    const explicit = String(env.GOOBSTER_SUPERVISOR || '').trim().toLowerCase();
    if (SUPERVISORS.includes(explicit)) return explicit;
    if (env.INVOCATION_ID) return 'systemd';
    if (env.PM2_HOME || env.pm_id !== undefined) return 'pm2';
    try {
        if (fs.existsSync('/.dockerenv')) return 'docker';
    } catch { }
    return 'none';
}

function lifecycleDir(env = process.env) {
    return path.join(revisionAck.managerStateDir(env), 'lifecycle');
}

function stagedFeaturesFile(env = process.env) {
    return path.join(lifecycleDir(env), 'staged-features.json');
}

function controlFile(worker, env = process.env) {
    if (!revisionAck.isWorkerName(worker)) throw new Error('lifecycle: invalid worker name');
    return path.join(revisionAck.managerStateDir(env), 'control', `${worker}.json`);
}

function writeJsonAtomic(file, value, fs) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
        fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.unlinkSync(tmp); } catch { }
        throw error;
    }
}

function readJsonFile(file, fs) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * The manager's requests to a worker it does not signal directly.
 *   boot     { revision, staged }  what the next start of this worker runs
 *   request  { id, type: 'stop-new-work'|'restart', revision, drainSeconds, at } | null
 */
function normalizeControl(value, worker) {
    if (!isPlainObject(value) || value.version !== CONTROL_VERSION || value.worker !== worker) return null;
    const boot = isPlainObject(value.boot) && Number.isInteger(value.boot.revision) && value.boot.revision >= 0
        ? { revision: value.boot.revision, staged: value.boot.staged === true }
        : null;
    let request = null;
    if (isPlainObject(value.request)
        && ['stop-new-work', 'restart'].includes(value.request.type)
        && typeof value.request.id === 'string'
        && typeof value.request.at === 'string') {
        request = {
            id: value.request.id.slice(0, 64),
            type: value.request.type,
            revision: Number.isInteger(value.request.revision) ? value.request.revision : null,
            drainSeconds: Number.isInteger(value.request.drainSeconds) ? value.request.drainSeconds : DRAIN_BOUND_SECONDS,
            at: value.request.at
        };
    }
    return { version: CONTROL_VERSION, worker, boot, request };
}

function readControl(worker, { env = process.env, fs = nodeFs } = {}) {
    return normalizeControl(readJsonFile(controlFile(worker, env), fs), worker);
}

function writeControl(worker, { boot = null, request = null }, { env = process.env, fs = nodeFs } = {}) {
    const doc = { version: CONTROL_VERSION, worker, boot, request };
    writeJsonAtomic(controlFile(worker, env), doc, fs);
    return doc;
}

/** The revision this start runs: the manager's env first, then the control file's `boot`. */
function bootRevision({ worker, env = process.env, fs = nodeFs } = {}) {
    const fromEnv = revisionAck.parseRevision(env.GOOBSTER_REVISION);
    if (fromEnv !== null) {
        const raw = String(env.GOOBSTER_FEATURES_STAGED || '').trim().toLowerCase();
        return { revision: fromEnv, staged: raw !== '' && !OFF_WORDS.has(raw), source: 'env' };
    }
    if (worker && revisionAck.isWorkerName(worker)) {
        const control = readControl(worker, { env, fs });
        if (control && control.boot) return { revision: control.boot.revision, staged: control.boot.staged, source: 'control' };
    }
    return { revision: null, staged: false, source: null };
}

/** The staged feature document for `revision`, validated against its tag; null when absent or for another revision. */
function readStagedFeatures({ revision, env = process.env, fs = nodeFs } = {}) {
    const doc = readJsonFile(stagedFeaturesFile(env), fs);
    if (!isPlainObject(doc) || !isPlainObject(doc.lifecycle) || doc.lifecycle.version !== STAGED_VERSION) return null;
    if (doc.lifecycle.revision !== revision) return null;
    return doc;
}

/**
 * Point this process's feature resolver at the staged document of the
 * revision it was started with. Must run before anything reads feature
 * state: the snapshot is memoised on first use.
 * @returns {{ adopted: boolean, reason: string|null }}
 */
function adoptStagedFeatures({ revision, env = process.env, fs = nodeFs, features = null } = {}) {
    if (revision === null || revision === undefined) return { adopted: false, reason: 'NO_REVISION' };
    const doc = readStagedFeatures({ revision, env, fs });
    if (!doc) return { adopted: false, reason: 'STAGED_MISSING' };
    const resolver = features || require('../features/featureState').features;
    try {
        resolver.configure({ filePath: stagedFeaturesFile(env) });
    } catch (error) {
        // Something read feature state before the worker's boot reached
        // here: the staged document cannot be adopted; run at the file's
        // current revision instead and say so.
        return { adopted: false, reason: error.code || 'CONFIGURE_FAILED' };
    }
    return { adopted: true, reason: null };
}

/**
 * Run each task's contract, all at once, bounded: a task that has not
 * settled when `boundMs` passes is interrupted. Never throws.
 * @param {Array<{ name: string, drain: (boundMs: number) => Promise<any>, interrupt?: () => Promise<any> }>} tasks
 * @returns {Promise<Array<{ name: string, outcome: 'settled'|'interrupted'|'failed' }>>}
 */
async function settle(tasks, boundMs, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    return Promise.all(tasks.map(async (task) => {
        let timer = null;
        const timedOut = new Promise((resolve) => {
            timer = setTimer(() => resolve('timeout'), Math.max(0, boundMs));
            timer?.unref?.();
        });
        let outcome;
        try {
            const raced = await Promise.race([
                Promise.resolve().then(() => task.drain(boundMs)).then(() => 'settled'),
                timedOut
            ]);
            outcome = raced === 'settled' ? 'settled' : 'interrupted';
        } catch {
            outcome = 'failed';
        } finally {
            clearTimer(timer);
        }
        if (outcome !== 'settled' && typeof task.interrupt === 'function') {
            try { await task.interrupt(); } catch { }
            if (outcome === 'failed') outcome = 'interrupted';
        }
        return { name: task.name, outcome };
    }));
}

/**
 * One process's lifecycle state. The module exports a process-wide
 * instance; tests build their own.
 */
function createWorkerLifecycle({ now = () => Date.now() } = {}) {
    const state = {
        worker: null,
        supervisor: null,
        revision: null,
        staged: false,
        stagedRequested: false,
        bootedAt: now(),
        paused: null,
        restarting: false
    };
    const listeners = new Set();
    const timers = [];
    let shutdownFn = null;
    let logger = console;

    /**
     * Call first in a worker's entry point, before any module reads feature
     * state. Resolves the supervisor and the revision, and adopts the
     * staged feature document when this start runs a staged revision.
     */
    function boot({ worker, env = process.env, fs = nodeFs, log = console } = {}) {
        logger = log;
        state.worker = worker;
        state.supervisor = detectSupervisor({ env, fs });
        const resolved = bootRevision({ worker, env, fs });
        state.revision = resolved.revision;
        state.staged = false;
        state.stagedRequested = Boolean(resolved.staged);
        if (resolved.staged) {
            const adopted = adoptStagedFeatures({ revision: resolved.revision, env, fs });
            state.staged = adopted.adopted;
            if (!adopted.adopted) {
                logger.warn?.(`[lifecycle] revision ${resolved.revision} asked for staged features but they are not there (${adopted.reason}); running data/features.json`);
            }
        }
        return { worker, supervisor: state.supervisor, revision: state.revision, staged: state.staged };
    }

    /**
     * Stop admitting new work in this process. Idempotent; the first call
     * wins. `announced` marks a lifecycle restart the manager scheduled (the
     * bot answers new feature commands with a "restarting" notice only then).
     */
    function pauseNewWork({ reason = 'shutdown', announced = false, drainSeconds = DRAIN_BOUND_SECONDS } = {}) {
        if (state.paused) {
            if (announced && !state.paused.announced) state.paused.announced = true;
            return false;
        }
        const seconds = Number.isFinite(Number(drainSeconds)) ? Math.max(0, Math.round(Number(drainSeconds))) : DRAIN_BOUND_SECONDS;
        state.paused = { reason: String(reason).slice(0, 32), announced: Boolean(announced), at: now(), drainSeconds: seconds };
        for (const listener of [...listeners]) {
            try { listener({ ...state.paused }); } catch { }
        }
        return true;
    }

    function onPauseNewWork(listener) {
        listeners.add(listener);
        if (state.paused) {
            try { listener({ ...state.paused }); } catch { }
        }
        return () => listeners.delete(listener);
    }

    function newWorkPaused() {
        return Boolean(state.paused);
    }

    /**
     * How long this shutdown may wait for in-flight work: what the stop
     * request said, else GOOBSTER_LIFECYCLE_DRAIN_SECONDS, else the
     * longest contract bound.
     */
    function drainBoundMs({ env = process.env } = {}) {
        if (state.paused) return state.paused.drainSeconds * 1000;
        return (revisionAck.parseRevision(env.GOOBSTER_LIFECYCLE_DRAIN_SECONDS) ?? DRAIN_BOUND_SECONDS) * 1000;
    }

    /** `{ secondsLeft }` while a manager-announced restart is draining this process, else null. */
    function restartNotice() {
        if (!state.paused || !state.paused.announced) return null;
        const left = Math.ceil((state.paused.at + state.paused.drainSeconds * 1000 - now()) / 1000);
        return { secondsLeft: Math.max(1, left) };
    }

    /**
     * Wire the signals: SIGUSR2 from the manager (POSIX children), the
     * control file (external units and Windows children), and the parent
     * watch (a child whose manager died shuts itself down instead of
     * running unsupervised). `shutdown({ exitCode, reason })` is the app's.
     */
    function install({ shutdown, env = process.env, fs = nodeFs, proc = process, setTimer = setInterval } = {}) {
        shutdownFn = shutdown;
        const worker = state.worker;
        const drainSeconds = revisionAck.parseRevision(env.GOOBSTER_LIFECYCLE_DRAIN_SECONDS) ?? DRAIN_BOUND_SECONDS;
        const childOfManager = state.supervisor === 'manager';
        if (childOfManager && proc.platform !== 'win32') {
            proc.on(STOP_NEW_WORK_SIGNAL, () => pauseNewWork({ reason: 'lifecycle', announced: true, drainSeconds }));
        }
        if (worker && (!childOfManager || proc.platform === 'win32')) {
            const seen = new Set();
            const bootIso = new Date(state.bootedAt).toISOString();
            const initial = readControl(worker, { env, fs });
            if (initial && initial.request && initial.request.at <= bootIso) seen.add(initial.request.id);
            const poll = setTimer(() => {
                const control = readControl(worker, { env, fs });
                const request = control && control.request;
                if (!request || seen.has(request.id)) return;
                seen.add(request.id);
                if (request.type === 'stop-new-work') {
                    pauseNewWork({ reason: 'lifecycle', announced: true, drainSeconds: request.drainSeconds });
                } else if (request.type === 'restart') {
                    pauseNewWork({ reason: 'lifecycle', announced: true, drainSeconds: request.drainSeconds });
                    requestRestart('manager');
                }
            }, CONTROL_POLL_MS);
            poll?.unref?.();
            timers.push(poll);
        }
        const managerPid = Number(env.GOOBSTER_MANAGER_PID);
        if (childOfManager && Number.isInteger(managerPid) && managerPid > 0) {
            const watch = setTimer(() => {
                if (proc.ppid !== managerPid && shutdownFn) {
                    logger.warn?.('[lifecycle] the manager that started this worker is gone; shutting down');
                    clearAll();
                    shutdownFn({ exitCode: 0, reason: 'orphaned' });
                }
            }, PARENT_POLL_MS);
            watch?.unref?.();
            timers.push(watch);
        }
    }

    function clearAll() {
        while (timers.length) clearInterval(timers.pop());
    }

    /**
     * Ask whoever supervises this process for a restart: the bounded
     * shutdown, then exit code 75. Refused (false) when nothing would bring
     * the process back.
     */
    function requestRestart(reason = 'requested') {
        if (state.restarting) return true;
        if (state.supervisor === 'none' || !shutdownFn) {
            logger.warn?.('[lifecycle] restart requested but nothing supervises this process; ignoring');
            return false;
        }
        state.restarting = true;
        clearAll();
        logger.info?.(`[lifecycle] restart requested (${String(reason).slice(0, 32)}); exiting with ${EXIT_RESTART} after the bounded shutdown`);
        shutdownFn({ exitCode: EXIT_RESTART, reason: 'restart' });
        return true;
    }

    /**
     * Write (and optionally POST) the ack of the revision this start runs.
     * A start that was asked to run staged features but could not adopt
     * them acknowledges nothing: it serves at the previous document, and
     * the supervisor's ack timeout rolls the change back instead of
     * promoting a revision no worker is running.
     */
    function acknowledgeReady({ env = process.env, fs = nodeFs } = {}) {
        if (!state.worker) return Promise.resolve({ skipped: true });
        if (state.stagedRequested && !state.staged) {
            logger.warn?.(`[lifecycle] not acknowledging revision ${state.revision}: its staged features were not adopted`);
            return Promise.resolve({ skipped: true, reason: 'STAGED_NOT_ADOPTED' });
        }
        return revisionAck.acknowledge({ worker: state.worker, revision: state.revision, env, fs, logger });
    }

    function describe() {
        return {
            worker: state.worker,
            supervisor: state.supervisor,
            revision: state.revision,
            staged: state.staged,
            newWorkPaused: Boolean(state.paused),
            announced: Boolean(state.paused && state.paused.announced)
        };
    }

    return {
        boot,
        install,
        pauseNewWork,
        onPauseNewWork,
        newWorkPaused,
        drainBoundMs,
        restartNotice,
        requestRestart,
        acknowledgeReady,
        describe,
        dispose: clearAll
    };
}

module.exports = createWorkerLifecycle();
Object.assign(module.exports, {
    EXIT_RESTART,
    STOP_NEW_WORK_SIGNAL,
    CONTROL_VERSION,
    STAGED_VERSION,
    SUPERVISORS,
    CONTRACTS,
    DRAIN_BOUND_SECONDS,
    contractBoundMs,
    createWorkerLifecycle,
    detectSupervisor,
    lifecycleDir,
    stagedFeaturesFile,
    controlFile,
    readControl,
    writeControl,
    bootRevision,
    readStagedFeatures,
    adoptStagedFeatures,
    settle
});
