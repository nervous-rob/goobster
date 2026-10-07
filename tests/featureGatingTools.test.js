/**
 * Feature policy at the AI tool surface (#319, P1.4).
 *
 * Covers utils/toolsRegistry.js (discovery and dispatch gated independently),
 * utils/chat/agentOrchestrator.js (FEATURE_UNAVAILABLE is a terminal tool
 * outcome and a user-facing answer still arrives), the availability prompt
 * line in utils/chat/promptContext.js, and the same stale-tool scenario
 * through the OpenAI, Anthropic, Gemini and Ollama provider fixtures. No keys
 * and no network: providers are driven through injected transports.
 *
 * Feature state is injected with `features._resetForTests` and an in-memory
 * file, so nothing here reads or writes data/features.json.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-feature-gating-tools-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/aiService', () => ({
    chat: jest.fn(),
    generateText: jest.fn().mockResolvedValue(''),
    supportsNativeWebSearch: jest.fn().mockReturnValue(false)
}));

const aiService = require('@goobster/core/services/aiService');
const db = require('@goobster/core/db');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const { runAgentLoop, MAX_STALLED_ROUNDS } = require('@goobster/core/utils/chat/agentOrchestrator');
const { buildConversationalPrompt, unavailableFeatureTitles } = require('@goobster/core/utils/chat/promptContext');
const { featureAvailabilityLine } = require('@goobster/core/utils/chat/promptFragments');
const { features } = require('@goobster/core/features/featureState');
const catalog = require('@goobster/core/features/catalog');
const inventory = require('@goobster/core/features/inventory');
const sandboxConfig = require('@goobster/core/config/sandboxConfig');
const observatoryConfig = require('@goobster/core/config/observatoryConfig');
const discordConfig = require('@goobster/core/config/discordConfig');

const MANAGEABLE = catalog.FEATURE_IDS.filter(id => id !== 'core');
const FILE = '/virtual/data/features.json';
const names = (defs) => defs.map(def => def.name);

/** Everything active except `off`; a feature the file turns off takes its dependents down with it. */
function useFileState({ off = [], config = { token: 'jest-placeholder' }, env = {} } = {}) {
    const entries = {};
    for (const id of MANAGEABLE) entries[id] = { installed: true, active: !off.includes(id) };
    const text = JSON.stringify({
        version: 1, revision: 1, updatedAt: '2026-10-06 21:14:02', origin: 'operator', features: entries
    });
    const memory = {
        existsSync: (p) => p === FILE,
        readFileSync: (p) => {
            if (p !== FILE) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return text;
        }
    };
    features._resetForTests({ fs: memory, filePath: FILE, env, config });
}

function useLegacyState() {
    features._resetForTests();
}

const original = {
    sandboxEnabled: sandboxConfig.enabled,
    sandboxScope: sandboxConfig.scope,
    sandboxApprovers: sandboxConfig.approverUserIds,
    sandboxIsolation: sandboxConfig.requireStrongIsolation,
    obsEnabled: observatoryConfig.enabled,
    obsScope: observatoryConfig.scope
};

beforeAll(() => {
    discordConfig.setEnabledForTests(true);
});

afterEach(() => {
    sandboxConfig.enabled = original.sandboxEnabled;
    sandboxConfig.scope = original.sandboxScope;
    sandboxConfig.approverUserIds = original.sandboxApprovers;
    sandboxConfig.requireStrongIsolation = original.sandboxIsolation;
    observatoryConfig.enabled = original.obsEnabled;
    observatoryConfig.scope = original.obsScope;
    useLegacyState();
    jest.restoreAllMocks();
});

