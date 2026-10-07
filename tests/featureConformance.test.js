/**
 * Cross-surface feature conformance (#322).
 *
 * The inventory (packages/core/features/inventory.js) is the only ownership
 * source; every gate (#318 commands/steps/events, #319 tools/MCP, #320
 * routes/sockets) reads it. Each per-surface spec proves one gate with one
 * feature at a time. This spec proves they agree: for every named PROFILE
 * the same invariant is derived from the inventory graph (never a hand list)
 * and checked at every surface kind:
 *
 *   served(claim) = owner and every alsoRequires are in the profile's served set
 *
 *   commands / context menus   the loader set equals the served set
 *   runtime steps              startCoreRuntime reports exactly the served steps; no marker of a skipped one
 *   event gates and adapters   the booted bot has exactly the served listeners, adapters and commands
 *   AI tools                   discovery offers only served tools; dispatch refuses the rest with no side effect
 *   MCP                        listings, calls, resources and the HTTP mount follow the claims
 *   HTTP routes                routeBlock agrees with every mounted route; a real request to each refused one is a 404
 *   WebSocket upgrades         a real upgrade is refused 404 exactly for the unserved paths
 *
 * Profiles: legacy-no-file, fresh-install, core-only, one-feature-off (every
 * manageable id), dependency combinations, env-override-only. The "served"
 * set is computed independently of featureState.js (see featureFixtures).
 *
 * Also here: inventory negative checks (an unclaimed surface fails closed,
 * invalid dependency declarations are rejected, core ownership is explicit),
 * the #321 hook, and the "loaded but not executed when off" report.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');
const WebSocket = require('ws');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-conformance-'));
process.env.GOOBSTER_DATA_DIR = ROOT;
process.env.GOOBSTER_UPLOADS_DIR = path.join(ROOT, 'uploads');
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'test.sqlite');

jest.mock('@goobster/core/services/aiService', () => ({
    chat: jest.fn(),
    generateText: jest.fn().mockResolvedValue(''),
    listProviders: () => [],
    supportsNativeWebSearch: jest.fn().mockReturnValue(false)
}));
jest.mock('@goobster/core/services/tableGames/tableManager', () => ({
    TableManager: jest.fn().mockImplementation(() => ({
        recoverFromJournal: jest.fn(async () => {}),
        stop: jest.fn()
    }))
}));
jest.mock('@goobster/core/services/tableGames/botPlayer', () => ({
    BotPlayer: jest.fn().mockImplementation(() => ({ stop: jest.fn() }))
}));
jest.mock('@goobster/core/services/serviceManager', () => ({
    voiceService: { _isInitialized: true, initialize: async () => {} },
    getVoiceService() { return this.voiceService; }
}));
jest.mock('@goobster/core/services/spotdl/spotdlService', () => class SpotDLServiceMock {});

const db = require('@goobster/core/db');
const inventory = require('@goobster/core/features/inventory');
const catalog = require('@goobster/core/features/catalog');
const gate = require('@goobster/core/features/gate');
const aiService = require('@goobster/core/services/aiService');
const mcpConfig = require('@goobster/core/config/mcpConfig');
const mcpTokenService = require('@goobster/core/services/mcpTokenService');
const eventBusService = require('@goobster/core/services/eventBusService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const featureGate = require('@goobster/core/web/featureGate');
const { features } = require('@goobster/core/features/featureState');
const { startCoreRuntime } = require('@goobster/core/runtime/coreRuntime');
const { featureCommandFilter, listCommandFiles } = require('@goobster/core/utils/commandDeployment');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const { createMcpApp, mountMcpIfEnabled } = require('@goobster/core/mcp/http');
const { TOOLS, toolDescriptors, callTool } = require('@goobster/core/mcp/tools');
const { listResourceTemplates, readResource } = require('@goobster/core/mcp/resources');
const { _resetForTests: resetMcpRate } = require('@goobster/core/mcp/rateLimit');
const {
    FEATURE_IDS,
    MANAGEABLE,
    COMMANDS_DIR,
    DEFAULT_CONFIG,
    EVERYTHING_ON,
    useState,
    useStateDoc,
    deriveActive,
    deriveServed,
    envKey,
    claimServed,
    expectedKeys,
    STEP_NAMES,
    FEATURE_STEPS,
    MARKERS,
    fakeDeps,
    quiet,
    FAKE_CLIENT,
    expectedReport,
    sortedByName,
    routeTable,
    concrete,
    keyOf,
    useBotBoot
} = require('./helpers/featureFixtures');

jest.setTimeout(120_000);

const USER = '620000000000000001';
const GUILD = '620000000000000100';
const silentLogger = { info() {}, debug() {}, warn() {}, error() {} };

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

function fileProfile(name, { inactive, config = EVERYTHING_ON, expectOff = null, expectOn = null }) {
    return {
        name,
        kind: 'file',
        served: deriveActive({ config, inactiveRequested: inactive }),
        apply: () => useState({ config, inactive }),
        boot: { config, inactive },
        expectOff,
        expectOn
    };
}

function envProfile(name, ids) {
    const env = Object.fromEntries(ids.map(id => [envKey(id), '0']));
    return {
        name,
        kind: 'env',
        served: deriveServed({ env }),
        apply: () => useState({ config: DEFAULT_CONFIG, env }),
        boot: { config: DEFAULT_CONFIG, env }
    };
}

function freshInstallProfile() {
    useState();
    const preset = features.freshPreset();
    const off = MANAGEABLE.filter(id => !preset.features[id].active);
    const doc = JSON.stringify({ ...preset, revision: 1, updatedAt: '2026-10-06 12:00:00' });
    return {
        name: 'fresh-install',
        kind: 'file',
        servedOff: off,
        served: deriveActive({ config: EVERYTHING_ON, inactiveRequested: off }),
        apply: () => useStateDoc(doc, { config: EVERYTHING_ON }),
        boot: { config: EVERYTHING_ON, file: doc }
    };
}

const LEGACY = {
    name: 'legacy-no-file',
    kind: 'legacy',
    served: new Set(FEATURE_IDS),
    apply: () => useState(),
    boot: { config: DEFAULT_CONFIG }
};

const FRESH = freshInstallProfile();
const CORE_ONLY = fileProfile('core-only', { inactive: MANAGEABLE });
const ONE_OFF = MANAGEABLE.map(id => fileProfile(`one-feature-off: ${id}`, { inactive: [id] }));
const COMBOS = [
    fileProfile('combo: sandbox off, so observatory off', { inactive: ['sandbox'], expectOff: ['sandbox', 'observatory'], expectOn: ['projects', 'knowledge'] }),
    fileProfile('combo: knowledge off, so expeditions off', { inactive: ['knowledge'], expectOff: ['knowledge', 'expeditions'], expectOn: ['projects', 'sandbox'] }),
    fileProfile('combo: economy off, so exchange and gambling off', { inactive: ['economy'], expectOff: ['economy', 'exchange', 'gambling'], expectOn: ['tavern', 'projects'] }),
    fileProfile('combo: discord off, so discordActivity off', { inactive: ['discord'], expectOff: ['discord', 'discordActivity'], expectOn: ['push', 'mail'] }),
    fileProfile('combo: github off, so cursor off', { inactive: ['github'], expectOff: ['github', 'cursor'], expectOn: ['discord', 'projects'] }),
    fileProfile('combo: economy and knowledge off together', { inactive: ['economy', 'knowledge'], expectOff: ['economy', 'exchange', 'gambling', 'knowledge', 'expeditions'], expectOn: ['tavern', 'sandbox'] })
];
const ENV_ONLY = [
    envProfile('env-override-only: sandbox', ['sandbox']),
    envProfile('env-override-only: knowledge', ['knowledge']),
    envProfile('env-override-only: economy', ['economy']),
    envProfile('env-override-only: discord', ['discord']),
    envProfile('env-override-only: github', ['github']),
    envProfile('env-override-only: gba and screenVision', ['gba', 'screenVision'])
];
const PROFILES = [LEGACY, FRESH, CORE_ONLY, ...ONE_OFF, ...COMBOS, ...ENV_ONLY];

/* ------------------------------------------------------------------ */
/* Derived invariants                                                  */
/* ------------------------------------------------------------------ */

