/**
 * WebSocket gating by feature state (#320, installer P1.5).
 *
 * An upgrade on a path whose owner feature is off is refused with a plain 404
 * before the handshake completes: before the Origin rule, the session
 * lookup, the connection lease and any feature handler, and for signed-in and
 * anonymous callers alike. A socket that was opened while the feature was on
 * and outlives a deliberate `refresh()` gets one stable error frame and a
 * policy close (1008) instead of reaching its feature, whether or not it is
 * idle. Core sockets (Parlor Live) stay up with everything optional off.
 *
 * Uses real sockets on loopback and the throwaway database the Jest setup
 * provides; no Discord token, keys or network.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const WebSocket = require('ws');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-gating-ws-'));
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'test.sqlite');

jest.mock('@goobster/core/services/tableGames/tableManager', () => ({
    TableManager: jest.fn().mockImplementation(() => ({
        recoverFromJournal: jest.fn(async () => {}),
        stop: jest.fn()
    }))
}));
jest.mock('@goobster/core/services/tableGames/botPlayer', () => ({
    BotPlayer: jest.fn().mockImplementation(() => ({ stop: jest.fn() }))
}));

const db = require('@goobster/core/db');
const inventory = require('@goobster/core/features/inventory');
const { FEATURE_IDS } = require('@goobster/core/features/catalog');
const { features } = require('@goobster/core/features/featureState');
const screenVisionService = require('@goobster/core/services/screenVisionService');
const gbaRunService = require('@goobster/core/services/gbaRunService');
const eventBusService = require('@goobster/core/services/eventBusService');
const { TableManager } = require('@goobster/core/services/tableGames/tableManager');
const { createWebAppApp, createWebAppContext, attachWebAppWebSocket } = require('@goobster/core/web/appApi');
const featureGate = require('@goobster/core/web/featureGate');
const { createActivityContext, attachActivityWebSocket } = require('@goobster/bot/web/activityApi');
const { attachScreenVisionWebSocket } = require('@goobster/bot/web/screenVisionApi');
const { attachGbaRunWebSocket } = require('@goobster/bot/web/gbaRunApi');
const { startWebServers, closeWebServers } = require('@goobster/bot/web/server');

const MANAGEABLE = FEATURE_IDS.filter(id => id !== 'core');
const FILE = '/virtual/data/features.json';
const USER = '100000000000000021';
const silentLogger = { info() {}, debug() {}, warn() {}, error() {} };

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

function stateDoc(off = []) {
    const entries = {};
    for (const id of MANAGEABLE) entries[id] = { installed: true, active: !off.includes(id) };
    return JSON.stringify({
        version: 1, revision: 1, updatedAt: '2026-10-06 21:14:02', origin: 'operator', features: entries
    });
}

let currentFs = null;
function useState(off = null) {
    currentFs = memoryFs(off ? { [FILE]: stateDoc(off) } : {});
    features._resetForTests({ fs: currentFs, filePath: FILE, env: {}, config: {} });
}
function flipTo(off) {
    currentFs.files.set(FILE, stateDoc(off));
    features.refresh();
}

// Every socket path the inventory claims, with the harness path that serves it.
const WS_PATHS = Object.entries(inventory.wsPaths).map(([wsPath, owner]) => ({ wsPath, owner }));
const OPTIONAL_WS = WS_PATHS.filter(entry => entry.owner !== 'core');

describe('the socket paths under test are the inventory\'s', () => {
    test('every inventory ws path has a non-core owner except Parlor Live', () => {
        expect(WS_PATHS.map(entry => entry.wsPath).sort()).toEqual([
            '/api/activity/ws', '/api/app/parlor/live', '/api/app/studio/live', '/api/app/voice/live',
            '/api/gba-run/ws', '/api/screen/ws'
        ]);
        expect(OPTIONAL_WS.map(entry => entry.owner).sort()).toEqual(['discordActivity', 'gba', 'music', 'screenVision', 'voice']);
    });
});

// ---------------------------------------------------------------------------
// Harness: one HTTP server with every live socket attached, feature handlers
// replaced by recorders so delivery is observable.

const delivered = [];
let server;
let base;
let wsBase;
let cookie;
let distDir;
let handlerCalls;

function listen(instance) {
    return new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
}

function recordingLive(name) {
    return {
        handleConnection: (socket) => {
            handlerCalls.push(name);
            socket.on('message', raw => delivered.push({ name, raw: raw.toString() }));
        }
    };
}

const openSockets = new Set();

function connect(wsPath, { headers = {} } = {}) {
    return new Promise((resolve) => {
        const socket = new WebSocket(`${wsBase}${wsPath}`, { headers });
        openSockets.add(socket);
        const result = { frames: [], closed: null };
        socket.on('message', raw => {
            try { result.frames.push(JSON.parse(raw.toString())); } catch { result.frames.push(raw.toString()); }
        });
        socket.on('close', (code, reason) => { result.closed = { code, reason: reason.toString() }; });
        socket.on('open', () => resolve({ status: 101, socket, result }));
        socket.on('unexpected-response', (req, res) => {
            res.resume();
            resolve({ status: res.statusCode, socket, result });
        });
        socket.on('error', () => { /* surfaced through unexpected-response or close */ });
    });
}

