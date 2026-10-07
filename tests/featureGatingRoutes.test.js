/**
 * HTTP gating by feature state (#320, installer P1.5).
 *
 * The portal router, the bot's public server and the api app refuse a
 * request whose owner feature is off before any handler body runs: no DB
 * write, no file write, no provider call, no feature service call, no worker
 * construction. Ownership is the inventory's ordered `routeRules`; the tests
 * walk the real router stacks, turn one feature off at a time through an
 * injected state file, and prove the refusal for every route that feature
 * owns. Core operator, privacy, Inbox, export and status routes stay up with
 * everything optional off, and with no state file the route table and the
 * answers are the ones the installation had before the catalog existed.
 *
 * Runs against the throwaway database the Jest setup provides (SQLite, or
 * Postgres under GOOBSTER_DB_URL); no Discord token, keys or network.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const express = require('express');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-gating-routes-'));
process.env.GOOBSTER_UPLOADS_DIR = path.join(ROOT, 'uploads');
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
jest.mock('@goobster/core/mcp/http', () => {
    const actual = jest.requireActual('@goobster/core/mcp/http');
    return { ...actual, mountMcpIfEnabled: jest.fn(actual.mountMcpIfEnabled) };
});
jest.mock('@goobster/core/services/repoWatchService', () => ({
    handleEvent: jest.fn(async () => {})
}));

const db = require('@goobster/core/db');
const inventory = require('@goobster/core/features/inventory');
const { FEATURE_IDS } = require('@goobster/core/features/catalog');
const { features } = require('@goobster/core/features/featureState');
const mcpConfig = require('@goobster/core/config/mcpConfig');
const integrationsConfig = require('@goobster/core/config/integrationsConfig');
const screenVisionService = require('@goobster/core/services/screenVisionService');
const gbaRunService = require('@goobster/core/services/gbaRunService');
const repoWatchService = require('@goobster/core/services/repoWatchService');
const mcpHttp = require('@goobster/core/mcp/http');
const { TableManager } = require('@goobster/core/services/tableGames/tableManager');
const { BotPlayer } = require('@goobster/core/services/tableGames/botPlayer');
const eventBusService = require('@goobster/core/services/eventBusService');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const featureGate = require('@goobster/core/web/featureGate');
const { startWebServers, closeWebServers } = require('@goobster/bot/web/server');
const { createApiApp } = require('@goobster/api/server');

const PORTAL_OWNERS = {
    observatory: 1, projects: 1, expeditions: 1, knowledge: 1, exchange: 1, voice: 1, music: 1, push: 1, discord: 1
};
const MANAGEABLE = FEATURE_IDS.filter(id => id !== 'core');
const FILE = '/virtual/data/features.json';
const USER = '100000000000000011';
const OTHER = '100000000000000012';
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
function useState({ off = null, config = {}, env = {} } = {}) {
    currentFs = memoryFs(off ? { [FILE]: stateDoc(off) } : {});
    features._resetForTests({ fs: currentFs, filePath: FILE, env, config });
}
const useNoState = (opts = {}) => useState({ off: null, ...opts });
const useOff = (...ids) => useState({ off: ids });
function flipTo(off) {
    currentFs.files.set(FILE, stateDoc(off));
    features.refresh();
}

// ---------------------------------------------------------------------------
// Router walking (the route table the inventory spec claims, here used to
// request every route a feature owns).

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

/** The first inactive feature among a route's owner and alsoRequires, by the one predicate. */
function expectedBlocker(route) {
    const claim = inventory.ownerOf('route', route.path, route.method);
    if (!claim) return null;
    return [claim.owner, ...claim.alsoRequires].find(id => !features.isActive(id)) || null;
}

// ---------------------------------------------------------------------------
// Portal harness: every feature-owned service is a recorder, so "no feature
// service was touched" is a plain assertion.

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
const RECORDED = [
    'observatory', 'projectAssets', 'projectTriggers', 'projectMissions', 'spitball', 'spitballRunner',
    'briefs', 'transfers', 'exchange', 'voice', 'voiceLive', 'studioSongs', 'studioLive', 'push'
];

let server;
let base;
let router;
let distDir;
let cookie;
let otherCookie;
let spies;

