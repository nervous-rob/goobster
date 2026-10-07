/**
 * The manager side of the maintenance barrier (#334,
 * documentation/maintenance_barrier.md): the durable store and its state
 * machine, boundaries and recovery rules, failure injection at each durable
 * boundary, and `maintenance.enter` / `maintenance.release` over real HTTP
 * against a claimed manager with fake workers that acknowledge, do not
 * acknowledge, or share their health URL with an unknown process.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-maintenance-barrier-${process.pid}.sqlite`);

const { resolveSettings } = require('@goobster/manager/settings');
const { createManager } = require('@goobster/manager/manager');
const { createManagerApp } = require('@goobster/manager/server');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const extensions = require('@goobster/manager/extensions');
const { createBarrier, tune, NEXT_PHASES } = require('@goobster/manager/maintenance/barrier');
const { createMaintenanceStore, recoverOnStart, PHASES, CANCEL_SAFE_THROUGH, IRREVERSIBLE_FROM } = require('@goobster/manager/maintenance/store');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const { MANAGER_AUDIT_ACTIONS } = require('@goobster/manager/audit');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-maintenance-barrier-'));
const silent = { info() {}, warn() {}, error() {} };
const cleanups = [];
const TUNING = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 };

function newRoot(config = { webapp: { enabled: true } }) {
    const root = path.join(ROOT, crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
    return root;
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

const controlEnv = settings => ({ GOOBSTER_MANAGER_STATE_DIR: settings.storeDir });

/**
 * Stands in for the worker processes' side: watches each fake worker's
 * control file and writes the fence acknowledgement the real
 * `lifecycle.enterMaintenance` writes.
 *   ignore    never acknowledges
 *   delayMs   acknowledges after this long
 *   wrongPid  acknowledges as a different process
 */
function startResponder({ fakes, settings, names = ['api', 'bot', 'sandbox'] }) {
    const env = controlEnv(settings);
    const seen = new Map();
    const behaviour = new Map();
    const requests = [];
    const timer = setInterval(() => {
        for (const name of names) {
            const proc = fakes.last(name);
            if (!proc || proc.exit) continue;
            const control = coreLifecycle.readControl(name, { env });
            const request = control && control.request;
            if (!request || seen.get(name) === request.id) continue;
            seen.set(name, request.id);
            requests.push({ name, type: request.type, fence: request.fence ?? null });
            const b = behaviour.get(name) || {};
            if (b.ignore) continue;
            setTimeout(() => {
                const state = request.type === 'resume' ? 'resumed' : (request.type === 'maintenance' ? 'fenced' : null);
                if (!state) return;
                coreMaintenance.writeFenceAck({ worker: name, fence: request.fence, state, pid: b.wrongPid || proc.pid, env });
            }, b.delayMs || 0);
        }
    }, 5);
    timer.unref();
    cleanups.push(() => clearInterval(timer));
    return { behave: (name, value) => behaviour.set(name, value), requests };
}

async function harness({ supervise = true, ready = true, env = {}, config, prepare = () => {}, sandboxActive = false, responder = true } = {}) {
    const root = newRoot(config);
    const settings = resolveSettings(envFor(root, env));
    tune(settings.storeDir, TUNING);
    const manager = createManager({ settings, logger: silent, extraKinds: extensions.kinds });
    const booted = await manager.init();
    const app = createManagerApp(manager, { logger: silent, mounts: extensions.routes });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    const fakes = createFakeWorkers();
    prepare(fakes, settings);
    let supervisor = null;
    let unregister = () => {};
    if (supervise) {
        supervisor = createSupervisor({
            manager,
            adapter: fakes.adapter,
            checkHealth: fakes.checkHealth,
            sandboxActive: () => sandboxActive,
            logger: silent,
            policy: { ...FAST_POLICY }
        });
        unregister = registry.register(settings.storeDir, supervisor);
        await supervisor.start();
        if (ready) await waitFor(async () => (await supervisor.status()).workers.every(worker => worker.ackedRevision === 0), { what: 'worker acks' });
    }
    const fenceWorkers = responder ? startResponder({ fakes, settings }) : null;
    cleanups.push(async () => {
        tune(settings.storeDir, null);
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

    const enter = (input = {}) => operation('maintenance.enter', { reason: 'restore', timeoutSeconds: 10, ...input });
    const release = input => operation('maintenance.release', input);
    const doc = () => createMaintenanceStore({ storeDir: settings.storeDir }).read().doc;
    const bridge = { principal: 'owner-1', via: 'bridge' };

    return { root, settings, manager, supervisor, fakes, fenceWorkers, request, call, operation, enter, release, doc, bridge, port };
}

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});

afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ store */

function directBarrier({ bootId = 'boot-a', fsImpl = fs, settings = null } = {}) {
    const resolved = settings || resolveSettings(envFor(newRoot()));
    return { settings: resolved, barrier: createBarrier({ settings: resolved, fs: fsImpl, logger: silent, bootId, isProcessAlive: () => true, timing: TUNING }) };
}

const API = { name: 'api', healthUrl: 'http://127.0.0.1:9/health', external: true, pid: null, running: true, state: 'external', fenceAck: null };
const resolvedWith = (...targets) => ({ layout: 'standalone', targets, refresh: () => targets });

