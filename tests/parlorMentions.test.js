/**
 * Unit tests for parlor @-mentions (services/parlorService.js): mentioning
 * another human of a shared discussion by display name notifies them -
 * through a 'parlor-mention' portal event when they are online in the web
 * app (presenceService), or through a Discord DM with a link to the chat
 * when they are not. Only humans actually seated at the table can be
 * mentioned, and delivery is best-effort (never breaks the turn). Runs
 * against a throwaway SQLite database with the AI backends mocked.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-parlor-mentions-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const mockEmbedding = {
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) =>
        texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    cosineSimilarity: () => 1
};
jest.mock('@goobster/core/services/embeddingService', () => mockEmbedding);

const mockAi = {
    chat: jest.fn(),
    generateText: jest.fn(),
    supportsNativeWebSearch: () => false
};
jest.mock('@goobster/core/services/aiService', () => mockAi);

jest.mock('@goobster/core/utils/imageDetectionHandler', () => ({ generateImage: jest.fn() }));

const db = require('@goobster/core/db');
const parlorService = require('@goobster/core/services/parlorService');
const webSessionService = require('@goobster/core/services/webSessionService');
const eventBusService = require('@goobster/core/services/eventBusService');

const OWNER = '410000000000000001';
const FRIEND = '410000000000000002';
const OTHER = '410000000000000003';

/** A fake DiscordGateway that records DMs (never resolves users). */
function fakeGateway() {
    return {
        isGoobsterGateway: true,
        sendDm: jest.fn(async () => ({ ok: true, channelId: 'c1', messageId: 'm1' }))
    };
}

/** Collect every event the bus publishes while fn runs. */
async function collectEvents(fn) {
    const events = [];
    const unsubscribe = eventBusService.subscribe((event) => events.push(event));
    try { await fn(); } finally { unsubscribe(); }
    return events;
}

async function makeSalon() {
    const persona = await parlorService.createPersona({
        ownerId: OWNER, name: 'Ada', charter: 'You are a careful researcher.'
    });
    const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });
    await parlorService.renameConversation({ ownerId: OWNER, conversationId: conversation.id, title: 'Rust salon' });
    return { persona, conversation: { ...conversation, ownerId: OWNER } };
}

async function join(conversationId, userId = FRIEND, userName = 'Frieda') {
    const { invite } = await parlorService.invite({
        ownerId: OWNER, ownerName: 'Rob', conversationId, inviteeId: userId
    });
    return await parlorService.respondInvite({ userId, userName, inviteId: invite.id, accept: true });
}

/** Shorthand: run mention delivery for one owner message. */
async function notify(conversation, text, { gateway = null, actorId = OWNER, actorName = 'Rob' } = {}) {
    return await parlorService._notifyMentions({
        gateway, conversation, actorId, actorName, text, messageId: 1
    });
}

beforeEach(async () => {
    for (const table of ['parlor_messages', 'parlor_participants', 'parlor_members',
        'parlor_invites', 'parlor_conversations',
        'parlor_note_tags', 'parlor_tags', 'parlor_notes', 'parlor_personas']) {
        await db.run(`DELETE FROM ${table}`);
    }
    await db.run('DELETE FROM web_sessions');
    await db.run('DELETE FROM user_friends');
    await db.run('DELETE FROM web_rate_events');
    parlorService._activeTurns.clear();
    mockAi.chat.mockReset();
    mockAi.generateText.mockReset();
    mockAi.generateText.mockResolvedValue('{"notes": []}');
    mockAi.chat.mockResolvedValue({ content: 'A considered reply.', toolCalls: [] });
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

describe('mention target resolution', () => {
    test('matches member snapshots by name, case-insensitively, mid-sentence', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id);
        const targets = await parlorService._mentionTargets({
            conversationId: conversation.id, ownerId: OWNER, actorId: OWNER,
            text: 'I think @frieda should weigh in here.'
        });
        expect(targets).toEqual([FRIEND]);
    });

    test('never the actor, never strangers, no partial-word matches', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id);
        // Self-mention is dropped
        expect(await parlorService._mentionTargets({
            conversationId: conversation.id, ownerId: OWNER, actorId: FRIEND,
            text: 'note to self @Frieda'
        })).toEqual([]);
        // A name that belongs to nobody at the table resolves to nothing
        expect(await parlorService._mentionTargets({
            conversationId: conversation.id, ownerId: OWNER, actorId: OWNER,
            text: 'hello @Zelda'
        })).toEqual([]);
        // "@FriedaX" is a different handle; "mail@Frieda" is not a mention
        expect(await parlorService._mentionTargets({
            conversationId: conversation.id, ownerId: OWNER, actorId: OWNER,
            text: 'ping @FriedaX and mail@Frieda'
        })).toEqual([]);
    });

    test('a member can mention the owner through their web-session name', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id);
        await webSessionService.create({ userId: OWNER, userName: 'Rob' });
        const targets = await parlorService._mentionTargets({
            conversationId: conversation.id, ownerId: OWNER, actorId: FRIEND,
            text: 'what do you think, @Rob?'
        });
        expect(targets).toEqual([OWNER]);
    });

    test('a raw user id works when no display name is known', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id, FRIEND, null); // no name snapshot
        const targets = await parlorService._mentionTargets({
            conversationId: conversation.id, ownerId: OWNER, actorId: OWNER,
            text: `hey @${FRIEND}, thoughts?`
        });
        expect(targets).toEqual([FRIEND]);
    });
});

