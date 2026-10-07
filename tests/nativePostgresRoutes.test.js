/**
 * The native database routes of the manager and the Host room's proxies for them
 * (#340, documentation/native_postgres.md): `GET /manager/api/native/status`,
 * `GET /api/app/admin/host/native/status` and the five `database.native.*` kinds
 * through `/api/app/admin/host/operations`.
 *
 * A real manager runs over HTTP on loopback, the portal is the real router with
 * devMode sessions and the bridge is the real key file (the shape of
 * databaseRoutes.test.js). The machine is fake: apt-get, pg_createcluster, psql and
 * the rest are fake executables (tests/helpers/fakeNative.js) and the real privileged
 * helper runs as an ordinary user inside that sandbox; the Postgres side is
 * scripted through `settings.databaseDeps`. Nothing needs a package manager or a
 * server, and the suite runs on SQLite and Postgres alike. Covers authorization
 * (anonymous 401, member 403 and nothing learned), the status view, that no password,
 * URL or environment value is echoed, journaled, audited or returned, and the
 * names-only audit row.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'native-340-'));
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
const { mountNativeRoutes } = require('@goobster/manager/routes/native');
const privileged = require('@goobster/manager/privileged');
const fakeNative = require('./helpers/fakeNative');
const environment = require('@goobster/manager/environment');
const extensions = require('@goobster/manager/extensions');
const configView = require('@goobster/manager/configView');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = 'route-pw/never?printed#52d7';
const OPERATOR = '100000000000000001';
const MEMBER = '100000000000000003';
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
        runProvisioning: async () => { throw new Error('the native option never provisions through the #338 library'); }
    };
    return server;
}


/** A claimed manager over a SQLite file with (or without) data, and a portal wired to it. */
async function harness({ sqliteRows = false, server = scriptedServer(), machine = {}, nativeDeps = {}, elevation = null } = {}) {
    const fake = fakeNative.create({ distro: 'debian', ...machine });
    fake.install();
    cleanups.push(() => fake.restore());
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
    settings.installDeps = { privileged, privilegedOptions: fake.privilegedOptions(elevation ? { elevation } : {}) };
    settings.nativeDeps = fake.nativeDeps(nativeDeps);
    const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds, reconcileDeps: { closeAfter: false } });
    await manager.init();
    const managerServer = await listen(createManagerApp(manager, { logger: silent, mounts: [mountDatabaseRoutes, mountNativeRoutes] }));
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

    return { root, settings, manager, managerPort, server, fake, request, api, managerCall, texts, sqlite, dataDirectory: path.join(fake.dir, 'srv', 'pgdata') };
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


const run = async (h, cookie, kind, input = {}) => {
    const preview = await h.api(cookie, 'POST', '/operations', { kind, input });
    expect(preview.status).toBe(200);
    const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
    expect(applied.status).toBe(200);
    return { preview: preview.json.operation, applied: applied.json.operation };
};

describe('authorization', () => {
    test('anonymous callers get 401, members 403 on the native status and every native operation, and learn nothing about the manager or the machine', async () => {
        const h = await harness();
        const member = await signIn(h.request, MEMBER, 'Sam');
        const calls = [['GET', '/native/status']].concat(host.NATIVE_DATABASE_KINDS.map(kind => ['POST', '/operations', { kind, input: {} }]));
        for (const [method, route, body] of calls) {
            const anonymous = await h.api(null, method, route, body);
            expect({ route, status: anonymous.status }).toEqual({ route, status: 401 });
            const denied = await h.api(member, method, route, body);
            expect({ route, status: denied.status, code: denied.json.error.code }).toEqual({ route, status: 403, code: 'FORBIDDEN' });
            expect(denied.text).not.toMatch(/manager|127\.0\.0\.1|bridge|pg_lsclusters|postgresql-17/i);
        }
        expect(h.fake.calls()).toEqual([]);
        expect(h.manager.journal.readAudit().entries.filter(item => item.action.includes('native'))).toEqual([]);
    });

    test('the manager refuses a status call that is not signed by the bridge, and a storage query with ".." or a relative path', async () => {
        const h = await harness();
        const unsigned = await fetch(`http://127.0.0.1:${h.managerPort}/manager/api/native/status`);
        expect(unsigned.status).toBe(401);
        for (const storage of ['relative/dir', '/srv/../etc']) {
            const res = await h.managerCall('GET', `/manager/api/native/status?storage=${encodeURIComponent(storage)}`);
            expect(res.status).toBe(400);
            expect(res.json.error.code).toBe('INVALID_INPUT');
        }
        expect(h.fake.mutations()).toEqual([]);
    });
});