/** The surface kinds the gates evaluate, with the inventory table that lists their identifiers. */
const GATED_KINDS = [
    ['command', inventory.commands],
    ['contextMenu', inventory.contextMenus],
    ['runtimeStep', inventory.runtimeSteps],
    ['eventGate', inventory.eventGates],
    ['interactionType', inventory.interactionTypes],
    ['aiTool', inventory.aiTools],
    ['mcpTool', inventory.mcpTools],
    ['mcpResource', inventory.mcpResources],
    ['wsPath', inventory.wsPaths]
];

const blockerOf = (claim, served) => [claim.owner, ...claim.alsoRequires].find(id => !served.has(id)) || null;

function claimedIds(kind, table) {
    return Object.keys(table).map(id => ({ kind, id, claim: inventory.ownerOf(kind, id) }));
}

const unclaimed = (kind, ids) => ids.filter(id => inventory.ownerOf(kind, id) === null);
const unclaimedFiles = (entries) => entries.filter(entry => inventory.ownerOf(entry.kind, entry.key) === null).map(entry => entry.key);

/* ------------------------------------------------------------------ */
/* Shared servers                                                      */
/* ------------------------------------------------------------------ */

const RECORDED = [
    'observatory', 'projectAssets', 'projectTriggers', 'projectMissions', 'spitball', 'spitballRunner',
    'briefs', 'transfers', 'exchange', 'voice', 'voiceLive', 'studioSongs', 'studioLive', 'push'
];
const serviceCalls = [];
function recorder(name) {
    return new Proxy({}, {
        get: (_target, property) => {
            if (property === 'then') return undefined;
            return (...args) => {
                serviceCalls.push(`${name}.${String(property)}`);
                return Promise.resolve({ args: args.length });
            };
        }
    });
}

let portal;
let portalBase;
let portalRouter;
let portalTable;
let distDir;
let cookie;
let mcpServer;
let mcpPort;
let wsServer;
let wsReached;
let wsBase;

function listen(app) {
    return new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
}

async function call(method, reqPath, { headers = {}, body } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (body !== undefined && !['GET', 'HEAD'].includes(method)) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    init.signal = AbortSignal.timeout(3000);
    let res;
    let text;
    try {
        res = await fetch(`${portalBase}${reqPath}`, init);
        text = await res.text();
    } catch (error) {
        return { status: 0, json: null, text: `no answer: ${error.name}`, headers: new Headers() };
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
}

function mcpRequest(token, body) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: mcpPort,
            path: '/mcp',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                accept: 'application/json',
                authorization: `Bearer ${token}`
            }
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function upgrade(wsPath) {
    return new Promise((resolve) => {
        const socket = new WebSocket(`${wsBase}${wsPath}`);
        socket.on('open', () => { socket.close(); resolve(101); });
        socket.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
        socket.on('error', () => {});
    });
}

beforeAll(async () => {
    LEGACY.apply();
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-conformance-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>stub</title>');
    const deps = { webDistDir: distDir };
    for (const name of RECORDED) deps[name] = recorder(name);
    const ctx = createWebAppContext({
        gateway: { sendDm: async () => ({}), sendToChannel: async () => ({}) },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: silentLogger,
        deps
    });
    portalRouter = createWebAppApp(ctx);
    const app = express();
    app.use(portalRouter);
    portal = await listen(app);
    portalBase = `http://127.0.0.1:${portal.address().port}`;
    // The first query of a suite applies the whole schema (an isolated
    // Postgres schema takes several seconds); do it here rather than
    // inside the 3 s window `call()` gives one request.
    await db.get('SELECT 1 AS ok');
    const login = await call('POST', '/api/app/auth/dev-session', { body: { userId: USER, name: 'Conformance tester' } });
    const setCookie = login.headers.get('set-cookie');
    if (login.status !== 200 || !setCookie) {
        throw new Error(`dev-session login failed: HTTP ${login.status} ${login.text}`);
    }
    cookie = setCookie.split(';')[0];
    portalTable = routeTable(portalRouter).filter(route => !/[()*\\]/.test(route.path));

    mcpConfig._setForTests({ enabled: true, requestsPerMinute: 100000, maxTokensPerUser: 1000 });
    const mcpApp = express();
    mcpApp.use('/mcp', createMcpApp({ logger: silentLogger }));
    mcpServer = await listen(mcpApp);
    mcpPort = mcpServer.address().port;

    wsReached = [];
    wsServer = http.createServer((_req, res) => res.end('ok'));
    featureGate.rejectBlockedUpgrades(wsServer);
    const sockets = new WebSocket.Server({ noServer: true });
    wsServer.on('upgrade', (request, socket, head) => {
        if (socket.destroyed) return;
        sockets.handleUpgrade(request, socket, head, (client) => {
            wsReached.push(new URL(request.url, 'http://localhost').pathname);
            client.close();
        });
    });
    await new Promise(resolve => wsServer.listen(0, '127.0.0.1', resolve));
    wsBase = `ws://127.0.0.1:${wsServer.address().port}`;
});