function startServer(app) {
    return new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
}

async function call(method, reqPath, { headers = {}, body, raw } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (raw !== undefined) {
        init.body = raw;
    } else if (body !== undefined && !['GET', 'HEAD'].includes(method)) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const res = await fetch(`${base}${reqPath}`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
}

async function login(userId) {
    const res = await call('POST', '/api/app/auth/dev-session', { body: { userId, name: 'Gate tester' } });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie').split(';')[0];
}

function listFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

function startSpies() {
    spies = {
        run: jest.spyOn(db, 'run'),
        insert: jest.spyOn(db, 'insert'),
        transaction: jest.spyOn(db, 'transaction'),
        writeFileSync: jest.spyOn(fs, 'writeFileSync'),
        writeFile: jest.spyOn(fs.promises, 'writeFile'),
        mkdirSync: jest.spyOn(fs, 'mkdirSync'),
        fetch: jest.spyOn(global, 'fetch')
    };
    serviceCalls.length = 0;
}
function resetSpies() {
    for (const spy of Object.values(spies)) spy.mockClear();
    serviceCalls.length = 0;
}
function sideEffects() {
    // The harness's own fetch calls reach the loopback server only.
    const outbound = spies.fetch.mock.calls.filter(([url]) => !String(url).startsWith(base));
    return {
        dbWrites: spies.run.mock.calls.length + spies.insert.mock.calls.length + spies.transaction.mock.calls.length,
        fileWrites: spies.writeFileSync.mock.calls.length + spies.writeFile.mock.calls.length + spies.mkdirSync.mock.calls.length,
        providerCalls: outbound.length,
        serviceCalls: [...serviceCalls]
    };
}
const NO_EFFECTS = { dbWrites: 0, fileWrites: 0, providerCalls: 0, serviceCalls: [] };

beforeAll(async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-gating-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>stub</title>');
    useNoState();
    const deps = { webDistDir: distDir };
    for (const name of RECORDED) deps[name] = recorder(name);
    const ctx = createWebAppContext({
        gateway: { sendDm: async () => ({}), sendToChannel: async () => ({}) },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: silentLogger,
        deps
    });
    router = createWebAppApp(ctx);
    const app = express();
    app.use(router);
    server = await startServer(app);
    base = `http://127.0.0.1:${server.address().port}`;
    cookie = await login(USER);
    otherCookie = await login(OTHER);
    startSpies();
});

