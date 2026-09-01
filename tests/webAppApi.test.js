/**
 * HTTP-level tests for the web app backend (web/appApi.js): session auth,
 * dev-session minting, the origin guard, the SSE chat stream, and the
 * memory dashboard's access rules - against a throwaway SQLite database
 * and a fake Discord client.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-webapp-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const { dmScopeId } = require('@goobster/core/utils/dmScope');
const eventBusService = require('@goobster/core/services/eventBusService');

const USER = '100000000000000001';
const OTHER = '100000000000000002';
const GUILD = '200000000000000001';
const BOT = '900000000000000001';

let server;
let port;
let manageGuildPermission = false;
let memberIds = new Set([USER]);

// The React build is the only web client; give the static routes an
// index.html to serve when apps/web/dist is absent (e.g. bare CI).
const DIST_DIR = path.join(__dirname, '../apps/web/dist');
const DIST_INDEX = path.join(DIST_DIR, 'index.html');
const DIST_FIXTURE = '<!doctype html><html><head><title>Goobster</title></head><body><div id="root"></div></body></html>';
let wroteDistFixture = false;

const fakeGuild = {
    id: GUILD,
    name: 'Test Guild',
    iconURL: () => null,
    members: {
        fetch: async (userId) => {
            if (!memberIds.has(userId)) throw new Error('Unknown Member');
            return { permissions: { has: () => manageGuildPermission } };
        }
    }
};

const fakeClient = {
    user: { id: BOT, username: 'Goobster' },
    guilds: { cache: new Map([[GUILD, fakeGuild]]) }
};

/** Fake chat service for the chat routes (the real one is tested separately). */
const fakeChat = {
    maxInputLength: 20000,
    getHistory: jest.fn(() => [{ id: 1, role: 'user', content: 'hi', createdAt: '2026-01-01 00:00:00' }]),
    getFile: jest.fn(() => null),
    listConversations: jest.fn(() => [{ id: 7, title: 'Pi plans', messageCount: 2 }]),
    createConversation: jest.fn(() => ({ id: 8, title: null, messageCount: 0 })),
    renameConversation: jest.fn(({ conversationId, title }) => ({ id: Number(conversationId), title })),
    deleteConversation: jest.fn(() => ({ deleted: true, deletedMessages: 2 })),
    truncateFrom: jest.fn(() => ({ deleted: 2 })),
    stopTurn: jest.fn(() => true),
    getAiSettings: jest.fn(async () => ({ thoughtful: false, thoughtfulAvailable: true, model: 'gpt-everyday', provider: null })),
    setThoughtful: jest.fn(async ({ thoughtful }) => ({ thoughtful, thoughtfulAvailable: true, model: 'gpt-x', provider: null })),
    extractDocumentFiles: jest.fn(async (files) => files),
    listModels: jest.fn(async () => (['gpt-everyday', 'gpt-thoughtful'])),
    searchMessages: jest.fn(() => ([
        { conversationId: 7, title: 'Pi plans', messageId: 42, role: 'user', snippet: 'the pi cluster', createdAt: '2026-01-01 00:00:00' }
    ])),
    startTurn: jest.fn(() => ({
        conversationId: 7,
        abort: () => {},
        release: () => {},
        run: async (events) => {
            events.onTyping();
            events.onTool?.({ phase: 'start', name: 'performSearch', cached: false });
            events.onTool?.({ phase: 'result', name: 'performSearch', isError: false, cached: false });
            events.onDelta('Hel');
            events.onDelta('lo');
            events.onMessage({ content: 'Hello!', attachments: [], isError: false });
        }
    })),
    branchFrom: jest.fn(({ conversationId, messageId }) => ({
        id: 9, title: 'Pi plans (branch)', parentConversationId: Number(conversationId),
        branchedFromMessageId: Number(messageId), messageCount: 2
    })),
    createShareLink: jest.fn(() => ({ token: 'a'.repeat(40), url: `/app/share/${'a'.repeat(40)}`, createdAt: '2026-01-01 00:00:00' })),
    getShareLink: jest.fn(() => ({ shared: false })),
    revokeShareLink: jest.fn(() => ({ revoked: true })),
    getSharedConversation: jest.fn((token) => {
        if (token !== 'a'.repeat(40)) {
            const error = new Error('This share link does not exist (or was revoked).');
            error.status = 404;
            error.code = 'NOT_FOUND';
            throw error;
        }
        return {
            title: 'Pi plans',
            sharedAt: '2026-01-01 00:00:00',
            messages: [{ role: 'user', content: 'hi', createdAt: '2026-01-01 00:00:00' }]
        };
    })
};

/** Fake voice bridge (the real one is tested in webVoiceService.test.js). */
const { Readable } = require('node:stream');
const fakeVoice = {
    capabilities: jest.fn(() => ({ stt: true, tts: true })),
    transcribe: jest.fn(async () => ({ text: 'dictated text' })),
    synthesize: jest.fn(async () => ({ stream: Readable.from([Buffer.from('mp3bytes')]), contentType: 'audio/mpeg' }))
};

/**
 * Fake exchange terminal (the real one, including its guild-membership gate
 * and domain-error translation, is tested in webExchangeService.test.js).
 */
const fakeExchange = {
    overview: jest.fn(async () => ({
        currencyName: 'Jimbucks',
        features: { marginEnabled: true, optionsEnabled: true },
        audit: { snapshot: { cash: 500 }, risks: [] }
    })),
    quote: jest.fn(async () => ({ quote: { symbol: 'AAPL', price: 210.5 }, balance: 500 })),
    history: jest.fn(async () => ({ symbol: 'AAPL', points: [{ date: '2026-01-02', close: 200 }] })),
    search: jest.fn(async () => ([{ symbol: 'AAPL', name: 'Apple Inc.' }])),
    tradeStock: jest.fn(async () => ({ symbol: 'AAPL', units: 2, price: 210.5, cost: 421, balance: 79 })),
    chain: jest.fn(async () => ({ underlying: 'AAPL', expiry: '2026-09-18', rows: [], simulated: true })),
    tradeOption: jest.fn(async () => ({ positionId: 4, contracts: 1, cost: 300, balance: 200 })),
    listOrders: jest.fn(async () => ([{ id: 11, symbol: 'AAPL', status: 'OPEN' }])),
    placeOrder: jest.fn(async () => ({ order: { id: 12, status: 'OPEN' }, triggerHint: 'fills at or below $200.00' })),
    cancelOrder: jest.fn(async () => ({ id: 12, status: 'CANCELLED' })),
    leaderboard: jest.fn(async () => ({ currencyName: 'Jimbucks', rows: [{ userId: USER, equity: 900 }] }))
};

