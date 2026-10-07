/**
 * The pieces under the supervisor (#325, documentation/manager_lifecycle.md):
 * the layout rule pinned against apps/api `resolveRuntimeMode()` and core
 * `discordConfig`; the worker set per layout; `detectSupervisor`; the
 * worker side (SIGUSR2, the control file, exit 75, the orphan watch, the
 * restarting notice); revision acks (file and loopback POST); staged
 * feature adoption; the external adapter's control requests; and the real
 * child adapter against a short `node` process group (Linux only, bounded).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const layouts = require('@goobster/manager/lifecycle/layouts');
const { createChildAdapter } = require('@goobster/manager/lifecycle/adapters/child');
const { createExternalAdapter } = require('@goobster/manager/lifecycle/adapters/external');
const lifecycle = require('@goobster/core/runtime/lifecycle');
const revisionAck = require('@goobster/core/runtime/revisionAck');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-lifecycle-adapters-'));
const REPO = path.join(__dirname, '..');
const quiet = { info() {}, warn() {}, error() {} };
const linuxOnly = process.platform === 'linux' ? test : test.skip;

function dir(name) {
    const d = path.join(ROOT, `${name}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Load the real module with a given process env and repo-root config.json. */
function withAppEnv({ env, config }, fn) {
    const saved = { ...process.env };
    for (const key of ['GOOBSTER_DISCORD_ENABLED', 'GOOBSTER_RUNTIME_MODE']) delete process.env[key];
    Object.assign(process.env, env);
    try {
        let result;
        jest.isolateModules(() => {
            jest.doMock(path.join(REPO, 'config.json'), () => config, { virtual: true });
            jest.doMock('dotenv', () => ({ config: () => ({}) }));
            result = fn();
        });
        return result;
    } finally {
        process.env = saved;
    }
}

describe('the layout rule matches the apps it starts', () => {
    const envs = [{}, { GOOBSTER_DISCORD_ENABLED: '1' }, { GOOBSTER_DISCORD_ENABLED: 'off' }];
    const configs = [
        {}, { token: 'bot-token-value' }, { token: '   ' },
        { discord: { enabled: false }, token: 'bot-token-value' }, { discord: { enabled: true } }
    ];

    test('discordAdapterEnabled is core discordConfig.enabled for every env/config combination', () => {
        for (const env of envs) {
            for (const config of configs) {
                const expected = withAppEnv({ env, config }, () => require('@goobster/core/config/discordConfig').enabled);
                expect([env, config, layouts.discordAdapterEnabled({ env, config })]).toEqual([env, config, expected]);
            }
        }
    });

    test('the api worker runs the mode apps/api resolveRuntimeMode() derives from the env the manager gives it', () => {
        const settings = { root: REPO, storeDir: dir('store'), port: 3400, lan: false };
        const cases = [
            { env: { GOOBSTER_RUNTIME_MODE: 'standalone' }, config: { webapp: { enabled: true } } },
            { env: {}, config: { webapp: { enabled: true } } },
            { env: { GOOBSTER_RUNTIME_MODE: 'paired', GOOBSTER_DB_URL: 'postgres://x', GOOBSTER_INTERNAL_TOKEN: 't' }, config: { token: 'bot-token-value' } },
            { env: { GOOBSTER_DISCORD_ENABLED: '0' }, config: { token: 'bot-token-value', webapp: { enabled: true } } }
        ];
        for (const { env, config } of cases) {
            const plan = layouts.workersFor({ settings, config, env });
            const api = plan.workers.find(worker => worker.name === 'api');
            expect(api).toBeDefined();
            const mode = withAppEnv({ env: { ...env, ...api.env }, config }, () => require('../apps/api/server').resolveRuntimeMode());
            expect([plan.layout, mode]).toEqual([plan.layout, layouts.apiModeFor(plan.layout)]);
        }
    });

    test('with no explicit mode a Discord adapter means lite (the bot serves the portal), none means standalone', () => {
        expect(layouts.resolveLayout({ env: {}, config: { token: 'bot-token-value' } })).toMatchObject({ layout: 'lite', source: 'discord', error: null });
        expect(layouts.resolveLayout({ env: {}, config: { webapp: { enabled: true } } })).toMatchObject({ layout: 'standalone', error: null });
        expect(layouts.resolveLayout({ env: {}, config: {} }).error).toBe('WEBAPP_DISABLED');
        expect(layouts.resolveLayout({ env: { GOOBSTER_RUNTIME_MODE: 'lite' }, config: {} }).error).toBe('DISCORD_TOKEN_MISSING');
        expect(layouts.resolveLayout({ env: { GOOBSTER_RUNTIME_MODE: 'paired' }, config: { token: 'x' } }).error).toBe('PAIRED_REQUIRES_POSTGRES');
        expect(layouts.resolveLayout({ env: { GOOBSTER_RUNTIME_MODE: 'paired', GOOBSTER_DB_URL: 'postgres://x' }, config: { token: 'x' } }).error)
            .toBe('PAIRED_REQUIRES_INTERNAL_TOKEN');
    });
});

