/**
 * The update routes of the manager API (documentation/manager_update.md), under /manager/api:
 *
 *   GET  /update/status    readAuth           installed release, policy, last check, staged release,
 *                                             handoff / recovery state, how the last apply ended
 *   POST /update/check     authenticate+nonce ask the source what it offers (update.check)
 *   POST /update/stage     authenticate+nonce download, verify and stage it (update.stage)
 *   POST /update/apply     authenticate+nonce { when?: 'now'|'window' } apply the staged release (update.apply)
 *   POST /update/policy    authenticate+nonce { channel?, mode?, window?, source? } (update.policy)
 *   POST /update/recovery  authenticate+nonce { decision: 'restore'|'retry' }; a local operator or a
 *                          recovery session only, never a portal assertion or a setup session
 *
 * Each mutating route runs the matching operation kind, which writes the one audit entry.
 */

const { ManagerError } = require('../errors');
const wiring = require('../update/wiring');
const { buildStatus } = require('../update/status');

const RECOVERY_VIA = ['local', 'recovery'];

function mountUpdateRoutes(api, { route, authenticate, readAuth, checkActor, manager }) {
    async function runKind(req, kind, input) {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        const { operation, result } = await manager.engine.run(kind, input, auth);
        return { operation, result: result ?? null };
    }

    const noBody = (req, name) => {
        if (Object.keys(req.body || {}).length > 0) throw new ManagerError(400, 'INVALID_INPUT', `${name} takes no body.`);
    };

    api.get('/update/status', route((req) => {
        readAuth(req);
        return buildStatus({ manager, settings: manager.settings, now: manager.now });
    }));

    api.post('/update/check', route((req) => {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        noBody(req, 'check');
        return manager.engine.run('update.check', {}, auth).then(({ operation, result }) => ({ operation, result: result ?? null }));
    }));

    api.post('/update/stage', route((req) => {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        noBody(req, 'stage');
        return manager.engine.run('update.stage', {}, auth).then(({ operation, result }) => ({ operation, result: result ?? null }));
    }));

    api.post('/update/apply', route((req) => runKind(req, 'update.apply', req.body)));

    api.post('/update/policy', route((req) => runKind(req, 'update.policy', req.body)));

    api.post('/update/recovery', route(async (req) => {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        if (!RECOVERY_VIA.includes(auth.via)) {
            throw new ManagerError(403, 'RECOVERY_SESSION_REQUIRED', 'The decision after a failed update is made on this machine (the command line) or with the recovery credential, not from the portal.');
        }
        const body = req.body || {};
        for (const key of Object.keys(body)) {
            if (key !== 'decision') throw new ManagerError(400, 'INVALID_INPUT', 'The body must be { decision }.');
        }
        if (body.decision !== 'restore' && body.decision !== 'retry') throw new ManagerError(400, 'INVALID_INPUT', '"decision" must be "restore" or "retry".');
        const decide = wiring.decider(manager.settings.storeDir);
        if (!decide) throw new ManagerError(409, 'NOT_AVAILABLE', 'This manager has no update machinery.');
        const { operation, result } = await decide({ decision: body.decision, auth });
        return { operation, result: result ?? null };
    }));
}

module.exports = { mountUpdateRoutes };