/** Fake tasks service (the real one is tested in webTaskService.test.js). */
const fakeTasks = {
    listTasks: jest.fn(() => ({ automations: [{ id: 1, name: 'brief' }], followups: [] })),
    createTask: jest.fn(async () => ({ id: 2, kind: 'automation', nextRun: '2026-01-02 09:00:00' })),
    setAutomationEnabled: jest.fn(() => ({ id: 1, enabled: false })),
    deleteAutomation: jest.fn(() => ({ deleted: true })),
    cancelFollowup: jest.fn(() => ({ cancelled: true }))
};

function request({ method = 'GET', reqPath = '/', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** Mint a dev session and return its Cookie header value. */
async function login(userId = USER, name = 'rob') {
    const res = await request({
        method: 'POST',
        reqPath: '/api/app/auth/dev-session',
        body: { userId, name }
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session='));
    return setCookie.split(';')[0];
}

beforeAll((done) => {
    if (!fs.existsSync(DIST_INDEX)) {
        fs.mkdirSync(DIST_DIR, { recursive: true });
        fs.writeFileSync(DIST_INDEX, DIST_FIXTURE);
        wroteDistFixture = true;
    }
    const ctx = createWebAppContext({
        client: fakeClient,
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { chat: fakeChat, voice: fakeVoice, tasks: fakeTasks, exchange: fakeExchange }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
    if (wroteDistFixture) {
        try { fs.unlinkSync(DIST_INDEX); } catch { /* already gone */ }
        try { fs.rmdirSync(DIST_DIR); } catch { /* dist had other files */ }
    }
});

beforeEach(async () => {
    jest.clearAllMocks();
    manageGuildPermission = false;
    memberIds = new Set([USER]);
    await db.run('DELETE FROM web_sessions');
    await db.run('DELETE FROM facts');
    await db.run('DELETE FROM memory_embeddings');
    await db.run('DELETE FROM kg_node_revisions');
    await db.run('DELETE FROM kg_nodes');
    await db.run('DELETE FROM web_applets');
    for (const table of [
        'attention_feedback', 'attention_notices', 'attention_provenance',
        'attention_items', 'attention_watches', 'attention_state', 'attention_policies'
    ]) {
        await db.run(`DELETE FROM ${table}`);
    }
});

describe('authentication', () => {
    test('API routes require a session', async () => {
        for (const reqPath of ['/api/app/me', '/api/app/chat/history', '/api/app/memory/facts?scope=x']) {
            const res = await request({ reqPath });
            expect(res.status).toBe(401);
            expect(res.json.error.code).toBe('UNAUTHENTICATED');
        }
    });

    test('config bootstrap is public and reports capabilities', async () => {
        const res = await request({ reqPath: '/api/app/config' });
        expect(res.status).toBe(200);
        expect(res.json).toEqual(expect.objectContaining({
            clientId: '123', devMode: true, maxInputLength: 20000
        }));
        expect(res.json.nextClient).toBeUndefined();
    });

    test('a dev session mints an httpOnly cookie and /me works with it', async () => {
        const cookie = await login();
        const res = await request({ reqPath: '/api/app/me', headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.user).toEqual(expect.objectContaining({ id: USER, name: 'rob' }));
        expect(res.json.bot).toEqual({ id: BOT, name: 'Goobster' });
        // Scopes: the DM scope plus the shared guild
        expect(res.json.scopes.map(s => s.id)).toEqual([dmScopeId(USER), GUILD]);
    });

    test('logout destroys the session', async () => {
        const cookie = await login();
        await request({ method: 'POST', reqPath: '/api/app/auth/logout', headers: { Cookie: cookie } });
        const res = await request({ reqPath: '/api/app/me', headers: { Cookie: cookie } });
        expect(res.status).toBe(401);
    });

    test('state-changing requests from a foreign Origin are rejected', async () => {
        const cookie = await login();
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/chat',
            headers: { Cookie: cookie, Origin: 'https://evil.example.com' },
            body: { message: 'hi' }
        });
        expect(res.status).toBe(403);
        expect(res.json.error.code).toBe('BAD_ORIGIN');
        expect(fakeChat.startTurn).not.toHaveBeenCalled();
    });

    test('same-origin state-changing requests pass the guard', async () => {
        const cookie = await login();
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/chat',
            headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
            body: { message: 'hi' }
        });
        expect(res.status).toBe(200);
    });
});

describe('chat routes', () => {
    test('history returns the stored conversation', async () => {
        const cookie = await login();
        const res = await request({ reqPath: '/api/app/chat/history', headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.messages).toHaveLength(1);
        expect(fakeChat.getHistory).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }));
    });

    test('a chat turn streams SSE events in order', async () => {
        const cookie = await login();
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/chat',
            headers: { Cookie: cookie },
            body: { message: 'hi there', conversationId: 7 }
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');

        const events = res.raw.split('\n\n').filter(Boolean).map(block => {
            const event = block.match(/^event: (.*)$/m)?.[1];
            const data = block.match(/^data: (.*)$/m)?.[1];
            return { event, data: data ? JSON.parse(data) : null };
        });
        expect(events.map(e => e.event)).toEqual(['start', 'typing', 'tool', 'tool', 'delta', 'delta', 'message', 'done']);
        expect(events[0].data.conversationId).toBe(7);
        expect(events[2].data).toEqual({ phase: 'start', name: 'performSearch', cached: false });
        expect(events[4].data.text).toBe('Hel');
        expect(events[6].data.content).toBe('Hello!');
        expect(fakeChat.startTurn).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER, userName: 'rob', message: 'hi there', conversationId: 7
        }));
    });

    test('conversation CRUD routes delegate with the session user', async () => {
        const cookie = await login();

        const list = await request({ reqPath: '/api/app/chat/conversations', headers: { Cookie: cookie } });
        expect(list.status).toBe(200);
        expect(list.json.conversations[0].title).toBe('Pi plans');

        const created = await request({
            method: 'POST', reqPath: '/api/app/chat/conversations', headers: { Cookie: cookie }
        });
        expect(created.status).toBe(200);
        expect(fakeChat.createConversation).toHaveBeenCalledWith(USER);

        const renamed = await request({
            method: 'PATCH', reqPath: '/api/app/chat/conversations/7',
            headers: { Cookie: cookie }, body: { title: 'Better title' }
        });
        expect(renamed.status).toBe(200);
        expect(fakeChat.renameConversation).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, conversationId: '7', title: 'Better title' }));

        const deleted = await request({
            method: 'DELETE', reqPath: '/api/app/chat/conversations/7', headers: { Cookie: cookie }
        });
        expect(deleted.status).toBe(200);
        expect(fakeChat.deleteConversation).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, conversationId: '7' }));
    });

    test('truncate, stop, and settings routes delegate correctly', async () => {
        const cookie = await login();

        const truncated = await request({
            method: 'POST', reqPath: '/api/app/chat/truncate',
            headers: { Cookie: cookie }, body: { conversationId: 7, messageId: 41 }
        });
        expect(truncated.status).toBe(200);
        expect(fakeChat.truncateFrom).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, conversationId: 7, messageId: 41 }));

        const stopped = await request({
            method: 'POST', reqPath: '/api/app/chat/stop', headers: { Cookie: cookie }
        });
        expect(stopped.status).toBe(200);
        expect(stopped.json.stopped).toBe(true);
        expect(fakeChat.stopTurn).toHaveBeenCalledWith(USER);

        const settings = await request({ reqPath: '/api/app/chat/settings', headers: { Cookie: cookie } });
        expect(settings.status).toBe(200);
        expect(settings.json.thoughtfulAvailable).toBe(true);

        const toggled = await request({
            method: 'PATCH', reqPath: '/api/app/chat/settings',
            headers: { Cookie: cookie }, body: { thoughtful: true }
        });
        expect(toggled.status).toBe(200);
        expect(toggled.json.thoughtful).toBe(true);
        expect(fakeChat.setThoughtful).toHaveBeenCalledWith({ userId: USER, thoughtful: true });
    });

    test('the model listing route delegates the provider choice', async () => {
        const cookie = await login();
        const res = await request({
            reqPath: '/api/app/chat/models?provider=openai',
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(200);
        expect(res.json.models).toEqual(['gpt-everyday', 'gpt-thoughtful']);
        expect(fakeChat.listModels).toHaveBeenCalledWith('openai');
    });

    test('full-text search delegates with the session user', async () => {
        const cookie = await login();
        const res = await request({
            reqPath: '/api/app/chat/search?q=pi%20cluster',
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(200);
        expect(res.json.results[0].messageId).toBe(42);
        expect(fakeChat.searchMessages).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, query: 'pi cluster' })
        );
    });

    test('turn validation failures stay proper HTTP errors (no stream)', async () => {
        const cookie = await login();
        fakeChat.startTurn.mockImplementationOnce(() => {
            const { WebChatError } = require('@goobster/core/services/webChatService');
            throw new WebChatError(429, 'RATE_LIMITED', 'Slow down.');
        });
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/chat',
            headers: { Cookie: cookie },
            body: { message: 'hi' }
        });
        expect(res.status).toBe(429);
        expect(res.json.error.code).toBe('RATE_LIMITED');
    });
});