describe('mention delivery', () => {
    test('online in the portal: a parlor-mention event, no DM', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id);
        await webSessionService.create({ userId: FRIEND, userName: 'Frieda' });
        const gateway = fakeGateway();
        const events = await collectEvents(() =>
            notify(conversation, 'over to you @Frieda', { gateway }));
        expect(gateway.sendDm).not.toHaveBeenCalled();
        expect(events).toEqual([expect.objectContaining({
            kind: 'parlor-mention',
            payload: expect.objectContaining({
                userId: FRIEND,
                conversationId: conversation.id,
                fromUserId: OWNER,
                fromName: 'Rob',
                title: 'Rust salon'
            })
        })]);
    });

    test('offline: a Discord DM with a link to the chat, no portal event', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id);
        const gateway = fakeGateway();
        const events = await collectEvents(() =>
            notify(conversation, 'over to you @Frieda', { gateway }));
        expect(events).toEqual([]);
        expect(gateway.sendDm).toHaveBeenCalledTimes(1);
        const [target, payload] = gateway.sendDm.mock.calls[0];
        expect(target).toBe(FRIEND);
        const embed = payload.embeds[0].toJSON();
        expect(embed.title).toContain('mentioned');
        expect(embed.description).toContain('Rob');
        expect(embed.description).toContain('Rust salon');
    });

    test('mixed presence splits delivery per person', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id);
        await join(conversation.id, OTHER, 'Sam');
        await webSessionService.create({ userId: FRIEND, userName: 'Frieda' });
        const gateway = fakeGateway();
        const events = await collectEvents(() =>
            notify(conversation, '@Frieda @Sam - settle this', { gateway }));
        expect(events.map(e => e.payload.userId)).toEqual([FRIEND]);
        expect(gateway.sendDm.mock.calls.map(([id]) => id)).toEqual([OTHER]);
    });

    test('no gateway (bot unreachable) skips the DM without throwing', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id);
        const events = await collectEvents(() =>
            notify(conversation, 'hey @Frieda', { gateway: null }));
        expect(events).toEqual([]);
    });

    test('a message without mentions publishes and sends nothing', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id);
        await webSessionService.create({ userId: FRIEND, userName: 'Frieda' });
        const gateway = fakeGateway();
        const events = await collectEvents(() =>
            notify(conversation, 'no mentions here', { gateway }));
        expect(events).toEqual([]);
        expect(gateway.sendDm).not.toHaveBeenCalled();
    });
});

describe('mentions ride a real turn', () => {
    test('startTurn delivers the mention DM off the critical path', async () => {
        const { conversation } = await makeSalon();
        await join(conversation.id);
        const gateway = fakeGateway();
        const turn = await parlorService.startTurn({
            gateway, userId: OWNER, userName: 'Rob',
            conversationId: conversation.id,
            message: 'what say you, @Frieda?'
        });
        await turn.run({});
        // Delivery is fire-and-forget; give the microtask queue a beat
        for (let i = 0; i < 50 && gateway.sendDm.mock.calls.length === 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(gateway.sendDm).toHaveBeenCalledTimes(1);
        expect(gateway.sendDm.mock.calls[0][0]).toBe(FRIEND);
    });
});
