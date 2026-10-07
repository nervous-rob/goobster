/**
 * Runtime-step, startup-side-effect and listener gating (#318, P1.3).
 *
 * `startCoreRuntime` must not invoke, construct or start the worker of a
 * feature that is not active, on first boot, on paused -> resume, and in the
 * client-less standalone and paired shapes; a skipped step is reported as
 * `skipped` with reason `feature`, distinct from `paused` and from a
 * failure. The bundled core workers keep starting and only drop the branches
 * their disabled features own. serviceManager builds nothing at require time
 * and nothing at all while voice is off; the bot's listeners follow the same
 * snapshot.
 *
 * No Discord token, key or network: feature state is injected, workers are
 * fakes that record what touched them, the database is the throwaway one.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

process.env.GOOBSTER_DB_PATH = process.env.GOOBSTER_DB_PATH
    || path.join(os.tmpdir(), `goobster-gating-runtime-${process.pid}.sqlite`);

const mockWheel = { spin: jest.fn(), settings: jest.fn() };
jest.mock('@goobster/core/services/exchange/wheelService', () => ({ spin: (...args) => mockWheel.spin(...args) }));
jest.mock('@goobster/core/services/exchange/wheelPresenter', () => ({
    buildWheelEmbed: () => ({ title: 'wheel' }),
    resolveNames: async () => new Map()
}));
jest.mock('@goobster/core/services/economyService', () => ({
    getSettings: async () => ({ currencyName: 'jimbucks' })
}));

const db = require('@goobster/core/db');
const inventory = require('@goobster/core/features/inventory');
const { features } = require('@goobster/core/features/featureState');
const { DisabledGateway } = require('@goobster/core/gateway');
const {
    startCoreRuntime,
    ATTENTION_GENERATOR_TABLES
} = require('@goobster/core/runtime/coreRuntime');

const {
    FEATURE_IDS,
    MANAGEABLE,
    FILE,
    DEFAULT_CONFIG,
    EVERYTHING_ON,
    memoryFs,
    useState,
    deriveActive,
    deriveServed,
    STEP_NAMES,
    FEATURE_STEPS,
    MARKERS,
    fakeDeps,
    quiet,
    FAKE_CLIENT,
    expectedReport,
    sortedByName,
    useBotBoot
} = require('./helpers/featureFixtures');

afterAll(() => {
    features._resetForTests({});
});

/* ------------------------------------------------------------------ */
/* coreRuntime step gating                                              */
/* ------------------------------------------------------------------ */

