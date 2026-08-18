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
// Isolate upload storage too - the test user ids look like real snowflakes,
// and cleanup must never touch the repo's data directory.
const TEST_UPLOADS = path.join(os.tmpdir(), `goobster-webchat-test-uploads-${process.pid}`);
process.env.GOOBSTER_UPLOADS_DIR = TEST_UPLOADS;

jest.mock('@goobster/core/utils/chatHandler', () => ({
    handleChatInteraction: jest.fn().mockResolvedValue(undefined)
}));
// pdfjs sets up its worker via dynamic import(), which Jest's VM forbids
// (--experimental-vm-modules). The fake honors the same contract: getText()
// returns the text inside the PDF's Tj operator, throws on non-PDF bytes.
jest.mock('pdf-parse', () => ({
    PDFParse: class {
        constructor({ data }) { this.data = data; }
        async getText() {
            const raw = this.data.toString('latin1');
            if (!raw.startsWith('%PDF')) throw new Error('Invalid PDF structure.');
            const match = /\((.*?)\)\s*Tj/.exec(raw);
            return { text: match ? match[1] : '' };
        }
        async destroy() {}
    }
}));
jest.mock('@goobster/core/services/aiService', () => ({
    generateText: jest.fn().mockResolvedValue('Trains And Hobbies'),
    getThoughtfulPreset: jest.fn(() => ({ provider: 'openai', model: 'gpt-thoughtful', reasoningEffort: 'high' })),
    getDefaultModel: jest.fn(() => 'gpt-everyday'),
    getProvider: jest.fn(() => 'openai'),
    listProviders: jest.fn(() => ([
        { key: 'openai', name: 'OpenAI', configured: true, isDefault: true, chatModel: 'gpt-everyday', thoughtfulModel: 'gpt-thoughtful', reasoningEffort: true },
        { key: 'ollama', name: 'Ollama (local)', configured: true, isDefault: false, chatModel: 'llama-local', thoughtfulModel: null, reasoningEffort: false }
    ]))
}));

const db = require('@goobster/core/db');
const { handleChatInteraction } = require('@goobster/core/utils/chatHandler');
const aiService = require('@goobster/core/services/aiService');
const webChatService = require('@goobster/core/services/webChatService');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const USER = '100000000000000001';
const OTHER = '100000000000000002';
const BOT = '900000000000000001';
const client = { user: { id: BOT, username: 'Goobster' } };

