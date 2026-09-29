/**
 * Unit tests for services/directMessageService.js: one private thread per
 * pair of friends (documentation/friends_and_messages.md). Opening needs a
 * friendship, sending needs one *right now* (ending it makes the thread
 * read-only), read cursors and unread counts per seat, paging, the event
 * bus fan-out, the HTTP routes, and /forget-me deleting the whole thread.
 * Throwaway SQLite, no network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-dm-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) => texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    cosineSimilarity: () => 1
}));
jest.mock('@goobster/core/services/aiService', () => ({
    listProviders: () => [{ key: 'openai', isDefault: true, chatModel: 'test-model' }],
    chat: jest.fn(async () => ({ content: 'ok', toolCalls: [] })),
    generateText: jest.fn(async () => '{"notes": []}'),
    supportsNativeWebSearch: () => false
}));
jest.mock('@goobster/core/utils/imageDetectionHandler', () => ({ generateImage: jest.fn() }));

const db = require('@goobster/core/db');
const dm = require('@goobster/core/services/directMessageService');
const friendService = require('@goobster/core/services/friendService');
const identityService = require('@goobster/core/services/identityService');
const eventBus = require('@goobster/core/services/eventBusService');
const privacyService = require('@goobster/core/services/privacyService');

const ALICE = '610000000000000001';
const BOB = '610000000000000002';
const CAROL = '610000000000000003';

async function person(id, name) {
    await identityService.ensureLegacyPrincipal({ discordId: id, displayName: name });
    await db.run(
        `INSERT INTO web_sessions (tokenHash, userId, userName, expiresAt, lastSeenAt)
         VALUES (@token, @id, @name, datetime('now', '+1 day'), datetime('now'))`,
        { token: `tok-${id}-${Math.random()}`, id, name }
    );
}

async function befriend(a, b) {
    const { request } = await friendService.request({ userId: a, targetId: b });
    await friendService.respond({ userId: b, requestId: request.id, accept: true });
}

beforeEach(async () => {
    for (const table of ['dm_messages', 'dm_participants', 'dm_threads', 'friendships', 'inbox_items',
        'web_rate_events', 'web_sessions', 'auth_identities', 'principals']) {
        await db.run(`DELETE FROM ${table}`);
    }
    await person(ALICE, 'Alice');
    await person(BOB, 'Bob');
    await person(CAROL, 'Carol');
    await befriend(ALICE, BOB);
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

describe('threads', () => {
    test('friends share exactly one thread, whoever opens it', async () => {
        const fromAlice = await dm.openWith({ userId: ALICE, friendId: BOB });
        const fromBob = await dm.openWith({ userId: BOB, friendId: ALICE });
        expect(fromBob.id).toBe(fromAlice.id);
        expect(fromAlice.with).toMatchObject({ id: BOB, name: 'Bob', online: true });
        expect(fromBob.with).toMatchObject({ id: ALICE, name: 'Alice' });
        expect(fromAlice).toMatchObject({ friends: true, unread: 0, lastMessage: null });
        expect(await db.get('SELECT COUNT(*) AS c FROM dm_threads')).toMatchObject({ c: 1 });
        expect(await db.get('SELECT COUNT(*) AS c FROM dm_participants')).toMatchObject({ c: 2 });
    });

    test('only friends can open a thread; nobody can message themselves', async () => {
        await expect(dm.openWith({ userId: ALICE, friendId: CAROL })).rejects.toMatchObject({ code: 'NOT_FRIENDS', status: 403 });
        await expect(dm.openWith({ userId: ALICE, friendId: ALICE })).rejects.toMatchObject({ code: 'CANNOT_MESSAGE_SELF' });
        await expect(dm.openWith({ userId: ALICE, friendId: '' })).rejects.toMatchObject({ code: 'BAD_USER_ID' });
    });

    test('a thread is only visible to its two seats', async () => {
        const thread = await dm.openWith({ userId: ALICE, friendId: BOB });
        await expect(dm.getThread({ userId: CAROL, threadId: thread.id })).rejects.toMatchObject({ code: 'NO_SUCH_THREAD', status: 404 });
        await expect(dm.getMessages({ userId: CAROL, threadId: thread.id })).rejects.toMatchObject({ code: 'NO_SUCH_THREAD' });
        await expect(dm.send({ userId: CAROL, threadId: thread.id, content: 'hi' })).rejects.toMatchObject({ code: 'NO_SUCH_THREAD' });
        await expect(dm.getThread({ userId: ALICE, threadId: 'x' })).rejects.toMatchObject({ code: 'NO_SUCH_THREAD' });
        expect(await dm.listThreads({ userId: CAROL })).toEqual([]);
    });
});

describe('messages', () => {
    test('send, list newest-activity-first, read cursors and unread counts per seat', async () => {
        const events = [];
        const unsubscribe = eventBus.subscribe(event => { if (event.kind === 'dm-message') events.push(event.payload); });
        const thread = await dm.openWith({ userId: ALICE, friendId: BOB });
        const first = await dm.send({ userId: ALICE, threadId: thread.id, content: '  hello bob \r\nline two  ' });
        expect(first).toMatchObject({ threadId: thread.id, senderId: ALICE, content: 'hello bob \nline two' });
        await dm.send({ userId: ALICE, threadId: thread.id, content: 'still there?' });
        unsubscribe();

        expect(events.map(e => e.userId).sort()).toEqual([ALICE, ALICE, BOB, BOB]);
        expect(events[0].invalidate).toEqual(['dm-threads', `dm-thread:${thread.id}`, 'me']);

        expect(await dm.unreadCount(BOB)).toBe(2);
        expect(await dm.unreadCount(ALICE)).toBe(0);
        const bobThreads = await dm.listThreads({ userId: BOB });
        expect(bobThreads).toHaveLength(1);
        expect(bobThreads[0]).toMatchObject({ unread: 2, lastMessage: { content: 'still there?', senderId: ALICE } });

        const page = await dm.getMessages({ userId: BOB, threadId: thread.id });
        expect(page.messages.map(m => m.content)).toEqual(['hello bob \nline two', 'still there?']);
        expect(page.hasMore).toBe(false);

        await dm.markRead({ userId: BOB, threadId: thread.id });
        expect(await dm.unreadCount(BOB)).toBe(0);
        // Replying reads nothing on Alice's side until she looks
        await dm.send({ userId: BOB, threadId: thread.id, content: 'yes!' });
        expect(await dm.unreadCount(ALICE)).toBe(1);
        expect(await dm.unreadCount(BOB)).toBe(0);
        await dm.markRead({ userId: ALICE, threadId: thread.id, upToId: page.messages[1].id });
        expect(await dm.unreadCount(ALICE)).toBe(1);
        await dm.markRead({ userId: ALICE, threadId: thread.id });
        expect(await dm.unreadCount(ALICE)).toBe(0);
    });

    test('pages backwards with beforeId', async () => {
        const thread = await dm.openWith({ userId: ALICE, friendId: BOB });
        for (let i = 1; i <= 5; i++) await dm.send({ userId: i % 2 ? ALICE : BOB, threadId: thread.id, content: `m${i}` });
        const latest = await dm.getMessages({ userId: ALICE, threadId: thread.id, limit: 2 });
        expect(latest.messages.map(m => m.content)).toEqual(['m4', 'm5']);
        expect(latest.hasMore).toBe(true);
        const older = await dm.getMessages({ userId: ALICE, threadId: thread.id, limit: 2, beforeId: latest.messages[0].id });
        expect(older.messages.map(m => m.content)).toEqual(['m2', 'm3']);
        const oldest = await dm.getMessages({ userId: ALICE, threadId: thread.id, limit: 2, beforeId: older.messages[0].id });
        expect(oldest.messages.map(m => m.content)).toEqual(['m1']);
        expect(oldest.hasMore).toBe(false);
        await expect(dm.getMessages({ userId: ALICE, threadId: thread.id, beforeId: 'nope' })).rejects.toMatchObject({ code: 'BAD_CURSOR' });
    });

    test('empty, oversized, and too-frequent messages are refused', async () => {
        const thread = await dm.openWith({ userId: ALICE, friendId: BOB });
        await expect(dm.send({ userId: ALICE, threadId: thread.id, content: '   ' })).rejects.toMatchObject({ code: 'EMPTY_MESSAGE' });
        await expect(dm.send({ userId: ALICE, threadId: thread.id, content: 'x'.repeat(dm.MAX_MESSAGE_LENGTH + 1) })).rejects.toMatchObject({ code: 'MESSAGE_TOO_LONG' });
        const { consumeWindow } = require('@goobster/core/utils/slidingWindowLimit');
        for (let i = 0; i < 60; i++) await consumeWindow({ scope: 'dm_send', subject: ALICE, max: 60, windowMs: 60_000 });
        await expect(dm.send({ userId: ALICE, threadId: thread.id, content: 'one more' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });

    test('ending the friendship makes the thread read-only for both, and it stays listed', async () => {
        const thread = await dm.openWith({ userId: ALICE, friendId: BOB });
        await dm.send({ userId: ALICE, threadId: thread.id, content: 'before' });
        await friendService.remove({ userId: BOB, friendId: ALICE });
        await expect(dm.send({ userId: ALICE, threadId: thread.id, content: 'after' })).rejects.toMatchObject({ code: 'NOT_FRIENDS' });
        await expect(dm.send({ userId: BOB, threadId: thread.id, content: 'after' })).rejects.toMatchObject({ code: 'NOT_FRIENDS' });
        const [listed] = await dm.listThreads({ userId: BOB });
        expect(listed).toMatchObject({ id: thread.id, friends: false, lastMessage: { content: 'before' } });
        expect((await dm.getMessages({ userId: BOB, threadId: thread.id })).messages).toHaveLength(1);
        // Friends again: the same thread carries on
        await befriend(BOB, ALICE);
        expect((await dm.openWith({ userId: BOB, friendId: ALICE })).id).toBe(thread.id);
        await dm.send({ userId: BOB, threadId: thread.id, content: 'after all' });
    });
});

describe('HTTP surfaces', () => {
    const express = require('express');
    const http = require('node:http');
    const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
    let server;
    let port;

    async function call(method, reqPath, { body = null, headers = {} } = {}) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request({
                host: '127.0.0.1', port, method, path: reqPath,
                headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { /* non-JSON */ }
                    resolve({ status: res.statusCode, headers: res.headers, json });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    beforeAll(async () => {
        const ctx = createWebAppContext({
            client: null,
            config: { clientId: '123', webapp: { enabled: true, devMode: true } },
            logger: { error: () => {}, warn: () => {}, info: () => {} }
        });
        const app = express();
        app.use(createWebAppApp(ctx));
        server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        port = server.address().port;
    });

    afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

    async function login(userId, name) {
        const res = await call('POST', '/api/app/auth/dev-session', { body: { userId, name } });
        return { Cookie: res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session=')).split(';')[0] };
    }

    test('open, send, list, read, and the /me unread count', async () => {
        const alice = await login(ALICE, 'Alice');
        const bob = await login(BOB, 'Bob');
        const carol = await login(CAROL, 'Carol');

        const opened = await call('POST', '/api/app/dm/threads', { body: { userId: BOB }, headers: alice });
        expect(opened.status).toBe(200);
        expect(opened.json.with).toMatchObject({ id: BOB, name: 'Bob' });
        expect((await call('POST', '/api/app/dm/threads', { body: { userId: CAROL }, headers: alice })).json.error.code).toBe('NOT_FRIENDS');

        const sent = await call('POST', `/api/app/dm/threads/${opened.json.id}/messages`, { body: { content: 'hi bob' }, headers: alice });
        expect(sent.status).toBe(200);
        expect(sent.json.message).toMatchObject({ senderId: ALICE, content: 'hi bob' });

        expect((await call('GET', '/api/app/me', { headers: bob })).json.people).toEqual({ pending: 0, unread: 1 });
        const list = await call('GET', '/api/app/dm/threads', { headers: bob });
        expect(list.json).toMatchObject({ unread: 1, threads: [expect.objectContaining({ id: opened.json.id, unread: 1 })] });

        const page = await call('GET', `/api/app/dm/threads/${opened.json.id}`, { headers: bob });
        expect(page.json.thread.with.id).toBe(ALICE);
        expect(page.json.messages.map(m => m.content)).toEqual(['hi bob']);
        expect((await call('GET', `/api/app/dm/threads/${opened.json.id}`, { headers: carol })).status).toBe(404);

        expect((await call('POST', `/api/app/dm/threads/${opened.json.id}/read`, { body: {}, headers: bob })).json.read).toBe(true);
        expect((await call('GET', '/api/app/me', { headers: bob })).json.people.unread).toBe(0);
        expect((await call('GET', '/api/app/dm/threads')).status).toBe(401);
    });
});

