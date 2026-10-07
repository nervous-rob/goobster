/**
 * The maintenance routes (documentation/maintenance_barrier.md § API), under
 * /manager/api:
 *
 *   GET  /maintenance       readAuth  the whole sanitized state of the barrier
 *   POST /maintenance/ack   loopback + per-start token: a worker's fence acknowledgement
 *
 * Enter and release are operations: POST /operations with kind
 * `maintenance.enter` / `maintenance.release`. `GET /status` carries the
 * short form (`maintenance: { active, phase, fence, since }`) and is read
 * from the manager store only, so it works with the application database
 * offline.
 */

const { ManagerError } = require('../errors');
const registry = require('../lifecycle/registry');
const revisionAck = require('@goobster/core/runtime/revisionAck');
const { createBarrier } = require('../maintenance/barrier');

const ACK_TOKEN_HEADER = 'x-goobster-ack-token';

function mountMaintenanceRoutes(api, { route, readAuth, throttle, noteFailure, guards, manager }) {
    api.get('/maintenance', route((req) => {
        readAuth(req);
        return createBarrier({ settings: manager.settings }).view();
    }));

    api.post('/maintenance/ack', route((req) => {
        if (!guards.isLocalRequest(req)) {
            throw new ManagerError(403, 'LOCAL_ONLY', 'Acknowledgements are accepted from this machine only.');
        }
        throttle('maintenance-ack');
        const { worker, fence, state = 'fenced', pid, ...rest } = req.body;
        if (Object.keys(rest).length > 0 || !revisionAck.isWorkerName(worker)
            || !Number.isInteger(fence) || fence < 0 || !['fenced', 'resumed'].includes(state)
            || !Number.isInteger(pid) || pid <= 0) {
            throw new ManagerError(400, 'INVALID_INPUT', 'The body must be { worker, fence, state, pid }.');
        }
        const supervisor = registry.get(manager.settings.storeDir);
        const token = req.headers[ACK_TOKEN_HEADER];
        if (!supervisor || typeof supervisor.fenceAck !== 'function'
            || !supervisor.fenceAck({ worker, fence, state, pid, token: typeof token === 'string' ? token : '' })) {
            noteFailure('maintenance-ack');
            throw new ManagerError(403, 'ACK_REFUSED', 'That acknowledgement does not match a worker this manager started.');
        }
        return { acknowledged: true, worker, fence };
    }));
}

module.exports = { mountMaintenanceRoutes, ACK_TOKEN_HEADER };
