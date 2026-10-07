/**
 * Shared fixtures for the feature-gating specs (#316 - #322).
 *
 * Everything here is derived from the inventory graph and the legacy
 * switches only, never from featureState.js, so a spec that compares the two
 * is a real cross-check. No Discord token, key or network: feature state is
 * injected through an in-memory file system, workers are fakes that record
 * what touched them.
 *
 * Specs own their `jest.mock` calls (they hoist per file); this module only
 * requires modules that are safe to load unmocked.
 */
'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');

const inventory = require('@goobster/core/features/inventory');
const { features } = require('@goobster/core/features/featureState');
const { createLegacyResolver } = require('@goobster/core/features/legacyResolver');

const { FEATURE_IDS, FEATURES } = inventory;
const MANAGEABLE = FEATURE_IDS.filter(id => id !== 'core');
const FILE = '/virtual/data/features.json';
const COMMANDS_DIR = path.join(__dirname, '..', '..', 'apps', 'bot', 'commands');

/* ------------------------------------------------------------------ */
/* Feature state                                                       */
/* ------------------------------------------------------------------ */

function memoryFs(initial = {}) {
    const files = new Map(Object.entries(initial));
    const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return {
        files,
        existsSync: (p) => files.has(p),
        readFileSync: (p) => { if (!files.has(p)) throw missing(p); return files.get(p); },
        writeFileSync: (p, data) => { files.set(p, String(data)); },
        renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
        mkdirSync() {},
        unlinkSync: (p) => { files.delete(p); }
    };
}

/** A configuration with the Discord adapter on and every legacy flag at its shipped default. */
const DEFAULT_CONFIG = { token: 'jest-token', clientId: '0', guildIds: ['0'] };
/** Every legacy switch flipped on. */
const EVERYTHING_ON = {
    ...DEFAULT_CONFIG,
    sandbox: { enabled: true },
    observatory: { enabled: true },
    mcp: { enabled: true },
    gbaRun: { enabled: true },
    screenVision: { enabled: true },
    activity: { enabled: true }
};

/** A features.json document: every manageable feature installed, `off` ones inactive. */
function stateDoc(off = [], { updatedAt = '2026-10-06 12:00:00' } = {}) {
    const entries = {};
    for (const id of MANAGEABLE) entries[id] = { installed: true, active: !off.includes(id) };
    return JSON.stringify({ version: 1, revision: 1, updatedAt, origin: 'operator', features: entries });
}

/**
 * Point featureState at an in-memory file. `inactive` writes a file that
 * turns exactly those features off; null writes no file at all (the legacy
 * no-file installation).
 */
function useState({ config = DEFAULT_CONFIG, env = {}, inactive = null } = {}) {
    const files = inactive ? { [FILE]: stateDoc(inactive) } : {};
    features._resetForTests({ fs: memoryFs(files), filePath: FILE, env, config });
    return features;
}

/** Same, with a file body written by the caller (fresh-install preset, hand-edited docs). */
function useStateDoc(text, { config = DEFAULT_CONFIG, env = {} } = {}) {
    const memory = memoryFs({ [FILE]: text });
    features._resetForTests({ fs: memory, filePath: FILE, env, config });
    return memory;
}

/**
 * Expected active set, computed from the inventory graph and the legacy
 * switches only (what the resolver is meant to equal when no state file
 * exists). Independent of featureState.js.
 */
function deriveActive({ config = DEFAULT_CONFIG, env = {}, inactiveRequested = null } = {}) {
    const legacy = createLegacyResolver({ config, env });
    const requested = (id) => {
        if (id === 'core') return true;
        if (inactiveRequested) return !inactiveRequested.includes(id);
        try { return legacy.value(id); } catch { return true; }
    };
    const memo = {};
    const active = (id) => {
        if (memo[id] === undefined) memo[id] = requested(id) && FEATURES[id].dependsOn.every(active);
        return memo[id];
    };
    return new Set(FEATURE_IDS.filter(active));
}

