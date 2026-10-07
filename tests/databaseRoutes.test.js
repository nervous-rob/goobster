/**
 * The database routes of the manager and the Host room's proxies for them
 * (#338, documentation/database_connection.md): `GET /manager/api/database/status`,
 * `POST /manager/api/database/test` and the three operation kinds through
 * `/api/app/admin/host/operations`.
 *
 * A real manager runs over HTTP on loopback (the shape of hostRoutes.test.js),
 * the portal is the real router with devMode sessions and the bridge is the
 * real key file. The server is scripted through `settings.databaseDeps`, so
 * nothing needs Postgres; the suite runs on SQLite and Postgres alike (the
 * portal's own database is the suite's). Covers authorization (anonymous 401,
 * member 403 and nothing learned), that a password is held for one request
 * and never echoed, journaled, audited or returned, the status view's
 * contents, the rate limit, and the manager's refusals passing through.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'database-338-'));
if (!process.env.GOOBSTER_DB_URL) process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'app.sqlite');

const db = require('@goobster/core/db');
const identityService = require('@goobster/core/services/identityService');
const eventBusService = require('@goobster/core/services/eventBusService');
const coreBridge = require('@goobster/core/web/managerBridge');
const { createFeatureState } = require('@goobster/core/features/featureState');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const { createHostManagerClient } = require('@goobster/core/web/hostManagerClient');
const host = require('@goobster/core/web/routes/host');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const { expectedSchema } = require('@goobster/core/db/migration/schemaModel');
const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const { createStore } = require('@goobster/manager/store/installation');
const { mountDatabaseRoutes } = require('@goobster/manager/routes/database');
const environment = require('@goobster/manager/environment');
const extensions = require('@goobster/manager/extensions');
const configView = require('@goobster/manager/configView');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const OPERATOR = '100000000000000001';
const MEMBER = '100000000000000003';
const PASSWORD = 'route-pw/never?printed#52d7';
const ELEVATED = 'elevated-route-pw-never-printed-31aa';
const BASE = host.BASE;
const TABLES = ['operator_audit', 'account_emails', 'web_sessions', 'auth_identities', 'app_accounts', 'principals', 'users'];
const cleanups = [];
configView.configure({ closeConnections: false });

const listen = app => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const closeServer = server => new Promise(resolve => server.close(() => resolve()));

function inspected(over = {}) {
    return {
        reachable: true,
        user: 'goobster_app',
        isSuperuser: false,
        serverVersion: 170011,
        serverVersionText: '17.11',
        schema: 'public',
        schemaExists: true,
        canConnect: true,
        canCreateInDatabase: false,
        canCreateInSchema: true,
        canCreateDatabase: false,
        canCreateRole: false,
        tables: [],
        otherRelations: [],
        relationCount: 0,
        extensions: { citext: { available: true, installed: true, trusted: true }, vector: { available: true, installed: true, trusted: false } },
        tls: { encrypted: true, protocol: 'TLSv1.3' },
        freeBytes: null,
        ...over
    };
}
const goobsterTables = () => Object.entries(expectedSchema().tables).map(([name, model]) => ({ name, columns: model.columns.map(col => col.name) }));

function scriptedServer(schema = 'current') {
    const server = { schema, applied: [], seen: [] };
    const layout = () => ({
        empty: { tables: [] },
        foreign: { tables: [{ name: 'invoices', columns: ['id'] }] },
        current: { tables: goobsterTables() }
    })[server.schema];
    server.deps = {
        probeDeps: {
            createClient: () => ({}),
            inspect: async (url) => {
                server.seen.push(url);
                if (server.schema === 'unreachable') return { reachable: false, code: '28P01' };
                if (server.schema === 'throws') throw new Error(`connection to postgres://goobster_app:${PASSWORD}@db.example.com/goobster failed`);
                return inspected(layout());
            }
        },
        initDatabase: async ({ url }) => { server.applied.push(url); server.schema = 'current'; return { engine: 'postgres', tables: 3 }; },
        checkProvisioning: async () => ({
            state: { roleExists: false, databaseExists: false, schemaExists: false, schemaState: null, extensions: {} },
            permitted: { 'create-role': true, grant: true },
            blocked: [],
            dba: [],
            capabilities: { superuser: false, createRole: true, createDatabase: true }
        }),
        runProvisioning: async (args) => { server.provisioned = args; return { results: args.actions.map(action => ({ action, status: 'done' })) }; }
    };
    return server;
}

const connection = (extra = {}) => ({ host: 'db.example.com', port: 5432, database: 'goobster', schema: 'public', user: 'goobster_app', password: PASSWORD, tls: { mode: 'require' }, ...extra });

/** A claimed manager over a SQLite file with (or without) data, and a portal wired to it. */
async function harness({ sqliteRows = false, server = scriptedServer() } = {}) {
    const root = path.join(ROOT, crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), '{}\n', { mode: 0o600 });
    const sqlite = path.join(root, 'data', 'installation.sqlite');
    const file = new Database(sqlite);
    file.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE self_docs (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO self_docs (body) VALUES (\'docs\');');
    if (sqliteRows) file.exec('INSERT INTO users (name) VALUES (\'ada\')');
    file.close();
    const settings = resolveSettings({
        GOOBSTER_DATA_DIR: path.join(root, 'data'),
        GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        GOOBSTER_RUNTIME_MODE: 'standalone',
        GOOBSTER_DB_PATH: sqlite
    });
    const store = createStore({ root: settings.storeDir });
    store.init();
    store.createInstallation({ origin: 'claim', ownerLabel: 'Rob' });
    settings.databaseDeps = { ...server.deps };
    const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds, reconcileDeps: { closeAfter: false } });
    await manager.init();
    const managerServer = await listen(createManagerApp(manager, { logger: silent, mounts: [mountDatabaseRoutes] }));
    cleanups.push(() => closeServer(managerServer));
    const managerPort = managerServer.address().port;

    const bridge = coreBridge.createManagerBridge({ keyFile: manager.store.paths.bridgeKey });
    const client = createHostManagerClient({ baseUrl: () => `http://127.0.0.1:${managerPort}`, bridge });
    const gateway = { sendDm: async () => ({}), sendToChannel: async () => ({}), listMutualGuilds: async () => [] };
    const ctx = createWebAppContext({
        gateway,
        config: { clientId: '123', guildIds: ['900000000000000001'], webapp: { enabled: true, devMode: true } },
        logger: silent,
        deps: { hostManager: client, features: createFeatureState({ filePath: settings.featuresPath, env: {}, config: {} }) }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    const portal = await listen(app);
    cleanups.push(() => closeServer(portal));
    const portalPort = portal.address().port;

    function request({ method = 'GET', reqPath, body, cookie }) {
        const payload = body === undefined ? null : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = http.request({
                agent: false, host: '127.0.0.1', port: portalPort, method, path: reqPath,
                headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(cookie ? { cookie } : {}) }
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { /* not JSON */ }
                    resolve({ status: res.statusCode, headers: res.headers, json, text: data });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    const texts = [];
    async function api(cookie, method, route, body) {
        const res = await request({ method, reqPath: `${BASE}${route}`, body, cookie });
        texts.push(res.text);
        return res;
    }

    async function managerCall(method, reqPath, body) {
        const headers = bridge.headers({ actor: { actorId: OPERATOR, account: { role: 'operator', status: 'active' } }, method, path: reqPath });
        const res = await fetch(`http://127.0.0.1:${managerPort}${reqPath}`, {
            method,
            headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        texts.push(text);
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json, text };
    }

    return { root, settings, manager, managerPort, server, request, api, managerCall, texts, sqlite };
}

async function signIn(request, userId, name, role) {
    await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: name });
    if (role) await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role });
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session=')).split(';')[0];
}