describe('privacy (/forget-me)', () => {
    test('erasing one person deletes the whole conversation, on both sides', async () => {
        await befriend(ALICE, CAROL);
        const withBob = await dm.openWith({ userId: ALICE, friendId: BOB });
        const withCarol = await dm.openWith({ userId: ALICE, friendId: CAROL });
        await dm.send({ userId: ALICE, threadId: withBob.id, content: 'to bob' });
        await dm.send({ userId: BOB, threadId: withBob.id, content: 'to alice' });
        await dm.send({ userId: CAROL, threadId: withCarol.id, content: 'to alice too' });

        const report = await privacyService.buildUserReport({ guildId: 'dm:' + ALICE, userId: ALICE });
        expect(report.directMessages).toEqual({ threads: 2, sent: 1 });

        await privacyService.forgetUser({ userId: ALICE });

        const audit = await privacyService.auditUser({ userId: ALICE });
        expect(audit.byTable.dm_threads).toBe(0);
        expect(audit.byTable.dm_messages_authored).toBe(0);
        expect(await dm.listThreads({ userId: BOB })).toEqual([]);
        expect(await dm.listThreads({ userId: CAROL })).toEqual([]);
        expect(await db.get('SELECT COUNT(*) AS c FROM dm_messages')).toMatchObject({ c: 0 });
        expect(await db.get('SELECT COUNT(*) AS c FROM dm_participants')).toMatchObject({ c: 0 });
    });
});
