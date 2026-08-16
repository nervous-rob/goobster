/**
 * Assistant routing between the two scheduling tools (utils/toolsRegistry.js):
 * recurring work must land in durable automations (manageAutomation) and
 * one-time reminders in followups (scheduleFollowUp). Covers the tool
 * definitions the model sees, the recurring-request guard on follow-ups, and
 * the manageAutomation create/list/pause/resume/update/cancel round trip in
 * guild and DM scope.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-schedtool-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// These wrapped commands boot heavy voice/music services at load time; the
// scheduling tools only need the registry itself.
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));
jest.mock('../services/aiService', () => ({
    chatText: jest.fn(),
    generateText: jest.fn()
}));

const db = require('../db');
const aiService = require('../services/aiService');
const toolsRegistry = require('../utils/toolsRegistry');
const followupService = require('../services/followupService');
const { dmScopeId } = require('../utils/dmScope');

const USER = '720000000000000001';
const GUILD = '820000000000000001';
const CHANNEL = '920000000000000001';
const DM_CHANNEL = '930000000000000001';

const guildContext = {
    guildId: GUILD,
    channelId: CHANNEL,
    channel: { id: CHANNEL },
    user: { id: USER }
};

const dmContext = {
    guildId: null,
    user: { id: USER },
    client: {
        users: {
            fetch: jest.fn().mockResolvedValue({
                id: USER,
                createDM: jest.fn().mockResolvedValue({ id: DM_CHANNEL })
            })
        }
    }
};

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    db.run('DELETE FROM automations');
    db.run('DELETE FROM followups');
});

describe('tool definitions the model routes on', () => {
    const definitions = toolsRegistry.getDefinitions();
    const byName = Object.fromEntries(definitions.map(def => [def.name, def]));

    test('both scheduling tools are offered', () => {
        expect(byName.manageAutomation).toBeDefined();
        expect(byName.scheduleFollowUp).toBeDefined();
    });

    test('manageAutomation is described as the recurring path', () => {
        const description = byName.manageAutomation.description;
        expect(description).toMatch(/recurring/i);
        expect(description).toMatch(/survive bot restarts/i);
        expect(description).toMatch(/never scheduleFollowUp/i);
        expect(byName.manageAutomation.parameters.properties.action.enum)
            .toEqual(['create', 'list', 'pause', 'resume', 'update', 'cancel']);
    });

    test('scheduleFollowUp is described as strictly one-time and routes recurring work away', () => {
        const description = byName.scheduleFollowUp.description;
        expect(description).toMatch(/strictly one-time/i);
        expect(description).toMatch(/use manageAutomation/i);
        expect(description).toMatch(/never chain follow-ups/i);
    });
});

describe('scheduleFollowUp stays one-time only', () => {
    test.each(['every hour', 'hourly', 'each morning', 'daily at 9am', 'once per week'])(
        'refuses the recurring request "%s" and points to manageAutomation',
        async (when) => {
            const result = await toolsRegistry.execute('scheduleFollowUp', {
                note: 'Check the lab feed', when, interactionContext: guildContext
            });
            expect(result).toMatch(/one-time/);
            expect(result).toMatch(/manageAutomation/);
            expect(db.get('SELECT COUNT(*) AS c FROM followups').c).toBe(0);
            expect(aiService.generateText).not.toHaveBeenCalled();
        }
    );

    test('still schedules a genuine one-time follow-up', async () => {
        const future = new Date(Date.now() + 2 * 60 * 60 * 1000)
            .toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        aiService.generateText.mockResolvedValue(future);

        const result = await toolsRegistry.execute('scheduleFollowUp', {
            note: 'Ask Rob how the deploy went', when: 'in 2 hours', interactionContext: guildContext
        });
        expect(result).toMatch(/Follow-up scheduled/);
        const row = db.get('SELECT * FROM followups');
        expect(row).toMatchObject({ guildId: GUILD, channelId: CHANNEL, status: 'PENDING' });
    });

    test('followupService.schedule enforces the same contract for any caller', async () => {
        await expect(followupService.schedule({
            guildId: GUILD, channelId: CHANNEL, note: 'n', whenDescription: 'every hour'
        })).rejects.toThrow(/one-time only/);
    });
});

describe('manageAutomation round trip (guild scope)', () => {
    test('create -> list -> pause -> resume -> update -> cancel', async () => {
        const created = await toolsRegistry.execute('manageAutomation', {
            action: 'create', name: 'lab-check',
            prompt: 'Check the lab feed for anomalies.', schedule: 'every hour',
            interactionContext: guildContext
        });
        expect(created).toMatch(/created/);
        expect(created).toMatch(/0 \* \* \* \*/);
        expect(created).toMatch(/persists across restarts/);
        expect(db.get('SELECT * FROM automations')).toMatchObject({
            userId: USER, guildId: GUILD, channelId: CHANNEL,
            name: 'lab-check', schedule: '0 * * * *', isEnabled: 1
        });

        const listed = await toolsRegistry.execute('manageAutomation', {
            action: 'list', interactionContext: guildContext
        });
        expect(listed).toMatch(/"lab-check"/);
        expect(listed).toMatch(/Next run:/);

        const paused = await toolsRegistry.execute('manageAutomation', {
            action: 'pause', name: 'lab-check', interactionContext: guildContext
        });
        expect(paused).toMatch(/paused/);
        expect(db.get('SELECT isEnabled, nextRun FROM automations')).toEqual({ isEnabled: 0, nextRun: null });

        const resumed = await toolsRegistry.execute('manageAutomation', {
            action: 'resume', name: 'lab-check', interactionContext: guildContext
        });
        expect(resumed).toMatch(/resumed/);
        expect(db.get('SELECT isEnabled FROM automations').isEnabled).toBe(1);

        const updated = await toolsRegistry.execute('manageAutomation', {
            action: 'update', name: 'lab-check', schedule: 'daily', interactionContext: guildContext
        });
        expect(updated).toMatch(/updated/);
        expect(db.get('SELECT schedule FROM automations').schedule).toBe('0 0 * * *');

        const cancelled = await toolsRegistry.execute('manageAutomation', {
            action: 'cancel', name: 'lab-check', interactionContext: guildContext
        });
        expect(cancelled).toMatch(/cancelled/);
        expect(db.get('SELECT COUNT(*) AS c FROM automations').c).toBe(0);
    });

    test('duplicate names are refused as errors the model can relay', async () => {
        await toolsRegistry.execute('manageAutomation', {
            action: 'create', name: 'lab-check', prompt: 'p', schedule: 'every hour',
            interactionContext: guildContext
        });
        const result = await toolsRegistry.execute('manageAutomation', {
            action: 'create', name: 'lab-check', prompt: 'p', schedule: 'every hour',
            interactionContext: guildContext
        });
        expect(result).toMatch(/already exists/);
        expect(db.get('SELECT COUNT(*) AS c FROM automations').c).toBe(1);
    });

    test('sub-15-minute cadences are refused', async () => {
        const result = await toolsRegistry.execute('manageAutomation', {
            action: 'create', name: 'too-fast', prompt: 'p', schedule: '* * * * *',
            interactionContext: guildContext
        });
        expect(result).toMatch(/at most every 15 minutes/);
        expect(db.get('SELECT COUNT(*) AS c FROM automations').c).toBe(0);
    });
});

describe('manageAutomation in DM scope', () => {
    test('creates a DM-scope automation delivered to the user\'s DM channel', async () => {
        const result = await toolsRegistry.execute('manageAutomation', {
            action: 'create', name: 'morning-brief', prompt: 'Summarize my day.', schedule: 'daily',
            interactionContext: dmContext
        });
        expect(result).toMatch(/created/);
        expect(db.get('SELECT * FROM automations')).toMatchObject({
            userId: USER, guildId: dmScopeId(USER), channelId: DM_CHANNEL,
            schedule: '0 0 * * *'
        });
    });

    test('needs a known user', async () => {
        const result = await toolsRegistry.execute('manageAutomation', {
            action: 'list', interactionContext: {}
        });
        expect(result).toMatch(/known user/);
    });
});
