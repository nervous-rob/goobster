/**
 * Unit tests for the web chat bridge (services/webChatService.js): turn
 * validation, the conversation sidebar model, history truncation (edit &
 * resend / regenerate), stop-generation, vision attachments, the
 * SQLite-backed pseudo-channel, and event normalization.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-webchat-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../utils/chatHandler', () => ({
    handleChatInteraction: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../services/aiService', () => ({
    generateText: jest.fn().mockResolvedValue('Trains And Hobbies'),
    getThoughtfulPreset: jest.fn(() => ({ provider: 'openai', model: 'gpt-thoughtful', reasoningEffort: 'high' })),
    getDefaultModel: jest.fn(() => 'gpt-everyday')
}));

const db = require('../db');
const { handleChatInteraction } = require('../utils/chatHandler');
const aiService = require('../services/aiService');
const webChatService = require('../services/webChatService');
const { dmScopeId } = require('../utils/dmScope');

const USER = '100000000000000001';
const OTHER = '100000000000000002';
const BOT = '900000000000000001';
const client = { user: { id: BOT, username: 'Goobster' } };

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    // mockImplementation/mockRejectedValue persist across tests; restore the
    // default resolved handler so each test starts from a clean pipeline.
    handleChatInteraction.mockReset();
    handleChatInteraction.mockResolvedValue(undefined);
    webChatService._activeTurns.clear();
    webChatService._recentTurns.clear();
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
    db.run('DELETE FROM conversation_summaries');
    db.run('DELETE FROM guild_conversations');
    db.run('DELETE FROM web_conversations');
    db.run('DELETE FROM users');
});

/** Seed a conversation with message rows the way handleChatInteraction would. */
function seedConversation(userId, texts) {
    const conversation = webChatService.createConversation(userId);
    const { channelId } = db.get(
        'SELECT channelId FROM web_conversations WHERE id = @id', { id: conversation.id }
    );

    db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('rob', @id, 'rob')`, { id: userId });
    db.run(`INSERT INTO users (discordUsername, discordId, username) VALUES ('Goobster', @id, 'Goobster')`, { id: BOT });
    const human = db.get('SELECT id FROM users WHERE discordId = @id', { id: userId }).id;
    const bot = db.get('SELECT id FROM users WHERE discordId = @id', { id: BOT }).id;

    db.run(
        `INSERT INTO guild_conversations (guildId, channelId, threadId) VALUES (@g, @c, @t)`,
        { g: dmScopeId(userId), c: channelId, t: `channel-${channelId}` }
    );
    const guildConvId = db.get('SELECT id FROM guild_conversations ORDER BY id DESC LIMIT 1').id;
    db.run('INSERT INTO conversations (userId, guildConversationId) VALUES (@u, @g)', { u: human, g: guildConvId });
    const conversationId = db.get('SELECT id FROM conversations ORDER BY id DESC LIMIT 1').id;

    for (const [role, text] of texts) {
        db.run(
            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot)
             VALUES (@c, @g, @by, @m, @isBot)`,
            { c: conversationId, g: guildConvId, by: role === 'user' ? human : bot, m: text, isBot: role !== 'user' }
        );
    }
    return conversation.id;
}

