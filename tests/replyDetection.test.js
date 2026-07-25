/**
 * Unit tests for reply detection (utils/replyDetection.js) and its wiring into
 * events/messageCreate.js: a message that follows one of Goobster's own is run
 * through an intent check, so a casual answer that forgets the @mention still
 * reaches him - and unrelated channel chatter still doesn't.
 */

jest.mock('../services/aiService', () => ({
    generateText: jest.fn().mockResolvedValue('unrelated')
}));
jest.mock('../utils/chatHandler', () => ({
    handleChatInteraction: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../utils/intentDetectionHandler', () => ({
    shouldRespond: jest.fn().mockReturnValue({ shouldRespond: false, confidence: 0 }),
    updateContext: jest.fn()
}));
jest.mock('../utils/guildSettings', () => ({
    getDynamicResponse: jest.fn().mockResolvedValue('DISABLED'),
    getReplyDetection: jest.fn().mockResolvedValue('ENABLED'),
    DYNAMIC_RESPONSE: { ENABLED: 'ENABLED', DISABLED: 'DISABLED' },
    REPLY_DETECTION: { ENABLED: 'ENABLED', DISABLED: 'DISABLED' }
}));
jest.mock('../utils/guildContext', () => ({
    getBotPreferredName: jest.fn().mockResolvedValue('Goobster')
}));
jest.mock('../services/activityService', () => ({
    recordMessage: jest.fn()
}));

const aiService = require('../services/aiService');
const { handleChatInteraction } = require('../utils/chatHandler');
const guildSettings = require('../utils/guildSettings');
const replyDetection = require('../utils/replyDetection');
const messageCreate = require('../events/messageCreate');

const BOT_ID = '900000000000000001';
const USER_ID = '100000000000000001';
const OTHER_USER_ID = '100000000000000002';
const GUILD_ID = '200000000000000001';
const CHANNEL_ID = '300000000000000001';

let nextMessageId = 1;

/**
 * Build a message stand-in shaped like the parts of discord.js the handler and
 * the detector actually touch.
 */
function makeMessage({
    content = 'hello',
    authorId = USER_ID,
    bot = false,
    mentionedUserIds = [],
    roleMentions = 0,
    mentionsEveryone = false,
    reference = null,
    createdTimestamp = Date.now(),
    channelId = CHANNEL_ID,
    attachments = [],
    embeds = [],
    fetchPrevious = null,
    fetchReferenced = null
} = {}) {
    const mentioned = new Set(mentionedUserIds);

    return {
        id: `msg-${nextMessageId++}`,
        content,
        createdTimestamp,
        partial: false,
        author: { id: authorId, bot, username: bot ? 'Goobster' : 'rob' },
        member: { displayName: bot ? 'Goobster' : 'Rob' },
        attachments: new Map(attachments.map((a, i) => [String(i), a])),
        embeds,
        reference,
        mentions: {
            everyone: mentionsEveryone,
            users: {
                has: id => mentioned.has(id),
                some: fn => [...mentioned].some(id => fn({ id }, id))
            },
            roles: { size: roleMentions, some: () => false }
        },
        guild: {
            id: GUILD_ID,
            members: {
                me: {},
                cache: { get: () => ({ roles: { cache: { has: () => false } } }) }
            }
        },
        channel: {
            id: channelId,
            name: 'general',
            sendTyping: jest.fn().mockResolvedValue(undefined),
            messages: {
                fetch: jest.fn(options => {
                    if (typeof options === 'string') {
                        return fetchReferenced
                            ? Promise.resolve(fetchReferenced)
                            : Promise.reject(new Error('unknown message'));
                    }
                    const collection = [fetchPrevious].filter(Boolean);
                    return Promise.resolve({ first: () => collection[0] ?? null });
                })
            }
        },
        client: { user: { id: BOT_ID, username: 'Goobster' } },
        reply: jest.fn().mockResolvedValue(undefined)
    };
}

/** A message authored by Goobster himself. */
function makeBotMessage(content, overrides = {}) {
    return makeMessage({ content, authorId: BOT_ID, bot: true, ...overrides });
}