describe('the worker set per layout', () => {
    const settings = { root: REPO, storeDir: '/store', port: 3400, lan: false };
    const paired = { GOOBSTER_RUNTIME_MODE: 'paired', GOOBSTER_DB_URL: 'postgres://x', GOOBSTER_INTERNAL_TOKEN: 'secret-token-value' };

    test('lite [bot], standalone [api], paired [bot, api], paired with the sandbox active [sandbox, bot, api]', () => {
        const names = (env, config, sandboxActive = false) => layouts.workersFor({ settings, env, config, sandboxActive }).workers.map(worker => worker.name);
        expect(names({}, { token: 'x' })).toEqual(['bot']);
        expect(names({}, { webapp: { enabled: true } })).toEqual(['api']);
        expect(names(paired, { token: 'x' })).toEqual(['bot', 'api']);
        expect(names(paired, { token: 'x' }, true)).toEqual(['sandbox', 'bot', 'api']);
        expect(names({ ...paired, GOOBSTER_SANDBOX_URL: 'http://sandbox-runner:3200' }, { token: 'x' }, true)).toEqual(['bot', 'api']);
    });

    test('worker records: scripts, health, bounded stop, the shared env (names only, never a secret)', () => {
        const { workers } = layouts.workersFor({ settings, env: paired, config: { token: 'x' }, sandboxActive: true, drainSeconds: 45 });
        const bot = workers.find(worker => worker.name === 'bot');
        expect(bot.script).toBe(path.join(REPO, 'apps', 'bot', 'index.js'));
        expect(bot.preStart).toMatchObject({ name: 'deploy-commands', script: path.join(REPO, 'apps', 'bot', 'deploy-commands.js') });
        expect(bot.healthUrl).toBe('http://127.0.0.1:3000/health');
        expect(bot.stopTimeoutMs).toBe(45_000 + 15_000);
        expect(bot.env).toMatchObject({
            GOOBSTER_SUPERVISOR: 'manager', GOOBSTER_WORKER_NAME: 'bot', GOOBSTER_LIFECYCLE_DRAIN_SECONDS: '45',
            GOOBSTER_MANAGER_URL: 'http://127.0.0.1:3400', GOOBSTER_PANEL_PORT: '3401', GOOBSTER_SANDBOX_URL: 'http://127.0.0.1:3200'
        });
        for (const worker of workers) expect(JSON.stringify(worker.env)).not.toContain('secret-token-value');
        const sandbox = workers.find(worker => worker.name === 'sandbox');
        expect(sandbox.env.GOOBSTER_SANDBOX_URL).toBe('');
        expect(sandbox.healthUrl).toBe('http://127.0.0.1:3200/health');
        expect(layouts.workersFor({ settings: { ...settings, lan: true }, env: {}, config: { token: 'x' } }).workers[0].env.GOOBSTER_MANAGER_URL).toBeUndefined();
        expect(layouts.BACKOFF_MS).toEqual([1000, 2000, 5000, 10000, 30000]);
    });

    test('startEnv gives each start its revision, staged flag, manager pid and a fresh ack token', () => {
        const a = layouts.startEnv({ revision: 3, staged: true, managerPid: 77 });
        const b = layouts.startEnv({ revision: 3, staged: false, managerPid: 77 });
        expect(a).toMatchObject({ GOOBSTER_REVISION: '3', GOOBSTER_FEATURES_STAGED: '1', GOOBSTER_MANAGER_PID: '77' });
        expect(b.GOOBSTER_FEATURES_STAGED).toBe('0');
        expect(a.GOOBSTER_MANAGER_ACK_TOKEN).not.toBe(b.GOOBSTER_MANAGER_ACK_TOKEN);
    });
});

