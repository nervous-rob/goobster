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
    compactToolHistory,
    buildTranscriptDigest,
    buildAbortedHandoff,
    buildPriorToolContext,
    MAX_TOOL_ROUNDS,
    PROJECT_MAX_TOOL_ROUNDS,
    MAX_STALLED_ROUNDS,
    TOOL_HISTORY_BUDGET_CHARS
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
            expect.objectContaining({
                phase: 'start', id: 0, name: 'performSearch', cached: false,
                argsPreview: '{"query":"goobster"}'
            }),
            expect.objectContaining({
                phase: 'result', id: 0, name: 'performSearch', isError: false, cached: false,
                resultPreview: 'search results', durationMs: expect.any(Number)
            }),
            expect.objectContaining({ phase: 'start', id: 1, name: 'readGithubFile', cached: false }),
            // Tool failures surface as events too - the UI shows ⚠, the
            // model gets the error text as an observation.
            expect.objectContaining({
                phase: 'result', id: 1, name: 'readGithubFile', isError: true, cached: false,
                resultPreview: expect.stringContaining('file not found')
            })
        ]);
    });

    test('returns an ordered steps timeline: interstitial text interleaved with tools', async () => {
        aiService.chat
            .mockResolvedValueOnce({
                content: 'Let me search the repo first.',
                toolCalls: [toolCall('c1', 'searchGithubCode', { query: 'chatHandler' })]
            })
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [toolCall('c2', 'readGithubFile', { path: 'utils/chatHandler.js' })]
            })
            .mockResolvedValueOnce({ content: 'It routes chat replies.', toolCalls: [] });
        const executeTool = jest.fn()
            .mockResolvedValueOnce('Matches: utils/chatHandler.js')
            .mockResolvedValueOnce('contents');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool
        });

        expect(result.content).toBe('It routes chat replies.');
        expect(result.steps.map(s => s.type)).toEqual(['text', 'tool', 'tool']);
        expect(result.steps[0].content).toBe('Let me search the repo first.');
        expect(result.steps[1]).toEqual(expect.objectContaining({
            type: 'tool', id: 0, name: 'searchGithubCode',
            argsPreview: '{"query":"chatHandler"}',
            resultPreview: 'Matches: utils/chatHandler.js',
            isError: false, cached: false, durationMs: expect.any(Number)
        }));
        // The final answer is the reply itself, never a timeline step.
        expect(result.steps.some(s => s.type === 'text' && s.content === 'It routes chat replies.')).toBe(false);
    });

    test('empty finalization falls back to the interstitial round text, not the raw digest', async () => {
        aiService.chat.mockImplementation(async (messages) => {
            const hasNudge = messages.some(m => m.role === 'system'
                && (m.content.startsWith('TOOL BUDGET EXHAUSTED') || m.content.includes('previous reply was empty')));
            if (hasNudge) return { content: '', toolCalls: [] }; // finalization never delivers
            const n = messages.filter(m => m.role === 'tool').length;
            return {
                content: `Checked step ${n + 1} - looks good.`,
                toolCalls: [toolCall(`c${n}`, 'searchGithubCode', { query: `q${n}` })]
            };
        });
        const executeTool = jest.fn().mockResolvedValue('some result');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            maxToolRounds: 2,
            executeTool
        });

        expect(result.finalized).toBe(true);
        // The narration the user already saw streaming becomes the reply -
        // never a dump of raw tool output when real prose exists.
        expect(result.content).toContain('Checked step 1 - looks good.');
        expect(result.content).toContain('Checked step 2 - looks good.');
        expect(result.content).not.toContain('tool step');
    });

    test('a transient finalization failure is retried once before falling back', async () => {
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [toolCall('c1', 'searchGithubCode', { query: 'x' })] })
            .mockResolvedValueOnce({ content: '', toolCalls: [] })
            .mockRejectedValueOnce(new Error('provider hiccup'))
            .mockResolvedValueOnce({ content: 'Recovered summary.', toolCalls: [] });
        const executeTool = jest.fn().mockResolvedValue('result text');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool
        });

        expect(result.content).toBe('Recovered summary.');
        expect(result.finalized).toBe(true);
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