function waitFor(predicate, ms = 4000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - started > ms) return reject(new Error('timed out waiting for the socket'));
            return setTimeout(tick, 20);
        };
        tick();
    });
}

beforeAll(async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-gating-ws-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>stub</title>');
    useState(null);
    handlerCalls = [];
    const ctx = createWebAppContext({
        gateway: { sendDm: async () => ({}), sendToChannel: async () => ({}) },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: silentLogger,
        deps: {
            webDistDir: distDir,
            parlorLive: recordingLive('parlor'),
            voiceLive: recordingLive('voice'),
            studioLive: recordingLive('studio')
        }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    server = http.createServer(app);
    featureGate.rejectBlockedUpgrades(server);
    attachWebAppWebSocket(server, ctx);
    const activity = createActivityContext({
        client: {}, config: { activity: { enabled: true } }, tableManager: {}, botPlayer: null, logger: silentLogger
    });
    attachActivityWebSocket(server, activity);
    attachScreenVisionWebSocket(server, { logger: silentLogger });
    attachGbaRunWebSocket(server, { logger: silentLogger });
    jest.spyOn(screenVisionService, 'handleConnection').mockImplementation((socket) => {
        handlerCalls.push('screen');
        socket.on('message', raw => delivered.push({ name: 'screen', raw: raw.toString() }));
    });
    jest.spyOn(gbaRunService, 'handleConnection').mockImplementation((socket) => {
        handlerCalls.push('gba');
        socket.on('message', raw => delivered.push({ name: 'gba', raw: raw.toString() }));
    });
    await listen(server);
    const { port } = server.address();
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    const res = await fetch(`${base}/api/app/auth/dev-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: USER, name: 'Socket tester' })
    });
    expect(res.status).toBe(200);
    cookie = res.headers.get('set-cookie').split(';')[0];
});

afterAll(async () => {
    jest.restoreAllMocks();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await eventBusService.close();
    await db.closeConnection();
    features._resetForTests({ config: {}, env: {}, fs: memoryFs(), filePath: FILE });
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    handlerCalls.length = 0;
    delivered.length = 0;
});
afterEach(() => {
    for (const socket of openSockets) socket.terminate();
    openSockets.clear();
    useState(null);
});

const authed = () => ({ headers: { Cookie: cookie } });

describe('upgrade', () => {
    test('with no state file every socket path opens exactly as before', async () => {
        useState(null);
        for (const { wsPath } of WS_PATHS) {
            const attempt = await connect(wsPath, authed());
            expect({ wsPath, status: attempt.status }).toEqual({ wsPath, status: 101 });
            attempt.socket.close();
        }
    });

    test.each(OPTIONAL_WS)('with $owner off, the $wsPath upgrade is a 404 for a signed-in and an anonymous caller', async ({ wsPath, owner }) => {
        useState([owner]);
        const withSession = await connect(wsPath, authed());
        const anonymous = await connect(wsPath);
        expect(withSession.status).toBe(404);
        expect(anonymous.status).toBe(404);
        expect(handlerCalls).toEqual([]);
        expect(delivered).toEqual([]);
    });

    test('a refused upgrade never reserves a connection lease or reads the session', async () => {
        useState(['voice']);
        const run = jest.spyOn(db, 'run');
        const insert = jest.spyOn(db, 'insert');
        const get = jest.spyOn(db, 'get');
        try {
            const attempt = await connect('/api/app/voice/live', authed());
            expect(attempt.status).toBe(404);
            expect(run).not.toHaveBeenCalled();
            expect(insert).not.toHaveBeenCalled();
            expect(get).not.toHaveBeenCalled();
        } finally {
            run.mockRestore();
            insert.mockRestore();
            get.mockRestore();
        }
    });

    test('the answer does not depend on the Origin rule: a foreign Origin is still a plain 404', async () => {
        useState(['music']);
        const attempt = await connect('/api/app/studio/live', { headers: { Cookie: cookie, Origin: 'https://evil.example.com' } });
        expect(attempt.status).toBe(404);
    });

    test('with everything optional off, Parlor Live (core) still opens and works', async () => {
        useState(MANAGEABLE);
        const attempt = await connect('/api/app/parlor/live', authed());
        expect(attempt.status).toBe(101);
        expect(handlerCalls).toEqual(['parlor']);
        attempt.socket.send('{"type":"ping"}');
        await waitFor(() => delivered.length === 1);
        expect(delivered[0].name).toBe('parlor');
        attempt.socket.close();
    });

    test('an unauthenticated upgrade to an available path is still 401, so the gate adds no new answer', async () => {
        useState(['gba']);
        const attempt = await connect('/api/app/voice/live');
        expect(attempt.status).toBe(401);
    });

    test('a dependency that is off blocks its dependent socket (the Activity needs Discord)', async () => {
        useState(['discord']);
        const attempt = await connect('/api/activity/ws');
        expect(attempt.status).toBe(404);
    });
});

describe('stale open connections after refresh()', () => {
    test.each(OPTIONAL_WS)('a $wsPath socket opened while $owner was on is refused on its next message', async ({ wsPath, owner }) => {
        useState([]);
        const attempt = await connect(wsPath, authed());
        expect(attempt.status).toBe(101);
        // The Activity's handler is the real one (it answers with its own frames); the others are recorders.
        if (owner !== 'discordActivity') expect(handlerCalls).toHaveLength(1);

        flipTo([owner]);
        attempt.socket.send(JSON.stringify({ type: 'join', note: 'after the feature went away' }));
        await waitFor(() => attempt.result.closed);

        expect(attempt.result.closed.code).toBe(1008);
        expect(attempt.result.closed.reason).toBe('FEATURE_UNAVAILABLE');
        expect(attempt.result.frames).toEqual([{
            type: 'error', code: 'FEATURE_UNAVAILABLE', feature: owner, message: featureGate.UNAVAILABLE_MESSAGE
        }]);
        expect(delivered).toEqual([]);
    });

    test('an idle portal socket is closed with the same frame without any message from the client', async () => {
        useState([]);
        const attempt = await connect('/api/app/voice/live', authed());
        expect(attempt.status).toBe(101);
        flipTo(['voice']);
        await waitFor(() => attempt.result.closed, 5000);
        expect(attempt.result.closed.code).toBe(1008);
        expect(attempt.result.frames).toEqual([{
            type: 'error', code: 'FEATURE_UNAVAILABLE', feature: 'voice', message: featureGate.UNAVAILABLE_MESSAGE
        }]);
    });

    test('one message is not enough to slip through: a burst is refused as a whole', async () => {
        useState([]);
        const attempt = await connect('/api/screen/ws', authed());
        flipTo(['screenVision']);
        for (let i = 0; i < 5; i += 1) attempt.socket.send(JSON.stringify({ type: 'hello', token: `t${i}` }));
        await waitFor(() => attempt.result.closed);
        expect(delivered).toEqual([]);
        expect(attempt.result.frames).toHaveLength(1);
    });

    test('a feature that stays on keeps delivering', async () => {
        useState([]);
        const attempt = await connect('/api/app/studio/live', authed());
        flipTo(['voice']);
        attempt.socket.send('{"type":"hello"}');
        await waitFor(() => delivered.length === 1);
        expect(delivered[0].name).toBe('studio');
        expect(attempt.result.closed).toBeNull();
        attempt.socket.close();
    });
});

describe('bot public server: sockets whose owner was off at startup', () => {
    const savedPort = process.env.PORT;
    let handles;

    function reservePort() {
        return new Promise((resolve, reject) => {
            const probe = net.createServer();
            probe.listen(0, '127.0.0.1', () => {
                const { port } = probe.address();
                probe.close(error => (error ? reject(error) : resolve(String(port))));
            });
            probe.on('error', reject);
        });
    }

    afterEach(async () => {
        if (handles) await closeWebServers(handles);
        handles = null;
        if (savedPort === undefined) delete process.env.PORT;
        else process.env.PORT = savedPort;
    });

    test('no handler is attached, yet the upgrade is answered 404 instead of hanging', async () => {
        useState(['discordActivity', 'screenVision', 'gba']);
        process.env.PORT = await reservePort();
        TableManager.mockClear();
        handles = await startWebServers({
            client: {},
            voiceService: {},
            config: {
                panel: { enabled: false },
                activity: { enabled: true },
                screenVision: { enabled: true },
                gbaRun: { enabled: true },
                webapp: { enabled: true, devMode: true }
            },
            logger: silentLogger
        });
        if (!handles.healthServer.listening) await new Promise(resolve => handles.healthServer.once('listening', resolve));
        expect(TableManager).not.toHaveBeenCalled();
        const port = handles.healthServer.address().port;
        for (const wsPath of ['/api/activity/ws', '/api/screen/ws', '/api/gba-run/ws']) {
            const attempt = await new Promise((resolve) => {
                const socket = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
                socket.on('unexpected-response', (req, res) => { res.resume(); resolve(res.statusCode); });
                socket.on('open', () => resolve(101));
                socket.on('error', () => resolve('error'));
            });
            expect({ wsPath, attempt }).toEqual({ wsPath, attempt: 404 });
        }
    });

    test('with no state file and nothing enabled the legacy behaviour is untouched (no answer is added)', async () => {
        useState(null);
        const upgrades = [];
        const fake = { on: (event, handler) => upgrades.push([event, handler]) };
        featureGate.rejectBlockedUpgrades(fake);
        const socket = { write: jest.fn(), destroy: jest.fn(), destroyed: false };
        upgrades[0][1]({ url: '/api/activity/ws' }, socket);
        upgrades[0][1]({ url: '/api/screen/ws' }, socket);
        expect(socket.write).not.toHaveBeenCalled();
        expect(socket.destroy).not.toHaveBeenCalled();
    });
});
