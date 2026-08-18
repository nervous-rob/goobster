/**
 * Scheduled prompts must enter the same context-aware chat/tool pipeline as
 * ordinary text turns, including when the automation owner is offline.
 */
jest.mock('@goobster/core/db', () => ({
    all: jest.fn(),
    get: jest.fn(),
    run: jest.fn()
}));

jest.mock('@goobster/core/utils/chatHandler', () => ({
    handleChatInteraction: jest.fn()
}));

const db = require('@goobster/core/db');
const { handleChatInteraction } = require('@goobster/core/utils/chatHandler');
const AutomationService = require('@goobster/core/services/automationService');

const AUTOMATION = {
    id: 42,
    userId: '600000000000000002',
    guildId: '600000000000000001',
    channelId: '600000000000000003',
    name: 'market-check',
    promptText: 'Check my portfolio, search for market news, then buy one share of AAPL.',
    schedule: '0 * * * *',
    metadata: null
};

function makeDiscordContext() {
    const channel = {
        id: AUTOMATION.channelId,
        send: jest.fn().mockResolvedValue({ id: 'message-1' }),
        sendTyping: jest.fn().mockResolvedValue(undefined)
    };
    const member = {
        user: { id: AUTOMATION.userId, username: 'rob' },
        displayName: 'Rob',
        presence: { status: 'offline' }
    };
    const guild = {
        id: AUTOMATION.guildId,
        name: 'Test Guild',
        members: {
            fetch: jest.fn().mockResolvedValue(member)
        }
    };
    const client = {
        user: { id: '600000000000000099', username: 'Goobster' },
        channels: {
            fetch: jest.fn().mockResolvedValue(channel)
        },
        guilds: {
            fetch: jest.fn().mockResolvedValue(guild)
        }
    };
    return { channel, member, guild, client };
}

beforeEach(() => {
    jest.clearAllMocks();
    db.run.mockReturnValue({ changes: 1 });
});

describe('AutomationService.executeAutomation', () => {
    test('runs an offline owner prompt through chat with complete tool context', async () => {
        const { channel, member, guild, client } = makeDiscordContext();
        const service = new AutomationService(client);

        await service.executeAutomation(AUTOMATION);

        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
        const interaction = handleChatInteraction.mock.calls[0][0];
        expect(interaction).toMatchObject({
            user: member.user,
            member,
            guild,
            guildId: AUTOMATION.guildId,
            channel,
            channelId: AUTOMATION.channelId,
            client,
            content: AUTOMATION.promptText,
            isAutomation: true
        });
        expect(interaction.options.getString()).toBe(AUTOMATION.promptText);

        // The claim advances nextRun BEFORE execution; lastRun is stamped after
        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('WHERE id = @id AND isEnabled = 1 AND nextRun <= CURRENT_TIMESTAMP'),
            expect.objectContaining({ id: AUTOMATION.id })
        );
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('SET lastRun = CURRENT_TIMESTAMP'),
            expect.objectContaining({ id: AUTOMATION.id })
        );
    });

    test('a fire that was already claimed (restart replay, second poller) never runs', async () => {
        const { client } = makeDiscordContext();
        db.run.mockReturnValue({ changes: 0 }); // someone else won the claim
        const service = new AutomationService(client);

        await service.executeAutomation(AUTOMATION);

        expect(handleChatInteraction).not.toHaveBeenCalled();
        expect(client.channels.fetch).not.toHaveBeenCalled();
    });

    test('routes direct tool replies through the automation channel label', async () => {
        const { channel, client } = makeDiscordContext();
        handleChatInteraction.mockImplementationOnce(async interaction => {
            await interaction.reply('Bought 1 AAPL.');
        });
        const service = new AutomationService(client);

        await service.executeAutomation(AUTOMATION);

        expect(channel.send).toHaveBeenCalledWith({
            content: `🤖 **Automated Message** - "${AUTOMATION.name}"\n\nBought 1 AAPL.`
        });
    });
});
