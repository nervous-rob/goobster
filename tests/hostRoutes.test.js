/**
 * The Host room's operator routes (#326, installer P2.4): the portal-to-manager
 * proxy under /api/app/admin/host.
 *
 * A real manager runs over HTTP on loopback (the same harness shape as
 * managerConfig.test.js), the portal is the real router with devMode sessions,
 * and the bridge is the real key file, so every assertion is minted, verified
 * and journaled for real. Covers authorization (member 403, operator 200, a
 * member learns nothing about the manager), the manager-down status shape,
 * preview then apply, audit attribution (`host.*` with the operation id as
 * target and no value in `detail`), sanitized responses (no secret values, no
 * absolute paths), pass-through of the manager's 409 codes, the Mail refusal
 * rule, the shared-instance rule with the Gambling attestation, and the
 * restart controls over fake workers. Runs on SQLite and on Postgres.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'host-326-'));
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
const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const { createStore } = require('@goobster/manager/store/installation');
const { mountLifecycleRoutes } = require('@goobster/manager/routes/lifecycle');
const { createConfigMount } = require('@goobster/manager/routes/config');
const { createInstallMount } = require('@goobster/manager/routes/install');
const { makeRelease, freePort } = require('./helpers/installFixture');
const extensions = require('@goobster/manager/extensions');
const configView = require('@goobster/manager/configView');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const OPERATOR = '100000000000000001';
const SECOND = '100000000000000002';
const MEMBER = '100000000000000003';
const PLANTED = `sk-planted-${crypto.randomBytes(12).toString('hex')}`;
const PLANTED_ENV = `sk-planted-env-${crypto.randomBytes(12).toString('hex')}`;
const BASE = host.BASE;
const TABLES = ['operator_audit', 'account_emails', 'web_sessions', 'auth_identities', 'app_accounts', 'principals', 'users'];
const cleanups = [];
configView.configure({ closeConnections: false });

function newRoot() {
    const dir = path.join(ROOT, crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function listen(app) {
    return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

function closeServer(server) {
    return new Promise(resolve => server.close(() => resolve()));
}

/** A manager (claimed, optionally supervising fake workers) and a portal wired to it. */
async function harness({ config = {}, env = {}, claim = true, supervise = false, guildIds, probe, baseUrl, install = false } = {}) {
    const root = newRoot();
    fs.writeFileSync(path.join(root, 'config.json'), `${JSON.stringify(supervise ? { webapp: { enabled: true }, ...config } : config, null, 4)}\n`, { mode: 0o600 });
    const settings = resolveSettings({
        GOOBSTER_DATA_DIR: path.join(root, 'data'),
        GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        GOOBSTER_RUNTIME_MODE: 'standalone',
        ...(install ? { GOOBSTER_WORKSPACE_ROOT: path.join(root, 'app'), GOOBSTER_API_PORT: String(await freePort()), PORT: String(await freePort()), HOME: root, PATH: process.env.PATH } : {}),
        ...(claim
            ? (process.env.GOOBSTER_DB_URL ? { GOOBSTER_DB_URL: process.env.GOOBSTER_DB_URL } : { GOOBSTER_DB_PATH: process.env.GOOBSTER_DB_PATH })
            : { GOOBSTER_DB_PATH: path.join(root, 'nothing-here.sqlite') }),
        ...env
    });
    const store = createStore({ root: settings.storeDir });
    if (claim) {
        store.init();
        store.createInstallation({ origin: 'claim', ownerLabel: 'Rob' });
    }
    if (install) {
        fs.mkdirSync(path.join(root, 'app'), { recursive: true });
        settings.installDeps = {
            home: root, readCrontab: () => null, writeCrontab: () => {}, discover: () => ({ candidates: [], searched: 0 }),
            initDatabase: async () => ({ engine: 'sqlite', tables: 1 }), checkOwner: async () => ({ ok: true, accounts: 1, operators: 1 }), checkHealth: async () => false
        };
    }
    const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds, reconcileDeps: { closeAfter: false } });
    await manager.init();
    const mounts = [mountLifecycleRoutes, createConfigMount(probe ? { probe } : {}), createInstallMount()];
    const managerServer = await listen(createManagerApp(manager, { logger: silent, mounts }));
    cleanups.push(() => closeServer(managerServer));
    const managerPort = managerServer.address().port;

    const fakes = createFakeWorkers();
    let supervisor = null;
    if (supervise) {
        supervisor = createSupervisor({
            manager, adapter: fakes.adapter, checkHealth: fakes.checkHealth, sandboxActive: () => false, logger: silent, policy: { ...FAST_POLICY }
        });
        const unregister = registry.register(settings.storeDir, supervisor);
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).acked.api === 0, { what: 'api ack' });
        cleanups.push(async () => {
            await supervisor.stop();
            unregister();
            for (const proc of fakes.alive()) proc.die(0);
        });
    }

    const bridge = coreBridge.createManagerBridge({ keyFile: manager.store.paths.bridgeKey });
    const client = createHostManagerClient({
        baseUrl: baseUrl ? () => baseUrl : () => `http://127.0.0.1:${managerPort}`,
        bridge
    });
    const gateway = { sendDm: async () => ({}), sendToChannel: async () => ({}), listMutualGuilds: async () => [] };
    const ctx = createWebAppContext({
        gateway,
        config: { clientId: '123', guildIds: guildIds || ['900000000000000001'], webapp: { enabled: true, devMode: true } },
        logger: silent,
        deps: {
            hostManager: client,
            features: createFeatureState({ filePath: settings.featuresPath, env: {}, config: {} })
        }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    const portal = await listen(app);
    cleanups.push(() => closeServer(portal));
    const portalPort = portal.address().port;

    function request({ method = 'GET', reqPath, body, cookie, port = portalPort }) {
        const payload = body === undefined ? null : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = http.request({
                agent: false, host: '127.0.0.1', port, method, path: reqPath,
                headers: {
                    ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                    ...(cookie ? { cookie } : {})
                }
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

    /** A direct, bridge-authenticated manager call as OPERATOR (for state the portal is not asked to create). */
    async function managerCall(method, reqPath, body) {
        const headers = bridge.headers({ actor: { actorId: OPERATOR, account: { role: 'operator', status: 'active' } }, method, path: reqPath });
        const res = await fetch(`http://127.0.0.1:${managerPort}${reqPath}`, {
            method,
            headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: res.status, body: await res.json() };
    }

    return { root, settings, manager, managerPort, fakes, supervisor, request, api, managerCall, texts, client, ctx };
}

async function signIn(request, userId, name, role) {
    await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: name });
    if (role) await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role });
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session=')).split(';')[0];
}

const operatorCookie = h => signIn(h.request, OPERATOR, 'Rob', 'operator');

function writeFeatures(h, features, revision = 1) {
    fs.mkdirSync(path.dirname(h.settings.featuresPath), { recursive: true });
    fs.writeFileSync(h.settings.featuresPath, JSON.stringify({
        version: 1, revision, updatedAt: '2026-10-06 21:14:02', origin: 'operator', features
    }));
}

const everythingInstalled = (extra = {}) => {
    const catalog = require('@goobster/core/features/catalog');
    const out = {};
    for (const id of catalog.FEATURE_IDS.filter(feature => feature !== 'core')) out[id] = { installed: true, active: false, ...(extra[id] || {}) };
    return out;
};

const featureRow = (res, id) => res.json.features.find(row => row.id === id);
const fieldOf = (report, id) => report.sections.flatMap(section => section.fields).find(entry => entry.id === id);

async function auditRows(action) {
    const rows = await db.all('SELECT action, actor, target, detailJson FROM operator_audit WHERE action = @action ORDER BY id', { action });
    return rows.map(row => ({ ...row, detail: row.detailJson ? JSON.parse(row.detailJson) : null }));
}

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
    test('anonymous callers get 401, members 403 on every route, and a member reaches the manager for nothing', async () => {
        const h = await harness();
        const member = await signIn(h.request, MEMBER, 'Sam');
        const calls = [
            ['GET', '/manager'], ['GET', '/features'], ['GET', '/config'], ['POST', '/config/probe', { target: 'openai' }],
            ['POST', '/operations', { kind: 'features.set', input: { changes: { tavern: false } } }],
            ['POST', '/operations/abcdef123456/apply', {}], ['GET', '/lifecycle'],
            ['POST', '/lifecycle/restart-now', {}], ['POST', '/lifecycle/cancel', {}], ['POST', '/lifecycle/restart', {}],
            ['GET', '/install/suggest'], ['GET', '/install/record'], ['GET', '/install/source?dir=%2Ftmp'], ['GET', '/operations/abcdef123456'],
            ['POST', '/operations', { kind: 'install.repair', input: {} }], ['POST', '/operations', { kind: 'install.uninstall', input: {} }]
        ];
        const before = h.manager.journal.readAudit().entries.length;
        for (const [method, route, body] of calls) {
            const anonymous = await h.api(null, method, route, body);
            expect({ route, status: anonymous.status }).toEqual({ route, status: 401 });
            const denied = await h.api(member, method, route, body);
            expect({ route, status: denied.status, code: denied.json.error.code }).toEqual({ route, status: 403, code: 'FORBIDDEN' });
            expect(denied.text).not.toMatch(/manager|127\.0\.0\.1|bridge/i);
        }
        expect(h.manager.journal.readAudit().entries.length).toBe(before);
        expect(await db.all('SELECT action FROM operator_audit')).toEqual([]);
    });

    test('an operator is answered', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        for (const route of ['/manager', '/features', '/config', '/lifecycle']) {
            const res = await h.api(cookie, 'GET', route);
            expect({ route, status: res.status }).toEqual({ route, status: 200 });
        }
    });
});