const operatorCookie = h => signIn(h.request, OPERATOR, 'Rob', 'operator');

async function auditRows(action) {
    const rows = await db.all('SELECT action, actor, target, detailJson FROM operator_audit WHERE action = @action ORDER BY id', { action });
    return rows.map(row => ({ ...row, detail: row.detailJson ? JSON.parse(row.detailJson) : null }));
}

const everything = async h => JSON.stringify(h.manager.journal.list())
    + JSON.stringify(h.manager.journal.readAudit().entries)
    + JSON.stringify(await db.all('SELECT * FROM operator_audit'))
    + h.texts.join('\n');

beforeAll(async () => {
    await db.get('SELECT 1 AS ok');
});

beforeEach(async () => {
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`);
});

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});

afterAll(async () => {
    await eventBusService.close();
    await db.closeConnection();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('authorization', () => {
    test('anonymous callers get 401, members 403 on every database route, and learn nothing about the manager', async () => {
        const h = await harness();
        const member = await signIn(h.request, MEMBER, 'Sam');
        const calls = [
            ['GET', '/database/status'],
            ['POST', '/database/test', { connection: connection() }],
            ['POST', '/operations', { kind: 'database.provision', input: { connection: connection(), elevated: { user: 'a', password: 'b' }, actions: ['create-role'] } }],
            ['POST', '/operations', { kind: 'database.schema.apply', input: { connection: connection() } }],
            ['POST', '/operations', { kind: 'database.connect', input: { connection: connection() } }]
        ];
        for (const [method, route, body] of calls) {
            const anonymous = await h.api(null, method, route, body);
            expect({ route, status: anonymous.status }).toEqual({ route, status: 401 });
            const denied = await h.api(member, method, route, body);
            expect({ route, status: denied.status, code: denied.json.error.code }).toEqual({ route, status: 403, code: 'FORBIDDEN' });
            expect(denied.text).not.toMatch(/manager|127\.0\.0\.1|bridge|db\.example\.com/i);
        }
        expect(h.server.seen).toEqual([]);
        expect(h.manager.journal.readAudit().entries.filter(item => item.action.includes('database'))).toEqual([]);
    });

    test('the manager refuses a call that is not signed by the bridge, and the test route needs the same signature', async () => {
        const h = await harness();
        for (const [method, route, body] of [['GET', '/manager/api/database/status'], ['POST', '/manager/api/database/test', { connection: connection() }]]) {
            const res = await fetch(`http://127.0.0.1:${h.managerPort}${route}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
            expect({ route, status: res.status }).toEqual({ route, status: 401 });
            expect(await res.text()).not.toContain(PASSWORD);
        }
        expect(h.server.seen).toEqual([]);
    });
});

