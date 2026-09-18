/**
 * The agent loop driving the Observatory's pipeline actions end to end:
 * a scripted model plans a nine-step setup (project, two scripts, a cron
 * stage with an output contract, a filtered event stage, a foreground
 * run, list/audit/inspect) and runAgentLoop executes every step through
 * the REAL tools registry against a throwaway SQLite file and the real
 * sandbox. Proves (a) every new set_trigger parameter is reachable from a
 * model tool call, and (b) a multi-step project task completes under the
 * project budget where the conversational budget would have handed off
 * mid-sequence.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-agent-loop-obs-${process.pid}.sqlite`);

jest.mock('@goobster/core/services/aiService', () => ({
    chat: jest.fn(),
    generateText: jest.fn().mockResolvedValue(''),
    supportsNativeWebSearch: jest.fn().mockReturnValue(false),
    getProvider: jest.fn(() => 'openai')
}));

const aiService = require('@goobster/core/services/aiService');
const db = require('@goobster/core/db');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const sandboxConfig = require('@goobster/core/config/sandboxConfig');
const observatoryConfig = require('@goobster/core/config/observatoryConfig');
const { PROJECTS_ROOT } = require('@goobster/core/services/observatoryService');
const {
    runAgentLoop,
    MAX_TOOL_ROUNDS,
    PROJECT_MAX_TOOL_ROUNDS
} = require('@goobster/core/utils/chat/agentOrchestrator');

const TEST_USER = `agent-loop-user-${process.pid}`;
const original = {
    sandboxEnabled: sandboxConfig.enabled,
    sandboxScope: sandboxConfig.scope,
    sandboxIsolation: sandboxConfig.requireStrongIsolation,
    obsEnabled: observatoryConfig.enabled,
    obsScope: observatoryConfig.scope
};

const FETCH_SCRIPT = [
    'import json, os, datetime',
    'root = os.environ["GOOBSTER_PROJECT_DIR"]',
    'os.makedirs(os.path.join(root, "pipeline"), exist_ok=True)',
    'today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")',
    'with open(os.path.join(root, "pipeline", f"fetch_manifest_{today}.json"), "w") as f:',
    '    json.dump({"rows": 3}, f)',
    'print("manifest written")'
].join('\n');

const REQUIRED_OUTPUTS = [{ path: 'pipeline/fetch_manifest_{utc_date}.json', type: 'json', minBytes: 2 }];

/** The nine tool steps a model would plan for "set up a two-stage pipeline". */
function pipelinePlan(project) {
    return [
        { action: 'create-project', name: project },
        { action: 'save_script', project, name: 'fetch', language: 'python', code: FETCH_SCRIPT },
        { action: 'save_script', project, name: 'build', language: 'python', code: 'print("build stage")' },
        {
            action: 'set_trigger', project, name: 'fetch-daily', kind: 'cron', schedule: '0 6 * * *',
            triggerAction: 'run_script', slug: 'fetch', background: true, requiredOutputs: REQUIRED_OUTPUTS
        },
        {
            action: 'set_trigger', project, name: 'build-after-fetch', kind: 'event', eventTopic: 'job_completed',
            triggerAction: 'run_script', slug: 'build', sourceAsset: 'fetch'
        },
        { action: 'run_script', project, slug: 'fetch' },
        { action: 'list_triggers', project },
        { action: 'audit', project },
        { action: 'inspect', project }
    ];
}

/**
 * A scripted model: round n requests plan[n]; after the plan it writes the
 * final answer; any system nudge makes it hand off.
 */
function scriptedModel(plan, { finalAnswer, handoff }) {
    return async (messages) => {
        const nudged = messages.some(m => m.role === 'system' && /EXHAUSTED|TIME LIMIT|NO PROGRESS/.test(m.content));
        if (nudged) return { content: handoff, toolCalls: [] };
        const n = messages.filter(m => m.role === 'tool').length;
        if (n >= plan.length) return { content: finalAnswer, toolCalls: [] };
        return {
            content: n === 0 ? 'Setting up the pipeline.' : '',
            toolCalls: [{ id: `call-${n}`, name: 'observatory', arguments: JSON.stringify(plan[n]) }]
        };
    };
}

const webContext = () => ({
    channelId: `web:${TEST_USER}:loop`,
    user: { id: TEST_USER, username: 'loop-user' },
    channel: { send: async () => ({}) }
});

