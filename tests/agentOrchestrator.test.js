/**
 * Agent orchestration loop (utils/chat/agentOrchestrator.js): bounded
 * multi-round tool calling where each step can use the results of previous
 * steps, with a guaranteed user-facing answer (finalization nudge, then a
 * transcript digest) instead of the old "I executed your request
 * successfully, but..." dead end.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-agent-orchestrator-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/aiService', () => ({
    chat: jest.fn(),
    supportsNativeWebSearch: jest.fn().mockReturnValue(false)
}));

// The real registry hard-requires command modules that load the gitignored
// config.json; the loop under test receives an injected executor anyway.
jest.mock('@goobster/core/utils/toolsRegistry', () => ({
    execute: jest.fn(),
    getDefinitions: jest.fn().mockReturnValue([])
}));

const aiService = require('@goobster/core/services/aiService');
const {
    runAgentLoop,
    buildTranscriptDigest,
    buildPriorToolContext,
    MAX_TOOL_ROUNDS
} = require('@goobster/core/utils/chat/agentOrchestrator');

const FUNCTION_DEFS = [{ name: 'searchGithubCode', description: 'search', parameters: { type: 'object', properties: {} } }];

const baseMessages = () => ([
    { role: 'system', content: 'You are Goobster.' },
    { role: 'user', content: 'What does the chat handler in my repo do?' }
]);

function toolCall(id, name, args) {
    return { id, name, arguments: JSON.stringify(args) };
}

afterAll(async () => {
    const db = require('@goobster/core/db');
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${TEST_DB}${suffix}`, { force: true });
    }
});

beforeEach(() => {
    jest.clearAllMocks();
});

describe('runAgentLoop', () => {
    test('plain reply without tool calls passes straight through', async () => {
        aiService.chat.mockResolvedValueOnce({ content: 'Hello there!', toolCalls: [] });

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS
        });

        expect(result.content).toBe('Hello there!');
        expect(result.toolTranscript).toHaveLength(0);
        expect(result.finalized).toBe(false);
        expect(aiService.chat).toHaveBeenCalledTimes(1);
    });

    test('chains three sequential tool rounds, each seeing previous results (old loop died at two)', async () => {
        // Snapshot the conversation as each round sees it (the loop appends
        // to one live array, so post-hoc inspection would see later rounds).
        const roundSnapshots = [];
        aiService.chat.mockImplementation(async (messages) => {
            roundSnapshots.push(messages.map(m => ({ ...m })));
            return aiService.chat.__responses.shift();
        });
        aiService.chat.__responses = [
            { content: '', toolCalls: [toolCall('c1', 'searchGithubCode', { query: 'chatHandler' })] },
            { content: '', toolCalls: [toolCall('c2', 'readGithubFile', { path: 'utils/chatHandler.js' })] },
            { content: '', toolCalls: [toolCall('c3', 'readGithubFile', { path: 'utils/chat/chatDb.js' })] },
            { content: 'The chat handler orchestrates replies.', toolCalls: [] }
        ];

        const executeTool = jest.fn()
            .mockResolvedValueOnce('Matches: utils/chatHandler.js')
            .mockResolvedValueOnce('contents of chatHandler.js')
            .mockResolvedValueOnce('contents of chatDb.js');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool
        });

        expect(result.content).toBe('The chat handler orchestrates replies.');
        expect(result.finalized).toBe(false);
        expect(result.toolTranscript.map(t => t.name)).toEqual(['searchGithubCode', 'readGithubFile', 'readGithubFile']);
        expect(executeTool).toHaveBeenCalledTimes(3);

        // The second model round must see the first tool's result: sequential
        // steps feed subsequent ones.
        const toolMessages = roundSnapshots[1].filter(m => m.role === 'tool');
        expect(toolMessages).toHaveLength(1);
        expect(toolMessages[0].content).toBe('Matches: utils/chatHandler.js');

        // The final round sees all three results.
        expect(roundSnapshots[3].filter(m => m.role === 'tool')).toHaveLength(3);
    });

    test('passes an automation interaction context through every action round', async () => {
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c1', 'checkPortfolio', {})] })
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c2', 'tradeStock', {
                action: 'buy', symbol: 'AAPL', units: 1
            })] })
            .mockResolvedValueOnce({ content: 'I checked the portfolio and bought one share.', toolCalls: [] });

        const interactionContext = {
            isAutomation: true,
            guildId: '600000000000000001',
            channelId: '600000000000000003',
            channel: { id: '600000000000000003' },
            user: { id: '600000000000000002' },
            member: { displayName: 'Rob' },
            guild: { id: '600000000000000001', name: 'Test Guild' },
            client: { user: { id: '600000000000000099' } }
        };
        const executeTool = jest.fn()
            .mockResolvedValueOnce('Portfolio is empty; balance is 1,000 points.')
            .mockResolvedValueOnce('Bought 1 AAPL.');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            interactionContext,
            executeTool
        });

        expect(result.content).toBe('I checked the portfolio and bought one share.');
        expect(executeTool).toHaveBeenNthCalledWith(
            1,
            'checkPortfolio',
            expect.objectContaining({ interactionContext })
        );
        expect(executeTool).toHaveBeenNthCalledWith(
            2,
            'tradeStock',
            expect.objectContaining({
                action: 'buy',
                symbol: 'AAPL',
                units: 1,
                interactionContext
            })
        );
    });

    test('onToolEvent reports per-tool start/result progress (web activity chips)', async () => {
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [
                toolCall('c1', 'performSearch', { query: 'goobster' }),
                toolCall('c2', 'readGithubFile', { path: 'nope.js' })
            ] })
            .mockResolvedValueOnce({ content: 'All done.', toolCalls: [] });
        const executeTool = jest.fn()
            .mockResolvedValueOnce('search results')
            .mockRejectedValueOnce(new Error('file not found'));

        const events = [];
        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool,
            onToolEvent: (event) => events.push(event)
        });

        expect(result.content).toBe('All done.');
        expect(events).toEqual([
            { phase: 'start', name: 'performSearch', cached: false },
            { phase: 'result', name: 'performSearch', isError: false, cached: false },
            { phase: 'start', name: 'readGithubFile', cached: false },
            // Tool failures surface as events too - the UI shows ⚠, the
            // model gets the error text as an observation.
            { phase: 'result', name: 'readGithubFile', isError: true, cached: false }
        ]);
    });

    test('duplicate tool calls emit cached events; a throwing hook never breaks the loop', async () => {
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c1', 'performSearch', { query: 'same' })] })
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c2', 'performSearch', { query: 'same' })] })
            .mockResolvedValueOnce({ content: 'Answer.', toolCalls: [] });
        const executeTool = jest.fn().mockResolvedValue('search results');

        const events = [];
        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool,
            onToolEvent: (event) => {
                events.push(event);
                throw new Error('hook blew up'); // must be swallowed
            }
        });

        expect(result.content).toBe('Answer.');
        expect(executeTool).toHaveBeenCalledTimes(1); // second call served from cache
        expect(events.filter(e => e.phase === 'start').map(e => e.cached)).toEqual([false, true]);
    });

    test('forces a final answer when the tool budget runs out', async () => {
        // The model wants tools on every round.
        aiService.chat.mockImplementation(async (messages) => {
            const hasNudge = messages.some(m => m.role === 'system' && m.content.startsWith('TOOL BUDGET EXHAUSTED'));
            if (hasNudge) {
                return { content: 'Based on what I found: it works like this.', toolCalls: [] };
            }
            const n = messages.filter(m => m.role === 'tool').length;
            return { content: '', toolCalls: [toolCall(`c${n}`, 'searchGithubCode', { query: `q${n}` })] };
        });
        const executeTool = jest.fn().mockResolvedValue('some result');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            maxToolRounds: 3,
            executeTool
        });

        expect(result.content).toBe('Based on what I found: it works like this.');
        expect(result.finalized).toBe(true);
        expect(executeTool).toHaveBeenCalledTimes(3);
        expect(aiService.chat).toHaveBeenCalledTimes(4); // 3 tool rounds + finalization
    });

    test('falls back to a transcript digest when even finalization yields nothing', async () => {
        aiService.chat.mockImplementation(async (messages) => {
            const n = messages.filter(m => m.role === 'tool').length;
            // Never produces text, always wants more tools.
            return { content: '', toolCalls: [toolCall(`c${n}`, 'searchGithubCode', { query: `q${n}` })] };
        });
        const executeTool = jest.fn().mockResolvedValue('Matches: db/schema.sql');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            maxToolRounds: 2,
            executeTool
        });

        expect(result.finalized).toBe(true);
        // The digest carries the real tool output to the user - never the
        // generic "I executed your request successfully" apology.
        expect(result.content).toContain('searchGithubCode');
        expect(result.content).toContain('Matches: db/schema.sql');
        // Tool calls requested during finalization are ignored, not executed.
        expect(executeTool).toHaveBeenCalledTimes(2);
    });

    test('retries once with a nudge when the reply after tool use is empty', async () => {
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c1', 'searchGithubCode', { query: 'x' })] })
            .mockResolvedValueOnce({ content: '   ', toolCalls: [] }) // whitespace-only reply
            .mockResolvedValueOnce({ content: 'Here is the summary.', toolCalls: [] });
        const executeTool = jest.fn().mockResolvedValue('result text');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool
        });

        expect(result.content).toBe('Here is the summary.');
        expect(result.finalized).toBe(true);
        const nudgeMessages = aiService.chat.mock.calls[2][0];
        expect(nudgeMessages.some(m => m.role === 'system' && m.content.includes('previous reply was empty'))).toBe(true);
    });

    test('tool errors become observations the model can recover from', async () => {
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c1', 'readGithubFile', { path: 'nope.js' })] })
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c2', 'searchGithubCode', { query: 'nope' })] })
            .mockResolvedValueOnce({ content: 'That file does not exist, but I found this instead.', toolCalls: [] });
        const executeTool = jest.fn()
            .mockRejectedValueOnce(new Error('404 Not Found'))
            .mockResolvedValueOnce('Matches: utils/nope-helper.js');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool
        });

        expect(result.content).toBe('That file does not exist, but I found this instead.');
        expect(result.toolTranscript[0].isError).toBe(true);
        expect(result.toolTranscript[0].result).toContain('404 Not Found');
        // The error observation reached the model on the next round.
        const secondRound = aiService.chat.mock.calls[1][0];
        expect(secondRound.find(m => m.role === 'tool').content).toContain('404 Not Found');
    });

    test('identical repeated tool calls are served from cache, not re-executed', async () => {
        const sameCall = () => toolCall('cX', 'searchGithubCode', { query: 'chatHandler' });
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [sameCall()] })
            .mockResolvedValueOnce({ content: '', toolCalls: [sameCall()] })
            .mockResolvedValueOnce({ content: 'Done.', toolCalls: [] });
        const executeTool = jest.fn().mockResolvedValue('the one result');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool
        });

        expect(result.content).toBe('Done.');
        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(result.toolTranscript[1].result).toContain('(cached)');
    });

    test('a Stop mid-round halts the remaining tool calls in that round', async () => {
        // One round with two tool calls; the Stop lands while the first is
        // running (e.g. a long sandbox run). The second must never execute
        // and the model must not be called again.
        aiService.chat.mockResolvedValueOnce({
            content: 'Working on it…',
            toolCalls: [
                toolCall('c1', 'runCode', { language: 'python', code: 'simulate()' }),
                toolCall('c2', 'runCode', { language: 'python', code: 'render()' })
            ]
        });

        let aborted = false;
        const executeTool = jest.fn().mockImplementation(async () => {
            aborted = true; // the user hit Stop while this tool ran
            return 'partial result';
        });

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool,
            shouldAbort: () => aborted
        });

        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(aiService.chat).toHaveBeenCalledTimes(1);
        expect(result.aborted).toBe(true);
        // No finalization round after an abort - partial text passes through
        expect(result.finalized).toBe(false);
        expect(result.content).toBe('Working on it…');
    });

    test('an abort raised before the loop starts never calls the model', async () => {
        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            shouldAbort: () => true
        });

        expect(aiService.chat).not.toHaveBeenCalled();
        expect(result.aborted).toBe(true);
        expect(result.content).toBe('');
    });

    test('exports a sane default round budget', () => {
        expect(MAX_TOOL_ROUNDS).toBeGreaterThanOrEqual(4);
    });
});

describe('buildTranscriptDigest', () => {
    test('renders names, status, and truncated results', () => {
        const digest = buildTranscriptDigest([
            { name: 'searchGithubCode', result: 'x'.repeat(2000), isError: false },
            { name: 'readGithubFile', result: 'boom', isError: true }
        ]);
        expect(digest).toContain('2 tool steps');
        expect(digest).toContain('✅ **searchGithubCode**');
        expect(digest).toContain('❌ **readGithubFile**');
        expect(digest).not.toContain('x'.repeat(1000)); // truncated well below 1000
    });
});

describe('buildPriorToolContext', () => {
    test('returns null without transcripts', () => {
        expect(buildPriorToolContext([])).toBeNull();
        expect(buildPriorToolContext(null)).toBeNull();
    });

    test('renders prior results with truncation, newest kept when over budget', () => {
        const block = buildPriorToolContext([
            {
                createdAt: '2026-07-24 10:00:00',
                tools: [{ name: 'searchGithubCode', arguments: '{"query":"a"}', result: 'old result', isError: false }]
            },
            {
                createdAt: '2026-07-24 10:05:00',
                tools: [{ name: 'readGithubFile', arguments: '{"path":"x.js"}', result: 'y'.repeat(3000), isError: false }]
            }
        ]);
        expect(block).toContain('PRIOR TOOL RESULTS');
        expect(block).toContain('searchGithubCode');
        expect(block).toContain('readGithubFile');
        expect(block).toContain('…(truncated)');
        expect(block).toContain('Only call the same tool again');
    });
});

describe('chatDb.getRecentToolTranscripts', () => {
    const db = require('@goobster/core/db');
    const { getOrCreateUser, getOrCreateConversation, getRecentToolTranscripts } = require('@goobster/core/utils/chat/chatDb');

    let guildConvId;
    let conversationId;
    let botUserId;

    beforeAll(async () => {
        const insert = await db.insert(
            `INSERT INTO guild_conversations (guildId, channelId, threadId) VALUES ('g1', 'ch1', 'channel-ch1')`
        );
        guildConvId = Number(insert);
        botUserId = await getOrCreateUser('900000000000000001', 'Goobster');
        conversationId = await getOrCreateConversation(botUserId, guildConvId);
    });

    async function insertBotMessage(message, metadata, createdAt = null) {
        await db.run(
            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot, metadata, createdAt)
             VALUES (@conversationId, @guildConvId, @createdBy, @message, 1, @metadata,
                     COALESCE(@createdAt, CURRENT_TIMESTAMP))`,
            { conversationId, guildConvId, createdBy: botUserId, message, metadata, createdAt }
        );
    }

    test('returns tool transcripts oldest-first, skipping other metadata and stale rows', async () => {
        await insertBotMessage('too old', JSON.stringify({
            toolTranscript: [{ name: 'searchGithubCode', arguments: '{}', result: 'ancient', isError: false }]
        }), '2020-01-01 00:00:00');
        await insertBotMessage('image reply', JSON.stringify({ imageGenerated: true, prompt: 'a cat' }));
        await insertBotMessage('broken metadata', '{not-json');
        await insertBotMessage('first tool reply', JSON.stringify({
            toolTranscript: [{ name: 'searchGithubCode', arguments: '{"query":"a"}', result: 'r1', isError: false }]
        }), '2026-07-24 10:00:00');
        await insertBotMessage('second tool reply', JSON.stringify({
            toolTranscript: [{ name: 'readGithubFile', arguments: '{"path":"x"}', result: 'r2', isError: false }]
        }));

        const transcripts = await getRecentToolTranscripts(guildConvId, { limit: 10, maxAgeMinutes: 60 * 24 * 365 * 10 });
        expect(transcripts.length).toBe(3); // the 2020 row only survives the huge test window
        const recent = await getRecentToolTranscripts(guildConvId);
        expect(recent.length).toBeGreaterThanOrEqual(1);
        expect(recent[recent.length - 1].tools[0].name).toBe('readGithubFile');
        // Non-transcript metadata rows never leak through.
        for (const t of recent) {
            expect(Array.isArray(t.tools)).toBe(true);
        }
    });

    test('returns [] for a conversation without transcripts', async () => {
        expect(await getRecentToolTranscripts(999999)).toEqual([]);
    });
});