describe('the manager as a status, never a 500', () => {
    test('a reachable claimed manager reports its state', async () => {
        const h = await harness();
        const res = await h.api(await operatorCookie(h), 'GET', '/manager');
        expect(res.json).toMatchObject({ reachable: true, state: 'claimed', bridge: { available: true }, error: null });
        expect(res.json.installationId).toEqual(expect.any(String));
        expect(res.text).not.toContain(h.root);
    });

    test('nothing listening: 200 with reachable false and MANAGER_UNREACHABLE; operations are 503', async () => {
        const h = await harness({ baseUrl: 'http://127.0.0.1:1' });
        const cookie = await operatorCookie(h);
        const status = await h.api(cookie, 'GET', '/manager');
        expect(status.status).toBe(200);
        expect(status.json).toMatchObject({ reachable: false, state: null, error: { code: 'MANAGER_UNREACHABLE' } });
        const features = await h.api(cookie, 'GET', '/features');
        expect(features.status).toBe(200);
        expect(features.json.manager).toMatchObject({ reachable: false, code: 'MANAGER_UNAVAILABLE' });
        expect(features.json.features.length).toBeGreaterThan(10);
        for (const [method, route, body] of [['GET', '/config'], ['GET', '/lifecycle'], ['POST', '/operations', { kind: 'features.set', input: { changes: { tavern: false } } }]]) {
            const res = await h.api(cookie, method, route, body);
            expect({ route, status: res.status, code: res.json.error.code }).toEqual({ route, status: 503, code: 'MANAGER_UNAVAILABLE' });
        }
    });

    test('an address that is not loopback http or https is refused, not called', async () => {
        const h = await harness({ baseUrl: 'http://manager.example.org:3400' });
        const res = await h.api(await operatorCookie(h), 'GET', '/manager');
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ reachable: false, error: { code: 'MANAGER_URL_REFUSED' } });
    });

    test('an unclaimed manager says so', async () => {
        const h = await harness({ claim: false });
        const res = await h.api(await operatorCookie(h), 'GET', '/manager');
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ reachable: true, state: 'unclaimed' });
        expect(res.json.error.code).toBe('MANAGER_NOT_CLAIMED');
    });

    test('a bridge the manager does not accept is MANAGER_BRIDGE_REFUSED, not a leak of the 401', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        const other = await harness();
        h.client.bridge.headers = ({ actor, method, path: p }) => coreBridge
            .createManagerBridge({ keyFile: other.manager.store.paths.bridgeKey }).headers({ actor, method, path: p });
        const res = await h.api(cookie, 'GET', '/config');
        expect(res.status).toBe(502);
        expect(res.json.error.code).toBe('MANAGER_BRIDGE_REFUSED');
    });
});