const envKey = (id) => `GOOBSTER_FEATURE_${id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

/**
 * The served set with no state file: everything except features an env
 * override forces off and their hard dependents (the enforcement rule;
 * legacy switches only change the reported value). Independent of featureState.js.
 */
function deriveServed({ env = {} } = {}) {
    const memo = {};
    const served = (id) => {
        if (memo[id] === undefined) {
            const override = env[envKey(id)];
            const forcedOff = override !== undefined && ['0', 'false', 'off', 'no'].includes(String(override).trim().toLowerCase());
            memo[id] = id === 'core' || (!forcedOff && FEATURES[id].dependsOn.every(served));
        }
        return memo[id];
    };
    return new Set(FEATURE_IDS.filter(served));
}

/** True when a surface claim (owner plus alsoRequires) is fully inside `activeSet`. */
function claimServed(claim, activeSet) {
    return Boolean(claim) && [claim.owner, ...claim.alsoRequires].every(id => activeSet.has(id));
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/** inventory command/context-menu keys whose owner and every alsoRequires are in `activeSet`. */
function expectedKeys(activeSet) {
    const keys = [];
    for (const [kind, table] of [['command', inventory.commands], ['contextMenu', inventory.contextMenus]]) {
        for (const key of Object.keys(table)) {
            if (claimServed(inventory.ownerOf(kind, key), activeSet)) keys.push(key);
        }
    }
    return keys.sort();
}

function payloadNames(payload) {
    return [...payload.guildCommands, ...payload.globalCommands].map(command => command.name).sort();
}

/* ------------------------------------------------------------------ */
/* Runtime steps                                                       */
/* ------------------------------------------------------------------ */

/** Every step name the runtime can attempt, in inventory order, minus the synthetic `paused`. */
const STEP_NAMES = Object.keys(inventory.runtimeSteps).filter(name => name !== 'paused');
const FEATURE_STEPS = STEP_NAMES.filter(name => inventory.ownerOf('runtimeStep', name).owner !== 'core');

/**
 * Marker each fake writes when the runtime touches it, per step. A disabled
 * feature's marker must never appear in the log.
 */
const MARKERS = {
    eventBus: 'start:eventBus',
    chatHistoryRetention: 'start:retention',
    accountExports: 'start:exports',
    selfDocs: 'selfDocs',
    workshopPinMigration: 'workshopPinMigration',
    observatoryResume: 'observatoryResume',
    missionReconcile: 'missionReconcile',
    projectTriggerCatchUp: 'catchUp',
    automation: 'new:automation',
    followupDelivery: 'timer:followup',
    personalHeartbeat: 'new:personal',
    spitballExpeditions: 'start:expeditions',
    memoryConsolidation: 'start:consolidation',
    knowledgeReflection: 'start:reflection',
    ledgerRetention: 'start:ledger',
    heartbeat: 'new:heartbeat',
    agentTracker: 'new:agentTracker',
    monologue: 'new:monologue',
    exchangeRiskEngine: 'new:risk'
};

function fakeDeps(log, extra = {}) {
    const worker = (name) => ({ start: () => log.push(`start:${name}`), stop: () => log.push(`stop:${name}`), close: () => log.push(`stop:${name}`) });
    const klass = (name) => class {
        constructor() { log.push(`new:${name}`); this.name = name; }
        start() { log.push(`start:${name}`); }
        stop() { log.push(`stop:${name}`); }
    };
    class FakeAutomation extends klass('automation') {
        async _pollProjectTriggers() { log.push('poll:projectTriggers'); }
    }
    class FakeHeartbeat extends klass('heartbeat') {
        async _agentProposalRepos() { log.push('heartbeat:agentRepos'); return ['repo']; }
        async _proposeAgent() { log.push('heartbeat:proposeAgent'); return true; }
    }
    return {
        eventBusService: worker('eventBus'),
        chatHistoryRetentionService: worker('retention'),
        accountExportService: { start: () => log.push('start:exports'), stop: async () => log.push('stop:exports') },
        selfDocsService: { seedOnStartup: async () => { log.push('selfDocs'); return { acquired: false }; } },
        workshopPinMigration: { runOnStartup: async () => { log.push('workshopPinMigration'); return { acquired: false }; } },
        observatoryService: { autoResumeInterrupted: async () => { log.push('observatoryResume'); return []; } },
        projectMissionService: {
            reconcileStartingSteps: async () => { log.push('missionReconcile'); return 0; },
            reconcileRunningSteps: async () => 0
        },
        projectTriggerService: { catchUpEventTriggers: async () => { log.push('catchUp'); return 0; } },
        AutomationService: FakeAutomation,
        followupDeliveryService: { deliverDue: async () => { log.push('timer:followup'); return { delivered: 0, left: 0 }; } },
        PersonalHeartbeatService: klass('personal'),
        spitballExpeditionRunner: { start: async () => { log.push('start:expeditions'); return []; }, stop: async () => log.push('stop:expeditions') },
        memoryConsolidationService: worker('consolidation'),
        knowledgeReflectionService: worker('reflection'),
        ledgerRetentionService: worker('ledger'),
        HeartbeatService: FakeHeartbeat,
        AgentTrackerService: klass('agentTracker'),
        MonologueService: klass('monologue'),
        RiskEngine: klass('risk'),
        instanceStateService: { isPaused: async () => false, getPause: async () => null },
        ...extra
    };
}

const quiet = () => {
    const lines = { info: [], warn: [], error: [] };
    return {
        lines,
        info: (m) => lines.info.push(String(m)),
        warn: (m) => lines.warn.push(String(m)),
        error: (m) => lines.error.push(String(m))
    };
};

const FAKE_CLIENT = { user: { id: '900000000000000001', username: 'Goobster' }, isReady: () => true };

/** The report the derived feature state predicts for a full run (client present, schedulers on). */
function expectedReport(activeSet, { withClient = true } = {}) {
    const rows = [];
    for (const name of STEP_NAMES) {
        const { owner } = inventory.ownerOf('runtimeStep', name);
        if (!withClient && ['heartbeat', 'agentTracker', 'monologue', 'exchangeRiskEngine'].includes(name)) continue;
        if (!activeSet.has(owner)) rows.push({ name, status: 'skipped', reason: 'feature', feature: owner });
        else if (name === 'followupDelivery' && withClient) rows.push({ name, status: 'skipped', reason: 'declined' });
        else rows.push({ name, status: 'started' });
    }
    return rows;
}

function sortedByName(report) {
    return [...report].sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* Router walking                                                      */
/* ------------------------------------------------------------------ */

function prefixOf(layer) {
    if (layer.regexp.fast_slash) return '';
    const keys = (layer.keys || []).map((key) => key.name);
    let next = 0;
    return layer.regexp.source
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\$$/, '')
        .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${keys[next++] || 'param'}`)
        .replace(/\\\//g, '/');
}