describe('GET /native/status', () => {
    test('a supported host: distribution, packages, clusters, elevation and the names it would use, with nothing owned yet', async () => {
        const h = await harness();
        h.fake.seedForeignCluster({ name: 'main', port: 5432 });
        const res = await h.api(await operatorCookie(h), 'GET', '/native/status');
        expect(res.status).toBe(200);
        expect(res.json.host).toMatchObject({
            supported: true,
            distro: { id: 'debian', family: 'debian' },
            packageManager: expect.any(String),
            major: 17
        });
        expect(res.json.host.clusters).toEqual([expect.objectContaining({ name: 'main', port: 5432, owned: false })]);
        expect(res.json.elevation).toMatchObject({ available: true });
        expect(res.json.names).toMatchObject({ cluster: 'goobster' });
        expect(res.json.record).toBeNull();
        expect(res.json.owned).toBeNull();
        expect(res.json.connected).toBe(false);
        expect(h.fake.mutations()).toEqual([]);
    });

    test('a host that cannot take the option is a verdict with its reason and a remedy, not an HTTP error', async () => {
        const h = await harness({ nativeDeps: { distro: { supported: false, reason: 'DISTRO_UNSUPPORTED', remedy: 'Use the Docker option.', family: null, id: 'arch' } } });
        const res = await h.api(await operatorCookie(h), 'GET', '/native/status');
        expect(res.status).toBe(200);
        expect(res.json.host).toMatchObject({ supported: false, reason: 'DISTRO_UNSUPPORTED' });
        expect(res.json.host.remedy).toBeTruthy();
    });

    test('no elevation is reported as such', async () => {
        const h = await harness({ elevation: { kind: 'none', reason: 'NO_ELEVATION' } });
        const res = await h.api(await operatorCookie(h), 'GET', '/native/status');
        expect(res.status).toBe(200);
        expect(res.json.elevation).toMatchObject({ available: false });
        expect(h.fake.mutations()).toEqual([]);
    });

    test('?storage= adds the free space and reachability facts for that directory; it creates nothing', async () => {
        const h = await harness();
        const dir = path.join(h.fake.dir, 'srv', 'chosen');
        const res = await h.api(await operatorCookie(h), 'GET', `/native/status?storage=${encodeURIComponent(dir)}`);
        expect(res.status).toBe(200);
        expect(res.json.host.storage).toMatchObject({ exists: false, candidate: true });
        expect(fs.existsSync(dir)).toBe(false);
        expect(h.fake.mutations()).toEqual([]);
    });

    test('after a provision it names the cluster, its port and storage, and never a password, URL or environment value', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        await run(h, cookie, 'database.native.provision', { installPackages: true, dataDirectory: h.dataDirectory, port: 5433 });
        const res = await h.api(cookie, 'GET', '/native/status');
        expect(res.status).toBe(200);
        expect(res.json.record).toMatchObject({ step: 'verified', complete: true, cluster: { name: 'goobster', port: 5433, bind: '127.0.0.1', dataDirectory: h.dataDirectory } });
        expect(res.json.owned).toMatchObject({ exists: true, online: true, port: 5433 });
        expect(res.json.connected).toBe(false);
        expect(res.text).not.toMatch(/postgres(ql)?:\/\//);
        const url = environment.read(h.settings.storeDir).values.GOOBSTER_NATIVE_DB_URL;
        const password = decodeURIComponent(new URL(url).password);
        expect(res.text).not.toContain(password);
        expect(res.text).not.toContain('GOOBSTER_NATIVE_DB_URL');
    });
});