afterAll(async () => {
    fs.rmSync(TEST_UPLOADS, { recursive: true, force: true });
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

    db.run(`INSERT OR IGNORE INTO users (discordUsername, discordId, username) VALUES ('rob', @id, 'rob')`, { id: userId });
    db.run(`INSERT OR IGNORE INTO users (discordUsername, discordId, username) VALUES ('Goobster', @id, 'Goobster')`, { id: BOT });
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

    test('the 409 tells the user how long the reply has been generating and where', () => {
        const turn = webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'hi' });
        // Make it read as an established long-runner, not a race
        webChatService._activeTurns.get(USER).startedAt = Date.now() - 92 * 1000;

        let caught;
        try {
            webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'again' });
        } catch (error) {
            caught = error;
        }
        expect(caught).toMatchObject({ status: 409, code: 'TURN_IN_FLIGHT' });
        expect(caught.message).toMatch(/1m 3\ds ago/); // ~92s, slow-CI tolerant
        expect(caught.message).toMatch(/still being generated/);
        // Machine-readable details for the client's stop affordance
        expect(caught.details.elapsedMs).toBeGreaterThanOrEqual(92 * 1000);
        expect(caught.details.conversationId).toBe(turn.conversationId);
        turn.release();
    });

    test('turnStatus reports the in-flight turn (and clears once released)', () => {
        expect(webChatService.turnStatus(USER)).toEqual({ inFlight: false });

        const turn = webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'hi' });
        const status = webChatService.turnStatus(USER);
        expect(status.inFlight).toBe(true);
        expect(status.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(status.conversationId).toBe(turn.conversationId);

        turn.release();
        expect(webChatService.turnStatus(USER)).toEqual({ inFlight: false });
    });

    test('turnStatus itself evicts a wedged turn past the watchdog TTL', () => {
        webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'hi' });
        const staleState = webChatService._activeTurns.get(USER);
        staleState.startedAt = Date.now() - 16 * 60 * 1000;

        expect(webChatService.turnStatus(USER)).toEqual({ inFlight: false });
        expect(staleState.aborted).toBe(true);
    });

    test('a wedged turn past the watchdog TTL is force-aborted and its lock released', () => {
        const stale = webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'hi' });
        const staleState = webChatService._activeTurns.get(USER);
        // Simulate a provider stream that stalled 16 minutes ago and never settled
        staleState.startedAt = Date.now() - 16 * 60 * 1000;

        // The next message takes over instead of 409ing until the next restart
        const next = webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'hello?' });
        expect(staleState.aborted).toBe(true);
        expect(staleState.signal.aborted).toBe(true); // the hung request was hard-cancelled

        // The stale turn settling late must not free the successor's lock
        stale.release();
        expect(() => webChatService.startTurn({ client, userId: USER, userName: 'rob', message: 'third' }))
            .toThrow(expect.objectContaining({ status: 409, code: 'TURN_IN_FLIGHT' }));
        next.release();
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

    test('stopTurn also fires the abort signal (hard-cancels the provider stream)', async () => {
        let signal;
        handleChatInteraction.mockImplementation(async (interaction) => {
            signal = interaction.abortSignal;
            expect(signal.aborted).toBe(false);
            webChatService.stopTurn(USER);
        });
        await webChatService.runTurn({ client, userId: USER, userName: 'rob', message: 'hi' });
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(true);
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
        // The override is cleared; the effective model falls back to the
        // provider's everyday default.
        expect(disabled.model).toBe(null);
        expect(disabled.effective.model).toBe('gpt-everyday');
    });

    test('setAiSettings validates and persists granular overrides', async () => {
        await expect(webChatService.setAiSettings({ userId: USER, provider: 'nonsense' }))
            .rejects.toMatchObject({ code: 'BAD_PROVIDER' });
        await expect(webChatService.setAiSettings({ userId: USER, reasoningEffort: 'extreme' }))
            .rejects.toMatchObject({ code: 'BAD_REASONING' });
        await expect(webChatService.setAiSettings({ userId: USER }))
            .rejects.toMatchObject({ code: 'NO_CHANGES' });

        const updated = await webChatService.setAiSettings({
            userId: USER, provider: 'ollama', model: 'llama-custom', reasoningEffort: 'low'
        });
        expect(updated.provider).toBe('ollama');
        expect(updated.model).toBe('llama-custom');
        expect(updated.reasoningEffort).toBe('low');
        expect(updated.effective.provider).toBe('ollama');
        expect(updated.effective.model).toBe('llama-custom');

        const cleared = await webChatService.setAiSettings({
            userId: USER, provider: null, model: null, reasoningEffort: null
        });
        expect(cleared.provider).toBe(null);
        expect(cleared.model).toBe(null);
        expect(cleared.reasoningEffort).toBe(null);
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

describe('text file attachments', () => {
    test('rejects malformed and oversized files', () => {
        const bad = (files) => () => webChatService.startTurn({
            client, userId: USER, userName: 'rob', message: 'hi', files
        });
        expect(bad('nope')).toThrow(expect.objectContaining({ code: 'BAD_FILES' }));
        expect(bad([{ name: 'x.txt', content: 42 }])).toThrow(expect.objectContaining({ code: 'BAD_FILES' }));
        expect(bad([{ name: 'big.txt', content: 'x'.repeat(50001) }]))
            .toThrow(expect.objectContaining({ code: 'BAD_FILES' }));
        expect(bad(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, content: 'ok' }))))
            .toThrow(expect.objectContaining({ code: 'BAD_FILES' }));
        // 3 files x 50k chars = 150k > the 120k combined cap
        expect(bad(Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.txt`, content: 'x'.repeat(50000) }))))
            .toThrow(expect.objectContaining({ code: 'BAD_FILES' }));
    });

    test('folds attachments into the pipeline message with parseable markers', async () => {
        const conversation = webChatService.createConversation(USER);
        let seen;
        handleChatInteraction.mockImplementation(async (interaction) => {
            seen = interaction.options.getString('message');
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'summarize this',
            conversationId: conversation.id,
            files: [{ name: 'notes.md', content: '# Heading\nBody text' }]
        });
        expect(seen).toContain('summarize this');
        expect(seen).toContain('[Attached file: notes.md]');
        expect(seen).toContain('# Heading\nBody text');
    });

    test('sanitizes hostile filenames', async () => {
        const conversation = webChatService.createConversation(USER);
        let seen;
        handleChatInteraction.mockImplementation(async (interaction) => {
            seen = interaction.options.getString('message');
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'read it',
            conversationId: conversation.id,
            files: [{ name: '../../etc/passwd\u0000<x>', content: 'harmless' }]
        });
        expect(seen).not.toContain('../');
        expect(seen).not.toContain('\u0000');
        expect(seen).toContain('[Attached file: ');
    });
});

describe('incognito mode', () => {
    afterEach(() => {
        webChatService.clearIncognito(USER);
    });

    test('an incognito turn writes nothing to SQLite and sets skipHistory', async () => {
        let interactionSeen;
        handleChatInteraction.mockImplementation(async (interaction) => {
            interactionSeen = interaction;
            await interaction.sendFullResponse('secret reply');
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'secret question', incognito: true
        });

        expect(interactionSeen.skipHistory).toBe(true);
        expect(interactionSeen.sourceDescription).toContain('INCOGNITO MODE');
        // Nothing persisted anywhere
        expect(db.get('SELECT COUNT(*) AS c FROM messages').c).toBe(0);
        expect(db.get('SELECT COUNT(*) AS c FROM web_conversations').c).toBe(0);
        expect(db.get('SELECT COUNT(*) AS c FROM guild_conversations').c).toBe(0);
    });

    test('the in-memory window serves context to the next incognito turn', async () => {
        handleChatInteraction.mockImplementation(async (interaction) => {
            await interaction.sendFullResponse('the answer is 42');
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'first question', incognito: true
        });

        let fetched;
        handleChatInteraction.mockImplementation(async (interaction) => {
            fetched = await interaction.channel.messages.fetch({ limit: 20 });
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'follow-up', incognito: true
        });

        expect(fetched.size).toBe(2);
        // Newest-first: the bot reply, then the first question
        expect(fetched[0].content).toBe('the answer is 42');
        expect(fetched[0].author.id).toBe(BOT);
        expect(fetched[1].content).toBe('first question');
        expect(fetched[1].author.id).toBe(USER);
    });

    test('clearIncognito drops the window', async () => {
        handleChatInteraction.mockImplementation(async (interaction) => {
            await interaction.sendFullResponse('reply');
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'hello there', incognito: true
        });
        expect(webChatService.clearIncognito(USER)).toEqual({ cleared: true });
        expect(webChatService.clearIncognito(USER)).toEqual({ cleared: false });

        let fetched;
        handleChatInteraction.mockImplementation(async (interaction) => {
            fetched = await interaction.channel.messages.fetch({ limit: 20 });
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'fresh start', incognito: true
        });
        expect(fetched.size).toBe(0);
    });

    test('incognito windows expire after the TTL', async () => {
        handleChatInteraction.mockImplementation(async (interaction) => {
            await interaction.sendFullResponse('reply');
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'hello', incognito: true
        });
        // Backdate the window past the 2h TTL
        webChatService._incognito.get(USER).updatedAt = Date.now() - (3 * 60 * 60 * 1000);
        expect(webChatService._incognitoEntry(USER)).toBeNull();
        expect(webChatService._incognito.has(USER)).toBe(false);
    });
});

describe('full-text message search', () => {
    test('finds message content across conversations, scoped to the user', () => {
        const firstConv = seedConversation(USER, [
            ['user', 'tell me about the fjords of Norway'],
            ['assistant', 'The fjords are long, narrow inlets carved by glaciers.']
        ]);
        seedConversation(OTHER, [['user', 'fjords are my secret too']]);

        const results = webChatService.searchMessages({ userId: USER, query: 'fjords' });
        expect(results).toHaveLength(2);
        // Newest first
        expect(results[0].role).toBe('assistant');
        expect(results[0].snippet).toContain('carved by glaciers');
        expect(results[1].role).toBe('user');
        expect(results.every(r => r.conversationId === firstConv)).toBe(true);
        expect(results.every(r => typeof r.messageId === 'number')).toBe(true);
        // The other user's data never leaks in
        expect(results.some(r => r.snippet.includes('secret'))).toBe(false);
    });

    test('short queries return nothing and LIKE wildcards stay literal', () => {
        seedConversation(USER, [['user', 'the discount is 100% real']]);
        expect(webChatService.searchMessages({ userId: USER, query: 'a' })).toEqual([]);
        // "%" must match a literal percent sign, not act as a wildcard
        expect(webChatService.searchMessages({ userId: USER, query: '100%' })).toHaveLength(1);
        expect(webChatService.searchMessages({ userId: USER, query: '1%l' })).toEqual([]);
    });

    test('long matches come back as a bounded snippet centered on the hit', () => {
        const message = `${'a'.repeat(300)} NEEDLE ${'b'.repeat(300)}`;
        const conversationId = seedConversation(USER, [['user', message]]);
        const [hit] = webChatService.searchMessages({ userId: USER, query: 'needle' });
        expect(hit.conversationId).toBe(conversationId);
        expect(hit.snippet).toContain('NEEDLE');
        expect(hit.snippet.length).toBeLessThan(160);
        expect(hit.snippet.startsWith('…')).toBe(true);
        expect(hit.snippet.endsWith('…')).toBe(true);
    });
});

describe('PDF attachments', () => {
    // A handcrafted single-page PDF containing "Hello Goobster PDF"
    const MINI_PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 24 Tf 72 700 Td (Hello Goobster PDF) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>`);

    test('extractDocumentFiles converts a PDF into a text entry', async () => {
        const files = await webChatService.extractDocumentFiles([
            { name: 'brief.pdf', contentBase64: MINI_PDF.toString('base64') },
            { name: 'notes.txt', content: 'plain text rides along untouched' }
        ]);
        expect(files).toHaveLength(2);
        expect(files[0].name).toBe('brief.pdf');
        expect(files[0].content).toContain('Hello Goobster PDF');
        expect(files[0].contentBase64).toBeUndefined();
        expect(files[1]).toEqual({ name: 'notes.txt', content: 'plain text rides along untouched' });
    });

    test('the extracted text then flows through the normal attachment path', async () => {
        const conversation = webChatService.createConversation(USER);
        let seen;
        handleChatInteraction.mockImplementation(async (interaction) => {
            seen = interaction.options.getString('message');
        });
        const files = await webChatService.extractDocumentFiles([
            { name: 'brief.pdf', contentBase64: MINI_PDF.toString('base64') }
        ]);
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'summarize the brief',
            conversationId: conversation.id, files
        });
        expect(seen).toContain('[Attached file: brief.pdf]');
        expect(seen).toContain('Hello Goobster PDF');
    });

    test('rejects unreadable and oversized PDFs with BAD_FILES', async () => {
        await expect(webChatService.extractDocumentFiles([
            { name: 'junk.pdf', contentBase64: Buffer.from('not a pdf at all').toString('base64') }
        ])).rejects.toMatchObject({ status: 400, code: 'BAD_FILES' });

        await expect(webChatService.extractDocumentFiles([
            { name: 'huge.pdf', contentBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }
        ])).rejects.toMatchObject({ status: 400, code: 'BAD_FILES' });

        // null passes straight through (no files attached)
        expect(await webChatService.extractDocumentFiles(null)).toBeNull();
    });
});