describe('detectSupervisor', () => {
    const noDocker = { existsSync: () => false };
    test('explicit wins, then systemd, PM2, Docker, none', () => {
        expect(lifecycle.detectSupervisor({ env: { GOOBSTER_SUPERVISOR: 'manager', INVOCATION_ID: 'x' }, fs: noDocker })).toBe('manager');
        expect(lifecycle.detectSupervisor({ env: { INVOCATION_ID: 'x' }, fs: noDocker })).toBe('systemd');
        expect(lifecycle.detectSupervisor({ env: { pm_id: '0' }, fs: noDocker })).toBe('pm2');
        expect(lifecycle.detectSupervisor({ env: {}, fs: { existsSync: file => file === '/.dockerenv' } })).toBe('docker');
        expect(lifecycle.detectSupervisor({ env: {}, fs: noDocker })).toBe('none');
        expect(lifecycle.detectSupervisor({ env: { GOOBSTER_SUPERVISOR: 'bogus' }, fs: noDocker })).toBe('none');
    });
});

describe('the worker side', () => {
    function fakeProc({ platform = 'linux', ppid = 4242 } = {}) {
        const proc = new EventEmitter();
        proc.platform = platform;
        proc.ppid = ppid;
        return proc;
    }
    function manualTimers() {
        const ticks = [];
        return { setTimer: (fn) => { ticks.push(fn); return { unref() {} }; }, tick: () => ticks.forEach(fn => fn()), ticks };
    }

    test('SIGUSR2 from the manager stops new work, announced, with the drain countdown; listeners hear it once', () => {
        let t = 1_000_000;
        const worker = lifecycle.createWorkerLifecycle({ now: () => t });
        const store = dir('worker');
        const env = { GOOBSTER_SUPERVISOR: 'manager', GOOBSTER_MANAGER_STATE_DIR: store, GOOBSTER_LIFECYCLE_DRAIN_SECONDS: '20' };
        worker.boot({ worker: 'bot', env, log: quiet });
        const proc = fakeProc();
        const heard = [];
        worker.onPauseNewWork(event => heard.push(event));
        worker.install({ shutdown: () => {}, env, proc, setTimer: manualTimers().setTimer });
        expect(worker.restartNotice()).toBeNull();
        proc.emit('SIGUSR2');
        proc.emit('SIGUSR2');
        expect(worker.newWorkPaused()).toBe(true);
        expect(heard).toEqual([expect.objectContaining({ reason: 'lifecycle', announced: true, drainSeconds: 20 })]);
        t += 5000;
        expect(worker.restartNotice()).toEqual({ secondsLeft: 15 });
        expect(worker.drainBoundMs()).toBe(20_000);
        worker.dispose();
    });

    test('a plain shutdown stops new work without a restart notice', () => {
        const worker = lifecycle.createWorkerLifecycle();
        worker.boot({ worker: 'api', env: {}, fs: { existsSync: () => false, readFileSync: () => { throw new Error('none'); } }, log: quiet });
        worker.pauseNewWork({ reason: 'shutdown' });
        expect(worker.newWorkPaused()).toBe(true);
        expect(worker.restartNotice()).toBeNull();
        expect(worker.describe()).toMatchObject({ worker: 'api', newWorkPaused: true, announced: false });
    });

    test('requestRestart runs the shutdown with exit 75, once; refused when nothing supervises the process', () => {
        const store = dir('restart');
        const supervised = lifecycle.createWorkerLifecycle();
        const env = { GOOBSTER_SUPERVISOR: 'systemd', GOOBSTER_MANAGER_STATE_DIR: store };
        supervised.boot({ worker: 'bot', env, log: quiet });
        const calls = [];
        supervised.install({ shutdown: options => calls.push(options), env, proc: fakeProc(), setTimer: manualTimers().setTimer });
        expect(supervised.requestRestart('test')).toBe(true);
        expect(supervised.requestRestart('again')).toBe(true);
        expect(calls).toEqual([{ exitCode: lifecycle.EXIT_RESTART, reason: 'restart' }]);
        expect(lifecycle.EXIT_RESTART).toBe(75);

        const alone = lifecycle.createWorkerLifecycle();
        alone.boot({ worker: 'bot', env: { GOOBSTER_SUPERVISOR: 'none', GOOBSTER_MANAGER_STATE_DIR: store }, log: quiet });
        const never = [];
        alone.install({ shutdown: options => never.push(options), env: { GOOBSTER_SUPERVISOR: 'none', GOOBSTER_MANAGER_STATE_DIR: store }, proc: fakeProc(), setTimer: manualTimers().setTimer });
        expect(alone.requestRestart('test')).toBe(false);
        expect(never).toEqual([]);
        alone.dispose();
    });

    test('an external unit follows its control file: a request older than this start is ignored, then stop-new-work, then restart (75)', () => {
        const store = dir('control');
        const env = { GOOBSTER_SUPERVISOR: 'systemd', GOOBSTER_MANAGER_STATE_DIR: store };
        lifecycle.writeControl('api', { boot: null, request: { id: 'old', type: 'restart', revision: 1, drainSeconds: 5, at: '2000-01-01T00:00:00.000Z' } }, { env });
        const worker = lifecycle.createWorkerLifecycle();
        worker.boot({ worker: 'api', env, log: quiet });
        const calls = [];
        const timers = manualTimers();
        worker.install({ shutdown: options => calls.push(options), env, proc: fakeProc(), setTimer: timers.setTimer });
        timers.tick();
        expect(worker.newWorkPaused()).toBe(false);
        lifecycle.writeControl('api', { boot: null, request: { id: 'a', type: 'stop-new-work', revision: 2, drainSeconds: 30, at: new Date().toISOString() } }, { env });
        timers.tick();
        expect(worker.newWorkPaused()).toBe(true);
        expect(worker.restartNotice()).not.toBeNull();
        expect(calls).toEqual([]);
        lifecycle.writeControl('api', { boot: { revision: 2, staged: true }, request: { id: 'b', type: 'restart', revision: 2, drainSeconds: 30, at: new Date().toISOString() } }, { env });
        timers.tick();
        expect(calls).toEqual([{ exitCode: 75, reason: 'restart' }]);
        expect(lifecycle.bootRevision({ worker: 'api', env })).toEqual({ revision: 2, staged: true, source: 'control' });
    });

    test('a child whose manager is gone shuts itself down instead of running unsupervised', () => {
        const env = { GOOBSTER_SUPERVISOR: 'manager', GOOBSTER_MANAGER_PID: '4242', GOOBSTER_MANAGER_STATE_DIR: dir('orphan') };
        const worker = lifecycle.createWorkerLifecycle();
        worker.boot({ worker: 'api', env, log: quiet });
        const proc = fakeProc({ ppid: 4242 });
        const calls = [];
        const timers = manualTimers();
        worker.install({ shutdown: options => calls.push(options), env, proc, setTimer: timers.setTimer });
        timers.tick();
        expect(calls).toEqual([]);
        proc.ppid = 1;
        timers.tick();
        expect(calls).toEqual([{ exitCode: 0, reason: 'orphaned' }]);
    });

    test('contract bounds never exceed the drain window; settle interrupts what is still going', async () => {
        expect(lifecycle.DRAIN_BOUND_SECONDS).toBe(45);
        expect(lifecycle.contractBoundMs('sandboxRun', 60_000)).toBe(35_000);
        expect(lifecycle.contractBoundMs('expedition', 10_000)).toBe(10_000);
        expect(() => lifecycle.contractBoundMs('nope', 1)).toThrow();
        const interrupted = [];
        const results = await lifecycle.settle([
            { name: 'fast', drain: async () => {} },
            { name: 'slow', drain: () => new Promise(() => {}), interrupt: async () => interrupted.push('slow') },
            { name: 'broken', drain: async () => { throw new Error('x'); }, interrupt: async () => interrupted.push('broken') }
        ], 20);
        expect(results).toEqual([
            { name: 'fast', outcome: 'settled' },
            { name: 'slow', outcome: 'interrupted' },
            { name: 'broken', outcome: 'interrupted' }
        ]);
        expect(interrupted.sort()).toEqual(['broken', 'slow']);
    });

    test('the bot drains every interaction listener (commands and buttons) inside the integrationAction bound', () => {
        const source = fs.readFileSync(path.join(REPO, 'apps', 'bot', 'index.js'), 'utf8');
        const listeners = source.match(/client\.on\((?:Events\.InteractionCreate|event\.name)[^\n]*/g) || [];
        const interaction = listeners.filter(line => line.includes('InteractionCreate') || line.includes('trackInteraction'));
        expect(interaction).toHaveLength(2);
        for (const line of interaction) expect(line).toContain('trackInteraction(');
        expect(source).toMatch(/name: 'integrationAction',\s*drain: \(\) => Promise\.allSettled\(\[\.\.\.interactionsInFlight\]\)/);
        expect(source).toContain("lifecycle.contractBoundMs('integrationAction', boundMs)");
    });
});

describe('the restarting notice (the Phase 1 refusal path)', () => {
    const { refuseUnavailableCommand } = require('../apps/bot/events/interactionCreate');
    const { commandNameIndex } = require('@goobster/core/utils/commandDeployment');
    const names = commandNameIndex(path.join(REPO, 'apps', 'bot', 'commands'));
    const interaction = (commandName, autocomplete = false) => ({
        commandName,
        isAutocomplete: () => autocomplete,
        reply: jest.fn(async () => {}),
        respond: jest.fn(async () => {}),
        followUp: jest.fn(async () => {}),
        deferred: false,
        replied: false
    });
    const restarting = { restartNotice: () => ({ secondsLeft: 12 }) };
    const steady = { restartNotice: () => null };

    test('only while an announced restart drains: feature commands get "restarting in N s", core commands keep working', async () => {
        const feature = interaction('adventure');
        expect(await refuseUnavailableCommand(feature, names, steady)).toBe(false);
        expect(await refuseUnavailableCommand(feature, names, restarting)).toBe(true);
        expect(feature.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Goobster is restarting in 12 s. Try that again in a minute.', ephemeral: true }));
        const core = interaction('help');
        expect(await refuseUnavailableCommand(core, names, restarting)).toBe(false);
        expect(core.reply).not.toHaveBeenCalled();
        const autocomplete = interaction('adventure', true);
        expect(await refuseUnavailableCommand(autocomplete, names, restarting)).toBe(true);
        expect(autocomplete.respond).toHaveBeenCalledWith([]);
    });
});

describe('revision acks', () => {
    test('the file record carries version, worker, revision, pid and time only; bad names and revisions are refused', () => {
        const env = { GOOBSTER_MANAGER_STATE_DIR: dir('ack') };
        const record = revisionAck.writeAck({ worker: 'bot', revision: 3, pid: 99, env });
        expect(Object.keys(record).sort()).toEqual(['at', 'pid', 'revision', 'version', 'worker']);
        expect(revisionAck.readAck('bot', { env })).toEqual(record);
        expect(fs.readdirSync(revisionAck.ackDir(env))).toEqual(['bot.json']);
        expect(() => revisionAck.writeAck({ worker: '../x', revision: 1, env })).toThrow();
        expect(() => revisionAck.writeAck({ worker: 'bot', revision: -1, env })).toThrow();
        revisionAck.clearAck('bot', { env });
        expect(revisionAck.readAck('bot', { env })).toBeNull();
        expect(revisionAck.parseRevision('12')).toBe(12);
        expect(revisionAck.parseRevision('1.5')).toBeNull();
    });

    test('acknowledge writes the file and POSTs { worker, revision, pid } with the per-start token', async () => {
        const seen = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                seen.push({ url: req.url, token: req.headers['x-goobster-ack-token'], body: JSON.parse(body) });
                res.end('{}');
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const env = {
                GOOBSTER_MANAGER_STATE_DIR: dir('post'),
                GOOBSTER_MANAGER_URL: `http://127.0.0.1:${server.address().port}`,
                GOOBSTER_MANAGER_ACK_TOKEN: 'per-start-token'
            };
            const out = await revisionAck.acknowledge({ worker: 'api', revision: 2, env, logger: quiet });
            expect(out).toMatchObject({ ok: true, posted: true });
            expect(seen).toEqual([{ url: '/manager/api/lifecycle/ack', token: 'per-start-token', body: { worker: 'api', revision: 2, pid: process.pid } }]);
            expect(revisionAck.readAck('api', { env })).toMatchObject({ revision: 2, pid: process.pid });
            expect(await revisionAck.acknowledge({ worker: 'api', revision: null, env })).toEqual({ skipped: true });
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});

describe('staged features', () => {
    test('a start at revision n adopts the staged document tagged n, and nothing else', () => {
        const env = { GOOBSTER_MANAGER_STATE_DIR: dir('staged') };
        const file = lifecycle.stagedFeaturesFile(env);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ version: 1, features: {}, lifecycle: { version: 1, revision: 4 } }));
        const resolver = { configure: jest.fn() };
        expect(lifecycle.adoptStagedFeatures({ revision: 3, env, features: resolver })).toEqual({ adopted: false, reason: 'STAGED_MISSING' });
        expect(resolver.configure).not.toHaveBeenCalled();
        expect(lifecycle.adoptStagedFeatures({ revision: null, env, features: resolver })).toEqual({ adopted: false, reason: 'NO_REVISION' });
        expect(lifecycle.adoptStagedFeatures({ revision: 4, env, features: resolver })).toEqual({ adopted: true, reason: null });
        expect(resolver.configure).toHaveBeenCalledWith({ filePath: file });
    });

    test('the real resolver adopts a staged document only before its first read, through configure()', () => {
        const { features, FeatureStateError } = require('@goobster/core/features/featureState');
        const env = { GOOBSTER_MANAGER_STATE_DIR: dir('staged-real') };
        const file = lifecycle.stagedFeaturesFile(env);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            version: 1, revision: 1, origin: 'operator', features: { gambling: { installed: true, active: false } },
            lifecycle: { version: 1, revision: 9 }
        }));
        features._resetForTests({});
        try {
            expect(lifecycle.adoptStagedFeatures({ revision: 9, env })).toEqual({ adopted: true, reason: null });
            expect(features.status().features.gambling.active).toBe(false);
            // Read already happened: a second adoption is refused, not applied.
            expect(() => features.configure({ filePath: file })).toThrow(FeatureStateError);
            expect(lifecycle.adoptStagedFeatures({ revision: 9, env })).toEqual({ adopted: false, reason: 'ALREADY_RESOLVED' });
        } finally {
            features._resetForTests({});
        }
    });

    test('a start that could not adopt its staged features acknowledges nothing', async () => {
        const storeDir = dir('no-ack');
        const env = { GOOBSTER_SUPERVISOR: 'manager', GOOBSTER_MANAGER_STATE_DIR: storeDir, GOOBSTER_REVISION: '6', GOOBSTER_FEATURES_STAGED: '1' };
        const worker = lifecycle.createWorkerLifecycle();
        expect(worker.boot({ worker: 'api', env, log: { warn: () => {} } })).toMatchObject({ revision: 6, staged: false });
        expect(await worker.acknowledgeReady({ env })).toEqual({ skipped: true, reason: 'STAGED_NOT_ADOPTED' });
        expect(fs.existsSync(path.join(storeDir, 'ack', 'api.json'))).toBe(false);
    });

    test('boot asks for staged features only with GOOBSTER_FEATURES_STAGED, and falls back when the document is not there', () => {
        const env = { GOOBSTER_SUPERVISOR: 'manager', GOOBSTER_MANAGER_STATE_DIR: dir('boot'), GOOBSTER_REVISION: '6', GOOBSTER_FEATURES_STAGED: '1' };
        const warnings = [];
        const worker = lifecycle.createWorkerLifecycle();
        expect(worker.boot({ worker: 'api', env, log: { warn: msg => warnings.push(msg) } })).toEqual({ worker: 'api', supervisor: 'manager', revision: 6, staged: false });
        expect(warnings.join('\n')).toMatch(/STAGED_MISSING/);
        expect(lifecycle.bootRevision({ worker: 'api', env: { ...env, GOOBSTER_FEATURES_STAGED: '0' } })).toMatchObject({ revision: 6, staged: false, source: 'env' });
    });
});

