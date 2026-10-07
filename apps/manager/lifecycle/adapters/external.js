/**
 * The external adapter: an OS unit (systemd, PM2, a Docker service) runs
 * the worker directly and restarts it on exit, so the manager does not
 * spawn, stop or signal anything (`supervised: false`).
 *
 * Requests travel through the worker's control file
 * (`<store>/control/<worker>.json`, packages/core/runtime/lifecycle.js):
 *
 *   stopNewWork   request `stop-new-work`: the worker stops admitting work
 *   start         `boot = { revision, staged }` plus request `restart`: the
 *                 worker drains, exits 75 and its unit starts it again; the
 *                 new process reads `boot` and acknowledges that revision
 *   stop          nothing: the unit owns the process; reported `external`
 *
 * The supervisor still verifies health and the acknowledgement, which must
 * be newer than the request.
 */

const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');

/**
 * @param {Object} params
 * @param {string} params.storeDir the manager store, as the workers see it
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 */
function createExternalAdapter({ storeDir, fs = nodeFs, now = () => new Date() }) {
    const env = { GOOBSTER_MANAGER_STATE_DIR: storeDir };
    const never = new Promise(() => {});

    function write(worker, { boot, request }) {
        const current = coreLifecycle.readControl(worker, { env, fs });
        coreLifecycle.writeControl(worker, {
            boot: boot === undefined ? (current ? current.boot : null) : boot,
            request
        }, { env, fs });
    }

    function handleFor(worker, requestedAt) {
        return {
            pid: null,
            external: true,
            requestedAt,
            exited: never,
            running: () => true,
            stopNewWork({ revision = null, drainSeconds = coreLifecycle.DRAIN_BOUND_SECONDS, id = crypto.randomUUID() } = {}) {
                write(worker.name, { request: { id, type: 'stop-new-work', revision, drainSeconds, at: now().toISOString() } });
            },
            signal: () => false,
            async stop() {
                return { exit: null, forced: false, timedOut: false, external: true };
            }
        };
    }

    /** The worker as its unit runs it now; records which revision its next start runs. */
    function attach(worker, { revision }) {
        write(worker.name, { boot: { revision, staged: false }, request: null });
        return handleFor(worker, null);
    }

    /** Ask the running worker to restart into `revision`. */
    function start(worker, { revision, staged = false, drainSeconds = coreLifecycle.DRAIN_BOUND_SECONDS, id = crypto.randomUUID() }) {
        const at = now().toISOString();
        write(worker.name, {
            boot: { revision, staged: Boolean(staged) },
            request: { id, type: 'restart', revision, drainSeconds, at }
        });
        return handleFor(worker, at);
    }

    return { kind: 'external', supervised: false, attach, start };
}

module.exports = { createExternalAdapter };