describe('coreRuntime step gating', () => {
    test('with no features.json every step starts as before, even where a legacy switch is off (reported, not enforced)', async () => {
        useState();
        // The shipped defaults leave observatory off in the *reported* view
        // (it needs sandbox); without a state file or env override that is
        // not a refusal, so the runtime is identical to the pre-gating one.
        expect(deriveActive().has('observatory')).toBe(false);
        expect(features.isActive('observatory')).toBe(false);
        expect(features.enforcedOff('observatory')).toBe(false);
        const log = [];
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps(log) });
        expect(sortedByName(runtime.report)).toEqual(sortedByName(expectedReport(new Set(FEATURE_IDS))));
        expect(runtime.featureSkipped).toEqual([]);
        expect(runtime.started).toContain('observatoryResume');
        expect(log).toContain(MARKERS.observatoryResume);
        await runtime.stop();
    });

    test('an env override alone (no features.json) skips the overridden steps with reason feature and nothing else', async () => {
        useState({ env: { GOOBSTER_FEATURE_SANDBOX: '0' } });
        const active = deriveServed({ env: { GOOBSTER_FEATURE_SANDBOX: '0' } });
        expect(active.has('sandbox')).toBe(false);
        expect(active.has('observatory')).toBe(false);
        const log = [];
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps(log) });
        expect(sortedByName(runtime.report)).toEqual(sortedByName(expectedReport(active)));
        expect(runtime.featureSkipped).toEqual(['observatoryResume']);
        expect(log).not.toContain(MARKERS.observatoryResume);
        // not in `skipped` (that list is failures/declines/paused), not in `started`
        expect(runtime.skipped).not.toContain('observatoryResume');
        expect(runtime.started).not.toContain('observatoryResume');
        await runtime.stop();
    });

    test.each(MANAGEABLE)('with %s off its steps are skipped with reason feature and never invoked; every other step is unaffected', async (id) => {
        useState({ config: EVERYTHING_ON, inactive: [id] });
        const active = deriveActive({ config: EVERYTHING_ON, inactiveRequested: [id] });
        const log = [];
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps(log) });
        expect(sortedByName(runtime.report)).toEqual(sortedByName(expectedReport(active)));

        const featureRows = runtime.report.filter(row => row.reason === 'feature');
        for (const row of featureRows) {
            expect(inventory.ownerOf('runtimeStep', row.name).owner).toBe(row.feature);
            expect(log).not.toContain(MARKERS[row.name]);
            expect(runtime.started).not.toContain(row.name);
            expect(runtime.skipped).not.toContain(row.name);
        }
        // a skipped feature step is never recorded as a failure
        expect(runtime.report.filter(row => row.status === 'failed')).toEqual([]);
        await runtime.stop();
        // nothing that was not started is stopped
        for (const row of featureRows) {
            expect(log.filter(entry => entry.startsWith('stop:')).join()).not.toContain(MARKERS[row.name].replace(/^(new|start):/, ''));
        }
    });

    test('with every optional feature off only core steps run, and the retention, export and reflection workers are among them', async () => {
        useState({ config: EVERYTHING_ON, inactive: MANAGEABLE });
        const log = [];
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps(log) });
        expect(runtime.featureSkipped.sort()).toEqual([...FEATURE_STEPS].sort());
        for (const name of ['eventBus', 'chatHistoryRetention', 'accountExports', 'selfDocs', 'automation',
            'personalHeartbeat', 'memoryConsolidation', 'knowledgeReflection', 'ledgerRetention', 'heartbeat', 'monologue']) {
            expect(runtime.started).toContain(name);
        }
        await runtime.stop();
    });

    test('every non-core step declares its feature at the call site, and it is the inventory owner', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'packages', 'core', 'runtime', 'coreRuntime.js'), 'utf8');
        const chunks = source.split(/await step\('/).slice(1);
        expect(chunks.length).toBe(STEP_NAMES.length);
        const declared = {};
        for (const chunk of chunks) {
            const name = chunk.slice(0, chunk.indexOf("'"));
            const option = /\}, \{ feature: '(\w+)' \}\);/.exec(chunk);
            declared[name] = option ? option[1] : null;
        }
        for (const name of STEP_NAMES) {
            const { owner } = inventory.ownerOf('runtimeStep', name);
            expect(declared[name]).toBe(owner === 'core' ? null : owner);
        }
        expect(Object.entries(declared).filter(([, feature]) => feature).map(([name]) => name).sort())
            .toEqual([...FEATURE_STEPS].sort());
    });

    test('the closing log names the feature-off steps apart from the skipped ones', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['exchange'] });
        const logger = quiet();
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger, deps: fakeDeps([]) });
        const summary = logger.lines.info.find(line => line.startsWith('[runtime] Started:'));
        expect(summary).toMatch(/Feature off: exchangeRiskEngine/);
        expect(summary).toMatch(/Skipped: followupDelivery/);
        expect(logger.lines.info.join('\n')).toMatch(/exchangeRiskEngine not started: feature exchange is not active/);
        await runtime.stop();
    });

    test('a failing step is a failure, not a feature skip, and a feature skip never reports an error', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['expeditions'] });
        const logger = quiet();
        const deps = fakeDeps([]);
        deps.selfDocsService = { seedOnStartup: async () => { throw new Error('corpus missing'); } };
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger, deps });
        expect(runtime.report).toEqual(expect.arrayContaining([
            { name: 'selfDocs', status: 'failed', reason: 'error' },
            { name: 'spitballExpeditions', status: 'skipped', reason: 'feature', feature: 'expeditions' }
        ]));
        expect(logger.lines.error.join('\n')).toMatch(/selfDocs failed to start/);
        expect(logger.lines.error.join('\n')).not.toMatch(/spitballExpeditions/);
        await runtime.stop();
    });
});

