/**
 * The Docker database routes of the manager and the Host room's proxies for them
 * (#339, documentation/docker_postgres.md): `GET /manager/api/docker/status`,
 * `GET /api/app/admin/host/docker/status` and the five `database.docker.*` kinds
 * through `/api/app/admin/host/operations`.
 *
 * A real manager runs over HTTP on loopback, the portal is the real router with
 * devMode sessions and the bridge is the real key file (the shape of
 * databaseRoutes.test.js). The Docker daemon is a fake `docker` executable on
 * PATH (tests/helpers/fakeDocker.js) and the Postgres side is scripted through
 * `settings.databaseDeps`, so nothing needs Docker or a server; the suite runs on
 * SQLite and Postgres alike. Covers authorization (anonymous 401, member 403 and
 * nothing learned), the status view, that no password, URL or environment value is
 * echoed, journaled, audited or returned, and the names-only audit row.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-339-'));
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
const { mountDockerRoutes } = require('@goobster/manager/routes/docker');
const fakeDocker = require('./helpers/fakeDocker');
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


/** A claimed manager over a SQLite file with (or without) data, and a portal wired to it. */
async function harness({ sqliteRows = false, server = scriptedServer(), docker = {}, dockerDeps = {} } = {}) {
    const fake = fakeDocker.create(docker).install();
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
    settings.dockerDeps = { sleep: async () => {}, probeListen: async () => true, pgDump: async () => ({ present: true, text: 'pg_dump (PostgreSQL) 17.4' }), waitMs: 2000, pollMs: 5, platform: 'linux', hostArch: 'x64', ...dockerDeps };
    const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds, reconcileDeps: { closeAfter: false } });
    await manager.init();
    const managerServer = await listen(createManagerApp(manager, { logger: silent, mounts: [mountDatabaseRoutes, mountDockerRoutes] }));
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

    return { root, settings, manager, managerPort, server, fake, request, api, managerCall, texts, sqlite };
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


const names = h => require('@goobster/manager/docker/service').createDockerService({ settings: h.settings }).resourceNames(h.manager.store.readInstallation().doc.installationId);

describe('authorization', () => {
    test('anonymous callers get 401, members 403 on the Docker status and every Docker operation, and learn nothing about the manager or the machine', async () => {
        const h = await harness();
        const member = await signIn(h.request, MEMBER, 'Sam');
        const calls = [['GET', '/docker/status']].concat(host.DOCKER_DATABASE_KINDS.map(kind => ['POST', '/operations', { kind, input: {} }]));
        for (const [method, route, body] of calls) {
            const anonymous = await h.api(null, method, route, body);
            expect({ route, status: anonymous.status }).toEqual({ route, status: 401 });
            const denied = await h.api(member, method, route, body);
            expect({ route, status: denied.status, code: denied.json.error.code }).toEqual({ route, status: 403, code: 'FORBIDDEN' });
            expect(denied.text).not.toMatch(/manager|127\.0\.0\.1|bridge|docker\.sock|pgvector/i);
        }
        expect(h.fake.calls()).toEqual([]);
        expect(h.manager.journal.readAudit().entries.filter(item => item.action.includes('docker'))).toEqual([]);
    });

    test('the manager refuses a status call that is not signed by the bridge, and a request for a path with ".." or a relative path', async () => {
        const h = await harness();
        const unsigned = await fetch(`http://127.0.0.1:${h.managerPort}/manager/api/docker/status`);
        expect(unsigned.status).toBe(401);
        for (const storage of ['relative/dir', '/srv/../etc']) {
            const res = await h.managerCall('GET', `/manager/api/docker/status?storage=${encodeURIComponent(storage)}`);
            expect(res.status).toBe(400);
            expect(res.json.error.code).toBe('INVALID_INPUT');
        }
        expect(h.fake.calls()).toEqual([]);
    });
});