afterAll(async () => {
    jest.restoreAllMocks();
    await new Promise(resolve => server.close(resolve));
    await eventBusService.close();
    await db.closeConnection();
    features._resetForTests({ config: {}, env: {}, fs: memoryFs(), filePath: FILE });
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => useNoState());

// ---------------------------------------------------------------------------

describe('portal: one feature turned off at a time', () => {
    let table;
    beforeAll(() => { table = routeTable(router).filter(route => !/[()*\\]/.test(route.path)); });

    test('the walker sees the real route table and the owners that matter here', () => {
        expect(table.length).toBeGreaterThan(300);
        const owners = new Set(table.map(route => inventory.ownerOf('route', route.path, route.method)?.owner));
        for (const id of ['core', 'observatory', 'projects', 'expeditions', 'knowledge', 'exchange', 'voice', 'music', 'push', 'discord']) {
            expect(owners.has(id)).toBe(true);
        }
    });

    test.each(MANAGEABLE)('with %s off, every route its rules give an inactive owner answers 404 FEATURE_UNAVAILABLE and does nothing', async (id) => {
        useOff(id);
        resetSpies();
        const blocked = table.filter(route => expectedBlocker(route));
        const owned = table.filter(route => inventory.ownerOf('route', route.path, route.method)?.owner === id);
        expect(blocked.length).toBeGreaterThanOrEqual(owned.length);
        if (id in PORTAL_OWNERS) expect(owned.length).toBeGreaterThan(0);

        const failures = [];
        for (const route of blocked) {
            const blocker = expectedBlocker(route);
            const reqPath = concrete(route.path);
            const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method) ? { body: {} } : {};
            const authed = await call(route.method, reqPath, { headers: { Cookie: cookie }, ...body });
            if (authed.status !== 404 || authed.json?.error?.code !== 'FEATURE_UNAVAILABLE' || authed.json?.feature !== blocker) {
                failures.push(`authed ${keyOf(route)} -> ${authed.status} ${authed.text.slice(0, 80)}`);
            }
            const anonymous = await call(route.method, reqPath, body);
            if (anonymous.status !== 404 || anonymous.json?.error?.code !== 'NOT_FOUND') {
                failures.push(`anonymous ${keyOf(route)} -> ${anonymous.status} ${anonymous.text.slice(0, 80)}`);
            }
        }
        expect(failures).toEqual([]);
        expect(sideEffects()).toEqual(NO_EFFECTS);
    });

    test('with push off a person can still remove their subscription ("disabled is not deleted"), but cannot add one or send a test', async () => {
        useOff('push');
        resetSpies();
        expect(inventory.ownerOf('route', 'DELETE /api/app/push/subscriptions')).toEqual({ owner: 'core', alsoRequires: [] });
        expect(featureGate.routeBlock('/api/app/push/subscriptions', 'DELETE', features)).toBeNull();
        for (const [method, reqPath] of [['POST', '/api/app/push/subscriptions'], ['POST', '/api/app/push/test'], ['GET', '/api/app/push']]) {
            expect({ method, reqPath, blocked: featureGate.routeBlock(reqPath, method, features) }).toEqual({ method, reqPath, blocked: 'push' });
            const refused = await call(method, reqPath, { headers: { Cookie: cookie }, body: method === 'POST' ? {} : undefined });
            expect(refused.status).toBe(404);
            expect(refused.json).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: 'FEATURE_UNAVAILABLE' }), feature: 'push' }));
        }
        const removal = await call('DELETE', '/api/app/push/subscriptions', { headers: { Cookie: cookie }, body: {} });
        expect(removal.json?.error?.code).not.toBe('FEATURE_UNAVAILABLE');
        expect(removal.status).not.toBe(404);
    });

    test('a route whose owner is active is never refused by the gate', () => {
        useOff('exchange', 'mcp', 'push');
        for (const route of table) {
            if (expectedBlocker(route)) continue;
            expect({ route: keyOf(route), blocked: featureGate.routeBlock(concrete(route.path), route.method, features) })
                .toEqual({ route: keyOf(route), blocked: null });
        }
    });

    test('everything optional off: core operator, privacy, Inbox, export and status routes are still served', async () => {
        useOff(...MANAGEABLE);
        const served = [
            ['GET', '/api/app/config'],
            ['GET', '/api/app/me'],
            ['GET', '/api/app/features'],
            ['GET', '/api/app/inbox'],
            ['GET', '/api/app/inbox/unread'],
            ['GET', '/api/app/account'],
            ['GET', '/api/app/memory/retention?scope=dm%3A100000000000000011'],
            ['GET', '/api/app/settings/exports'],
            ['GET', '/api/app/settings/export'],
            ['GET', '/api/app/admin/limits'],
            ['GET', '/api/app/admin/instance'],
            ['GET', '/api/app/admin/audit'],
            ['POST', '/api/app/privacy/forget']
        ];
        const gated = [];
        for (const [method, reqPath] of served) {
            expect(featureGate.routeBlock(reqPath, method, features)).toBeNull();
            const res = await call(method, reqPath, { headers: { Cookie: cookie }, body: method === 'POST' ? {} : undefined });
            if (res.json?.error?.code === 'FEATURE_UNAVAILABLE' || (res.status === 404 && res.json?.error?.code === 'NOT_FOUND')) {
                gated.push(`${method} ${reqPath} -> ${res.status}`);
            }
        }
        expect(gated).toEqual([]);

        for (const reqPath of ['/api/app/config', '/api/app/me', '/api/app/features', '/api/app/inbox', '/api/app/account', '/api/app/settings/exports']) {
            const res = await call('GET', reqPath, { headers: { Cookie: cookie } });
            expect({ reqPath, status: res.status }).toEqual({ reqPath, status: 200 });
        }
        const health = await call('GET', '/app/sw.js');
        expect(health.json?.error?.code).not.toBe('FEATURE_UNAVAILABLE');
    });
});