function walkStack(stack, prefix, out) {
    for (const layer of stack) {
        if (layer.route) {
            for (const candidate of [].concat(layer.route.path)) {
                if (typeof candidate !== 'string') continue;
                for (const method of Object.keys(layer.route.methods)) {
                    out.push({ method: method.toUpperCase(), path: `${prefix}${candidate}` });
                }
            }
        } else if (layer.handle && layer.handle.stack) {
            walkStack(layer.handle.stack, `${prefix}${prefixOf(layer)}`, out);
        }
    }
}

const stackOf = (app) => app.stack || app._router.stack;

function routeTable(router) {
    const out = [];
    walkStack(stackOf(router), '', out);
    return out;
}

const concrete = (template) => template.replace(/:[A-Za-z]+/g, 'x1');
const keyOf = (route) => `${route.method} ${route.path}`;

/* ------------------------------------------------------------------ */
/* Bot process boot harness                                            */
/* ------------------------------------------------------------------ */

/**
 * Register the hooks and return `boot(state)`, which boots apps/bot/index.js
 * against a fake Discord client inside a fresh module registry whose feature
 * state is `state` ({ config, env, inactive, musicService }), then fires
 * ClientReady. Call from inside a `describe`.
 *
 * Jest caches a mock's first factory result for the whole file, so every
 * boot shares the same mock objects and they read the active boot through
 * `mockBoot`.
 */