/** Enter through the barrier directly: begin, a worker that acknowledged, quiesce, verify. */
async function enterDirect(barrier, settings, operationId) {
    const { fence } = barrier.begin({ operationId, actor: 'owner-1', via: 'bridge', reason: 'restore' });
    coreMaintenance.writeFenceAck({ worker: 'api', fence, state: 'fenced', pid: 4242, env: controlEnv(settings) });
    const resolved = resolvedWith(API);
    const { writers, sent } = await barrier.quiesce({ operationId, fence, resolved, timeoutSeconds: 10, actor: 'owner-1' });
    const state = await barrier.verify({ operationId, fence, resolved, writers, sent, actor: 'owner-1' });
    return { fence, state };
}

describe('the maintenance store and its state machine', () => {
    test('the fence is monotonic across manager restarts, and an inactive document keeps it', async () => {
        const { settings, barrier } = directBarrier({ bootId: 'boot-a' });
        const first = await enterDirect(barrier, settings, 'op-1');
        expect(first.fence).toBe(1);
        const released = await barrier.release({ operationId: 'op-1', fence: 1, actor: 'owner-1' });
        expect(released).toMatchObject({ outcome: 'released', fence: 1 });
        expect(createMaintenanceStore({ storeDir: settings.storeDir }).read().doc).toMatchObject({ active: false, fence: 1 });

        let restarted;
        jest.isolateModules(() => {
            restarted = require('@goobster/manager/maintenance/barrier');
        });
        expect(restarted).not.toBe(require('@goobster/manager/maintenance/barrier'));
        const again = restarted.createBarrier({ settings, fs, logger: silent, bootId: 'boot-b', isProcessAlive: () => true, timing: TUNING });
        const second = await enterDirect(again, settings, 'op-2');
        expect(second.fence).toBe(2);
        expect(coreMaintenance.readStore({ env: controlEnv(settings) })).toMatchObject({ status: 'active', fence: 2, phase: 'quiesced', operationId: 'op-2' });
        await again.release({ operationId: 'op-2', fence: 2, force: true });
        expect(coreMaintenance.readStore({ env: controlEnv(settings) })).toMatchObject({ status: 'inactive', fence: 2 });
    });

    test('phases are named in order, cancel-safe through quiesce, irreversible from mutate', () => {
        expect(PHASES).toEqual(['plan', 'preflight', 'backup', 'quiesce', 'mutate', 'verify', 'cutover', 'release']);
        expect(CANCEL_SAFE_THROUGH).toBe('quiesce');
        expect(IRREVERSIBLE_FROM).toBe('mutate');
        expect(NEXT_PHASES.quiesced).toEqual(['backup', 'mutate']);
    });

    test('entering journals plan, preflight, quiesce; the cancel-safe boundary holds until mutate begins', async () => {
        const { settings, barrier } = directBarrier();
        const { state } = await enterDirect(barrier, settings, 'op-1');
        expect(state).toMatchObject({ active: true, phase: 'quiesced', boundary: 'cancel-safe', mutateBegun: false, fence: 1, operationId: 'op-1' });
        expect(state.writers.api).toMatchObject({ acked: true, pid: 4242 });
        const journal = barrier.view().journal.map(entry => [entry.phase, entry.outcome]);
        expect(journal).toEqual([['plan', 'ok'], ['preflight', 'ok'], ['quiesce', 'started'], ['quiesce', 'ok']]);

        expect(barrier.advance({ operationId: 'op-1', fence: 1, to: 'backup' })).toMatchObject({ phase: 'backup', boundary: 'cancel-safe' });
        expect(barrier.advance({ operationId: 'op-1', fence: 1, to: 'quiesced' })).toMatchObject({ phase: 'quiesced', boundary: 'cancel-safe' });
        expect(() => barrier.advance({ operationId: 'op-1', fence: 1, to: 'cutover' })).toThrow(expect.objectContaining({ code: 'PHASE_NOT_ALLOWED' }));
        expect(barrier.advance({ operationId: 'op-1', fence: 1, to: 'mutate' })).toMatchObject({ phase: 'mutate', boundary: 'irreversible' });
        expect(barrier.view()).toMatchObject({ boundary: 'irreversible', mutateBegun: true });
        expect(() => barrier.advance({ operationId: 'op-1', fence: 1, to: 'backup' })).toThrow(expect.objectContaining({ code: 'PHASE_NOT_ALLOWED' }));
        expect(() => barrier.advance({ operationId: 'op-1', fence: 2, to: 'verify' })).toThrow(expect.objectContaining({ code: 'FENCE_MISMATCH' }));
    });

    test('after mutate began, release never claims success: it needs acknowledgeMutation and ends abandoned', async () => {
        const { settings, barrier } = directBarrier();
        await enterDirect(barrier, settings, 'op-1');
        barrier.advance({ operationId: 'op-1', fence: 1, to: 'mutate' });
        await expect(barrier.release({ operationId: 'op-1', fence: 1 })).rejects.toMatchObject({ code: 'MUTATION_NOT_COMPLETE' });
        expect(barrier.view().active).toBe(true);
        const out = await barrier.release({ operationId: 'op-1', fence: 1, acknowledgeMutation: true });
        expect(out.outcome).toBe('abandoned');
        expect(barrier.view().lastOutcome).toMatchObject({ outcome: 'abandoned', fence: 1 });
    });

    test('a full run through mutate, verify and cutover ends completed', async () => {
        const { settings, barrier } = directBarrier();
        await enterDirect(barrier, settings, 'op-1');
        for (const to of ['mutate', 'verify', 'cutover']) barrier.advance({ operationId: 'op-1', fence: 1, to });
        barrier.settle({ operationId: 'op-1', fence: 1, outcome: 'ok' });
        expect((await barrier.release({ operationId: 'op-1', fence: 1 })).outcome).toBe('completed');
    });

    test('a second enter in the same manager is MAINTENANCE_ACTIVE; another manager boot makes the barrier STALE_MAINTENANCE', async () => {
        const { settings, barrier } = directBarrier({ bootId: 'boot-a' });
        await enterDirect(barrier, settings, 'op-1');
        expect(() => barrier.assertEnterable()).toThrow(expect.objectContaining({ code: 'MAINTENANCE_ACTIVE' }));
        const other = createBarrier({ settings, fs, logger: silent, bootId: 'boot-b', isProcessAlive: () => true, timing: TUNING });
        expect(() => other.assertEnterable()).toThrow(expect.objectContaining({ code: 'STALE_MAINTENANCE' }));
        expect(other.view()).toMatchObject({ active: true, stale: true });
        await expect(other.release({ operationId: 'op-1', fence: 1 })).rejects.toMatchObject({ code: 'STALE_MAINTENANCE' });
        await expect(other.release({ operationId: 'nope', fence: 1, force: true })).rejects.toMatchObject({ code: 'FENCE_MISMATCH' });
        expect(other.view().active).toBe(true);
        const forced = await other.release({ operationId: 'op-1', fence: 1, force: true, actor: 'owner-1' });
        expect(forced).toMatchObject({ outcome: 'released', forced: true });
        expect(other.view().journal.at(-1)).toMatchObject({ phase: 'release', outcome: 'released', code: 'FORCED', actor: 'owner-1' });
    });

    test('a dead owner pid makes the barrier stale even on the same boot id', async () => {
        const { settings, barrier } = directBarrier({ bootId: 'boot-a' });
        await enterDirect(barrier, settings, 'op-1');
        const dead = createBarrier({ settings, fs, logger: silent, bootId: 'boot-a', isProcessAlive: () => false });
        expect(dead.view().stale).toBe(true);
    });

    test('an unreadable maintenance.json is never overwritten and counts as active for the workers', async () => {
        const { settings, barrier } = directBarrier();
        fs.mkdirSync(settings.storeDir, { recursive: true });
        fs.writeFileSync(path.join(settings.storeDir, 'maintenance.json'), '{ not json');
        expect(() => barrier.assertEnterable()).toThrow(expect.objectContaining({ code: 'MAINTENANCE_STATE_UNREADABLE' }));
        expect(barrier.summary()).toMatchObject({ active: true, problem: 'CORRUPT' });
        expect(coreMaintenance.readStore({ env: controlEnv(settings) }).status).toBe('unreadable');
        expect(fs.readFileSync(path.join(settings.storeDir, 'maintenance.json'), 'utf8')).toBe('{ not json');
    });

    test('the journal and the state carry ids, codes and times, never a path, an argument or an environment value', async () => {
        const { settings, barrier } = directBarrier();
        await enterDirect(barrier, settings, 'op-1');
        const text = fs.readFileSync(path.join(settings.storeDir, 'maintenance.json'), 'utf8');
        expect(text).not.toContain(settings.storeDir);
        expect(text).not.toContain(settings.root);
        expect(JSON.stringify(barrier.view())).not.toContain(settings.storeDir);
    });
});

