/**
 * chatHandler × agent loop on a web turn: the budget and deadline the
 * handler hands to runAgentLoop, and what reaches the user when the turn
 * is stopped mid-sequence. A user Stop ends quietly; a system stop (the
 * turn watchdog) after tools ran delivers a handoff naming what ran -
 * never "tools ran, then silence".
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-chathandler-agent-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/aiService', () => ({
    chat: jest.fn(),
    generateText: jest.fn().mockResolvedValue(''),
    supportsNativeWebSearch: jest.fn().mockReturnValue(false),
    getProvider: jest.fn(() => 'openai')
}));
jest.mock('@goobster/core/services/memoryService', () => ({
    recall: jest.fn().mockResolvedValue([]),
    remember: jest.fn().mockResolvedValue(undefined),
    cleanupVecIndex: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('@goobster/core/utils/toolsRegistry', () => ({
    TOOL_ORDER: ['observatory'],
    getDefinitions: jest.fn(),
    execute: jest.fn(),
    registerCommandAdapters: jest.fn()
}));
jest.mock('@goobster/core/utils/chat/agentOrchestrator', () => {
    const actual = jest.requireActual('@goobster/core/utils/chat/agentOrchestrator');
    return { ...actual, runAgentLoop: jest.fn(actual.runAgentLoop) };
});

const aiService = require('@goobster/core/services/aiService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const orchestrator = require('@goobster/core/utils/chat/agentOrchestrator');
const { handleChatInteraction } = require('@goobster/core/utils/chatHandler');

const USER = '100000000000000001';
const BOT = '900000000000000001';
const OBSERVATORY_DEF = { name: 'observatory', description: 'projects', parameters: { type: 'object', properties: {} } };
const SEARCH_DEF = { name: 'performSearch', description: 'search', parameters: { type: 'object', properties: {} } };

/** A Study-shaped pseudo-interaction (what webChatService._buildInteraction produces). */
function webInteraction({ text = 'wire the pipeline', deadlineAt = null } = {}) {
    const state = { aborted: false, abortReason: null, startedAt: Date.now() };
    const delivered = [];
    const interaction = {
        id: `web-${USER}-test`,
        user: { id: USER, username: 'rob' },
        guild: null,
        guildId: null,
        member: null,
        client: { user: { id: BOT, username: 'Goobster' } },
        content: text,
        channelId: `web:${USER}:incognito`,
        channel: {
            id: `web:${USER}:incognito`,
            isThread: () => false,
            sendTyping: async () => {},
            messages: { fetch: async () => [] },
            send: async (payload) => { delivered.push(payload); return { id: 'm' }; }
        },
        maxInputLength: 20000,
        skipHistory: true, // incognito: nothing persisted, keeps the test on the pipeline itself
        shouldAbort: () => state.aborted,
        abortReason: () => state.abortReason,
        turnDeadlineAt: deadlineAt,
        turnStartedAt: state.startedAt,
        onToolEvent: () => {},
        onStreamDelta: () => {},
        sendFullResponse: async (content, { isError = false } = {}) => { delivered.push({ content, isError }); },
        deferReply: async () => {},
        editReply: async (r) => { delivered.push(r); },
        reply: async (r) => { delivered.push(r); },
        followUp: async (r) => { delivered.push(r); },
        options: { getString: () => text }
    };
    return { interaction, state, delivered };
}

const toolCall = (id, args) => ({ id, name: 'observatory', arguments: JSON.stringify(args) });

beforeEach(() => {
    jest.clearAllMocks();
    toolsRegistry.getDefinitions.mockResolvedValue([OBSERVATORY_DEF]);
    toolsRegistry.execute.mockResolvedValue('✅ job #7 RUNNING in "sim"');
});

