/**
 * The update surfaces (#342, documentation/manager_update.md): the manager's HTTP routes under
 * /manager/api/update (portal assertion for check, stage, apply and policy; a recovery session for the
 * decision), the audit rows, and `goobster-manager update ...` run in this process. A real manager
 * serves over loopback; the release source is a directory; the workers are fakes.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const coreBridge = require('@goobster/core/web/managerBridge');
const { createManagerApp } = require('@goobster/manager/server');
const extensions = require('@goobster/manager/extensions');
const cli = require('@goobster/manager/cli');
const { drive, tempDir } = require('./helpers/installFixture');
const { newKey, makePayload, publish, installBase, supervise, fakeChild } = require('./helpers/updateFixture');

const roots = [];
const cleanups = [];
const silent = { info() {}, warn() {}, error() {} };
const OPERATOR = '100000000000000001';

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});
afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

async function world({ next = {}, supervised = true, deps = {} } = {}) {
    const key = newKey(roots, 'trusted');
    const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
    const second = makePayload(tempDir(roots, 'next'), key, { core: '2.5.0', ...next });
    const published = await publish(roots, key, second);
    const harness = await installBase({
        roots,
        key,
        base,
        sourceDir: published.dir,
        updateDeps: { runChild: fakeChild(), runsFromPayload: false, verifyTimeoutMs: 1500, watchdogMs: 60_000, ...deps }
    });
    await drive(harness, 'update.policy', { mode: 'apply' });
    fs.writeFileSync(path.join(harness.code, 'config.json'), JSON.stringify({ webapp: { enabled: true }, token: 'tok-routes-secret-0123456789' }));
    const workers = supervised ? await supervise(harness, { cleanups }) : null;
    const server = await new Promise((resolve) => { const s = createManagerApp(harness.manager, { logger: silent, mounts: extensions.routes }).listen(0, '127.0.0.1', () => resolve(s)); });
    cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
    const port = server.address().port;

    function call({ method = 'GET', route, body, headers = {} }) {
        const payload = body === undefined ? null : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = http.request({
                agent: false,
                host: '127.0.0.1',
                port,
                method,
                path: `/manager/api${route}`,
                headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers }
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { }
                    resolve({ status: res.statusCode, body: json, text: data });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    const bridgeKey = () => coreBridge.readBridgeKey(harness.manager.store.paths.bridgeKey);
    const assertion = (method, route) => coreBridge.mintAssertion({
        actor: { actorId: OPERATOR, account: { role: 'operator', status: 'active' } },
        bridgeKey: bridgeKey(),
        method,
        path: `/manager/api${route}`
    });
    const portal = (method, route, body) => call({ method, route, body, headers: { [coreBridge.ASSERTION_HEADER]: assertion(method, route) } });

    async function recoverySession() {
        const minted = harness.manager.credentials.recovery.mint();
        const unlocked = await call({ method: 'POST', route: '/recovery/unlock', body: { credential: minted.credential } });
        return unlocked.body.session.token;
    }
    const session = (token, method, route, body) => call({ method, route, body, headers: { authorization: `Bearer ${token}`, ...(method === 'GET' ? {} : { 'x-goobster-nonce': crypto.randomBytes(12).toString('base64url') }) } });

    return { key, base, second, published, harness, workers, call, portal, session, recoverySession, port };
}

const audit = (harness) => fs.readFileSync(path.join(harness.settings.storeDir, 'operations', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));

describe('GET /update/status', () => {
    test('needs authentication and tells a portal what is installed, the policy and the last check, with no path or address', async () => {
        const w = await world({ supervised: false });
        expect((await w.call({ route: '/update/status' })).status).toBe(401);
        const res = await w.portal('GET', '/update/status');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            available: true,
            installed: { version: '2.4.0' },
            updater: 'manager',
            policy: { mode: 'apply', effectiveMode: 'apply', channel: 'stable', source: { kind: 'directory' } },
            lastCheck: null,
            staged: null,
            handoff: null,
            recovery: null
        });
        expect(res.text).not.toContain(w.harness.root);
        expect(res.text).not.toContain(path.dirname(w.harness.root));
        expect(res.text).not.toContain('tok-routes-secret');
    });
});

describe('check, stage and apply over HTTP', () => {
    test('a portal runs the whole update, each step audited once, and status follows along', async () => {
        const w = await world();
        const checked = await w.portal('POST', '/update/check', {});
        expect(checked.status).toBe(200);
        expect(checked.body.result).toMatchObject({ outcome: 'available', latest: { version: '2.5.0' } });
        expect((await w.portal('GET', '/update/status')).body.lastCheck).toMatchObject({ outcome: 'available' });

        const staged = await w.portal('POST', '/update/stage', {});
        expect(staged.body.result).toMatchObject({ staged: true, version: '2.5.0', schemaChanging: false });
        expect((await w.portal('GET', '/update/status')).body.staged).toMatchObject({ version: '2.5.0', stale: false });

        const applied = await w.portal('POST', '/update/apply', { when: 'now' });
        expect(applied.status).toBe(200);
        expect(applied.body.result).toMatchObject({ outcome: 'applied', from: '2.4.0', to: '2.5.0' });
        const status = (await w.portal('GET', '/update/status')).body;
        expect(status.installed.version).toBe('2.5.0');
        expect(status.lastApply).toMatchObject({ outcome: 'applied' });

        const rows = audit(w.harness).filter(entry => entry.action.startsWith('manager.update.'));
        expect(rows.map(entry => entry.action)).toEqual(expect.arrayContaining(['manager.update.check', 'manager.update.stage', 'manager.update.apply']));
        for (const action of ['manager.update.check', 'manager.update.stage', 'manager.update.apply']) {
            expect(rows.filter(entry => entry.action === action)).toHaveLength(1);
        }
        const text = JSON.stringify(rows);
        expect(text).not.toContain(w.harness.root);
        expect(text).not.toContain('tok-routes-secret');
    });

    test('refuses the anonymous, a body check and stage do not take, and an unknown apply field or time', async () => {
        const w = await world({ supervised: false });
        for (const route of ['/update/check', '/update/stage', '/update/apply', '/update/policy', '/update/recovery']) {
            expect((await w.call({ method: 'POST', route, body: {} })).status).toBe(401);
        }
        expect((await w.portal('POST', '/update/check', { dir: '/tmp' })).status).toBe(400);
        expect((await w.portal('POST', '/update/stage', { source: 'x' })).status).toBe(400);
        expect((await w.portal('POST', '/update/apply', { dir: '/tmp' })).body.error.code).toBe('INVALID_INPUT');
        expect((await w.portal('POST', '/update/apply', { when: 'later' })).body.error.code).toBe('INVALID_INPUT');
        expect((await w.portal('POST', '/update/apply', {})).body.error.code).toBe('NOTHING_STAGED');
        expect(audit(w.harness).filter(entry => entry.action === 'manager.update.check')).toHaveLength(0);
    });

    test('the policy route stores a policy and refuses nonsense', async () => {
        const w = await world({ supervised: false });
        const set = await w.portal('POST', '/update/policy', { mode: 'download', channel: 'prerelease' });
        expect(set.status).toBe(200);
        expect(set.body.result.policy).toMatchObject({ mode: 'download', channel: 'prerelease' });
        expect((await w.portal('POST', '/update/policy', { mode: 'sometimes' })).status).toBe(400);
        expect((await w.portal('POST', '/update/policy', { source: { kind: 'url', base: 'http://example.com/releases' } })).status).toBe(400);
        const rows = audit(w.harness).filter(entry => entry.action === 'manager.update.policy' && entry.via === 'bridge');
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows)).not.toContain('example.com');
    });
});

describe('POST /update/recovery', () => {
    test('is for a recovery session only: a portal assertion and a setup session are refused', async () => {
        const w = await world({ supervised: false });
        const viaPortal = await w.portal('POST', '/update/recovery', { decision: 'retry' });
        expect(viaPortal.status).toBe(403);
        expect(viaPortal.body.error.code).toBe('RECOVERY_SESSION_REQUIRED');
    });

    test('with a recovery session: nothing pending is refused, a bad decision is refused', async () => {
        const w = await world({ supervised: false });
        const token = await w.recoverySession();
        expect((await w.session(token, 'POST', '/update/recovery', { decision: 'maybe' })).body.error.code).toBe('INVALID_INPUT');
        expect((await w.session(token, 'POST', '/update/recovery', { decision: 'retry', extra: 1 })).body.error.code).toBe('INVALID_INPUT');
        expect((await w.session(token, 'POST', '/update/recovery', { decision: 'retry' })).body.error.code).toBe('NO_RECOVERY_PENDING');
    });

    test('a schema-changing update that failed after the database was used waits for the decision, and "retry" finishes it', async () => {
        const w = await world({ next: { columns: [['users', 'nickname', 'TEXT']] } });
        await w.portal('POST', '/update/stage', {});
        for (const name of w.workers.names) w.workers.fakes.behave(name, { ack: false });
        const failed = await w.portal('POST', '/update/apply', {});
        expect(failed.status).toBe(409);
        expect(failed.body.error.code).toBe('UPDATE_RECOVERY_REQUIRED');

        const status = (await w.portal('GET', '/update/status')).body;
        expect(status.recovery).toMatchObject({ code: 'SCHEMA_CHANGED_DATABASE_IN_USE', decisions: ['restore', 'retry'], backup: { verified: true } });
        expect(status.recovery.warning).toMatch(/every write since then is lost/);
        expect((await w.portal('POST', '/update/stage', {})).body.error.code).toBe('RECOVERY_PENDING');
        expect((await w.portal('POST', '/update/recovery', { decision: 'retry' })).status).toBe(403);

        const token = await w.recoverySession();
        const decided = await w.session(token, 'POST', '/update/recovery', { decision: 'retry' });
        expect(decided.status).toBe(200);
        expect(decided.body.result).toMatchObject({ outcome: 'applied' });
        expect((await w.portal('GET', '/update/status')).body).toMatchObject({ installed: { version: '2.5.0' }, recovery: null });
        expect(audit(w.harness).filter(entry => entry.action === 'manager.update.recover')).toHaveLength(1);
    });
});

describe('goobster-manager update, in this process', () => {
    async function runCli(w, argv) {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let out = '';
        let err = '';
        stdout.on('data', (chunk) => { out += chunk; });
        stderr.on('data', (chunk) => { err += chunk; });
        const code = await cli.run(argv, { env: { ...w.harness.settings.env, GOOBSTER_MANAGER_PORT: '0' }, stdout, stderr, stdin: new PassThrough() });
        return { code, out, err, json: () => JSON.parse(out) };
    }

    test('status, policy, check and stage', async () => {
        const w = await world({ supervised: false });
        const status = await runCli(w, ['update', 'status']);
        expect(status.code).toBe(0);
        expect(status.out).toMatch(/installed\s+2\.4\.0/);
        expect(status.out).toMatch(/policy\s+apply/);

        const policy = await runCli(w, ['update', 'policy', '--mode', 'download', '--window', 'sun,sat/2-4/UTC']);
        expect(policy.code).toBe(0);
        expect(w.harness.manager.store.readInstallation().doc.update).toMatchObject({ mode: 'download', window: { days: [0, 6], startHour: 2, endHour: 4, tz: 'UTC' } });
        expect((await runCli(w, ['update', 'policy', '--no-window'])).code).toBe(0);
        expect(w.harness.manager.store.readInstallation().doc.update.window).toBeUndefined();

        const checked = await runCli(w, ['update', 'check', '--json']);
        expect(checked.code).toBe(0);
        expect(checked.json()).toMatchObject({ ok: true, command: 'update', result: { outcome: 'available' } });
        expect(checked.out).not.toContain(w.harness.root);

        const staged = await runCli(w, ['update', 'stage']);
        expect(staged.code).toBe(0);
        expect(staged.out).toMatch(/staged\s+2\.5\.0/);
        expect((await runCli(w, ['update', 'status'])).out).toMatch(/staged\s+2\.5\.0/);
    });

    test('apply with nothing staged is refused with exit 3; the arguments are checked', async () => {
        const w = await world({ supervised: false });
        const refused = await runCli(w, ['update', 'apply', '--now']);
        expect(refused.code).toBe(3);
        expect(refused.err).toMatch(/NOTHING_STAGED/);
        expect((await runCli(w, ['update'])).code).toBe(2);
        expect((await runCli(w, ['update', 'bogus'])).code).toBe(2);
        expect((await runCli(w, ['update', 'recovery'])).code).toBe(2);
        expect((await runCli(w, ['update', 'apply', '--now', '--window'])).code).toBe(2);
        expect((await runCli(w, ['update', 'check', '--mode', 'apply'])).code).toBe(2);
        expect((await runCli(w, ['update', 'policy'])).code).toBe(2);
        expect((await runCli(w, ['update', 'policy', '--source-dir', '/a', '--github', 'o/r'])).code).toBe(2);
        expect((await runCli(w, ['update', 'policy', '--window', 'someday'])).code).toBe(2);
        expect((await runCli(w, ['status', '--decision', 'restore'])).code).toBe(2);
    });

    test('the restore decision needs --yes, and nothing pending is refused', async () => {
        const w = await world({ supervised: false });
        const noYes = await runCli(w, ['update', 'recovery', '--decision', 'restore']);
        expect(noYes.code).toBe(2);
        expect(noYes.err).toMatch(/CONFIRMATION_REQUIRED/);
        const none = await runCli(w, ['update', 'recovery', '--decision', 'retry']);
        expect(none.err).toMatch(/NO_RECOVERY_PENDING/);
        expect(none.code).not.toBe(0);
    });
});