/* ------------------------------------------------------------------ */
/* Shapes: standalone, paired, paused -> resume                         */
/* ------------------------------------------------------------------ */

describe('runtime shapes', () => {
    test('standalone (no client, Discord adapter off) applies the same policy; Discord-bound workers stay out as before', async () => {
        useState({ config: { clientId: '0' }, inactive: ['exchange', 'projects', 'cursor'] });
        const log = [];
        const runtime = await startCoreRuntime({ gateway: new DisabledGateway(), logger: quiet(), deps: fakeDeps(log) });
        const featureRows = runtime.report.filter(row => row.reason === 'feature').map(row => `${row.name}:${row.feature}`).sort();
        expect(featureRows).toEqual([
            'missionReconcile:projects',
            'observatoryResume:observatory',
            'projectTriggerCatchUp:projects',
            'workshopPinMigration:projects'
        ].sort());
        // no client: the four Discord-bound workers are skipped the way they always were, never constructed
        expect(runtime.skipped).toEqual(expect.arrayContaining(['heartbeat', 'agentTracker', 'monologue', 'exchangeRiskEngine']));
        expect(log).not.toContain('new:heartbeat');
        expect(log).not.toContain('new:agentTracker');
        expect(log).not.toContain('new:risk');
        expect(log).not.toContain('missionReconcile');
        expect(log).toContain('new:automation');
        expect(runtime.services.followupTimer).toBeTruthy();
        await runtime.stop();
    });

    test('paired (schedulers off) gates the one-shot reconciliation steps and starts no scheduler', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['projects'] });
        const log = [];
        const runtime = await startCoreRuntime({ gateway: new DisabledGateway(), schedulers: false, logger: quiet(), deps: fakeDeps(log) });
        expect(runtime.featureSkipped.sort()).toEqual(['missionReconcile', 'observatoryResume', 'projectTriggerCatchUp', 'workshopPinMigration']);
        expect(runtime.started).toEqual(expect.arrayContaining(['eventBus', 'chatHistoryRetention', 'selfDocs']));
        expect(runtime.started).not.toContain('automation');
        expect(log).not.toContain('new:automation');
        expect(log).not.toContain('workshopPinMigration');
        await runtime.stop();
    });

    test('paused: only the core trio runs; resume applies the feature policy, reports paused apart from feature, and starts no disabled worker', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['expeditions', 'projects', 'exchange'] });
        const log = [];
        let paused = true;
        const deps = fakeDeps(log, {
            instanceStateService: {
                isPaused: async () => paused,
                getPause: async () => ({ since: '2026-10-06 12:00:00', reason: 'restore' })
            }
        });
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, pausePollMs: 20, logger: quiet(), deps });
        try {
            expect(runtime.pausedAtStart).toBe(true);
            expect(runtime.started).toEqual(['eventBus', 'chatHistoryRetention', 'accountExports']);
            expect(runtime.report).toContainEqual({ name: 'paused', status: 'skipped', reason: 'paused' });
            expect(runtime.featureSkipped).toEqual([]);
            expect(log).toEqual(['start:eventBus', 'start:retention', 'start:exports']);

            paused = false;
            const deadline = Date.now() + 3000;
            while (!log.includes('start:reflection') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));

            expect(runtime.featureSkipped.sort()).toEqual([
                'exchangeRiskEngine', 'missionReconcile', 'observatoryResume', 'projectTriggerCatchUp', 'spitballExpeditions', 'workshopPinMigration'
            ]);
            for (const name of runtime.featureSkipped) expect(log).not.toContain(MARKERS[name]);
            for (const name of ['selfDocs', 'automation', 'personalHeartbeat', 'knowledgeReflection', 'memoryConsolidation', 'ledgerRetention']) {
                expect(runtime.started).toContain(name);
            }
            // paused stays distinct from feature in the report
            expect(runtime.report.filter(row => row.reason === 'paused')).toHaveLength(1);
            expect(runtime.report.filter(row => row.reason === 'feature').every(row => row.feature)).toBe(true);
        } finally {
            await runtime.stop();
        }
    });

    test('a restart with the same state yields the same report (dormant schedules do not catch up on another process starting)', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['projects'] });
        const first = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps([]) });
        const second = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps([]) });
        expect(second.report).toEqual(first.report);
        await first.stop();
        await second.stop();
    });
});