beforeEach(() => {
    jest.clearAllMocks();
    replyDetection.clearAll();
    aiService.generateText.mockResolvedValue('unrelated');
    guildSettings.getReplyDetection.mockResolvedValue('ENABLED');
    guildSettings.getDynamicResponse.mockResolvedValue('DISABLED');
});

describe('replyDetection channel history', () => {
    test('remembers the previous message in a channel, excluding the current one', async () => {
        const botMessage = makeBotMessage('I went with the second option.');
        replyDetection.recordMessage(botMessage);

        const userMessage = makeMessage({ content: 'why that one?' });
        replyDetection.recordMessage(userMessage);

        const previous = await replyDetection.getPreviousMessage(userMessage);
        expect(previous.id).toBe(botMessage.id);
        expect(previous.isGoobster).toBe(true);
    });

    test('keeps only the tail of a channel', () => {
        for (let i = 0; i < replyDetection.HISTORY_LIMIT + 4; i++) {
            replyDetection.recordMessage(makeMessage({ content: `message ${i}` }));
        }

        expect(replyDetection.getHistory(CHANNEL_ID)).toHaveLength(replyDetection.HISTORY_LIMIT);
    });

    test('falls back to Discord when the channel has no remembered tail', async () => {
        const botMessage = makeBotMessage('anyone still around?');
        const userMessage = makeMessage({ content: 'yeah I am', fetchPrevious: botMessage });

        const previous = await replyDetection.getPreviousMessage(userMessage);

        expect(userMessage.channel.messages.fetch).toHaveBeenCalledWith({ limit: 1, before: userMessage.id });
        expect(previous.isGoobster).toBe(true);
        // The fetched message is remembered, so the next lookup is free
        expect(replyDetection.getHistory(CHANNEL_ID)).toHaveLength(1);
    });
});

describe('replyDetection.shouldRespond', () => {
    test('stays quiet when the previous message was not Goobster\'s', async () => {
        replyDetection.recordMessage(makeMessage({ content: 'anyone up for a game?', authorId: OTHER_USER_ID }));
        const message = makeMessage({ content: 'sure, in five' });
        replyDetection.recordMessage(message);

        const verdict = await replyDetection.shouldRespond(message);

        expect(verdict.respond).toBe(false);
        expect(aiService.generateText).not.toHaveBeenCalled();
    });

    test('answers when the intent check reads the message as a reply', async () => {
        aiService.generateText.mockResolvedValue('reply');
        replyDetection.recordMessage(makeBotMessage('I\'d go with the blue one.'));
        const message = makeMessage({ content: 'why not the red one?' });
        replyDetection.recordMessage(message);

        const verdict = await replyDetection.shouldRespond(message);

        expect(verdict.respond).toBe(true);
        const prompt = aiService.generateText.mock.calls[0][0];
        expect(prompt).toContain('I\'d go with the blue one.');
        expect(prompt).toContain('why not the red one?');
    });

    test('stays quiet when the intent check reads it as unrelated chatter', async () => {
        aiService.generateText.mockResolvedValue('unrelated');
        replyDetection.recordMessage(makeBotMessage('I\'d go with the blue one.'));
        const message = makeMessage({ content: 'brb, dinner' });
        replyDetection.recordMessage(message);

        expect((await replyDetection.shouldRespond(message)).respond).toBe(false);
    });

    test('an old message of his still counts - the intent decides, not the clock', async () => {
        aiService.generateText.mockResolvedValue('reply');
        const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
        replyDetection.recordMessage(makeBotMessage('Ping me when you want that summary.', { createdTimestamp: twoDaysAgo }));
        const message = makeMessage({ content: 'ok I want that summary now' });
        replyDetection.recordMessage(message);

        const verdict = await replyDetection.shouldRespond(message);

        expect(verdict.respond).toBe(true);
        expect(aiService.generateText.mock.calls[0][0]).toContain('2 days');
    });

    test('hands the classifier the earlier conversation for context', async () => {
        aiService.generateText.mockResolvedValue('reply');
        replyDetection.recordMessage(makeMessage({ content: 'what should we name the cat?', authorId: OTHER_USER_ID }));
        replyDetection.recordMessage(makeBotMessage('Biscuit has a nice ring to it.'));
        const message = makeMessage({ content: 'biscuit it is' });
        replyDetection.recordMessage(message);

        await replyDetection.shouldRespond(message);

        expect(aiService.generateText.mock.calls[0][0]).toContain('what should we name the cat?');
    });

    test.each([
        ['a mention of someone else', { content: 'nice one', mentionedUserIds: [OTHER_USER_ID] }],
        ['an @everyone ping', { content: 'raid in 5', mentionsEveryone: true }],
        ['a role mention', { content: 'over to you', roleMentions: 1 }],
        ['another bot\'s command', { content: '!skip' }],
        ['a reply aimed at a human', { content: 'agreed', reference: { messageId: 'msg-other' } }]
    ])('skips the intent check for %s', async (_label, overrides) => {
        replyDetection.recordMessage(makeBotMessage('Here you go.'));
        const message = makeMessage(overrides);
        replyDetection.recordMessage(message);

        const verdict = await replyDetection.shouldRespond(message);

        expect(verdict.respond).toBe(false);
        expect(aiService.generateText).not.toHaveBeenCalled();
    });

    test('falls back to recency when the classifier is unavailable', async () => {
        aiService.generateText.mockRejectedValue(new Error('no AI provider configured'));

        replyDetection.recordMessage(makeBotMessage('Want me to keep going?'));
        const prompt = makeMessage({ content: 'yeah go on' });
        replyDetection.recordMessage(prompt);
        expect((await replyDetection.shouldRespond(prompt)).respond).toBe(true);

        replyDetection.clearAll();
        const hourAgo = Date.now() - 60 * 60 * 1000;
        replyDetection.recordMessage(makeBotMessage('Want me to keep going?', { createdTimestamp: hourAgo }));
        const stale = makeMessage({ content: 'yeah go on' });
        replyDetection.recordMessage(stale);
        expect((await replyDetection.shouldRespond(stale)).respond).toBe(false);
    });
});