afterAll(async () => {
    discordConfig.setEnabledForTests(undefined);
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${TEST_DB}${suffix}`, { force: true });
});

describe('no features.json: discovery equals the pre-gate baseline', () => {
    // Recorded from toolsRegistry.getDefinitions on the commit before #319:
    // the TOOL_ORDER names each configuration did NOT offer.
    const CONTEXTS = { plain: {}, web: { isWeb: true }, automation: { isAutomation: true } };
    const SCENARIOS = [
        ['default', () => {}, {
            plain: ['runCode', 'observatory', 'requestPythonPackages', 'setSpeechAccent'],
            web: ['runCode', 'observatory', 'requestPythonPackages', 'playTrack', 'speakMessage'],
            automation: ['runCode', 'observatory', 'requestPythonPackages', 'playTrack', 'speakMessage', 'setSpeechAccent']
        }],
        ['sandbox everywhere', () => {
            sandboxConfig.enabled = true; sandboxConfig.scope = 'everywhere'; sandboxConfig.approverUserIds = ['1'];
        }, {
            plain: ['observatory', 'setSpeechAccent'],
            web: ['observatory', 'playTrack', 'speakMessage'],
            automation: ['observatory', 'playTrack', 'speakMessage', 'setSpeechAccent']
        }],
        ['sandbox web scope', () => {
            sandboxConfig.enabled = true; sandboxConfig.scope = 'web'; sandboxConfig.approverUserIds = ['1'];
        }, {
            plain: ['runCode', 'observatory', 'requestPythonPackages', 'setSpeechAccent'],
            web: ['observatory', 'playTrack', 'speakMessage'],
            automation: ['observatory', 'playTrack', 'speakMessage', 'setSpeechAccent']
        }],
        ['sandbox web scope, no approvers', () => {
            sandboxConfig.enabled = true; sandboxConfig.scope = 'web'; sandboxConfig.approverUserIds = [];
        }, {
            plain: ['runCode', 'observatory', 'requestPythonPackages', 'setSpeechAccent'],
            web: ['observatory', 'requestPythonPackages', 'playTrack', 'speakMessage'],
            automation: ['observatory', 'requestPythonPackages', 'playTrack', 'speakMessage', 'setSpeechAccent']
        }],
        ['observatory everywhere', () => {
            sandboxConfig.enabled = true; sandboxConfig.scope = 'web'; sandboxConfig.approverUserIds = ['1'];
            observatoryConfig.enabled = true; observatoryConfig.scope = 'everywhere';
        }, {
            plain: ['runCode', 'requestPythonPackages', 'setSpeechAccent'],
            web: ['playTrack', 'speakMessage'],
            automation: ['playTrack', 'speakMessage', 'setSpeechAccent']
        }],
        ['observatory web scope', () => {
            sandboxConfig.enabled = true; sandboxConfig.scope = 'web'; sandboxConfig.approverUserIds = ['1'];
            observatoryConfig.enabled = true; observatoryConfig.scope = 'web';
        }, {
            plain: ['runCode', 'observatory', 'requestPythonPackages', 'setSpeechAccent'],
            web: ['playTrack', 'speakMessage'],
            automation: ['playTrack', 'speakMessage', 'setSpeechAccent']
        }],
        ['observatory on, sandbox off', () => {
            sandboxConfig.enabled = false; sandboxConfig.scope = 'web'; sandboxConfig.approverUserIds = ['1'];
            observatoryConfig.enabled = true; observatoryConfig.scope = 'web';
        }, {
            plain: ['runCode', 'observatory', 'requestPythonPackages', 'setSpeechAccent'],
            web: ['runCode', 'observatory', 'requestPythonPackages', 'playTrack', 'speakMessage'],
            automation: ['runCode', 'observatory', 'requestPythonPackages', 'playTrack', 'speakMessage', 'setSpeechAccent']
        }]
    ];

    test.each(SCENARIOS)('%s', async (_label, configure, expectedMissing) => {
        sandboxConfig.requireStrongIsolation = false;
        sandboxConfig.enabled = false;
        observatoryConfig.enabled = false;
        configure();
        useLegacyState();
        for (const [context, args] of Object.entries(CONTEXTS)) {
            const offered = names(await toolsRegistry.getDefinitions(undefined, args));
            const expected = toolsRegistry.TOOL_ORDER.filter(name => !expectedMissing[context].includes(name));
            expect(offered).toEqual(expected);
        }
    });

    test('the source reports no state file, so the legacy switches decide', () => {
        useLegacyState();
        expect(features.status().source).toBe('none');
    });
});

describe('discovery follows the feature state', () => {
    test('a disabled feature removes its tools, and only its tools', async () => {
        useFileState({ off: ['tavern', 'github', 'music'] });
        const offered = names(await toolsRegistry.getDefinitions());
        for (const gone of [
            'tavernInfo', 'tavernParty', 'tavernAct', 'tavernAttack', 'tavernTwist', 'tavernRecap', 'rollDice',
            'searchGithubCode', 'readGithubFile', 'createGithubIssue', 'launchCursorAgent', 'playTrack'
        ]) {
            expect(offered).not.toContain(gone);
        }
        for (const kept of ['performSearch', 'consultDocs', 'checkPoints', 'stockQuote', 'gamblePoints', 'speakMessage', 'executePlan']) {
            expect(offered).toContain(kept);
        }
    });

    test('a dependent feature goes with the one it depends on', async () => {
        useFileState({ off: ['github'] });
        expect(features.isActive('cursor')).toBe(false);
        expect(names(await toolsRegistry.getDefinitions())).not.toContain('launchCursorAgent');
    });

    test('economy off takes the exchange and gambling tools with it', async () => {
        useFileState({ off: ['economy'] });
        const offered = names(await toolsRegistry.getDefinitions());
        for (const gone of ['checkPoints', 'gamblePoints', 'stockQuote', 'tradeStock', 'eventContracts', 'goblinWheel', 'auditExchange']) {
            expect(offered).not.toContain(gone);
        }
    });

    test('eventContracts and goblinWheel need gambling and exchange together', async () => {
        useFileState({ off: ['exchange'] });
        let offered = names(await toolsRegistry.getDefinitions());
        expect(offered).toContain('gamblePoints');
        expect(offered).not.toContain('eventContracts');
        expect(offered).not.toContain('goblinWheel');

        useFileState({ off: ['gambling'] });
        offered = names(await toolsRegistry.getDefinitions());
        expect(offered).toContain('stockQuote');
        expect(offered).not.toContain('eventContracts');
        expect(offered).not.toContain('goblinWheel');
        expect(offered).not.toContain('gamblePoints');
    });

    test('speakMessage needs voice and the Discord adapter, setSpeechAccent only voice', async () => {
        useFileState({ off: ['voice'] });
        let offered = names(await toolsRegistry.getDefinitions(undefined, { isWeb: true }));
        expect(offered).not.toContain('setSpeechAccent');
        expect(offered).not.toContain('speakMessage');

        useFileState({ off: ['discord'] });
        offered = names(await toolsRegistry.getDefinitions());
        expect(offered).not.toContain('speakMessage');
        expect(offered).not.toContain('setNickname');
        expect(offered).not.toContain('playTrack');
    });

    test('an active feature is still subject to its operational switch', async () => {
        sandboxConfig.requireStrongIsolation = false;
        sandboxConfig.enabled = false;
        useFileState();
        expect(features.isActive('sandbox')).toBe(true);
        expect(names(await toolsRegistry.getDefinitions(undefined, { isWeb: true }))).not.toContain('runCode');

        sandboxConfig.enabled = true;
        sandboxConfig.scope = 'everywhere';
        useFileState();
        expect(names(await toolsRegistry.getDefinitions())).toContain('runCode');

        useFileState({ off: ['sandbox'] });
        expect(names(await toolsRegistry.getDefinitions())).not.toContain('runCode');
        expect(names(await toolsRegistry.getDefinitions())).not.toContain('requestPythonPackages');
        expect(names(await toolsRegistry.getDefinitions())).not.toContain('observatory');
    });

    test('a name allowlist cannot bring a disabled tool back', async () => {
        useFileState({ off: ['tavern'] });
        const defs = await toolsRegistry.getDefinitions(['rollDice', 'performSearch']);
        expect(names(defs)).toEqual(['performSearch']);
    });

    test('a tool nobody owns is hidden and refused rather than crashing discovery', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        let isolated;
        jest.isolateModules(() => {
            const actual = jest.requireActual('@goobster/core/features/gate');
            const { GateError } = actual;
            jest.doMock('@goobster/core/features/gate', () => ({
                ...actual,
                surfaceActive: (kind, name) => {
                    if (name === 'performSearch') throw new GateError('UNCLAIMED_SURFACE', 'unclaimed');
                    return actual.surfaceActive(kind, name);
                },
                requireSurface: (kind, name) => {
                    if (name === 'performSearch') throw new GateError('UNCLAIMED_SURFACE', 'unclaimed');
                    return actual.requireSurface(kind, name);
                }
            }));
            isolated = require('@goobster/core/utils/toolsRegistry');
        });
        const offered = names(await isolated.getDefinitions());
        expect(offered).not.toContain('performSearch');
        expect(offered).toContain('consultDocs');
        await expect(isolated.execute('performSearch', { query: 'x' })).resolves.toMatchObject({
            ok: false, code: 'FEATURE_UNAVAILABLE'
        });
        expect(warn).toHaveBeenCalledTimes(1);
        jest.dontMock('@goobster/core/features/gate');
    });
});

describe('dispatch refuses a tool the feature state has switched off', () => {
    const interactionContext = {
        channelId: '700000000000000003',
        guildId: '700000000000000001',
        user: { id: '700000000000000002' },
        member: { id: '700000000000000002', displayName: 'Rob' },
        guild: { id: '700000000000000001' }
    };

    function spyOnSideEffects() {
        const personalPolicyService = require('@goobster/core/services/personalPolicyService');
        const stockPortfolioService = require('@goobster/core/services/stockPortfolioService');
        const wheelService = require('@goobster/core/services/exchange/wheelService');
        return {
            policy: jest.spyOn(personalPolicyService, 'toolPolicy'),
            buy: jest.spyOn(stockPortfolioService, 'buy').mockResolvedValue({}),
            spin: jest.spyOn(wheelService, 'spin').mockResolvedValue({}),
            dbGet: jest.spyOn(db, 'get'),
            dbAll: jest.spyOn(db, 'all'),
            dbRun: jest.spyOn(db, 'run'),
            dbInsert: jest.spyOn(db, 'insert'),
            fetch: jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no network in this test'))
        };
    }

    test('a manually constructed call is refused before approvals, admission or any side effect', async () => {
        useFileState({ off: ['exchange'] });
        const spies = spyOnSideEffects();

        const result = await toolsRegistry.execute('tradeStock', {
            action: 'buy', symbol: 'AAPL', units: 1, interactionContext
        });

        expect(result).toMatchObject({ ok: false, code: 'FEATURE_UNAVAILABLE', feature: 'exchange' });
        expect(result.reasons.map(reason => reason.code)).toEqual(['DISABLED']);
        expect(spies.policy).not.toHaveBeenCalled();
        expect(spies.buy).not.toHaveBeenCalled();
        for (const spy of [spies.dbGet, spies.dbAll, spies.dbRun, spies.dbInsert, spies.fetch]) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    test.each([
        ['gamblePoints', ['gambling'], 'gambling', { game: 'poker', bet: 5 }],
        ['goblinWheel', ['gambling'], 'gambling', { action: 'spin' }],
        ['eventContracts', ['exchange'], 'exchange', { action: 'list' }],
        ['checkPoints', ['economy'], 'economy', {}],
        ['rollDice', ['tavern'], 'tavern', { notation: '1d20' }],
        ['searchGithubCode', ['github'], 'github', { query: 'x' }],
        ['launchCursorAgent', ['cursor'], 'cursor', { prompt: 'x' }],
        ['playTrack', ['music'], 'music', { query: 'x' }],
        ['setNickname', ['discord'], 'discord', { nickname: 'x' }]
    ])('%s is refused naming the feature that blocks it', async (tool, off, blockedBy, args) => {
        useFileState({ off });
        const spies = spyOnSideEffects();
        const result = await toolsRegistry.execute(tool, { ...args, interactionContext });
        expect(result).toMatchObject({ ok: false, code: 'FEATURE_UNAVAILABLE', feature: blockedBy });
        expect(spies.policy).not.toHaveBeenCalled();
        expect(spies.dbRun).not.toHaveBeenCalled();
        expect(spies.dbInsert).not.toHaveBeenCalled();
        expect(spies.fetch).not.toHaveBeenCalled();
    });

    test('the refusal carries no setting values, only reason codes and names', async () => {
        useFileState({ off: ['exchange'], env: { GOOBSTER_FEATURE_EXCHANGE: 'off' }, config: { token: 'super-secret-token' } });
        const result = await toolsRegistry.execute('tradeStock', { action: 'buy', symbol: 'AAPL', units: 1 });
        const text = JSON.stringify(result);
        expect(text).not.toContain('super-secret-token');
        expect(result.reasons.every(reason => typeof reason.code === 'string')).toBe(true);
    });

    test('an unknown tool name is still an error, not a feature result', async () => {
        await expect(toolsRegistry.execute('noSuchTool', {})).rejects.toThrow(/Unknown tool/);
    });

    test('executePlan reports a switched-off step as failed and never as completed', async () => {
        useFileState({ off: ['exchange'] });
        const spies = spyOnSideEffects();
        const out = await toolsRegistry.execute('executePlan', {
            plan: [{ name: 'tradeStock', args: { action: 'buy', symbol: 'AAPL', units: 1 } }],
            interactionContext
        });
        expect(String(out)).toMatch(/0\/1 steps completed/);
        expect(String(out)).toMatch(/not available on this installation/);
        expect(String(out)).not.toMatch(/Completed successfully/);
        expect(spies.buy).not.toHaveBeenCalled();
    });

    test('with every optional feature off the core tools still answer', async () => {
        useFileState({ off: MANAGEABLE });
        const offered = names(await toolsRegistry.getDefinitions(undefined, { isWeb: true }));
        const claimedByCore = Object.keys(inventory.aiTools).filter(name => {
            const claim = inventory.ownerOf('aiTool', name);
            return claim.owner === 'core' && claim.alsoRequires.length === 0 && toolsRegistry.TOOL_ORDER.includes(name);
        });
        expect(claimedByCore.length).toBeGreaterThan(10);
        // The sandbox-dependent definitions are operational; everything else core owns is offered.
        for (const name of claimedByCore) expect(offered).toContain(name);
        for (const name of ['consultDocs', 'rememberFact', 'forgetFact', 'lookupNotes']) {
            expect(offered).toContain(name);
        }
        expect(offered.length).toBe(claimedByCore.length);

        const docs = await toolsRegistry.execute('consultDocs', { action: 'list', interactionContext });
        expect(typeof docs).toBe('string');
        expect(docs).toMatch(/DOCS/);
    }, 60_000);
});

describe('runAgentLoop treats FEATURE_UNAVAILABLE as a terminal outcome', () => {
    const DEFS = [{ name: 'performSearch', description: 'search', parameters: { type: 'object', properties: {} } }];
    const call = (id, name, args = {}) => ({ id, name, arguments: JSON.stringify(args) });
    const unavailable = (feature = 'exchange') => ({
        ok: false,
        code: 'FEATURE_UNAVAILABLE',
        feature,
        reasons: [{ code: 'DISABLED', detail: 'features.json' }]
    });
    const messages = () => [
        { role: 'system', content: 'You are Goobster.' },
        { role: 'user', content: 'buy me a share of AAPL' }
    ];

    beforeEach(() => {
        aiService.chat.mockReset();
    });

    test('the model is told once and the user still gets an answer', async () => {
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [call('c1', 'tradeStock', { action: 'buy', symbol: 'AAPL' })] })
            .mockResolvedValueOnce({ content: 'Trading is switched off here, so I cannot buy that.', toolCalls: [] });
        const executeTool = jest.fn().mockResolvedValue(unavailable());

        const result = await runAgentLoop({ messages: messages(), functionDefs: DEFS, executeTool });

        expect(result.content).toBe('Trading is switched off here, so I cannot buy that.');
        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(aiService.chat).toHaveBeenCalledTimes(2);
        expect(result.roundsUsed).toBe(2);
        expect(result.toolTranscript).toHaveLength(1);
        expect(result.toolTranscript[0]).toMatchObject({ name: 'tradeStock', isError: true, unavailable: true });
        expect(result.steps.find(step => step.type === 'tool')).toMatchObject({ unavailable: true, isError: true });

        const toolMessage = aiService.chat.mock.calls[1][0].find(m => m.role === 'tool');
        expect(toolMessage.content).toMatch(/FEATURE_UNAVAILABLE/);
        expect(toolMessage.content).toMatch(/Exchange/);
        expect(toolMessage.content).toMatch(/Do not call it again/);
        expect(toolMessage.content).not.toMatch(/features\.json|DISABLED/);
    });

    test('a second attempt at the same tool, even with new arguments, executes nothing', async () => {
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [call('c1', 'tradeStock', { symbol: 'AAPL' })] })
            .mockResolvedValueOnce({ content: '', toolCalls: [call('c2', 'tradeStock', { symbol: 'MSFT' })] })
            .mockResolvedValueOnce({ content: 'Sorry, trading is off on this installation.', toolCalls: [] });
        const executeTool = jest.fn().mockResolvedValue(unavailable());

        const result = await runAgentLoop({ messages: messages(), functionDefs: DEFS, executeTool });

        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(result.toolTranscript).toHaveLength(2);
        expect(result.toolTranscript.every(entry => entry.unavailable && entry.isError)).toBe(true);
        expect(result.content).toBe('Sorry, trading is off on this installation.');
        expect(result.stopReason).toBeNull();
    });

    test('a model that keeps asking is stopped by the stall rule and still hands off an answer', async () => {
        for (let i = 0; i < MAX_STALLED_ROUNDS + 1; i++) {
            aiService.chat.mockResolvedValueOnce({ content: '', toolCalls: [call(`c${i}`, 'tradeStock', { n: i })] });
        }
        aiService.chat.mockResolvedValueOnce({ content: 'I cannot trade here; here is what I can do instead.', toolCalls: [] });
        const executeTool = jest.fn().mockResolvedValue(unavailable());

        const result = await runAgentLoop({ messages: messages(), functionDefs: DEFS, executeTool });

        expect(executeTool).toHaveBeenCalledTimes(1);
        expect(result.stopReason).toBe('stalled');
        expect(result.finalized).toBe(true);
        expect(result.content).toBe('I cannot trade here; here is what I can do instead.');
    });

    test('other tools in the same round still run, and the unavailable one counts toward the rounds', async () => {
        aiService.chat
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [call('a', 'tradeStock', {}), call('b', 'performSearch', { query: 'aapl' })]
            })
            .mockResolvedValueOnce({ content: 'AAPL is up, but I cannot trade it here.', toolCalls: [] });
        const executeTool = jest.fn(async (name) => (name === 'tradeStock' ? unavailable() : 'AAPL +2%'));

        const result = await runAgentLoop({ messages: messages(), functionDefs: DEFS, executeTool });

        expect(executeTool).toHaveBeenCalledTimes(2);
        expect(result.roundsUsed).toBe(2);
        expect(result.toolTranscript.map(entry => [entry.name, entry.isError])).toEqual([
            ['tradeStock', true], ['performSearch', false]
        ]);
        expect(result.content).toMatch(/cannot trade it here/);
    });

    test('nothing is ever enabled on the model\'s behalf', async () => {
        const writes = {
            existsSync: () => false,
            readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
            writeFileSync: jest.fn(),
            renameSync: jest.fn(),
            mkdirSync: jest.fn(),
            unlinkSync: jest.fn()
        };
        features._resetForTests({ fs: writes, filePath: FILE, env: {}, config: { token: 'x' } });
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [call('c1', 'tradeStock', {})] })
            .mockResolvedValueOnce({ content: 'Not available.', toolCalls: [] });
        await runAgentLoop({
            messages: messages(),
            functionDefs: DEFS,
            executeTool: async () => unavailable()
        });
        for (const name of ['writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync']) {
            expect(writes[name]).not.toHaveBeenCalled();
        }
        expect(features.status().source).toBe('none');
    });

    test('the real registry result is handled the same way', async () => {
        useFileState({ off: ['exchange'] });
        aiService.chat
            .mockResolvedValueOnce({ content: '', toolCalls: [call('c1', 'tradeStock', { action: 'buy', symbol: 'AAPL', units: 1 })] })
            .mockResolvedValueOnce({ content: 'Trading is off.', toolCalls: [] });

        const result = await runAgentLoop({ messages: messages(), functionDefs: DEFS });

        expect(result.content).toBe('Trading is off.');
        expect(result.toolTranscript[0]).toMatchObject({ name: 'tradeStock', isError: true, unavailable: true });
    });
});

describe('the same stale tool response through every provider', () => {
    const STALE = { name: 'tradeStock', args: { action: 'buy', symbol: 'AAPL', units: 1 } };
    const outcomes = {};

    function fixtures() {
        const usageTracker = require('@goobster/core/services/usageTracker');
        jest.spyOn(usageTracker, 'log').mockResolvedValue(undefined);

        const openai = require('@goobster/core/services/openaiService');
        const create = jest.fn()
            .mockResolvedValueOnce({
                output: [{ type: 'function_call', call_id: 'call_1', name: STALE.name, arguments: JSON.stringify(STALE.args) }],
                usage: { input_tokens: 1, output_tokens: 1 }
            })
            .mockResolvedValueOnce({
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'ANSWER' }] }],
                usage: { input_tokens: 1, output_tokens: 1 }
            });
        openai.client = { responses: { create } };

        const { AnthropicService } = require('@goobster/core/services/anthropicService');
        const anthropic = new AnthropicService();
        anthropic.apiKey = 'test-anthropic-key';

        const { GeminiService } = require('@goobster/core/services/geminiService');
        const gemini = new GeminiService();
        gemini.apiKey = 'test-gemini-key';

        const ollama = require('@goobster/core/services/ollamaService');

        return {
            openai: {
                service: openai,
                calls: () => create.mock.calls.length,
                install: () => {}
            },
            anthropic: {
                service: anthropic,
                calls: () => global.fetch.mock.calls.length,
                install: () => {
                    global.fetch = jest.fn()
                        .mockResolvedValueOnce({
                            ok: true,
                            json: async () => ({
                                content: [{ type: 'tool_use', id: 'toolu_1', name: STALE.name, input: STALE.args }],
                                usage: { input_tokens: 1, output_tokens: 1 }
                            })
                        })
                        .mockResolvedValueOnce({
                            ok: true,
                            json: async () => ({
                                content: [{ type: 'text', text: 'ANSWER' }],
                                usage: { input_tokens: 1, output_tokens: 1 }
                            })
                        });
                }
            },
            gemini: {
                service: gemini,
                calls: () => global.fetch.mock.calls.length,
                install: () => {
                    global.fetch = jest.fn()
                        .mockResolvedValueOnce({
                            ok: true,
                            json: async () => ({
                                candidates: [{ content: { parts: [{ functionCall: { name: STALE.name, args: STALE.args } }] } }],
                                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
                            })
                        })
                        .mockResolvedValueOnce({
                            ok: true,
                            json: async () => ({
                                candidates: [{ content: { parts: [{ text: 'ANSWER' }] } }],
                                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
                            })
                        });
                }
            },
            ollama: {
                service: ollama,
                calls: () => require('axios').post.mock.calls.length,
                install: () => {
                    jest.spyOn(require('axios'), 'post')
                        .mockResolvedValueOnce({
                            data: {
                                message: {
                                    content: `\`\`\`json\n${JSON.stringify({ tool_call: { name: STALE.name, arguments: STALE.args } })}\n\`\`\``
                                }
                            }
                        })
                        .mockResolvedValueOnce({ data: { message: { content: 'ANSWER' } } });
                }
            }
        };
    }

    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
        require('@goobster/core/services/openaiService').client = null;
    });

    test.each(['openai', 'anthropic', 'gemini', 'ollama'])('%s', async (providerName) => {
        useFileState({ off: ['exchange'] });
        const provider = fixtures()[providerName];
        provider.install();
        aiService.chat.mockReset();
        aiService.chat.mockImplementation((messages, options) => provider.service.chat(messages, options));

        const functionDefs = await toolsRegistry.getDefinitions();
        expect(names(functionDefs)).not.toContain(STALE.name);

        const stockPortfolioService = require('@goobster/core/services/stockPortfolioService');
        const buy = jest.spyOn(stockPortfolioService, 'buy').mockResolvedValue({});
        const policy = jest.spyOn(require('@goobster/core/services/personalPolicyService'), 'toolPolicy');

        const result = await runAgentLoop({
            messages: [
                { role: 'system', content: 'You are Goobster.' },
                { role: 'user', content: 'buy me a share of AAPL' }
            ],
            chatOptions: { model: undefined },
            functionDefs,
            interactionContext: { channelId: '700000000000000003', user: { id: '700000000000000002' } }
        });

        expect(result.content).toBe('ANSWER');
        expect(provider.calls()).toBe(2);
        expect(result.roundsUsed).toBe(2);
        expect(result.toolTranscript).toHaveLength(1);
        expect(buy).not.toHaveBeenCalled();
        expect(policy).not.toHaveBeenCalled();

        outcomes[providerName] = result.toolTranscript.map(entry => ({
            name: entry.name,
            isError: entry.isError,
            unavailable: entry.unavailable,
            result: entry.result
        }));
        expect(outcomes[providerName][0]).toMatchObject({ name: STALE.name, isError: true, unavailable: true });
        expect(outcomes[providerName][0].result).toMatch(/FEATURE_UNAVAILABLE/);
    });

    test('the outcome is identical across providers', () => {
        expect(Object.keys(outcomes).sort()).toEqual(['anthropic', 'gemini', 'ollama', 'openai']);
        const serialized = new Set(Object.values(outcomes).map(entry => JSON.stringify(entry)));
        expect(serialized.size).toBe(1);
    });
});

