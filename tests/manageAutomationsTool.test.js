/**
 * Assistant routing for scheduling work (utils/toolsRegistry.js +
 * utils/toolPromptBuilder.js): recurring requests must land on the
 * manageAutomations tool (durable automations), while scheduleFollowUp
 * stays a strictly one-time reminder facility. Covers the definitions the
 * model sees, the shared scheduling guidance, the tool's execute paths in
 * guild/DM/web contexts, and an agent-loop turn where the model's
 * manageAutomations call lands in the automations table.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-mngauto-tool-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// These wrapped commands boot heavy voice/music services at load time; the
// registry tests only need the registry itself.
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));

jest.mock('../services/aiService', () => ({
    chat: jest.fn(),
    chatText: jest.fn(),
    generateText: jest.fn(),
    supportsNativeWebSearch: jest.fn().mockReturnValue(false)
}));

const db = require('../db');
const aiService = require('../services/aiService');
const toolsRegistry = require('../utils/toolsRegistry');
const { buildNativeToolGuidance, buildPromptBasedToolPrompt } = require('../utils/toolPromptBuilder');
const { runAgentLoop } = require('../utils/chat/agentOrchestrator');
const { dmScopeId } = require('../utils/dmScope');

const USER = '720000000000000001';
const GUILD = '820000000000000001';
const CHANNEL = '920000000000000001';
const DM_CHANNEL = '930000000000000001';

const guildContext = () => ({
    guildId: GUILD,
    channelId: CHANNEL,
    channel: { id: CHANNEL },
    user: { id: USER, username: 'rob' }
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    db.run('DELETE FROM automations');
});

describe('tool selection surface (what the model is offered)', () => {
    test('manageAutomations is offered everywhere, with a well-formed action contract', () => {
        for (const opts of [undefined, { isWeb: true }]) {
            const defs = toolsRegistry.getDefinitions(undefined, opts);
            const def = defs.find(d => d.name === 'manageAutomations');
            expect(def).toBeTruthy();
            expect(def.parameters.required).toEqual(['action']);
            expect(def.parameters.properties.action.enum)
                .toEqual(['create', 'list', 'pause', 'resume', 'cancel']);
        }
    });

    test('manageAutomations advertises durable recurring work; scheduleFollowUp advertises tool-less reminders', () => {
        const defs = toolsRegistry.getDefinitions();
        const automations = defs.find(d => d.name === 'manageAutomations');
        expect(automations.description).toMatch(/recurring/i);
        expect(automations.description).toMatch(/survive bot restarts/i);
        expect(automations.description).toMatch(/never a chain of one-time follow-ups/i);

        // Follow-ups are reminders: one-shot by default, optionally
        // repeating a fixed note - a delivery never runs tools, so the
        // description must redirect recurring WORK to manageAutomations.
        const followUp = defs.find(d => d.name === 'scheduleFollowUp');
        expect(followUp.description).toMatch(/One-time by default/);
        expect(followUp.description).toMatch(/run no tools/);
        expect(followUp.description).toMatch(/recurring WORK/);
        expect(followUp.description).toContain('manageAutomations');
    });

    test('the shared scheduling guidance routes recurring work to manageAutomations on every provider', () => {
        const native = buildNativeToolGuidance();
        expect(native).toContain('SCHEDULING REQUESTS');
        expect(native).toMatch(/Recurring WORK.*every hour.*manageAutomations/s);
        expect(native).toMatch(/reposts a fixed note.*scheduleFollowUp with repeat/s);
        expect(native).toMatch(/scheduleFollowUp without repeat.*exactly once/s);
        expect(native).toMatch(/NEVER simulate recurrence by chaining one-time follow-ups/);

        const promptBased = buildPromptBasedToolPrompt(toolsRegistry.getDefinitions());
        expect(promptBased).toContain('SCHEDULING REQUESTS');
        expect(promptBased).toMatch(/NEVER simulate recurrence by chaining one-time follow-ups/);
    });
});

describe('execute: guild conversations', () => {
    test('create makes a durable hourly guild automation delivered to this channel', async () => {
        const result = await toolsRegistry.execute('manageAutomations', {
            action: 'create', name: 'hourly lab check',
            prompt: 'Check the lab sensor feed and post a status summary',
            cron: '0 * * * *',
            interactionContext: guildContext()
        });

        expect(result).toMatch(/^✅ Created automation "hourly lab check"/);
        expect(result).toContain('survives restarts');

        const row = db.get('SELECT * FROM automations WHERE userId = @u', { u: USER });
        expect(row).toMatchObject({
            guildId: GUILD, channelId: CHANNEL,
            name: 'hourly lab check', schedule: '0 * * * *', isEnabled: 1
        });
        expect(row.nextRun).toBeTruthy();
    });

    test('list, pause, resume, and cancel manage the row by name', async () => {
        const context = guildContext();
        await toolsRegistry.execute('manageAutomations', {
            action: 'create', name: 'hourly lab check', prompt: 'Check the feed', cron: '0 * * * *',
            interactionContext: context
        });

        const listed = await toolsRegistry.execute('manageAutomations', { action: 'list', interactionContext: context });
        expect(listed).toContain('"hourly lab check"');
        expect(listed).toContain('`0 * * * *`');
        expect(listed).toContain('🟢 active');

        const paused = await toolsRegistry.execute('manageAutomations', {
            action: 'pause', name: 'hourly lab check', interactionContext: context
        });
        expect(paused).toContain('paused');
        expect(db.get('SELECT isEnabled, nextRun FROM automations WHERE userId = @u', { u: USER }))
            .toMatchObject({ isEnabled: 0, nextRun: null });

        const resumed = await toolsRegistry.execute('manageAutomations', {
            action: 'resume', name: 'hourly lab check', interactionContext: context
        });
        expect(resumed).toContain('resumed');
        expect(db.get('SELECT isEnabled FROM automations WHERE userId = @u', { u: USER }).isEnabled).toBe(1);

        const cancelled = await toolsRegistry.execute('manageAutomations', {
            action: 'cancel', name: 'hourly lab check', interactionContext: context
        });
        expect(cancelled).toContain('cancelled');
        expect(db.get('SELECT 1 AS ok FROM automations WHERE userId = @u', { u: USER })).toBeUndefined();
    });

    test('create is refused on an unattended automation turn (no self-replication)', async () => {
        const result = await toolsRegistry.execute('manageAutomations', {
            action: 'create', name: 'hourly clone',
            prompt: 'Check the lab feed', cron: '0 * * * *',
            interactionContext: { ...guildContext(), isAutomation: true }
        });
        expect(result).toMatch(/^❌/);
        expect(result).toMatch(/scheduled automation run/i);
        expect(db.get('SELECT 1 AS ok FROM automations WHERE userId = @u', { u: USER })).toBeUndefined();

        // Read-only management still works on automation turns
        const listed = await toolsRegistry.execute('manageAutomations', {
            action: 'list', interactionContext: { ...guildContext(), isAutomation: true }
        });
        expect(listed).toBe('You have no automations here.');
    });

    test('validation failures surface as recoverable observations, never throws', async () => {
        const tooFrequent = await toolsRegistry.execute('manageAutomations', {
            action: 'create', name: 'spam', prompt: 'p', cron: '* * * * *',
            interactionContext: guildContext()
        });
        expect(tooFrequent).toMatch(/^❌/);
        expect(tooFrequent).toContain('every 15 minutes');

        const badCron = await toolsRegistry.execute('manageAutomations', {
            action: 'create', name: 'bad', prompt: 'p', cron: 'whenever',
            interactionContext: guildContext()
        });
        expect(badCron).toMatch(/^❌/);

        const missing = await toolsRegistry.execute('manageAutomations', {
            action: 'cancel', name: 'no such thing', interactionContext: guildContext()
        });
        expect(missing).toMatch(/^❌/);

        const noUser = await toolsRegistry.execute('manageAutomations', { action: 'list' });
        expect(noUser).toMatch(/^❌/);
    });
});

describe('execute: DM and web conversations', () => {
    test('a Discord DM creates a DM-scope automation delivered to that DM channel', async () => {
        const result = await toolsRegistry.execute('manageAutomations', {
            action: 'create', name: 'morning brief', prompt: 'Summarize my day', cron: '0 9 * * *',
            interactionContext: {
                guildId: null, channelId: DM_CHANNEL, channel: { id: DM_CHANNEL },
                user: { id: USER, username: 'rob' }
            }
        });
        expect(result).toMatch(/^✅/);
        expect(result).toContain('your Discord DMs');

        const row = db.get('SELECT guildId, channelId FROM automations WHERE userId = @u', { u: USER });
        expect(row).toEqual({ guildId: dmScopeId(USER), channelId: DM_CHANNEL });
    });

    test('a web chat resolves the user\'s Discord DM channel for delivery', async () => {
        const createDM = jest.fn().mockResolvedValue({ id: DM_CHANNEL });
        const result = await toolsRegistry.execute('manageAutomations', {
            action: 'create', name: 'web brief', prompt: 'Summarize my day', cron: '0 9 * * *',
            interactionContext: {
                guildId: null, channelId: `web:${USER}:abc`,
                user: { id: USER, username: 'rob' },
                client: { users: { fetch: jest.fn().mockResolvedValue({ id: USER, createDM }) } }
            }
        });
        expect(result).toMatch(/^✅/);
        expect(createDM).toHaveBeenCalled();

        const row = db.get('SELECT guildId, channelId FROM automations WHERE userId = @u', { u: USER });
        expect(row).toEqual({ guildId: dmScopeId(USER), channelId: DM_CHANNEL });
    });

    test('a web chat with unreachable DMs refuses with a clear observation', async () => {
        const result = await toolsRegistry.execute('manageAutomations', {
            action: 'create', name: 'web brief', prompt: 'p', cron: '0 9 * * *',
            interactionContext: {
                guildId: null, channelId: `web:${USER}:abc`,
                user: { id: USER, username: 'rob' },
                client: { users: { fetch: jest.fn().mockRejectedValue(new Error('blocked')) } }
            }
        });
        expect(result).toMatch(/^❌/);
        expect(db.get('SELECT 1 AS ok FROM automations WHERE userId = @u', { u: USER })).toBeUndefined();
    });
});

describe('assistant routing through the agent loop', () => {
    test('a recurring hourly request handled with manageAutomations lands in the automations table', async () => {
        aiService.chat
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [{
                    id: 'c1', name: 'manageAutomations',
                    arguments: JSON.stringify({
                        action: 'create', name: 'neurogene lab hourly',
                        prompt: 'Check the neurogene lab feed and post a status summary',
                        cron: '0 * * * *'
                    })
                }]
            })
            .mockResolvedValueOnce({
                content: 'Done - I will check the lab feed every hour on the hour.', toolCalls: []
            });

        const interactionContext = guildContext();
        const result = await runAgentLoop({
            messages: [
                { role: 'system', content: buildNativeToolGuidance() },
                { role: 'user', content: 'Check the neurogene lab feed every hour and post a status summary.' }
            ],
            functionDefs: toolsRegistry.getDefinitions(),
            interactionContext,
            executeTool: (name, args) => toolsRegistry.execute(name, args)
        });

        expect(result.content).toContain('every hour');
        expect(result.toolTranscript.map(t => t.name)).toEqual(['manageAutomations']);
        expect(result.toolTranscript[0].isError).toBe(false);

        // The durable artifact: a real automations row, not a followup
        const row = db.get('SELECT * FROM automations WHERE userId = @u', { u: USER });
        expect(row).toMatchObject({
            name: 'neurogene lab hourly', schedule: '0 * * * *',
            guildId: GUILD, channelId: CHANNEL, isEnabled: 1
        });
        expect(db.get('SELECT COUNT(*) AS c FROM followups').c).toBe(0);
    });
});