describe('GET /docker/status', () => {
    test('a healthy Engine: CLI, daemon, platform, the pinned image, backup tools and the verdict, with nothing owned yet', async () => {
        const h = await harness();
        const res = await h.api(await operatorCookie(h), 'GET', '/docker/status');
        expect(res.status).toBe(200);
        expect(res.json.daemon).toMatchObject({
            cli: { present: true },
            daemon: { reachable: true, flavor: 'engine' },
            image: { humanReference: 'pgvector/pgvector:pg17', pulled: true, postgresMajor: 17 },
            backupTools: { ok: true, code: 'BACKUP_TOOLS_OK' },
            verdict: { blocks: [] }
        });
        expect(res.json.names).toMatchObject({ container: expect.stringMatching(/^goobster-pg-[0-9a-f]{8}$/), volume: expect.stringMatching(/^goobster-pgdata-/), network: expect.stringMatching(/^goobster-[0-9a-f]{8}$/) });
        expect(res.json.record).toBeNull();
        expect(res.json.owned).toBeNull();
        expect(res.json.connected).toBe(false);
        expect(h.fake.mutations()).toEqual([]);
    });

    test.each([
        ['unreachable', 'DOCKER_DAEMON_UNREACHABLE'],
        ['permission', 'DOCKER_PERMISSION_DENIED'],
        ['windows', 'CONTAINER_OS_UNSUPPORTED']
    ])('a %s daemon is a verdict with its code and a remedy, not an HTTP error', async (mode, code) => {
        const h = await harness({ docker: { mode } });
        const res = await h.api(await operatorCookie(h), 'GET', '/docker/status');
        expect(res.status).toBe(200);
        const block = res.json.daemon.verdict.blocks.find(item => item.code === code);
        expect(block).toBeDefined();
        expect(block.remedy).toBeTruthy();
        expect(res.json.daemon.daemon.reachable).toBe(mode === 'windows');
    });

    test('a mismatched pg_dump is a warning with its remedy, and a storage path reports free space under it', async () => {
        const h = await harness({ dockerDeps: { pgDump: async () => ({ present: true, text: 'pg_dump (PostgreSQL) 15.8' }) } });
        const dir = fs.mkdtempSync(path.join(ROOT, 'storage-'));
        const res = await h.api(await operatorCookie(h), 'GET', `/docker/status?storage=${encodeURIComponent(dir)}`);
        expect(res.status).toBe(200);
        expect(res.json.daemon.backupTools).toMatchObject({ ok: false, code: 'BACKUP_TOOLS_MISMATCH' });
        expect(res.json.daemon.verdict.warnings.map(item => item.code)).toContain('BACKUP_TOOLS_MISMATCH');
        expect(res.json.daemon.storage).toBeTruthy();
    });

    test('after a provision it names the container, its health, port and storage, and never a password, URL or environment value', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'database.docker.provision', input: { pull: true } });
        expect(preview.status).toBe(200);
        const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
        expect(applied.status).toBe(200);
        const res = await h.api(cookie, 'GET', '/docker/status');
        expect(res.status).toBe(200);
        expect(res.json.record).toMatchObject({ step: 'verified', request: { port: 5432, bind: '127.0.0.1', storage: { kind: 'volume' } } });
        expect(res.json.owned.container).toMatchObject({ exists: true, running: true, health: 'healthy', port: 5432, imagePinned: true });
        expect(res.json.owned.volume).toBe(true);
        expect(res.json.owned.network).toBe(true);
        expect(res.text).not.toMatch(/postgres(ql)?:\/\//);
        expect(res.text).not.toContain(h.root);
        const application = h.server.provisioned.application.password;
        expect(res.text).not.toContain(application);
        expect(res.text).not.toContain(h.server.provisioned.elevated.password);
    });
});