describe('turn validation', () => {
    test('rejects an empty message with 400', () => {
        expect(() => webChatService.startTurn({ client, userId: USER, userName: 'rob', message: '   ' }))
            .toThrow(expect.objectContaining({ status: 400, code: 'EMPTY_MESSAGE' }));
    });

    test('accepts messages beyond the Discord cap but enforces the web cap', () => {
        expect(() => webChatService.startTurn({
            client, userId: USER, userName: 'rob', message: 'x'.repeat(20001)
        })).toThrow(expect.objectContaining({ status: 400, code: 'MESSAGE_TOO_LONG' }));

        // 5000 chars would be rejected by Discord's 2000 limit - fine here
        const turn = webChatService.startTurn({
            client, userId: USER, userName: 'rob', message: 'x'.repeat(5000)
        });
        turn.release();
    });

    test('rejects a second concurrent turn for the same user with 409', () => {
        const turn = webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'hi' });
        expect(() => webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'again' }))
            .toThrow(expect.objectContaining({ status: 409, code: 'TURN_IN_FLIGHT' }));
        turn.release();
        // Released: a new turn is allowed again
        webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'ok now' }).release();
    });

    test('rate limits after 10 turns in a minute with 429', () => {
        for (let i = 0; i < 10; i++) {
            webChatService.startTurn({ client, userId: USER, userName: 'rob', message: `m${i}` }).release();
        }
        expect(() => webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'one more' }))
            .toThrow(expect.objectContaining({ status: 429, code: 'RATE_LIMITED' }));
    });

    test('rejects turns while the bot is offline with 503', () => {
        expect(() => webChatService.startTurn({ client: {}, userId: USER, userName: 'rob', message: 'hi' }))
            .toThrow(expect.objectContaining({ status: 503, code: 'BOT_OFFLINE' }));
    });

    test('validates vision attachments: shape, count, and data-URL format', () => {
        const png = 'data:image/png;base64,iVBORw0KGgo=';
        expect(() => webChatService.startTurn({
            client, userId: USER, userName: 'rob', message: 'look', images: 'nope'
        })).toThrow(expect.objectContaining({ code: 'BAD_IMAGES' }));

        expect(() => webChatService.startTurn({
            client, userId: USER, userName: 'rob', message: 'look', images: [png, png, png, png, png]
        })).toThrow(expect.objectContaining({ code: 'BAD_IMAGES' }));

        expect(() => webChatService.startTurn({
            client, userId: USER, userName: 'rob', message: 'look', images: ['https://example.com/x.png']
        })).toThrow(expect.objectContaining({ code: 'BAD_IMAGES' }));

        const turn = webChatService.startTurn({
            client, userId: USER, userName: 'rob', message: 'look', images: [png]
        });
        turn.release();
    });
});

describe('conversations', () => {
    test('create/list: newest activity first, with message counts', () => {
        const first = seedConversation(USER, [['user', 'old message']]);
        const second = webChatService.createConversation(USER);
        db.run(`UPDATE web_conversations SET lastMessageAt = datetime('now', '+1 minute') WHERE id = @id`,
            { id: second.id });

        const list = webChatService.listConversations(USER);
        expect(list.map(c => c.id)).toEqual([second.id, first]);
        expect(list[1].messageCount).toBe(1);
        expect(list[0].messageCount).toBe(0);
    });

    test('conversations are private: another user cannot touch them', () => {
        const conversationId = seedConversation(USER, [['user', 'secret']]);
        expect(() => webChatService.renameConversation({ userId: OTHER, conversationId, title: 'mine now' }))
            .toThrow(expect.objectContaining({ status: 404, code: 'NO_SUCH_CONVERSATION' }));
        expect(() => webChatService.deleteConversation({ userId: OTHER, conversationId }))
            .toThrow(expect.objectContaining({ status: 404 }));
        expect(() => webChatService.getHistory({ userId: OTHER, conversationId }))
            .toThrow(expect.objectContaining({ status: 404 }));
    });

    test('rename trims and rejects empty titles', () => {
        const conversationId = seedConversation(USER, []);
        const renamed = webChatService.renameConversation({ userId: USER, conversationId, title: '  Pi plans  ' });
        expect(renamed.title).toBe('Pi plans');
        expect(() => webChatService.renameConversation({ userId: USER, conversationId, title: '  ' }))
            .toThrow(expect.objectContaining({ code: 'BAD_TITLE' }));
    });

    test('delete removes the conversation and every row under it', () => {
        const conversationId = seedConversation(USER, [['user', 'a'], ['assistant', 'b']]);
        const result = webChatService.deleteConversation({ userId: USER, conversationId });
        expect(result.deletedMessages).toBe(2);
        expect(db.get('SELECT COUNT(*) AS c FROM web_conversations').c).toBe(0);
        expect(db.get('SELECT COUNT(*) AS c FROM guild_conversations').c).toBe(0);
        expect(db.get('SELECT COUNT(*) AS c FROM messages').c).toBe(0);
    });

    test('a pre-conversations web chat is adopted into the sidebar once', () => {
        // Legacy layout: guild_conversations on "web:<userId>" with no sidebar row
        db.run(
            `INSERT INTO guild_conversations (guildId, channelId, threadId) VALUES (@g, @c, @t)`,
            { g: dmScopeId(USER), c: `web:${USER}`, t: `channel-web:${USER}` }
        );
        const list = webChatService.listConversations(USER);
        expect(list).toHaveLength(1);
        expect(list[0].title).toBe('Earlier conversation');
        // Idempotent
        expect(webChatService.listConversations(USER)).toHaveLength(1);
    });

    test('truncateFrom deletes the message and everything after it', () => {
        const conversationId = seedConversation(USER, [
            ['user', 'keep me'],
            ['assistant', 'keep me too'],
            ['user', 'edit me'],
            ['assistant', 'stale reply']
        ]);
        const history = webChatService.getHistory({ userId: USER, conversationId });
        const editTarget = history[2];

        const result = webChatService.truncateFrom({ userId: USER, conversationId, messageId: editTarget.id });
        expect(result.deleted).toBe(2);
        expect(webChatService.getHistory({ userId: USER, conversationId }).map(m => m.content))
            .toEqual(['keep me', 'keep me too']);

        expect(() => webChatService.truncateFrom({ userId: USER, conversationId, messageId: 999999 }))
            .toThrow(expect.objectContaining({ status: 404 }));
    });
});