describe('runAgentLoop: project-length turns never end in silence', () => {
    // A scripted "model" that keeps planning distinct steps until told to
    // stop: round n calls the tool with a fresh argument. Any system nudge
    // makes it write a handoff.
    const plannerModel = (handoffText = 'Handoff: done A-B, remaining C.') => async (messages) => {
        const nudged = messages.some(m => m.role === 'system' && /EXHAUSTED|TIME LIMIT|NO PROGRESS|previous reply was empty/.test(m.content));
        if (nudged) return { content: handoffText, toolCalls: [] };
        const n = messages.filter(m => m.role === 'tool').length;
        return { content: '', toolCalls: [toolCall(`c${n}`, 'observatory', { action: 'step', n })] };
    };

    test('the project budget is a real ceiling for multi-step work, well above the chat default', () => {
        expect(PROJECT_MAX_TOOL_ROUNDS).toBeGreaterThanOrEqual(20);
        expect(PROJECT_MAX_TOOL_ROUNDS).toBeGreaterThan(MAX_TOOL_ROUNDS * 3);
    });

    test('a 15-step project sequence completes under the project budget (the chat budget would have cut it off)', async () => {
        const STEPS = 15;
        aiService.chat.mockImplementation(async (messages) => {
            const n = messages.filter(m => m.role === 'tool').length;
            if (n >= STEPS) return { content: 'Pipeline wired end to end.', toolCalls: [] };
            return { content: '', toolCalls: [toolCall(`c${n}`, 'observatory', { action: 'step', n })] };
        });
        const executeTool = jest.fn().mockImplementation(async (name, args) => `step ${args.n} ok`);

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            maxToolRounds: PROJECT_MAX_TOOL_ROUNDS,
            executeTool
        });

        expect(result.content).toBe('Pipeline wired end to end.');
        expect(result.finalized).toBe(false);
        expect(result.stopReason).toBeNull();
        expect(executeTool).toHaveBeenCalledTimes(STEPS);
        expect(STEPS).toBeGreaterThan(MAX_TOOL_ROUNDS);
    });

    test('budget exhaustion reports stopReason "rounds" and the nudge demands a handoff, not a summary', async () => {
        aiService.chat.mockImplementation(plannerModel());
        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            maxToolRounds: 3,
            executeTool: jest.fn().mockResolvedValue('ok')
        });

        expect(result.stopReason).toBe('rounds');
        expect(result.finalized).toBe(true);
        expect(result.content).toBe('Handoff: done A-B, remaining C.');
        const nudge = aiService.chat.mock.calls.at(-1)[0].findLast(m => m.role === 'system');
        expect(nudge.content).toMatch(/TOOL BUDGET EXHAUSTED/);
        expect(nudge.content).toMatch(/what is still left/i);
        expect(nudge.content).toMatch(/"continue"/);
        expect(nudge.content).toMatch(/Never claim the goal is finished/);
    });

    test('a passed deadline stops new tool rounds and finalizes with a time-limit handoff instead of dying', async () => {
        aiService.chat.mockImplementation(plannerModel('Out of time: fetch stage saved, build stage still to wire.'));
        const executeTool = jest.fn().mockResolvedValue('ok');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            maxToolRounds: PROJECT_MAX_TOOL_ROUNDS,
            deadlineAt: Date.now() - 1, // already past: the first round still runs, then hand off
            executeTool
        });

        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(result.stopReason).toBe('deadline');
        expect(result.finalized).toBe(true);
        expect(result.content).toBe('Out of time: fetch stage saved, build stage still to wire.');
        const nudge = aiService.chat.mock.calls.at(-1)[0].findLast(m => m.role === 'system');
        expect(nudge.content).toMatch(/TIME LIMIT REACHED/);
    });

    test('a deadline in the future does not interfere with a normal turn', async () => {
        aiService.chat.mockImplementation(async (messages) => {
            const n = messages.filter(m => m.role === 'tool').length;
            if (n >= 3) return { content: 'done', toolCalls: [] };
            return { content: '', toolCalls: [toolCall(`c${n}`, 'observatory', { n })] };
        });
        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            deadlineAt: Date.now() + 60 * 60 * 1000,
            executeTool: jest.fn().mockResolvedValue('ok')
        });
        expect(result.content).toBe('done');
        expect(result.stopReason).toBeNull();
    });

    test('a model that only repeats cached calls is stopped as stalled instead of burning the whole budget', async () => {
        const sameCall = () => toolCall('cX', 'observatory', { action: 'status', project: 'sim' });
        aiService.chat.mockImplementation(async (messages) => {
            const nudged = messages.some(m => m.role === 'system' && m.content.startsWith('NO PROGRESS'));
            if (nudged) return { content: 'Status has not changed; the job is still running.', toolCalls: [] };
            return { content: '', toolCalls: [sameCall()] };
        });
        const executeTool = jest.fn().mockResolvedValue('RUNNING');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            maxToolRounds: PROJECT_MAX_TOOL_ROUNDS,
            executeTool
        });

        expect(result.stopReason).toBe('stalled');
        expect(result.content).toBe('Status has not changed; the job is still running.');
        expect(executeTool).toHaveBeenCalledTimes(1); // the rest were served from cache
        // 1 real round + MAX_STALLED_ROUNDS cached rounds + finalization
        expect(aiService.chat).toHaveBeenCalledTimes(1 + MAX_STALLED_ROUNDS + 1);
        expect(result.roundsUsed).toBeLessThan(PROJECT_MAX_TOOL_ROUNDS);
    });

    test('a repeat interleaved with fresh calls is progress, not a stall', async () => {
        const repeat = () => toolCall('cR', 'observatory', { action: 'status' });
        aiService.chat.mockImplementation(async (messages) => {
            const n = messages.filter(m => m.role === 'tool').length;
            if (n >= 6) return { content: 'done', toolCalls: [] };
            // Every round re-checks status AND does one new thing
            return { content: '', toolCalls: [repeat(), toolCall(`c${n}`, 'observatory', { action: 'step', n })] };
        });
        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            maxToolRounds: PROJECT_MAX_TOOL_ROUNDS,
            executeTool: jest.fn().mockResolvedValue('ok')
        });
        expect(result.stopReason).toBeNull();
        expect(result.content).toBe('done');
    });

    test('an abort that surfaces as a rejected provider call returns the transcript instead of throwing', async () => {
        let aborted = false;
        aiService.chat
            .mockResolvedValueOnce({ content: 'Starting the run…', toolCalls: [toolCall('c1', 'observatory', { action: 'run' })] })
            .mockImplementationOnce(async () => {
                aborted = true; // the watchdog fired while this request was in flight
                throw new Error('The operation was aborted');
            });
        const executeTool = jest.fn().mockResolvedValue('job #12 RUNNING');

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            executeTool,
            shouldAbort: () => aborted
        });

        expect(result.aborted).toBe(true);
        expect(result.toolTranscript).toHaveLength(1);
        expect(result.toolTranscript[0].result).toBe('job #12 RUNNING');
        expect(result.roundTexts).toEqual(['Starting the run…']);
        expect(result.finalized).toBe(false);
    });

    test('a provider error without an abort still propagates', async () => {
        aiService.chat.mockRejectedValueOnce(new Error('502 Bad Gateway'));
        await expect(runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            shouldAbort: () => false
        })).rejects.toThrow('502 Bad Gateway');
    });

    test('older tool results are compacted once the history outgrows its budget; the newest stay intact', async () => {
        const BIG = 'x'.repeat(60_000);
        const ROUNDS = 8; // 480k chars of results, budget is 200k
        const snapshots = [];
        aiService.chat.mockImplementation(async (messages) => {
            snapshots.push(messages.filter(m => m.role === 'tool').map(m => m.content.length));
            const n = messages.filter(m => m.role === 'tool').length;
            if (n >= ROUNDS) return { content: 'done', toolCalls: [] };
            return { content: '', toolCalls: [toolCall(`c${n}`, 'observatory', { action: 'read', n })] };
        });

        const result = await runAgentLoop({
            messages: baseMessages(),
            functionDefs: FUNCTION_DEFS,
            maxToolRounds: PROJECT_MAX_TOOL_ROUNDS,
            executeTool: jest.fn().mockResolvedValue(BIG)
        });

        expect(result.content).toBe('done');
        expect(result.compactedResults).toBeGreaterThan(0);
        const finalSizes = snapshots.at(-1);
        expect(finalSizes).toHaveLength(ROUNDS);
        // The tail the model is about to use is verbatim
        expect(finalSizes.slice(-4).every(size => size === BIG.length)).toBe(true);
        // The head was stubbed
        expect(finalSizes[0]).toBeLessThan(1000);
        expect(finalSizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TOOL_HISTORY_BUDGET_CHARS + 4 * BIG.length);
        // The persisted transcript keeps the full results regardless
        expect(result.toolTranscript.every(t => t.result.length === BIG.length)).toBe(true);
    });
});