describe('uploaded image persistence', () => {
    const { deleteUserUploads, userUploadDir } = require('@goobster/core/utils/webUploads');
    // 1x1 transparent PNG
    const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    afterEach(() => {
        deleteUserUploads(USER);
    });

    test('a turn with images saves them to disk and passes userAttachments to the pipeline', async () => {
        const conversation = webChatService.createConversation(USER);
        let interactionSeen;
        handleChatInteraction.mockImplementation(async (interaction) => {
            interactionSeen = interaction;
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'what is this?',
            conversationId: conversation.id, images: [PNG_DATA_URL]
        });

        expect(interactionSeen.userAttachments).toHaveLength(1);
        const saved = interactionSeen.userAttachments[0];
        expect(saved.name).toMatch(/^upload-[0-9a-f]{24}\.png$/);
        expect(saved.path.startsWith(userUploadDir(USER))).toBe(true);
        expect(fs.existsSync(saved.path)).toBe(true);
        // The model still receives the data URL for vision
        expect(interactionSeen.imageUrls).toEqual([PNG_DATA_URL]);
    });

    test('re-sending the same image reuses the content-hashed file', async () => {
        const conversation = webChatService.createConversation(USER);
        const paths = [];
        handleChatInteraction.mockImplementation(async (interaction) => {
            paths.push(interaction.userAttachments[0].path);
        });
        for (const message of ['first look', 'second look']) {
            await webChatService.runTurn({
                client, userId: USER, userName: 'rob', message,
                conversationId: conversation.id, images: [PNG_DATA_URL]
            });
        }
        expect(paths[0]).toBe(paths[1]);
        expect(fs.readdirSync(userUploadDir(USER))).toHaveLength(1);
    });

    test('incognito turns never write uploads to disk', async () => {
        let interactionSeen;
        handleChatInteraction.mockImplementation(async (interaction) => {
            interactionSeen = interaction;
        });
        await webChatService.runTurn({
            client, userId: USER, userName: 'rob', message: 'secret image',
            images: [PNG_DATA_URL], incognito: true
        });
        expect(interactionSeen.userAttachments).toBeNull();
        expect(fs.existsSync(userUploadDir(USER))).toBe(false);
        webChatService.clearIncognito(USER);
    });
});

