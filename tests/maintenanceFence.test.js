/**
 * The process-side maintenance fence (#334, documentation/maintenance_barrier.md),
 * on both database engines:
 *
 *   - the database facade refuses run / insert / transaction while fenced,
 *     allows reads, and the adapter's engine-level read-only mode stops a
 *     raw handle too;
 *   - the portal answers 503 MAINTENANCE to a mutating route and to a
 *     WebSocket upgrade while reads keep working;
 *   - integration webhooks answer 503 with Retry-After;
 *   - coreRuntime started under maintenance starts no writer, and one
 *     already running tears down and comes back;
 *   - a Discord command or button is refused with one sentence;
 *   - the sandbox runner answers 503 MAINTENANCE;
 *   - real apps/api child processes: one fenced by the manager's barrier
 *     while running, one that boots while the barrier is up, both refuse
 *     writes and both resume after release.
 *
 * Each in-process section restores the fence it set; the child sections use
 * their own manager store and database.
 */
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-maintenance-fence-${process.pid}.sqlite`);

jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    embedBatch: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    cosineSimilarity: jest.fn(() => 0)
}));
jest.mock('@goobster/core/services/serviceManager', () => ({ voiceService: null }));

const db = require('@goobster/core/db');
const maintenance = require('@goobster/core/runtime/maintenance');
const lifecycle = require('@goobster/core/runtime/lifecycle');
const { startCoreRuntime } = require('@goobster/core/runtime/coreRuntime');
const { createWebAppContext, createWebAppApp, attachWebAppWebSocket } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');
const { createSandboxApp } = require('../apps/sandbox/server');
const { createIntegrationsApp } = require('@goobster/bot/web/integrationsApi');
const { resolveSettings } = require('@goobster/manager/settings');
const { createBarrier } = require('@goobster/manager/maintenance/barrier');

const REPO = path.join(__dirname, '..');
const USER = '710000000000000001';
const quiet = { info() {}, warn() {}, error() {} };
const ENGINE = process.env.GOOBSTER_DB_URL ? 'postgres' : 'sqlite';

afterEach(() => {
    maintenance._reset();
});

afterAll(async () => {
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.GOOBSTER_DB_PATH + suffix); } catch { /* already gone */ }
    }
});

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function request(port, { method = 'GET', reqPath = '/', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            agent: false,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** A WebSocket upgrade attempt: resolves with the status of the refusal, or 101. */
function upgrade(port, reqPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: reqPath,
            agent: false,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                ...headers
            }
        });
        req.on('response', (res) => {
            res.resume();
            resolve({ status: res.statusCode, headers: res.headers });
        });
        req.on('upgrade', (res, socket) => {
            socket.destroy();
            resolve({ status: 101, headers: res.headers });
        });
        req.on('error', reject);
        req.end();
    });
}

let probeSeq = 0;
const probeRow = () => ({ kind: 'maintenance-fence', workId: `probe-${process.pid}-${++probeSeq}`, phase: 'test', code: 'PROBE' });
const INSERT_PROBE = 'INSERT INTO work_failures (kind, workId, phase, code) VALUES (@kind, @workId, @phase, @code)';
const countProbes = async () => (await db.get("SELECT COUNT(*) AS n FROM work_failures WHERE kind = 'maintenance-fence'")).n;

/* --------------------------------------------------------------- database */

describe(`the database facade (${ENGINE})`, () => {
    test('run, insert and transaction refuse with MaintenanceError while fenced; reads keep working', async () => {
        const before = await countProbes();
        await db.run(INSERT_PROBE, probeRow());
        expect(await countProbes()).toBe(before + 1);

        maintenance.begin(1);
        await db.run(INSERT_PROBE, probeRow());
        expect(await countProbes()).toBe(before + 2);
        maintenance.fenceDb(1);

        await expect(db.run(INSERT_PROBE, probeRow())).rejects.toMatchObject({ name: 'MaintenanceError', code: 'MAINTENANCE', status: 503 });
        await expect(db.insert(INSERT_PROBE, probeRow())).rejects.toMatchObject({ code: 'MAINTENANCE' });
        await expect(db.transaction(async (tx) => { await tx.run(INSERT_PROBE, probeRow()); })).rejects.toMatchObject({ code: 'MAINTENANCE' });
        expect(await countProbes()).toBe(before + 2);
        expect((await db.all("SELECT id FROM work_failures WHERE kind = 'maintenance-fence'")).length).toBe(before + 2);
        expect(await db.get('SELECT 1 AS ok')).toEqual({ ok: 1 });
    });

    test('the engine itself is read-only behind the facade: a raw handle cannot write either', async () => {
        const before = await countProbes();
        maintenance.begin(2);
        maintenance.fenceDb(2);
        const row = probeRow();
        if (db.engine === 'sqlite') {
            await db.get('SELECT 1 AS warm');
            expect(() => db.getDb().prepare(INSERT_PROBE.replace(/@(\w+)/g, '@$1')).run(row)).toThrow(/readonly/i);
        } else {
            await expect(db.rawQuery(
                'INSERT INTO work_failures (kind, "workId", phase, code) VALUES ($1, $2, $3, $4)',
                [row.kind, row.workId, row.phase, row.code]
            )).rejects.toThrow(/read-only/i);
        }
        expect(await countProbes()).toBe(before);
    });

    test('releasing the fence allows writes again, on the same connection', async () => {
        maintenance.begin(3);
        maintenance.fenceDb(3);
        await expect(db.run(INSERT_PROBE, probeRow())).rejects.toMatchObject({ code: 'MAINTENANCE' });
        maintenance.release(3);
        const before = await countProbes();
        await db.run(INSERT_PROBE, probeRow());
        expect(await countProbes()).toBe(before + 1);
        const id = await db.insert(INSERT_PROBE, probeRow());
        expect(id).toBeTruthy();
        await db.transaction(async (tx) => { await tx.run(INSERT_PROBE, probeRow()); });
        expect(await countProbes()).toBe(before + 3);
    });

    test('a release for another fence leaves the fence up', async () => {
        maintenance.begin(5);
        maintenance.fenceDb(5);
        expect(maintenance.release(4)).toBe(false);
        await expect(db.run(INSERT_PROBE, probeRow())).rejects.toMatchObject({ code: 'MAINTENANCE' });
        expect(maintenance.release(5)).toBe(true);
    });
});

/* ------------------------------------------------------------- the portal */

describe(`the portal (${ENGINE})`, () => {
    const conversations = [];
    const fakeChat = {
        maxInputLength: 20000,
        listConversations: jest.fn(() => conversations.slice()),
        createConversation: jest.fn(() => {
            const created = { id: conversations.length + 1, title: null, messageCount: 0 };
            conversations.push(created);
            return created;
        })
    };
    let server;
    let port;
    let cookie;

    beforeAll(async () => {
        const ctx = createWebAppContext({
            client: { user: { id: '900000000000000001', username: 'Goobster' }, guilds: { cache: new Map() } },
            config: { clientId: '123', webapp: { enabled: true, devMode: true } },
            logger: quiet,
            deps: { chat: fakeChat }
        });
        const app = express();
        app.use(createWebAppApp(ctx));
        server = await listen(http.createServer(app));
        attachWebAppWebSocket(server, ctx);
        port = server.address().port;
        const res = await request(port, { method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId: USER, name: 'fence' } });
        expect(res.status).toBe(200);
        cookie = res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session=')).split(';')[0];
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    const mutate = () => request(port, {
        method: 'POST',
        reqPath: '/api/app/chat/conversations',
        headers: { cookie, origin: `http://127.0.0.1:${port}` },
        body: {}
    });
    const read = reqPath => request(port, { reqPath, headers: { cookie } });

    test('a mutating route is 503 MAINTENANCE with Retry-After while fenced; the same route works before and after', async () => {
        const first = await mutate();
        expect(first.status).toBe(200);
        const created = conversations.length;

        maintenance.begin(1);
        const refused = await mutate();
        expect(refused.status).toBe(503);
        expect(refused.json).toMatchObject({ error: 'MAINTENANCE', retryAfter: maintenance.RETRY_AFTER_SECONDS });
        expect(refused.headers['retry-after']).toBe(String(maintenance.RETRY_AFTER_SECONDS));
        expect(conversations.length).toBe(created);

        maintenance.fenceDb(1);
        expect((await mutate()).status).toBe(503);
        expect(conversations.length).toBe(created);

        maintenance.release(1);
        expect((await mutate()).status).toBe(200);
        expect(conversations.length).toBe(created + 1);
    });

    test('reads, the sign-in state and /health-style status keep working while fenced', async () => {
        maintenance.begin(1);
        maintenance.fenceDb(1);
        const me = await read('/api/app/me');
        expect(me.status).toBe(200);
        const list = await read('/api/app/chat/conversations');
        expect(list.status).toBe(200);
        const signedOut = await request(port, { reqPath: '/api/app/me' });
        expect(signedOut.status).toBe(401);
    });

    test('a WebSocket upgrade is refused 503 while fenced; before, it is answered by the normal checks', async () => {
        const before = await upgrade(port, '/api/app/parlor/live', { cookie });
        expect(before.status).toBe(101);
        maintenance.begin(1);
        const refused = await upgrade(port, '/api/app/parlor/live', { cookie });
        expect(refused.status).toBe(503);
        for (const live of ['/api/app/voice/live', '/api/app/studio/live']) {
            expect((await upgrade(port, live, { cookie })).status).toBe(503);
        }
        maintenance.release(1);
        const after = await upgrade(port, '/api/app/parlor/live', { cookie });
        expect(after.status).toBe(101);
    });
});