/* ------------------------------------------------------------------ */
/* Bundled core workers keep starting; feature branches drop out        */
/* ------------------------------------------------------------------ */

describe('bundled core workers', () => {
    test('automation: project trigger polling is switched off when projects are off, and left alone when on', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['projects'] });
        const log = [];
        let runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps(log) });
        expect(runtime.started).toContain('automation');
        await runtime.services.automation._pollProjectTriggers();
        expect(log).not.toContain('poll:projectTriggers');
        await runtime.stop();

        useState({ config: EVERYTHING_ON });
        runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps(log) });
        await runtime.services.automation._pollProjectTriggers();
        expect(log).toContain('poll:projectTriggers');
        await runtime.stop();
    });

    test('heartbeat: Cursor launch proposals are dropped when cursor is off; the heartbeat itself still starts', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['cursor'] });
        const log = [];
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps(log) });
        expect(runtime.started).toContain('heartbeat');
        expect(await runtime.services.heartbeat._agentProposalRepos('g')).toEqual([]);
        expect(await runtime.services.heartbeat._proposeAgent()).toBe(false);
        expect(log).not.toContain('heartbeat:agentRepos');
        expect(log).not.toContain('heartbeat:proposeAgent');
        await runtime.stop();

        useState({ config: EVERYTHING_ON });
        const second = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps(log) });
        expect(await second.services.heartbeat._agentProposalRepos('g')).toEqual(['repo']);
        await second.stop();
    });

    test('attention: generators that read a disabled feature\'s tables become no-ops; the rest are untouched and the service is not even loaded when nothing is gated', async () => {
        const generators = new Map();
        let loaded = 0;
        const attention = {
            listGenerators: () => [...generators.keys()].map(name => ({ name, description: `d:${name}` })),
            registerGenerator: jest.fn((name, generator) => generators.set(name, generator))
        };
        const original = jest.fn(async () => [{ candidate: true }]);
        for (const name of ['followed_source', 'deadline', ...Object.keys(ATTENTION_GENERATOR_TABLES)]) {
            generators.set(name, { description: `d:${name}`, run: original });
        }
        const depsWithAttention = (log) => {
            const deps = fakeDeps(log);
            Object.defineProperty(deps, 'attentionService', { get() { loaded += 1; return attention; }, enumerable: true });
            return deps;
        };

        useState({ config: EVERYTHING_ON });
        let runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: depsWithAttention([]) });
        expect(loaded).toBe(0);
        expect(attention.registerGenerator).not.toHaveBeenCalled();
        await runtime.stop();

        useState({ config: EVERYTHING_ON, inactive: ['expeditions', 'projects'] });
        runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: depsWithAttention([]) });
        expect(runtime.started).toContain('personalHeartbeat');
        const replaced = attention.registerGenerator.mock.calls.map(([name]) => name).sort();
        // projects off also takes observatory down (dependency): all three table-backed generators
        expect(replaced).toEqual(['observatory_job', 'project_mission', 'research_outcome']);
        expect(await generators.get('research_outcome').run({})).toEqual([]);
        expect(await generators.get('observatory_job').run({})).toEqual([]);
        expect(generators.get('research_outcome').description).toBe('d:research_outcome');
        expect(await generators.get('deadline').run({})).toEqual([{ candidate: true }]);
        expect(await generators.get('followed_source').run({})).toEqual([{ candidate: true }]);
        await runtime.stop();
    });

    test('the generator table map is claimed by the inventory (a rename would fail here, not silently ungate)', () => {
        for (const table of Object.values(ATTENTION_GENERATOR_TABLES)) {
            expect(inventory.ownerOf('table', table)).not.toBeNull();
            expect(inventory.ownerOf('table', table).owner).not.toBe('core');
        }
    });

    test('with the real attention service a disabled feature\'s generator reads nothing from the database', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['expeditions'] });
        const attentionService = require('@goobster/core/services/attentionService');
        const deps = fakeDeps([], { attentionService });
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps });
        const getSpy = jest.spyOn(db, 'get');
        const allSpy = jest.spyOn(db, 'all');
        try {
            const generator = attentionService._generators.get('research_outcome');
            expect(await generator.run({ userId: '100000000000000001', nowMs: Date.now() })).toEqual([]);
            expect(getSpy).not.toHaveBeenCalled();
            expect(allSpy).not.toHaveBeenCalled();
            expect(attentionService.listGenerators().find(item => item.name === 'research_outcome').description)
                .toMatch(/Spitball Expedition/);
        } finally {
            getSpy.mockRestore();
            allSpy.mockRestore();
            await runtime.stop();
        }
    });
});