describe('the external adapter', () => {
    test('attach records the boot revision; start asks the unit to restart into n with a request newer than now; stop does nothing', async () => {
        const storeDir = dir('external');
        const env = { GOOBSTER_MANAGER_STATE_DIR: storeDir };
        const adapter = createExternalAdapter({ storeDir });
        expect(adapter.supervised).toBe(false);
        const attached = adapter.attach({ name: 'bot' }, { revision: 2 });
        expect(attached).toMatchObject({ external: true, pid: null, requestedAt: null });
        expect(lifecycle.readControl('bot', { env })).toMatchObject({ boot: { revision: 2, staged: false }, request: null });

        const started = adapter.start({ name: 'bot' }, { revision: 3, staged: true, drainSeconds: 30, id: 'req-1' });
        expect(lifecycle.readControl('bot', { env })).toMatchObject({
            boot: { revision: 3, staged: true },
            request: { id: 'req-1', type: 'restart', revision: 3, drainSeconds: 30, at: started.requestedAt }
        });
        started.stopNewWork({ revision: 4, drainSeconds: 10, id: 'req-2' });
        expect(lifecycle.readControl('bot', { env })).toMatchObject({ boot: { revision: 3, staged: true }, request: { id: 'req-2', type: 'stop-new-work' } });
        expect(await started.stop()).toEqual({ exit: null, forced: false, timedOut: false, external: true });
    });

    test('the child adapter refuses a worker an OS unit already runs', () => {
        const adapter = createChildAdapter({ spawn: () => { throw new Error('must not spawn'); }, logger: quiet });
        expect(() => adapter.start({ name: 'bot', external: true }, { env: {} })).toThrow(expect.objectContaining({ code: 'NESTED_SUPERVISOR_REFUSED' }));
    });
});

