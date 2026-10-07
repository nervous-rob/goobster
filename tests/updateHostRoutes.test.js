/**
 * The Host room's update proxies (#342, documentation/manager_update.md): `GET /host/update/status` and the
 * `update.check|stage|apply|policy` kinds behind `POST /host/operations`, authorization (anonymous 401, a
 * member 403, nothing journaled or audited), and the `host.update.apply` audit rows, which carry versions,
 * outcomes and flags and never a source, a path or an address.
 *
 * A real manager serves over loopback with the extension routes, the portal is the real router with devMode
 * sessions and the real bridge key, the release source is a directory and the workers are fakes. Runs on
 * SQLite and on an isolated Postgres schema.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-update-host-'));
if (!process.env.GOOBSTER_DB_URL) process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'app.sqlite');

const db = require('@goobster/core/db');
const identityService = require('@goobster/core/services/identityService');
const eventBusService = require('@goobster/core/services/eventBusService');
const coreBridge = require('@goobster/core/web/managerBridge');
const { createFeatureState } = require('@goobster/core/features/featureState');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const { createHostManagerClient } = require('@goobster/core/web/hostManagerClient');
const host = require('@goobster/core/web/routes/host');
const { createManagerApp } = require('@goobster/manager/server');
const extensions = require('@goobster/manager/extensions');
const { tempDir } = require('./helpers/installFixture');
const { newKey, makePayload, publish, installBase, supervise, fakeChild } = require('./helpers/updateFixture');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const OPERATOR = '100000000000000001';
const MEMBER = '100000000000000003';
const BASE = host.BASE;
const TOKEN_MARK = 'update-host-token-never-appears-4d1e';
const TABLES = ['operator_audit', 'account_emails', 'web_sessions', 'auth_identities', 'app_accounts', 'principals', 'users'];
const roots = [];
const cleanups = [];

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const closeServer = (server) => new Promise(resolve => server.close(() => resolve()));

async function world() {
    const key = newKey(roots, 'trusted');
    const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
    const second = makePayload(tempDir(roots, 'next'), key, { core: '2.5.0' });
    const published = await publish(roots, key, second);
    const harness = await installBase({
        roots,
        key,
        base,
        sourceDir: published.dir,
        updateDeps: { runChild: fakeChild(), runsFromPayload: false, verifyTimeoutMs: 1500, watchdogMs: 60_000 }
    });
    fs.writeFileSync(path.join(harness.code, 'config.json'), JSON.stringify({ webapp: { enabled: true }, token: TOKEN_MARK }));
    await supervise(harness, { cleanups });

    const managerServer = await listen(createManagerApp(harness.manager, { logger: silent, mounts: extensions.routes }));
    cleanups.push(() => closeServer(managerServer));
    const managerPort = managerServer.address().port;
    const bridge = coreBridge.createManagerBridge({ keyFile: harness.manager.store.paths.bridgeKey });
    const client = createHostManagerClient({ baseUrl: () => `http://127.0.0.1:${managerPort}`, bridge });
    const gateway = { sendDm: async () => ({}), sendToChannel: async () => ({}), listMutualGuilds: async () => [] };
    const ctx = createWebAppContext({
        gateway,
        config: { clientId: '123', guildIds: ['900000000000000001'], webapp: { enabled: true, devMode: true } },
        logger: silent,
        deps: { hostManager: client, features: createFeatureState({ filePath: harness.settings.featuresPath, env: {}, config: {} }) }
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
    return { harness, request, api, texts };
}

async function signIn(request, userId, name, role) {
    await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: name });
    if (role) await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role });
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session=')).split(';')[0];
}

async function auditRows() {
    const rows = await db.all("SELECT action, actor, target, detailJson FROM operator_audit WHERE action = 'host.update.apply' ORDER BY id");
    return rows.map(row => ({ ...row, detail: row.detailJson ? JSON.parse(row.detailJson) : null }));
}

async function run(h, cookie, kind, input) {
    const created = await h.api(cookie, 'POST', '/operations', { kind, input });
    expect(created.status).toBe(200);
    const id = created.json.operation.id;
    const applied = await h.api(cookie, 'POST', `/operations/${id}/apply`, {});
    return { created, applied };
}

beforeAll(async () => { await db.get('SELECT 1 AS ok'); });
beforeEach(async () => { for (const table of TABLES) await db.run(`DELETE FROM ${table}`); });
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
afterAll(async () => {
    await eventBusService.close();
    await db.closeConnection();
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('authorization', () => {
    test('anonymous callers get 401 and members 403 on the update routes; nothing is journaled or audited', async () => {
        const h = await world();
        const member = await signIn(h.request, MEMBER, 'Sam');
        const before = h.harness.manager.journal.list().length;
        for (const [method, route, body] of [
            ['GET', '/update/status'],
            ['POST', '/operations', { kind: 'update.check', input: {} }],
            ['POST', '/operations', { kind: 'update.apply', input: { when: 'now' } }]
        ]) {
            expect([route, (await h.api(null, method, route, body)).status]).toEqual([route, 401]);
            const denied = await h.api(member, method, route, body);
            expect([route, denied.status]).toEqual([route, 403]);
            expect(denied.text).not.toMatch(/manager|127\.0\.0\.1|bridge/i);
        }
        expect(h.harness.manager.journal.list().length).toBe(before);
        expect(await auditRows()).toEqual([]);
    }, 60000);
});

describe('the update through the portal', () => {
    test('status, check, stage and apply run end to end; each mutation writes one audit row with versions and flags only', async () => {
        const h = await world();
        const cookie = await signIn(h.request, OPERATOR, 'Rob', 'operator');

        const status = await h.api(cookie, 'GET', '/update/status');
        expect(status.status).toBe(200);
        expect(status.json).toMatchObject({ installed: { version: '2.4.0' }, updater: 'manager', staged: null, recovery: null });

        const policy = await run(h, cookie, 'update.policy', { mode: 'apply' });
        expect(policy.applied.status).toBe(200);
        const check = await run(h, cookie, 'update.check', {});
        expect(check.applied.json.result).toMatchObject({ outcome: 'available', latest: { version: '2.5.0' } });
        const stage = await run(h, cookie, 'update.stage', {});
        expect(stage.applied.json.result).toMatchObject({ staged: true, version: '2.5.0' });
        const apply = await run(h, cookie, 'update.apply', { when: 'now' });
        expect(apply.applied.status).toBe(200);
        expect(apply.applied.json.result).toMatchObject({ outcome: 'applied', from: '2.4.0', to: '2.5.0' });

        const after = await h.api(cookie, 'GET', '/update/status');
        expect(after.json.installed.version).toBe('2.5.0');

        const rows = await auditRows();
        expect(rows.map(row => row.detail.operation)).toEqual(['policy', 'check', 'stage', 'apply']);
        expect(rows[3].detail).toMatchObject({ outcome: 'applied', fromVersion: '2.4.0', toVersion: '2.5.0', schemaChanging: false });
        expect(rows.every(row => row.actor === OPERATOR)).toBe(true);

        const everything = JSON.stringify(rows) + h.texts.join('\n');
        expect(everything).not.toContain(TOKEN_MARK);
        expect(everything).not.toContain(h.harness.root);
        expect(everything).not.toContain(path.dirname(h.harness.root));
    }, 120000);
});