describe('memory dashboard access rules', () => {
    async function seedDashboardData() {
        await db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@g, 'USER', @u, 'rob likes trains')`,
            { g: GUILD, u: USER });
        await db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@g, 'USER', @o, 'alice likes planes')`,
            { g: GUILD, o: OTHER });
        await db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@dm, 'USER', @u, 'dm-scope fact')`,
            { dm: dmScopeId(USER), u: USER });
        await db.run(`INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
                VALUES (@g, @u, 'rob', 'rob guild memory', x'00000000', 1, 'test/model')`, { g: GUILD, u: USER });
        await db.run(`INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
                VALUES (@g, @o, 'alice', 'alice guild memory', x'00000000', 1, 'test/model')`, { g: GUILD, o: OTHER });
    }

    test('a user only sees their own facts in a guild scope', async () => {
        await seedDashboardData();
        const cookie = await login();
        const res = await request({
            reqPath: `/api/app/memory/facts?scope=${GUILD}`,
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(200);
        expect(res.json.facts.map(f => f.content)).toEqual(['rob likes trains']);
    });

    test('another user\'s DM scope is forbidden', async () => {
        const cookie = await login();
        const res = await request({
            reqPath: `/api/app/memory/facts?scope=${encodeURIComponent(dmScopeId(OTHER))}`,
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(403);
    });

    test('a guild the user is not a member of is forbidden', async () => {
        memberIds = new Set(); // fetch throws for everyone
        const cookie = await login();
        const res = await request({
            reqPath: `/api/app/memory/memories?scope=${GUILD}`,
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(403);
        expect(res.json.error.code).toBe('NOT_A_MEMBER');
    });

    test('deleting a memory works for your own rows and 404s for others', async () => {
        await seedDashboardData();
        const cookie = await login();
        const own = (await db.get(`SELECT id FROM memory_embeddings WHERE authorId = @u`, { u: USER })).id;
        const theirs = (await db.get(`SELECT id FROM memory_embeddings WHERE authorId = @o`, { o: OTHER })).id;

        const okRes = await request({
            method: 'DELETE',
            reqPath: `/api/app/memory/memories/${own}?scope=${GUILD}`,
            headers: { Cookie: cookie }
        });
        expect(okRes.status).toBe(200);

        const denyRes = await request({
            method: 'DELETE',
            reqPath: `/api/app/memory/memories/${theirs}?scope=${GUILD}`,
            headers: { Cookie: cookie }
        });
        expect(denyRes.status).toBe(404);
        expect((await db.get('SELECT COUNT(*) AS c FROM memory_embeddings')).c).toBe(1);
    });

    test('the transparency report answers for an accessible scope', async () => {
        await seedDashboardData();
        const cookie = await login();
        const res = await request({
            reqPath: `/api/app/memory/report?scope=${GUILD}`,
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(200);
        expect(res.json.facts).toHaveLength(1);
        expect(res.json.memories.count).toBe(1);
    });

    test('the knowledge graph requires Manage Server', async () => {
        await db.run(`INSERT INTO kg_nodes (guildId, type, label, salience) VALUES (@g, 'person', 'Rob', 0.9)`, { g: GUILD });
        const cookie = await login();

        const denied = await request({
            reqPath: `/api/app/graph?guildId=${GUILD}`,
            headers: { Cookie: cookie }
        });
        expect(denied.status).toBe(403);

        manageGuildPermission = true;
        const allowed = await request({
            reqPath: `/api/app/graph?guildId=${GUILD}`,
            headers: { Cookie: cookie }
        });
        expect(allowed.status).toBe(200);
        expect(allowed.json.nodes.map(n => n.label)).toEqual(['Rob']);
        expect(allowed.json).toEqual(expect.objectContaining({
            edges: [], thoughts: [], scratchpad: []
        }));
    });
});

describe('branching and share routes', () => {
    test('branch delegates with the session user', async () => {
        const cookie = await login();
        const res = await request({
            method: 'POST', reqPath: '/api/app/chat/conversations/7/branch',
            headers: { Cookie: cookie }, body: { messageId: 41 }
        });
        expect(res.status).toBe(200);
        expect(res.json.parentConversationId).toBe(7);
        expect(fakeChat.branchFrom).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, conversationId: '7', messageId: 41 }));
    });

    test('share create/get/revoke require auth and delegate', async () => {
        const cookie = await login();
        const created = await request({
            method: 'POST', reqPath: '/api/app/chat/conversations/7/share', headers: { Cookie: cookie }
        });
        expect(created.status).toBe(200);
        expect(created.json.url).toBe(`/app/share/${'a'.repeat(40)}`);

        const state = await request({
            reqPath: '/api/app/chat/conversations/7/share', headers: { Cookie: cookie }
        });
        expect(state.status).toBe(200);
        expect(state.json.shared).toBe(false);

        const revoked = await request({
            method: 'DELETE', reqPath: '/api/app/chat/conversations/7/share', headers: { Cookie: cookie }
        });
        expect(revoked.status).toBe(200);
        expect(revoked.json.revoked).toBe(true);

        const noAuth = await request({ method: 'POST', reqPath: '/api/app/chat/conversations/7/share' });
        expect(noAuth.status).toBe(401);
    });

    test('the public share endpoint needs NO auth and 404s unknown tokens', async () => {
        const ok = await request({ reqPath: `/api/app/share/${'a'.repeat(40)}` });
        expect(ok.status).toBe(200);
        expect(ok.json.title).toBe('Pi plans');
        expect(ok.json.messages).toHaveLength(1);

        const missing = await request({ reqPath: `/api/app/share/${'b'.repeat(40)}` });
        expect(missing.status).toBe(404);
        expect(missing.json.error.code).toBe('NOT_FOUND');
    });

    test('the pretty share URL serves the SPA (the share view is a client route)', async () => {
        const res = await request({ reqPath: `/app/share/${'a'.repeat(40)}` });
        expect(res.status).toBe(200);
        expect(res.raw).toContain('id="root"');
    });
});

describe('voice routes', () => {
    test('capabilities, transcription, and TTS streaming delegate', async () => {
        const cookie = await login();

        const caps = await request({ reqPath: '/api/app/voice/capabilities', headers: { Cookie: cookie } });
        expect(caps.status).toBe(200);
        expect(caps.json).toEqual({ stt: true, tts: true });

        const stt = await request({
            method: 'POST', reqPath: '/api/app/voice/transcribe',
            headers: { Cookie: cookie }, body: { audio: 'aGk=', mimeType: 'audio/webm' }
        });
        expect(stt.status).toBe(200);
        expect(stt.json.text).toBe('dictated text');
        expect(fakeVoice.transcribe).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, audioBase64: 'aGk=', mimeType: 'audio/webm' }));

        const tts = await request({
            method: 'POST', reqPath: '/api/app/voice/tts',
            headers: { Cookie: cookie }, body: { text: 'Read me.' }
        });
        expect(tts.status).toBe(200);
        expect(tts.headers['content-type']).toContain('audio/mpeg');
        expect(tts.raw).toBe('mp3bytes');
    });

    test('voice errors keep their status + code', async () => {
        const cookie = await login();
        fakeVoice.synthesize.mockRejectedValueOnce(
            Object.assign(new Error('no key'), { status: 503, code: 'TTS_UNAVAILABLE' }));
        const res = await request({
            method: 'POST', reqPath: '/api/app/voice/tts',
            headers: { Cookie: cookie }, body: { text: 'Read me.' }
        });
        expect(res.status).toBe(503);
        expect(res.json.error.code).toBe('TTS_UNAVAILABLE');
    });

    test('voice routes require a session', async () => {
        const res = await request({ method: 'POST', reqPath: '/api/app/voice/transcribe', body: {} });
        expect(res.status).toBe(401);
    });
});

describe('tasks routes', () => {
    test('list/create/toggle/delete/cancel delegate with the session user', async () => {
        const cookie = await login();

        const list = await request({ reqPath: '/api/app/tasks', headers: { Cookie: cookie } });
        expect(list.status).toBe(200);
        expect(list.json.automations).toHaveLength(1);
        expect(fakeTasks.listTasks).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }));

        const created = await request({
            method: 'POST', reqPath: '/api/app/tasks',
            headers: { Cookie: cookie },
            body: { name: 'brief', prompt: 'p', cron: '0 9 * * *' }
        });
        expect(created.status).toBe(200);
        expect(fakeTasks.createTask).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, name: 'brief', cron: '0 9 * * *', dueAt: null }));

        const toggled = await request({
            method: 'PATCH', reqPath: '/api/app/tasks/automations/1',
            headers: { Cookie: cookie }, body: { enabled: false }
        });
        expect(toggled.status).toBe(200);
        expect(fakeTasks.setAutomationEnabled).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, automationId: '1', enabled: false }));

        const deleted = await request({
            method: 'DELETE', reqPath: '/api/app/tasks/automations/1', headers: { Cookie: cookie }
        });
        expect(deleted.status).toBe(200);

        const cancelled = await request({
            method: 'DELETE', reqPath: '/api/app/tasks/followups/3', headers: { Cookie: cookie }
        });
        expect(cancelled.status).toBe(200);
        expect(fakeTasks.cancelFollowup).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, followupId: '3' }));
    });
});

// The Assistant Inbox routes run against the real service and database (it
// is cheap and DB-backed), so these cover route -> service -> storage.
describe('attention routes', () => {
    const ledger = require('@goobster/core/services/attentionLedgerService');
    const attentionService = require('@goobster/core/services/attentionService');

    test('not being enrolled is a state, not an error', async () => {
        const cookie = await login();
        const res = await request({ reqPath: '/api/app/attention', headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.enrolled).toBe(false);
        expect(res.json.policy).toBeNull();
        expect(res.json.initiativeLevels).toContain('nudge');
    });

    test('enrolling, tuning, and disabling round-trip through the policy', async () => {
        const cookie = await login();

        const enrolled = await request({
            method: 'POST', reqPath: '/api/app/attention/enroll',
            headers: { Cookie: cookie }, body: { initiative: 'assist' }
        });
        expect(enrolled.status).toBe(200);
        expect(enrolled.json.policy.initiative).toBe('assist');

        const tuned = await request({
            method: 'PATCH', reqPath: '/api/app/attention/policy',
            headers: { Cookie: cookie },
            body: {
                initiative: 'observe',
                maxContactsPerDay: 1,
                contactCooldownMinutes: 600,
                quietStartMinute: 22 * 60,
                quietEndMinute: 7 * 60
            }
        });
        expect(tuned.status).toBe(200);
        expect(tuned.json.policy).toMatchObject({
            initiative: 'observe',
            maxContactsPerDay: 1,
            contactCooldownMinutes: 600,
            quietStartMinute: 22 * 60,
            quietEndMinute: 7 * 60
        });

        const overview = await request({ reqPath: '/api/app/attention', headers: { Cookie: cookie } });
        expect(overview.json.enrolled).toBe(true);
        // Boundaries are reported merged with the shipped defaults, so the
        // pane can render the effective permission without knowing them.
        expect(overview.json.boundaries.github.externalWrite).toBe('never');

        const disabled = await request({
            method: 'POST', reqPath: '/api/app/attention/disable', headers: { Cookie: cookie }
        });
        expect(disabled.status).toBe(200);
        expect((await request({ reqPath: '/api/app/attention', headers: { Cookie: cookie } })).json.enrolled)
            .toBe(false);
    });

    test('tuning refuses a bad initiative level, and refuses before enrollment', async () => {
        const cookie = await login();
        const early = await request({
            method: 'PATCH', reqPath: '/api/app/attention/policy',
            headers: { Cookie: cookie }, body: { initiative: 'nudge' }
        });
        expect(early.status).toBe(409);
        expect(early.json.error.code).toBe('NOT_ENROLLED');

        await request({
            method: 'POST', reqPath: '/api/app/attention/enroll', headers: { Cookie: cookie }, body: {}
        });
        const bad = await request({
            method: 'PATCH', reqPath: '/api/app/attention/policy',
            headers: { Cookie: cookie }, body: { initiative: 'omniscient' }
        });
        expect(bad.status).toBe(400);
        expect(bad.json.error.code).toBe('BAD_INITIATIVE');
    });

    test('reacting to a notice records feedback; another user cannot', async () => {
        const cookie = await login();
        await request({
            method: 'POST', reqPath: '/api/app/attention/enroll', headers: { Cookie: cookie }, body: {}
        });
        const noticeId = Number(await db.insert(
            `INSERT INTO attention_notices (userId, dedupeKey, category, title, disposition, score)
             VALUES (@u, 'route:test', 'schedule', 'Presentation is Thursday', 'inbox', 0.4)`,
            { u: USER }
        ));

        const dismissed = await request({
            method: 'POST', reqPath: `/api/app/attention/notices/${noticeId}`,
            headers: { Cookie: cookie }, body: { action: 'dismiss' }
        });
        expect(dismissed.status).toBe(200);
        expect(dismissed.json.notice.status).toBe('dismissed');

        const feedback = await db.get(
            `SELECT COUNT(*) AS c FROM attention_feedback
             WHERE userId = @u AND signal = 'dismissed'`,
            { u: USER }
        );
        expect(feedback.c).toBe(1);

        const otherCookie = await login(OTHER, 'someone else');
        const stolen = await request({
            method: 'POST', reqPath: `/api/app/attention/notices/${noticeId}`,
            headers: { Cookie: otherCookie }, body: { action: 'dismiss' }
        });
        expect(stolen.status).toBe(404);
    });

    test('an unknown notice action is refused', async () => {
        const cookie = await login();
        const res = await request({
            method: 'POST', reqPath: '/api/app/attention/notices/1',
            headers: { Cookie: cookie }, body: { action: 'explode' }
        });
        expect(res.status).toBe(404);
    });

    test('open loops can be closed or dropped, but never invented', async () => {
        const cookie = await login();
        await request({
            method: 'POST', reqPath: '/api/app/attention/enroll', headers: { Cookie: cookie }, body: {}
        });
        const { id } = await ledger.upsertItem({
            guildId: dmScopeId(USER), userId: USER, kind: 'commitment', subject: 'dbt demo'
        });
        await ledger.addProvenance({ itemId: id, sourceKind: 'memory', sourceId: 5 });

        const detail = await request({
            reqPath: `/api/app/attention/items/${id}`, headers: { Cookie: cookie }
        });
        expect(detail.status).toBe(200);
        expect(detail.json.provenance).toHaveLength(1);

        const resolved = await request({
            method: 'POST', reqPath: `/api/app/attention/items/${id}/resolve`,
            headers: { Cookie: cookie }, body: { state: 'resolved' }
        });
        expect(resolved.status).toBe(200);
        expect(resolved.json.item.state).toBe('resolved');

        const badState = await request({
            method: 'POST', reqPath: `/api/app/attention/items/${id}/resolve`,
            headers: { Cookie: cookie }, body: { state: 'transcended' }
        });
        expect(badState.status).toBe(400);

        // There is no route that creates one: loops come from evidence.
        const invented = await request({
            method: 'POST', reqPath: '/api/app/attention/items',
            headers: { Cookie: cookie }, body: { subject: 'made up' }
        });
        expect(invented.status).toBe(404);
    });

    test('another user\'s loop is not readable or resolvable', async () => {
        const { id } = await ledger.upsertItem({
            guildId: dmScopeId(OTHER), userId: OTHER, kind: 'goal', subject: 'private thing'
        });
        const cookie = await login();
        expect((await request({
            reqPath: `/api/app/attention/items/${id}`, headers: { Cookie: cookie }
        })).status).toBe(404);
        expect((await request({
            method: 'POST', reqPath: `/api/app/attention/items/${id}/resolve`,
            headers: { Cookie: cookie }, body: {}
        })).status).toBe(404);
    });

    test('the overview carries notices, loops, and calibration together', async () => {
        const cookie = await login();
        await request({
            method: 'POST', reqPath: '/api/app/attention/enroll', headers: { Cookie: cookie }, body: {}
        });
        await ledger.upsertItem({
            guildId: dmScopeId(USER), userId: USER, kind: 'deadline', subject: 'presentation'
        });
        await db.insert(
            `INSERT INTO attention_notices (userId, dedupeKey, category, title, disposition, score)
             VALUES (@u, 'route:overview', 'observatory', 'A run failed', 'inbox', 0.3)`,
            { u: USER }
        );
        for (let i = 0; i < 5; i++) {
            await attentionService.recordFeedback({
                userId: USER, category: 'observatory', signal: 'acted_on'
            });
        }

        const res = await request({ reqPath: '/api/app/attention', headers: { Cookie: cookie } });
        expect(res.json.notices).toHaveLength(1);
        expect(res.json.items).toHaveLength(1);
        const observatory = res.json.calibration.find(row => row.category === 'observatory');
        expect(observatory.actedOn).toBe(5);
        // Acting on things lowers the bar for that category.
        expect(observatory.thresholds.dm).toBeLessThan(0.75);
    });

    test('a watch can be disarmed, and only by its owner', async () => {
        const watches = require('@goobster/core/services/attentionWatchService');
        const cookie = await login();
        const watch = await watches.register({
            userId: USER, guildId: dmScopeId(USER), label: 'run result',
            topic: 'observatory.job_completed', prompt: 'inspect it'
        });

        const otherCookie = await login(OTHER, 'someone else');
        expect((await request({
            method: 'DELETE', reqPath: `/api/app/attention/watches/${watch.id}`,
            headers: { Cookie: otherCookie }
        })).status).toBe(404);

        const disarmed = await request({
            method: 'DELETE', reqPath: `/api/app/attention/watches/${watch.id}`,
            headers: { Cookie: cookie }
        });
        expect(disarmed.status).toBe(200);
        expect((await watches.get(watch.id)).status).toBe('CANCELLED');
    });

    test('every attention route requires a session', async () => {
        for (const reqPath of ['/api/app/attention', '/api/app/attention/items/1']) {
            expect((await request({ reqPath })).status).toBe(401);
        }
        for (const reqPath of ['/api/app/attention/enroll', '/api/app/attention/disable']) {
            expect((await request({ method: 'POST', reqPath })).status).toBe(401);
        }
    });
});

describe('usage and retention routes', () => {
    test('usage stats answer for the session user', async () => {
        await db.run(
            `INSERT INTO usage_log (guildId, userId, provider, model, operation, inputTokens, outputTokens, count)
             VALUES (@scope, @u, 'openai', 'gpt-test', 'chat', 100, 50, 1)`,
            { scope: dmScopeId(USER), u: USER }
        );
        const cookie = await login();
        const res = await request({ reqPath: '/api/app/usage?days=7', headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.totals).toEqual({ calls: 1, inputTokens: 100, outputTokens: 50 });
        expect(res.json.byModel[0].model).toBe('gpt-test');
        await db.run('DELETE FROM usage_log');
    });

    test('retention get/set works for the own DM scope and rejects others', async () => {
        const cookie = await login();
        const scope = encodeURIComponent(dmScopeId(USER));

        const initial = await request({ reqPath: `/api/app/memory/retention?scope=${scope}`, headers: { Cookie: cookie } });
        expect(initial.status).toBe(200);
        expect(initial.json.retentionDays).toBeNull();

        const set = await request({
            method: 'PUT', reqPath: '/api/app/memory/retention',
            headers: { Cookie: cookie }, body: { scope: dmScopeId(USER), days: 30 }
        });
        expect(set.status).toBe(200);
        expect(set.json.retentionDays).toBe(30);

        const cleared = await request({
            method: 'PUT', reqPath: '/api/app/memory/retention',
            headers: { Cookie: cookie }, body: { scope: dmScopeId(USER), days: 0 }
        });
        expect(cleared.json.retentionDays).toBeNull();

        const foreign = await request({
            method: 'PUT', reqPath: '/api/app/memory/retention',
            headers: { Cookie: cookie }, body: { scope: dmScopeId(OTHER), days: 30 }
        });
        expect(foreign.status).toBe(403);

        const guildScope = await request({
            method: 'PUT', reqPath: '/api/app/memory/retention',
            headers: { Cookie: cookie }, body: { scope: GUILD, days: 30 }
        });
        expect(guildScope.status).toBe(400);
        await db.run('DELETE FROM guild_settings');
    });
});

describe('exchange routes', () => {
    test('every exchange route requires a session', async () => {
        for (const reqPath of [
            `/api/app/exchange/overview?guildId=${GUILD}`,
            `/api/app/exchange/quote?guildId=${GUILD}&symbol=AAPL`,
            `/api/app/exchange/orders?guildId=${GUILD}`,
            `/api/app/exchange/leaderboard?guildId=${GUILD}`
        ]) {
            const res = await request({ reqPath });
            expect(res.status).toBe(401);
            expect(res.json.error.code).toBe('UNAUTHENTICATED');
        }
        expect(fakeExchange.overview).not.toHaveBeenCalled();
    });

    test('read routes pass the guild and the session user through', async () => {
        const cookie = await login();
        const scope = expect.objectContaining({ guildId: GUILD, userId: USER });

        const overview = await request({
            reqPath: `/api/app/exchange/overview?guildId=${GUILD}`, headers: { Cookie: cookie }
        });
        expect(overview.status).toBe(200);
        expect(overview.json.currencyName).toBe('Jimbucks');
        expect(fakeExchange.overview).toHaveBeenCalledWith(scope);

        const quote = await request({
            reqPath: `/api/app/exchange/quote?guildId=${GUILD}&symbol=aapl`, headers: { Cookie: cookie }
        });
        expect(quote.status).toBe(200);
        expect(fakeExchange.quote).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: GUILD, userId: USER, symbol: 'aapl' }));

        const history = await request({
            reqPath: `/api/app/exchange/history?guildId=${GUILD}&symbol=AAPL&range=1y`, headers: { Cookie: cookie }
        });
        expect(history.status).toBe(200);
        expect(fakeExchange.history).toHaveBeenCalledWith(
            expect.objectContaining({ symbol: 'AAPL', range: '1y' }));

        // Arrays are wrapped in a named field, never returned bare
        const search = await request({
            reqPath: `/api/app/exchange/search?guildId=${GUILD}&q=apple`, headers: { Cookie: cookie }
        });
        expect(search.status).toBe(200);
        expect(search.json.results[0].symbol).toBe('AAPL');
        expect(fakeExchange.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'apple' }));

        const chain = await request({
            reqPath: `/api/app/exchange/chain?guildId=${GUILD}&symbol=AAPL`, headers: { Cookie: cookie }
        });
        expect(chain.status).toBe(200);
        expect(chain.json.simulated).toBe(true);
        expect(fakeExchange.chain).toHaveBeenCalledWith(
            expect.objectContaining({ symbol: 'AAPL', expiry: null }));

        const orders = await request({
            reqPath: `/api/app/exchange/orders?guildId=${GUILD}`, headers: { Cookie: cookie }
        });
        expect(orders.status).toBe(200);
        expect(orders.json.orders[0].id).toBe(11);

        const board = await request({
            reqPath: `/api/app/exchange/leaderboard?guildId=${GUILD}`, headers: { Cookie: cookie }
        });
        expect(board.status).toBe(200);
        expect(board.json.rows[0].equity).toBe(900);
        expect(fakeExchange.leaderboard).toHaveBeenCalledWith(scope);
    });

    test('trading routes take the guild from the body', async () => {
        const cookie = await login();

        const trade = await request({
            method: 'POST', reqPath: '/api/app/exchange/trade', headers: { Cookie: cookie },
            body: { guildId: GUILD, side: 'buy', symbol: 'AAPL', units: 2 }
        });
        expect(trade.status).toBe(200);
        expect(trade.json.cost).toBe(421);
        expect(fakeExchange.tradeStock).toHaveBeenCalledWith(expect.objectContaining({
            guildId: GUILD, userId: USER, side: 'buy', symbol: 'AAPL', units: 2
        }));

        const option = await request({
            method: 'POST', reqPath: '/api/app/exchange/options', headers: { Cookie: cookie },
            body: {
                guildId: GUILD, action: 'buy', symbol: 'AAPL',
                optionType: 'CALL', strike: 210, expiry: '2026-09-18', contracts: 1
            }
        });
        expect(option.status).toBe(200);
        expect(fakeExchange.tradeOption).toHaveBeenCalledWith(expect.objectContaining({
            guildId: GUILD, userId: USER, action: 'buy', optionType: 'CALL', strike: 210
        }));

        const placed = await request({
            method: 'POST', reqPath: '/api/app/exchange/orders', headers: { Cookie: cookie },
            body: { guildId: GUILD, symbol: 'AAPL', side: 'BUY', orderType: 'LIMIT', units: 1, limitPrice: 200 }
        });
        expect(placed.status).toBe(200);
        expect(placed.json.order.id).toBe(12);
        expect(fakeExchange.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
            guildId: GUILD, userId: USER, orderType: 'LIMIT', limitPrice: 200
        }));

        const cancelled = await request({
            method: 'DELETE', reqPath: `/api/app/exchange/orders/12?guildId=${GUILD}`, headers: { Cookie: cookie }
        });
        expect(cancelled.status).toBe(200);
        expect(fakeExchange.cancelOrder).toHaveBeenCalledWith(
            expect.objectContaining({ guildId: GUILD, userId: USER, orderId: '12' }));
    });

    test('service errors keep their status and machine-readable code', async () => {
        const cookie = await login();
        fakeExchange.tradeStock.mockRejectedValueOnce(Object.assign(
            new Error('Shorting is off on this server.'), { status: 400, code: 'FEATURE_OFF' }));
        const res = await request({
            method: 'POST', reqPath: '/api/app/exchange/trade', headers: { Cookie: cookie },
            body: { guildId: GUILD, side: 'short', symbol: 'AAPL', units: 1 }
        });
        expect(res.status).toBe(400);
        expect(res.json.error).toEqual({
            code: 'FEATURE_OFF', message: 'Shorting is off on this server.'
        });
    });

    test('an unexpected failure never leaks internals to the browser', async () => {
        const cookie = await login();
        fakeExchange.overview.mockRejectedValueOnce(new Error('sqlite exploded at /var/lib/goobster'));
        const res = await request({
            reqPath: `/api/app/exchange/overview?guildId=${GUILD}`, headers: { Cookie: cookie }
        });
        expect(res.status).toBe(500);
        expect(res.json.error).toEqual({ code: 'INTERNAL', message: 'Something went wrong.' });
    });

    test('state-changing exchange requests obey the origin guard', async () => {
        const cookie = await login();
        const res = await request({
            method: 'POST', reqPath: '/api/app/exchange/trade',
            headers: { Cookie: cookie, Origin: 'https://evil.example.com' },
            body: { guildId: GUILD, side: 'buy', symbol: 'AAPL', units: 1 }
        });
        expect(res.status).toBe(403);
        expect(res.json.error.code).toBe('BAD_ORIGIN');
        expect(fakeExchange.tradeStock).not.toHaveBeenCalled();
    });
});

describe('companion home, constellation, workshop, forget', () => {
    test('GET /api/app/home requires a session and then returns the snapshot', async () => {
        const denied = await request({ reqPath: '/api/app/home' });
        expect(denied.status).toBe(401);

        await db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content)
             VALUES (@scope, 'USER', @u, 'Likes trains')`,
            { scope: dmScopeId(USER), u: USER }
        );
        const cookie = await login();
        const res = await request({ reqPath: '/api/app/home', headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.you.facts).toContain('Likes trains');
        expect(res.json.pickup).toEqual(expect.objectContaining({ conversations: expect.any(Array) }));
        expect(res.json.workshop).toEqual(expect.objectContaining({ pinned: expect.any(Array) }));
        expect(res.json.observatory).toEqual({ enabled: false });
    });

    test('GET /api/app/memory/constellation stars the user\'s own facts', async () => {
        await db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content)
             VALUES (@scope, 'USER', @u, 'Likes trains')`,
            { scope: dmScopeId(USER), u: USER }
        );
        const cookie = await login();
        const res = await request({
            reqPath: `/api/app/memory/constellation?scope=${encodeURIComponent(dmScopeId(USER))}`,
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(200);
        expect(res.json.kind).toBe('personal');
        expect(res.json.nodes[0].id).toBe('you');
        expect(res.json.nodes.some(n => n.content === 'Likes trains')).toBe(true);
        expect(res.json.counts.cap).toBe(2500);
    });

    test('spitball notes can be created, listed, edited, and deleted', async () => {
        const cookie = await login();
        const scope = dmScopeId(USER);
        const created = await request({
            method: 'POST',
            reqPath: '/api/app/spitball/notes',
            headers: { Cookie: cookie },
            body: { scope, label: 'Rosetta Stone', content: 'A bilingual decree', type: 'artifact', tags: ['egypt'] }
        });
        expect(created.status).toBe(200);
        expect(created.json.note).toMatchObject({
            label: 'Rosetta Stone', content: 'A bilingual decree', type: 'artifact', source: 'user'
        });
        expect(created.json.note.tags).toContain('egypt');

        const listed = await request({
            reqPath: `/api/app/spitball/notes?scope=${encodeURIComponent(scope)}&q=rosetta`,
            headers: { Cookie: cookie }
        });
        expect(listed.status).toBe(200);
        expect(listed.json.total).toBe(1);
        expect(listed.json.cap).toBe(2500);

        const patched = await request({
            method: 'PATCH',
            reqPath: `/api/app/spitball/notes/${created.json.note.id}`,
            headers: { Cookie: cookie },
            body: { scope, content: 'Hand-edited bilingual decree' }
        });
        expect(patched.status).toBe(200);
        expect(patched.json.note.content).toBe('Hand-edited bilingual decree');
        expect(patched.json.note.source).toBe('user');

        const deleted = await request({
            method: 'DELETE',
            reqPath: `/api/app/spitball/notes/${created.json.note.id}?scope=${encodeURIComponent(scope)}`,
            headers: { Cookie: cookie }
        });
        expect(deleted.status).toBe(200);
        expect(deleted.json.deleted).toBe(true);
    });

    test('POST /api/app/applets pins and GET lists it', async () => {
        const cookie = await login();
        const pinned = await request({
            method: 'POST',
            reqPath: '/api/app/applets',
            headers: { Cookie: cookie },
            body: { language: 'html', source: '<html><title>Clock</title></html>' }
        });
        expect(pinned.status).toBe(200);
        expect(pinned.json.title).toBe('Clock');

        const list = await request({ reqPath: '/api/app/applets', headers: { Cookie: cookie } });
        expect(list.status).toBe(200);
        expect(list.json.pinned).toHaveLength(1);
        expect(list.json.pinned[0].title).toBe('Clock');
    });

    test('POST /api/app/privacy/forget refuses a soft confirm', async () => {
        const cookie = await login();
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/privacy/forget',
            headers: { Cookie: cookie },
            body: { confirm: 'please' }
        });
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe('BAD_CONFIRM');
    });
});

describe('static client', () => {
    test('serves the React app index page', async () => {
        const res = await request({ reqPath: '/app/' });
        expect(res.status).toBe(200);
        expect(res.raw).toContain('id="root"');
    });

    test('serves KaTeX from node_modules for LaTeX rendering', async () => {
        const js = await request({ reqPath: '/app/vendor/katex/katex.min.js' });
        expect(js.status).toBe(200);
        expect(js.raw).toContain('katex');

        const css = await request({ reqPath: '/app/vendor/katex/katex.min.css' });
        expect(css.status).toBe(200);
        expect(css.raw).toContain('.katex');
    });
});

describe('portal event stream', () => {
    test('GET /api/app/events requires a session', async () => {
        const res = await request({ reqPath: '/api/app/events' });
        expect(res.status).toBe(401);
        expect(res.json.error.code).toBe('UNAUTHENTICATED');
    });

    test('forwards only this user\'s events with invalidation hints', async () => {
        const cookie = await login();
        const sse = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port,
                method: 'GET',
                path: '/api/app/events',
                headers: { Cookie: cookie }
            }, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`SSE status ${res.statusCode}`));
                    return;
                }
                resolve(res);
            });
            req.on('error', reject);
            req.end();
        });

        let buf = '';
        const waitFor = (needle, timeoutMs = 2000) => new Promise((resolve, reject) => {
            if (buf.includes(needle)) {
                resolve(buf);
                return;
            }
            const timer = setTimeout(() => reject(new Error(`sse timeout waiting for ${needle}: ${buf}`)), timeoutMs);
            const onData = (chunk) => {
                buf += chunk.toString();
                if (buf.includes(needle)) {
                    clearTimeout(timer);
                    sse.removeListener('data', onData);
                    resolve(buf);
                }
            };
            sse.on('data', onData);
        });

        await waitFor('event: hello');
        eventBusService.publish('automation-ran', { userId: OTHER, automationId: 1 });
        eventBusService.publish('automation-ran', { userId: USER, automationId: 7 });
        const delivered = await waitFor('event: automation-ran');
        expect(delivered).toContain('"automationId":7');
        expect(delivered).toContain('"invalidate":["tasks","home"]');
        expect(delivered).not.toContain(`"userId":"${OTHER}"`);

        // Scoped hints from the publisher merge after the kind-level ones
        eventBusService.publish('parlor-turn', {
            userId: USER, conversationId: 12, invalidate: ['parlor-messages:12']
        });
        const scoped = await waitFor('event: parlor-turn');
        expect(scoped).toContain('"invalidate":["parlor-conversations","parlor-messages:12"]');
        sse.destroy();
    });
});

describe('friends route', () => {
    test('requires a session', async () => {
        const res = await request({ reqPath: '/api/app/friends' });
        expect(res.status).toBe(401);
    });

    test('mirrors the synced Discord friends of this user only', async () => {
        await db.run('DELETE FROM user_friends');
        await db.run(
            `INSERT INTO user_friends (ownerId, friendId, friendName, avatar, syncedAt)
             VALUES (@me, '100000000000000009', 'Frieda', NULL, '2026-01-05 12:00:00'),
                    (@other, '100000000000000010', 'NotMine', NULL, '2026-01-05 12:00:00')`,
            { me: USER, other: OTHER }
        );
        const cookie = await login();
        const res = await request({ reqPath: '/api/app/friends', headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.friends).toEqual([
            expect.objectContaining({ id: '100000000000000009', name: 'Frieda' })
        ]);
        expect(res.json.syncedAt).toBe('2026-01-05 12:00:00');
    });

    test('an unsynced user gets an empty mirror, not an error', async () => {
        await db.run('DELETE FROM user_friends');
        const cookie = await login();
        const res = await request({ reqPath: '/api/app/friends', headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ friends: [], syncedAt: null });
    });
});