afterAll(async () => {
    jest.restoreAllMocks();
    mcpConfig._setForTests(null);
    await new Promise(resolve => portal.close(resolve));
    await new Promise(resolve => mcpServer.close(resolve));
    wsServer.closeAllConnections?.();
    await new Promise(resolve => wsServer.close(resolve));
    await eventBusService.close();
    features._resetForTests({});
    await db.closeConnection();
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Profile sanity                                                      */
/* ------------------------------------------------------------------ */

describe('the profiles are what they claim to be', () => {
    test('there is a profile for every kind the issue names, and one-feature-off covers every manageable feature', () => {
        expect(PROFILES.map(profile => profile.kind)).toEqual(expect.arrayContaining(['legacy', 'file', 'env']));
        expect(ONE_OFF.map(profile => profile.name)).toEqual(MANAGEABLE.map(id => `one-feature-off: ${id}`));
        expect(MANAGEABLE.length).toBe(FEATURE_IDS.length - 1);
        expect(catalog.FEATURE_IDS).toEqual(FEATURE_IDS);
    });

    test.each(PROFILES.map(profile => [profile.name, profile]))('%s: the independent served set is the one the state resolver enforces', (_name, profile) => {
        profile.apply();
        for (const id of FEATURE_IDS) {
            const enforced = features.enforcedOff(id);
            expect([id, !enforced]).toEqual([id, profile.served.has(id)]);
        }
    });

    test('core is served in every profile and core-only serves nothing else', () => {
        for (const profile of PROFILES) expect(profile.served.has('core')).toBe(true);
        expect([...CORE_ONLY.served]).toEqual(['core']);
    });

    test('legacy-no-file reports some features off yet refuses nothing', () => {
        LEGACY.apply();
        expect(deriveActive().has('observatory')).toBe(false);
        expect(features.isActive('observatory')).toBe(false);
        expect(features.enforcedOff('observatory')).toBe(false);
        for (const id of FEATURE_IDS) expect(features.enforcedOff(id)).toBe(false);
    });

    test('fresh-install: records what the preset turns off, and that it is a strict subset of the manageable set', () => {
        expect(FRESH.servedOff.length).toBeGreaterThan(0);
        expect(FRESH.servedOff.length).toBeLessThan(MANAGEABLE.length);
        for (const id of FRESH.servedOff) expect(catalog.get(id).freshDefault).toBe('off');
        process.stdout.write(`fresh-install preset turns off: ${FRESH.servedOff.join(', ')}\n`);
        process.stdout.write(`fresh-install served set: ${[...FRESH.served].join(', ')}\n`);
    });

    test.each(COMBOS.map(profile => [profile.name, profile]))('%s', (_name, profile) => {
        for (const id of profile.expectOff) expect([id, profile.served.has(id)]).toEqual([id, false]);
        for (const id of profile.expectOn) expect([id, profile.served.has(id)]).toEqual([id, true]);
    });

    test('discord off takes down every Discord-bound alsoRequires claim, by the inventory', () => {
        const discordBound = [];
        for (const [kind, table] of GATED_KINDS) {
            for (const entry of claimedIds(kind, table)) {
                if (entry.claim.alsoRequires.includes('discord')) discordBound.push(entry);
            }
        }
        expect(discordBound.length).toBeGreaterThan(3);
        const discordOff = COMBOS.find(profile => profile.name.startsWith('combo: discord'));
        for (const entry of discordBound) {
            expect([entry.kind, entry.id, claimServed(entry.claim, discordOff.served)]).toEqual([entry.kind, entry.id, false]);
        }
    });
});

/* ------------------------------------------------------------------ */
/* Surface: the central rule at every gated kind                       */
/* ------------------------------------------------------------------ */

describe.each(PROFILES.map(profile => [profile.name, profile]))('%s', (_name, profile) => {
    beforeEach(() => profile.apply());

    test('gate.requireSurface answers the inventory rule for every claimed command, step, event, interaction, tool, MCP item and socket', () => {
        const disagreements = [];
        let checked = 0;
        for (const [kind, table] of GATED_KINDS) {
            for (const { id, claim } of claimedIds(kind, table)) {
                checked += 1;
                const result = gate.requireSurface(kind, id);
                const blocker = claimServed(claim, profile.served) ? null : blockerOf(claim, profile.served);
                if (blocker === null && result !== null) disagreements.push(`${kind} ${id}: refused (${result.feature})`);
                if (blocker !== null && (!result || result.code !== 'FEATURE_UNAVAILABLE' || result.feature !== blocker)) {
                    disagreements.push(`${kind} ${id}: expected ${blocker}, got ${result && result.feature}`);
                }
            }
        }
        expect(checked).toBeGreaterThan(200);
        expect(disagreements).toEqual([]);
    });

    test('commands and context menus: the loader set is the served set', () => {
        const listed = listCommandFiles(COMMANDS_DIR, { filter: featureCommandFilter });
        expect(listed.active.map(entry => entry.key).sort()).toEqual(expectedKeys(profile.served));
        const unfiltered = listCommandFiles(COMMANDS_DIR);
        expect(listed.active.length + listed.inactive.length).toBe(unfiltered.active.length);
        for (const entry of listed.inactive) {
            expect(claimServed(inventory.ownerOf(entry.kind, entry.key), profile.served)).toBe(false);
        }
        if (profile.kind === 'legacy') {
            expect(listed.active.map(entry => entry.key).sort()).toEqual(unfiltered.active.map(entry => entry.key).sort());
            expect(listed.inactive).toEqual([]);
        }
    });

    test('runtime steps: the report is the served steps, a skipped step is never touched', async () => {
        const log = [];
        const logger = quiet();
        const chat = aiService.chat.mock.calls.length;
        const fetchSpy = jest.spyOn(global, 'fetch');
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger, deps: fakeDeps(log) });
        try {
            expect(sortedByName(runtime.report)).toEqual(sortedByName(expectedReport(profile.served)));
            const expectedSkipped = FEATURE_STEPS.filter(name => !profile.served.has(inventory.ownerOf('runtimeStep', name).owner));
            expect([...runtime.featureSkipped].sort()).toEqual([...expectedSkipped].sort());
            for (const name of runtime.featureSkipped) {
                expect([name, log.includes(MARKERS[name])]).toEqual([name, false]);
                expect(runtime.started).not.toContain(name);
            }
            expect(runtime.report.filter(row => row.status === 'failed')).toEqual([]);
            if (profile === CORE_ONLY) {
                for (const name of FEATURE_STEPS) expect(log).not.toContain(MARKERS[name]);
                expect(runtime.featureSkipped.sort()).toEqual([...FEATURE_STEPS].sort());
            }
            expect(aiService.chat.mock.calls.length).toBe(chat);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
            await runtime.stop();
        }
    });

    test('AI tools: discovery offers only served tools; dispatch refuses the rest before any side effect', async () => {
        const offered = (await toolsRegistry.getDefinitions(undefined, { isWeb: true })).map(def => def.name);
        const servedTools = [];
        const blockedTools = [];
        for (const name of toolsRegistry.TOOL_ORDER) {
            const claim = inventory.ownerOf('aiTool', name);
            expect([name, claim === null]).toEqual([name, false]);
            (claimServed(claim, profile.served) ? servedTools : blockedTools).push(name);
        }
        for (const name of blockedTools) expect([name, offered.includes(name)]).toEqual([name, false]);
        for (const name of offered) expect([name, servedTools.includes(name)]).toEqual([name, true]);
        if (profile === CORE_ONLY) {
            const coreTools = servedTools.filter(name => inventory.ownerOf('aiTool', name).alsoRequires.length === 0);
            expect(offered.length).toBe(coreTools.length);
            expect(offered.length).toBeGreaterThan(10);
        }

        const writes = [jest.spyOn(db, 'run'), jest.spyOn(db, 'insert'), jest.spyOn(db, 'transaction')];
        const fetchSpy = jest.spyOn(global, 'fetch');
        const chat = aiService.chat.mock.calls.length;
        const generate = aiService.generateText.mock.calls.length;
        const interactionContext = { channelId: '620000000000000200', guildId: GUILD, user: { id: USER }, member: { id: USER }, guild: { id: GUILD } };
        try {
            for (const name of blockedTools) {
                const result = await toolsRegistry.execute(name, { interactionContext });
                const blocker = blockerOf(inventory.ownerOf('aiTool', name), profile.served);
                expect([name, result.ok, result.code, result.feature]).toEqual([name, false, 'FEATURE_UNAVAILABLE', blocker]);
            }
            for (const spy of writes) expect(spy).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(aiService.chat.mock.calls.length).toBe(chat);
            expect(aiService.generateText.mock.calls.length).toBe(generate);
        } finally {
            for (const spy of [...writes, fetchSpy]) spy.mockRestore();
        }
    });

    test('MCP: listings, calls, resources and the HTTP mount follow the claims', async () => {
        const names = TOOLS.map(tool => tool.name);
        expect(names.length).toBeGreaterThan(10);
        for (const name of names) expect([name, inventory.ownerOf('mcpTool', name) === null]).toEqual([name, false]);
        const expectedTools = names.filter(name => claimServed(inventory.ownerOf('mcpTool', name), profile.served));
        expect(toolDescriptors().map(tool => tool.name).sort()).toEqual([...expectedTools].sort());

        const blockedTools = names.filter(name => !expectedTools.includes(name));
        for (const name of blockedTools) {
            await expect(callTool(USER, name, {}, { scope: 'read' })).rejects.toMatchObject({
                rpcCode: -32602, publicMessage: `${name} is not available on this installation.`
            });
        }

        const expectedTemplates = Object.keys(inventory.mcpResources)
            .filter(uri => claimServed(inventory.ownerOf('mcpResource', uri), profile.served)).sort();
        expect(listResourceTemplates('read').resourceTemplates.map(entry => entry.uriTemplate).sort()).toEqual(expectedTemplates);
        if (!profile.served.has('expeditions')) {
            await expect(readResource(USER, 'read', 'goobster://briefs/1')).rejects.toMatchObject({ rpcCode: -32002 });
        }

        const created = await mcpTokenService.create({ userId: USER, label: `conformance ${profile.name}`.slice(0, 60) });
        resetMcpRate();
        const ping = await mcpRequest(created.token, { jsonrpc: '2.0', id: 1, method: 'ping' });
        // MCP is a legacy default-off flag (mcp.enabled): with no state file the mount keeps reading that flag, so only file-backed profiles serve HTTP.
        if (profile.served.has('mcp') && profile.kind === 'file') {
            expect(ping.status).toBe(200);
            const listed = await mcpRequest(created.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
            expect(listed.json.result.tools.map(tool => tool.name).sort()).toEqual([...expectedTools].sort());
        } else {
            expect(ping.status).toBe(404);
            expect(ping.json).toEqual({ error: 'FEATURE_UNAVAILABLE', feature: 'mcp' });
            expect(mountMcpIfEnabled(express(), { logger: { info() {} } })).toBe(false);
        }
        await mcpTokenService.revoke({ userId: USER, id: created.id });
        const revoked = await db.get('SELECT revokedAt FROM mcp_tokens WHERE id = @id', { id: created.id });
        expect(revoked.revokedAt).toBeTruthy();
    });

    test('HTTP routes: routeBlock agrees with every mounted route, and each refused route answers 404 to a real request', async () => {
        expect(portalTable.length).toBeGreaterThan(300);
        const refused = [];
        for (const route of portalTable) {
            const claim = inventory.ownerOf('route', route.path, route.method);
            expect([keyOf(route), claim === null]).toEqual([keyOf(route), false]);
            const blocker = claimServed(claim, profile.served) ? null : blockerOf(claim, profile.served);
            expect([keyOf(route), featureGate.routeBlock(concrete(route.path), route.method)]).toEqual([keyOf(route), blocker]);
            if (blocker) refused.push({ route, blocker });
        }
        if (profile === CORE_ONLY) expect(refused.length).toBeGreaterThan(100);
        if (profile.kind === 'legacy') expect(refused).toEqual([]);

        const writes = [jest.spyOn(db, 'run'), jest.spyOn(db, 'insert'), jest.spyOn(db, 'transaction')];
        const fetchSpy = jest.spyOn(global, 'fetch');
        serviceCalls.length = 0;
        const failures = [];
        try {
            for (const { route, blocker } of refused) {
                const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) ? { body: {} } : {};
                const res = await call(route.method, concrete(route.path), { headers: { Cookie: cookie }, ...body });
                if (res.status !== 404 || res.json?.error?.code !== 'FEATURE_UNAVAILABLE' || res.json?.feature !== blocker) {
                    failures.push(`${keyOf(route)} -> ${res.status} ${res.text.slice(0, 80)}`);
                }
            }
            const outbound = fetchSpy.mock.calls.filter(([url]) => !String(url).startsWith(portalBase));
            expect(failures).toEqual([]);
            expect(writes.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0]);
            expect(outbound).toEqual([]);
            expect(serviceCalls).toEqual([]);
        } finally {
            for (const spy of [...writes, fetchSpy]) spy.mockRestore();
        }
    });

    test('HTTP routes: the core operator, privacy, Inbox, export, settings and status routes are served in every profile', async () => {
        const core = [
            ['GET', '/api/app/config'],
            ['GET', '/api/app/me'],
            ['GET', '/api/app/features'],
            ['GET', '/api/app/inbox'],
            ['GET', '/api/app/inbox/unread'],
            ['GET', '/api/app/account'],
            ['GET', '/api/app/settings/exports'],
            ['GET', '/api/app/settings/export'],
            ['GET', '/api/app/admin/limits'],
            ['GET', '/api/app/admin/instance'],
            ['GET', '/api/app/admin/audit'],
            ['POST', '/api/app/privacy/forget']
        ];
        for (const [method, reqPath] of core) {
            expect([method, reqPath, featureGate.routeBlock(reqPath, method)]).toEqual([method, reqPath, null]);
        }
        for (const reqPath of ['/api/app/config', '/api/app/me', '/api/app/features', '/api/app/inbox', '/api/app/account', '/api/app/settings/exports']) {
            const res = await call('GET', reqPath, { headers: { Cookie: cookie } });
            expect([reqPath, res.status]).toEqual([reqPath, 200]);
        }
        const status = await call('GET', '/api/app/features', { headers: { Cookie: cookie } });
        expect(Object.keys(status.json.features)).toEqual([...FEATURE_IDS]);
        for (const id of FEATURE_IDS) expect([id, status.json.features[id].active === profile.served.has(id) || profile.kind !== 'file']).toEqual([id, true]);
    });

    test('WebSocket upgrades: a real upgrade is refused 404 exactly for the unserved paths and never reaches a handler', async () => {
        wsReached.length = 0;
        const wsPaths = Object.keys(inventory.wsPaths);
        expect(wsPaths.length).toBeGreaterThan(4);
        const expectedReached = [];
        for (const wsPath of wsPaths) {
            const claim = inventory.ownerOf('wsPath', wsPath);
            const served = claimServed(claim, profile.served);
            const status = await upgrade(wsPath);
            expect([wsPath, status]).toEqual([wsPath, served ? 101 : 404]);
            expect([wsPath, featureGate.wsBlock(wsPath)]).toEqual([wsPath, served ? null : blockerOf(claim, profile.served)]);
            if (served) expectedReached.push(wsPath);
        }
        expect(wsReached.sort()).toEqual(expectedReached.sort());
    });
});

