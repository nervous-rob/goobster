/**
 * Unit tests for services/friendService.js: the Discord friend roster the
 * Activity syncs (legalization of a client-supplied payload), and the
 * "people you could invite" merge - friends first, then the members of
 * servers the user shares with the bot - plus the parlor invite picker on
 * top of it and /forget-me coverage. Runs against a throwaway SQLite
 * database with a fake Discord client (no network).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-friends-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) =>
        texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    cosineSimilarity: () => 1
}));
jest.mock('@goobster/core/services/aiService', () => ({
    chat: jest.fn(async () => ({ content: 'ok', toolCalls: [] })),
    generateText: jest.fn(async () => '{"notes": []}'),
    supportsNativeWebSearch: () => false
}));
jest.mock('@goobster/core/utils/imageDetectionHandler', () => ({ generateImage: jest.fn() }));

const db = require('@goobster/core/db');
const friendService = require('@goobster/core/services/friendService');
const parlorService = require('@goobster/core/services/parlorService');
const privacyService = require('@goobster/core/services/privacyService');

const USER = '600000000000000001';
const FRIEND = '600000000000000002';
const MATE = '600000000000000003';
const STRANGER = '600000000000000004';

/** One relationship entry as the Embedded App SDK reports it. */
function relationship(id, name, { type = 1, bot = false, avatar = 'abc' } = {}) {
    return { type, user: { id, username: name, global_name: name, avatar, bot } };
}

/** A fake guild member (discord.js shape). */
function member(id, name, { bot = false } = {}) {
    return {
        id,
        displayName: name,
        user: {
            id, username: name, globalName: name, bot,
            displayAvatarURL: () => `https://cdn.example/${id}.png`
        }
    };
}

/** A fake client whose guild has the given members and membership set. */
function fakeClient(members, { guildName = 'The Lair', memberIds = null } = {}) {
    const cache = new Map(members.map(m => [m.id, m]));
    const present = memberIds || new Set(members.map(m => m.id));
    const guild = {
        id: '700000000000000001',
        name: guildName,
        members: {
            cache,
            fetch: async (arg) => {
                if (typeof arg === 'string') {
                    if (!present.has(arg)) throw new Error('Unknown Member');
                    return cache.get(arg) || member(arg, `user ${arg}`);
                }
                const query = String(arg?.query || '').toLowerCase();
                const matched = members.filter(m => m.displayName.toLowerCase().includes(query));
                return new Map(matched.map(m => [m.id, m]));
            }
        }
    };
    return { guilds: { cache: new Map([[guild.id, guild]]) } };
}