describe('automation wheel branch', () => {
    const AutomationService = require('@goobster/core/services/automationService');

    function channel() {
        return { guild: { id: '200000000000000001' }, send: jest.fn(async () => {}) };
    }

    beforeEach(() => {
        mockWheel.spin.mockReset();
        mockWheel.spin.mockResolvedValue({ deployments: [] });
    });

    test.each([['gambling'], ['exchange'], ['economy']])('with %s off the daily wheel does not spin, post or fail', async (off) => {
        useState({ config: EVERYTHING_ON, inactive: [off] });
        const target = channel();
        const service = new AutomationService(null, {});
        await service.executeWheel({ id: 1, name: 'Daily wheel', guildId: '200000000000000001' }, target);
        expect(mockWheel.spin).not.toHaveBeenCalled();
        expect(target.send).not.toHaveBeenCalled();
    });

    test('with gambling, exchange and economy on the wheel spins and posts as before', async () => {
        useState({ config: EVERYTHING_ON });
        const target = channel();
        const service = new AutomationService(null, {});
        await service.executeWheel({ id: 1, name: 'Daily wheel', guildId: '200000000000000001' }, target);
        expect(mockWheel.spin).toHaveBeenCalledTimes(1);
        expect(target.send).toHaveBeenCalledTimes(1);
    });

    test('with no features.json the wheel runs (gambling and exchange have no legacy switch)', async () => {
        useState();
        const target = channel();
        const service = new AutomationService(null, {});
        await service.executeWheel({ id: 1, name: 'Daily wheel', guildId: '200000000000000001' }, target);
        expect(mockWheel.spin).toHaveBeenCalledTimes(1);
    });
});

/* ------------------------------------------------------------------ */
/* serviceManager                                                       */
/* ------------------------------------------------------------------ */

