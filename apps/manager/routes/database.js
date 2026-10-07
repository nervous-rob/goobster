/**
 * The database routes of the manager API (documentation/database_connection.md),
 * under /manager/api:
 *
 *   GET  /database/status   readAuth   the connection in effect (host, port, database, user,
 *                                      schema, TLS, where it comes from), the engine the record
 *                                      says, whether SQLite is empty, the layout, the migration
 *                                      and maintenance state. No URL, no password, no path.
 *   POST /database/test     assertion  { connection: { host, port, database, schema, user,
 *                                      password, tls: { mode, caFile } } } -> the read-only
 *                                      probe report. The password is held for this request
 *                                      only: never journaled, audited, logged or echoed.
 *                                      Nothing is written to the server or to the installation.
 *
 * Changing anything is an operation kind (`database.provision`,
 * `database.schema.apply`, `database.connect`).
 */

const nodeFs = require('node:fs');
const { ManagerError } = require('../errors');
const { createBarrier } = require('../maintenance/barrier');
const { databaseStatus } = require('../database/state');
const { createProbe, redactDeep } = require('../database/probe');
const { parseConnection } = require('../database/input');

const WINDOW_MS = 60_000;
const LIMIT = 12;

function mountDatabaseRoutes(api, { route, authenticate, readAuth, checkActor, manager, now = () => new Date() }) {
    const times = [];
    const settings = manager.settings;
    const fs = manager.fs || nodeFs;

    function throttle() {
        const t = now().getTime();
        while (times.length > 0 && t - times[0] >= WINDOW_MS) times.shift();
        if (times.length >= LIMIT) throw new ManagerError(429, 'TOO_MANY_PROBES', 'Too many connection tests; wait a minute.');
        times.push(t);
    }

    api.get('/database/status', route(async (req) => {
        readAuth(req);
        const read = manager.store.readInstallation();
        let view = null;
        try {
            view = createBarrier({ settings, fs, now, logger: { info() {}, warn() {}, error() {} } }).view();
        } catch { }
        return databaseStatus({ settings, fs, doc: read.status === 'ok' ? read.doc : null, deps: settings.databaseDeps || {}, barrier: view });
    }));

    api.post('/database/test', route(async (req) => {
        const auth = authenticate(req);
        checkActor(req, auth.principal);
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'connection')) {
            throw new ManagerError(400, 'INVALID_INPUT', 'The body must be { connection: { host, port, database, schema, user, password, tls } }.');
        }
        const connection = parseConnection(body.connection);
        throttle();
        const report = await createProbe(settings)(connection);
        return redactDeep(report, [connection.password]);
    }));
}

module.exports = { mountDatabaseRoutes };