describe('recovery on manager start', () => {
    test('an active barrier is honoured as it is and a mutate phase is never resumed or advanced', async () => {
        const { settings, barrier } = directBarrier({ bootId: 'boot-a' });
        await enterDirect(barrier, settings, 'op-1');
        barrier.advance({ operationId: 'op-1', fence: 1, to: 'mutate' });

        const store = createMaintenanceStore({ storeDir: settings.storeDir });
        const options = { bootId: 'boot-b', isProcessAlive: () => true };
        const first = recoverOnStart(store, options);
        expect(first).toMatchObject({ active: true, stale: true, phase: 'mutate', fence: 1, mutateBegun: true });
        recoverOnStart(store, options);
        const recovered = store.read().doc.journal.filter(entry => entry.action === 'maintenance.recover');
        expect(recovered).toEqual([expect.objectContaining({ outcome: 'recovered', code: 'MUTATE_NOT_RESUMED', phase: 'mutate' })]);
        expect(store.read().doc).toMatchObject({ active: true, phase: 'mutate', mutateBegun: true });

        const restarted = createBarrier({ settings, fs, logger: silent, bootId: 'boot-b', isProcessAlive: () => true });
        expect(() => restarted.advance({ operationId: 'op-1', fence: 1, to: 'verify' })).toThrow(expect.objectContaining({ code: 'STALE_MAINTENANCE' }));
        expect(coreMaintenance.readStore({ env: controlEnv(settings) })).toMatchObject({ status: 'active', phase: 'mutate' });
    });

    test('an inactive store recovers to nothing', () => {
        const { settings } = directBarrier();
        expect(recoverOnStart(createMaintenanceStore({ storeDir: settings.storeDir }), { bootId: 'x' })).toMatchObject({ active: false, stale: false });
    });
});