describe('the web pseudo-interaction', () => {
    test('carries the web capabilities, DM-scope shape, and images', async () => {
        const png = 'data:image/png;base64,iVBORw0KGgo=';
        await webChatService.runTurn({ client, userId: USER, userName: 'rob', message: 'hello', images: [png] });

        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
        const interaction = handleChatInteraction.mock.calls[0][0];
        expect(interaction.guildId).toBeNull();
        expect(interaction.guild).toBeNull();
        expect(interaction.user.id).toBe(USER);
        expect(interaction.channelId).toMatch(new RegExp(`^web:${USER}:[0-9a-f]+$`));
        expect(interaction.maxInputLength).toBe(20000);
        expect(interaction.imageUrls).toEqual([png]);
        expect(typeof interaction.onStreamDelta).toBe('function');
        expect(typeof interaction.sendFullResponse).toBe('function');
        expect(typeof interaction.shouldAbort).toBe('function');
        expect(interaction.sourceDescription).toContain('web chat');
        expect(interaction.options.getString()).toBe('hello');
    });

    test('streams deltas and full responses to the event sink', async () => {
        const events = { onTyping: jest.fn(), onDelta: jest.fn(), onMessage: jest.fn() };
        handleChatInteraction.mockImplementation(async (interaction) => {
            await interaction.channel.sendTyping();
            interaction.onStreamDelta('Hel');
            interaction.onStreamDelta('lo');
            await interaction.sendFullResponse('Hello there!');
        });

        await webChatService.runTurn({ client, userId: USER, userName: 'rob', message: 'hi', events });

        expect(events.onTyping).toHaveBeenCalled();
        expect(events.onDelta.mock.calls.map(c => c[0]).join('')).toBe('Hello');
        expect(events.onMessage).toHaveBeenCalledWith({
            content: 'Hello there!', attachments: [], isError: false
        });
    });

    test('stopTurn flips shouldAbort mid-turn (the Stop button contract)', async () => {
        let observed;
        handleChatInteraction.mockImplementation(async (interaction) => {
            expect(interaction.shouldAbort()).toBe(false);
            webChatService.stopTurn(USER);
            observed = interaction.shouldAbort();
        });
        await webChatService.runTurn({ client, userId: USER, userName: 'rob', message: 'hi' });
        expect(observed).toBe(true);
        // No active turn afterwards
        expect(webChatService.stopTurn(USER)).toBe(false);
    });

    test('normalizes channel sends: files become owner-bound URLs, ✅ is dropped', async () => {
        const tempFile = path.join(os.tmpdir(), `goobster-webchat-file-${process.pid}.png`);
        fs.writeFileSync(tempFile, 'fake image bytes');
        const events = { onMessage: jest.fn() };

        handleChatInteraction.mockImplementation(async (interaction) => {
            await interaction.editReply('✅'); // Discord ack, not web content
            await interaction.channel.send({
                files: [{ attachment: tempFile, name: path.basename(tempFile) }]
            });
        });
        await webChatService.runTurn({ client, userId: USER, userName: 'rob', message: 'draw me', events });

        expect(events.onMessage).toHaveBeenCalledTimes(1);
        const message = events.onMessage.mock.calls[0][0];
        expect(message.attachments).toHaveLength(1);
        expect(message.attachments[0].url).toMatch(/^\/api\/app\/files\/[0-9a-f]{32}$/);

        // The registry only serves the file back to its owner
        const fileId = message.attachments[0].url.split('/').pop();
        expect(webChatService.getFile(fileId, USER)?.path).toBe(tempFile);
        expect(webChatService.getFile(fileId, '999999999999999999')).toBeNull();
        fs.unlinkSync(tempFile);
    });

    test('a dead event sink never breaks the turn', async () => {
        const events = {
            onDelta: () => { throw new Error('client went away'); },
            onMessage: () => { throw new Error('client went away'); }
        };
        handleChatInteraction.mockImplementation(async (interaction) => {
            interaction.onStreamDelta('x');
            await interaction.sendFullResponse('done');
        });
        await expect(webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'hi', events
        })).resolves.toBeUndefined();
    });

    test('releases the turn slot even when the pipeline throws', async () => {
        handleChatInteraction.mockRejectedValue(new Error('provider exploded'));
        await expect(webChatService.runTurn({ client, userId: USER, userName: 'rob', message: 'hi' }))
            .rejects.toThrow('provider exploded');
        expect(webChatService._activeTurns.has(USER)).toBe(false);
    });
});