describe('features: the merged page model', () => {
    test('catalog rows carry names only, the manager revision, the host switches and the keeps-data line', async () => {
        const h = await harness({ config: { openaiKey: PLANTED } });
        writeFeatures(h, everythingInstalled({ economy: { active: true }, exchange: { active: true } }), 4);
        const res = await h.api(await operatorCookie(h), 'GET', '/features');
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ manager: { reachable: true }, revision: 4, source: 'file', shared: { shared: false } });
        expect(res.json.keepsData).toMatch(/keeps its data/);
        expect(res.json.gamblingAttestation.text).toMatch(/private/);
        const economy = featureRow(res, 'economy');
        expect(economy).toMatchObject({ requiredBy: ['exchange', 'gambling'], state: { installed: true, active: true, pending: false } });
        expect(economy.hostSwitch.name).toBe('Economy and exchange');
        expect(featureRow(res, 'gambling').hostSwitch.name).toBe('Gambling');
        expect(featureRow(res, 'gba').hostSwitch).toBeTruthy();
        expect(featureRow(res, 'openai')).toBeUndefined();
        const names = res.json.features.flatMap(row => row.apiKeys.map(key => key.name));
        expect(names).toContain('RESEND_API_KEY');
        expect(res.text).not.toContain(PLANTED);
        expect(res.text).not.toContain(h.root);
    });

    test('a pending change is shown from the manager with what it will become', async () => {
        const h = await harness();
        writeFeatures(h, everythingInstalled({ tavern: { active: true, pendingActive: false } }), 2);
        const res = await h.api(await operatorCookie(h), 'GET', '/features');
        expect(featureRow(res, 'tavern').state).toMatchObject({ active: true, pending: true, pendingActive: false });
    });
});

