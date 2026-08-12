/**
 * Unit tests for multi-user parlors (services/parlorService.js): inviting a
 * Discord friend into a discussion (parlor_invites + the DM buttons),
 * membership (parlor_members), member access to shared discussions
 * (transcript, turns, nudges - never the owner-only management surface),
 * speaker attribution on user messages, and /forget-me coverage for a
 * member's footprint in someone else's parlor. Runs against a throwaway
 * SQLite database with the AI and embedding backends mocked (no network).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-parlor-sharing-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const mockEmbedding = {
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) =>
        texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    cosineSimilarity: () => 1
};
jest.mock('../services/embeddingService', () => mockEmbedding);

const mockAi = {
    chat: jest.fn(),
    generateText: jest.fn(),
    supportsNativeWebSearch: () => false
};
jest.mock('../services/aiService', () => mockAi);

// Persona turns offer tools from the real registry; these wrapped commands
// boot heavy voice/music services at load time (parlorService.test pattern).
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));
jest.mock('../utils/imageDetectionHandler', () => ({ generateImage: jest.fn() }));

const db = require('../db');
const parlorService = require('../services/parlorService');
const privacyService = require('../services/privacyService');

const OWNER = '400000000000000001';
const FRIEND = '400000000000000002';
const STRANGER = '400000000000000003';

/** Assert a ParlorError with the expected code (sync). */
function expectParlorError(fn, code) {
    let caught = null;
    try { fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(code);
}

/** Assert a ParlorError with the expected code (async). */
async function expectParlorErrorAsync(promise, code) {
    await expect(promise).rejects.toMatchObject({ code });
}

/** A fake discord.js client whose users.fetch returns a DM-able user. */
function fakeClient({ bot = false, failFetch = false, failSend = false } = {}) {
    const send = jest.fn(async () => {
        if (failSend) throw new Error('Cannot send messages to this user');
        return { id: 'dm-1' };
    });
    const user = { id: FRIEND, bot, username: 'frieda', globalName: 'Frieda', send };
    return {
        users: {
            fetch: jest.fn(async () => {
                if (failFetch) throw new Error('Unknown User');
                return user;
            })
        },
        _sent: send
    };
}

beforeEach(() => {
    for (const table of ['parlor_messages', 'parlor_participants', 'parlor_members',
        'parlor_invites', 'parlor_conversations',
        'parlor_note_tags', 'parlor_tags', 'parlor_notes', 'parlor_personas']) {
        db.run(`DELETE FROM ${table}`);
    }
    parlorService._recentTurns.clear();
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

function makeSalon() {
    const persona = parlorService.createPersona({
        ownerId: OWNER, name: 'Ada', emoji: '🔬', charter: 'You are a careful researcher.'
    });
    const conversation = parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });
    parlorService.renameConversation({ ownerId: OWNER, conversationId: conversation.id, title: 'Rust salon' });
    return { persona, conversation };
}

async function acceptInvite(conversationId, userId = FRIEND, userName = 'Frieda') {
    const { invite } = await parlorService.invite({
        ownerId: OWNER, ownerName: 'Rob', conversationId, inviteeId: userId
    });
    return parlorService.respondInvite({ userId, userName, inviteId: invite.id, accept: true });
}

describe('inviting a friend', () => {
    test('creates a pending invite and DMs accept/decline buttons', async () => {
        const { conversation } = makeSalon();
        const client = fakeClient();
        const { invite, dmSent, inviteeName } = await parlorService.invite({
            client, ownerId: OWNER, ownerName: 'Rob',
            conversationId: conversation.id, inviteeId: FRIEND
        });
        expect(invite.status).toBe('pending');
        expect(invite.inviteeId).toBe(FRIEND);
        expect(dmSent).toBe(true);
        expect(inviteeName).toBe('Frieda');

        const [payload] = client._sent.mock.calls[0];
        const buttons = payload.components[0].components.map(c => c.toJSON().custom_id);
        expect(buttons).toEqual([
            `accept_parlorinvite_${invite.id}`,
            `decline_parlorinvite_${invite.id}`
        ]);
        // The invitee sees it in their web app list too
        expect(parlorService.listInvites(FRIEND).map(i => i.id)).toEqual([invite.id]);
        expect(parlorService.listInvites(STRANGER)).toEqual([]);
    });

    test('closed DMs are not an error - the invite still exists', async () => {
        const { conversation } = makeSalon();
        const { invite, dmSent } = await parlorService.invite({
            client: fakeClient({ failSend: true }), ownerId: OWNER, ownerName: 'Rob',
            conversationId: conversation.id, inviteeId: FRIEND
        });
        expect(dmSent).toBe(false);
        expect(parlorService.listInvites(FRIEND).map(i => i.id)).toEqual([invite.id]);
    });

    test('validation: bad ids, self, bots, unknown users, duplicates', async () => {
        const { conversation } = makeSalon();
        await expectParlorErrorAsync(parlorService.invite({
            ownerId: OWNER, conversationId: conversation.id, inviteeId: 'not-a-snowflake'
        }), 'BAD_USER_ID');
        await expectParlorErrorAsync(parlorService.invite({
            ownerId: OWNER, conversationId: conversation.id, inviteeId: OWNER
        }), 'CANNOT_INVITE_SELF');
        await expectParlorErrorAsync(parlorService.invite({
            client: fakeClient({ bot: true }), ownerId: OWNER,
            conversationId: conversation.id, inviteeId: FRIEND
        }), 'CANNOT_INVITE_BOT');
        await expectParlorErrorAsync(parlorService.invite({
            client: fakeClient({ failFetch: true }), ownerId: OWNER,
            conversationId: conversation.id, inviteeId: FRIEND
        }), 'NO_SUCH_USER');
        // A failed invite never leaves a ghost row
        expect(db.get('SELECT COUNT(*) AS c FROM parlor_invites').c).toBe(0);

        await parlorService.invite({ ownerId: OWNER, conversationId: conversation.id, inviteeId: FRIEND });
        await expectParlorErrorAsync(parlorService.invite({
            ownerId: OWNER, conversationId: conversation.id, inviteeId: FRIEND
        }), 'ALREADY_INVITED');
    });

    test('only the owner invites; strangers cannot even see the discussion', async () => {
        const { conversation } = makeSalon();
        await expectParlorErrorAsync(parlorService.invite({
            ownerId: STRANGER, conversationId: conversation.id, inviteeId: FRIEND
        }), 'NO_SUCH_CONVERSATION');
    });

    test('the people cap counts members and pending invitations', async () => {
        const { conversation } = makeSalon();
        // Owner (1) + three invites = 4 people; a fourth invite must fail
        for (const id of ['400000000000000011', '400000000000000012', '400000000000000013']) {
            await parlorService.invite({ ownerId: OWNER, conversationId: conversation.id, inviteeId: id });
        }
        await expectParlorErrorAsync(parlorService.invite({
            ownerId: OWNER, conversationId: conversation.id, inviteeId: '400000000000000014'
        }), 'DISCUSSION_FULL');
    });

    test('the owner can revoke a pending invitation', async () => {
        const { conversation } = makeSalon();
        const { invite } = await parlorService.invite({
            ownerId: OWNER, conversationId: conversation.id, inviteeId: FRIEND
        });
        expectParlorError(() => parlorService.revokeInvite({ ownerId: STRANGER, inviteId: invite.id }),
            'NO_SUCH_INVITE');
        expect(parlorService.revokeInvite({ ownerId: OWNER, inviteId: invite.id })).toEqual({ revoked: true });
        expect(parlorService.listInvites(FRIEND)).toEqual([]);
        expectParlorError(() => parlorService.respondInvite({
            userId: FRIEND, inviteId: invite.id, accept: true
        }), 'INVITE_SETTLED');
    });
});

describe('accepting and declining', () => {
    test('accept makes the friend a member; the discussion shows up for them', async () => {
        const { conversation } = makeSalon();
        const result = await acceptInvite(conversation.id);
        expect(result.status).toBe('accepted');

        const shared = parlorService.listConversations(FRIEND);
        expect(shared).toHaveLength(1);
        expect(shared[0].id).toBe(conversation.id);
        expect(shared[0].role).toBe('member');
        expect(shared[0].ownerId).toBe(OWNER);
        expect(shared[0].members).toEqual([
            expect.objectContaining({ userId: FRIEND, userName: 'Frieda' })
        ]);
        // The owner sees the same roster (role flips)
        const mine = parlorService.listConversations(OWNER);
        expect(mine[0].role).toBe('owner');
        expect(mine[0].members.map(m => m.userId)).toEqual([FRIEND]);

        const roster = parlorService.listMembers({ userId: OWNER, conversationId: conversation.id });
        expect(roster.role).toBe('owner');
        expect(roster.members.map(m => m.userId)).toEqual([FRIEND]);
        expect(roster.invites).toEqual([]);
    });

    test('decline leaves no membership behind', async () => {
        const { conversation } = makeSalon();
        const { invite } = await parlorService.invite({
            ownerId: OWNER, conversationId: conversation.id, inviteeId: FRIEND
        });
        const result = parlorService.respondInvite({ userId: FRIEND, inviteId: invite.id, accept: false });
        expect(result.status).toBe('declined');
        expect(parlorService.listConversations(FRIEND)).toEqual([]);
        expectParlorError(() => parlorService.respondInvite({
            userId: FRIEND, inviteId: invite.id, accept: true
        }), 'INVITE_SETTLED');
    });

    test('only the addressee can respond', async () => {
        const { conversation } = makeSalon();
        const { invite } = await parlorService.invite({
            ownerId: OWNER, conversationId: conversation.id, inviteeId: FRIEND
        });
        expectParlorError(() => parlorService.respondInvite({
            userId: STRANGER, inviteId: invite.id, accept: true
        }), 'NO_SUCH_INVITE');
    });

    test('the Discord DM buttons settle the invite', async () => {
        const { conversation } = makeSalon();
        const { invite } = await parlorService.invite({
            ownerId: OWNER, conversationId: conversation.id, inviteeId: FRIEND
        });
        const interaction = {
            user: { id: FRIEND, username: 'frieda', globalName: 'Frieda' },
            message: { embeds: [] },
            update: jest.fn(async () => {}),
            reply: jest.fn(async () => {})
        };
        // A stranger clicking someone else's DM buttons is refused
        await parlorService.handleInviteButton('accept', invite.id,
            { ...interaction, user: { id: STRANGER } });
        expect(parlorService.listConversations(FRIEND)).toEqual([]);

        await parlorService.handleInviteButton('accept', invite.id, interaction);
        expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
        expect(parlorService.listConversations(FRIEND).map(c => c.id)).toEqual([conversation.id]);
        expect(parlorService.listMembers({ userId: OWNER, conversationId: conversation.id })
            .members[0].userName).toBe('Frieda');
    });
});

describe('member access to a shared discussion', () => {
    test('members read the transcript; strangers get a 404', async () => {
        const { conversation } = makeSalon();
        db.run(
            `INSERT INTO parlor_messages (conversationId, role, content, userId, userName)
             VALUES (@id, 'user', 'hello from Rob', @ownerId, 'Rob')`,
            { id: conversation.id, ownerId: OWNER }
        );
        await acceptInvite(conversation.id);
        const messages = parlorService.getMessages({ userId: FRIEND, conversationId: conversation.id });
        expect(messages).toHaveLength(1);
        expect(messages[0].userName).toBe('Rob');
        expectParlorError(() => parlorService.getMessages({
            userId: STRANGER, conversationId: conversation.id
        }), 'NO_SUCH_CONVERSATION');
    });

    test('a member sends a turn: attribution stored, personas told who spoke', async () => {
        const { conversation } = makeSalon();
        await acceptInvite(conversation.id);
        const turn = parlorService.startTurn({
            userId: FRIEND, userName: 'Frieda',
            conversationId: conversation.id,
            message: 'May I join the discussion?'
        });
        await turn.run({});

        const stored = parlorService.getMessages({ userId: OWNER, conversationId: conversation.id });
        expect(stored.map(m => m.role)).toEqual(['user', 'persona']);
        expect(stored[0].userId).toBe(FRIEND);
        expect(stored[0].userName).toBe('Frieda');

        // The persona's prompt labeled the member by name
        const [messages] = mockAi.chat.mock.calls[0];
        expect(messages.some(m => m.role === 'user' && m.content.startsWith('[Frieda]:'))).toBe(true);
    });

    test('one turn per conversation: a member turn locks the owner out too', async () => {
        const { conversation } = makeSalon();
        await acceptInvite(conversation.id);
        const turn = parlorService.startTurn({
            userId: FRIEND, userName: 'Frieda', conversationId: conversation.id, message: 'hi'
        });
        expectParlorError(() => parlorService.startTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id, message: 'me too'
        }), 'TURN_IN_FLIGHT');
        // The owner can stop their own turns only; the member stops theirs
        expect(parlorService.stopTurn(OWNER)).toBe(false);
        expect(parlorService.stopTurn(FRIEND)).toBe(true);
        await turn.run({});
    });

    test('members can nudge a seated persona', async () => {
        const { conversation, persona } = makeSalon();
        await acceptInvite(conversation.id);
        const turn = parlorService.startPersonaTurn({
            userId: FRIEND, userName: 'Frieda',
            conversationId: conversation.id, personaId: persona.id
        });
        await turn.run({});
        const stored = parlorService.getMessages({ userId: FRIEND, conversationId: conversation.id });
        expect(stored.map(m => m.role)).toEqual(['persona']);
    });

    test('the management surface stays owner-only', async () => {
        const { conversation, persona } = makeSalon();
        await acceptInvite(conversation.id);
        expectParlorError(() => parlorService.renameConversation({
            ownerId: FRIEND, conversationId: conversation.id, title: 'Mine now'
        }), 'NO_SUCH_CONVERSATION');
        expectParlorError(() => parlorService.deleteConversation({
            ownerId: FRIEND, conversationId: conversation.id
        }), 'NO_SUCH_CONVERSATION');
        expectParlorError(() => parlorService.setParticipant({
            ownerId: FRIEND, conversationId: conversation.id, personaId: persona.id, present: false
        }), 'NO_SUCH_CONVERSATION');
        await expectParlorErrorAsync(parlorService.invite({
            ownerId: FRIEND, conversationId: conversation.id, inviteeId: STRANGER
        }), 'NO_SUCH_CONVERSATION');
        // Members do not see the owner's pending invites either
        const roster = parlorService.listMembers({ userId: FRIEND, conversationId: conversation.id });
        expect(roster.role).toBe('member');
        expect(roster.invites).toEqual([]);
    });

    test('removal: owner removes anyone, members remove only themselves', async () => {
        const { conversation } = makeSalon();
        await acceptInvite(conversation.id);
        await acceptInvite(conversation.id, STRANGER, 'Sam');

        expectParlorError(() => parlorService.removeMember({
            userId: FRIEND, conversationId: conversation.id, memberId: STRANGER
        }), 'NOT_OWNER');

        // A member leaves on their own
        const left = parlorService.removeMember({
            userId: FRIEND, conversationId: conversation.id, memberId: FRIEND
        });
        expect(left.left).toBe(true);
        expect(parlorService.listConversations(FRIEND)).toEqual([]);

        // The owner removes the other member
        const removed = parlorService.removeMember({
            userId: OWNER, conversationId: conversation.id, memberId: STRANGER
        });
        expect(removed.members).toEqual([]);
        expectParlorError(() => parlorService.removeMember({
            userId: OWNER, conversationId: conversation.id, memberId: STRANGER
        }), 'NO_SUCH_MEMBER');
    });

    test('deleting the discussion cascades members and invites', async () => {
        const { conversation } = makeSalon();
        await acceptInvite(conversation.id);
        await parlorService.invite({ ownerId: OWNER, conversationId: conversation.id, inviteeId: STRANGER });
        parlorService.deleteConversation({ ownerId: OWNER, conversationId: conversation.id });
        expect(db.get('SELECT COUNT(*) AS c FROM parlor_members').c).toBe(0);
        expect(db.get('SELECT COUNT(*) AS c FROM parlor_invites').c).toBe(0);
        expect(parlorService.listConversations(FRIEND)).toEqual([]);
    });
});