describe('serviceManager builds nothing at require time and nothing while voice is off', () => {
    const spies = { constructed: 0, initialized: 0 };

    // The mock class is cached by Jest after its first use, so every load shares one set of counters.
    function mockVoice() {
        jest.doMock('@goobster/core/services/voice', () => class VoiceServiceSpy extends EventEmitter {
            constructor() { super(); spies.constructed += 1; this.tts = {}; this.musicService = {}; }
            async initialize() { spies.initialized += 1; }
        });
    }

    function load({ inactive = [], state = true } = {}) {
        let manager;
        jest.isolateModules(() => {
            mockVoice();
            const isolatedFeatures = require('@goobster/core/features/featureState').features;
            const entries = {};
            for (const id of MANAGEABLE) entries[id] = { installed: true, active: !inactive.includes(id) };
            const files = state
                ? { [FILE]: JSON.stringify({ version: 1, revision: 1, updatedAt: null, origin: 'operator', features: entries }) }
                : {};
            isolatedFeatures._resetForTests({
                fs: memoryFs(files), filePath: FILE, env: {}, config: state ? EVERYTHING_ON : DEFAULT_CONFIG
            });
            manager = require('@goobster/core/services/serviceManager');
        });
        return manager;
    }

    beforeEach(() => {
        spies.constructed = 0;
        spies.initialized = 0;
    });

    afterEach(() => {
        jest.dontMock('@goobster/core/services/voice');
    });

    test('requiring the module constructs nothing, voice on or off', () => {
        load();
        load({ inactive: ['voice'] });
        expect(spies.constructed).toBe(0);
    });

    test('voice on: the first read builds and initialises one shared VoiceService', () => {
        const manager = load();
        const first = manager.voiceService;
        expect(spies.constructed).toBe(1);
        expect(spies.initialized).toBe(1);
        expect(manager.voiceService).toBe(first);
        expect(manager.getVoiceService()).toBe(first);
        expect(spies.constructed).toBe(1);
    });

    test('voice off: reads return an inert stand-in; no VoiceService, MusicService or TTS is ever built', async () => {
        const manager = load({ inactive: ['voice'] });
        const service = manager.voiceService;
        expect(service.unavailable).toBe(true);
        expect(service.tts).toBeNull();
        expect(service.musicService).toBeNull();
        expect(service.ambientService).toBeNull();
        expect(service._isInitialized).toBe(true);
        await expect(service.initialize()).resolves.toBeUndefined();
        expect(spies.constructed).toBe(0);
        expect(manager.voiceService).toBe(service);
    });

    test('with no features.json voice is on (no legacy switch) so the baseline still builds the shared service on first use', () => {
        const manager = load({ state: false });
        expect(spies.constructed).toBe(0);
        expect(manager.voiceService).toBeTruthy();
        expect(spies.constructed).toBe(1);
    });
});

/* ------------------------------------------------------------------ */
/* The bot process: loader, listeners, adapters                         */
/* ------------------------------------------------------------------ */