describe('preview, then apply, then one audit row', () => {
    test('features.set: preview writes nothing; apply writes features.json, the audit row has the operation id and names only', async () => {
        const h = await harness();
        writeFeatures(h, everythingInstalled({ tavern: { active: true } }), 1);
        const cookie = await operatorCookie(h);
        const before = fs.readFileSync(h.settings.featuresPath, 'utf8');

        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { tavern: false }, expectedRevision: 1 } });
        expect(preview.status).toBe(200);
        expect(preview.json.operation).toMatchObject({ kind: 'features.set', status: 'validated', revision: 1 });
        expect(preview.json.operation.plan.changes).toEqual([{ id: 'tavern', from: true, to: false, running: true }]);
        expect(preview.json.preview).toEqual({ restartRequired: true, warnings: [] });
        expect(fs.readFileSync(h.settings.featuresPath, 'utf8')).toBe(before);
        expect(await auditRows('host.features.apply')).toEqual([]);

        const id = preview.json.operation.id;
        const applied = await h.api(cookie, 'POST', `/operations/${id}/apply`, {});
        expect(applied.status).toBe(200);
        expect(applied.json.operation.status).toBe('applied');
        expect(applied.json.result).toMatchObject({ revision: 2, pending: ['tavern'] });
        expect(JSON.parse(fs.readFileSync(h.settings.featuresPath, 'utf8')).features.tavern).toMatchObject({ active: true, pendingActive: false });

        const rows = await auditRows('host.features.apply');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor: OPERATOR, target: id });
        expect(rows[0].detail).toEqual({ features: { tavern: false }, revision: 2, pending: ['tavern'] });
        const managerRecord = h.manager.journal.readAudit().entries.find(entry => entry.action === 'manager.features.set');
        expect(managerRecord).toBeTruthy();
        expect(h.texts.join('\n')).not.toContain(h.root);
    });

    test('the proxy does not forward a field features.set would refuse, and rejects unknown ones itself', async () => {
        const h = await harness();
        writeFeatures(h, everythingInstalled({ tavern: { active: true } }));
        const cookie = await operatorCookie(h);
        const unknown = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { tavern: false }, force: true } });
        expect(unknown).toMatchObject({ status: 400 });
        expect(unknown.json.error.code).toBe('INVALID_INPUT');
        const kind = await h.api(cookie, 'POST', '/operations', { kind: 'reset.everything', input: {} });
        expect(kind.json.error.code).toBe('UNKNOWN_KIND');
        const extra = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { tavern: false } }, actor: 'x' });
        expect(extra.json.error.code).toBe('INVALID_INPUT');
        const withBody = await h.api(cookie, 'POST', '/operations/abcdef123456/apply', { revision: 3 });
        expect(withBody.json.error.code).toBe('INVALID_INPUT');
        const badId = await h.api(cookie, 'POST', '/operations/..%2Fx/apply', {});
        expect([400, 404]).toContain(badId.status);
    });

    test('config.set: a secret is typed once, never comes back, and the audit row names the field only', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        const report = (await h.api(cookie, 'GET', '/config')).json;
        expect(fieldOf(report, 'ai.openai.apiKey')).toMatchObject({ present: false, source: 'unset', secret: true });

        const preview = await h.api(cookie, 'POST', '/operations', {
            kind: 'config.set',
            input: { expectedRevision: report.revision, changes: [{ id: 'ai.openai.apiKey', action: 'set', value: PLANTED }] }
        });
        expect(preview.status).toBe(200);
        expect(preview.json.operation.plan.changes).toEqual([expect.objectContaining({ id: 'ai.openai.apiKey', action: 'set', secret: true })]);
        expect(preview.text).not.toContain(PLANTED);
        expect(preview.json.preview.restartRequired).toBe(true);

        const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
        expect(applied.status).toBe(200);
        expect(applied.text).not.toContain(PLANTED);
        const after = (await h.api(cookie, 'GET', '/config')).json;
        const field = fieldOf(after, 'ai.openai.apiKey');
        expect(field).toMatchObject({ present: true, source: 'config', fingerprint: PLANTED.slice(-4), masked: true });
        expect(field).not.toHaveProperty('value');

        const rows = await auditRows('host.config.apply');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor: OPERATOR, target: preview.json.operation.id });
        expect(rows[0].detail.fields).toEqual([{ id: 'ai.openai.apiKey', action: 'set', secret: true }]);
        expect(JSON.stringify(rows)).not.toContain(PLANTED);

        const removed = await h.api(cookie, 'POST', '/operations', {
            kind: 'config.set', input: { expectedRevision: after.revision, changes: [{ id: 'ai.openai.apiKey', action: 'remove' }] }
        });
        expect((await h.api(cookie, 'POST', `/operations/${removed.json.operation.id}/apply`, {})).status).toBe(200);
        expect(fieldOf((await h.api(cookie, 'GET', '/config')).json, 'ai.openai.apiKey')).toMatchObject({ present: false, source: 'unset' });
        expect(h.texts.join('\n')).not.toContain(PLANTED);
        expect(h.texts.join('\n')).not.toContain(h.root);
        expect(JSON.stringify(await db.all('SELECT detailJson FROM operator_audit'))).not.toContain(PLANTED);
    });

    test('an environment-controlled field is read-only: the manager refuses and force is not accepted from the portal', async () => {
        const h = await harness({ env: { OPENAI_API_KEY: PLANTED_ENV } });
        const cookie = await operatorCookie(h);
        const report = (await h.api(cookie, 'GET', '/config')).json;
        expect(fieldOf(report, 'ai.openai.apiKey')).toMatchObject({ source: 'env', envControlled: true, fingerprint: PLANTED_ENV.slice(-4) });
        const input = { expectedRevision: report.revision, changes: [{ id: 'ai.openai.apiKey', action: 'set', value: PLANTED }] };
        const refused = await h.api(cookie, 'POST', '/operations', { kind: 'config.set', input });
        expect(refused.status).toBe(409);
        expect(refused.json.error.code).toBe('ENV_CONTROLLED');
        expect(refused.json.error.details).toMatchObject({ id: 'ai.openai.apiKey', envName: 'OPENAI_API_KEY' });
        const forced = await h.api(cookie, 'POST', '/operations', { kind: 'config.set', input: { ...input, force: true } });
        expect(forced.status).toBe(400);
        expect(h.texts.join('\n')).not.toContain(PLANTED_ENV);
        expect(h.texts.join('\n')).not.toContain(PLANTED);
        expect(await auditRows('host.config.apply')).toEqual([]);
    });

    test('defaults.set is applied and audited with field ids only', async () => {
        const h = await harness();
        const cookie = await operatorCookie(h);
        const report = (await h.api(cookie, 'GET', '/config')).json;
        expect(report.defaults).toEqual({ revision: expect.any(Number) });
        const preview = await h.api(cookie, 'POST', '/operations', {
            kind: 'defaults.set',
            input: { expectedRevision: report.defaults.revision, changes: [{ id: 'defaults.appearance.theme', action: 'set', value: 'light' }] }
        });
        expect(preview.status).toBe(200);
        const applied = await h.api(cookie, 'POST', `/operations/${preview.json.operation.id}/apply`, {});
        expect(applied.status).toBe(200);
        const rows = await auditRows('host.defaults.apply');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor: OPERATOR, target: preview.json.operation.id });
        expect(rows[0].detail).toEqual({ fields: [{ id: 'defaults.appearance.theme', action: 'set' }] });
        expect(fieldOf((await h.api(cookie, 'GET', '/config')).json, 'defaults.appearance.theme')).toMatchObject({ value: 'light', source: 'db' });
    });

    test('the probe answers a whitelisted outcome and writes no audit row', async () => {
        const seen = [];
        const h = await harness({ probe: async (target, options) => { seen.push([target, Object.keys(options || {})]); return { target, ok: false, code: 'UNREACHABLE', latencyMs: 3, detail: 'No answer.', whatItDoes: 'Calls /api/tags.', secretLeak: PLANTED }; } });
        const cookie = await operatorCookie(h);
        const res = await h.api(cookie, 'POST', '/config/probe', { target: 'ollama', useSaved: true });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ target: 'ollama', ok: false, code: 'UNREACHABLE' });
        expect(res.json).not.toHaveProperty('secretLeak');
        expect(seen).toHaveLength(1);
        const typed = await h.api(cookie, 'POST', '/config/probe', { target: 'openai', credential: PLANTED });
        expect(typed.status).toBe(200);
        expect(typed.text).not.toContain(PLANTED);
        expect(await db.all('SELECT action FROM operator_audit')).toEqual([]);
        const unknown = await h.api(cookie, 'POST', '/config/probe', { target: 'nope' });
        expect(unknown.status).toBe(400);
        expect(unknown.json.error.code).toBe('UNKNOWN_TARGET');
    });
});