describe('the native operations through the Host proxy', () => {
    test('provision: the preview changes nothing, the apply is audited as host.database.apply with names only, and no password appears anywhere', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'database.native.provision', input: { installPackages: true, dataDirectory: h.dataDirectory } });
        expect(preview.status).toBe(200);
        expect(preview.json.operation).toMatchObject({ kind: 'database.native.provision', status: 'validated' });
        expect(preview.json.operation.plan).toMatchObject({ effect: 'provision-native-database', mode: 'fresh', ok: true });
        expect(h.fake.mutations()).toEqual([]);
        expect(await auditRows('host.database.apply')).toEqual([]);

        const id = preview.json.operation.id;
        const applied = await h.api(cookie, 'POST', `/operations/${id}/apply`, {});
        expect(applied.status).toBe(200);
        expect(applied.json.operation.status).toBe('applied');
        expect(h.fake.state().clusters.map(item => item.name)).toEqual(['goobster']);

        const rows = await auditRows('host.database.apply');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ target: id, actor: OPERATOR });
        expect(rows[0].detail).toMatchObject({ operation: 'native.provision', names: expect.any(Object) });
        const detail = JSON.stringify(rows[0].detail);
        for (const word of ['password', '127.0.0.1', 'postgres://', '5432', h.dataDirectory]) expect(detail).not.toContain(word);

        const url = environment.read(h.settings.storeDir).values.GOOBSTER_NATIVE_DB_URL;
        const password = decodeURIComponent(new URL(url).password);
        const all = await everything(h) + h.fake.argvText() + h.fake.stdinText();
        for (const secret of [password, encodeURIComponent(password), url]) expect(all).not.toContain(secret);
        expect(h.fake.stdinText()).toMatch(/NOSUPERUSER/);
        expect(environment.read(h.settings.storeDir).values.GOOBSTER_DB_URL).toBeUndefined();
    });

    test('the plan of a request that cannot work carries the blocks and remedies, and applying it is refused with the manager\'s code', async () => {
        const h = await harness({ elevation: { kind: 'none', reason: 'NO_ELEVATION' } });
        const cookie = await operatorCookie(h);
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'database.native.provision', input: { installPackages: true, dataDirectory: h.dataDirectory } });
        expect([200, 409]).toContain(preview.status);
        if (preview.status === 200) {
            expect(preview.json.operation.plan.ok).toBe(false);
            expect(preview.json.operation.plan.blocks.map(item => item.code)).toContain('ELEVATION_UNAVAILABLE');
            const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
            expect(applied.status).toBe(409);
            expect(applied.json.error.code).toBe('PREFLIGHT_FAILED');
        } else {
            expect(preview.json.error.code).toBe('PREFLIGHT_FAILED');
        }
        expect(h.fake.mutations()).toEqual([]);
    });

    test('start, stop and repair operate on the owned cluster; the audit rows carry the cluster name only', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        await run(h, cookie, 'database.native.provision', { installPackages: true, dataDirectory: h.dataDirectory });
        const clusterOnline = () => h.fake.state().clusters.find(item => item.name === 'goobster').online;
        await run(h, cookie, 'database.native.stop');
        expect(clusterOnline()).toBe(false);
        await run(h, cookie, 'database.native.start');
        expect(clusterOnline()).toBe(true);
        const repair = await run(h, cookie, 'database.native.repair');
        expect(repair.preview.plan).toMatchObject({ effect: 'repair-native-database', action: 'none' });

        const rows = await auditRows('host.database.apply');
        expect(rows.map(row => row.detail.operation)).toEqual(['native.provision', 'native.stop', 'native.start', 'native.repair']);
        for (const row of rows.slice(1)) {
            expect(JSON.stringify(row.detail.names)).toContain('goobster');
            expect(JSON.stringify(row.detail)).not.toMatch(/password|postgres:\/\/|127\.0\.0\.1|\/srv\//);
        }
    });

    test('a stray field and a malformed request are refused before anything is created', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        for (const input of [{ extra: 1 }, { port: 70000 }, { bind: 'localhost' }, { dataDirectory: 'relative' }]) {
            const res = await h.api(cookie, 'POST', '/operations', { kind: 'database.native.provision', input });
            expect(res.status).toBe(400);
        }
        expect(h.fake.mutations()).toEqual([]);
        expect(h.fake.state().clusters).toEqual([]);
    });

    test('a LAN bind without acknowledgement is refused', async () => {
        const h = await harness();
        const res = await h.api(await operatorCookie(h), 'POST', '/operations', { kind: 'database.native.provision', input: { installPackages: true, bind: '0.0.0.0', dataDirectory: h.dataDirectory } });
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe('LAN_BIND_NOT_ACKNOWLEDGED');
        expect(h.fake.mutations()).toEqual([]);
    });

    test('the Host proxy knows the five kinds and the audit vocabulary has every manager action', () => {
        expect(host.NATIVE_DATABASE_KINDS).toHaveLength(5);
        for (const kind of host.NATIVE_DATABASE_KINDS) {
            expect(host.KINDS).toContain(kind);
            expect(host.DATABASE_KINDS).toContain(kind);
            expect(operatorAudit.ACTIONS).toContain(`manager.${kind}`);
        }
        expect(operatorAudit.ACTIONS).toContain('host.database.apply');
    });
});