describe('messageCreate reply handling', () => {
    test('answers a mention-free reply to Goobster\'s last message', async () => {
        aiService.generateText.mockResolvedValue('reply');
        await messageCreate.execute(makeBotMessage('I\'d start with the smaller one.'));

        const message = makeMessage({ content: 'how come?' });
        await messageCreate.execute(message);

        expect(message.channel.sendTyping).toHaveBeenCalled();
        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
        expect(handleChatInteraction.mock.calls[0][0].content).toBe('how come?');
    });

    test('stays quiet when the intent check says the message is unrelated', async () => {
        aiService.generateText.mockResolvedValue('unrelated');
        await messageCreate.execute(makeBotMessage('I\'d start with the smaller one.'));

        await messageCreate.execute(makeMessage({ content: 'anyone seen the new trailer?' }));

        expect(handleChatInteraction).not.toHaveBeenCalled();
    });

    test('stays quiet when a server disables reply detection', async () => {
        aiService.generateText.mockResolvedValue('reply');
        guildSettings.getReplyDetection.mockResolvedValue('DISABLED');

        await messageCreate.execute(makeBotMessage('I\'d start with the smaller one.'));
        await messageCreate.execute(makeMessage({ content: 'how come?' }));

        expect(handleChatInteraction).not.toHaveBeenCalled();
        expect(aiService.generateText).not.toHaveBeenCalled();
    });

    test('a Discord reply to Goobster is an explicit address - no intent check needed', async () => {
        const botMessage = makeBotMessage('Here\'s the summary.');
        await messageCreate.execute(botMessage);

        const message = makeMessage({
            content: 'can you shorten it?',
            reference: { messageId: botMessage.id },
            fetchReferenced: botMessage
        });
        await messageCreate.execute(message);

        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
        expect(handleChatInteraction.mock.calls[0][0].content).toBe('can you shorten it?');
        expect(aiService.generateText).not.toHaveBeenCalled();
    });

    test('a reply to another member is left alone', async () => {
        const humanMessage = makeMessage({ content: 'I liked the second one', authorId: OTHER_USER_ID });
        await messageCreate.execute(humanMessage);

        const message = makeMessage({
            content: 'same here',
            reference: { messageId: humanMessage.id },
            fetchReferenced: humanMessage
        });
        await messageCreate.execute(message);

        expect(handleChatInteraction).not.toHaveBeenCalled();
    });
});