describe('the manager\'s 409 codes pass through with their own code', () => {
    test('REVISION_CONFLICT: the stale tab loses and nothing is audited for it', async () => {
        const h = await harness();
        writeFeatures(h, everythingInstalled({ tavern: { active: true }, music: { active: true } }), 1);
        const cookie = await operatorCookie(h);
        const stale = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { tavern: false }, expectedRevision: 1 } });
        const fresh = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { music: false }, expectedRevision: 1 } });
        expect((await h.api(cookie, 'POST', `/operations/${fresh.json.operation.id}/apply`, {})).status).toBe(200);

        const lost = await h.api(cookie, 'POST', `/operations/${stale.json.operation.id}/apply`, {});
        expect(lost.status).toBe(409);
        expect(lost.json.error.code).toBe('REVISION_CONFLICT');
        const again = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { tavern: false }, expectedRevision: 1 } });
        expect(again.status).toBe(409);
        expect(again.json.error.code).toBe('REVISION_CONFLICT');
        expect(again.json.error.details).toMatchObject({ expected: 1, actual: 2 });
        expect((await auditRows('host.features.apply')).map(row => row.target)).toEqual([fresh.json.operation.id]);
    });

    test('DEPENDENCY_CONFLICT and FEATURE_NOT_INSTALLED', async () => {
        const h = await harness();
        writeFeatures(h, everythingInstalled({ gba: { installed: false } }), 1);
        const cookie = await operatorCookie(h);
        const dependency = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { exchange: true } } });
        expect(dependency.status).toBe(409);
        expect(dependency.json.error.code).toBe('DEPENDENCY_CONFLICT');
        const missing = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { gba: true } } });
        expect(missing.status).toBe(409);
        expect(missing.json.error.code).toBe('FEATURE_NOT_INSTALLED');
        expect(missing.json.error.details).toEqual({ feature: 'gba' });
        const row = featureRow(await h.api(cookie, 'GET', '/features'), 'gba');
        expect(row.state.installed).toBe(false);
    });
});

describe('the Mail guard', () => {
    const open = { identity: { nativeLogin: true, registration: 'open' } };

    test('turning Mail off while open registration needs it is refused before the manager, naming the setting', async () => {
        const h = await harness({ config: open });
        writeFeatures(h, everythingInstalled({ mail: { active: true } }));
        const cookie = await operatorCookie(h);
        const before = h.manager.journal.readAudit().entries.length;
        const res = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { mail: false } } });
        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe('MAIL_REQUIRED_FOR_REGISTRATION');
        expect(res.json.error.details).toEqual({ setting: 'identity.registration', change: 'invite' });
        expect(res.json.error.message).toMatch(/invite/);
        expect(h.manager.journal.readAudit().entries.length).toBe(before);
        const planned = await h.managerCall('GET', '/manager/api/features');
        expect(planned.status).toBe(200);
    });

    test('with invite-only registration it goes through, and verified addresses add a warning', async () => {
        const h = await harness({ config: { identity: { nativeLogin: true, registration: 'invite' } } });
        writeFeatures(h, everythingInstalled({ mail: { active: true } }));
        const cookie = await operatorCookie(h);
        const clean = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { mail: false } } });
        expect(clean.status).toBe(200);
        expect(clean.json.preview.warnings).toEqual([]);

        await db.run(`INSERT INTO account_emails (principalId, address, normalized, verifiedAt) VALUES (@id, 'rob@example.org', 'rob@example.org', datetime('now'))`, { id: OPERATOR });
        const warned = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { mail: false } } });
        expect(warned.status).toBe(200);
        expect(warned.json.preview.warnings).toEqual([expect.objectContaining({ code: 'VERIFIED_ADDRESSES_EXIST', count: 1 })]);
        expect(warned.text).not.toContain('rob@example.org');
    });

    test('turning Mail on is never blocked', async () => {
        const h = await harness({ config: open });
        writeFeatures(h, everythingInstalled());
        const res = await h.api(await operatorCookie(h), 'POST', '/operations', { kind: 'features.set', input: { changes: { mail: true } } });
        expect(res.status).toBe(200);
    });
});