/* ------------------------------------------------------------------ */
/* Surface: the bot process (event gates, listeners, adapters, loader) */
/* ------------------------------------------------------------------ */

describe('bot process boot: listeners, adapters and the loader follow the profile', () => {
    const boot = useBotBoot();

    test.each(PROFILES.map(profile => [profile.name, profile]))('%s', async (_name, profile) => {
        const { client, readyClient, handle } = await boot(profile.boot);
        const served = profile.served;

        expect(client.commands.size).toBe(expectedKeys(served).length);
        expect(handle.runtimeStarted).toBe(1);

        const gateServed = (name) => claimServed(inventory.ownerOf('eventGate', name), served);
        expect(client.listenerCount('voiceStateUpdate')).toBe(gateServed('voiceStateUpdate') ? 1 : 0);
        // The music service lives inside the voice stack, so apps/bot/index.js registers the presence listeners only when voice is served as well; the inventory claims them as music alone, which is the looser of the two.
        const playbackListeners = (name) => (gateServed(name) && gateServed('voiceStateUpdate') ? 1 : 0);
        expect(readyClient.listenerCount('musicTrackStarted')).toBe(playbackListeners('musicTrackStarted'));
        expect(readyClient.listenerCount('musicTrackEnded')).toBe(playbackListeners('musicTrackEnded'));
        if (!gateServed('voiceStateUpdate')) expect(handle.voice.initialize).not.toHaveBeenCalled();

        const adapterServed = (key) => claimServed(inventory.ownerOf('command', key), served);
        expect(Boolean(handle.adapters.playTrack)).toBe(adapterServed('music/playtrack.js'));
        expect(Boolean(handle.adapters.speak)).toBe(adapterServed('chat/speak.js'));
        expect(Boolean(handle.adapters.nickname)).toBe(adapterServed('settings/nickname.js'));

        const reaction = { emoji: { name: '📋' }, partial: false, message: { guild: null, id: '1', channel: { id: '2' } } };
        client.emit('messageReactionAdd', reaction, { id: USER, tag: 'u#1', bot: false });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(handle.reactions).toEqual(gateServed('messageReactionAdd:issue-capture') ? ['📋'] : []);
    });
});