describe('auto-titles', () => {
    test('first turn sets a fallback title immediately, then the AI title', async () => {
        const created = webChatService.createConversation(USER);
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob',
            conversationId: created.id,
            message: 'Tell me about model trains and other rainy-day hobbies please'
        });

        // Fallback title landed synchronously at turn start
        const midTitle = db.get('SELECT title FROM web_conversations WHERE id = @id', { id: created.id }).title;
        expect(midTitle).toBeTruthy();

        // The fire-and-forget AI title replaces it
        await new Promise(resolve => setImmediate(resolve));
        const finalTitle = db.get('SELECT title FROM web_conversations WHERE id = @id', { id: created.id }).title;
        expect(finalTitle).toBe('Trains And Hobbies');
        expect(aiService.generateText).toHaveBeenCalledTimes(1);
    });

    test('an explicit title is never overwritten by auto-titling', async () => {
        const created = webChatService.createConversation(USER);
        webChatService.renameConversation({ userId: USER, conversationId: created.id, title: 'My title' });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', conversationId: created.id, message: 'hello'
        });
        await new Promise(resolve => setImmediate(resolve));
        expect(db.get('SELECT title FROM web_conversations WHERE id = @id', { id: created.id }).title)
            .toBe('My title');
        expect(aiService.generateText).not.toHaveBeenCalled();
    });
});

describe('AI settings (Thoughtful Mode)', () => {
    test('toggling thoughtful pins the preset to the DM scope and back', async () => {
        const before = await webChatService.getAiSettings(USER);
        expect(before.thoughtful).toBe(false);
        expect(before.thoughtfulAvailable).toBe(true);

        const enabled = await webChatService.setThoughtful({ userId: USER, thoughtful: true });
        expect(enabled.thoughtful).toBe(true);
        expect(enabled.model).toBe('gpt-thoughtful');

        const row = db.get(
            'SELECT ai_model, ai_reasoning_effort FROM guild_settings WHERE guildId = @scope',
            { scope: dmScopeId(USER) }
        );
        expect(row.ai_model).toBe('gpt-thoughtful');
        expect(row.ai_reasoning_effort).toBe('high');

        const disabled = await webChatService.setThoughtful({ userId: USER, thoughtful: false });
        expect(disabled.thoughtful).toBe(false);
        expect(disabled.model).toBe('gpt-everyday');
    });
});

