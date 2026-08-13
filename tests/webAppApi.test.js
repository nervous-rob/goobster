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

const db = require('../db');
const { createWebAppContext, createWebAppApp } = require('../web/appApi');
const { dmScopeId } = require('../utils/dmScope');

const USER = '100000000000000001';
const OTHER = '100000000000000002';
const GUILD = '200000000000000001';
const BOT = '900000000000000001';

let server;
let port;
let manageGuildPermission = false;
let memberIds = new Set([USER]);

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
    }))
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
    const ctx = createWebAppContext({
        client: fakeClient,
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { chat: fakeChat }
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
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    manageGuildPermission = false;
    memberIds = new Set([USER]);
    db.run('DELETE FROM web_sessions');
    db.run('DELETE FROM facts');
    db.run('DELETE FROM memory_embeddings');
    db.run('DELETE FROM kg_nodes');
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
            const { WebChatError } = require('../services/webChatService');
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
    function seedDashboardData() {
        db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@g, 'USER', @u, 'rob likes trains')`,
            { g: GUILD, u: USER });
        db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@g, 'USER', @o, 'alice likes planes')`,
            { g: GUILD, o: OTHER });
        db.run(`INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@dm, 'USER', @u, 'dm-scope fact')`,
            { dm: dmScopeId(USER), u: USER });
        db.run(`INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
                VALUES (@g, @u, 'rob', 'rob guild memory', x'00000000', 1, 'test/model')`, { g: GUILD, u: USER });
        db.run(`INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
                VALUES (@g, @o, 'alice', 'alice guild memory', x'00000000', 1, 'test/model')`, { g: GUILD, o: OTHER });
    }

    test('a user only sees their own facts in a guild scope', async () => {
        seedDashboardData();
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
        seedDashboardData();
        const cookie = await login();
        const own = db.get(`SELECT id FROM memory_embeddings WHERE authorId = @u`, { u: USER }).id;
        const theirs = db.get(`SELECT id FROM memory_embeddings WHERE authorId = @o`, { o: OTHER }).id;

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
        expect(db.get('SELECT COUNT(*) AS c FROM memory_embeddings').c).toBe(1);
    });

    test('the transparency report answers for an accessible scope', async () => {
        seedDashboardData();
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
        db.run(`INSERT INTO kg_nodes (guildId, type, label, salience) VALUES (@g, 'person', 'Rob', 0.9)`, { g: GUILD });
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

describe('static client', () => {
    test('serves the web app index page', async () => {
        const res = await request({ reqPath: '/app/' });
        expect(res.status).toBe(200);
        expect(res.raw).toContain('Goobster');
        expect(res.raw).toContain('app.js');
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