afterAll(async () => {
    const db = require('@goobster/core/db');
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${TEST_DB}${suffix}`, { force: true });
    }
});

describe('budget and deadline selection', () => {
    test('a turn that offers the observatory tool runs with the project budget and the surface deadline', async () => {
        aiService.chat.mockResolvedValue({ content: 'Hello.', toolCalls: [] });
        const deadlineAt = Date.now() + 90 * 60 * 1000;
        const { interaction } = webInteraction({ deadlineAt });

        await handleChatInteraction(interaction);

        expect(orchestrator.runAgentLoop).toHaveBeenCalledTimes(1);
        const params = orchestrator.runAgentLoop.mock.calls[0][0];
        expect(params.maxToolRounds).toBe(orchestrator.PROJECT_MAX_TOOL_ROUNDS);
        expect(params.deadlineAt).toBe(deadlineAt);
        expect(params.functionDefs.map(d => d.name)).toContain('observatory');
    });

    test('a turn without project tools keeps the conversational budget', async () => {
        toolsRegistry.getDefinitions.mockResolvedValue([SEARCH_DEF]);
        aiService.chat.mockResolvedValue({ content: 'Hello.', toolCalls: [] });
        const { interaction } = webInteraction();

        await handleChatInteraction(interaction);

        const params = orchestrator.runAgentLoop.mock.calls[0][0];
        expect(params.maxToolRounds).toBe(orchestrator.MAX_TOOL_ROUNDS);
        expect(params.deadlineAt).toBeNull();
    });
});

describe('stopped mid-sequence', () => {
    test('the watchdog stopping a turn after tools ran delivers a handoff, not silence', async () => {
        const { interaction, state, delivered } = webInteraction();
        aiService.chat
            .mockResolvedValueOnce({ content: 'Kicking off the run.', toolCalls: [toolCall('c1', { action: 'run_script', slug: 'fetch' })] })
            .mockImplementationOnce(async () => {
                // The watchdog evicted the turn while this request was in flight
                state.aborted = true;
                state.abortReason = 'watchdog';
                throw new Error('This operation was aborted');
            });

        await handleChatInteraction(interaction);

        const replies = delivered.map(d => (typeof d === 'string' ? d : d.content)).filter(Boolean);
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatch(/could not finish/);
        expect(replies[0]).toMatch(/watchdog/);
        expect(replies[0]).toMatch(/"continue"/);
        expect(replies[0]).toContain('Kicking off the run.');
        expect(replies[0]).toContain('job #7 RUNNING');
        // Not the generic apology
        expect(replies[0]).not.toMatch(/encountered an error/);
    });

    test('a user Stop after tools ran still ends quietly', async () => {
        const { interaction, state, delivered } = webInteraction();
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c1', { action: 'status' })] })
            .mockImplementationOnce(async () => {
                state.aborted = true;
                state.abortReason = 'stop';
                throw new Error('This operation was aborted');
            });

        await handleChatInteraction(interaction);

        const replies = delivered.map(d => (typeof d === 'string' ? d : d?.content)).filter(Boolean);
        expect(replies).toEqual([]);
    });

    test('a watchdog stop before any tool ran ends quietly too (nothing to hand off)', async () => {
        const { interaction, state, delivered } = webInteraction();
        aiService.chat.mockImplementationOnce(async () => {
            state.aborted = true;
            state.abortReason = 'watchdog';
            throw new Error('This operation was aborted');
        });

        await handleChatInteraction(interaction);

        const replies = delivered.map(d => (typeof d === 'string' ? d : d?.content)).filter(Boolean);
        expect(replies).toEqual([]);
    });

    test('a passed deadline produces the model handoff through the normal delivery path', async () => {
        const { interaction, delivered } = webInteraction({ deadlineAt: Date.now() - 1 });
        aiService.chat.mockImplementation(async (messages) => {
            if (messages.some(m => m.role === 'system' && m.content.startsWith('TIME LIMIT REACHED'))) {
                return { content: 'Out of time: the fetch stage is saved; the build trigger still needs wiring. Say continue.', toolCalls: [] };
            }
            return { content: '', toolCalls: [toolCall('c1', { action: 'save_script', name: 'fetch' })] };
        });

        await handleChatInteraction(interaction);

        const replies = delivered.map(d => (typeof d === 'string' ? d : d?.content)).filter(Boolean);
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatch(/Say continue/);
        expect(toolsRegistry.execute).toHaveBeenCalledTimes(1);
    });
});


test('incognito does not offer durable memory or file-saving tools', async () => {
    const names = ['rememberFact', 'saveArtifact', 'findImages', 'fetchWebFile', 'lookupNotes', 'performSearch'];
    toolsRegistry.getDefinitions.mockResolvedValue(names.map(name => ({ name, parameters: { type: 'object', properties: {} } })));
    aiService.chat.mockResolvedValue({ content: 'Hello.', toolCalls: [] });
    await handleChatInteraction(webInteraction().interaction);
    expect(orchestrator.runAgentLoop.mock.calls[0][0].functionDefs.map(d => d.name))
        .toEqual(['lookupNotes', 'performSearch']);
});

test.each(['portal', 'discord-dm', 'guild'])('private runtime preferences stay scoped on %s turns', async (surface) => {
    const db = require('@goobster/core/db');
    const settings = require('@goobster/core/services/userSettingsService');
    await settings._mergePreferencesTx(db, USER, { replyMaxTokens: 768, temperature: 0.3, topP: 0.8, disabledTools: ['performSearch'] });
    aiService.supportsNativeWebSearch.mockReturnValue(true);
    aiService.chat.mockResolvedValue({ content: 'Hello.', toolCalls: [] });
    toolsRegistry.getDefinitions.mockResolvedValue([SEARCH_DEF]);
    const { interaction } = webInteraction();
    if (surface !== 'portal') {
        interaction.channelId = '950000000000000001';
        interaction.channel.id = interaction.channelId;
    }
    if (surface === 'guild') {
        interaction.guildId = '960000000000000001';
        interaction.guild = { id: interaction.guildId, name: 'A server' };
    }
    await handleChatInteraction(interaction);
    const params = orchestrator.runAgentLoop.mock.calls[0][0];
    if (surface === 'guild') {
        expect(params.chatOptions.max_tokens).toBe(4096);
        expect(params.chatOptions.temperature).toBeUndefined();
        expect(params.chatOptions.webSearch).toBe(true);
        expect(params.functionDefs.map(d => d.name)).toContain('performSearch');
    } else {
        expect(params.chatOptions).toMatchObject({ max_tokens: 768, temperature: 0.3, top_p: 0.8 });
        expect(params.chatOptions.webSearch).not.toBe(true);
        expect(params.functionDefs).toEqual([]);
    }
});


test('Inbox context reaches the shared instructions slot ahead of the user message', async () => {
    aiService.chat.mockResolvedValue({ content: 'The header was rejected.', toolCalls: [] });
    const { interaction } = webInteraction({ text: 'Why did this fail?' });
    interaction.inboxInstructions = 'INBOX CONTEXT: server-reloaded failure evidence';
    await handleChatInteraction(interaction);
    const { messages } = orchestrator.runAgentLoop.mock.calls[0][0];
    const system = messages.findIndex(message => message.role === 'system' && message.content.includes(interaction.inboxInstructions));
    const user = messages.findIndex(message => message.role === 'user' && message.content.includes('Why did this fail?'));
    expect(system).toBeGreaterThanOrEqual(0);
    expect(user).toBeGreaterThan(system);
});