describe('POST /database/test', () => {
    test('probes through the portal, reports the verdict, and never echoes the password', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        const res = await h.api(cookie, 'POST', '/database/test', { connection: connection() });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({
            reachable: true,
            auth: 'ok',
            server: { supported: true },
            schema: { state: 'goobster-current' },
            verdict: { ok: true }
        });
        expect(res.json.extensions).toMatchObject({ citext: { available: true, installed: true }, vector: { available: true, installed: true, trusted: false } });
        expect(res.json.tls).toMatchObject({ encrypted: true });
        expect(res.text).not.toContain(PASSWORD);
        expect(res.text).not.toContain(encodeURIComponent(PASSWORD));
        expect(h.server.seen).toHaveLength(1);
        expect(decodeURIComponent(h.server.seen[0])).toContain(PASSWORD);
        expect(await auditRows('host.database.apply')).toEqual([]);
        expect(environment.read(h.settings.storeDir).present).toBe(false);
        expect(await everything(h)).not.toContain(PASSWORD);
    });

    test('a failed login is told apart and still carries no secret', async () => {
        const h = await harness({ server: scriptedServer('unreachable') });
        const res = await h.api(await operatorCookie(h), 'POST', '/database/test', { connection: connection() });
        expect(res.status).toBe(200);
        expect(res.json.reachable).toBe(false);
        expect(res.json.verdict.ok).toBe(false);
        expect(JSON.stringify(res.json.verdict.blocks)).toMatch(/AUTH_FAILED|auth/i);
        expect(await everything(h)).not.toContain(PASSWORD);
    });

    test('an error that quotes the password is scrubbed before it leaves the manager', async () => {
        const h = await harness({ server: scriptedServer('throws') });
        const res = await h.api(await operatorCookie(h), 'POST', '/database/test', { connection: connection() });
        expect([200, 400, 500, 502]).toContain(res.status);
        expect(res.text).not.toContain(PASSWORD);
        expect(res.text).not.toContain(encodeURIComponent(PASSWORD));
        expect(await everything(h)).not.toContain(PASSWORD);
    });

    test.each([
        [{ connection: connection(), extra: 1 }, 'INVALID_INPUT'],
        [{}, 'INVALID_INPUT'],
        [{ connection: connection({ host: 'postgres://x' }) }, 'INVALID_HOST'],
        [{ connection: connection({ port: 70000 }) }, 'INVALID_PORT'],
        [{ connection: connection({ tls: { mode: 'sometimes' } }) }, 'INVALID_TLS_MODE'],
        [{ connection: connection({ tls: { mode: 'verify-full' } }) }, 'TLS_CA_REQUIRED']
    ])('%j is refused with %s before any connection is made', async (body, code) => {
        const h = await harness();
        const res = await h.api(await operatorCookie(h), 'POST', '/database/test', body);
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe(code);
        expect(h.server.seen).toEqual([]);
        expect(res.text).not.toContain(PASSWORD);
    });

    test('the manager allows twelve probes a minute and then says so', async () => {
        const h = await harness();
        let last;
        for (let i = 0; i < 13; i++) last = await h.managerCall('POST', '/manager/api/database/test', { connection: connection() });
        expect(last.status).toBe(429);
        expect(last.json.error.code).toBe('TOO_MANY_PROBES');
        expect(h.server.seen).toHaveLength(12);
    });

    test('the manager route takes exactly one field', async () => {
        const h = await harness();
        const res = await h.managerCall('POST', '/manager/api/database/test', { connection: connection(), url: 'postgres://x' });
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe('INVALID_INPUT');
    });
});