describe('integration webhooks', () => {
    test('a webhook is answered 503 with Retry-After while fenced, so GitHub and Cursor redeliver, and nothing is read', async () => {
        const app = express();
        app.use(createIntegrationsApp({ client: {}, logger: quiet }));
        const server = await listen(http.createServer(app));
        try {
            const port = server.address().port;
            const probe = () => request(port, { method: 'POST', reqPath: '/webhooks/github', headers: { 'X-GitHub-Event': 'ping' }, body: { zen: 'x' } });
            const before = await probe();
            expect(before.status).not.toBe(503);

            maintenance.begin(1);
            const refused = await probe();
            expect(refused.status).toBe(503);
            expect(refused.headers['retry-after']).toBe(String(maintenance.RETRY_AFTER_SECONDS));
            expect(refused.json).toMatchObject({ error: 'MAINTENANCE' });
            maintenance.release(1);
            expect((await probe()).status).not.toBe(503);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});

/* ------------------------------------------------------------ the runtime */

describe('coreRuntime', () => {
    function fakeDeps(log) {
        const worker = name => ({ start: () => log.push(`start:${name}`), stop: () => log.push(`stop:${name}`), close: () => log.push(`stop:${name}`) });
        class FakeAutomation { start() { log.push('start:automation'); } stop() { log.push('stop:automation'); } }
        class FakePersonal {
            constructor() { this.ticking = false; }
            start() { log.push('start:personal'); }
            stop() { log.push('stop:personal'); }
        }
        const runner = {
            async start() { log.push('start:expeditions'); return []; },
            async stop() { log.push('stop:expeditions'); },
            requestCheckpoint() { return []; },
            waitForCheckpoint() { return Promise.resolve(); },
            async interruptLive() { return []; }
        };
        return {
            eventBusService: worker('eventBus'),
            chatHistoryRetentionService: worker('retention'),
            accountExportService: worker('exports'),
            instanceStateService: { isPaused: async () => { log.push('read:paused'); return false; }, getPause: async () => null },
            selfDocsService: { seedOnStartup: async () => { log.push('seed:docs'); return { acquired: false }; } },
            workshopPinMigration: { runOnStartup: async () => ({ acquired: false }) },
            observatoryService: { autoResumeInterrupted: async () => { log.push('write:observatory'); return []; } },
            projectMissionService: { reconcileStartingSteps: async () => 0, reconcileRunningSteps: async () => 0 },
            projectTriggerService: { catchUpEventTriggers: async () => 0 },
            AutomationService: FakeAutomation,
            followupDeliveryService: { deliverDue: async () => ({ delivered: 0, left: 0 }) },
            PersonalHeartbeatService: FakePersonal,
            spitballExpeditionRunner: runner,
            memoryConsolidationService: { ...worker('consolidation'), running: false },
            knowledgeReflectionService: { start: () => log.push('start:reflection'), stop: async () => { log.push('stop:reflection'); } },
            ledgerRetentionService: worker('ledger')
        };
    }

    test('started under maintenance it starts no writer and reads no flag; every step is skipped: maintenance', async () => {
        const log = [];
        maintenance.begin(1);
        maintenance.fenceDb(1);
        const runtime = await startCoreRuntime({ gateway: null, logger: quiet, deps: fakeDeps(log) });
        expect(log).toEqual([]);
        expect(runtime.started).toEqual([]);
        expect(runtime.dormant).toBe(true);
        expect(runtime.pausedAtStart).toBe(false);
        const reasons = new Set(runtime.report.map(item => item.reason));
        expect(reasons).toEqual(new Set(['maintenance']));
        expect(runtime.report.length).toBeGreaterThan(2);
        expect(runtime.report.every(item => item.status === 'skipped')).toBe(true);

        maintenance.release(1);
        expect(await runtime.resumeFromMaintenance()).toBe(true);
        expect(runtime.dormant).toBe(false);
        expect(log).toEqual(expect.arrayContaining(['start:eventBus', 'start:automation', 'start:personal']));
        await runtime.stop();
    });

    test('a running runtime tears every worker down on entering maintenance and starts them again on resume; none of it is the paused flag', async () => {
        const log = [];
        const runtime = await startCoreRuntime({ gateway: null, logger: quiet, deps: fakeDeps(log) });
        expect(runtime.started.length).toBeGreaterThan(3);
        log.length = 0;
        maintenance.begin(1);
        await runtime.enterMaintenance(1000);
        maintenance.fenceDb(1);
        expect(runtime.dormant).toBe(true);
        expect(log).toEqual(expect.arrayContaining(['stop:automation', 'stop:personal', 'stop:eventBus', 'stop:retention']));
        expect(log).not.toContain('read:paused');
        expect(runtime.pausedAtStart).toBe(false);

        log.length = 0;
        maintenance.release(1);
        expect(await runtime.resumeFromMaintenance()).toBe(true);
        expect(log).toEqual(expect.arrayContaining(['start:eventBus', 'start:automation', 'start:personal']));
        await runtime.stop();
    });
});

/* -------------------------------------------------------------- the bot */

describe('Discord interactions', () => {
    const { refuseUnavailableCommand, gateComponentInteraction, MAINTENANCE_TEXT } = require('../apps/bot/events/interactionCreate');
    const { commandNameIndex } = require('@goobster/core/utils/commandDeployment');
    const names = commandNameIndex(path.join(REPO, 'apps', 'bot', 'commands'));
    const interaction = (commandName, { autocomplete = false, customId = 'x_y' } = {}) => ({
        commandName,
        customId,
        isAutocomplete: () => autocomplete,
        reply: jest.fn(async () => {}),
        respond: jest.fn(async () => {}),
        followUp: jest.fn(async () => {}),
        deferred: false,
        replied: false
    });

    test('every command, a core one included, gets one ephemeral sentence while fenced; none before', async () => {
        const quietBefore = interaction('help');
        expect(await refuseUnavailableCommand(quietBefore, names, { restartNotice: () => null })).toBe(false);
        expect(quietBefore.reply).not.toHaveBeenCalled();

        maintenance.begin(1);
        for (const name of ['help', 'adventure', 'play']) {
            const fenced = interaction(name);
            expect(await refuseUnavailableCommand(fenced, names, { restartNotice: () => null })).toBe(true);
            expect(fenced.reply).toHaveBeenCalledTimes(1);
            expect(fenced.reply).toHaveBeenCalledWith(expect.objectContaining({ content: MAINTENANCE_TEXT, ephemeral: true }));
        }
        const autocomplete = interaction('adventure', { autocomplete: true });
        expect(await refuseUnavailableCommand(autocomplete, names, { restartNotice: () => null })).toBe(true);
        expect(autocomplete.respond).toHaveBeenCalledWith([]);
        expect(autocomplete.reply).not.toHaveBeenCalled();
    });

    test('a button or a modal is refused the same way before any handler runs', async () => {
        maintenance.begin(1);
        const button = interaction('', { customId: 'intaction_approve_5' });
        const outcome = await gateComponentInteraction(button);
        expect(outcome).toMatchObject({ handled: true, refusal: { maintenance: true } });
        expect(button.reply).toHaveBeenCalledWith(expect.objectContaining({ content: MAINTENANCE_TEXT, ephemeral: true }));
    });

    test('messageCreate starts no chat turn while fenced', async () => {
        const messageCreate = require('../apps/bot/events/messageCreate');
        maintenance.begin(1);
        const message = {
            author: { bot: false, id: USER },
            content: 'hello goobster',
            guild: null,
            channel: { id: 'c1', send: jest.fn(), sendTyping: jest.fn(), isDMBased: () => true, messages: { fetch: async () => [] } },
            mentions: { has: () => true, users: new Map() },
            reply: jest.fn()
        };
        const client = { user: { id: '900000000000000001' } };
        await expect(Promise.resolve(messageCreate.execute(message, client))).resolves.toBeUndefined();
        expect(message.reply).not.toHaveBeenCalled();
        expect(message.channel.send).not.toHaveBeenCalled();
        expect(message.channel.sendTyping).not.toHaveBeenCalled();
    });
});

/* ----------------------------------------------------------- the sandbox */

describe('the sandbox runner', () => {
    const TOKEN = 'maintenance-fence-token';
    let previousToken;
    beforeAll(() => {
        previousToken = process.env.GOOBSTER_INTERNAL_TOKEN;
        process.env.GOOBSTER_INTERNAL_TOKEN = TOKEN;
    });
    afterAll(() => {
        if (previousToken === undefined) delete process.env.GOOBSTER_INTERNAL_TOKEN;
        else process.env.GOOBSTER_INTERNAL_TOKEN = previousToken;
    });

    test('POST /run is 503 MAINTENANCE with Retry-After after the token check, and the code never runs; reads and /health answer', async () => {
        const run = jest.fn(async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, timedOut: false, files: [] }));
        const sandbox = { enabled: true, run, resumeNewWork: () => {}, pauseNewWork: () => {} };
        const server = await listen(http.createServer(createSandboxApp({ sandbox, logger: quiet })));
        try {
            const port = server.address().port;
            const headers = { 'x-goobster-internal-token': TOKEN };
            const code = { language: 'python', code: 'print(1)', userId: USER };
            maintenance.begin(1);
            const refused = await request(port, { method: 'POST', reqPath: '/run', headers, body: code });
            expect(refused.status).toBe(503);
            expect(refused.json.error).toMatchObject({ code: 'MAINTENANCE' });
            expect(refused.headers['retry-after']).toBe(String(maintenance.RETRY_AFTER_SECONDS));
            expect(run).not.toHaveBeenCalled();
            const unauthenticated = await request(port, { method: 'POST', reqPath: '/run', body: code });
            expect(unauthenticated.status).toBe(401);
            expect((await request(port, { reqPath: '/health' })).status).toBe(200);

            maintenance.release(1);
            const allowed = await request(port, { method: 'POST', reqPath: '/run', headers, body: code });
            expect(allowed.status).toBe(200);
            expect(run).toHaveBeenCalledTimes(1);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});

/* ---------------------------------------------------- the worker lifecycle */

describe('the worker lifecycle contract', () => {
    function lifecycleHarness(worker = 'api') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-fence-lifecycle-'));
        const env = { GOOBSTER_MANAGER_STATE_DIR: dir, GOOBSTER_DATA_DIR: dir };
        const instance = lifecycle.createWorkerLifecycle();
        instance.boot({ worker, env, log: quiet });
        return { dir, env, instance, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    }

    test('enterMaintenance drains the registered handlers, fences the database, acknowledges that fence, and is idempotent; resume reverses it', async () => {
        const h = lifecycleHarness();
        const calls = [];
        h.instance.onMaintenance({ name: 'writers', drain: async () => { calls.push('drain'); }, resume: async () => { calls.push('resume'); } });
        const first = await h.instance.enterMaintenance({ fence: 7, drainSeconds: 2 });
        expect(first).toBeTruthy();
        expect(maintenance.isFenced()).toBe(true);
        expect(maintenance.currentFence()).toBe(7);
        expect(maintenance.readFenceAck('api', { env: h.env })).toMatchObject({ fence: 7, state: 'fenced', pid: process.pid });
        await h.instance.enterMaintenance({ fence: 7, drainSeconds: 2 });
        expect(calls).toEqual(['drain']);
        await expect(db.run(INSERT_PROBE, probeRow())).rejects.toMatchObject({ code: 'MAINTENANCE' });

        const resumed = await h.instance.resumeMaintenance({ fence: 7 });
        expect(resumed).toMatchObject({ resumed: true });
        expect(calls).toEqual(['drain', 'resume']);
        expect(maintenance.isActive()).toBe(false);
        expect(maintenance.readFenceAck('api', { env: h.env })).toMatchObject({ fence: 7, state: 'resumed' });
        await db.run(INSERT_PROBE, probeRow());
        h.cleanup();
    });

    test('a resume for another fence changes nothing', async () => {
        const h = lifecycleHarness();
        await h.instance.enterMaintenance({ fence: 3, drainSeconds: 1 });
        expect(await h.instance.resumeMaintenance({ fence: 2 })).toMatchObject({ resumed: false });
        expect(maintenance.isFenced()).toBe(true);
        await h.instance.resumeMaintenance({ fence: 3 });
        h.cleanup();
    });

    test('a process that boots while the manager store says active (or cannot be read) fences itself and acknowledges, writers never started', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-fence-boot-'));
        const env = { GOOBSTER_MANAGER_STATE_DIR: dir };
        fs.writeFileSync(path.join(dir, 'maintenance.json'), JSON.stringify({ version: 1, active: true, fence: 9, phase: 'quiesced', operationId: 'op' }));
        const instance = lifecycle.createWorkerLifecycle();
        instance.boot({ worker: 'bot', env, log: quiet });
        expect(maintenance.isFenced()).toBe(true);
        expect(maintenance.currentFence()).toBe(9);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(maintenance.readFenceAck('bot', { env })).toMatchObject({ fence: 9, state: 'fenced' });
        maintenance._reset();

        fs.writeFileSync(path.join(dir, 'maintenance.json'), '{ unreadable');
        const second = lifecycle.createWorkerLifecycle();
        second.boot({ worker: 'bot', env, log: quiet });
        expect(maintenance.isFenced()).toBe(true);
        expect(maintenance.snapshot().unreadable).toBe(true);
        maintenance._reset();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

/* ------------------------------------------------------- real api children */

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function childEnv(dir, port) {
    const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'production',
        GOOBSTER_RUNTIME_MODE: 'standalone',
        GOOBSTER_API_PORT: String(port),
        GOOBSTER_WORKSPACE_ROOT: dir,
        GOOBSTER_DATA_DIR: path.join(dir, 'data'),
        GOOBSTER_UPLOADS_DIR: path.join(dir, 'data', 'uploads'),
        GOOBSTER_CACHE_DIR: path.join(dir, 'cache'),
        GOOBSTER_LOG_DIR: path.join(dir, 'logs'),
        GOOBSTER_CONFIG_PATH: path.join(dir, 'config.json'),
        GOOBSTER_MANAGER_STATE_DIR: path.join(dir, 'manager'),
        GOOBSTER_WORKER_NAME: 'api'
    };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (process.env.GOOBSTER_DB_URL) {
        env.GOOBSTER_DB_URL = process.env.GOOBSTER_DB_URL;
        env.GOOBSTER_PG_TEST_ISOLATE = '1';
        // A whole runtime, not a suite worker: the isolation default of 3
        // pooled clients deadlocks the boot's singleton locks
        // (documentation/packaging.md).
        env.GOOBSTER_PG_POOL_SIZE = process.env.GOOBSTER_PG_POOL_SIZE || '10';
    } else {
        env.GOOBSTER_DB_PATH = path.join(dir, 'data', 'api.sqlite');
    }
    return env;
}

function spawnApi(dir, port) {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'manager'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webapp: { enabled: true, devMode: true } }));
    const child = spawn(process.execPath, [path.join(REPO, 'apps', 'api', 'index.js')], {
        cwd: REPO,
        env: childEnv(dir, port),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = { text: '' };
    child.stdout.on('data', (chunk) => { output.text += chunk; });
    child.stderr.on('data', (chunk) => { output.text += chunk; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    const stop = async (graceMs = 10_000) => {
        child.kill('SIGTERM');
        const forced = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
        try {
            return await exited;
        } finally {
            clearTimeout(forced);
        }
    };
    return { child, output, exited, stop };
}

async function waitForHealth(port, exited, output) {
    const deadline = Date.now() + 60_000;
    let gone = null;
    exited.then((result) => { gone = result; });
    while (Date.now() < deadline) {
        if (gone) throw new Error(`api exited before it was healthy (${JSON.stringify(gone)}): ${output.text.slice(-600)}`);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) return res.json();
        } catch { /* not listening yet */ }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`api did not become healthy in time: ${output.text.slice(-600)}`);
}

async function waitUntil(predicate, { timeoutMs = 20_000, what = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function signIn(port) {
    const res = await fetch(`http://127.0.0.1:${port}/api/app/auth/dev-session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: USER, name: 'fence probe' })
    });
    return { status: res.status, cookie: res.status === 200 ? res.headers.get('set-cookie').split(';')[0] : null, body: await res.json().catch(() => null) };
}

const portalCall = (port, cookie, { method = 'GET', route, body }) => fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
});

describe(`real apps/api processes (${ENGINE})`, () => {
    const roots = [];
    const running = [];

    afterEach(async () => {
        while (running.length) await running.pop().stop();
        while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
    });

    function newDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-fence-api-'));
        roots.push(dir);
        return dir;
    }

    function managerSide(dir, port) {
        const settings = resolveSettings({ GOOBSTER_DATA_DIR: path.join(dir, 'data'), GOOBSTER_CONFIG_PATH: path.join(dir, 'config.json'), GOOBSTER_MANAGER_STATE_DIR: path.join(dir, 'manager') });
        const barrier = createBarrier({ settings, logger: quiet, bootId: 'manager-under-test', timing: { pollMs: 50, resumeWaitMs: 15_000 } });
        const target = { name: 'api', healthUrl: `http://127.0.0.1:${port}/health`, external: true, pid: null, running: true, state: 'external', fenceAck: null };
        return { settings, barrier, resolved: { layout: 'standalone', targets: [target], refresh: () => [target] } };
    }

    test('a running api is fenced by the barrier: portal writes are 503, reads work, a websocket is refused; release resumes it', async () => {
        const dir = newDir();
        const port = await freePort();
        const api = spawnApi(dir, port);
        running.push(api);
        await waitForHealth(port, api.exited, api.output);
        const { cookie, status } = await signIn(port);
        expect(status).toBe(200);

        const created = await portalCall(port, cookie, { method: 'POST', route: '/api/app/chat/conversations' });
        expect(created.status).toBe(200);
        const countConversations = async () => (await (await portalCall(port, cookie, { route: '/api/app/chat/conversations' })).json()).conversations.length;
        expect(await countConversations()).toBe(1);

        const { barrier, resolved } = managerSide(dir, port);
        const { fence } = barrier.begin({ operationId: 'op-fence-1', actor: 'owner-1', via: 'bridge', reason: 'restore' });
        const { writers, sent } = await barrier.quiesce({ operationId: 'op-fence-1', fence, resolved, timeoutSeconds: 30, actor: 'owner-1' });
        expect(writers.api).toMatchObject({ acked: true });
        const state = await barrier.verify({ operationId: 'op-fence-1', fence, resolved, writers, sent, actor: 'owner-1' });
        expect(state).toMatchObject({ active: true, phase: 'quiesced', fence: 1 });
        expect(writers.api.pid).toBe(api.child.pid);

        const refused = await portalCall(port, cookie, { method: 'POST', route: '/api/app/chat/conversations' });
        expect(refused.status).toBe(503);
        expect(await refused.json()).toMatchObject({ error: 'MAINTENANCE' });
        expect(refused.headers.get('retry-after')).toBe(String(maintenance.RETRY_AFTER_SECONDS));
        const second = await portalCall(port, cookie, { method: 'POST', route: '/api/app/chat/conversations', body: { title: 'again' } });
        expect(second.status).toBe(503);
        expect(await countConversations()).toBe(1);
        expect((await portalCall(port, cookie, { route: '/api/app/me' })).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
        expect((await upgrade(port, '/api/app/parlor/live', { cookie })).status).toBe(503);

        const out = await barrier.release({ operationId: 'op-fence-1', fence, actor: 'owner-1' });
        expect(out).toMatchObject({ outcome: 'released', resumed: ['api'], unconfirmed: [] });
        const again = await portalCall(port, cookie, { method: 'POST', route: '/api/app/chat/conversations' });
        expect(again.status).toBe(200);
        expect(await countConversations()).toBe(2);
    }, 120_000);

    test('an api that boots while the barrier is up never starts writing, acknowledges the fence it found, and resumes from the store alone', async () => {
        const dir = newDir();
        const port = await freePort();
        const { settings, barrier } = managerSide(dir, port);
        fs.mkdirSync(settings.storeDir, { recursive: true });
        const { fence } = barrier.begin({ operationId: 'op-fence-2', actor: 'owner-1', via: 'bridge', reason: 'reset' });

        const api = spawnApi(dir, port);
        running.push(api);
        await waitForHealth(port, api.exited, api.output);
        const env = { GOOBSTER_MANAGER_STATE_DIR: settings.storeDir };
        const ack = await waitUntil(() => maintenance.readFenceAck('api', { env }), { what: 'boot acknowledgement' });
        expect(ack).toMatchObject({ fence, state: 'fenced', pid: api.child.pid });

        const signedIn = await signIn(port);
        expect(signedIn.status).toBe(503);
        expect(signedIn.body).toMatchObject({ error: 'MAINTENANCE' });
        expect((await fetch(`http://127.0.0.1:${port}/api/app/me`)).status).toBe(401);

        const doc = barrier.store.update((next) => {
            next.active = false;
            next.phase = null;
            next.operationId = null;
            return next;
        });
        expect(doc.active).toBe(false);
        const resumed = await waitUntil(async () => (await signIn(port)).status === 200, { what: 'the worker to resume from the store', timeoutMs: 20_000 });
        expect(resumed).toBe(true);
    }, 120_000);
});