describe('Gambling on a shared instance', () => {
    const gambling = { economy: true, gambling: true };

    async function prepared(options) {
        const h = await harness(options);
        writeFeatures(h, everythingInstalled(), 1);
        return h;
    }

    test('one account, one guild: not shared, no attestation asked, and none recorded', async () => {
        const h = await prepared();
        const cookie = await operatorCookie(h);
        expect(featureRow(await h.api(cookie, 'GET', '/features'), 'gambling')).toBeTruthy();
        expect((await h.api(cookie, 'GET', '/features')).json.shared).toMatchObject({ shared: false, reasons: [], activeAccounts: 1, guilds: 1 });
        const res = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: gambling } });
        expect(res.status).toBe(200);
        expect(res.json.attestation).toBeNull();
        const applied = await h.api(cookie, 'POST', `/operations/${res.json.operation.id}/apply`, {});
        expect(applied.status).toBe(200);
        const [row] = await auditRows('host.features.apply');
        expect(row.detail).not.toHaveProperty('attested');
    });

    test('a second signed-in account makes it shared: refused without the attestation, planned and audited with it', async () => {
        const h = await prepared();
        const cookie = await operatorCookie(h);
        await signIn(h.request, SECOND, 'Alex');
        expect((await h.api(cookie, 'GET', '/features')).json.shared).toMatchObject({ shared: true, reasons: ['MULTIPLE_ACTIVE_ACCOUNTS'], activeAccounts: 2 });

        const refused = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: gambling } });
        expect(refused.status).toBe(409);
        expect(refused.json.error.code).toBe('ATTESTATION_REQUIRED');
        expect(refused.json.error.details.reasons).toEqual(['MULTIPLE_ACTIVE_ACCOUNTS']);
        const declined = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: gambling, attestation: { confirmed: false } } });
        expect(declined.json.error.code).toBe('ATTESTATION_REQUIRED');
        const malformed = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: gambling, attestation: { confirmed: true, text: 'x' } } });
        expect(malformed.json.error.code).toBe('INVALID_INPUT');
        expect(h.manager.journal.readAudit().entries.filter(entry => entry.action === 'manager.features.set')).toEqual([]);

        const attested = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: gambling, attestation: { confirmed: true } } });
        expect(attested.status).toBe(200);
        expect(attested.json.attestation).toMatchObject({ by: OPERATOR, text: host.GAMBLING_ATTESTATION_TEXT, at: expect.any(String) });
        expect(attested.json.operation.plan.attestation).toEqual(attested.json.attestation);
        const applied = await h.api(cookie, 'POST', `/operations/${attested.json.operation.id}/apply`, {});
        expect(applied.status).toBe(200);
        const [row] = await auditRows('host.features.apply');
        expect(row).toMatchObject({ actor: OPERATOR, target: attested.json.operation.id });
        expect(row.detail).toMatchObject({ features: { economy: true, gambling: true }, attested: true });
        expect(JSON.stringify(row)).not.toContain('private');
    });

    test('a second guild also makes it shared', async () => {
        const h = await prepared({ guildIds: ['900000000000000001', '900000000000000002'] });
        const cookie = await operatorCookie(h);
        const verdict = (await h.api(cookie, 'GET', '/features')).json.shared;
        expect(verdict).toMatchObject({ shared: true, reasons: ['MULTIPLE_GUILDS'], guilds: 2, activeAccounts: 1 });
        const refused = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: gambling } });
        expect(refused.json.error.code).toBe('ATTESTATION_REQUIRED');
        expect(refused.json.error.details.reasons).toEqual(['MULTIPLE_GUILDS']);
    });

    test('guilds the operator shares with the bot count, a suspended account does not', async () => {
        const h = await prepared();
        const cookie = await operatorCookie(h);
        await signIn(h.request, SECOND, 'Alex', 'member');
        await db.run(`UPDATE app_accounts SET status = 'disabled' WHERE principalId = @id`, { id: SECOND });
        expect((await h.api(cookie, 'GET', '/features')).json.shared.shared).toBe(false);
        const original = h.ctx.gateway.listMutualGuilds;
        h.ctx.gateway.listMutualGuilds = async () => [{ id: '900000000000000009' }];
        expect((await h.api(cookie, 'GET', '/features')).json.shared).toMatchObject({ shared: true, reasons: ['MULTIPLE_GUILDS'] });
        h.ctx.gateway.listMutualGuilds = async () => { throw new Error('bot offline'); };
        expect((await h.api(cookie, 'GET', '/features')).json.shared.shared).toBe(false);
        h.ctx.gateway.listMutualGuilds = original;
    });

    test('an apply that no attested preview preceded is refused again on a shared instance', async () => {
        const h = await prepared();
        const cookie = await operatorCookie(h);
        const planned = await h.managerCall('POST', '/manager/api/operations', { kind: 'features.set', input: { changes: gambling } });
        expect(planned.status).toBe(200);
        const id = planned.body.operation.id;
        expect((await h.managerCall('POST', `/manager/api/operations/${id}/validate`)).status).toBe(200);
        await signIn(h.request, SECOND, 'Alex');
        const refused = await h.api(cookie, 'POST', `/operations/${id}/apply`, {});
        expect(refused.status).toBe(409);
        expect(refused.json.error.code).toBe('ATTESTATION_REQUIRED');
        expect(JSON.parse(fs.readFileSync(h.settings.featuresPath, 'utf8')).features.gambling).toEqual({ installed: true, active: false });
        expect(await auditRows('host.features.apply')).toEqual([]);
    });

    test('turning Gambling off or leaving it alone never asks', async () => {
        const h = await harness({ guildIds: ['900000000000000001', '900000000000000002'] });
        writeFeatures(h, everythingInstalled({ economy: { active: true }, gambling: { active: true } }), 1);
        const res = await h.api(await operatorCookie(h), 'POST', '/operations', { kind: 'features.set', input: { changes: { gambling: false } } });
        expect(res.status).toBe(200);
        expect(res.json.attestation).toBeNull();
    });
});