describe('portal: how a refusal is reached', () => {
    test('direct URL variants hit the same gate: case, trailing slash, query string and HEAD', async () => {
        useOff('exchange');
        resetSpies();
        const variants = [
            ['GET', '/API/APP/EXCHANGE/overview'],
            ['GET', '/api/app/exchange/overview/'],
            ['GET', '/api/app/exchange/overview?scope=x'],
            ['GET', '/api/app/Exchange/leaderboard'],
            ['POST', '/api/app/exchange/trade/'],
            ['HEAD', '/api/app/exchange/overview']
        ];
        for (const [method, reqPath] of variants) {
            const res = await call(method, reqPath, { headers: { Cookie: cookie }, ...(method === 'POST' ? { body: {} } : {}) });
            expect({ method, reqPath, status: res.status }).toEqual({ method, reqPath, status: 404 });
            if (method !== 'HEAD') expect(res.json?.error?.code).toBe('FEATURE_UNAVAILABLE');
        }
        expect(sideEffects()).toEqual(NO_EFFECTS);
    });

    test('a refusal is a refusal for the signed-in person only; anyone else sees a missing route', async () => {
        useOff('music');
        const authed = await call('GET', '/api/app/studio/songs', { headers: { Cookie: otherCookie } });
        expect(authed.status).toBe(404);
        expect(authed.json).toEqual({
            error: { code: 'FEATURE_UNAVAILABLE', message: featureGate.UNAVAILABLE_MESSAGE },
            feature: 'music'
        });
        const stale = await call('GET', '/api/app/studio/songs', { headers: { Cookie: 'goobster_web_session=not-a-session' } });
        const none = await call('GET', '/api/app/studio/songs');
        const missing = await call('GET', '/api/app/definitely-missing');
        expect(stale.status).toBe(404);
        expect(stale.json).toEqual(none.json);
        expect(none.json).toEqual(missing.json);
        expect(JSON.stringify(none.json)).not.toMatch(/music|FEATURE/);
    });

    test('a stale client after refresh(): served while the feature is on, refused once the snapshot says off', async () => {
        useState({ off: [] });
        const before = await call('GET', '/api/app/exchange/leaderboard', { headers: { Cookie: cookie } });
        expect(before.json?.error?.code).not.toBe('FEATURE_UNAVAILABLE');
        flipTo(['exchange']);
        resetSpies();
        const after = await call('GET', '/api/app/exchange/leaderboard', { headers: { Cookie: cookie } });
        expect(after.status).toBe(404);
        expect(after.json.error.code).toBe('FEATURE_UNAVAILABLE');
        expect(sideEffects()).toEqual(NO_EFFECTS);
        flipTo([]);
        const back = await call('GET', '/api/app/exchange/leaderboard', { headers: { Cookie: cookie } });
        expect(back.json?.error?.code).not.toBe('FEATURE_UNAVAILABLE');
    });

    test('an environment override with no state file is enforced like a file', async () => {
        useNoState({ env: { GOOBSTER_FEATURE_EXCHANGE: '0' } });
        const res = await call('GET', '/api/app/exchange/leaderboard', { headers: { Cookie: cookie } });
        expect(res.status).toBe(404);
        expect(res.json.feature).toBe('exchange');
    });

    test('a dependency that is off blocks its dependents (observatory needs projects)', async () => {
        useOff('projects');
        resetSpies();
        const chat = await call('POST', '/api/app/projects/x1/chat', { headers: { Cookie: cookie }, body: { message: 'hi' } });
        expect(chat.status).toBe(404);
        expect(chat.json.feature).toBe(features.isActive('observatory') ? 'projects' : 'observatory');
        expect(sideEffects()).toEqual(NO_EFFECTS);
    });

    test('a public share link is refused with a missing-route answer when its owner is off, and served when on', async () => {
        const token = 'a'.repeat(40);
        useNoState();
        resetSpies();
        const on = await call('GET', `/app/observatory/share/${token}`);
        expect(on.status).not.toBe(404);
        expect(serviceCalls).toContain('observatory.getSharedDashboard');

        useOff('projects');
        resetSpies();
        const off = await call('GET', `/app/observatory/share/${token}`);
        expect(off.status).toBe(404);
        expect(off.json).toEqual({ error: { code: 'NOT_FOUND', message: 'No such API route.' } });
        expect(sideEffects()).toEqual(NO_EFFECTS);
    });

    test('private note attachments: owner-bound while knowledge is on, unreachable while it is off, files untouched', async () => {
        useNoState();
        const upload = await fetch(`${base}/api/app/note-attachments?name=plan.pdf`, {
            method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('%PDF-plan')
        });
        expect(upload.status).toBe(200);
        const { url } = await upload.json();
        expect((await call('GET', url, { headers: { Cookie: cookie } })).status).toBe(200);
        expect((await call('GET', url, { headers: { Cookie: otherCookie } })).status).toBe(404);
        expect((await call('GET', url)).status).toBe(401);

        useOff('knowledge');
        const filesBefore = listFiles(process.env.GOOBSTER_UPLOADS_DIR);
        resetSpies();
        const read = await call('GET', url, { headers: { Cookie: cookie } });
        expect(read.status).toBe(404);
        expect(read.json.error.code).toBe('FEATURE_UNAVAILABLE');
        const blockedUpload = await fetch(`${base}/api/app/note-attachments?name=again.pdf`, {
            method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('%PDF-again')
        });
        expect(blockedUpload.status).toBe(404);
        const removal = await call('DELETE', url, { headers: { Cookie: cookie } });
        expect(removal.status).toBe(404);
        expect(listFiles(process.env.GOOBSTER_UPLOADS_DIR)).toEqual(filesBefore);
        expect(sideEffects()).toEqual(NO_EFFECTS);

        useNoState();
        expect((await call('GET', url, { headers: { Cookie: cookie } })).status).toBe(200);
    });
});