function useBotBoot() {
    let exitSpy;
    let intervalSpy;
    const intervals = [];
    const mockBoot = { handle: null, FakeClient: null };

    beforeAll(() => {
        const realSetInterval = global.setInterval;
        intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((...args) => {
            const handle = realSetInterval(...args);
            intervals.push(handle);
            return handle;
        });
    });

    afterAll(() => {
        for (const handle of intervals) clearInterval(handle);
        intervalSpy.mockRestore();
    });

    beforeEach(() => {
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        jest.dontMock('discord.js');
    });

    /** The ready handler ends with the initial presence update, so wait for it. */
    async function readyHandlerDone(client) {
        const deadline = Date.now() + 5000;
        while (client.user.setPresence.mock.calls.length === 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    function installBotMocks(discord) {
        jest.doMock('discord.js', () => ({ ...discord, Client: function FakeClientProxy(...args) { return new mockBoot.FakeClient(...args); } }));
        jest.doMock('@goobster/core/utils/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
        jest.doMock('@goobster/bot/web/server', () => ({ startWebServers: async () => ({}), closeWebServers: async () => {} }));
        jest.doMock('@goobster/core/services/serviceManager', () => ({ get voiceService() { return mockBoot.handle.voice; } }));
        jest.doMock('@goobster/core/runtime/coreRuntime', () => ({
            startCoreRuntime: async () => { mockBoot.handle.runtimeStarted += 1; return { services: {}, stop: async () => {} }; }
        }));
        jest.doMock('@goobster/core/utils/chatHandler', () => ({
            handleChatInteraction: jest.fn(),
            handleReactionAdd: jest.fn(async (reaction) => { mockBoot.handle.reactions.push(reaction.emoji.name); }),
            handleReactionRemove: jest.fn()
        }));
        jest.doMock('@goobster/core/utils/toolsRegistry', () => ({
            registerCommandAdapters: (adapters) => { mockBoot.handle.adapters = adapters; }
        }));
        jest.doMock('@goobster/core/config/reportIntegrations', () => ({ reportIntegrations() {} }));
        jest.doMock('@goobster/core/utils/configValidator', () => ({ validateConfig: () => ({ isValid: true, errors: [], warnings: [] }) }));
        jest.doMock('@goobster/core/db', () => ({ getConnection: async () => ({}), closeConnection: async () => {} }));
        jest.doMock('@goobster/core/services/spotdl/spotdlService', () => class SpotDLServiceMock {});
    }

    return async function boot(state) {
        const handle = {
            clients: [],
            voice: { _isInitialized: false, initialize: jest.fn(async () => {}), musicService: state.musicService || null },
            adapters: null,
            runtimeStarted: 0,
            reactions: []
        };
        mockBoot.handle = handle;
        mockBoot.FakeClient = class FakeClient extends EventEmitter {
            constructor() {
                super();
                this.ws = new EventEmitter();
                this.user = { id: '900000000000000001', tag: 'goob#1', setPresence: jest.fn(async () => {}) };
                handle.clients.push(this);
            }

            login() { return Promise.resolve('ok'); }
        };
        await new Promise((resolve, reject) => {
            jest.isolateModules(() => {
                installBotMocks(jest.requireActual('discord.js'));
                const isolatedFeatures = require('@goobster/core/features/featureState').features;
                const files = state.inactive ? { [FILE]: stateDoc(state.inactive, { updatedAt: null }) } : {};
                if (state.file) files[FILE] = state.file;
                isolatedFeatures._resetForTests({
                    fs: memoryFs(files),
                    filePath: FILE, env: state.env || {}, config: state.config || EVERYTHING_ON
                });
                try {
                    require('@goobster/bot/index.js');
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
        const client = handle.clients[0];
        const readyClient = new EventEmitter();
        readyClient.user = client.user;
        readyClient.setMaxListeners(50);
        client.emit('clientReady', readyClient);
        client.emit('ready', readyClient);
        await readyHandlerDone(client);
        return { client, readyClient, handle };
    };
}

module.exports = {
    FEATURE_IDS,
    FEATURES,
    MANAGEABLE,
    FILE,
    COMMANDS_DIR,
    DEFAULT_CONFIG,
    EVERYTHING_ON,
    memoryFs,
    stateDoc,
    useState,
    useStateDoc,
    deriveActive,
    deriveServed,
    envKey,
    claimServed,
    expectedKeys,
    payloadNames,
    STEP_NAMES,
    FEATURE_STEPS,
    MARKERS,
    fakeDeps,
    quiet,
    FAKE_CLIENT,
    expectedReport,
    sortedByName,
    prefixOf,
    walkStack,
    stackOf,
    routeTable,
    concrete,
    keyOf,
    useBotBoot
};