describe('the restart controls', () => {
    test('schedule, restart now, cancel, and the lifecycle model, each audited by the operation', async () => {
        const h = await harness({ supervise: true });
        writeFeatures(h, everythingInstalled({ tavern: { active: true } }), 1);
        const cookie = await operatorCookie(h);

        const idle = await h.api(cookie, 'GET', '/lifecycle');
        expect(idle.status).toBe(200);
        expect(idle.json).toMatchObject({ supervising: true, current: 0, pending: null });
        expect(idle.json.workers).toEqual([expect.objectContaining({ name: 'api', state: 'running', ackedRevision: 0 })]);
        expect(idle.text).not.toContain(h.root);
        const nothing = await h.api(cookie, 'POST', '/lifecycle/restart-now', {});
        expect(nothing.status).toBe(409);
        expect(nothing.json.error.code).toBe('NOTHING_PENDING');
        expect(await auditRows('host.lifecycle.restart_now')).toEqual([]);

        const change = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { tavern: false } } });
        const changeId = change.json.operation.id;
        await h.api(cookie, 'POST', `/operations/${changeId}/apply`, {});

        const schedule = await h.api(cookie, 'POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: changeId, graceSeconds: 30 } });
        expect(schedule.status).toBe(200);
        const scheduled = await h.api(cookie, 'POST', `/operations/${schedule.json.operation.id}/apply`, {});
        expect(scheduled.status).toBe(200);
        const [scheduleRow] = await auditRows('host.lifecycle.apply');
        expect(scheduleRow).toMatchObject({ actor: OPERATOR, target: schedule.json.operation.id });
        expect(scheduleRow.detail).toMatchObject({ changeRef: changeId, graceSeconds: 30 });

        const counting = await h.api(cookie, 'GET', '/lifecycle');
        expect(counting.json.pending).toMatchObject({ phase: 'countdown', changeRef: changeId });
        expect(counting.json.pending.secondsLeft).toBeGreaterThan(0);

        const cancelled = await h.api(cookie, 'POST', '/lifecycle/cancel', {});
        expect(cancelled.status).toBe(200);
        expect((await h.api(cookie, 'GET', '/lifecycle')).json.pending).toBeNull();
        expect(await auditRows('host.lifecycle.cancel')).toHaveLength(1);

        const again = await h.api(cookie, 'POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: changeId, graceSeconds: 30 } });
        await h.api(cookie, 'POST', `/operations/${again.json.operation.id}/apply`, {});
        const now = await h.api(cookie, 'POST', '/lifecycle/restart-now', {});
        expect(now.status).toBe(200);
        await waitFor(async () => (await h.api(cookie, 'GET', '/lifecycle')).json.acked.api === 1, { what: 'ack of revision 1' });
        const after = await h.api(cookie, 'GET', '/lifecycle');
        expect(after.json).toMatchObject({ current: 1, pending: null, lastOutcome: { outcome: 'applied' } });
        const [nowRow] = await auditRows('host.lifecycle.restart_now');
        expect(nowRow).toMatchObject({ actor: OPERATOR, target: expect.any(String) });
        expect(nowRow.detail).toEqual({ scope: 'pending' });

        const workers = await h.api(cookie, 'POST', '/lifecycle/restart', {});
        expect(workers.status).toBe(200);
        expect((await auditRows('host.lifecycle.restart'))[0].detail).toEqual({ scope: 'workers' });
        expect(JSON.parse(fs.readFileSync(h.settings.featuresPath, 'utf8')).features.tavern).toEqual({ installed: true, active: false });
    });

    test('without supervision the model says so and a schedule is refused with the manager code', async () => {
        const h = await harness();
        writeFeatures(h, everythingInstalled({ tavern: { active: true } }), 1);
        const cookie = await operatorCookie(h);
        const model = await h.api(cookie, 'GET', '/lifecycle');
        expect(model.json).toMatchObject({ supervising: false, workers: [] });
        const change = await h.api(cookie, 'POST', '/operations', { kind: 'features.set', input: { changes: { tavern: false } } });
        await h.api(cookie, 'POST', `/operations/${change.json.operation.id}/apply`, {});
        const refused = await h.api(cookie, 'POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: change.json.operation.id } });
        expect(refused.status).toBe(409);
        expect(refused.json.error.code).toBe('NOT_SUPERVISING');
    });
});

describe('the audit vocabulary', () => {
    test('every action the proxy writes is a known operator_audit action', () => {
        for (const action of ['host.features.apply', 'host.config.apply', 'host.defaults.apply', 'host.lifecycle.apply',
            'host.lifecycle.restart_now', 'host.lifecycle.cancel', 'host.lifecycle.restart', 'host.install.apply']) {
            expect(operatorAudit.ACTIONS).toContain(action);
        }
    });
});

