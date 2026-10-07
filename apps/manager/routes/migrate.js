/**
 * The migration routes of the manager API (documentation/db_migration.md),
 * under /manager/api:
 *
 *   GET  /migrate/status      readAuth   the migration's progress, the per-table
 *                                        copy progress, the rollback boundary and
 *                                        the rollback-limit sentence
 *   POST /migrate/preflight   assertion  { target: { url } } -> the read-only
 *                                        inspection. The URL is held in memory for
 *                                        this request and is never journaled,
 *                                        audited, logged or echoed.
 *
 * The migration itself and its rollback are operation kinds planned in
 * process by the CLI (`db.migrate`, `db.migrate.rollback`): they take a
 * connection secret and a passphrase and rewrite the installation's
 * connection, so no route plans them.
 */

const { ManagerError } = require('../errors');
const { migrationStatus } = require('../migration/status');

const WINDOW_MS = 60_000;
const LIMIT = 12;

function mountMigrateRoutes(api, { route, authenticate, readAuth, checkActor, manager, now = () => new Date() }) {
    const times = [];

    function throttlePreflight() {
        const t = now().getTime();
        while (times.length > 0 && t - times[0] >= WINDOW_MS) times.shift();
        if (times.length >= LIMIT) throw new ManagerError(429, 'TOO_MANY_PREFLIGHTS', 'Too many migration preflights; wait a minute.');
        times.push(t);
    }

    api.get('/migrate/status', route((req) => {
        readAuth(req);
        return migrationStatus({ settings: manager.settings });
    }));

    api.post('/migrate/preflight', route(async (req) => {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'target')) {
            throw new ManagerError(400, 'INVALID_INPUT', 'The body must be { target: { url } }.');
        }
        throttlePreflight();
        const { operation, result } = await manager.engine.run('db.migrate.preflight', body, auth);
        return { operationId: operation.id, ...result };
    }));
}

module.exports = { mountMigrateRoutes };
