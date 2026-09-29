/**
 * Unit tests for services/friendService.js: Goobster's own friendship graph
 * (documentation/friends_and_messages.md). Finding people (name, verified
 * email, id, shared server), the request lifecycle (pending → accepted /
 * declined / cancelled / removed, the reverse-request auto-accept, the
 * decline cooldown), delivery to the Inbox with the Discord DM echo and its
 * buttons, presence on the friend list, the "people you could invite" merge
 * the parlor picker sits on, the HTTP routes, and /forget-me coverage.
 * Runs against a throwaway SQLite database with a fake Discord client.
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
    listProviders: () => [{ key: 'openai', isDefault: true, chatModel: 'test-model' }],
    chat: jest.fn(async () => ({ content: 'ok', toolCalls: [] })),
    generateText: jest.fn(async () => '{"notes": []}'),
    supportsNativeWebSearch: () => false
}));
jest.mock('@goobster/core/utils/imageDetectionHandler', () => ({ generateImage: jest.fn() }));

const db = require('@goobster/core/db');
const friendService = require('@goobster/core/services/friendService');
const inboxService = require('@goobster/core/services/inboxService');
const identityService = require('@goobster/core/services/identityService');
const parlorService = require('@goobster/core/services/parlorService');
const privacyService = require('@goobster/core/services/privacyService');
const identityConfig = require('@goobster/core/config/identityConfig');

const USER = '600000000000000001';
const FRIEND = '600000000000000002';
const MATE = '600000000000000003';
const STRANGER = '600000000000000004';
const NOBODY = '600000000000000099';
const NATIVE = 'usr_0f7f5d0e-1111-4a2b-9c3d-000000000001';

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

/**
 * A fake client whose guild has the given members; `users.fetch` resolves
 * any member (and records DMs sent to them) so the gateway seam works.
 */
function fakeClient(members, { guildName = 'The Lair', memberIds = null, dms = [] } = {}) {
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
    return {
        guilds: { cache: new Map([[guild.id, guild]]) },
        users: {
            fetch: async (id) => {
                const found = cache.get(id);
                if (!found) throw new Error('Unknown User');
                return {
                    ...found.user,
                    send: async (payload) => { dms.push({ to: id, payload }); return { id: 'm1', channelId: 'c1' }; }
                };
            }
        }
    };
}