beforeEach(() => {
    jest.clearAllMocks();
    sandboxConfig.enabled = true;
    sandboxConfig.scope = 'web';
    sandboxConfig.requireStrongIsolation = false;
    observatoryConfig.enabled = true;
    observatoryConfig.scope = 'web';
});

afterEach(() => {
    sandboxConfig.enabled = original.sandboxEnabled;
    sandboxConfig.scope = original.sandboxScope;
    sandboxConfig.requireStrongIsolation = original.sandboxIsolation;
    observatoryConfig.enabled = original.obsEnabled;
    observatoryConfig.scope = original.obsScope;
});

afterAll(async () => {
    await db.closeConnection();
    try { fs.rmSync(path.join(PROJECTS_ROOT, TEST_USER), { recursive: true, force: true }); } catch { /* gone */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(`${process.env.GOOBSTER_DB_PATH}${suffix}`, { force: true }); } catch { /* held open */ }
    }
});

describe('runAgentLoop × observatory tool (real registry)', () => {
    test('the model wires a two-stage pipeline in nine tool steps under the project budget', async () => {
        const plan = pipelinePlan('Loop Pipeline Lab');
        expect(plan.length).toBeGreaterThan(MAX_TOOL_ROUNDS); // the chat budget could not finish this
        aiService.chat.mockImplementation(scriptedModel(plan, {
            finalAnswer: 'Pipeline ready: fetch runs daily with an output contract, build follows only fetch.',
            handoff: 'Handed off early.'
        }));
        const functionDefs = await toolsRegistry.getDefinitions(['observatory'], { isWeb: true });
        expect(functionDefs.map(d => d.name)).toEqual(['observatory']);
        const toolEvents = [];

        const result = await runAgentLoop({
            messages: [
                { role: 'system', content: 'You are Goobster.' },
                { role: 'user', content: 'Set up a two-stage fetch → build pipeline in a new project.' }
            ],
            functionDefs,
            interactionContext: webContext(),
            maxToolRounds: PROJECT_MAX_TOOL_ROUNDS,
            onToolEvent: (event) => toolEvents.push(event)
        });

        expect(result.aborted).toBe(false);
        expect(result.stopReason).toBeNull();
        expect(result.finalized).toBe(false);
        expect(result.content).toBe('Pipeline ready: fetch runs daily with an output contract, build follows only fetch.');
        expect(result.toolTranscript).toHaveLength(plan.length);
        expect(result.toolTranscript.every(t => t.isError === false)).toBe(true);
        expect(result.toolTranscript.every(t => !/^❌/.test(t.result))).toBe(true);
        // Each step was reported to the UI as start + result
        expect(toolEvents.filter(e => e.phase === 'start')).toHaveLength(plan.length);
        expect(toolEvents.filter(e => e.phase === 'result')).toHaveLength(plan.length);

        const [created, fetchSaved, buildSaved, cronSet, eventSet, ran, listed, audited, inspected] =
            result.toolTranscript.map(t => t.result);
        expect(created).toContain('loop-pipeline-lab');
        expect(fetchSaved).toMatch(/Saved script "fetch"/);
        expect(buildSaved).toMatch(/Saved script "build"/);

        // Stage 2: cron + output contract, echoed back to the model
        expect(cronSet).toMatch(/Armed trigger "fetch-daily"/);
        expect(cronSet).toMatch(/cron `0 6 \* \* \*`/);
        expect(cronSet).toContain('requires pipeline/fetch_manifest_{utc_date}.json');

        // Stage 3: event trigger filtered to the fetch asset
        expect(eventSet).toMatch(/Armed trigger "build-after-fetch"/);
        expect(eventSet).toMatch(/on job_completed \(from asset #\d+\)/);

        // The foreground run produced the manifest for today
        expect(ran).toMatch(/✅ Ran "fetch" v1/);
        expect(ran).toContain('manifest written');
        const today = new Date().toISOString().slice(0, 10);
        expect(fs.existsSync(path.join(PROJECTS_ROOT, TEST_USER, 'loop-pipeline-lab', 'pipeline', `fetch_manifest_${today}.json`))).toBe(true);

        // list / audit / inspect read the filters and contract back
        expect(listed).toMatch(/"fetch-daily" · cron 0 6 \* \* \* → run_script/);
        expect(listed).toContain('1 required output(s)');
        expect(listed).toMatch(/"build-after-fetch" · job_completed \(from asset #\d+\) → run_script/);
        expect(audited).not.toMatch(/trigger_source_asset_missing|trigger_output_contract_invalid|trigger_unfiltered_fanout/);
        expect(audited).not.toMatch(/^❌/);
        expect(inspected).toContain('loop-pipeline-lab');
        expect(inspected).toMatch(/Triggers/);

        // Persisted exactly as the service contract says
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId: TEST_USER, slug: 'loop-pipeline-lab' }
        );
        const fetchAsset = await db.get(
            'SELECT id FROM project_assets WHERE projectId = @projectId AND slug = @slug',
            { projectId: project.id, slug: 'fetch' }
        );
        const triggers = await db.all(
            'SELECT name, kind, sourceAssetId, sourceTriggerId, actionAssetId, actionParams FROM project_triggers WHERE projectId = @projectId ORDER BY id',
            { projectId: project.id }
        );
        expect(triggers).toHaveLength(2);
        const cron = triggers.find(t => t.name === 'fetch-daily');
        const event = triggers.find(t => t.name === 'build-after-fetch');
        expect(cron.sourceAssetId).toBeNull();
        expect(JSON.parse(cron.actionParams).requiredOutputs).toEqual(REQUIRED_OUTPUTS);
        expect(cron.actionAssetId).toBe(fetchAsset.id);
        expect(event.sourceAssetId).toBe(fetchAsset.id);
        expect(event.sourceTriggerId).toBeNull();
    }, 60_000);

    test('the same plan under the conversational budget hands off mid-sequence with an explicit stop reason', async () => {
        const plan = pipelinePlan('Loop Budget Lab');
        aiService.chat.mockImplementation(scriptedModel(plan, {
            finalAnswer: 'never reached',
            handoff: 'Handoff: project and scripts saved; the triggers still need wiring - say continue.'
        }));
        const functionDefs = await toolsRegistry.getDefinitions(['observatory'], { isWeb: true });

        const result = await runAgentLoop({
            messages: [{ role: 'system', content: 'You are Goobster.' }, { role: 'user', content: 'Set up the pipeline.' }],
            functionDefs,
            interactionContext: webContext(),
            maxToolRounds: MAX_TOOL_ROUNDS
        });

        // Bounded, but never silent: the user gets a handoff naming what is left.
        expect(result.stopReason).toBe('rounds');
        expect(result.finalized).toBe(true);
        expect(result.toolTranscript).toHaveLength(MAX_TOOL_ROUNDS);
        expect(result.content).toMatch(/say continue/);
    }, 60_000);

    test('a set_trigger step with a bad filter comes back as an observation the model can correct, not a crash', async () => {
        const project = 'Loop Recovery Lab';
        const plan = [
            { action: 'create-project', name: project },
            { action: 'save_script', project, name: 'build', language: 'python', code: 'print(1)' },
            // Wrong: filters on a script that does not exist in this project
            {
                action: 'set_trigger', project, name: 'after-fetch', kind: 'event', eventTopic: 'job_completed',
                triggerAction: 'run_script', slug: 'build', sourceAsset: 'fetch'
            },
            // Corrected on the next round
            {
                action: 'set_trigger', project, name: 'after-fetch', kind: 'event', eventTopic: 'job_completed',
                triggerAction: 'run_script', slug: 'build', sourceAsset: 'build', allowSelfChain: false
            }
        ];
        aiService.chat.mockImplementation(scriptedModel(plan, { finalAnswer: 'Fixed the filter.', handoff: 'x' }));
        const functionDefs = await toolsRegistry.getDefinitions(['observatory'], { isWeb: true });

        const result = await runAgentLoop({
            messages: [{ role: 'system', content: 'You are Goobster.' }, { role: 'user', content: 'Wire it.' }],
            functionDefs,
            interactionContext: webContext(),
            maxToolRounds: PROJECT_MAX_TOOL_ROUNDS
        });

        expect(result.content).toBe('Fixed the filter.');
        const [, , bad, good] = result.toolTranscript.map(t => t.result);
        expect(bad).toMatch(/^❌/);
        expect(bad).toMatch(/sourceAsset must be a script asset in this project/);
        expect(good).toMatch(/Armed trigger "after-fetch"/);
        expect(good).toMatch(/from asset #\d+/);
    }, 60_000);
});