describe('bot process boot (listener and loader spies)', () => {
    const boot = useBotBoot();

    test('everything on: voice listeners, music presence listeners, every command and every adapter are present', async () => {
        const { client, readyClient, handle } = await boot({ config: EVERYTHING_ON });
        expect(client.listenerCount('voiceStateUpdate')).toBe(1);
        expect(handle.voice.initialize).toHaveBeenCalledTimes(1);
        expect(handle.adapters.playTrack).toBeTruthy();
        expect(handle.adapters.speak).toBeTruthy();
        expect(handle.adapters.nickname).toBeTruthy();
        expect(handle.runtimeStarted).toBe(1);
        expect(readyClient.listenerCount('musicTrackStarted')).toBe(1);
        expect(readyClient.listenerCount('musicTrackEnded')).toBe(1);
        expect(client.commands.size).toBeGreaterThan(60);
        expect(client.commands.has('speak')).toBe(true);
    });

    test('voice and music off: no voice init, no voiceStateUpdate or presence listener, no playback/voice adapters, no such commands', async () => {
        const { client, readyClient, handle } = await boot({ config: EVERYTHING_ON, inactive: ['voice', 'music'] });
        expect(client.listenerCount('voiceStateUpdate')).toBe(0);
        expect(handle.voice.initialize).not.toHaveBeenCalled();
        expect(readyClient.listenerCount('musicTrackStarted')).toBe(0);
        expect(readyClient.listenerCount('musicTrackEnded')).toBe(0);
        expect(handle.adapters.playTrack).toBeUndefined();
        expect(handle.adapters.speak).toBeUndefined();
        expect(handle.adapters.nickname).toBeTruthy();
        for (const name of ['play', 'music', 'speak', 'voicechat', 'setvoice', 'aidj', 'Goobster Controls', 'generatemusic', 'spotdl']) {
            expect(client.commands.has(name)).toBe(false);
        }
        expect(client.commands.has('forget-me')).toBe(true);
        // the core runtime still starts: it is the one that gates its own steps
        expect(handle.runtimeStarted).toBe(1);
    });

    test('music on, voice on, with a music service: presence listeners register on the ready client', async () => {
        const { readyClient, music } = await bootWithMusic();
        expect(music.setClient).toHaveBeenCalledWith(readyClient);
        expect(readyClient.listenerCount('musicTrackStarted')).toBe(1);
        expect(readyClient.listenerCount('musicTrackEnded')).toBe(1);
    });

    async function bootWithMusic() {
        const music = { setClient: jest.fn() };
        const { readyClient } = await boot({ config: EVERYTHING_ON, musicService: music });
        return { readyClient, music };
    }

    test('the 📋 issue-capture reaction is ignored with github off; every other reaction still reaches the handler', async () => {
        const off = await boot({ config: EVERYTHING_ON, inactive: ['github'] });
        const reactionFor = (emoji) => ({ emoji: { name: emoji }, partial: false, message: { guild: null, id: '1', channel: { id: '2' } } });
        const user = { id: '100000000000000001', tag: 'u#1', bot: false };
        off.client.emit('messageReactionAdd', reactionFor('📋'), user);
        off.client.emit('messageReactionAdd', reactionFor('🔄'), user);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(off.handle.reactions).toEqual(['🔄']);

        const on = await boot({ config: EVERYTHING_ON });
        on.client.emit('messageReactionAdd', reactionFor('📋'), user);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(on.handle.reactions).toEqual(['📋']);
    });

    test('a stale slash command for a disabled feature is answered ephemerally and nothing runs', async () => {
        const { client } = await boot({ config: EVERYTHING_ON, inactive: ['tavern'] });
        expect(client.commands.has('adventure')).toBe(false);
        const interaction = {
            commandName: 'adventure',
            isAutocomplete: () => false,
            isContextMenuCommand: () => false,
            isChatInputCommand: () => true,
            isButton: () => false,
            isMessageComponent: () => false,
            isModalSubmit: () => false,
            reply: jest.fn(async () => {}),
            deferred: false,
            replied: false
        };
        client.emit('interactionCreate', interaction);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'That feature is not available on this installation.',
            ephemeral: true
        }));
    });

    test('with no features.json every command loads, including those whose legacy switch is off', async () => {
        const { client } = await boot({ config: DEFAULT_CONFIG });
        const everyKey = [...Object.keys(inventory.commands), ...Object.keys(inventory.contextMenus)];
        expect(client.commands.size).toBe(everyKey.length);
        expect(client.commands.has('gbarun')).toBe(true);
        expect(client.commands.has('screenvision')).toBe(true);
    });

    test('an env override alone (no features.json) leaves the overridden commands out of the loader', async () => {
        const { client } = await boot({ config: DEFAULT_CONFIG, env: { GOOBSTER_FEATURE_GBA: '0', GOOBSTER_FEATURE_SCREEN_VISION: '0' } });
        const active = deriveServed({ env: { GOOBSTER_FEATURE_GBA: '0', GOOBSTER_FEATURE_SCREEN_VISION: '0' } });
        const expectedKeys = [];
        for (const [kind, table] of [['command', inventory.commands], ['contextMenu', inventory.contextMenus]]) {
            for (const key of Object.keys(table)) {
                const { owner, alsoRequires } = inventory.ownerOf(kind, key);
                if ([owner, ...alsoRequires].every(id => active.has(id))) expectedKeys.push(key);
            }
        }
        expect(client.commands.size).toBe(expectedKeys.length);
        expect(client.commands.has('gbarun')).toBe(false);
        expect(client.commands.has('screenvision')).toBe(false);
    });
});