describe('the child adapter with a real process group (Linux)', () => {
    const alive = (pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
    };
    const script = (name, body) => {
        const file = path.join(dir(name), `${name}.js`);
        fs.writeFileSync(file, body);
        return file;
    };
    const leader = ({ ignoreTerm }) => `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        fs.writeFileSync(process.env.PIDS_FILE, JSON.stringify({ leader: process.pid, helper: helper.pid }));
        process.on('SIGUSR2', () => fs.writeFileSync(process.env.PIDS_FILE + '.usr2', 'yes'));
        process.on('SIGTERM', () => { ${ignoreTerm ? '' : 'helper.kill(); process.exit(0);'} });
        setInterval(() => {}, 1000);
    `;
    const until = async (predicate, ms = 3000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (predicate()) return true;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        return false;
    };

    linuxOnly('graceful: SIGUSR2 to the leader only, SIGTERM, a clean exit, nothing left in the group', async () => {
        const pidsFile = path.join(dir('graceful'), 'pids.json');
        const adapter = createChildAdapter({ logger: quiet });
        const handle = adapter.start({ name: 'api', script: script('graceful', leader({ ignoreTerm: false })), stopTimeoutMs: 2000 }, { env: { ...process.env, PIDS_FILE: pidsFile } });
        expect(await until(() => fs.existsSync(pidsFile))).toBe(true);
        const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
        handle.stopNewWork({ revision: 1, drainSeconds: 1 });
        expect(await until(() => fs.existsSync(`${pidsFile}.usr2`))).toBe(true);
        expect(alive(pids.helper)).toBe(true);
        const result = await handle.stop({ timeoutMs: 2000 });
        expect(result).toMatchObject({ forced: false, timedOut: false, exit: { code: 0 } });
        expect(await until(() => !alive(pids.helper) && !alive(pids.leader))).toBe(true);
    }, 15000);

    linuxOnly('forced: a leader that ignores SIGTERM is killed with its whole group after the bound', async () => {
        const pidsFile = path.join(dir('forced'), 'pids.json');
        const adapter = createChildAdapter({ logger: quiet });
        const handle = adapter.start({ name: 'bot', script: script('forced', leader({ ignoreTerm: true })), stopTimeoutMs: 300 }, { env: { ...process.env, PIDS_FILE: pidsFile } });
        expect(await until(() => fs.existsSync(pidsFile))).toBe(true);
        const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
        const startedAt = Date.now();
        const result = await handle.stop({ timeoutMs: 300 });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(280);
        expect(result).toMatchObject({ forced: true, timedOut: false, exit: { signal: 'SIGKILL' } });
        expect(await until(() => !alive(pids.helper) && !alive(pids.leader))).toBe(true);
    }, 15000);

    linuxOnly('a spawn failure comes back through exited, never as a throw', async () => {
        const adapter = createChildAdapter({ execPath: path.join(ROOT, 'no-such-node'), logger: quiet });
        const handle = adapter.start({ name: 'api', script: 'x.js', stopTimeoutMs: 100 }, { env: {} });
        expect(await handle.exited).toMatchObject({ error: 'ENOENT' });
    });

    linuxOnly('run: a bounded helper that hangs is killed with its group and reported timedOut', async () => {
        const adapter = createChildAdapter({ logger: quiet });
        const ok = await adapter.run({ script: script('quick', 'process.exit(0)'), timeoutMs: 3000 }, { env: process.env });
        expect(ok).toMatchObject({ code: 0, timedOut: false });
        const hung = await adapter.run({ script: script('hang', 'setInterval(() => {}, 1000)'), timeoutMs: 200 }, { env: process.env });
        expect(hung).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    }, 15000);
});