describe('compactToolHistory', () => {
    const toolMsg = (id, size) => ({ role: 'tool', toolCallId: id, name: 'observatory', content: 'r'.repeat(size) });

    test('does nothing under budget', () => {
        const messages = [toolMsg('a', 100), toolMsg('b', 100)];
        expect(compactToolHistory(messages, { budgetChars: 1000 })).toBe(0);
        expect(messages[0].content).toHaveLength(100);
    });

    test('stubs oldest first, keeps the recent window, pairs and ids intact, compacts each once', () => {
        const messages = [
            { role: 'system', content: 'sys' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'a' }] },
            toolMsg('a', 5000),
            { role: 'assistant', content: '', toolCalls: [{ id: 'b' }] },
            toolMsg('b', 5000),
            { role: 'assistant', content: '', toolCalls: [{ id: 'c' }] },
            toolMsg('c', 5000)
        ];
        expect(compactToolHistory(messages, { budgetChars: 6000, keepRecent: 1 })).toBe(2);
        expect(messages[2].content).toMatch(/trimmed to save context/);
        expect(messages[2].content).toMatch(/Call the tool again/);
        expect(messages[2].toolCallId).toBe('a');
        expect(messages[2].role).toBe('tool');
        expect(messages[4].content).toMatch(/trimmed/);
        expect(messages[6].content).toHaveLength(5000); // the recent one survives
        expect(messages).toHaveLength(7);
        // Idempotent on already-compacted rows
        expect(compactToolHistory(messages, { budgetChars: 100, keepRecent: 1 })).toBe(0);
    });
});