beforeEach(async () => {
    for (const table of ['user_friends', 'parlor_messages', 'parlor_participants',
        'parlor_members', 'parlor_invites', 'parlor_conversations',
        'parlor_note_tags', 'parlor_tags', 'parlor_notes', 'parlor_personas']) {
        await db.run(`DELETE FROM ${table}`);
    }
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

describe('syncing the friend roster', () => {
    test('stores friends and reports the count', async () => {
        const result = await friendService.syncRelationships({
            userId: USER,
            relationships: [relationship(FRIEND, 'Frieda'), relationship(MATE, 'Marco')]
        });
        expect(result.friends).toBe(2);
        expect(result.syncedAt).toBeTruthy();

        const friends = await friendService.listFriends(USER);
        expect(friends.map(f => f.name)).toEqual(['Frieda', 'Marco']);
        expect(friends[0].avatar).toBe(`https://cdn.discordapp.com/avatars/${FRIEND}/abc.png?size=64`);
    });

    test('legalizes the payload: only real friends, no bots, no self, no junk ids', async () => {
        const result = await friendService.syncRelationships({
            userId: USER,
            relationships: [
                relationship(FRIEND, 'Frieda'),
                relationship(MATE, 'Pending Pete', { type: 3 }),      // incoming request
                relationship(STRANGER, 'Blocked Bob', { type: 2 }),   // blocked
                relationship('900000000000000009', 'A Bot', { bot: true }),
                relationship('not-a-snowflake', 'Junk'),
                relationship(USER, 'Myself'),
                { type: 1 },                                          // no user at all
                null
            ]
        });
        expect(result.friends).toBe(1);
        expect((await friendService.listFriends(USER)).map(f => f.id)).toEqual([FRIEND]);
    });

    test('a re-sync replaces the roster (it is a cache, not a log)', async () => {
        await friendService.syncRelationships({
            userId: USER, relationships: [relationship(FRIEND, 'Frieda'), relationship(MATE, 'Marco')]
        });
        await friendService.syncRelationships({ userId: USER, relationships: [relationship(MATE, 'Marco')] });
        expect((await friendService.listFriends(USER)).map(f => f.id)).toEqual([MATE]);
    });

    test('rosters are per user and a bad user id is refused', async () => {
        await friendService.syncRelationships({ userId: USER, relationships: [relationship(FRIEND, 'Frieda')] });
        expect(await friendService.listFriends(STRANGER)).toEqual([]);
        expect(await friendService.lastSyncedAt(STRANGER)).toBeNull();
        let caught = null;
        try {
            await friendService.syncRelationships({ userId: 'nope', relationships: [] });
        } catch (error) { caught = error; }
        expect(caught?.code).toBe('BAD_USER_ID');
    });
});

describe('who a user can invite', () => {
    test('friends come first, then server-mates, deduped', async () => {
        await friendService.syncRelationships({ userId: USER, relationships: [relationship(FRIEND, 'Frieda')] });
        const client = fakeClient([
            member(USER, 'Rob'),
            member(FRIEND, 'Frieda'),      // also a server-mate: stays a friend
            member(MATE, 'Marco'),
            member('900000000000000009', 'Goobster', { bot: true })
        ]);

        const { people, friendsSynced } = await friendService.listInvitable({ client, userId: USER });
        expect(friendsSynced).toBe(true);
        expect(people.map(p => p.id)).toEqual([FRIEND, MATE]);
        expect(people[0]).toMatchObject({ source: 'friend', name: 'Frieda' });
        expect(people[1]).toMatchObject({ source: 'server', name: 'Marco', via: 'The Lair' });
        // Never yourself, never bots
        expect(people.some(p => p.id === USER)).toBe(false);
        expect(people.some(p => p.name === 'Goobster')).toBe(false);
    });

    test('works with no friend roster at all (server-mates only)', async () => {
        const client = fakeClient([member(USER, 'Rob'), member(MATE, 'Marco')]);
        const { people, friendsSynced, syncedAt } = await friendService.listInvitable({ client, userId: USER });
        expect(friendsSynced).toBe(false);
        expect(syncedAt).toBeNull();
        expect(people.map(p => p.id)).toEqual([MATE]);
    });

    test('works with no Discord client at all (friends only)', async () => {
        await friendService.syncRelationships({ userId: USER, relationships: [relationship(FRIEND, 'Frieda')] });
        const { people } = await friendService.listInvitable({ userId: USER });
        expect(people.map(p => p.id)).toEqual([FRIEND]);
    });

    test('only lists people from servers the user is actually in', async () => {
        const client = fakeClient([member(MATE, 'Marco')], { memberIds: new Set([MATE]) });
        const { people } = await friendService.listInvitable({ client, userId: USER });
        expect(people).toEqual([]);
    });

    test('the query filters both sources and matches ids', async () => {
        await friendService.syncRelationships({
            userId: USER, relationships: [relationship(FRIEND, 'Frieda'), relationship(STRANGER, 'Zoltan')]
        });
        const client = fakeClient([member(USER, 'Rob'), member(MATE, 'Marco')]);

        const byName = await friendService.listInvitable({ client, userId: USER, q: 'mar' });
        expect(byName.people.map(p => p.id)).toEqual([MATE]);

        const byFriendName = await friendService.listInvitable({ client, userId: USER, q: 'fri' });
        expect(byFriendName.people.map(p => p.id)).toEqual([FRIEND]);

        const byId = await friendService.listInvitable({ client, userId: USER, q: STRANGER });
        expect(byId.people.map(p => p.id)).toEqual([STRANGER]);
    });

    test('the exclusion set removes people already at the table', async () => {
        await friendService.syncRelationships({ userId: USER, relationships: [relationship(FRIEND, 'Frieda')] });
        const client = fakeClient([member(USER, 'Rob'), member(MATE, 'Marco')]);
        const { people } = await friendService.listInvitable({
            client, userId: USER, exclude: [FRIEND]
        });
        expect(people.map(p => p.id)).toEqual([MATE]);
    });
});

describe('the parlor invite picker', () => {
    async function makeDiscussion() {
        const persona = await parlorService.createPersona({
            ownerId: USER, name: 'Ada', charter: 'You are a careful researcher.'
        });
        return await parlorService.createConversation({ ownerId: USER, personaIds: [persona.id] });
    }

    test('offers friends and server-mates, minus members and pending invites', async () => {
        await friendService.syncRelationships({
            userId: USER, relationships: [relationship(FRIEND, 'Frieda'), relationship(STRANGER, 'Zoltan')]
        });
        const client = fakeClient([member(USER, 'Rob'), member(MATE, 'Marco')]);
        const conversation = await makeDiscussion();

        const before = await parlorService.listInvitable({
            client, ownerId: USER, conversationId: conversation.id
        });
        expect(before.people.map(p => p.id)).toEqual([FRIEND, STRANGER, MATE]);

        // Frieda joins, Zoltan has a pending invitation - both drop out
        await parlorService.invite({ ownerId: USER, conversationId: conversation.id, inviteeId: FRIEND });
        const { invite } = { invite: await db.get('SELECT id FROM parlor_invites') };
        await parlorService.respondInvite({ userId: FRIEND, userName: 'Frieda', inviteId: invite.id, accept: true });
        await parlorService.invite({ ownerId: USER, conversationId: conversation.id, inviteeId: STRANGER });

        const after = await parlorService.listInvitable({
            client, ownerId: USER, conversationId: conversation.id
        });
        expect(after.people.map(p => p.id)).toEqual([MATE]);
    });

    test('only the owner may browse the picker', async () => {
        const conversation = await makeDiscussion();
        await expect(parlorService.listInvitable({
            ownerId: STRANGER, conversationId: conversation.id
        })).rejects.toMatchObject({ code: 'NO_SUCH_CONVERSATION' });
    });
});

describe('HTTP surfaces', () => {
    const express = require('express');
    const http = require('node:http');

    /** Minimal JSON request helper. */
    async function call(port, method, reqPath, { body = null, headers = {} } = {}) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request({
                host: '127.0.0.1', port, method, path: reqPath,
                headers: {
                    ...(payload ? {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload)
                    } : {}),
                    ...headers
                }
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

    async function listen(app) {
        const server = await new Promise(resolve => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        return { server, port: server.address().port };
    }

    describe('the Activity sync route', () => {
        const { createActivityApp } = require('@goobster/bot/web/activityApi');
        let server;
        let port;
        const sessions = new Map([['good-token', { userId: USER, name: 'Rob', createdAt: Date.now() }]]);

        function activityApp(relationships) {
            const app = express();
            app.use(createActivityApp({
                clientId: 'test-client', devMode: true, relationships,
                friends: friendService, sessions, logger: { warn: () => {} }
            }));
            return app;
        }

        afterEach(async () => {
            if (server) await new Promise(resolve => server.close(resolve));
            server = null;
        });

        test('syncs a session-authenticated roster', async () => {
            ({ server, port } = await listen(activityApp(true)));
            const res = await call(port, 'POST', '/api/activity/relationships', {
                body: { session: 'good-token', relationships: [relationship(FRIEND, 'Frieda')] }
            });
            expect(res.status).toBe(200);
            expect(res.json.friends).toBe(1);
            expect((await friendService.listFriends(USER)).map(f => f.id)).toEqual([FRIEND]);
        });

        test('rejects an unknown session and refuses when the feature is off', async () => {
            ({ server, port } = await listen(activityApp(true)));
            const unauthorized = await call(port, 'POST', '/api/activity/relationships', {
                body: { session: 'nope', relationships: [relationship(FRIEND, 'Frieda')] }
            });
            expect(unauthorized.status).toBe(401);
            await new Promise(resolve => server.close(resolve));

            ({ server, port } = await listen(activityApp(false)));
            const disabled = await call(port, 'POST', '/api/activity/relationships', {
                body: { session: 'good-token', relationships: [] }
            });
            expect(disabled.status).toBe(403);
            expect(await friendService.listFriends(USER)).toEqual([]);
        });

        test('config advertises whether the client should ask for the scope', async () => {
            ({ server, port } = await listen(activityApp(true)));
            const res = await call(port, 'GET', '/api/activity/config');
            expect(res.json.relationships).toBe(true);
        });
    });

    describe('the web app picker route', () => {
        const { createWebAppContext, createWebAppApp } = require('@goobster/bot/web/appApi');
        let server;
        let port;

        beforeAll(async () => {
            const ctx = createWebAppContext({
                client: fakeClient([member(USER, 'Rob'), member(MATE, 'Marco')]),
                config: { clientId: '123', webapp: { enabled: true, devMode: true } },
                logger: { error: () => {}, warn: () => {}, info: () => {} }
            });
            const app = express();
            app.use(createWebAppApp(ctx));
            ({ server, port } = await listen(app));
        });

        afterAll(async () => {
            await new Promise(resolve => server.close(resolve));
        });

        /** Dev-session cookie for USER. */
        async function login() {
            const res = await call(port, 'POST', '/api/app/auth/dev-session', {
                body: { userId: USER, name: 'Rob' }
            });
            return res.headers['set-cookie']
                .find(c => c.startsWith('goobster_web_session=')).split(';')[0];
        }

        test('returns friends and server-mates for the owner', async () => {
            await friendService.syncRelationships({ userId: USER, relationships: [relationship(FRIEND, 'Frieda')] });
            const Cookie = await login();
            const persona = await parlorService.createPersona({
                ownerId: USER, name: 'Ada', charter: 'You are a careful researcher.'
            });
            const conversation = await parlorService.createConversation({
                ownerId: USER, personaIds: [persona.id]
            });

            const res = await call(port, 'GET',
                `/api/app/parlor/conversations/${conversation.id}/invitable`, { headers: { Cookie } });
            expect(res.status).toBe(200);
            expect(res.json.friendsSynced).toBe(true);
            expect(res.json.people).toEqual([
                expect.objectContaining({ id: FRIEND, source: 'friend' }),
                expect.objectContaining({ id: MATE, source: 'server', via: 'The Lair' })
            ]);

            const filtered = await call(port, 'GET',
                `/api/app/parlor/conversations/${conversation.id}/invitable?q=marc`,
                { headers: { Cookie } });
            expect(filtered.json.people.map(p => p.id)).toEqual([MATE]);
        });

        test('requires a session', async () => {
            const res = await call(port, 'GET', '/api/app/parlor/conversations/1/invitable');
            expect(res.status).toBe(401);
        });
    });
});

describe('privacy (/forget-me)', () => {
    test('erases the roster in both directions and reports it', async () => {
        await friendService.syncRelationships({ userId: USER, relationships: [relationship(FRIEND, 'Frieda')] });
        await friendService.syncRelationships({ userId: FRIEND, relationships: [relationship(USER, 'Rob')] });
        await friendService.syncRelationships({ userId: MATE, relationships: [relationship(USER, 'Rob')] });

        const report = await privacyService.buildUserReport({ guildId: 'dm:' + USER, userId: USER });
        expect(report.friends).toEqual({ cached: 1, listedByOthers: 2 });

        await privacyService.forgetUser({ userId: USER });

        expect((await privacyService.auditUser({ userId: USER })).byTable.user_friends).toBe(0);
        expect(await friendService.listFriends(USER)).toEqual([]);
        expect(await friendService.listFriends(FRIEND)).toEqual([]);
        expect(await friendService.listFriends(MATE)).toEqual([]);
    });
});