/* -------------------------------------------------------- failure injection */

/** An fs whose maintenance.json (and control file) writes stop after `survive` of them: the manager is killed there. */
function killableFs({ survive }) {
    let writes = 0;
    let dead = false;
    const kill = () => {
        dead = true;
        const error = new Error('manager killed');
        error.code = 'EKILLED';
        throw error;
    };
    const wrapper = new Proxy(fs, {
        get(target, prop) {
            const value = target[prop];
            if (typeof value !== 'function') return value;
            if (prop === 'renameSync') {
                return (from, to) => {
                    if (dead) kill();
                    if (String(to).endsWith('maintenance.json')) {
                        writes += 1;
                        if (writes > survive) kill();
                    } else if (String(to).includes(`${path.sep}control${path.sep}`) && writes >= survive) {
                        kill();
                    }
                    return target.renameSync(from, to);
                };
            }
            return (...args) => (dead && ['openSync', 'writeSync', 'writeFileSync'].includes(prop) ? kill() : value.apply(target, args));
        }
    });
    return { fs: wrapper, writes: () => writes };
}

describe('failure injection at each durable boundary', () => {
    async function killedEnter({ survive }) {
        const settings = resolveSettings(envFor(newRoot()));
        const { fs: faulty } = killableFs({ survive });
        const barrier = createBarrier({ settings, fs: faulty, logger: silent, bootId: 'boot-a', isProcessAlive: () => true, timing: TUNING });
        let outcome = 'finished';
        try {
            await enterDirect(barrier, settings, 'op-1');
        } catch (error) {
            outcome = 'killed';
        }
        return { settings, outcome };
    }

    const restarted = settings => createBarrier({ settings, fs, logger: silent, bootId: 'boot-b', isProcessAlive: () => true, timing: TUNING });

    test('killed before the fence is persisted: nothing is active, the fence did not move, entry works', async () => {
        const { settings, outcome } = await killedEnter({ survive: 0 });
        expect(outcome).toBe('killed');
        const barrier = restarted(settings);
        expect(barrier.view()).toMatchObject({ active: false, fence: 0 });
        expect(coreMaintenance.readStore({ env: controlEnv(settings) }).status).toBe('absent');
        expect(() => barrier.assertEnterable()).not.toThrow();
    });

    test('killed after the fence and before the quiescence is recorded: the barrier stays up (stale), phase quiesce, cancel-safe; only a forced release lifts it', async () => {
        const { settings, outcome } = await killedEnter({ survive: 1 });
        expect(outcome).toBe('killed');
        const barrier = restarted(settings);
        expect(barrier.view()).toMatchObject({ active: true, stale: true, phase: 'quiesce', fence: 1, boundary: 'cancel-safe', mutateBegun: false });
        expect(coreMaintenance.readStore({ env: controlEnv(settings) })).toMatchObject({ status: 'active', fence: 1, phase: 'quiesce' });
        expect(() => barrier.assertEnterable()).toThrow(expect.objectContaining({ code: 'STALE_MAINTENANCE' }));
        await expect(barrier.release({ operationId: 'op-1', fence: 1 })).rejects.toMatchObject({ code: 'STALE_MAINTENANCE' });
        await barrier.release({ operationId: 'op-1', fence: 1, force: true });
        expect(barrier.view()).toMatchObject({ active: false, fence: 1 });
        expect(() => barrier.assertEnterable()).not.toThrow();
    });

    test('killed after the quiescence is recorded: quiesced, stale, honoured', async () => {
        const { settings, outcome } = await killedEnter({ survive: 99 });
        expect(outcome).toBe('finished');
        const barrier = restarted(settings);
        expect(barrier.view()).toMatchObject({ active: true, stale: true, phase: 'quiesced', fence: 1 });
        expect(barrier.view().writers.api).toMatchObject({ acked: true });
    });

    test('killed while releasing: the release write is atomic, the barrier is still up; after the write, the barrier is down and the fence kept', async () => {
        const settings = resolveSettings(envFor(newRoot()));
        const live = createBarrier({ settings, fs, logger: silent, bootId: 'boot-a', isProcessAlive: () => true, timing: TUNING });
        await enterDirect(live, settings, 'op-1');

        const before = killableFs({ survive: 0 });
        const killedBefore = createBarrier({ settings, fs: before.fs, logger: silent, bootId: 'boot-a', isProcessAlive: () => true, timing: TUNING });
        await expect(killedBefore.release({ operationId: 'op-1', fence: 1 })).rejects.toMatchObject({ code: 'EKILLED' });
        expect(restarted(settings).view()).toMatchObject({ active: true, phase: 'quiesced', fence: 1 });

        const after = killableFs({ survive: 1 });
        const killedAfter = createBarrier({ settings, fs: after.fs, logger: silent, bootId: 'boot-a', isProcessAlive: () => true, timing: TUNING });
        const out = await killedAfter.release({ operationId: 'op-1', fence: 1 });
        expect(out.outcome).toBe('released');
        const barrier = restarted(settings);
        expect(barrier.view()).toMatchObject({ active: false, fence: 1, lastOutcome: { outcome: 'released' } });
        expect(coreMaintenance.readStore({ env: controlEnv(settings) })).toMatchObject({ status: 'inactive', fence: 1 });
        const next = barrier.begin({ operationId: 'op-2' });
        expect(next.fence).toBe(2);
    });

    test('control files that cannot be written refuse the entry and leave nothing active', async () => {
        const settings = resolveSettings(envFor(newRoot()));
        const blocked = new Proxy(fs, {
            get(target, prop) {
                if (prop === 'renameSync') {
                    return (from, to) => {
                        if (String(to).includes(`${path.sep}control${path.sep}`)) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
                        return target.renameSync(from, to);
                    };
                }
                const value = target[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        const barrier = createBarrier({ settings, fs: blocked, logger: silent, bootId: 'boot-a', isProcessAlive: () => true, timing: TUNING });
        const { fence } = barrier.begin({ operationId: 'op-1' });
        await expect(barrier.quiesce({ operationId: 'op-1', fence, resolved: resolvedWith(API), timeoutSeconds: 10 }))
            .rejects.toMatchObject({ code: 'CONTROL_WRITE_FAILED' });
        expect(barrier.view()).toMatchObject({ active: false, fence: 1, lastOutcome: { outcome: 'refused', code: 'CONTROL_WRITE_FAILED' } });
    });
});

/* ------------------------------------------------------------------- HTTP */

describe('maintenance.enter and maintenance.release over HTTP', () => {
    test('every writer acknowledges: { operationId, fence }, quiesced, cancel-safe, audited, reads need a session', async () => {
        const h = await harness();
        expect((await h.request({ reqPath: '/manager/api/maintenance' })).status).toBe(401);
        expect((await h.call('GET', '/maintenance')).body).toMatchObject({ active: false, fence: 0, stale: false });

        const entered = await h.enter();
        expect(entered.status).toBe(200);
        expect(entered.body.result).toMatchObject({ fence: 1, phase: 'quiesced', boundary: 'cancel-safe', writers: ['api'] });
        expect(typeof entered.body.result.operationId).toBe('string');
        expect(entered.body.result.operationId).toBe(entered.body.operation.id);

        const state = await h.call('GET', '/maintenance');
        expect(state.body).toMatchObject({ active: true, phase: 'quiesced', fence: 1, stale: false, boundary: 'cancel-safe', operationId: entered.body.result.operationId });
        expect(state.body.writers.api).toMatchObject({ acked: true, pid: h.fakes.last('api').pid });
        expect(state.text).not.toContain(h.settings.storeDir);
        expect(h.fenceWorkers.requests).toContainEqual({ name: 'api', type: 'maintenance', fence: 1 });
        expect(h.manager.journal.readAudit().entries.map(entry => [entry.action, entry.outcome]).at(-1)).toEqual(['manager.maintenance.enter', 'applied']);
        const steps = entered.body.operation.steps.map(step => step.name);
        expect(steps).toEqual(expect.arrayContaining(['preflight', 'fence', 'quiesce', 'verify']));
    });

    test('GET /status reports the barrier from the store alone while the application database is unreachable', async () => {
        const h = await harness();
        fs.mkdirSync(path.dirname(h.settings.sqlitePath), { recursive: true });
        fs.writeFileSync(h.settings.sqlitePath, 'this is not a database');
        await h.enter();
        const status = await h.request({ reqPath: '/manager/api/status' });
        expect(status.status).toBe(200);
        expect(status.body.appDatabase).toMatchObject({ reachable: false, reason: 'SQLITE_CORRUPT' });
        expect(status.body.maintenance).toMatchObject({ active: true, phase: 'quiesced', fence: 1, stale: false });
        expect(typeof status.body.maintenance.since).toBe('string');
        expect(status.body.state).toBe('claimed');
        expect(fs.readFileSync(h.settings.sqlitePath, 'utf8')).toBe('this is not a database');
        const idle = await createManager({ settings: resolveSettings(envFor(newRoot())), logger: silent }).status();
        expect(idle.maintenance).toMatchObject({ active: false, phase: null, fence: 0, since: null });
    });

    test('the manager defers its own audit reconciliation while the barrier is up', async () => {
        const h = await harness();
        await h.enter();
        const deferred = await h.manager.reconcile();
        expect(deferred).toMatchObject({ deferred: true, reason: 'MAINTENANCE_ACTIVE' });
        expect(h.manager.journal.readAudit().entries.every(entry => entry.reconciledAt === null)).toBe(true);
    });

    test('a second enter is 409 MAINTENANCE_ACTIVE and lifecycle.apply is refused while the barrier is up', async () => {
        const h = await harness();
        const change = await h.operation('features.set', { changes: { gambling: false } });
        expect((await h.enter()).status).toBe(200);
        const again = await h.call('POST', '/operations', { kind: 'maintenance.enter', input: { reason: 'restore' } });
        expect(again.status).toBe(409);
        expect(again.body.error.code).toBe('MAINTENANCE_ACTIVE');
        const restart = await h.call('POST', '/operations', { kind: 'lifecycle.apply', input: { changeRef: change.body.operation.id } });
        expect(restart.status).toBe(409);
        expect(restart.body.error.code).toBe('MAINTENANCE_ACTIVE');
    });

    test('a pending staged restart refuses entry: RESTART_PENDING', async () => {
        const h = await harness();
        const change = await h.operation('features.set', { changes: { gambling: false } });
        expect((await h.operation('lifecycle.apply', { changeRef: change.body.operation.id, graceSeconds: 600 })).status).toBe(200);
        const refused = await h.call('POST', '/operations', { kind: 'maintenance.enter', input: { reason: 'restore' } });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('RESTART_PENDING');
        expect(h.doc().active).toBe(false);
    });

    test('release needs the matching fence; it resumes the writers and does not touch the paused flag; the next entry has fence 2', async () => {
        const h = await harness();
        const entered = await h.enter();
        const { operationId } = entered.body.result;
        const wrong = await h.release({ operationId, fence: 7 });
        expect(wrong.status).toBe(409);
        expect(wrong.body.error.code).toBe('FENCE_MISMATCH');
        expect(h.doc().active).toBe(true);

        const released = await h.release({ operationId, fence: 1 });
        expect(released.status).toBe(200);
        expect(released.body.result).toMatchObject({ outcome: 'released', fence: 1, forced: false, resumed: ['api'], unconfirmed: [] });
        expect(h.doc()).toMatchObject({ active: false, fence: 1, phase: null, lastOutcome: { outcome: 'released', fence: 1 } });
        expect(h.fenceWorkers.requests).toContainEqual({ name: 'api', type: 'resume', fence: 1 });
        expect(coreMaintenance.readFenceAck('api', { env: controlEnv(h.settings) })).toMatchObject({ fence: 1, state: 'resumed' });
        expect(fs.existsSync(h.settings.sqlitePath)).toBe(false);
        const audit = h.manager.journal.readAudit().entries.map(entry => entry.action);
        expect(audit.slice(-2)).toEqual(['manager.maintenance.enter', 'manager.maintenance.release']);

        const second = await h.enter();
        expect(second.body.result.fence).toBe(2);
        const gone = await h.release({ operationId, fence: 1 });
        expect(gone.status).toBe(409);
        expect(gone.body.error.code).toBe('FENCE_MISMATCH');
    });

    test('a writer that does not acknowledge refuses the entry: WRITER_UNACKNOWLEDGED, nothing active, writers told to resume', async () => {
        const h = await harness();
        h.fenceWorkers.behave('api', { ignore: true });
        const refused = await h.enter();
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('WRITER_UNACKNOWLEDGED');
        expect(refused.body.error.details.writers).toEqual(['api']);
        expect(h.doc()).toMatchObject({ active: false, fence: 1, phase: null, lastOutcome: { outcome: 'refused', code: 'WRITER_UNACKNOWLEDGED', fence: 1 } });
        expect(h.doc().journal.at(-1)).toMatchObject({ phase: 'quiesce', outcome: 'refused', code: 'WRITER_UNACKNOWLEDGED' });
        expect(coreLifecycle.readControl('api', { env: controlEnv(h.settings) }).request).toMatchObject({ type: 'resume', fence: 1 });
        expect(coreMaintenance.readStore({ env: controlEnv(h.settings) }).status).toBe('inactive');
        const audit = h.manager.journal.readAudit().entries.at(-1);
        expect([audit.action, audit.outcome]).toEqual(['manager.maintenance.enter', 'failed']);

        h.fenceWorkers.behave('api', {});
        const retry = await h.enter();
        expect(retry.status).toBe(200);
        expect(retry.body.result.fence).toBe(2);
    });

    test('an acknowledgement from a different process than the one the manager started does not count', async () => {
        const h = await harness();
        h.fenceWorkers.behave('api', { wrongPid: 999999 });
        const refused = await h.enter();
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('WRITER_UNACKNOWLEDGED');
        expect(h.doc().active).toBe(false);
    });

    test('an unknown process answering a worker\'s health URL refuses the entry before anything is fenced: UNKNOWN_WRITER', async () => {
        const h = await harness({
            ready: false,
            prepare: (fakes) => { fakes.occupy('http://127.0.0.1:3100/health'); }
        });
        await waitFor(async () => (await h.supervisor.status()).workers[0].state === 'conflict', { what: 'conflict' });
        const refused = await h.enter();
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('UNKNOWN_WRITER');
        expect(refused.body.error.details.writers).toEqual(['api']);
        expect(h.doc()).toMatchObject({ active: false, fence: 0, lastOutcome: { outcome: 'refused', code: 'UNKNOWN_WRITER' } });
        expect(h.fenceWorkers.requests).toEqual([]);
    });

    test('without a supervisor an external worker that answers health and never acknowledges is WRITER_UNACKNOWLEDGED; one that is down is not a writer', async () => {
        const answering = await new Promise((resolve) => {
            const s = http.createServer((req, res) => { res.statusCode = 200; res.end('ok'); }).listen(0, '127.0.0.1', () => resolve(s));
        });
        cleanups.push(() => new Promise(resolve => answering.close(() => resolve())));
        const h = await harness({ supervise: false, env: { GOOBSTER_API_PORT: String(answering.address().port) }, responder: false });
        const refused = await h.enter();
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('WRITER_UNACKNOWLEDGED');
        expect(h.doc().active).toBe(false);

        await new Promise(resolve => answering.close(() => resolve()));
        const free = await h.enter();
        expect(free.status).toBe(200);
        expect(free.body.result.writers).toEqual(['api']);
        expect(h.doc().writers.api).toMatchObject({ acked: true, note: 'not-running' });
    });

    test('an external worker acknowledging through its control file is fenced without a supervisor, with the pid it reported', async () => {
        const answering = await new Promise((resolve) => {
            const s = http.createServer((req, res) => { res.statusCode = 200; res.end('ok'); }).listen(0, '127.0.0.1', () => resolve(s));
        });
        cleanups.push(() => new Promise(resolve => answering.close(() => resolve())));
        const h = await harness({ supervise: false, responder: false, env: { GOOBSTER_API_PORT: String(answering.address().port) } });
        const env = controlEnv(h.settings);
        const timer = setInterval(() => {
            const control = coreLifecycle.readControl('api', { env });
            if (control && control.request && control.request.type === 'maintenance') {
                coreMaintenance.writeFenceAck({ worker: 'api', fence: control.request.fence, state: 'fenced', pid: 5150, env });
            }
        }, 5);
        cleanups.push(() => clearInterval(timer));
        const entered = await h.enter();
        expect(entered.status).toBe(200);
        expect(h.doc().writers.api).toMatchObject({ acked: true, pid: 5150 });
        expect(h.doc().writers.api.note).toBeUndefined();
    });

    test('a layout that cannot be resolved refuses entry: LAYOUT_UNRESOLVED', async () => {
        const h = await harness({ supervise: false, config: { webapp: { enabled: false } } });
        const refused = await h.enter();
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('LAYOUT_UNRESOLVED');
        expect(h.doc().active).toBe(false);
    });

    test('a writer the manager cannot reach (a remote sandbox runner) refuses entry: WRITER_UNFENCEABLE', async () => {
        const h = await harness({ supervise: false, env: { GOOBSTER_SANDBOX_URL: 'http://sandbox.internal:3200' } });
        const idle = await h.enter();
        expect(idle.status).toBe(200);
        await h.release({ operationId: idle.body.result.operationId, fence: 1 });
        expect((await h.operation('features.set', { changes: { sandbox: true } })).status).toBe(200);
        const raw = JSON.parse(fs.readFileSync(h.settings.featuresPath, 'utf8'));
        raw.features.sandbox = { installed: true, active: true };
        fs.writeFileSync(h.settings.featuresPath, JSON.stringify(raw));
        const refusedUnknown = await h.enter();
        expect(refusedUnknown.status).toBe(409);
        expect(refusedUnknown.body.error.code).toBe('WRITER_UNFENCEABLE');
        expect(refusedUnknown.body.error.details.writers).toEqual(['sandbox']);
        expect(h.doc()).toMatchObject({ active: false, fence: 1, lastOutcome: { outcome: 'refused', code: 'WRITER_UNFENCEABLE' } });
    });

    test('two concurrent enters: exactly one wins, the other is refused, the fence moved once', async () => {
        const h = await harness();
        h.fenceWorkers.behave('api', { delayMs: 120 });
        const results = await Promise.all([h.enter(), h.enter()]);
        const winners = results.filter(result => result.status === 200);
        const losers = results.filter(result => result.status !== 200);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0].status).toBe(409);
        expect(['OPERATION_IN_PROGRESS', 'MAINTENANCE_ACTIVE', 'REVISION_CONFLICT']).toContain(losers[0].body.error.code);
        expect(h.doc()).toMatchObject({ active: true, fence: 1, operationId: winners[0].body.result.operationId });
        expect(h.fenceWorkers.requests.filter(request => request.type === 'maintenance')).toHaveLength(1);
    });

    test('with several writers (bot, sandbox) one silent writer refuses the whole entry and every writer that was asked is told to resume', async () => {
        const h = await harness({
            env: { GOOBSTER_RUNTIME_MODE: 'lite', GOOBSTER_INTERNAL_TOKEN: 'internal-token-value', GOOBSTER_SANDBOX_URL: 'http://127.0.0.1:3299' },
            config: { token: 'discord-token-value', webapp: { enabled: true } },
            sandboxActive: true
        });
        expect((await h.supervisor.status()).workers.map(worker => worker.name).sort()).toEqual(['bot', 'sandbox']);
        h.fenceWorkers.behave('bot', { ignore: true });
        const refused = await h.enter();
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('WRITER_UNACKNOWLEDGED');
        expect(refused.body.error.details.writers).toEqual(['bot']);
        for (const name of ['bot', 'sandbox']) {
            expect(coreLifecycle.readControl(name, { env: controlEnv(h.settings) }).request).toMatchObject({ type: 'resume', fence: 1 });
        }
        h.fenceWorkers.behave('bot', {});
        const ok = await h.enter();
        expect(ok.status).toBe(200);
        expect(ok.body.result.writers.sort()).toEqual(['bot', 'sandbox']);
    });

    test('a stale barrier refuses enter and a plain release; force needs an operator (bridge or recovery), not a setup session, and is audited forced', async () => {
        const h = await harness();
        const store = createMaintenanceStore({ storeDir: h.settings.storeDir });
        store.update((doc) => {
            doc.fence = 4;
            doc.active = true;
            doc.operationId = 'left-by-another-manager';
            doc.phase = 'mutate';
            doc.mutateBegun = true;
            doc.enteredAt = new Date().toISOString();
            doc.owner = { pid: 1, bootId: 'an-earlier-manager' };
            return doc;
        });
        expect((await h.call('GET', '/maintenance')).body).toMatchObject({ active: true, stale: true, phase: 'mutate', boundary: 'irreversible' });
        const refused = await h.call('POST', '/operations', { kind: 'maintenance.enter', input: { reason: 'restore' } });
        expect(refused.body.error.code).toBe('STALE_MAINTENANCE');
        const input = { operationId: 'left-by-another-manager', fence: 4 };
        const plain = await h.call('POST', '/operations', { kind: 'maintenance.release', input });
        expect(plain.body.error.code).toBe('STALE_MAINTENANCE');
        const viaSetup = await h.release({ ...input, force: true, acknowledgeMutation: true });
        expect(viaSetup.status).toBe(403);
        expect(viaSetup.body.error.code).toBe('FORCE_REQUIRES_OPERATOR');
        expect(h.doc().active).toBe(true);

        const noAck = await h.manager.engine.run('maintenance.release', { ...input, force: true }, h.bridge).catch(error => error);
        expect(noAck.code).toBe('MUTATION_NOT_COMPLETE');
        const forced = await h.manager.engine.run('maintenance.release', { ...input, force: true, acknowledgeMutation: true }, h.bridge);
        expect(forced.result).toMatchObject({ outcome: 'abandoned', forced: true });
        expect(h.doc()).toMatchObject({ active: false, fence: 4, lastOutcome: { outcome: 'abandoned', forced: true } });
        const audit = h.manager.journal.readAudit().entries.at(-1);
        expect(audit).toMatchObject({ action: 'manager.maintenance.release', actor: 'owner-1', outcome: 'applied', forced: true, via: 'bridge' });
    });

    test('inputs are checked: unknown fields, bad reason, out-of-range timeout, bad fence', async () => {
        const h = await harness();
        const cases = [
            { kind: 'maintenance.enter', input: {} },
            { kind: 'maintenance.enter', input: { reason: 'restore', extra: 1 } },
            { kind: 'maintenance.enter', input: { reason: '../etc/passwd' } },
            { kind: 'maintenance.enter', input: { reason: 'restore', timeoutSeconds: 5 } },
            { kind: 'maintenance.enter', input: { reason: 'restore', timeoutSeconds: 601 } },
            { kind: 'maintenance.release', input: { operationId: 'x', fence: 0 } },
            { kind: 'maintenance.release', input: { operationId: 'x', fence: 1, force: 'yes' } }
        ];
        for (const body of cases) {
            const res = await h.call('POST', '/operations', body);
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('INVALID_INPUT');
        }
        const conflict = await h.call('POST', '/operations', { kind: 'maintenance.enter', input: { reason: 'restore', expectedRevision: 99 } });
        expect(conflict.body.error.code).toBe('REVISION_CONFLICT');
        const none = await h.call('POST', '/operations', { kind: 'maintenance.release', input: { operationId: 'x', fence: 1 } });
        expect(none.body.error.code).toBe('MAINTENANCE_NOT_ACTIVE');
    });

    test('POST /maintenance/ack takes loopback acknowledgements with the per-start token only', async () => {
        const h = await harness();
        const proc = h.fakes.last('api');
        const body = { worker: 'api', fence: 3, state: 'fenced', pid: proc.pid };
        const refused = await h.request({ method: 'POST', reqPath: '/manager/api/maintenance/ack', body, headers: { 'x-goobster-ack-token': 'wrong' } });
        expect(refused.status).toBe(403);
        expect(refused.body.error.code).toBe('ACK_REFUSED');
        const accepted = await h.request({
            method: 'POST', reqPath: '/manager/api/maintenance/ack', body, headers: { 'x-goobster-ack-token': proc.env.GOOBSTER_MANAGER_ACK_TOKEN }
        });
        expect(accepted.status).toBe(200);
        expect(accepted.body).toMatchObject({ acknowledged: true, worker: 'api', fence: 3 });
        expect(h.supervisor.fenceTargets().workers[0].fenceAck).toMatchObject({ fence: 3, state: 'fenced', pid: proc.pid });
        const bad = await h.request({ method: 'POST', reqPath: '/manager/api/maintenance/ack', body: { worker: 'api', fence: 'x' } });
        expect(bad.status).toBe(400);
    });

    test('the audit actions exist in the manager and in the operator ledger', () => {
        for (const action of ['manager.maintenance.enter', 'manager.maintenance.release']) {
            expect(MANAGER_AUDIT_ACTIONS).toContain(action);
            expect(operatorAudit.ACTIONS.has(action)).toBe(true);
        }
    });
});
