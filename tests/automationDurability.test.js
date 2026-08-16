/**
 * Durability contract for recurring automations: rows live in SQLite, so an
 * hourly workflow survives restarts (a fresh AutomationService picks up the
 * same row), each due occurrence executes exactly once (nextRun advances
 * after the run), and a failed run still advances nextRun instead of
 * re-firing the same occurrence (retry happens at the next cadence, never as
 * a duplicate of the missed one).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-autodur-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../utils/chatHandler', () => ({
    handleChatInteraction: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../services/aiService', () => ({
    chatText: jest.fn(),
    generateText: jest.fn()
}));

const db = require('../db');
const { handleChatInteraction } = require('../utils/chatHandler');
const AutomationService = require('../services/automationService');
const automationManagementService = require('../services/automationManagementService');

const USER = '710000000000000001';
const GUILD = '810000000000000001';
const CHANNEL = '910000000000000001';

// The exact due-row query automationService's minute poll runs.
const DUE_SQL = `
    SELECT a.id, a.userId, a.guildId, a.channelId,
           a.name, a.promptText, a.schedule, a.metadata
    FROM automations a
    WHERE a.isEnabled = 1
    AND a.nextRun <= CURRENT_TIMESTAMP
`;

function makeClient() {
    const channel = {
        id: CHANNEL,
        send: jest.fn().mockResolvedValue({ id: 'message-1' }),
        sendTyping: jest.fn().mockResolvedValue(undefined)
    };
    const member = { user: { id: USER, username: 'rob' }, displayName: 'Rob' };
    const guild = { id: GUILD, name: 'Test Guild', members: { fetch: jest.fn().mockResolvedValue(member) } };
    return {
        user: { id: '810000000000000099', username: 'Goobster' },
        channels: { fetch: jest.fn().mockResolvedValue(channel) },
        guilds: { fetch: jest.fn().mockResolvedValue(guild) }
    };
}

/** Create an hourly automation and backdate nextRun so it is due now. */
async function createDueHourlyAutomation(name = 'lab-check') {
    const created = await automationManagementService.create({
        userId: USER, scopeId: GUILD, channelId: CHANNEL,
        name, prompt: 'Check the lab feed for anomalies.', schedule: 'every hour'
    });
    db.run(
        `UPDATE automations SET nextRun = datetime('now', '-5 minutes') WHERE id = @id`,
        { id: created.id }
    );
    return created;
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    handleChatInteraction.mockReset();
    handleChatInteraction.mockResolvedValue(undefined);
    db.run('DELETE FROM automations');
});

describe('hourly execution', () => {
    test('a due hourly automation runs once and advances to the next hour', async () => {
        await createDueHourlyAutomation();
        const service = new AutomationService(makeClient());

        const due = db.all(DUE_SQL);
        expect(due).toHaveLength(1);
        for (const automation of due) await service.executeAutomation(automation);

        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
        expect(handleChatInteraction.mock.calls[0][0]).toMatchObject({
            guildId: GUILD,
            content: 'Check the lab feed for anomalies.',
            isAutomation: true
        });

        const row = db.get('SELECT lastRun, nextRun FROM automations WHERE name = @n', { n: 'lab-check' });
        expect(row.lastRun).toBeTruthy();
        const nextRun = new Date(`${row.nextRun.replace(' ', 'T')}Z`);
        expect(nextRun.getTime()).toBeGreaterThan(Date.now());
        // Hourly cron: the next occurrence is the top of an hour
        expect(nextRun.getUTCMinutes()).toBe(0);
        expect(nextRun.getUTCSeconds()).toBe(0);
    });

    test('after a run the row is no longer due - no duplicate runs within the poll cadence', async () => {
        await createDueHourlyAutomation();
        const service = new AutomationService(makeClient());

        for (const automation of db.all(DUE_SQL)) await service.executeAutomation(automation);
        expect(handleChatInteraction).toHaveBeenCalledTimes(1);

        // The very next poll finds nothing due: the occurrence ran exactly once
        expect(db.all(DUE_SQL)).toHaveLength(0);
        for (const automation of db.all(DUE_SQL)) await service.executeAutomation(automation);
        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
    });
});

describe('persistence and restart recovery', () => {
    test('a fire missed while the bot was down runs exactly once after restart', async () => {
        await createDueHourlyAutomation();

        // "Restart": a brand-new service instance over the same SQLite rows
        const restarted = new AutomationService(makeClient());
        const due = db.all(DUE_SQL);
        expect(due).toHaveLength(1);
        for (const automation of due) await restarted.executeAutomation(automation);

        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
        expect(db.all(DUE_SQL)).toHaveLength(0);
    });

    test('an automation that ran before the restart is not re-run after it', async () => {
        await createDueHourlyAutomation();
        const before = new AutomationService(makeClient());
        for (const automation of db.all(DUE_SQL)) await before.executeAutomation(automation);
        expect(handleChatInteraction).toHaveBeenCalledTimes(1);

        const after = new AutomationService(makeClient());
        for (const automation of db.all(DUE_SQL)) await after.executeAutomation(automation);
        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
    });

    test('paused automations are never picked up', async () => {
        await createDueHourlyAutomation();
        automationManagementService.setEnabled({ userId: USER, scopeId: GUILD, name: 'lab-check', enabled: false });
        expect(db.all(DUE_SQL)).toHaveLength(0);
    });
});

describe('retry / idempotency on failure', () => {
    test('a failed run still advances nextRun so the occurrence never fires twice', async () => {
        await createDueHourlyAutomation();
        handleChatInteraction.mockRejectedValueOnce(new Error('provider outage'));
        const service = new AutomationService(makeClient());

        for (const automation of db.all(DUE_SQL)) await service.executeAutomation(automation);
        expect(handleChatInteraction).toHaveBeenCalledTimes(1);

        const row = db.get('SELECT isEnabled, lastRun, nextRun FROM automations WHERE name = @n', { n: 'lab-check' });
        expect(row.isEnabled).toBe(1); // still scheduled - retried at the next cadence
        expect(row.lastRun).toBeNull(); // the failed occurrence is not recorded as a run
        expect(new Date(`${row.nextRun.replace(' ', 'T')}Z`).getTime()).toBeGreaterThan(Date.now());

        // The same occurrence is not re-fired on the next poll
        expect(db.all(DUE_SQL)).toHaveLength(0);
    });
});