/** A person who has used the portal (a live web session names them). */
async function portalUser(id, name, { seenSecondsAgo = null } = {}) {
    await identityService.ensureLegacyPrincipal({ discordId: id, displayName: name });
    const seen = seenSecondsAgo == null ? null
        : new Date(Date.now() - seenSecondsAgo * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.run(
        `INSERT INTO web_sessions (tokenHash, userId, userName, avatar, expiresAt, lastSeenAt)
         VALUES (@token, @id, @name, 'hash', datetime('now', '+1 day'), @seen)`,
        { token: `tok-${id}-${Math.random()}`, id, name, seen }
    );
}

/** A native (no Discord) member with a verified email address. */
async function nativeMember(id, name, email) {
    await db.run(
        `INSERT INTO principals (id, displayName) VALUES (@id, @name) ON CONFLICT (id) DO NOTHING`, { id, name }
    );
    await db.run(
        `INSERT INTO app_accounts (principalId, loginName, entitlement) VALUES (@id, @login, 'invite')
         ON CONFLICT (principalId) DO NOTHING`,
        { id, login: name.toLowerCase().replace(/\s+/g, '') }
    );
    await db.run(
        `INSERT INTO account_emails (principalId, address, normalized, verifiedAt)
         VALUES (@id, @email, @normalized, datetime('now'))`,
        { id, email, normalized: email.toLowerCase() }
    );
}

const TABLES = ['dm_messages', 'dm_participants', 'dm_threads', 'friendships', 'inbox_items', 'web_rate_events',
    'web_sessions', 'account_emails', 'app_accounts', 'auth_identities', 'principals',
    'parlor_messages', 'parlor_participants', 'parlor_members', 'parlor_invites', 'parlor_conversations',
    'parlor_note_tags', 'parlor_tags', 'parlor_notes', 'parlor_personas'];

beforeEach(async () => {
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`);
    await portalUser(USER, 'Rob');
    await portalUser(FRIEND, 'Frieda');
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

describe('finding people', () => {
    test('by the start of a name: people of this portal and members of shared servers', async () => {
        await portalUser(MATE, 'Frank');
        const client = fakeClient([member(USER, 'Rob'), member(STRANGER, 'Fredo'), member('900000000000000009', 'Frobot', { bot: true })]);
        const { people, kind } = await friendService.search({ client, userId: USER, q: 'fr' });
        expect(kind).toBe('name');
        expect(people.map(p => p.id).sort()).toEqual([FRIEND, MATE, STRANGER].sort());
        expect(people.find(p => p.id === FRIEND)).toMatchObject({
            name: 'Frieda', source: 'member', via: identityConfig.installationName,
            relationship: { status: 'none', requestId: null }
        });
        expect(people.find(p => p.id === STRANGER)).toMatchObject({ source: 'server', via: 'The Lair' });
        // Never yourself, never bots, and one character is not a search.
        expect(people.some(p => p.id === USER)).toBe(false);
        expect(people.some(p => p.name === 'Frobot')).toBe(false);
        expect((await friendService.search({ client, userId: USER, q: 'f' })).people).toEqual([]);
    });

    test('by exact verified email - the address itself is never returned', async () => {
        await nativeMember(NATIVE, 'Nadia Native', 'Nadia@Example.org');
        const hit = await friendService.search({ userId: USER, q: 'nadia@example.org' });
        expect(hit.kind).toBe('email');
        expect(hit.people).toEqual([expect.objectContaining({ id: NATIVE, name: 'Nadia Native', source: 'member' })]);
        expect(JSON.stringify(hit)).not.toContain('example.org');
        // Unverified and unknown addresses find nobody.
        await db.run('UPDATE account_emails SET verifiedAt = NULL');
        expect((await friendService.search({ userId: USER, q: 'nadia@example.org' })).people).toEqual([]);
        expect((await friendService.search({ userId: USER, q: 'who@example.org' })).people).toEqual([]);
    });

    test('by id: a principal, or a Discord user the bot can see', async () => {
        const known = await friendService.search({ userId: USER, q: FRIEND });
        expect(known.kind).toBe('id');
        expect(known.people).toEqual([expect.objectContaining({ id: FRIEND, name: 'Frieda' })]);
        const client = fakeClient([member(STRANGER, 'Zed')]);
        const seen = await friendService.search({ client, userId: USER, q: STRANGER });
        expect(seen.people).toEqual([expect.objectContaining({ id: STRANGER, name: 'Zed', source: 'server' })]);
        expect((await friendService.search({ client, userId: USER, q: NOBODY })).people).toEqual([]);
        expect((await friendService.search({ userId: USER, q: USER })).people).toEqual([]);
    });

    test('results carry the relationship so the UI offers one action', async () => {
        await friendService.request({ userId: USER, targetId: FRIEND });
        const mine = await friendService.search({ userId: USER, q: 'frie' });
        expect(mine.people[0].relationship).toMatchObject({ status: 'outgoing', direction: 'outgoing' });
        const theirs = await friendService.search({ userId: FRIEND, q: 'rob' });
        expect(theirs.people[0].relationship).toMatchObject({ status: 'incoming', direction: 'incoming' });
        await friendService.respond({ userId: FRIEND, requestId: mine.people[0].relationship.requestId, accept: true });
        expect((await friendService.search({ userId: USER, q: 'frie' })).people[0].relationship.status).toBe('friends');
    });
});

describe('the request lifecycle', () => {
    test('a request lands in the Inbox with Accept / Decline and is echoed to Discord with buttons', async () => {
        const dms = [];
        const client = fakeClient([member(USER, 'Rob'), member(FRIEND, 'Frieda')], { dms });
        const result = await friendService.request({ client, userId: USER, userName: 'Rob', targetId: FRIEND });
        expect(result.status).toBe('pending');
        expect(result.dmSent).toBe(true);
        expect(result.request).toMatchObject({ requesterId: USER, requesterName: 'Rob', addresseeId: FRIEND, addresseeName: 'Frieda', status: 'pending' });

        const { items } = await inboxService.list({ userId: FRIEND });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            kind: 'invite', title: 'Rob wants to be friends', link: '/people/friends',
            source: { type: 'friend_request', id: String(result.request.id) },
            friend: { id: result.request.id, status: 'pending', requesterName: 'Rob', actionable: true },
            discord: { status: 'sent' }
        });
        expect(dms).toHaveLength(1);
        expect(dms[0].to).toBe(FRIEND);
        const ids = dms[0].payload.components[0].components.map(button => button.data.custom_id);
        expect(ids).toEqual([`accept_friendreq_${result.request.id}`, `decline_friendreq_${result.request.id}`]);

        // The requester's own view: outgoing, not actionable
        expect(await friendService.listRequests(USER)).toMatchObject({ incoming: [], outgoing: [expect.objectContaining({ addresseeId: FRIEND })] });
        expect(await friendService.pendingCount(FRIEND)).toBe(1);
        expect(await friendService.pendingCount(USER)).toBe(0);
    });

    test('without Discord the request still lands in the Inbox', async () => {
        const result = await friendService.request({ userId: USER, targetId: FRIEND });
        expect(result.dmSent).toBe(false);
        const { items } = await inboxService.list({ userId: FRIEND });
        expect(items[0].discord.status).toBe('skipped');
    });

    test('refuses yourself, the assistant, bots, unknown people, and duplicates', async () => {
        const client = fakeClient([member(USER, 'Rob'), member('900000000000000009', 'Goobot', { bot: true })]);
        await expect(friendService.request({ userId: USER, targetId: USER })).rejects.toMatchObject({ code: 'CANNOT_FRIEND_SELF' });
        await expect(friendService.request({ client, userId: USER, targetId: '900000000000000009' })).rejects.toMatchObject({ code: 'CANNOT_FRIEND_BOT' });
        await expect(friendService.request({ client, userId: USER, targetId: NOBODY })).rejects.toMatchObject({ code: 'NO_SUCH_USER' });
        await expect(friendService.request({ userId: USER, targetId: NOBODY })).rejects.toMatchObject({ code: 'NO_SUCH_USER' });
        await expect(friendService.request({ userId: USER, targetId: 'nope' })).rejects.toMatchObject({ code: 'BAD_USER_ID' });
        await friendService.request({ userId: USER, targetId: FRIEND });
        await expect(friendService.request({ userId: USER, targetId: FRIEND })).rejects.toMatchObject({ code: 'ALREADY_REQUESTED' });
        expect(await db.get('SELECT COUNT(*) AS c FROM friendships')).toMatchObject({ c: 1 });
    });

    test('a Discord user the bot can see becomes a principal when asked', async () => {
        const client = fakeClient([member(USER, 'Rob'), member(STRANGER, 'Zed')]);
        expect(await identityService.getPrincipal(STRANGER)).toBeNull();
        await friendService.request({ client, userId: USER, targetId: STRANGER });
        expect(await identityService.getPrincipal(STRANGER)).toMatchObject({ id: STRANGER, displayName: 'Zed' });
    });

    test('accepting makes friends both ways and tells the requester; declining is silent', async () => {
        const { request } = await friendService.request({ userId: USER, userName: 'Rob', targetId: FRIEND });
        const accepted = await friendService.respond({ userId: FRIEND, userName: 'Frieda', requestId: request.id, accept: true });
        expect(accepted.status).toBe('accepted');
        expect(accepted.friend).toMatchObject({ id: USER, name: 'Rob' });
        expect(await friendService.areFriends(USER, FRIEND)).toBe(true);
        expect(await friendService.areFriends(FRIEND, USER)).toBe(true);
        expect((await friendService.listFriends(USER)).map(f => f.name)).toEqual(['Frieda']);
        expect((await friendService.listFriends(FRIEND)).map(f => f.name)).toEqual(['Rob']);
        const requesterInbox = await inboxService.list({ userId: USER });
        expect(requesterInbox.items[0]).toMatchObject({
            kind: 'system', title: 'Frieda accepted your friend request',
            friend: { status: 'accepted', actionable: false }
        });
        // The addressee's copy now shows the outcome instead of the buttons
        expect((await inboxService.list({ userId: FRIEND })).items[0].friend).toMatchObject({ status: 'accepted', actionable: false });
        await expect(friendService.respond({ userId: FRIEND, requestId: request.id, accept: false })).rejects.toMatchObject({ code: 'REQUEST_SETTLED' });

        await portalUser(MATE, 'Marco');
        const second = await friendService.request({ userId: MATE, targetId: FRIEND });
        await friendService.respond({ userId: FRIEND, requestId: second.request.id, accept: false });
        expect(await friendService.areFriends(MATE, FRIEND)).toBe(false);
        expect((await inboxService.list({ userId: MATE })).items).toEqual([]);
        // Asking again straight away is refused; the requester only sees the request has gone.
        await expect(friendService.request({ userId: MATE, targetId: FRIEND })).rejects.toMatchObject({ code: 'REQUEST_COOLDOWN' });
        expect(await friendService.listRequests(MATE)).toEqual({ incoming: [], outgoing: [] });
    });

    test('only the addressee answers, only the requester withdraws', async () => {
        const { request } = await friendService.request({ userId: USER, targetId: FRIEND });
        await expect(friendService.respond({ userId: USER, requestId: request.id, accept: true })).rejects.toMatchObject({ code: 'NO_SUCH_REQUEST' });
        await expect(friendService.respond({ userId: STRANGER, requestId: request.id, accept: true })).rejects.toMatchObject({ code: 'NO_SUCH_REQUEST' });
        await expect(friendService.cancel({ userId: FRIEND, requestId: request.id })).rejects.toMatchObject({ code: 'NO_SUCH_REQUEST' });
        expect(await friendService.cancel({ userId: USER, requestId: request.id })).toEqual({ cancelled: true });
        expect(await friendService.pendingCount(FRIEND)).toBe(0);
        // A cancelled request can be sent again (the row is reopened, not duplicated)
        const again = await friendService.request({ userId: USER, targetId: FRIEND });
        expect(again.request.id).toBe(request.id);
        expect(again.status).toBe('pending');
    });

    test('two people who ask each other are friends without a second answer', async () => {
        await friendService.request({ userId: USER, targetId: FRIEND });
        const result = await friendService.request({ userId: FRIEND, targetId: USER });
        expect(result.status).toBe('accepted');
        expect(await friendService.areFriends(USER, FRIEND)).toBe(true);
    });

    test('either side can end a friendship, quietly, and ask again later', async () => {
        const { request } = await friendService.request({ userId: USER, targetId: FRIEND });
        await friendService.respond({ userId: FRIEND, requestId: request.id, accept: true });
        expect(await friendService.remove({ userId: FRIEND, friendId: USER })).toEqual({ removed: true });
        expect(await friendService.areFriends(USER, FRIEND)).toBe(false);
        expect(await friendService.listFriends(USER)).toEqual([]);
        await expect(friendService.remove({ userId: FRIEND, friendId: USER })).rejects.toMatchObject({ code: 'NOT_FRIENDS' });
        // No new inbox item for the removed side
        expect((await inboxService.list({ userId: USER })).items.map(item => item.title)).toEqual(['Frieda accepted your friend request']);
        const again = await friendService.request({ userId: FRIEND, targetId: USER });
        expect(again).toMatchObject({ status: 'pending', request: { id: request.id, requesterId: FRIEND, addresseeId: USER } });
    });

    test('friend requests are rate limited per sender', async () => {
        const { consumeWindow } = require('@goobster/core/utils/slidingWindowLimit');
        for (let i = 0; i < 20; i++) {
            await consumeWindow({ scope: 'friend_request', subject: USER, max: 20, windowMs: 3_600_000 });
        }
        await expect(friendService.request({ userId: USER, targetId: FRIEND })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });
});

describe('the Discord buttons', () => {
    function interaction(userId, client) {
        const followUps = [];
        return { user: { id: userId, username: 'frieda', globalName: 'Frieda' }, client, followUp: async (msg) => { followUps.push(msg); }, followUps };
    }

    test('the addressee accepts from the DM; anyone else is told it is not theirs', async () => {
        const client = fakeClient([member(USER, 'Rob'), member(FRIEND, 'Frieda')]);
        const { request } = await friendService.request({ client, userId: USER, targetId: FRIEND });
        const wrong = interaction(STRANGER, client);
        expect(await friendService.handleButton('accept', request.id, wrong)).toBeNull();
        expect(wrong.followUps[0].content).toMatch(/not addressed to you/);

        const edit = await friendService.handleButton('accept', request.id, interaction(FRIEND, client));
        expect(edit.content).toMatch(/friends now/);
        expect(edit.components).toEqual([]);
        expect(await friendService.areFriends(USER, FRIEND)).toBe(true);
        // Pressing again reports the settled state
        expect((await friendService.handleButton('decline', request.id, interaction(FRIEND, client))).content).toMatch(/Already accepted/);
        expect((await friendService.handleButton('accept', 999, interaction(FRIEND, client))).content).toMatch(/no longer exists/);
    });

    test('declining from the DM settles the request', async () => {
        const client = fakeClient([member(USER, 'Rob'), member(FRIEND, 'Frieda')]);
        const { request } = await friendService.request({ client, userId: USER, targetId: FRIEND });
        const edit = await friendService.handleButton('decline', request.id, interaction(FRIEND, client));
        expect(edit.content).toMatch(/declined/i);
        expect(await friendService.pendingCount(FRIEND)).toBe(0);
    });
});

describe('the friend list', () => {
    test('carries portal presence and respects "show me as online"', async () => {
        await portalUser(MATE, 'Marco', { seenSecondsAgo: 10 });
        await db.run('UPDATE web_sessions SET lastSeenAt = datetime(\'now\') WHERE userId = @id', { id: MATE });
        for (const other of [FRIEND, MATE]) {
            const { request } = await friendService.request({ userId: USER, targetId: other });
            await friendService.respond({ userId: other, requestId: request.id, accept: true });
        }
        const friends = await friendService.listFriends(USER, { presence: true });
        expect(friends.map(f => [f.name, f.online])).toEqual([['Frieda', false], ['Marco', true]]);
        const overview = await friendService.overview({ userId: USER });
        expect(overview.friends).toHaveLength(2);
        expect(overview.incoming).toEqual([]);

        const userSettingsService = require('@goobster/core/services/userSettingsService');
        jest.spyOn(userSettingsService, 'usersHidingPresence').mockResolvedValueOnce([MATE]);
        expect((await friendService.listFriends(USER, { presence: true })).find(f => f.id === MATE).online).toBe(false);
    });
});

describe('who a user can invite', () => {
    async function befriend(a, b) {
        const { request } = await friendService.request({ userId: a, targetId: b });
        await friendService.respond({ userId: b, requestId: request.id, accept: true });
    }

    test('friends come first, then server-mates, deduped', async () => {
        await befriend(USER, FRIEND);
        const client = fakeClient([
            member(USER, 'Rob'),
            member(FRIEND, 'Frieda'),      // also a server-mate: stays a friend
            member(MATE, 'Marco'),
            member('900000000000000009', 'Goobster', { bot: true })
        ]);
        const { people, hasFriends } = await friendService.listInvitable({ client, userId: USER });
        expect(hasFriends).toBe(true);
        expect(people.map(p => p.id)).toEqual([FRIEND, MATE]);
        expect(people[0]).toMatchObject({ source: 'friend', name: 'Frieda' });
        expect(people[1]).toMatchObject({ source: 'server', name: 'Marco', via: 'The Lair' });
        expect(people.some(p => p.id === USER)).toBe(false);
        expect(people.some(p => p.name === 'Goobster')).toBe(false);
    });

    test('works with no friends at all (server-mates only)', async () => {
        const client = fakeClient([member(USER, 'Rob'), member(MATE, 'Marco')]);
        const { people, hasFriends } = await friendService.listInvitable({ client, userId: USER });
        expect(hasFriends).toBe(false);
        expect(people.map(p => p.id)).toEqual([MATE]);
    });

    test('works with no Discord client at all (friends only)', async () => {
        await befriend(USER, FRIEND);
        const { people } = await friendService.listInvitable({ userId: USER });
        expect(people.map(p => p.id)).toEqual([FRIEND]);
    });

    test('only lists people from servers the user is actually in', async () => {
        const client = fakeClient([member(MATE, 'Marco')], { memberIds: new Set([MATE]) });
        const { people } = await friendService.listInvitable({ client, userId: USER });
        expect(people).toEqual([]);
    });

    test('the query filters every source and matches ids', async () => {
        await befriend(USER, FRIEND);
        const client = fakeClient([member(USER, 'Rob'), member(MATE, 'Marco')]);
        expect((await friendService.listInvitable({ client, userId: USER, q: 'mar' })).people.map(p => p.id)).toEqual([MATE]);
        expect((await friendService.listInvitable({ client, userId: USER, q: 'fri' })).people.map(p => p.id)).toEqual([FRIEND]);
        expect((await friendService.listInvitable({ client, userId: USER, q: FRIEND })).people.map(p => p.id)).toEqual([FRIEND]);
    });

    test('the exclusion set removes people already at the table', async () => {
        await befriend(USER, FRIEND);
        const client = fakeClient([member(USER, 'Rob'), member(MATE, 'Marco')]);
        const { people } = await friendService.listInvitable({ client, userId: USER, exclude: [FRIEND] });
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
        const { request } = await friendService.request({ userId: USER, targetId: FRIEND });
        await friendService.respond({ userId: FRIEND, requestId: request.id, accept: true });
        const client = fakeClient([member(USER, 'Rob'), member(MATE, 'Marco'), member(STRANGER, 'Zoltan')]);
        const conversation = await makeDiscussion();

        const before = await parlorService.listInvitable({ client, ownerId: USER, conversationId: conversation.id });
        expect(before.people.map(p => p.id)).toEqual([FRIEND, MATE, STRANGER]);
        expect(before.hasFriends).toBe(true);

        // Frieda joins, Zoltan has a pending invitation - both drop out
        await parlorService.invite({ ownerId: USER, conversationId: conversation.id, inviteeId: FRIEND });
        const invite = await db.get('SELECT id FROM parlor_invites');
        await parlorService.respondInvite({ userId: FRIEND, userName: 'Frieda', inviteId: invite.id, accept: true });
        await parlorService.invite({ ownerId: USER, conversationId: conversation.id, inviteeId: STRANGER });

        const after = await parlorService.listInvitable({ client, ownerId: USER, conversationId: conversation.id });
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
    const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
    let server;
    let port;
    const dms = [];

    async function call(method, reqPath, { body = null, headers = {} } = {}) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const req = http.request({
                host: '127.0.0.1', port, method, path: reqPath,
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
            client: fakeClient([member(USER, 'Rob'), member(FRIEND, 'Frieda'), member(MATE, 'Marco')], { dms }),
            config: { clientId: '123', webapp: { enabled: true, devMode: true } },
            logger: { error: () => {}, warn: () => {}, info: () => {} }
        });
        const app = express();
        app.use(createWebAppApp(ctx));
        server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        port = server.address().port;
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    async function login(userId, name) {
        const res = await call('POST', '/api/app/auth/dev-session', { body: { userId, name } });
        return res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session=')).split(';')[0];
    }

    test('the whole flow over HTTP: search, request, accept, list, remove', async () => {
        const rob = { Cookie: await login(USER, 'Rob') };
        const frieda = { Cookie: await login(FRIEND, 'Frieda') };

        const search = await call('GET', '/api/app/friends/search?q=fri', { headers: rob });
        expect(search.status).toBe(200);
        expect(search.json.people).toEqual([expect.objectContaining({ id: FRIEND, relationship: expect.objectContaining({ status: 'none' }) })]);

        const sent = await call('POST', '/api/app/friends/requests', { body: { userId: FRIEND }, headers: rob });
        expect(sent.status).toBe(200);
        expect(sent.json).toMatchObject({ status: 'pending', dmSent: true });
        expect((await call('POST', '/api/app/friends/requests', { body: { userId: FRIEND }, headers: rob })).json.error.code).toBe('ALREADY_REQUESTED');

        const me = await call('GET', '/api/app/me', { headers: frieda });
        expect(me.json.people).toEqual({ pending: 1, unread: 0 });
        const overview = await call('GET', '/api/app/friends', { headers: frieda });
        expect(overview.json.incoming).toEqual([expect.objectContaining({ id: sent.json.request.id, requesterName: 'Rob' })]);

        // Rob cannot accept his own request; Frieda can
        expect((await call('POST', `/api/app/friends/requests/${sent.json.request.id}/accept`, { headers: rob })).status).toBe(404);
        const accepted = await call('POST', `/api/app/friends/requests/${sent.json.request.id}/accept`, { headers: frieda });
        expect(accepted.json).toMatchObject({ status: 'accepted', friend: { id: USER } });

        const friends = await call('GET', '/api/app/friends', { headers: rob });
        expect(friends.json.friends).toEqual([expect.objectContaining({ id: FRIEND, name: 'Frieda', online: true })]);
        expect(friends.json.incoming).toEqual([]);

        const picker = await call('GET', '/api/app/people?q=fri', { headers: rob });
        expect(picker.json.people[0]).toMatchObject({ id: FRIEND, source: 'friend' });
        expect(picker.json.hasFriends).toBe(true);

        expect((await call('DELETE', `/api/app/friends/${USER}`, { headers: frieda })).json).toEqual({ removed: true });
        expect((await call('GET', '/api/app/friends', { headers: rob })).json.friends).toEqual([]);
    });

    test('withdrawing and declining over HTTP', async () => {
        const rob = { Cookie: await login(USER, 'Rob') };
        const frieda = { Cookie: await login(FRIEND, 'Frieda') };
        const first = await call('POST', '/api/app/friends/requests', { body: { userId: FRIEND }, headers: rob });
        expect((await call('DELETE', `/api/app/friends/requests/${first.json.request.id}`, { headers: rob })).json).toEqual({ cancelled: true });
        const second = await call('POST', '/api/app/friends/requests', { body: { userId: FRIEND }, headers: rob });
        const declined = await call('POST', `/api/app/friends/requests/${second.json.request.id}/decline`, { headers: frieda });
        expect(declined.json.status).toBe('declined');
        expect((await call('GET', '/api/app/me', { headers: frieda })).json.people.pending).toBe(0);
    });

    test('every route needs a session', async () => {
        expect((await call('GET', '/api/app/friends')).status).toBe(401);
        expect((await call('GET', '/api/app/friends/search?q=x')).status).toBe(401);
        expect((await call('POST', '/api/app/friends/requests', { body: { userId: FRIEND } })).status).toBe(401);
    });
});

describe('privacy (/forget-me)', () => {
    test('erases every friendship the person is on and reports it', async () => {
        await portalUser(MATE, 'Marco');
        const { request } = await friendService.request({ userId: USER, targetId: FRIEND });
        await friendService.respond({ userId: FRIEND, requestId: request.id, accept: true });
        await friendService.request({ userId: MATE, targetId: USER });

        const report = await privacyService.buildUserReport({ guildId: 'dm:' + USER, userId: USER });
        expect(report.friends).toEqual({ friends: 1, incomingRequests: 1, outgoingRequests: 0 });

        await privacyService.forgetUser({ userId: USER });

        expect((await privacyService.auditUser({ userId: USER })).byTable.friendships).toBe(0);
        expect(await friendService.listFriends(FRIEND)).toEqual([]);
        expect(await friendService.pendingCount(USER)).toBe(0);
        expect(await friendService.listRequests(MATE)).toEqual({ incoming: [], outgoing: [] });
        // Frieda's own inbox copy keeps its words but is no longer actionable
        const { items } = await inboxService.list({ userId: FRIEND });
        expect(items.map(item => item.friend)).toEqual([null]);
    });
});