describe('SQLite-backed history and context', () => {
    test('getHistory returns rows oldest-first with roles', () => {
        const conversationId = seedConversation(USER, [
            ['user', 'first'],
            ['assistant', 'second'],
            ['user', 'third']
        ]);
        const history = webChatService.getHistory({ userId: USER, conversationId });
        expect(history.map(m => [m.role, m.content])).toEqual([
            ['user', 'first'],
            ['assistant', 'second'],
            ['user', 'third']
        ]);
    });

    test('getHistory rebuilds generated-image attachments from message metadata', () => {
        const tempFile = path.join(os.tmpdir(), `goobster-webchat-history-file-${process.pid}.png`);
        fs.writeFileSync(tempFile, 'fake image bytes');

        const conversationId = seedConversation(USER, [['user', 'draw me a goose']]);
        const guildConvId = db.get('SELECT id FROM guild_conversations ORDER BY id DESC LIMIT 1').id;
        const convRow = db.get('SELECT id FROM conversations ORDER BY id DESC LIMIT 1').id;
        const bot = db.get('SELECT id FROM users WHERE discordId = @id', { id: BOT }).id;
        db.run(
            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot, metadata)
             VALUES (@c, @g, @by, 'Here is your goose!', 1, @meta)`,
            {
                c: convRow, g: guildConvId, by: bot,
                meta: JSON.stringify({
                    attachments: [
                        { path: tempFile, name: path.basename(tempFile) },
                        { path: '/nowhere/deleted.png', name: 'deleted.png' }
                    ]
                })
            }
        );

        const history = webChatService.getHistory({ userId: USER, conversationId });
        expect(history[0].attachments).toBeUndefined(); // user rows: no attachments key

        const reply = history[1];
        expect(reply.role).toBe('assistant');
        // Files missing from disk are dropped, existing ones become URLs
        expect(reply.attachments).toHaveLength(1);
        expect(reply.attachments[0].url).toMatch(/^\/api\/app\/files\/[0-9a-f]{32}$/);
        expect(reply.attachments[0].name).toBe(path.basename(tempFile));

        // The URL serves the file back to its owner only
        const fileId = reply.attachments[0].url.split('/').pop();
        expect(webChatService.getFile(fileId, USER)?.path).toBe(tempFile);
        expect(webChatService.getFile(fileId, OTHER)).toBeNull();

        // Repeated history loads reuse the registration (stable URL,
        // no registry growth)
        const again = webChatService.getHistory({ userId: USER, conversationId });
        expect(again[1].attachments[0].url).toBe(reply.attachments[0].url);

        fs.unlinkSync(tempFile);
    });

    test('the pseudo-channel serves the context window from SQLite, newest-first with .size', async () => {
        const conversationId = seedConversation(USER, [
            ['user', 'oldest'],
            ['assistant', 'middle'],
            ['user', 'newest']
        ]);

        let fetched;
        handleChatInteraction.mockImplementation(async (interaction) => {
            fetched = await interaction.channel.messages.fetch({ limit: 20 });
        });
        await webChatService.runTurn({ client, userId: USER, userName: 'rob', message: 'hi', conversationId });

        expect(fetched.size).toBe(3);
        expect(fetched[0].content).toBe('newest');
        expect(fetched[2].content).toBe('oldest');
        // Bot rows are attributed to the bot account, human rows to the user
        expect(fetched[1].author.id).toBe(BOT);
        expect(fetched[0].author.id).toBe(USER);
        // chatContext calls .reverse() on the result - the same (mutated)
        // object must keep its .size
        const reversed = fetched.reverse();
        expect(reversed.size).toBe(3);
        expect(reversed[0].content).toBe('oldest');
    });
});