/* ------------------------------------------------------------------ */
/* #321 hook                                                           */
/* ------------------------------------------------------------------ */

/**
 * Portal rooms, tutorials and self-docs (#321). These surfaces act on the
 * *reported* state (`features.isActive`): navigation hides and explains, it
 * never refuses, so with no state file the portal shows exactly what the
 * legacy flags showed. Refusal (tutorial launch) follows the enforcement
 * rule like every other surface. Three invariants per profile:
 *   rooms      a room or nested view is available <=> every feature it
 *              requires is reported active; its `requires` names the same
 *              features as the inventory claim
 *   tutorials  a tour is listed available <=> its required features are
 *              reported active; `gate.requireSurface('tutorial', id)`
 *              refuses exactly the tours whose claim is not served
 *   self-docs  the corpus is never hidden: every seeded doc is listed in
 *              every profile, and a doc tagged `feature:<id>` carries an
 *              availability note <=> that feature is reported inactive
 */
const tutorialCatalog = require('@goobster/core/config/tutorialCatalog');
const tutorialService = require('@goobster/core/services/tutorialService');
const selfDocsService = require('@goobster/core/services/selfDocsService');
const rooms = require('../apps/web/src/lib/rooms.cjs');

/** The feature ids a claim names beyond core, sorted. */
const claimFeatures = (claim) => [claim.owner, ...claim.alsoRequires].filter(id => id !== 'core').sort();

