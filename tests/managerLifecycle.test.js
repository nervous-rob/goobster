/**
 * The staged-restart API (#325, documentation/manager_lifecycle.md) over
 * real HTTP on loopback with fake workers: GET /lifecycle, lifecycle.apply
 * through the operations API (countdown, restart-now, promotion only after
 * health and acks), cancel before commitment and 409 ALREADY_COMMITTED
 * after, the loopback ack route, the refusals, the config.set seam (#324:
 * restartRequired, NO_PREVIOUS_CONFIG, a restored previous config), the
 * Inbox notice on the suite's database engine, and /status `lifecycle`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-manager-lifecycle-${process.pid}.sqlite`);

const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const { createLifecycleStore } = require('@goobster/manager/lifecycle/store');
const registry = require('@goobster/manager/lifecycle/registry');
const notice = require('@goobster/manager/lifecycle/notice');
const extensions = require('@goobster/manager/extensions');
const { main } = require('@goobster/manager');
const { createFeatureState } = require('@goobster/core/features/featureState');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-manager-lifecycle-'));
const silent = { info() {}, warn() {}, error() {} };
const cleanups = [];

function envFor(root, extra = {}) {
    return {
        GOOBSTER_DATA_DIR: path.join(root, 'data'),
        GOOBSTER_CONFIG_PATH: path.join(root, 'config.json'),
        GOOBSTER_MANAGER_PORT: '0',
        GOOBSTER_MANAGER_RECONCILE: '0',
        GOOBSTER_RUNTIME_MODE: 'standalone',
        ...extra
    };
}

function newRoot(config = { webapp: { enabled: true } }) {
    const root = path.join(ROOT, crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
    return root;
}

async function harness({ supervise = true, policy = {}, prepare = () => {} } = {}) {
    const root = newRoot();
    const settings = resolveSettings(envFor(root));
    const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds });
    const booted = await manager.init();
    const app = createManagerApp(manager, { logger: silent, mounts: extensions.routes });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    const fakes = createFakeWorkers();
    prepare(fakes);
    let supervisor = null;
    let unregister = () => {};
    if (supervise) {
        supervisor = createSupervisor({
            manager,
            adapter: fakes.adapter,
            checkHealth: fakes.checkHealth,
            sandboxActive: () => false,
            logger: silent,
            policy: { ...FAST_POLICY, ...policy }
        });
        unregister = registry.register(settings.storeDir, supervisor);
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).acked.api === 0, { what: 'api ack' });
    }
    cleanups.push(async () => {
        if (supervisor) await supervisor.stop();
        unregister();
        for (const proc of fakes.alive()) proc.die(0);
        await new Promise(resolve => server.close(() => resolve()));
    });

    function request({ method = 'GET', reqPath, body, headers = {} }) {
        const payload = body !== undefined ? JSON.stringify(body) : null;
        return new Promise((resolve, reject) => {
            const req = http.request({
                agent: false,
                host: '127.0.0.1',
                port,
                method,
                path: reqPath,
                headers: {
                    host: `127.0.0.1:${port}`,
                    ...(payload !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                    ...headers
                }
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
            if (payload !== null) req.write(payload);
            req.end();
        });
    }

    const claimed = await request({ method: 'POST', reqPath: '/manager/api/claim', body: { credential: booted.bootstrap.credential, label: 'Rob' } });
    const token = claimed.body.session.token;
    const auth = () => ({ authorization: `Bearer ${token}`, 'x-goobster-nonce': crypto.randomBytes(12).toString('base64url') });
    const call = (method, reqPath, body) => request({ method, reqPath: `/manager/api${reqPath}`, body, headers: method === 'GET' ? { authorization: `Bearer ${token}` } : auth() });

    async function operation(kind, input) {
        const planned = await call('POST', '/operations', { kind, input });
        if (planned.status !== 200) return planned;
        const validated = await call('POST', `/operations/${planned.body.operation.id}/validate`, {});
        if (validated.status !== 200) return validated;
        return call('POST', `/operations/${planned.body.operation.id}/apply`, { revision: validated.body.operation.revision });
    }

    return { root, settings, manager, supervisor, fakes, request, call, operation, port };
}

const lifecycleDoc = settings => createLifecycleStore({ storeDir: settings.storeDir }).read().doc;
const featureStatus = settings => createFeatureState({ filePath: settings.featuresPath, env: {}, config: {} }).status();

function appliedConfigChange(manager, plan) {
    const record = manager.journal.create({ kind: 'config.set', actor: 'local:setup', via: 'setup', plan });
    return manager.journal.update(record.id, next => ({ ...next, status: 'applied' })).id;
}

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});

afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('GET /manager/api/lifecycle', () => {
    test('needs a session; reports workers, health and acks without env values or paths', async () => {
        const h = await harness();
        expect((await h.request({ reqPath: '/manager/api/lifecycle' })).status).toBe(401);
        const res = await h.call('GET', '/lifecycle');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ supervising: true, layout: 'standalone', current: 0, pending: null, acked: { api: 0 } });
        expect(res.body.workers).toEqual([expect.objectContaining({ name: 'api', state: 'running', healthy: true, ackedRevision: 0 })]);
        expect(res.text).not.toContain(h.settings.storeDir);
        expect(res.text).not.toContain(h.fakes.last('api').env.GOOBSTER_MANAGER_ACK_TOKEN);
    });

    test('without supervision: the stored state, supervising false, and lifecycle.apply refuses NOT_SUPERVISING', async () => {
        const h = await harness({ supervise: false });
        const res = await h.call('GET', '/lifecycle');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ supervising: false, layout: null, current: 0, pending: null, workers: [] });
        const change = await h.operation('features.set', { changes: { gambling: false } });
        expect(change.status).toBe(200);
        const refused = await h.call('POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: change.body.operation.id } });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('NOT_SUPERVISING');
    });
});

describe('lifecycle.apply end to end', () => {
    test('countdown, restart-now, n+1 healthy and acked, features.json promoted, audited', async () => {
        const h = await harness();
        const change = await h.operation('features.set', { changes: { gambling: false } });
        expect(change.status).toBe(200);
        expect(featureStatus(h.settings).features.gambling).toMatchObject({ pending: true, pendingActive: false });

        const applied = await h.operation('lifecycle.apply', { changeRef: change.body.operation.id, graceSeconds: 10 });
        expect(applied.status).toBe(200);
        expect(applied.body.result).toMatchObject({ revision: 1, graceSeconds: 10, notice: 'RECONCILE_DISABLED' });
        const counting = await h.call('GET', '/lifecycle');
        expect(counting.body.pending).toMatchObject({ revision: 1, phase: 'countdown', graceSeconds: 10 });
        expect(counting.body.pending.secondsLeft).toBeGreaterThan(0);
        expect(counting.body.pending.secondsLeft).toBeLessThanOrEqual(10);
        expect(fs.existsSync(path.join(h.settings.storeDir, 'lifecycle', 'staged-features.json'))).toBe(true);

        const now = await h.call('POST', '/lifecycle/restart-now', {});
        expect(now.status).toBe(200);
        await waitFor(() => lifecycleDoc(h.settings).current === 1, { what: 'promotion' });
        await waitFor(async () => (await h.call('GET', '/lifecycle')).body.acked.api === 1, { what: 'ack of 1' });
        expect(h.fakes.last('api').env).toMatchObject({ GOOBSTER_REVISION: '1', GOOBSTER_FEATURES_STAGED: '1' });
        const raw = JSON.parse(fs.readFileSync(h.settings.featuresPath, 'utf8'));
        expect(raw.features.gambling).toEqual({ installed: true, active: false });
        const after = await h.call('GET', '/lifecycle');
        expect(after.body).toMatchObject({ current: 1, pending: null, lastOutcome: { revision: 1, outcome: 'applied' } });

        const audit = h.manager.journal.readAudit().entries
            .filter(entry => entry.action !== 'manager.claim')
            .map(entry => [entry.action, entry.outcome]);
        expect(audit).toEqual([
            ['manager.features.set', 'applied'],
            ['manager.lifecycle.apply', 'applied'],
            ['manager.lifecycle.restart', 'applied'],
            ['manager.lifecycle.restart', 'applied']
        ]);
        const text = JSON.stringify(h.manager.journal.readAudit().entries);
        expect(text).not.toContain(h.settings.storeDir);
        expect(text).not.toContain(h.fakes.last('api').env.GOOBSTER_MANAGER_ACK_TOKEN);
    });

    test('cancel before commitment clears pending and leaves features.json pending; twice is NOTHING_PENDING', async () => {
        const h = await harness();
        const change = await h.operation('features.set', { changes: { gambling: false } });
        await h.operation('lifecycle.apply', { changeRef: change.body.operation.id, graceSeconds: 600 });
        const cancelled = await h.call('POST', '/lifecycle/cancel', {});
        expect(cancelled.status).toBe(200);
        expect(cancelled.body.result).toMatchObject({ revision: 1 });
        expect(lifecycleDoc(h.settings)).toMatchObject({ current: 0, pending: null, lastOutcome: { outcome: 'cancelled', code: 'CANCELLED' } });
        expect(featureStatus(h.settings).features.gambling).toMatchObject({ pending: true, pendingActive: false });
        expect(h.fakes.of('api')).toHaveLength(1);
        const again = await h.call('POST', '/lifecycle/cancel', {});
        expect(again.status).toBe(409);
        expect(again.body.error.code).toBe('NOTHING_PENDING');
        expect(h.manager.journal.readAudit().entries.map(entry => entry.action)).toContain('manager.lifecycle.cancel');
        const body = await h.call('POST', '/lifecycle/cancel', { now: true });
        expect(body.status).toBe(400);
    });

    test('after the stop-new-work signal: cancel and restart-now are 409 ALREADY_COMMITTED', async () => {
        const h = await harness({ policy: { healthTimeoutMs: 3000, readyTimeoutMs: 3000 } });
        h.fakes.behave('api', { readyAfterMs: 600 });
        const change = await h.operation('features.set', { changes: { gambling: false } });
        await h.operation('lifecycle.apply', { changeRef: change.body.operation.id, graceSeconds: 10 });
        expect((await h.call('POST', '/lifecycle/restart-now', {})).status).toBe(200);
        await waitFor(() => lifecycleDoc(h.settings).pending?.phase === 'committing', { what: 'committing' });
        const cancel = await h.call('POST', '/lifecycle/cancel', {});
        expect(cancel.status).toBe(409);
        expect(cancel.body.error.code).toBe('ALREADY_COMMITTED');
        const now = await h.call('POST', '/lifecycle/restart-now', {});
        expect(now.status).toBe(409);
        expect(now.body.error.code).toBe('ALREADY_COMMITTED');
        await waitFor(() => lifecycleDoc(h.settings).current === 1, { what: 'promotion', timeoutMs: 5000 });
    });

    test('a new worker that never becomes healthy rolls back: previous revision, features.json untouched, failed with a code', async () => {
        const h = await harness();
        h.fakes.behave('api', { healthy: false });
        const change = await h.operation('features.set', { changes: { gambling: false } });
        await h.operation('lifecycle.apply', { changeRef: change.body.operation.id, graceSeconds: 10 });
        await h.call('POST', '/lifecycle/restart-now', {});
        await waitFor(() => lifecycleDoc(h.settings).lastOutcome?.outcome === 'rolled_back', { what: 'rollback', timeoutMs: 5000 });
        expect(lifecycleDoc(h.settings)).toMatchObject({ current: 0, pending: null, lastOutcome: { revision: 1, code: 'HEALTH_TIMEOUT', worker: 'api' } });
        await waitFor(async () => (await h.call('GET', '/lifecycle')).body.acked.api === 0, { what: 'revision 0 back' });
        expect(h.fakes.last('api').env.GOOBSTER_REVISION).toBe('0');
        expect(featureStatus(h.settings).features.gambling).toMatchObject({ pending: true, pendingActive: false });
        const audit = h.manager.journal.readAudit().entries.map(entry => [entry.action, entry.outcome]);
        expect(audit.at(-1)).toEqual(['manager.lifecycle.restart', 'failed']);
    });
});

describe('refusals', () => {
    test('bad input, unknown or unapplied change, nothing pending, a second apply while one is pending', async () => {
        const h = await harness();
        const bad = await h.call('POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: 'x', graceSeconds: 5 } });
        expect([bad.status, bad.body.error.code]).toEqual([400, 'INVALID_INPUT']);
        const unknown = await h.call('POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: crypto.randomUUID() } });
        expect([unknown.status, unknown.body.error.code]).toEqual([404, 'CHANGE_NOT_FOUND']);

        const planned = await h.call('POST', '/operations', { kind: 'features.set', input: { changes: { gambling: false } } });
        const notApplied = await h.call('POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: planned.body.operation.id } });
        expect([notApplied.status, notApplied.body.error.code]).toEqual([409, 'CHANGE_NOT_APPLIED']);

        const noop = await h.operation('features.set', { changes: { gambling: true } });
        expect(noop.status).toBe(200);
        const nothing = await h.call('POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: noop.body.operation.id } });
        expect([nothing.status, nothing.body.error.code]).toEqual([409, 'NOTHING_PENDING']);

        const change = await h.operation('features.set', { changes: { gambling: false } });
        expect((await h.operation('lifecycle.apply', { changeRef: change.body.operation.id, graceSeconds: 600 })).status).toBe(200);
        const second = await h.call('POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: change.body.operation.id } });
        expect([second.status, second.body.error.code]).toEqual([409, 'RESTART_PENDING']);
        const internal = await h.call('POST', '/operations', { kind: 'lifecycle.cancel' });
        expect(internal.status).toBe(400);
    });

    test('a corrupt lifecycle.json is never overwritten: apply refuses LIFECYCLE_STATE_UNREADABLE', async () => {
        const h = await harness();
        const change = await h.operation('features.set', { changes: { gambling: false } });
        const file = path.join(h.settings.storeDir, 'lifecycle.json');
        fs.writeFileSync(file, '{ broken');
        const refused = await h.call('POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: change.body.operation.id } });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('LIFECYCLE_STATE_UNREADABLE');
        expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
    });
});

describe('the config.set seam (#324)', () => {
    test('a config change needs restartRequired; without the previous-config file a rollback reports NO_PREVIOUS_CONFIG', async () => {
        const h = await harness();
        const plain = appliedConfigChange(h.manager, { target: 'config', keys: ['ai.provider'] });
        const refused = await h.call('POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: plain } });
        expect([refused.status, refused.body.error.code]).toEqual([409, 'NO_RESTART_REQUIRED']);

        const restart = appliedConfigChange(h.manager, { target: 'config', keys: ['ai.provider'], restartRequired: true });
        h.fakes.behave('api', { healthy: false });
        expect((await h.operation('lifecycle.apply', { changeRef: restart, graceSeconds: 10 })).status).toBe(200);
        await h.call('POST', '/lifecycle/restart-now', {});
        await waitFor(() => lifecycleDoc(h.settings).lastOutcome?.outcome === 'rolled_back', { what: 'rollback', timeoutMs: 5000 });
        expect(lifecycleDoc(h.settings).lastOutcome).toMatchObject({ configRecovery: 'NO_PREVIOUS_CONFIG' });
        expect(JSON.parse(fs.readFileSync(h.settings.configPath, 'utf8'))).toEqual({ webapp: { enabled: true } });
    });

    test('with the previous-config file beside the journal, a rollback restores it', async () => {
        const h = await harness();
        const restart = appliedConfigChange(h.manager, { target: 'config', keys: ['webapp.devMode'], restartRequired: true });
        fs.writeFileSync(path.join(h.manager.store.paths.operations, `${restart}.previous-config.json`), JSON.stringify({ webapp: { enabled: true, devMode: false } }));
        fs.writeFileSync(h.settings.configPath, JSON.stringify({ webapp: { enabled: true, devMode: true } }));
        h.fakes.behave('api', { healthy: false });
        await h.operation('lifecycle.apply', { changeRef: restart, graceSeconds: 10 });
        await h.call('POST', '/lifecycle/restart-now', {});
        await waitFor(() => lifecycleDoc(h.settings).lastOutcome?.outcome === 'rolled_back', { what: 'rollback', timeoutMs: 5000 });
        expect(lifecycleDoc(h.settings).lastOutcome.configRecovery).toBe('RESTORED');
        expect(JSON.parse(fs.readFileSync(h.settings.configPath, 'utf8'))).toEqual({ webapp: { enabled: true, devMode: false } });
    });
});

describe('POST /manager/api/lifecycle/ack', () => {
    test('loopback, bounded body, the per-start token and pid', async () => {
        const h = await harness();
        const proc = h.fakes.last('api');
        const ack = (body, token) => h.request({
            method: 'POST',
            reqPath: '/manager/api/lifecycle/ack',
            body,
            headers: token ? { 'x-goobster-ack-token': token } : {}
        });
        expect((await ack({ worker: 'api', revision: 0 }, proc.env.GOOBSTER_MANAGER_ACK_TOKEN)).status).toBe(400);
        expect((await ack({ worker: 'api', revision: 0, pid: proc.pid, extra: 1 }, proc.env.GOOBSTER_MANAGER_ACK_TOKEN)).status).toBe(400);
        const wrong = await ack({ worker: 'api', revision: 0, pid: proc.pid }, 'not-the-token-not-the-token');
        expect([wrong.status, wrong.body.error.code]).toEqual([403, 'ACK_REFUSED']);
        const otherPid = await ack({ worker: 'api', revision: 0, pid: proc.pid + 1 }, proc.env.GOOBSTER_MANAGER_ACK_TOKEN);
        expect(otherPid.status).toBe(403);
        const ok = await ack({ worker: 'api', revision: 0, pid: proc.pid }, proc.env.GOOBSTER_MANAGER_ACK_TOKEN);
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ acknowledged: true, worker: 'api', revision: 0 });
    });
});

describe('the Inbox notice', () => {
    const pending = { revision: 4, operationId: crypto.randomUUID(), graceSeconds: 60, deadline: '2026-10-07T12:00:00.000Z' };
    const reachable = async () => ({ reachable: true, reason: null });

    test('a portal operator gets one Inbox item through inboxService.deliver on this engine', async () => {
        const db = require('@goobster/core/db');
        const actor = '100000000000000777';
        const settings = { reconcile: true };
        const first = await notice.announce({ settings, probe: reachable, actor, pending, closeAfter: false });
        expect(first).toEqual({ delivered: true, reason: null });
        await notice.announce({ settings, probe: reachable, actor, pending, closeAfter: false });
        const rows = await db.all('SELECT kind, title, sourceType, sourceId FROM inbox_items WHERE userId = @actor', { actor });
        expect(rows).toEqual([{ kind: 'system', title: 'Goobster restarts in 60 seconds', sourceType: 'manager.lifecycle', sourceId: pending.operationId }]);
    });

    test('nobody to tell, reconcile off, or no reachable database: skipped with a reason, never thrown', async () => {
        const settings = { reconcile: true };
        expect(await notice.announce({ settings, probe: reachable, actor: 'local:setup', pending })).toEqual({ delivered: false, reason: 'NO_RECIPIENT' });
        expect(await notice.announce({ settings: { reconcile: false }, probe: reachable, actor: '1', pending })).toEqual({ delivered: false, reason: 'RECONCILE_DISABLED' });
        expect(await notice.announce({ settings, probe: async () => ({ reachable: false, reason: 'NOT_FOUND' }), actor: '1', pending }))
            .toEqual({ delivered: false, reason: 'NOT_FOUND' });
        expect(await notice.announce({ settings, probe: async () => { throw new Error('boom'); }, actor: '1', pending }))
            .toEqual({ delivered: false, reason: 'APP_DB_UNREACHABLE' });
        expect(await notice.announce({
            settings, probe: reachable, actor: '1', pending, loadDb: () => ({}), loadInbox: () => ({ deliver: async () => { throw new Error('db down'); } })
        })).toEqual({ delivered: false, reason: 'NOTICE_FAILED' });
    });
});

describe('/manager/api/status lifecycle', () => {
    test('--supervise adds { supervising, layout, workers } and stop reaps the workers; without it the shape says not supervising', async () => {
        const root = newRoot();
        const fakes = createFakeWorkers();
        const out = { write() {}, isTTY: false };
        const supervised = await main(['--supervise'], {
            env: envFor(root),
            stdout: out,
            logger: silent,
            supervisorOptions: { adapter: fakes.adapter, checkHealth: fakes.checkHealth, policy: FAST_POLICY, sandboxActive: () => false }
        });
        try {
            await waitFor(async () => (await supervised.manager.status()).lifecycle.workers[0]?.ackedRevision === 0, { what: 'ack' });
            const status = await supervised.manager.status();
            expect(status.lifecycle).toMatchObject({ supervising: true, layout: 'standalone' });
            expect(status.lifecycle.workers).toEqual([expect.objectContaining({ name: 'api', state: 'running' })]);
            expect(status.state).toBeDefined();
        } finally {
            await supervised.stop();
        }
        expect(fakes.alive()).toHaveLength(0);

        const plain = await main([], { env: envFor(newRoot()), stdout: out, logger: silent });
        try {
            expect((await plain.manager.status()).lifecycle).toEqual({ supervising: false, layout: null, workers: [] });
            expect(plain.supervisor).toBeNull();
        } finally {
            await plain.stop();
        }
    });
});
