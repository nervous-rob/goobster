/**
 * Unit tests for web chat branching (webChatService.branchFrom) and
 * read-only share links (create/get/revoke/getSharedConversation), plus
 * their /forget-me coverage.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-branchshare-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/utils/chatHandler', () => ({
    handleChatInteraction: jest.fn().mockResolvedValue(undefined)
}));
// _autoTitle fires a fire-and-forget model call on a conversation's first
// turn - keep it off the network.
jest.mock('@goobster/core/services/aiService', () => ({
    generateText: jest.fn().mockResolvedValue('Branch Title')
}));

const db = require('@goobster/core/db');
const webChatService = require('@goobster/core/services/webChatService');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const USER = '200000000000000001';
const OTHER = '200000000000000002';
const BOT = '900000000000000001';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(async () => {
    webChatService._activeTurns.clear();
    webChatService._recentTurns.clear();
    await db.run('DELETE FROM messages');
    await db.run('DELETE FROM conversations');
    await db.run('DELETE FROM conversation_summaries');
    await db.run('DELETE FROM guild_conversations');
    await db.run('DELETE FROM web_share_links');
    await db.run('DELETE FROM web_conversations');
    await db.run('DELETE FROM users');
});

/** Seed a conversation with message rows the way handleChatInteraction would. */
async function seedConversation(userId, texts, { title = null } = {}) {
    const conversation = await webChatService.createConversation(userId);
    if (title) {
        await webChatService.renameConversation({ userId, conversationId: conversation.id, title });
    }
    const { channelId } = await db.get(
        'SELECT channelId FROM web_conversations WHERE id = @id', { id: conversation.id }
    );

    await db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('rob', @id, 'rob') ON CONFLICT DO NOTHING`, { id: userId });
    await db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('Goobster', @id, 'Goobster') ON CONFLICT DO NOTHING`, { id: BOT });
    const human = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: userId })).id;
    const bot = (await db.get('SELECT id FROM users WHERE discordId = @id', { id: BOT })).id;

    await db.run(
        `INSERT INTO guild_conversations (guildId, channelId, threadId) VALUES (@g, @c, @t)`,
        { g: dmScopeId(userId), c: channelId, t: `channel-${channelId}` }
    );
    const guildConvId = (await db.get('SELECT id FROM guild_conversations ORDER BY id DESC LIMIT 1')).id;
    await db.run('INSERT INTO conversations (userId, guildConversationId) VALUES (@u, @g)', { u: human, g: guildConvId });
    const conversationId = (await db.get('SELECT id FROM conversations ORDER BY id DESC LIMIT 1')).id;

    for (const [role, text] of texts) {
        await db.run(
            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot)
             VALUES (@c, @g, @by, @m, @isBot)`,
            { c: conversationId, g: guildConvId, by: role === 'user' ? human : bot, m: text, isBot: role !== 'user' }
        );
    }
    return conversation.id;
}

describe('branching', () => {
    test('branchFrom copies history before the branch point into a new conversation', async () => {
        const sourceId = await seedConversation(USER, [
            ['user', 'question one'],
            ['assistant', 'answer one'],
            ['user', 'question two'],
            ['assistant', 'answer two']
        ], { title: 'Original chat' });
        const history = await webChatService.getHistory({ userId: USER, conversationId: sourceId });
        const branchPoint = history[2]; // 'question two'

        const branch = await webChatService.branchFrom({
            userId: USER, conversationId: sourceId, messageId: branchPoint.id
        });
        expect(branch.parentConversationId).toBe(sourceId);
        expect(branch.branchedFromMessageId).toBe(branchPoint.id);
        expect(branch.title).toBe('Original chat (branch)');
        expect(branch.messageCount).toBe(2);

        // The branch holds exactly the shared history
        const branchHistory = await webChatService.getHistory({ userId: USER, conversationId: branch.id });
        expect(branchHistory.map(m => [m.role, m.content])).toEqual([
            ['user', 'question one'],
            ['assistant', 'answer one']
        ]);

        // The original stays fully intact - the whole point of branching
        expect((await webChatService.getHistory({ userId: USER, conversationId: sourceId })).map(m => m.content))
            .toEqual(['question one', 'answer one', 'question two', 'answer two']);

        // Both appear in the sidebar; the branch carries its lineage
        const list = await webChatService.listConversations(USER);
        expect(list.map(c => c.id).sort()).toEqual([sourceId, branch.id].sort());
        expect(list.find(c => c.id === branch.id).parentConversationId).toBe(sourceId);
    });

    test('bot authorship survives the copy (context rebuild reads correctly)', async () => {
        const { handleChatInteraction } = require('@goobster/core/utils/chatHandler');
        const sourceId = await seedConversation(USER, [
            ['user', 'hi'],
            ['assistant', 'hello!'],
            ['user', 'bye']
        ]);
        const history = await webChatService.getHistory({ userId: USER, conversationId: sourceId });
        const branch = await webChatService.branchFrom({
            userId: USER, conversationId: sourceId, messageId: history[2].id
        });

        let fetched;
        handleChatInteraction.mockImplementation(async (interaction) => {
            fetched = await interaction.channel.messages.fetch({ limit: 20 });
        });
        const client = { user: { id: BOT, username: 'Goobster' } };
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'branch turn', conversationId: branch.id
        });
        expect(fetched.size).toBe(2);
        expect(fetched[0].author.id).toBe(BOT);     // 'hello!' newest-first
        expect(fetched[1].author.id).toBe(USER);    // 'hi'
    });

    test('branching from the first message yields an empty branch with lineage', async () => {
        const sourceId = await seedConversation(USER, [['user', 'only message']]);
        const [first] = await webChatService.getHistory({ userId: USER, conversationId: sourceId });
        const branch = await webChatService.branchFrom({
            userId: USER, conversationId: sourceId, messageId: first.id
        });
        expect(branch.messageCount).toBe(0);
        expect(await webChatService.getHistory({ userId: USER, conversationId: branch.id })).toEqual([]);
    });

    test('ownership and validity are enforced', async () => {
        const sourceId = await seedConversation(USER, [['user', 'mine']]);
        const [message] = await webChatService.getHistory({ userId: USER, conversationId: sourceId });

        await expect((async () => await webChatService.branchFrom({ userId: OTHER, conversationId: sourceId, messageId: message.id }))())
            .rejects.toThrow(expect.objectContaining({ status: 404, code: 'NO_SUCH_CONVERSATION' }));
        await expect((async () => await webChatService.branchFrom({ userId: USER, conversationId: sourceId, messageId: 999999 }))())
            .rejects.toThrow(expect.objectContaining({ status: 404, code: 'NOT_FOUND' }));
    });

    test('branching is blocked while a turn is in flight', async () => {
        const sourceId = await seedConversation(USER, [['user', 'busy']]);
        const [message] = await webChatService.getHistory({ userId: USER, conversationId: sourceId });
        const client = { user: { id: BOT, username: 'Goobster' } };
        const turn = await webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'go' });
        await expect((async () => await webChatService.branchFrom({ userId: USER, conversationId: sourceId, messageId: message.id }))())
            .rejects.toThrow(expect.objectContaining({ status: 409, code: 'TURN_IN_FLIGHT' }));
        turn.release();
    });

    test('deleting the parent detaches (not deletes) its branches', async () => {
        const sourceId = await seedConversation(USER, [['user', 'a'], ['assistant', 'b'], ['user', 'c']]);
        const history = await webChatService.getHistory({ userId: USER, conversationId: sourceId });
        const branch = await webChatService.branchFrom({ userId: USER, conversationId: sourceId, messageId: history[2].id });

        await webChatService.deleteConversation({ userId: USER, conversationId: sourceId });
        const list = await webChatService.listConversations(USER);
        expect(list.map(c => c.id)).toEqual([branch.id]);
        expect(list[0].parentConversationId).toBeNull();
        // The branch's copied history is its own - it survives
        expect(await webChatService.getHistory({ userId: USER, conversationId: branch.id })).toHaveLength(2);
    });
});

describe('share links', () => {
    test('create is idempotent, get reflects state, revoke kills the link', async () => {
        const conversationId = await seedConversation(USER, [['user', 'hello'], ['assistant', 'hi!']], { title: 'Shared thoughts' });

        expect(await webChatService.getShareLink({ userId: USER, conversationId })).toEqual({ shared: false });

        const created = await webChatService.createShareLink({ userId: USER, conversationId });
        expect(created.token).toMatch(/^[a-f0-9]{40}$/);
        expect(created.url).toBe(`/app/share/${created.token}`);

        // Idempotent: same link back
        expect((await webChatService.createShareLink({ userId: USER, conversationId })).token).toBe(created.token);

        const state = await webChatService.getShareLink({ userId: USER, conversationId });
        expect(state.shared).toBe(true);
        expect(state.token).toBe(created.token);

        expect(await webChatService.revokeShareLink({ userId: USER, conversationId })).toEqual({ revoked: true });
        expect(await webChatService.getShareLink({ userId: USER, conversationId })).toEqual({ shared: false });
        await expect((async () => await webChatService.getSharedConversation(created.token))())
            .rejects.toThrow(expect.objectContaining({ status: 404 }));
    });

    test('the public transcript is read-only text with no owner identifiers', async () => {
        const conversationId = await seedConversation(USER, [
            ['user', 'what is a fjord?'],
            ['assistant', 'A long narrow inlet.']
        ], { title: 'Geography' });
        const { token } = await webChatService.createShareLink({ userId: USER, conversationId });

        const shared = await webChatService.getSharedConversation(token);
        expect(shared.title).toBe('Geography');
        expect(shared.messages).toEqual([
            expect.objectContaining({ role: 'user', content: 'what is a fjord?' }),
            expect.objectContaining({ role: 'assistant', content: 'A long narrow inlet.' })
        ]);
        // Nothing that identifies the owner or enables further access
        expect(JSON.stringify(shared)).not.toContain(USER);
        expect(JSON.stringify(shared)).not.toContain('attachments');
    });

    test('a share link never exposes other conversations', async () => {
        const sharedConv = await seedConversation(USER, [['user', 'public stuff']]);
        await seedConversation(USER, [['user', 'private stuff']]);
        await seedConversation(OTHER, [['user', 'someone else entirely']]);
        const { token } = await webChatService.createShareLink({ userId: USER, conversationId: sharedConv });

        const shared = await webChatService.getSharedConversation(token);
        expect(shared.messages.map(m => m.content)).toEqual(['public stuff']);
    });

    test('bogus and malformed tokens 404 without leaking anything', async () => {
        await expect((async () => await webChatService.getSharedConversation('deadbeef'.repeat(5)))())
            .rejects.toThrow(expect.objectContaining({ status: 404 }));
        await expect((async () => await webChatService.getSharedConversation("' OR 1=1 --"))())
            .rejects.toThrow(expect.objectContaining({ status: 404 }));
        await expect((async () => await webChatService.getSharedConversation(''))())
            .rejects.toThrow(expect.objectContaining({ status: 404 }));
    });

    test('only the owner can create or revoke', async () => {
        const conversationId = await seedConversation(USER, [['user', 'mine']]);
        await expect((async () => await webChatService.createShareLink({ userId: OTHER, conversationId }))())
            .rejects.toThrow(expect.objectContaining({ status: 404 }));
        await webChatService.createShareLink({ userId: USER, conversationId });
        await expect((async () => await webChatService.revokeShareLink({ userId: OTHER, conversationId }))())
            .rejects.toThrow(expect.objectContaining({ status: 404 }));
    });

    test('deleting the conversation deletes its share link', async () => {
        const conversationId = await seedConversation(USER, [['user', 'temp']]);
        const { token } = await webChatService.createShareLink({ userId: USER, conversationId });
        await webChatService.deleteConversation({ userId: USER, conversationId });
        await expect((async () => await webChatService.getSharedConversation(token))())
            .rejects.toThrow(expect.objectContaining({ status: 404 }));
        expect((await db.get('SELECT COUNT(*) AS c FROM web_share_links')).c).toBe(0);
    });
});

describe('privacy coverage', () => {
    test('/forget-me deletes share links and the audit counts them', async () => {
        const privacyService = require('@goobster/core/services/privacyService');
        const conversationId = await seedConversation(USER, [['user', 'forget this']]);
        await webChatService.createShareLink({ userId: USER, conversationId });

        const before = await privacyService.auditUser({ userId: USER });
        expect(before.byTable.web_share_links).toBe(1);

        const counts = await privacyService.forgetUser({ userId: USER });
        expect(counts.webShareLinks).toBe(1);

        const after = await privacyService.auditUser({ userId: USER });
        expect(after.byTable.web_share_links).toBe(0);
        expect(after.total).toBe(0);
    });
});