/** The reported-active set for the applied state. */
const reportedActive = () => new Set(FEATURE_IDS.filter(id => features.isActive(id)));

/**
 * A signed-in viewer as the portal client sees one in this state: the
 * sanitized status route plus the legacy `me.features` / `me.discord`
 * flags, which the server derives from the same switches.
 */
function viewerFor(active) {
    return {
        identity: { operator: true },
        features: { projects: active.has('projects'), observatory: active.has('observatory'), spitball: active.has('expeditions') },
        discord: { enabled: active.has('discord') },
        featureStatus: featureGate.sanitizeStatus(features.status())
    };
}

describe('#321: rooms, tutorials and self-docs follow the reported state; tutorial launch follows the enforcement rule', () => {
    let seededDocs = null;

    beforeAll(async () => {
        useState();
        await selfDocsService.seed();
        seededDocs = await selfDocsService.listDocs({ includeOperator: true });
        expect(seededDocs.length).toBeGreaterThan(20);
        expect(seededDocs.filter(doc => doc.feature).length).toBeGreaterThan(5);
    });

    test('the inventory claims every room and tutorial, and each declares the same features its claim names', () => {
        for (const room of rooms.ROOMS) {
            const claim = inventory.ownerOf('room', room.id);
            expect([room.id, claim]).not.toEqual([room.id, null]);
            expect([room.id, rooms.requiredFeatures(room.requires).sort()]).toEqual([room.id, claimFeatures(claim)]);
        }
        for (const tutorial of tutorialCatalog.TUTORIALS) {
            const claim = inventory.ownerOf('tutorial', tutorial.id);
            expect([tutorial.id, claim]).not.toEqual([tutorial.id, null]);
            expect([tutorial.id, tutorialCatalog.requiredFeatureIds(tutorial.requires).sort()]).toEqual([tutorial.id, claimFeatures(claim)]);
        }
        expect(Object.keys(inventory.rooms).sort()).toEqual(rooms.ROOMS.map(room => room.id).sort());
        expect(Object.keys(inventory.tutorials).sort()).toEqual(tutorialCatalog.TUTORIALS.map(tutorial => tutorial.id).sort());
    });

    describe.each(PROFILES.map(profile => [profile.name, profile]))('%s', (_name, profile) => {
        beforeEach(() => profile.apply());

        test('reported-active is never wider than served: an enforced-off feature is reported inactive', () => {
            for (const id of reportedActive()) expect([id, profile.served.has(id)]).toEqual([id, true]);
            if (profile.kind !== 'legacy') {
                // With a file or override in force the two coincide (EVERYTHING_ON legacy switches).
                if (profile.kind === 'file') expect([...reportedActive()].sort()).toEqual([...profile.served].sort());
            }
        });

        test('rooms and nested views: available exactly when every required feature is reported active, and a deep link explains the rest', () => {
            const active = reportedActive();
            const me = viewerFor(active);
            for (const room of rooms.ROOMS) {
                if (room.requires?.operator) continue;
                const expected = rooms.requiredFeatures(room.requires).every(id => active.has(id));
                expect([room.id, rooms.isRoomAvailable(room, me)]).toEqual([room.id, expected]);
                const unavailable = rooms.routeUnavailability(`/app${room.path}`, me);
                expect([room.id, unavailable === null]).toEqual([room.id, expected]);
                if (!expected) {
                    expect(unavailable.level).toBe('room');
                    expect(active.has(unavailable.feature)).toBe(false);
                    expect(typeof unavailable.sentence).toBe('string');
                }
                for (const view of room.views || []) {
                    const viewExpected = rooms.requiredFeatures(view.requires).every(id => active.has(id));
                    expect([room.id, view.id, rooms.isViewAvailable(room, view, me)]).toEqual([room.id, view.id, viewExpected]);
                    if (expected && !viewExpected) {
                        expect(rooms.routeUnavailability(`/app${view.path}`, me)?.level).toBe('view');
                    }
                }
            }
        });

        test('tutorials: listed available exactly when reported active; launch refused exactly when the claim is not served', () => {
            const active = reportedActive();
            for (const tutorial of tutorialCatalog.TUTORIALS) {
                const required = tutorialCatalog.requiredFeatureIds(tutorial.requires);
                const availability = tutorialService.tutorialAvailability(tutorial, {});
                const expected = required.every(id => active.has(id));
                expect([tutorial.id, availability.available]).toEqual([tutorial.id, expected]);
                if (!expected) {
                    expect(required).toContain(availability.feature);
                    expect(availability.reasons.length).toBeGreaterThan(0);
                }
                const claim = inventory.ownerOf('tutorial', tutorial.id);
                const refusal = gate.requireSurface('tutorial', tutorial.id);
                const blocker = claimServed(claim, profile.served) ? null : blockerOf(claim, profile.served);
                expect([tutorial.id, refusal && refusal.feature]).toEqual([tutorial.id, blocker]);
            }
        });

        test('self-docs: nothing is hidden; a doc is annotated exactly when the feature it describes is reported inactive', async () => {
            const active = reportedActive();
            const docs = await selfDocsService.listDocs({ includeOperator: true });
            expect(docs.map(doc => doc.slug).sort()).toEqual(seededDocs.map(doc => doc.slug).sort());
            for (const doc of docs) {
                const known = doc.feature && catalog.get(doc.feature);
                const expected = Boolean(known) && !active.has(doc.feature);
                expect([doc.slug, doc.unavailable !== null]).toEqual([doc.slug, expected]);
                if (expected) {
                    expect(doc.unavailable.feature).toBe(doc.feature);
                    expect(doc.unavailable.note).toMatch(/Not available on this installation/);
                }
            }
        });
    });
});

/* ------------------------------------------------------------------ */
/* Inventory negative checks                                           */
/* ------------------------------------------------------------------ */