describe('GET /api/app/features', () => {
    test('requires a session', async () => {
        const res = await call('GET', '/api/app/features');
        expect(res.status).toBe(401);
    });

    test('returns every catalog id with reason codes only, and never a detail value or file content', async () => {
        useNoState({ config: { token: 'x', webapp: { push: { enabled: true } }, mcp: { enabled: false } } });
        const res = await call('GET', '/api/app/features', { headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(Object.keys(res.json.features)).toEqual([...FEATURE_IDS]);
        expect(res.json).toMatchObject({ source: 'none', revision: null, error: null });
        expect(res.json.features.core).toMatchObject({ active: true, reasons: [] });
        expect(res.json.features.mcp).toMatchObject({ active: false, reasons: [{ code: 'DISABLED' }] });
        for (const entry of Object.values(res.json.features)) {
            for (const reason of entry.reasons) expect(Object.keys(reason).every(key => ['code', 'dependency'].includes(key))).toBe(true);
            for (const warning of entry.warnings) expect(Object.keys(warning)).toEqual(['code']);
        }
    });

    test('reflects the state file and its dependencies, and is itself never gated', async () => {
        useOff('discord', 'exchange');
        const res = await call('GET', '/api/app/features', { headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.source).toBe('file');
        expect(res.json.revision).toBe(1);
        expect(res.json.features.exchange).toMatchObject({ active: false, reasons: [{ code: 'DISABLED' }] });
        expect(res.json.features.discordActivity.reasons).toEqual([{ code: 'DEPENDENCY_INACTIVE', dependency: 'discord' }]);
    });

    test('an unusable state file reports its code, not its contents', async () => {
        currentFs = memoryFs({ [FILE]: '{ "secret": "do-not-echo", broken' });
        features._resetForTests({ fs: currentFs, filePath: FILE, env: {}, config: {} });
        const res = await call('GET', '/api/app/features', { headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.error).toEqual({ code: expect.any(String) });
        expect(JSON.stringify(res.json)).not.toContain('do-not-echo');
    });
});

describe('no state file: the installation behaves as it did before the catalog', () => {
    test('the route table does not depend on the feature state', () => {
        const baseline = routeTable(router).map(keyOf).sort();
        for (const mode of [() => useNoState(), () => useOff(...MANAGEABLE), () => useOff('exchange', 'mcp')]) {
            mode();
            expect(routeTable(router).map(keyOf).sort()).toEqual(baseline);
        }
        expect(baseline).toContain('GET /api/app/features');
        expect(baseline.filter(entry => entry !== 'GET /api/app/features').length).toBeGreaterThan(300);
    });

    test('no route is refused for any default configuration, including legacy-off features', () => {
        for (const config of [{}, { token: 'x' }, { mcp: { enabled: true }, observatory: { enabled: true } }]) {
            useNoState({ config });
            const refused = routeTable(router)
                .filter(route => !/[()*\\]/.test(route.path))
                .filter(route => featureGate.routeBlock(concrete(route.path), route.method, features))
                .map(keyOf);
            expect(refused).toEqual([]);
        }
    });

    test('routes of a legacy-off feature answer exactly as before', async () => {
        useNoState({ config: {} });
        expect(features.isActive('mcp')).toBe(false);
        expect(features.isActive('discord')).toBe(false);
        const mcpRoute = await call('GET', '/api/app/mcp', { headers: { Cookie: cookie } });
        expect(mcpRoute.status).toBe(200);
        expect(mcpRoute.json).toHaveProperty('tokens');
        const login503 = await call('GET', '/api/app/auth/login');
        expect(login503.status).toBe(503);
        expect(login503.json.error.code).toBe('LOGIN_UNAVAILABLE');
    });

    test('an unusable state file falls back to the same legacy behaviour', async () => {
        features._resetForTests({ fs: memoryFs({ [FILE]: 'not json' }), filePath: FILE, env: {}, config: {} });
        const mcpRoute = await call('GET', '/api/app/mcp', { headers: { Cookie: cookie } });
        expect(mcpRoute.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// The bot's public server: mounts are skipped (and a stable stub answers),
// workers are never constructed, callbacks are refused.

describe('bot public server', () => {
    const savedEnv = { PORT: process.env.PORT, GOOBSTER_INTERNAL_TOKEN: process.env.GOOBSTER_INTERNAL_TOKEN };
    const WEBHOOK_SECRET = 'whsec-gating-test';
    let handles;
    let origin;
    let savedIntegrations;

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

    async function boot(config = {}) {
        process.env.PORT = await reservePort();
        handles = await startWebServers({
            client: {},
            voiceService: {},
            config: {
                panel: { enabled: false },
                activity: { enabled: true },
                screenVision: { enabled: true },
                gbaRun: { enabled: true },
                ...config
            },
            logger: silentLogger
        });
        if (!handles.healthServer.listening) {
            await new Promise(resolve => handles.healthServer.once('listening', resolve));
        }
        origin = `http://127.0.0.1:${handles.healthServer.address().port}`;
    }

    async function hit(method, reqPath, { headers = {}, body } = {}) {
        const res = await fetch(`${origin}${reqPath}`, { method, headers, body });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, json, text };
    }

    function sign(body) {
        return `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
    }

    beforeEach(() => {
        savedIntegrations = integrationsConfig.github.webhookSecret;
        mcpConfig._setForTests({ enabled: true });
        integrationsConfig.github.webhookSecret = WEBHOOK_SECRET;
        process.env.GOOBSTER_INTERNAL_TOKEN = 'internal-token-for-tests';
        TableManager.mockClear();
        BotPlayer.mockClear();
        mcpHttp.mountMcpIfEnabled.mockClear();
        repoWatchService.handleEvent.mockClear();
        jest.spyOn(screenVisionService, 'configure');
        jest.spyOn(gbaRunService, 'configure');
    });

    afterEach(async () => {
        if (handles) await closeWebServers(handles);
        handles = null;
        mcpConfig._setForTests(null);
        integrationsConfig.github.webhookSecret = savedIntegrations;
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        screenVisionService.configure.mockRestore();
        gbaRunService.configure.mockRestore();
    });

    test('no state file: every enabled surface is mounted and nothing is stubbed (baseline)', async () => {
        useNoState({ config: { token: 'x', activity: { enabled: true }, screenVision: { enabled: true }, gbaRun: { enabled: true } } });
        await boot();
        expect(TableManager).toHaveBeenCalledTimes(1);
        expect(BotPlayer).toHaveBeenCalledTimes(1);
        expect(mcpHttp.mountMcpIfEnabled).toHaveBeenCalledTimes(1);
        expect(screenVisionService.configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
        expect(gbaRunService.configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
        expect((await hit('GET', '/api/activity/config')).status).toBe(200);
        expect((await hit('POST', '/api/screen/pair', { headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
        expect((await hit('GET', '/companion')).status).toBe(200);
        expect((await hit('POST', '/api/gba-run/pair', { headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
        expect((await hit('GET', '/health')).status).toBe(200);
    });

    test('no state file and nothing enabled: the legacy 404s are the server\'s own, not a stub', async () => {
        useNoState({ config: {} });
        mcpConfig._setForTests({ enabled: false });
        await boot({ activity: {}, screenVision: {}, gbaRun: {} });
        expect(TableManager).not.toHaveBeenCalled();
        for (const reqPath of ['/api/activity/config', '/companion', '/api/screen/pair', '/api/gba-run/pair']) {
            const res = await hit('GET', reqPath);
            expect({ reqPath, status: res.status, stub: res.json?.error === 'FEATURE_UNAVAILABLE' })
                .toEqual({ reqPath, status: 404, stub: false });
        }
    });

    test.each([
        ['discordActivity', 'GET', '/api/activity/config'],
        ['discordActivity', 'POST', '/api/activity/token'],
        ['discordActivity', 'POST', '/api/activity/dev-session'],
        ['discordActivity', 'GET', '/api/activity/music/casino'],
        ['discordActivity', 'GET', '/activity/index.html'],
        ['screenVision', 'POST', '/api/screen/pair'],
        ['screenVision', 'GET', '/companion'],
        ['screenVision', 'GET', '/companion.js'],
        ['gba', 'POST', '/api/gba-run/pair'],
        ['github', 'POST', '/api/webhooks/github'],
        ['cursor', 'POST', '/api/webhooks/cursor'],
        ['discord', 'GET', '/internal/gateway/health'],
        ['discord', 'POST', '/internal/gateway/users/1/dm'],
        ['mcp', 'POST', '/mcp'],
        ['mcp', 'GET', '/mcp']
    ])('with %s off, %s %s is a stable 404 FEATURE_UNAVAILABLE', async (id, method, reqPath) => {
        useOff(id);
        await boot();
        const blocker = [id].concat(MANAGEABLE.filter(other => !features.isActive(other))).find(Boolean);
        const res = await hit(method, reqPath, {
            headers: { 'Content-Type': 'application/json', 'x-goobster-internal-token': 'internal-token-for-tests' },
            body: method === 'POST' ? '{}' : undefined
        });
        expect(res.status).toBe(404);
        expect(res.json).toEqual({ error: 'FEATURE_UNAVAILABLE', feature: blocker });
        expect(res.text).not.toMatch(/reasons/);
    });

    test('with the Activity off no TableManager or BotPlayer is constructed and no journal is recovered', async () => {
        useOff('discordActivity');
        await boot();
        expect(TableManager).not.toHaveBeenCalled();
        expect(BotPlayer).not.toHaveBeenCalled();
        expect(handles.tableManager).toBeNull();
        expect(handles.botPlayer).toBeNull();
    });

    test.each([
        ['the fresh preset (economy, exchange and gambling off)', ['economy', 'exchange', 'gambling']],
        ['gambling alone', ['gambling']],
        ['economy alone (gambling depends on it)', ['economy']]
    ])('with %s the casino is not built: no TableManager, BotPlayer or journal replay, the Activity shell stays up', async (label, off) => {
        useOff(...off);
        await boot();
        expect(TableManager).not.toHaveBeenCalled();
        expect(BotPlayer).not.toHaveBeenCalled();
        expect(handles.tableManager).toBeNull();
        expect(handles.botPlayer).toBeNull();
        expect((await hit('GET', '/api/activity/config')).status).toBe(200);
        const music = await hit('GET', '/api/activity/music/casino');
        expect(music.status).toBe(404);
        expect(music.json).toEqual({ error: 'FEATURE_UNAVAILABLE', feature: 'gambling' });
    });

    test('with economy and gambling on (exchange off) the casino is built and its journal replayed', async () => {
        useOff('exchange');
        await boot();
        expect(TableManager).toHaveBeenCalledTimes(1);
        expect(BotPlayer).toHaveBeenCalledTimes(1);
        const manager = TableManager.mock.results[0].value;
        expect(manager.recoverFromJournal).toHaveBeenCalledTimes(1);
    });

    test('with screen vision and the GBA harness off their session managers are configured disabled', async () => {
        useOff('screenVision', 'gba');
        await boot();
        expect(screenVisionService.configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
        expect(gbaRunService.configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });

    test('with MCP off the MCP app is not mounted, even when mcp.enabled is true', async () => {
        useOff('mcp');
        await boot();
        expect(mcpHttp.mountMcpIfEnabled).not.toHaveBeenCalled();
    });

    test('webhook callbacks: refused with no processing while github is off, accepted when on', async () => {
        const body = JSON.stringify({ zen: 'ping' });
        const headers = { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(body), 'x-github-event': 'ping' };

        useNoState({ config: {} });
        await boot();
        const accepted = await hit('POST', '/api/webhooks/github', { headers, body });
        expect(accepted.status).toBe(202);
        expect(repoWatchService.handleEvent).toHaveBeenCalledTimes(1);
        await closeWebServers(handles);
        handles = null;
        repoWatchService.handleEvent.mockClear();

        useOff('github');
        await boot();
        const refused = await hit('POST', '/api/webhooks/github', { headers, body });
        expect(refused.status).toBe(404);
        expect(refused.json).toEqual({ error: 'FEATURE_UNAVAILABLE', feature: 'github' });
        expect(repoWatchService.handleEvent).not.toHaveBeenCalled();
    });

    test('stale clients after refresh(): a mounted surface answers with the stub once its owner goes off', async () => {
        useState({ off: [] });
        await boot();
        expect((await hit('GET', '/api/activity/config')).status).toBe(200);
        expect((await hit('GET', '/companion')).status).toBe(200);
        flipTo(['discordActivity', 'screenVision']);
        for (const reqPath of ['/api/activity/config', '/companion', '/api/screen/pair']) {
            const res = await hit(reqPath === '/api/screen/pair' ? 'POST' : 'GET', reqPath);
            expect({ reqPath, status: res.status, code: res.json?.error }).toEqual({ reqPath, status: 404, code: 'FEATURE_UNAVAILABLE' });
        }
        expect((await hit('GET', '/health')).status).toBe(200);
    });

    test('the health endpoint and the portal are never touched by the bot-side gate', async () => {
        useOff(...MANAGEABLE);
        await boot({ webapp: { enabled: true, devMode: true } });
        expect((await hit('GET', '/health')).status).toBe(200);
        const config = await hit('GET', '/api/app/config');
        expect(config.status).toBe(200);
    });
});

describe('api app', () => {
    test('the portal gate is installed, and MCP is not mounted when its owner is off', async () => {
        useOff('mcp', 'exchange');
        mcpConfig._setForTests({ enabled: true });
        const mounted = mcpHttp.mountMcpIfEnabled;
        mounted.mockClear();
        const { app } = createApiApp({
            config: { webapp: { enabled: true, devMode: true } },
            gateway: { kind: 'disabled', available: async () => false },
            logger: silentLogger
        });
        expect(mounted).not.toHaveBeenCalled();
        const instance = await startServer(app);
        try {
            const apiBase = `http://127.0.0.1:${instance.address().port}`;
            const mcp = await fetch(`${apiBase}/mcp`, { method: 'POST' });
            expect(mcp.status).toBe(404);
            expect(await mcp.json()).toEqual({ error: 'FEATURE_UNAVAILABLE', feature: 'mcp' });
            const anonymous = await fetch(`${apiBase}/api/app/exchange/overview`);
            expect(anonymous.status).toBe(404);
            expect((await anonymous.json()).error.code).toBe('NOT_FOUND');
            expect((await fetch(`${apiBase}/health`)).status).toBe(200);
        } finally {
            await new Promise(resolve => instance.close(resolve));
            mcpConfig._setForTests(null);
        }
    });
});
