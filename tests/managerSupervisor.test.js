/**
 * The manager's supervisor (#325) against scripted fake processes: start at
 * the current revision with the ack recorded, exit 75 as an immediate
 * restart, a bounded normal stop (SIGTERM, then the forced kill) with every
 * process reaped, backoff then CRASH_LOOP, failed starts (spawn throws,
 * spawn error, exit before health), health timeout, a manager interrupted
 * mid-countdown (countdown restored; deadline honoured, expired-and-applied
 * or expired-and-cancelled; an interrupted commit re-run), a crash while a
 * change is pending (previous revision, nothing promoted), the paired
 * layout needing both acks, and never starting a second copy.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-supervisor-'));

const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createStore } = require('@goobster/manager/store/installation');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const { createLifecycleStore } = require('@goobster/manager/lifecycle/store');
const registry = require('@goobster/manager/lifecycle/registry');
const extensions = require('@goobster/manager/extensions');
const { createFeatureState } = require('@goobster/core/features/featureState');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');

const silent = { info() {}, warn() {}, error() {} };
const BRIDGE = { principal: '100000000000000001', via: 'bridge' };
const live = [];

function newRoot(name) {
    const dir = path.join(ROOT, `${name}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

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

async function fixture({ env = {}, config = { webapp: { enabled: true } }, claimed = true } = {}) {
    const root = newRoot('sup');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
    const settings = resolveSettings(envFor(root, env));
    if (claimed) {
        const store = createStore({ root: settings.storeDir });
        store.init();
        store.createInstallation({ origin: 'claim', ownerLabel: 'Rob' });
    }
    const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds });
    await manager.init();
    return { root, settings, manager };
}

function supervise(manager, fakes, { policy = {}, sandboxActive = () => false } = {}) {
    const supervisor = createSupervisor({
        manager,
        adapter: fakes.adapter,
        checkHealth: fakes.checkHealth,
        sandboxActive,
        logger: silent,
        policy: { ...FAST_POLICY, ...policy }
    });
    const unregister = registry.register(manager.settings.storeDir, supervisor);
    live.push({ supervisor, unregister, fakes });
    return supervisor;
}

async function applyFeatures(manager, changes) {
    const planned = await manager.engine.plan('features.set', { changes }, BRIDGE);
    const validated = await manager.engine.validate(planned.id, BRIDGE);
    return manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE);
}

async function applyLifecycle(manager, changeRef, extra = {}) {
    const planned = await manager.engine.plan('lifecycle.apply', { changeRef, graceSeconds: 10, ...extra }, BRIDGE);
    const validated = await manager.engine.validate(planned.id, BRIDGE);
    return manager.engine.apply(validated.id, { revision: validated.revision }, BRIDGE);
}

function setDeadline(settings, msFromNow) {
    createLifecycleStore({ storeDir: settings.storeDir }).update((doc) => {
        doc.pending.deadline = new Date(Date.now() + msFromNow).toISOString();
        return doc;
    });
}

const lifecycleDoc = settings => createLifecycleStore({ storeDir: settings.storeDir }).read().doc;
const featureStatus = settings => createFeatureState({ filePath: settings.featuresPath, env: {}, config: {} }).status();

afterEach(async () => {
    while (live.length) {
        const { supervisor, unregister, fakes } = live.pop();
        await supervisor.stop();
        unregister();
        for (const proc of fakes.alive()) proc.die(0);
    }
});

afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('starting and acknowledging', () => {
    test('standalone starts [api] at the current revision; the ack is recorded; status carries names, not env', async () => {
        const { manager, settings } = await fixture();
        const fakes = createFakeWorkers();
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).acked.api === 0, { what: 'api ack' });
        const proc = fakes.last('api');
        expect(proc.env.GOOBSTER_REVISION).toBe('0');
        expect(proc.env.GOOBSTER_FEATURES_STAGED).toBe('0');
        expect(proc.env.GOOBSTER_SUPERVISOR).toBe('manager');
        expect(proc.env.GOOBSTER_RUNTIME_MODE).toBe('standalone');
        expect(proc.env.GOOBSTER_MANAGER_PID).toBe(String(process.pid));
        const status = await supervisor.status();
        expect(status).toMatchObject({ supervising: true, layout: 'standalone', current: 0, pending: null, acked: { api: 0 } });
        expect(status.workers).toEqual([expect.objectContaining({ name: 'api', state: 'running', healthy: true, ackedRevision: 0, crashes: 0 })]);
        const text = JSON.stringify(status);
        expect(text).not.toContain(proc.env.GOOBSTER_MANAGER_ACK_TOKEN);
        expect(text).not.toContain(settings.storeDir);
        expect(text).not.toContain('apps/api');
        expect(JSON.stringify(lifecycleDoc(settings))).not.toContain(proc.env.GOOBSTER_MANAGER_ACK_TOKEN);
    });

    test('an ack from another pid (a stale file) is not accepted; the HTTP ack needs the per-start token', async () => {
        const { manager } = await fixture();
        const fakes = createFakeWorkers();
        fakes.setDefault('api', { ack: false });
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).workers[0].healthy, { what: 'healthy' });
        const proc = fakes.last('api');
        require('@goobster/core/runtime/revisionAck').writeAck({ worker: 'api', revision: 0, pid: proc.pid + 1, env: proc.env });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect((await supervisor.status()).acked.api).toBeNull();
        expect(supervisor.ack({ worker: 'api', revision: 0, pid: proc.pid, token: 'wrong-token-wrong-token' })).toBe(false);
        expect(supervisor.ack({ worker: 'api', revision: 1, pid: proc.pid, token: proc.env.GOOBSTER_MANAGER_ACK_TOKEN })).toBe(false);
        expect(supervisor.ack({ worker: 'api', revision: 0, pid: proc.pid, token: proc.env.GOOBSTER_MANAGER_ACK_TOKEN })).toBe(true);
        expect((await supervisor.status()).acked.api).toBe(0);
    });
});

describe('exits, backoff and the crash loop', () => {
    test('exit 75 from a healthy worker is an immediate restart, not a crash', async () => {
        const { manager } = await fixture();
        const fakes = createFakeWorkers();
        const supervisor = supervise(manager, fakes, { policy: { backoffMs: [5000, 5000, 5000, 5000, 5000] } });
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).acked.api === 0);
        const first = fakes.last('api');
        const before = Date.now();
        first.die(75);
        await waitFor(() => fakes.of('api').length === 2, { what: 'respawn' });
        expect(Date.now() - before).toBeLessThan(1000);
        await waitFor(async () => (await supervisor.status()).workers[0].state === 'running');
        const status = await supervisor.status();
        expect(status.workers[0]).toMatchObject({ restarts: 1, crashes: 0, crashLoop: false });
        expect(status.workers[0].lastExit).toMatchObject({ code: 75, reason: 'RESTART_REQUESTED' });
        expect(fakes.last('api').env.GOOBSTER_REVISION).toBe('0');
    });

    test('a normal stop sends SIGTERM, forces a worker that ignores it after the bound, reaps every process and restarts nothing', async () => {
        const { manager } = await fixture({
            env: { GOOBSTER_RUNTIME_MODE: 'paired', GOOBSTER_DB_URL: 'postgres://u:p@127.0.0.1:1/x', GOOBSTER_INTERNAL_TOKEN: 't'.repeat(32) },
            config: { token: 'x'.repeat(10), webapp: { enabled: true } }
        });
        const fakes = createFakeWorkers();
        fakes.setDefault('bot', { ignoreTerm: true });
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        await waitFor(async () => {
            const s = await supervisor.status();
            return s.acked.bot === 0 && s.acked.api === 0;
        }, { what: 'both acks' });
        const startedAt = Date.now();
        const result = await supervisor.stop();
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(FAST_POLICY.stopTimeoutMs - 10);
        expect(result.workers).toEqual(expect.arrayContaining([
            { name: 'bot', forced: true, timedOut: false },
            { name: 'api', forced: false, timedOut: false }
        ]));
        expect(fakes.last('bot').signals).toEqual(['SIGTERM', 'SIGKILL']);
        expect(fakes.last('api').signals).toEqual(['SIGTERM']);
        expect(fakes.alive()).toHaveLength(0);
        expect(fakes.procs.every(proc => proc.reaped)).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(fakes.procs).toHaveLength(2);
    });

    test('crashes back off [10, 20, 30, 40] ms, then CRASH_LOOP stops restarting until an operator restart', async () => {
        const { manager, settings } = await fixture();
        const fakes = createFakeWorkers();
        fakes.setDefault('api', { exitAfterMs: 15, exitCode: 1 });
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).workers[0].state === 'crash-loop', { what: 'crash loop' });
        expect(fakes.of('api')).toHaveLength(5);
        const doc = lifecycleDoc(settings);
        expect(doc.events.filter(e => e.type === 'crash').map(e => e.backoffMs)).toEqual([10, 20, 30, 40]);
        expect(doc.events.some(e => e.type === 'crash-loop' && e.code === 'CRASH_LOOP')).toBe(true);
        expect(doc.workers.api).toMatchObject({ crashLoop: true });
        expect(doc.workers.api.crashes).toHaveLength(5);
        await new Promise(resolve => setTimeout(resolve, 120));
        expect(fakes.of('api')).toHaveLength(5);
        expect((await supervisor.status()).workers[0]).toMatchObject({ state: 'crash-loop', crashLoop: true, crashes: 5 });

        fakes.setDefault('api', {});
        expect(supervisor.operatorRestart()).toEqual({ workers: ['api'], revision: 0 });
        await waitFor(async () => (await supervisor.status()).acked.api === 0 && fakes.of('api').length === 6, { what: 'operator restart' });
        expect((await supervisor.status()).workers[0]).toMatchObject({ state: 'running', crashLoop: false, crashes: 0 });
    });

    test('failed starts: start() throwing, a spawn error and an exit before health are crashes with their codes', async () => {
        const { manager, settings } = await fixture();
        const fakes = createFakeWorkers();
        fakes.behave('api', { throwOnSpawn: true }, { spawnError: true }, { readyAfterMs: 1000, exitAfterMs: 5, exitCode: 1 });
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).acked.api === 0, { what: 'the fourth start to come up' });
        const codes = lifecycleDoc(settings).events.filter(e => e.type === 'crash').map(e => e.code);
        expect(codes).toEqual(['EACCES', 'ENOENT', 'EXITED_BEFORE_HEALTHY']);
        expect(fakes.of('api')).toHaveLength(3);
        expect((await supervisor.status()).workers[0]).toMatchObject({ state: 'running', crashes: 3 });
    });

    test('a worker that never answers /health is stopped after the health timeout and counted as a crash', async () => {
        const { manager, settings } = await fixture();
        const fakes = createFakeWorkers();
        fakes.behave('api', { healthy: false });
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        await waitFor(() => fakes.of('api').length === 2, { what: 'restart after the health timeout' });
        const first = fakes.of('api')[0];
        expect(first.signals[0]).toBe('SIGTERM');
        expect(first.exit).not.toBeNull();
        expect(lifecycleDoc(settings).events.find(e => e.type === 'crash')).toMatchObject({ worker: 'api', code: 'HEALTH_TIMEOUT' });
        await waitFor(async () => (await supervisor.status()).acked.api === 0);
    });

    test('never a second copy: a health URL that already answers is a conflict, nothing is spawned', async () => {
        const { manager } = await fixture();
        const fakes = createFakeWorkers();
        const release = fakes.occupy('http://127.0.0.1:3100/health');
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        const status = await supervisor.status();
        expect(status.workers[0]).toMatchObject({ state: 'conflict', code: 'WORKER_ALREADY_RUNNING' });
        expect(fakes.procs).toHaveLength(0);
        release();
        await waitFor(async () => (await supervisor.status()).acked.api === 0, { what: 'start once the port is free' });
        expect(fakes.procs).toHaveLength(1);
    });
});

describe('the staged restart', () => {
    test('a crash while a change is pending restarts at the previous revision and promotes nothing', async () => {
        const { manager, settings } = await fixture();
        const fakes = createFakeWorkers();
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).acked.api === 0);
        const change = await applyFeatures(manager, { gambling: false });
        await applyLifecycle(manager, change.operation.id);
        expect((await supervisor.status()).pending).toMatchObject({ revision: 1, phase: 'countdown' });
        fakes.last('api').die(1);
        await waitFor(() => fakes.of('api').length === 2 && fakes.last('api').exit === null, { what: 'respawn' });
        await waitFor(async () => (await supervisor.status()).acked.api === 0);
        const respawned = fakes.last('api');
        expect(respawned.env.GOOBSTER_REVISION).toBe('0');
        expect(respawned.env.GOOBSTER_FEATURES_STAGED).toBe('0');
        const status = await supervisor.status();
        expect(status.current).toBe(0);
        expect(status.pending).toMatchObject({ revision: 1, phase: 'countdown' });
        const features = featureStatus(settings);
        expect(features.features.gambling).toMatchObject({ pending: true, pendingActive: false });
    });

    test('at the deadline: stop new work, restart at n+1 staged, health + ack, then promote features.json', async () => {
        const { manager, settings } = await fixture();
        const fakes = createFakeWorkers();
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        await waitFor(async () => (await supervisor.status()).acked.api === 0);
        const change = await applyFeatures(manager, { gambling: false });
        await applyLifecycle(manager, change.operation.id);
        setDeadline(settings, 40);
        const old = fakes.last('api');
        await waitFor(() => lifecycleDoc(settings).current === 1, { what: 'promotion' });
        expect(old.signals.slice(0, 2)).toEqual(['SIGUSR2', 'SIGTERM']);
        const fresh = fakes.last('api');
        expect(fresh.env.GOOBSTER_REVISION).toBe('1');
        expect(fresh.env.GOOBSTER_FEATURES_STAGED).toBe('1');
        const doc = lifecycleDoc(settings);
        expect(doc.pending).toBeNull();
        expect(doc.lastOutcome).toMatchObject({ revision: 1, outcome: 'applied', code: null });
        const features = featureStatus(settings);
        expect(features.features.gambling.requested).toBe(false);
        expect(features.features.gambling.pending).toBe(false);
        const raw = JSON.parse(fs.readFileSync(settings.featuresPath, 'utf8'));
        expect(raw.features.gambling).toEqual({ installed: true, active: false });
        const audit = manager.journal.readAudit().entries.map(e => [e.action, e.outcome]);
        expect(audit).toEqual([
            ['manager.features.set', 'applied'],
            ['manager.lifecycle.apply', 'applied'],
            ['manager.lifecycle.restart', 'applied']
        ]);
        expect(manager.lock.describe().held).toBe(false);
    });

    test('paired: promotion waits for both bot and api; one missing ack rolls back to the previous revision', async () => {
        const { manager, settings } = await fixture({
            env: { GOOBSTER_RUNTIME_MODE: 'paired', GOOBSTER_DB_URL: 'postgres://u:p@127.0.0.1:1/x', GOOBSTER_INTERNAL_TOKEN: 't'.repeat(32) },
            config: { token: 'x'.repeat(10), webapp: { enabled: true } }
        });
        const fakes = createFakeWorkers();
        const supervisor = supervise(manager, fakes);
        await supervisor.start();
        await waitFor(async () => {
            const s = await supervisor.status();
            return s.acked.bot === 0 && s.acked.api === 0;
        });
        const change = await applyFeatures(manager, { gambling: false });
        await applyLifecycle(manager, change.operation.id);
        fakes.behave('bot', { ack: false });
        setDeadline(settings, 20);
        await waitFor(() => lifecycleDoc(settings).lastOutcome, { what: 'outcome' });
        const doc = lifecycleDoc(settings);
        expect(doc.lastOutcome).toMatchObject({ revision: 1, outcome: 'rolled_back', code: 'ACK_TIMEOUT', worker: 'bot', previousRevisionReady: true });
        expect(doc.current).toBe(0);
        expect(doc.pending).toBeNull();
        expect(fakes.last('bot').env.GOOBSTER_REVISION).toBe('0');
        expect(fakes.last('api').env.GOOBSTER_REVISION).toBe('0');
        expect(fakes.of('api').map(p => p.env.GOOBSTER_REVISION)).toEqual(['0', '1', '0']);
        expect(featureStatus(settings).features.gambling).toMatchObject({ pending: true, pendingActive: false });
        const last = manager.journal.readAudit().entries.slice(-1)[0];
        expect(last).toMatchObject({ action: 'manager.lifecycle.restart', outcome: 'failed' });
        const record = manager.journal.read(last.operationId).record;
        expect(record).toMatchObject({ kind: 'lifecycle.restart', status: 'failed', error: { code: 'ACK_TIMEOUT' } });
    });
});

describe('a manager interrupted mid-countdown', () => {
    async function interrupted({ deadlineMs, onExpired = 'apply', phase = 'countdown' }) {
        const { manager, settings } = await fixture();
        const fakesA = createFakeWorkers();
        const first = supervise(manager, fakesA);
        await first.start();
        await waitFor(async () => (await first.status()).acked.api === 0);
        const change = await applyFeatures(manager, { gambling: false });
        const applied = await applyLifecycle(manager, change.operation.id, { onExpired });
        createLifecycleStore({ storeDir: settings.storeDir }).update((doc) => {
            doc.pending.deadline = new Date(Date.now() + deadlineMs).toISOString();
            doc.pending.phase = phase;
            return doc;
        });
        first.abandon();
        live.splice(live.findIndex(entry => entry.supervisor === first), 1);
        for (const proc of fakesA.alive()) proc.die(0);
        const before = lifecycleDoc(settings).pending;
        const again = createManager({ settings, logger: silent, extraKinds: extensions.kinds });
        await again.init();
        const fakesB = createFakeWorkers();
        const second = supervise(again, fakesB);
        return { settings, manager: again, supervisor: second, fakes: fakesB, before, applyId: applied.operation.id };
    }

    test('the countdown and pending change are restored and the deadline is honoured', async () => {
        const ctx = await interrupted({ deadlineMs: 250 });
        await ctx.supervisor.start();
        const status = await ctx.supervisor.status();
        expect(status.pending).toMatchObject({ revision: 1, operationId: ctx.applyId, deadline: ctx.before.deadline, phase: 'countdown' });
        expect(status.pending.secondsLeft).toBeGreaterThanOrEqual(0);
        expect(ctx.fakes.last('api').env.GOOBSTER_REVISION).toBe('0');
        expect(lifecycleDoc(ctx.settings).current).toBe(0);
        await waitFor(() => lifecycleDoc(ctx.settings).current === 1, { what: 'promotion at the deadline' });
        const committed = lifecycleDoc(ctx.settings).events.find(e => e.type === 'committed');
        expect(Date.parse(committed.at)).toBeGreaterThanOrEqual(Date.parse(ctx.before.deadline));
        expect(lifecycleDoc(ctx.settings).events.some(e => e.type === 'resumed')).toBe(true);
    });

    test('a deadline that passed while the manager was down is applied at once (onExpired: apply)', async () => {
        const ctx = await interrupted({ deadlineMs: -5000 });
        await ctx.supervisor.start();
        await waitFor(() => lifecycleDoc(ctx.settings).current === 1, { what: 'immediate apply' });
        expect(ctx.fakes.of('api').map(p => p.env.GOOBSTER_REVISION)).toEqual(['0', '1']);
        expect(featureStatus(ctx.settings).features.gambling.requested).toBe(false);
    });

    test('a deadline that passed is cancelled instead with onExpired: cancel; features.json keeps the pending change', async () => {
        const ctx = await interrupted({ deadlineMs: -5000, onExpired: 'cancel' });
        await ctx.supervisor.start();
        const doc = lifecycleDoc(ctx.settings);
        expect(doc.pending).toBeNull();
        expect(doc.lastOutcome).toMatchObject({ revision: 1, outcome: 'cancelled', code: 'DEADLINE_PASSED' });
        await waitFor(async () => (await ctx.supervisor.status()).acked.api === 0);
        expect(ctx.fakes.of('api').map(p => p.env.GOOBSTER_REVISION)).toEqual(['0']);
        expect(featureStatus(ctx.settings).features.gambling).toMatchObject({ pending: true });
    });

    test('a commit the manager died in is run again from the start', async () => {
        const ctx = await interrupted({ deadlineMs: -1000, phase: 'committing' });
        await ctx.supervisor.start();
        await waitFor(() => lifecycleDoc(ctx.settings).current === 1, { what: 'resumed commit' });
        expect(ctx.fakes.of('api').map(p => p.env.GOOBSTER_REVISION)).toEqual(['1']);
        expect(lifecycleDoc(ctx.settings).lastOutcome).toMatchObject({ outcome: 'applied' });
    });
});
