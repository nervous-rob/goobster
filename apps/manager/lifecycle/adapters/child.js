/**
 * The child adapter: the manager spawns and owns the worker process.
 *
 * - stdio is ['ignore', 'inherit', 'inherit']: a worker's own logger keeps
 *   writing where it always did (journald, PM2, a terminal).
 * - POSIX: the worker leads its own process group (`detached: true`), so
 *   ffmpeg, yt-dlp or a sandbox child die with it. Stop is graceful to the
 *   leader first (its shutdown runs the work contracts and stops its own
 *   children), then SIGKILL to the whole group after `stopTimeoutMs`, and a
 *   last SIGKILL sweep of the group after the leader exited.
 * - Windows: the graceful request goes through the control file (there are
 *   no POSIX signals), then `taskkill /T /F` after the bound.
 * - Every spawned process is waited for: `exited` resolves on `exit` (or a
 *   spawn `error`), which is when Node has reaped it.
 *
 * A worker marked `external` (an OS unit already runs it) is refused: two
 * supervisors on one process is the failure this adapter exists to avoid.
 */

const childProcess = require('node:child_process');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const { ManagerError } = require('../../errors');

const SWEEP_GRACE_MS = 5000;

/**
 * @param {Object} [deps]
 * @param {Function} [deps.spawn]
 * @param {Function} [deps.execFile]
 * @param {(pid: number, signal: string) => void} [deps.kill]
 * @param {string} [deps.platform]
 * @param {string} [deps.execPath]
 * @param {string} [deps.cwd]
 * @param {(worker: string, request: Object) => void} [deps.writeControl] Windows graceful path
 * @param {Object} [deps.logger]
 */
function createChildAdapter({
    spawn = childProcess.spawn,
    execFile = childProcess.execFile,
    kill = (pid, signal) => process.kill(pid, signal),
    platform = process.platform,
    execPath = process.execPath,
    cwd = process.cwd(),
    writeControl = () => {},
    logger = console
} = {}) {
    const posix = platform !== 'win32';

    function signalGroup(pid, signal) {
        if (!pid) return false;
        if (posix) {
            try {
                kill(-pid, signal);
                return true;
            } catch (error) {
                if (error && error.code !== 'ESRCH') logger.warn?.(`[manager] could not signal a worker group: ${error.code || error.name}`);
            }
        }
        try {
            kill(pid, signal);
            return true;
        } catch {
            return false;
        }
    }

    function signalLeader(pid, signal) {
        if (!pid) return false;
        try {
            kill(pid, signal);
            return true;
        } catch {
            return false;
        }
    }

    function taskkill(pid) {
        return new Promise((resolve) => {
            execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve());
        });
    }

    function launch(script, args, env) {
        const child = spawn(execPath, [script, ...args], {
            cwd,
            env,
            stdio: ['ignore', 'inherit', 'inherit'],
            detached: posix,
            windowsHide: true
        });
        let exit = null;
        const exited = new Promise((resolve) => {
            child.once('error', (error) => {
                if (exit) return;
                exit = { code: null, signal: null, error: error && error.code ? String(error.code) : 'SPAWN_FAILED' };
                resolve(exit);
            });
            child.once('exit', (code, signal) => {
                if (exit && exit.error) return;
                exit = { code, signal: signal || null, error: null };
                resolve(exit);
            });
        });
        return { child, exited, isExited: () => exit !== null };
    }

    /**
     * Start a worker. Throws NESTED_SUPERVISOR_REFUSED for an external one;
     * a spawn failure comes back through `exited` with `error` set.
     */
    function start(worker, { env }) {
        if (worker.external) {
            throw new ManagerError(409, 'NESTED_SUPERVISOR_REFUSED',
                `"${worker.name}" is run by the operating system's service manager; the manager will not start a second copy.`);
        }
        const { child, exited, isExited } = launch(worker.script, worker.args || [], env);
        const pid = child.pid || null;

        async function waitFor(ms) {
            let timer;
            const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
            const result = await Promise.race([exited, timeout]);
            clearTimeout(timer);
            return result;
        }

        return {
            pid,
            exited,
            running: () => !isExited(),
            /** Committed restart: stop admitting work (SIGUSR2 to the leader only; its default action would kill a helper). */
            stopNewWork({ revision = null, drainSeconds = coreLifecycle.DRAIN_BOUND_SECONDS, id }) {
                if (isExited()) return;
                if (posix) {
                    signalLeader(pid, coreLifecycle.STOP_NEW_WORK_SIGNAL);
                } else {
                    writeControl(worker.name, { id, type: 'stop-new-work', revision, drainSeconds });
                }
            },
            signal(signal) {
                return posix ? signalGroup(pid, signal) : signalLeader(pid, signal);
            },
            /**
             * Graceful stop bounded by `timeoutMs`, then forced. Resolves with
             * the exit and whether it had to be forced; `timedOut` when even
             * the forced kill was not observed within the sweep grace.
             */
            async stop({ timeoutMs = worker.stopTimeoutMs, id } = {}) {
                if (!isExited()) {
                    if (posix) signalLeader(pid, worker.stopSignal || 'SIGTERM');
                    else writeControl(worker.name, { id, type: 'restart', revision: null, drainSeconds: Math.floor(timeoutMs / 1000) });
                }
                let result = await waitFor(timeoutMs);
                let forced = false;
                if (!result) {
                    forced = true;
                    if (posix) signalGroup(pid, 'SIGKILL');
                    else await taskkill(pid);
                    result = await waitFor(SWEEP_GRACE_MS);
                }
                if (posix && pid) {
                    try { kill(-pid, 'SIGKILL'); } catch { }
                }
                return { exit: result, forced, timedOut: !result };
            }
        };
    }

    /** Run a bounded one-shot helper (the bot's command deployment) in its own group. */
    async function run(task, { env }) {
        const { child, exited } = launch(task.script, task.args || [], env);
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), task.timeoutMs); });
        let result = await Promise.race([exited, timeout]);
        clearTimeout(timer);
        if (!result) {
            if (posix) signalGroup(child.pid, 'SIGKILL');
            else await taskkill(child.pid);
            await exited;
            return { code: null, signal: 'SIGKILL', timedOut: true };
        }
        return { code: result.code, signal: result.signal, error: result.error, timedOut: false };
    }

    return { kind: 'child', supervised: true, start, run };
}

module.exports = { createChildAdapter, SWEEP_GRACE_MS };
