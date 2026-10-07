/**
 * The lifecycle routes (documentation/manager_lifecycle.md § API), under
 * /manager/api:
 *
 *   GET  /lifecycle               readAuth           workers, health, acks, pending, countdown, crash loop
 *   POST /lifecycle/restart-now   authenticate+nonce skip the rest of the countdown (lifecycle.restart, scope pending)
 *   POST /lifecycle/cancel        authenticate+nonce before the stop-new-work signal only (lifecycle.cancel)
 *   POST /lifecycle/restart       authenticate+nonce restart the workers at the current revision (lifecycle.restart, scope workers)
 *   POST /lifecycle/ack           loopback + per-start token: a worker's revision acknowledgement
 *
 * Plan a staged restart itself with POST /operations { kind: 'lifecycle.apply' }.
 */

const { ManagerError } = require('../errors');
const registry = require('../lifecycle/registry');
const { createLifecycleStore } = require('../lifecycle/store');
const revisionAck = require('@goobster/core/runtime/revisionAck');

const ACK_TOKEN_HEADER = 'x-goobster-ack-token';

function unsupervisedView(manager) {
    const { doc, problem } = createLifecycleStore({ storeDir: manager.settings.storeDir }).read();
    return {
        supervising: false,
        mode: null,
        layout: null,
        layoutError: null,
        stateProblem: problem,
        current: doc.current,
        pending: doc.pending
            ? { revision: doc.pending.revision, operationId: doc.pending.operationId, changeRef: doc.pending.changeRef, phase: doc.pending.phase, deadline: doc.pending.deadline }
            : null,
        committing: false,
        lastOutcome: doc.lastOutcome,
        acked: {},
        workers: [],
        events: doc.events.slice(-20)
    };
}

function mountLifecycleRoutes(api, { route, authenticate, readAuth, checkActor, throttle, noteFailure, guards, manager }) {
    function noBody(req, name) {
        if (Object.keys(req.body).length > 0) throw new ManagerError(400, 'INVALID_INPUT', `${name} takes no body.`);
    }

    async function runKind(req, kind, input, name) {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        noBody(req, name);
        const { operation, result } = await manager.engine.run(kind, input, auth);
        return { operation, result: result ?? null };
    }

    api.get('/lifecycle', route(async (req) => {
        readAuth(req);
        const supervisor = registry.get(manager.settings.storeDir);
        return supervisor ? supervisor.status({ probe: true }) : unsupervisedView(manager);
    }));

    api.post('/lifecycle/restart-now', route(req => runKind(req, 'lifecycle.restart', { scope: 'pending' }, 'restart-now')));

    api.post('/lifecycle/cancel', route(req => runKind(req, 'lifecycle.cancel', undefined, 'cancel')));

    api.post('/lifecycle/restart', route(req => runKind(req, 'lifecycle.restart', { scope: 'workers' }, 'restart')));

    api.post('/lifecycle/ack', route((req) => {
        if (!guards.isLocalRequest(req)) {
            throw new ManagerError(403, 'LOCAL_ONLY', 'Acknowledgements are accepted from this machine only.');
        }
        throttle('lifecycle-ack');
        const { worker, revision, pid, ...rest } = req.body;
        if (Object.keys(rest).length > 0 || !revisionAck.isWorkerName(worker)
            || !Number.isInteger(revision) || revision < 0 || !Number.isInteger(pid) || pid <= 0) {
            throw new ManagerError(400, 'INVALID_INPUT', 'The body must be { worker, revision, pid }.');
        }
        const supervisor = registry.get(manager.settings.storeDir);
        const token = req.headers[ACK_TOKEN_HEADER];
        if (!supervisor || !supervisor.ack({ worker, revision, pid, token: typeof token === 'string' ? token : '' })) {
            noteFailure('lifecycle-ack');
            throw new ManagerError(403, 'ACK_REFUSED', 'That acknowledgement does not match a worker this manager started.');
        }
        return { acknowledged: true, worker, revision };
    }));
}

module.exports = { mountLifecycleRoutes, ACK_TOKEN_HEADER };