describe('the Docker operations through the Host proxy', () => {
    test('provision: the preview changes nothing, the apply is audited as host.database.apply with names only, and no password appears anywhere', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'database.docker.provision', input: { pull: true } });
        expect(preview.status).toBe(200);
        expect(preview.json.operation).toMatchObject({ kind: 'database.docker.provision', status: 'validated' });
        expect(preview.json.operation.plan).toMatchObject({ effect: 'provision-docker-database', mode: 'fresh', ok: true, names: names(h) });
        expect(h.fake.mutations()).toEqual([]);
        expect(await auditRows('host.database.apply')).toEqual([]);

        const id = preview.json.operation.id;
        const applied = await h.api(cookie, 'POST', `/operations/${id}/apply`, {});
        expect(applied.status).toBe(200);
        expect(applied.json.operation.status).toBe('applied');
        const created = Object.keys(h.fake.state().containers);
        expect(created).toEqual([names(h).container]);

        const rows = await auditRows('host.database.apply');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ target: id, actor: OPERATOR });
        expect(rows[0].detail).toMatchObject({ operation: 'docker.provision', names: expect.any(Object) });
        const detail = JSON.stringify(rows[0].detail);
        for (const word of ['password', '127.0.0.1', 'postgres://', '5432']) expect(detail).not.toContain(word);

        const application = h.server.provisioned.application.password;
        const superuser = h.server.provisioned.elevated.password;
        const all = await everything(h) + h.fake.argvText();
        for (const secret of [application, superuser, encodeURIComponent(application)]) expect(all).not.toContain(secret);
        expect(h.fake.calls().find(call => call.args[0] === 'run').env).toEqual({ POSTGRES_PASSWORD: superuser });
        expect(environment.read(h.settings.storeDir).values.GOOBSTER_DB_URL).toBeUndefined();
    });

    test('the plan of a request that cannot work carries the blocks and remedies, and applying it is refused with the manager\'s code', async () => {
        const h = await harness({ docker: { mode: 'unreachable' } });
        const cookie = await operatorCookie(h);
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'database.docker.provision', input: { pull: true } });
        expect([200, 409]).toContain(preview.status);
        if (preview.status === 200) {
            expect(preview.json.operation.plan.ok).toBe(false);
            expect(preview.json.operation.plan.blocks.map(item => item.code)).toContain('DOCKER_DAEMON_UNREACHABLE');
            const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
            expect(applied.status).toBe(409);
            expect(applied.json.error.code).toBe('PREFLIGHT_FAILED');
        } else {
            expect(preview.json.error.code).toBe('PREFLIGHT_FAILED');
        }
        expect(h.fake.mutations()).toEqual([]);
    });

    test('start, stop and repair operate on the owned container; the audit rows carry the container, volume and network names only', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        const run = async (kind, input = {}) => {
            const preview = await h.api(cookie, 'POST', '/operations', { kind, input });
            expect(preview.status).toBe(200);
            const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
            expect(applied.status).toBe(200);
            return applied.json.operation;
        };
        await run('database.docker.provision', { pull: true });
        await run('database.docker.stop');
        expect(h.fake.state().containers[names(h).container].running).toBe(false);
        await run('database.docker.start');
        expect(h.fake.state().containers[names(h).container].running).toBe(true);
        const repair = await run('database.docker.repair');
        expect(repair.plan).toMatchObject({ effect: 'repair-docker-database', action: 'none' });

        const rows = await auditRows('host.database.apply');
        expect(rows.map(row => row.detail.operation)).toEqual(['docker.provision', 'docker.stop', 'docker.start', 'docker.repair']);
        for (const row of rows.slice(1)) {
            expect(row.detail.names).toEqual({ container: names(h).container, volume: names(h).volume, network: names(h).network });
            expect(JSON.stringify(row.detail)).not.toMatch(/password|postgres:\/\/|127\.0\.0\.1/);
        }
    });

    test('a stray field and a malformed request are refused before anything is created', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        for (const input of [{ extra: 1 }, { port: 70000 }, { bind: 'localhost' }, { storage: { kind: 'path', path: 'relative' } }]) {
            const res = await h.api(cookie, 'POST', '/operations', { kind: 'database.docker.provision', input });
            expect(res.status).toBe(400);
        }
        expect(h.fake.mutations()).toEqual([]);
        expect(Object.keys(h.fake.state().containers)).toEqual([]);
    });

    test('the Host proxy knows the five kinds and the audit vocabulary has every manager action', () => {
        for (const kind of host.DOCKER_DATABASE_KINDS) {
            expect(host.KINDS).toContain(kind);
            expect(operatorAudit.ACTIONS).toContain(`manager.${kind}`);
        }
        expect(operatorAudit.ACTIONS).toContain('host.database.apply');
    });
});