describe('privacy (/forget-me) for shared parlors', () => {
    test('forgetting a member erases their footprint in the host parlor', async () => {
        const { conversation } = makeSalon();
        await acceptInvite(conversation.id);
        const turn = parlorService.startTurn({
            userId: FRIEND, userName: 'Frieda', conversationId: conversation.id, message: 'my message'
        });
        await turn.run({});
        db.run(
            `INSERT INTO parlor_invites (conversationId, inviterId, inviteeId)
             VALUES (@id, @ownerId, '400000000000000099')`,
            { id: conversation.id, ownerId: OWNER }
        );

        const report = privacyService.buildUserReport({ guildId: 'dm:' + FRIEND, userId: FRIEND });
        expect(report.parlor.sharedDiscussions).toBe(1);

        privacyService.forgetUser({ userId: FRIEND });

        const audit = privacyService.auditUser({ userId: FRIEND });
        expect(audit.byTable.parlor_members).toBe(0);
        expect(audit.byTable.parlor_invites).toBe(0);
        expect(audit.byTable.parlor_messages_authored).toBe(0);

        // The host parlor survives: conversation, persona reply, other invite
        expect(parlorService.listConversations(OWNER)).toHaveLength(1);
        const remaining = parlorService.getMessages({ userId: OWNER, conversationId: conversation.id });
        expect(remaining.map(m => m.role)).toEqual(['persona']);
        expect(db.get('SELECT COUNT(*) AS c FROM parlor_invites').c).toBe(1);
    });
});