describe('inventory negative checks: an unclaimed surface fails closed', () => {
    test('requireSurface throws UNCLAIMED_SURFACE for an id no feature owns, for every gated kind', () => {
        useState({ inactive: [] });
        for (const [kind] of GATED_KINDS) {
            let error;
            try { gate.requireSurface(kind, `zz-unclaimed-${kind}`); } catch (thrown) { error = thrown; }
            expect([kind, error && error.code]).toEqual([kind, 'UNCLAIMED_SURFACE']);
        }
        expect(() => gate.requireSurface('route', '/api/app/zz-unclaimed', 'GET')).toThrow(/No feature owns route/);
    });

    test('an unclaimed command file is neither loaded nor deployed: the lister fails it closed with UNCLAIMED_SURFACE', () => {
        useState({ inactive: ['economy'] });
        const dir = fs.mkdtempSync(path.join(ROOT, 'commands-'));
        fs.cpSync(COMMANDS_DIR, dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'chat', 'zz-ghost.js'), "module.exports = {};\n// .setName('zz-ghost')\n");
        expect(() => featureCommandFilter('command', 'chat/zz-ghost.js')).toThrow(/No feature owns/);
        const real = listCommandFiles(COMMANDS_DIR, { filter: featureCommandFilter });
        expect(real.inactive.filter(entry => entry.reason === 'UNCLAIMED_SURFACE')).toEqual([]);
        const listed = listCommandFiles(dir, { filter: featureCommandFilter });
        expect(listed.active.map(entry => entry.key)).not.toContain('chat/zz-ghost.js');
        const ghost = listed.inactive.find(entry => entry.key === 'chat/zz-ghost.js');
        expect(ghost && ghost.reason).toBe('UNCLAIMED_SURFACE');
        expect(unclaimedFiles(listCommandFiles(dir).active)).toEqual(['chat/zz-ghost.js']);
        expect(unclaimedFiles(listCommandFiles(COMMANDS_DIR).active)).toEqual([]);
    });

    test.each([
        ['aiTool', 'checkPoints', inventory.aiTools],
        ['runtimeStep', 'ledgerRetention', inventory.runtimeSteps],
        ['mcpTool', 'list_docs', inventory.mcpTools],
        ['interactionType', 'friendreq', inventory.interactionTypes],
        ['eventGate', 'voiceStateUpdate', inventory.eventGates],
        ['wsPath', '/api/app/parlor/live', inventory.wsPaths]
    ])('a %s whose claim is removed (%s) is found by the inventory check and refused by the gate', async (kind, id, table) => {
        useState({ inactive: [] });
        const real = inventory.ownerOf;
        const spy = jest.spyOn(inventory, 'ownerOf').mockImplementation((k, i, m) => (k === kind && i === id ? null : real(k, i, m)));
        try {
            expect(unclaimed(kind, Object.keys(table))).toEqual([id]);
            let error;
            try { gate.requireSurface(kind, id); } catch (thrown) { error = thrown; }
            expect(error && error.code).toBe('UNCLAIMED_SURFACE');
            expect(error.kind).toBe(kind);
            if (kind === 'aiTool') {
                const result = await toolsRegistry.execute(id, {});
                expect(result).toMatchObject({ ok: false, code: 'FEATURE_UNAVAILABLE', reasons: [{ code: 'UNCLAIMED_SURFACE' }] });
                const offered = (await toolsRegistry.getDefinitions(undefined, { isWeb: true })).map(def => def.name);
                expect(offered).not.toContain(id);
            }
        } finally {
            spy.mockRestore();
        }
        expect(unclaimed(kind, Object.keys(table))).toEqual([]);
    });

    test('an unclaimed route is found by the inventory check (the network edge never gates an unclaimed path, so this check is the safety net)', () => {
        const mounted = [...portalTable, { method: 'GET', path: '/api/app/zz-unclaimed-route' }];
        const missing = mounted.filter(route => inventory.ownerOf('route', route.path, route.method) === null).map(keyOf);
        expect(missing).toEqual(['GET /api/app/zz-unclaimed-route']);
        useState({ inactive: MANAGEABLE });
        expect(featureGate.routeBlock('/api/app/zz-unclaimed-route', 'GET')).toBeNull();
    });
});

describe('inventory negative checks: invalid dependency declarations are rejected', () => {
    const clone = () => {
        const copy = Object.fromEntries(catalog.FEATURE_IDS.map(id => [id, { ...catalog.FEATURES[id], dependsOn: [...catalog.FEATURES[id].dependsOn] }]));
        return { FEATURE_IDS: [...catalog.FEATURE_IDS], FEATURES: copy };
    };

    test('the shipped catalog validates', () => {
        expect(catalog.validateCatalog()).toBe(true);
        expect(catalog.validateCatalog(clone())).toBe(true);
    });

    test.each([
        ['an unknown dependency', (candidate) => { candidate.FEATURES.tavern.dependsOn.push('nonexistent'); }, 'UNKNOWN_DEPENDENCY'],
        ['a dependency cycle', (candidate) => { candidate.FEATURES.economy.dependsOn.push('exchange'); }, 'DEPENDENCY_CYCLE'],
        ['core depending on something', (candidate) => { candidate.FEATURES.core.dependsOn.push('economy'); }, 'CORE_HAS_DEPENDENCIES'],
        ['a feature depending on core', (candidate) => { candidate.FEATURES.tavern.dependsOn.push('core'); }, 'CORE_AS_DEPENDENCY'],
        ['a feature depending on itself', (candidate) => { candidate.FEATURES.tavern.dependsOn.push('tavern'); }, 'SELF_DEPENDENCY'],
        ['a duplicate id', (candidate) => { candidate.FEATURE_IDS.push('tavern'); }, 'DUPLICATE_ID'],
        ['a descriptor with no id entry', (candidate) => { candidate.FEATURES.ghost = { ...candidate.FEATURES.tavern, id: 'ghost' }; }, 'UNLISTED_DESCRIPTOR']
    ])('catalog.validateCatalog rejects %s', (_label, mutate, code) => {
        const candidate = clone();
        mutate(candidate);
        let error;
        try { catalog.validateCatalog(candidate); } catch (thrown) { error = thrown; }
        expect(error && error.code).toBe(code);
    });

    test('featureState refuses to write an unknown id, a core entry, or a dependent without its dependency', async () => {
        const memory = useStateDoc(JSON.stringify({ version: 1, revision: 1, updatedAt: null, origin: 'operator', features: {} }));
        const write = (entries) => features.write({ origin: 'operator', features: entries }, { expectedRevision: 1 });
        await expect(write({ nonexistent: { installed: true, active: true } })).rejects.toMatchObject({ code: 'UNKNOWN_FEATURE' });
        await expect(write({ core: { installed: true, active: false } })).rejects.toMatchObject({ code: 'CORE_IMMUTABLE' });
        const base = Object.fromEntries(MANAGEABLE.map(id => [id, { installed: true, active: true }]));
        await expect(write({ ...base, sandbox: { installed: true, active: false } })).rejects.toMatchObject({ code: 'DEPENDENCY_CONFLICT' });
        await expect(write({ ...base, economy: { installed: true, active: false } })).rejects.toMatchObject({ code: 'DEPENDENCY_CONFLICT' });
        expect(memory.files.get('/virtual/data/features.json')).toContain('"revision":1');
    });
});