describe('the installation journeys (#330)', () => {
    async function installed() {
        const h = await harness({ install: true });
        const release = makeRelease(newRoot());
        const { engine } = h.manager;
        const local = { principal: 'local:cli', via: 'local' };
        const planned = await engine.plan('install.new', { source: release.dir, features: ['tavern'], layout: 'standalone', registerService: false, release: { allowUnsigned: true } }, local, { internal: true });
        await engine.validate(planned.id, local);
        await engine.apply(planned.id, { revision: null }, local);
        const cookie = await operatorCookie(h);
        return { h, release, cookie };
    }

    const sourceInput = (release, extra = {}) => ({ source: release.dir, release: { allowUnsigned: true }, ...extra });

    test('suggest, record and source answer an operator and a member learns nothing', async () => {
        const { h, release, cookie } = await installed();
        const suggest = await h.api(cookie, 'GET', '/install/suggest');
        expect(suggest.status).toBe(200);
        expect(suggest.json.roots.code.fixed).toBe(false);
        expect(suggest.json.database.engines.find(entry => entry.engine === 'postgres').available).toBe(false);
        const record = await h.api(cookie, 'GET', '/install/record');
        expect(record.json).toMatchObject({ installed: true, record: { layout: 'standalone', release: { features: ['core', 'tavern'] } } });
        const source = await h.api(cookie, 'GET', `/install/source?dir=${encodeURIComponent(release.dir)}`);
        expect(source.status).toBe(200);
        expect(source.json.features.map(feature => feature.id)).toContain('tavern');
        const bad = await h.api(cookie, 'GET', '/install/source');
        expect(bad.status).toBe(400);
        const member = await signIn(h.request, MEMBER, 'Sam');
        for (const route of ['/install/suggest', '/install/record']) expect((await h.api(member, 'GET', route)).status).toBe(403);
    });

    test('repair through the proxy: preview writes nothing, apply is audited as host.install.apply with names only', async () => {
        const { h, release, cookie } = await installed();
        const before = (await auditRows('host.install.apply')).length;
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'install.repair', input: sourceInput(release) });
        expect(preview.status).toBe(200);
        expect(preview.json.operation).toMatchObject({ kind: 'install.repair', status: 'validated' });
        expect((await auditRows('host.install.apply')).length).toBe(before);

        const id = preview.json.operation.id;
        const applied = await h.api(cookie, 'POST', `/operations/${id}/apply`, {});
        expect(applied.status).toBe(200);
        expect(applied.json.operation.status).toBe('applied');
        const rows = await auditRows('host.install.apply');
        expect(rows).toHaveLength(before + 1);
        const row = rows[rows.length - 1];
        expect(row.target).toBe(id);
        expect(row.actor).toBe(OPERATOR);
        expect(row.detail).toMatchObject({ operation: 'repair', layout: 'standalone', features: ['core', 'tavern'] });
        expect(JSON.stringify(row.detail)).not.toContain(h.root);
        expect(JSON.stringify(row.detail)).not.toContain(release.dir);

        const read = await h.api(cookie, 'GET', `/operations/${id}`);
        expect(read.status).toBe(200);
        expect(read.json.operation).toMatchObject({ id, kind: 'install.repair', status: 'applied' });
        const missing = await h.api(cookie, 'GET', '/operations/abcdef123456');
        expect(missing.status).toBeGreaterThanOrEqual(400);
    });

    test('reconfigure: a secret is typed once, never returns, and the audit row names the field only', async () => {
        const { h, cookie } = await installed();
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'install.reconfigure', input: { config: [{ id: 'ai.openai.apiKey', value: PLANTED }, { id: 'ollama.model', value: 'llama3.2:1b' }] } });
        expect(preview.status).toBe(200);
        expect(preview.text).not.toContain(PLANTED);
        const id = preview.json.operation.id;
        const applied = await h.api(cookie, 'POST', `/operations/${id}/apply`, {});
        expect(applied.status).toBe(200);
        const rows = await auditRows('host.install.apply');
        expect(rows[0].detail).toMatchObject({ operation: 'reconfigure' });
        expect(rows[0].detail.fields).toEqual(expect.arrayContaining(['ai.openai.apiKey', 'ollama.model']));
        expect(JSON.stringify(rows)).not.toContain(PLANTED);
        for (const text of h.texts) expect(text).not.toContain(PLANTED);
        expect(fs.readFileSync(h.settings.configPath, 'utf8')).toContain(PLANTED);
    });

    test('a root outside the allowed bases is refused for the portal, with the manager\'s own finding', async () => {
        const { h, cookie } = await installed();
        const elsewhere = path.join(os.tmpdir(), `elsewhere-${crypto.randomBytes(3).toString('hex')}`, 'goobster');
        const preview = await h.api(cookie, 'POST', '/operations', { kind: 'install.reconfigure', input: { roots: { cache: elsewhere } } });
        const findings = ((preview.json.operation || {}).plan || {}).preflight;
        const codes = preview.status === 200 ? findings.findings.map(item => item.code) : [preview.json.error.code];
        expect(codes.some(code => ['ROOT_OUTSIDE_ALLOWED_BASES', 'PREFLIGHT_FAILED'].includes(code))).toBe(true);
        if (preview.status !== 200) {
            // The refusal carries the validated plan, so the page can list the findings that stopped it.
            expect(findings.findings.map(item => item.code)).toContain('ROOT_OUTSIDE_ALLOWED_BASES');
        }
        expect(fs.existsSync(elsewhere)).toBe(false);
    });

    test('uninstall keeping data: the confirmation for deleting it is the installation id, and the audit row says keepData', async () => {
        const { h, cookie } = await installed();
        const record = (await h.api(cookie, 'GET', '/install/record')).json.record;
        const refused = await h.api(cookie, 'POST', '/operations', { kind: 'install.uninstall', input: { keepData: false } });
        expect(refused.status).toBe(400);
        expect(refused.json.error.code).toMatch(/CONFIRM/);
        const wrong = await h.api(cookie, 'POST', '/operations', { kind: 'install.uninstall', input: { keepData: false, confirm: 'not-the-id' } });
        expect(wrong.status).toBe(400);
        expect(fs.existsSync(h.settings.dataDir)).toBe(true);

        const keep = await h.api(cookie, 'POST', '/operations', { kind: 'install.uninstall', input: { keepData: true } });
        expect(keep.json.operation.plan.confirmation).toEqual({ required: false, satisfied: true });
        const applied = await h.api(cookie, 'POST', `/operations/${keep.json.operation.id}/apply`, {});
        expect(applied.status).toBe(200);
        const rows = await auditRows('host.install.apply');
        expect(rows[rows.length - 1].detail).toMatchObject({ operation: 'uninstall', keepData: true });
        expect(record.installationId).toMatch(/\S/);
    });
});
