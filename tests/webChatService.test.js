/**
 * Unit tests for the web chat bridge (services/webChatService.js): turn
 * validation, the SQLite-backed pseudo-channel, event normalization, and
 * the web capabilities handed to the chat pipeline.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-webchat-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../utils/chatHandler', () => ({
    handleChatInteraction: jest.fn().mockResolvedValue(undefined)
}));

const db = require('../db');
const { handleChatInteraction } = require('../utils/chatHandler');
const webChatService = require('../services/webChatService');
const { dmScopeId } = require('../utils/dmScope');

const USER = '100000000000000001';
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
    webChatService._activeTurns.clear();
    webChatService._recentTurns.clear();
    db.run('DELETE FROM messages');
    db.run('DELETE FROM conversations');
    db.run('DELETE FROM guild_conversations');
    db.run('DELETE FROM users');
});

/** Seed a web conversation with rows the way handleChatInteraction would. */
function seedConversation(userId, texts) {
    const channelId = webChatService.channelIdFor(userId);
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
});

describe('the web pseudo-interaction', () => {
    test('carries the web capabilities and DM-scope shape', async () => {
        await webChatService.runTurn({ client, userId: USER, userName: 'rob', message: 'hello' });

        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
        const interaction = handleChatInteraction.mock.calls[0][0];
        expect(interaction.guildId).toBeNull();
        expect(interaction.guild).toBeNull();
        expect(interaction.user.id).toBe(USER);
        expect(interaction.channelId).toBe(`web:${USER}`);
        expect(interaction.maxInputLength).toBe(20000);
        expect(typeof interaction.onStreamDelta).toBe('function');
        expect(typeof interaction.sendFullResponse).toBe('function');
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

describe('SQLite-backed history and context', () => {
    test('getHistory returns rows oldest-first with roles', () => {
        seedConversation(USER, [
            ['user', 'first'],
            ['assistant', 'second'],
            ['user', 'third']
        ]);
        const history = webChatService.getHistory({ userId: USER });
        expect(history.map(m => [m.role, m.content])).toEqual([
            ['user', 'first'],
            ['assistant', 'second'],
            ['user', 'third']
        ]);
    });

    test('getHistory is empty for a user with no web conversation', () => {
        expect(webChatService.getHistory({ userId: USER })).toEqual([]);
    });

    test('the pseudo-channel serves the context window from SQLite, newest-first with .size', async () => {
        seedConversation(USER, [
            ['user', 'oldest'],
            ['assistant', 'middle'],
            ['user', 'newest']
        ]);

        let fetched;
        handleChatInteraction.mockImplementation(async (interaction) => {
            fetched = await interaction.channel.messages.fetch({ limit: 20 });
        });
        await webChatService.runTurn({ client, userId: USER, userName: 'rob', message: 'hi' });

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