describe('inventory negative checks: core ownership is explicit', () => {
    test('every mounted portal route has an inventory rule, and the core ones are matched by a core rule, not by absence', () => {
        const unowned = portalTable.filter(route => inventory.ownerOf('route', route.path, route.method) === null).map(keyOf);
        expect(unowned).toEqual([]);
        const coreRoutes = portalTable.filter(route => inventory.ownerOf('route', route.path, route.method).owner === 'core');
        expect(coreRoutes.length).toBeGreaterThan(100);
        const coreRules = inventory.routeRules.filter(rule => rule.owner === 'core');
        expect(coreRules.length).toBeGreaterThan(5);
        for (const route of coreRoutes) {
            const rule = inventory.routeRules.find(candidate => (!candidate.method || candidate.method === route.method) && candidate.pattern.test(route.path.toLowerCase().replace(/\/+$/, '') || '/'));
            expect([keyOf(route), rule && rule.owner]).toEqual([keyOf(route), 'core']);
        }
    });

    test('every runtime step and every AI tool the registry can run is listed by name', () => {
        expect(STEP_NAMES.filter(name => inventory.ownerOf('runtimeStep', name) === null)).toEqual([]);
        expect(toolsRegistry.TOOL_ORDER.filter(name => inventory.ownerOf('aiTool', name) === null)).toEqual([]);
        const coreSteps = STEP_NAMES.filter(name => inventory.ownerOf('runtimeStep', name).owner === 'core');
        const coreTools = toolsRegistry.TOOL_ORDER.filter(name => inventory.ownerOf('aiTool', name).owner === 'core');
        expect(coreSteps.length).toBeGreaterThan(5);
        expect(coreTools.length).toBeGreaterThan(10);
        for (const name of coreSteps) expect(Object.prototype.hasOwnProperty.call(inventory.runtimeSteps, name)).toBe(true);
        for (const name of coreTools) expect(Object.prototype.hasOwnProperty.call(inventory.aiTools, name)).toBe(true);
    });

    test('every command, MCP tool, socket path and static asset prefix is listed by name as well', () => {
        const everyKey = listCommandFiles(COMMANDS_DIR).active.map(entry => entry.key);
        expect(unclaimed('command', everyKey.filter(key => inventory.commands[key] !== undefined))).toEqual([]);
        for (const entry of listCommandFiles(COMMANDS_DIR).active) {
            const table = entry.kind === 'contextMenu' ? inventory.contextMenus : inventory.commands;
            expect([entry.key, Object.prototype.hasOwnProperty.call(table, entry.key)]).toEqual([entry.key, true]);
        }
        for (const name of TOOLS.map(tool => tool.name)) expect(Object.prototype.hasOwnProperty.call(inventory.mcpTools, name)).toBe(true);
        for (const wsPath of Object.keys(inventory.wsPaths)) expect(inventory.ownerOf('wsPath', wsPath)).not.toBeNull();
        for (const prefix of Object.keys(inventory.staticAssets)) expect(inventory.ownerOf('staticAsset', prefix)).not.toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Loaded but not executed when off                                    */
/* ------------------------------------------------------------------ */

describe('module loading versus execution (report, not a failure)', () => {
    function probe(off) {
        const dir = fs.mkdtempSync(path.join(ROOT, off ? 'probe-off-' : 'probe-on-'));
        const env = { ...process.env, GOOBSTER_DB_PATH: path.join(dir, 'probe.sqlite') };
        delete env.GOOBSTER_DB_URL;
        delete env.GOOBSTER_PG_TEST_ISOLATE;
        for (const id of MANAGEABLE) delete env[envKey(id)];
        const result = spawnSync(process.execPath, [path.join(__dirname, 'helpers', 'loadProbe.js'), dir, ...(off ? ['--off'] : [])], {
            env, encoding: 'utf8', timeout: 90_000, cwd: path.join(__dirname, '..')
        });
        const line = (result.stdout || '').split('\n').find(entry => entry.startsWith('@@PROBE@@'));
        if (!line) throw new Error(`probe produced no result: ${(result.stderr || '').slice(0, 400)}`);
        return JSON.parse(line.slice('@@PROBE@@'.length));
    }

    test('lists, per feature module, whether it is still required with every optional feature off', () => {
        const modules = JSON.parse(fs.readFileSync(path.join(__dirname, 'helpers', 'loadProbeModules.json'), 'utf8'));
        const off = probe(true);
        const on = probe(false);
        expect(off.error).toBeUndefined();
        expect(on.error).toBeUndefined();

        const entryOf = (result, module) => {
            const step = result.steps.find(entry => entry.newlyLoaded.includes(module));
            return step ? step.label : null;
        };
        const rows = [];
        for (const [feature, list] of Object.entries(modules)) {
            expect(catalog.get(feature)).not.toBeNull();
            for (const module of list) {
                expect(fs.existsSync(path.join(__dirname, '..', module))).toBe(true);
                rows.push({ feature, module: module.replace('packages/core/', ''), off: entryOf(off, module), on: entryOf(on, module) });
            }
        }
        const width = Math.max(...rows.map(row => row.module.length));
        const lines = ['', 'Loaded but not executed when off (entry point that first required the module; "-" = not loaded)',
            `${'feature'.padEnd(14)}${'module'.padEnd(width + 2)}${'all off'.padEnd(16)}legacy (nothing off)`];
        for (const row of rows) lines.push(`${row.feature.padEnd(14)}${row.module.padEnd(width + 2)}${(row.off || '-').padEnd(16)}${row.on || '-'}`);
        process.stdout.write(`${lines.join('\n')}\n`);

        expect(off.steps.map(step => step.label)).toEqual(['baseline', 'toolsRegistry', 'commands', 'portal', 'runtime']);
        for (const row of rows) {
            // With everything off nothing may be reachable through the command loader or the runtime.
            expect([row.module, ['commands', 'runtime'].includes(row.off)]).toEqual([row.module, false]);
        }
    });
});
