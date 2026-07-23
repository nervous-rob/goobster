/**
 * Unit tests for one-on-one DM chat support: the DM conversation scope
 * helpers (utils/dmScope.js) and the messageCreate DM branch (DMs are no
 * longer dropped, every DM message is an implicit prompt).
 */

jest.mock('../utils/chatHandler', () => ({
    handleChatInteraction: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../utils/intentDetectionHandler', () => ({
    shouldRespond: jest.fn().mockReturnValue({ shouldRespond: false, confidence: 0 }),
    updateContext: jest.fn()
}));
jest.mock('../utils/guildSettings', () => ({
    getDynamicResponse: jest.fn().mockResolvedValue('DISABLED'),
    DYNAMIC_RESPONSE: { ENABLED: 'ENABLED', DISABLED: 'DISABLED' }
}));
jest.mock('../utils/guildContext', () => ({
    getBotPreferredName: jest.fn().mockResolvedValue('Goobster')
}));
jest.mock('../services/activityService', () => ({
    recordMessage: jest.fn()
}));

const { dmScopeId, isDmScopeId, getConversationScopeId } = require('../utils/dmScope');
const { handleChatInteraction } = require('../utils/chatHandler');
const activityService = require('../services/activityService');
const messageCreate = require('../events/messageCreate');

const BOT_ID = '900000000000000001';
const USER_ID = '100000000000000001';

function makeDmMessage(content) {
    return {
        author: { bot: false, id: USER_ID, username: 'rob' },
        partial: false,
        guild: null,
        member: null,
        content,
        reference: null,
        attachments: new Map(),
        mentions: { users: { has: () => false }, roles: { some: () => false } },
        channel: { id: 'dm-channel-1', partial: false, sendTyping: jest.fn().mockResolvedValue(undefined) },
        client: { user: { id: BOT_ID, username: 'Goobster' } },
        reply: jest.fn().mockResolvedValue(undefined)
    };
}

describe('dmScope helpers', () => {
    test('dmScopeId builds a per-user scope and isDmScopeId recognizes it', () => {
        expect(dmScopeId(USER_ID)).toBe(`dm:${USER_ID}`);
        expect(isDmScopeId(dmScopeId(USER_ID))).toBe(true);
        expect(isDmScopeId('200000000000000001')).toBe(false);
        expect(isDmScopeId(null)).toBe(false);
    });

    test('dmScopeId requires a user id', () => {
        expect(() => dmScopeId(null)).toThrow();
    });

    test('getConversationScopeId prefers the guild, falls back to DM scope', () => {
        expect(getConversationScopeId({ guildId: 'g1', user: { id: USER_ID } })).toBe('g1');
        expect(getConversationScopeId({ guildId: null, user: { id: USER_ID } })).toBe(`dm:${USER_ID}`);
    });
});

describe('messageCreate DM handling', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('a DM message is handled as an implicit chat prompt', async () => {
        const message = makeDmMessage('hello there');
        await messageCreate.execute(message);

        expect(message.channel.sendTyping).toHaveBeenCalled();
        expect(handleChatInteraction).toHaveBeenCalledTimes(1);

        const pseudo = handleChatInteraction.mock.calls[0][0];
        expect(pseudo.guild).toBeNull();
        expect(pseudo.guildId).toBeUndefined();
        expect(pseudo.content).toBe('hello there');
        expect(pseudo.user.id).toBe(USER_ID);
        expect(pseudo.channelId).toBe('dm-channel-1');
    });

    test('an explicit bot mention in a DM is stripped from the prompt', async () => {
        const message = makeDmMessage(`<@${BOT_ID}> what time is it`);
        await messageCreate.execute(message);

        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
        expect(handleChatInteraction.mock.calls[0][0].content).toBe('what time is it');
    });

    test('an empty DM gets a hint instead of a chat round-trip', async () => {
        const message = makeDmMessage('   ');
        await messageCreate.execute(message);

        expect(handleChatInteraction).not.toHaveBeenCalled();
        expect(message.reply).toHaveBeenCalledTimes(1);
    });

    test('DM messages are not activity-tracked (counts are a guild feature)', async () => {
        await messageCreate.execute(makeDmMessage('hello'));
        expect(activityService.recordMessage).not.toHaveBeenCalled();
    });

    test('bot-authored DMs are ignored', async () => {
        const message = makeDmMessage('beep boop');
        message.author.bot = true;
        await messageCreate.execute(message);

        expect(handleChatInteraction).not.toHaveBeenCalled();
        expect(message.reply).not.toHaveBeenCalled();
    });

    test('guild messages without a mention still go nowhere when dynamic response is off', async () => {
        const message = makeDmMessage('just chatting with friends');
        message.guild = {
            id: '200000000000000001',
            members: {
                me: {},
                cache: { get: () => ({ roles: { cache: { has: () => false } } }) }
            }
        };
        await messageCreate.execute(message);

        expect(handleChatInteraction).not.toHaveBeenCalled();
        expect(activityService.recordMessage).toHaveBeenCalledTimes(1);
    });
});
