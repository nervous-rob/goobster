/**
 * Scriptable fake worker processes for the supervisor specs (#325): an
 * adapter with the child adapter's contract, a health check that answers
 * for "listening" fakes, and real revision-ack files written the way a
 * worker writes them. No process is spawned.
 *
 * A behaviour (per spawn, queued per worker name, else the default):
 *   readyAfterMs  when /health starts answering (default 5)
 *   healthy       false: never answers /health
 *   ack           false: never acknowledges its revision
 *   exitAfterMs   exits on its own after this long, with exitCode (default 1)
 *   ignoreTerm    ignores SIGTERM (only the forced kill ends it)
 *   throwOnSpawn  the adapter's start() throws
 *   spawnError    start() returns but the process never runs (exit with error)
 */

const revisionAck = require('@goobster/core/runtime/revisionAck');

function createFakeWorkers() {
    const procs = [];
    const queues = new Map();
    const defaults = new Map();
    const listening = new Map();
    let nextPid = 70000;

    function behave(name, ...behaviours) {
        if (!queues.has(name)) queues.set(name, []);
        queues.get(name).push(...behaviours);
    }

    function setDefault(name, behaviour) {
        defaults.set(name, behaviour);
    }

    function start(worker, { env }) {
        const queue = queues.get(worker.name) || [];
        const b = queue.length ? queue.shift() : (defaults.get(worker.name) || {});
        if (b.throwOnSpawn) {
            const error = new Error('spawn failed');
            error.code = 'EACCES';
            throw error;
        }
        let resolveExit;
        const proc = {
            pid: nextPid++,
            name: worker.name,
            env,
            revision: Number(env.GOOBSTER_REVISION),
            staged: env.GOOBSTER_FEATURES_STAGED === '1',
            behaviour: b,
            signals: [],
            exit: null,
            reaped: false,
            startedAt: Date.now(),
            exited: new Promise((resolve) => { resolveExit = resolve; })
        };
        proc.die = (code, signal = null, error = null) => {
            if (proc.exit) return;
            proc.exit = { code, signal, error };
            if (listening.get(worker.healthUrl) === proc) listening.delete(worker.healthUrl);
            resolveExit(proc.exit);
        };
        proc.exited.then(() => { proc.reaped = true; });
        procs.push(proc);
        if (b.spawnError) {
            setTimeout(() => proc.die(null, null, 'ENOENT'), 1);
        } else {
            setTimeout(() => {
                if (proc.exit || b.healthy === false) return;
                listening.set(worker.healthUrl, proc);
                if (b.ack !== false) {
                    revisionAck.writeAck({ worker: worker.name, revision: proc.revision, pid: proc.pid, env });
                }
            }, b.readyAfterMs ?? 5);
            if (b.exitAfterMs !== undefined) setTimeout(() => proc.die(b.exitCode ?? 1), b.exitAfterMs);
        }
        return {
            pid: proc.pid,
            exited: proc.exited,
            running: () => !proc.exit,
            stopNewWork(request) {
                proc.signals.push('SIGUSR2');
                proc.stopNewWorkRequest = request;
            },
            signal(sig) {
                proc.signals.push(sig);
                return true;
            },
            async stop({ timeoutMs }) {
                if (proc.exit) return { exit: proc.exit, forced: false, timedOut: false };
                proc.signals.push('SIGTERM');
                if (!b.ignoreTerm) setTimeout(() => proc.die(0), 1);
                let timer;
                const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
                let exit = await Promise.race([proc.exited, timeout]);
                clearTimeout(timer);
                let forced = false;
                if (!exit) {
                    forced = true;
                    proc.signals.push('SIGKILL');
                    proc.die(null, 'SIGKILL');
                    exit = await proc.exited;
                }
                return { exit, forced, timedOut: false };
            }
        };
    }

    async function checkHealth(url) {
        const proc = listening.get(url);
        return Boolean(proc && !proc.exit);
    }

    return {
        adapter: { kind: 'fake', supervised: true, start },
        checkHealth,
        behave,
        setDefault,
        procs,
        alive: () => procs.filter(proc => !proc.exit),
        of: name => procs.filter(proc => proc.name === name),
        last: name => procs.filter(proc => proc.name === name).slice(-1)[0] || null,
        /** Something outside the supervisor answers this health URL. */
        occupy(url) {
            const squatter = { exit: null };
            listening.set(url, squatter);
            return () => { if (listening.get(url) === squatter) listening.delete(url); };
        }
    };
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 5, what = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

const FAST_POLICY = Object.freeze({
    backoffMs: [10, 20, 30, 40, 50],
    crashLimit: 5,
    crashWindowMs: 60_000,
    stableMs: 10_000,
    healthTimeoutMs: 300,
    readyTimeoutMs: 600,
    pollMs: 5,
    lockWaitMs: 500,
    lockRetryMs: 10,
    conflictRetryMs: 30,
    drainSeconds: 0,
    stopTimeoutMs: 150
});

module.exports = { createFakeWorkers, waitFor, FAST_POLICY };