describe('the availability line in the system prompt', () => {
    const ALL_ON = {
        token: 'jest-placeholder',
        sandbox: { enabled: true },
        observatory: { enabled: true },
        mcp: { enabled: true },
        gbaRun: { enabled: true },
        screenVision: { enabled: true },
        activity: { enabled: true },
        mail: { provider: 'smtp', from: 'a@b.c', smtp: { host: 'h' } }
    };

    const promptFor = async () => (await buildConversationalPrompt({
        mode: 'chat',
        basePrompt: 'You are Goobster.',
        query: 'hey',
        guildId: 'dm:700000000000000002',
        userId: '700000000000000002',
        userName: 'Rob',
        botName: 'Goobster',
        isGuild: false
    })).prompt;

    function useAllOn(off = []) {
        const entries = {};
        for (const id of MANAGEABLE) entries[id] = { installed: true, active: !off.includes(id) };
        const text = JSON.stringify({
            version: 1, revision: 1, updatedAt: null, origin: 'operator', features: entries
        });
        features._resetForTests({
            fs: { existsSync: () => true, readFileSync: () => text },
            filePath: FILE,
            env: {},
            config: ALL_ON
        });
    }

    test('is omitted when every feature with a tool is active', async () => {
        useAllOn();
        expect(unavailableFeatureTitles()).toEqual([]);
        expect(await promptFor()).not.toMatch(/UNAVAILABLE HERE/);
    });

    test('names the inactive features by title, once, without paths or settings', async () => {
        useAllOn(['music', 'exchange', 'gambling']);
        const prompt = await promptFor();
        const lines = prompt.split('\n').filter(line => line.startsWith('UNAVAILABLE HERE'));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('Music');
        expect(lines[0]).toContain('Exchange');
        expect(lines[0]).toContain('Gambling');
        expect(lines[0]).not.toMatch(/features\.json|GOOBSTER_|config\.json|\/data\//);
        expect(lines[0].length).toBeLessThan(300);
    });

    test('lists only features that own a model tool, derived rather than hardcoded', () => {
        useAllOn(['mcp', 'gba', 'screenVision', 'discordActivity', 'mail', 'push', 'tavern']);
        expect(unavailableFeatureTitles()).toEqual(['Tavern']);
    });

    test('a feature whose dependency is off is listed alongside it', () => {
        useAllOn(['sandbox']);
        expect(unavailableFeatureTitles().sort()).toEqual(['Observatory', 'Sandbox']);
    });

    test('carries no secret values from config or env', async () => {
        features._resetForTests({
            fs: { existsSync: () => false, readFileSync: () => { throw new Error('none'); } },
            filePath: FILE,
            env: { OPENAI_API_KEY: 'sk-secret-env-value', GOOBSTER_FEATURE_TAVERN: 'off' },
            config: { token: 'secret-discord-token', github: { token: 'ghp_secret' } }
        });
        const prompt = await promptFor();
        for (const secret of ['secret-discord-token', 'sk-secret-env-value', 'ghp_secret']) {
            expect(prompt).not.toContain(secret);
        }
        expect(prompt).toMatch(/UNAVAILABLE HERE:.*Tavern/);
    });

    test('featureAvailabilityLine formats one line and returns null for nothing', () => {
        expect(featureAvailabilityLine([])).toBeNull();
        expect(featureAvailabilityLine(undefined)).toBeNull();
        expect(featureAvailabilityLine(['Music', 'Music', ' '])).toMatch(/^UNAVAILABLE HERE: Music is switched off/);
        expect(featureAvailabilityLine(['Music', 'Voice'])).toMatch(/Music, Voice are switched off/);
    });
});