describe('custom instructions', () => {
    afterEach(() => {
        db.run('DELETE FROM UserPreferences');
    });

    test('setAiSettings stores, surfaces, and clears custom instructions', async () => {
        const updated = await webChatService.setAiSettings({
            userId: USER, customInstructions: 'Always answer in haiku.'
        });
        expect(updated.customInstructions).toBe('Always answer in haiku.');
        expect((await webChatService.getAiSettings(USER)).customInstructions).toBe('Always answer in haiku.');

        const cleared = await webChatService.setAiSettings({ userId: USER, customInstructions: null });
        expect(cleared.customInstructions).toBe(null);
    });

    test('rejects instructions beyond the length cap', async () => {
        await expect(webChatService.setAiSettings({
            userId: USER, customInstructions: 'x'.repeat(2001)
        })).rejects.toMatchObject({ status: 400, code: 'INSTRUCTIONS_TOO_LONG' });
    });

    test('the prompt block builder wraps the stored text', () => {
        const { setUserInstructions, buildInstructionsBlock } = require('@goobster/core/utils/userInstructions');
        expect(buildInstructionsBlock(USER)).toBeNull();
        setUserInstructions(USER, '  Be concise.  ');
        const block = buildInstructionsBlock(USER);
        expect(block).toContain('USER CUSTOM INSTRUCTIONS');
        expect(block).toContain('Be concise.');
        setUserInstructions(USER, null);
        expect(buildInstructionsBlock(USER)).toBeNull();
    });
});