describe('buildAbortedHandoff', () => {
    test('names the system stop, the elapsed time, the narration, and every step - never silence', () => {
        const text = buildAbortedHandoff({
            transcript: [
                { name: 'observatory', result: 'Saved script "fetch" v1', isError: false },
                { name: 'observatory', result: 'Error: BAD_FILTER', isError: true }
            ],
            roundTexts: ['Setting up the fetch stage first.'],
            elapsedMs: 125_000,
            reason: 'watchdog'
        });
        expect(text).toMatch(/could not finish/);
        expect(text).toMatch(/watchdog/);
        expect(text).toMatch(/2m 5s/);
        expect(text).toMatch(/"continue"/);
        expect(text).toContain('Setting up the fetch stage first.');
        expect(text).toContain('✅ **observatory**');
        expect(text).toContain('❌ **observatory**');
        expect(text).toContain('Steps completed before the stop (2)');
    });

    test('works with nothing but a transcript', () => {
        const text = buildAbortedHandoff({ transcript: [{ name: 'runCode', result: 'ok', isError: false }] });
        expect(text).toMatch(/this reply was stopped/);
        expect(text).toContain('runCode');
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
                tools: [{ name: 'readGithubFile', arguments: '{"path":"x.js"}', result: 'y'.repeat(20_000), isError: false }]
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