describe('GET /database/status', () => {
    test('an installation on SQLite: engine, storage owner, emptiness and the layout, with no URL, password or path', async () => {
        const h = await harness({ sqliteRows: true });
        const res = await h.api(await operatorCookie(h), 'GET', '/database/status');
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({
            engine: 'sqlite',
            connection: null,
            mismatch: false,
            storage: { owner: 'installation', external: false },
            sqlite: { present: true, readable: true, empty: false },
            migration: { state: 'none' },
            overlay: { present: false }
        });
        expect(res.json.sqlite.populated).toContain('users');
        expect(res.text).not.toContain(h.root);
        expect(res.text).not.toMatch(/postgres:\/\//);
    });

    test('after a connection is in effect it names host, database and user, the engine is Postgres and the storage is external', async () => {
        const h = await harness();
        const url = `postgres://goobster_app:${encodeURIComponent(PASSWORD)}@db.example.com:5432/goobster?sslmode=require&options=${encodeURIComponent('-c search_path=public')}`;
        environment.write(h.settings.storeDir, { GOOBSTER_DB_URL: url });
        environment.apply(h.settings, { GOOBSTER_DB_URL: url });
        const res = await h.api(await operatorCookie(h), 'GET', '/database/status');
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({
            engine: 'postgres',
            storage: { owner: 'external', external: true },
            connection: { host: 'db.example.com', database: 'goobster', source: 'overlay' },
            overlay: { present: true },
            sqlite: null
        });
        expect(res.text).not.toContain(PASSWORD);
        expect(res.text).not.toContain(encodeURIComponent(PASSWORD));
        expect(res.text).not.toContain(url);
    });
});

describe('the operations through the Host proxy', () => {
    test('schema.apply: preview writes nothing, apply is audited as host.database.apply with names only, and the password never appears', async () => {
        const h = await harness({ server: scriptedServer('empty') });
        const cookie = await operatorCookie(h);
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'database.schema.apply', input: { connection: connection() } });
        expect(preview.status).toBe(200);
        expect(preview.json.operation).toMatchObject({ kind: 'database.schema.apply', status: 'validated' });
        expect(preview.json.operation.plan).toMatchObject({ effect: 'apply-schema' });
        expect(h.server.applied).toEqual([]);
        expect((await auditRows('host.database.apply'))).toEqual([]);

        const id = preview.json.operation.id;
        const applied = await h.api(cookie, 'POST', `/operations/${id}/apply`, {});
        expect(applied.status).toBe(200);
        expect(applied.json.operation.status).toBe('applied');
        expect(h.server.applied).toHaveLength(1);
        const rows = await auditRows('host.database.apply');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ target: id, actor: OPERATOR });
        expect(rows[0].detail).toMatchObject({ operation: 'schema', effect: 'apply-schema', before: 'empty', database: { database: 'goobster', schema: 'public' } });
        expect(JSON.stringify(rows[0].detail)).not.toContain('db.example.com');
        expect(await everything(h)).not.toContain(PASSWORD);
        expect(await everything(h)).not.toContain(encodeURIComponent(PASSWORD));
    });

    test('provision: the elevated credential is typed once, never returns, and the audit row names the ticked actions only', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        const actions = ['create-role', 'grant'];
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'database.provision', input: { connection: connection(), elevated: { user: 'admin', password: ELEVATED }, actions } });
        expect(preview.status).toBe(200);
        expect(preview.text).not.toContain(ELEVATED);
        expect(preview.text).not.toContain(PASSWORD);
        expect(preview.json.operation.plan).toMatchObject({ effect: 'provision-database', elevated: { user: 'admin', persisted: false } });

        const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
        expect(applied.status).toBe(200);
        expect(h.server.provisioned.elevated.password).toBe(ELEVATED);
        expect(h.server.provisioned.actions).toEqual(actions);
        const rows = await auditRows('host.database.apply');
        expect(rows[0].detail).toMatchObject({ operation: 'provision', actions, done: ['create-role:done', 'grant:done'] });
        const all = await everything(h);
        for (const secret of [ELEVATED, PASSWORD, encodeURIComponent(PASSWORD)]) expect(all).not.toContain(secret);
        expect(environment.read(h.settings.storeDir).present).toBe(false);
    });

    test('the manager\'s refusals pass through with their code: a foreign schema, and an installation the manager does not own', async () => {
        const foreign = await harness({ server: scriptedServer('foreign') });
        const refused = await foreign.api(await operatorCookie(foreign), 'POST', '/operations', { kind: 'database.schema.apply', input: { connection: connection() } });
        expect(refused.status).toBe(409);
        expect(refused.json.error.code).toBe('SCHEMA_FOREIGN');
        expect(refused.text).not.toContain(PASSWORD);

        const populated = await harness({ sqliteRows: true });
        const connect = await populated.api(await operatorCookie(populated), 'POST', '/operations', { kind: 'database.connect', input: { connection: connection() } });
        expect(connect.status).toBe(409);
        expect(connect.json.error.code).toBe('NOT_MANAGED');
        expect(connect.text).not.toContain(PASSWORD);
        expect(environment.read(populated.settings.storeDir).present).toBe(false);
    });

    test('an unknown kind and a stray field are refused', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        expect((await h.api(cookie, 'POST', '/operations', { kind: 'database.drop', input: {} })).json.error.code).toBe('UNKNOWN_KIND');
        const stray = await h.api(cookie, 'POST', '/operations', { kind: 'database.schema.apply', input: { connection: connection(), url: 'postgres://x' } });
        expect(stray.status).toBe(400);
    });

    test('the audit vocabulary knows the action the proxy writes', () => {
        expect(operatorAudit.ACTIONS).toContain('host.database.apply');
        expect(host.DATABASE_KINDS).toEqual(['database.provision', 'database.schema.apply', 'database.connect']);
        for (const kind of host.DATABASE_KINDS) expect(host.KINDS).toContain(kind);
    });
});
