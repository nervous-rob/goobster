/**
 * Durability contract for recurring automations (services/automationService
 * against a real SQLite file): an hourly automation fires when due, its
 * schedule survives a "restart" (a fresh service instance over the same
 * database), each scheduled fire is claimed before it runs so replays and
 * restarts never double-run it, and a failed run waits for its next
 * scheduled fire instead of retrying every poll.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-autodur-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../utils/chatHandler', () => ({
    handleChatInteraction: jest.fn().mockResolvedValue(undefined)
}));

const db = require('../db');
const { handleChatInteraction } = require('../utils/chatHandler');
const AutomationService = require('../services/automationService');
const automationManagerService = require('../services/automationManagerService');

const USER = '710000000000000001';
const GUILD = '810000000000000001';
const CHANNEL = '910000000000000001';

function makeClient(channelOverrides = {}) {
    const channel = {
        id: CHANNEL,
        send: jest.fn().mockResolvedValue({ id: 'message-1' }),
        sendTyping: jest.fn().mockResolvedValue(undefined),
        ...channelOverrides
    };
    const member = { user: { id: USER, username: 'rob' }, displayName: 'Rob' };
    const guild = { id: GUILD, name: 'Test Guild', members: { fetch: jest.fn().mockResolvedValue(member) } };
    return {
        channel,
        client: {
            user: { id: '999000000000000001', username: 'Goobster' },
            channels: { fetch: jest.fn().mockResolvedValue(channel) },
            guilds: { fetch: jest.fn().mockResolvedValue(guild) }
        }
    };
}

/** Create an hourly automation and backdate nextRun so it is due now. */
function createDueHourlyAutomation(name = 'hourly lab check') {
    const created = automationManagerService.create({
        userId: USER, scope: GUILD, channelId: CHANNEL,
        name, prompt: 'Check the lab sensor feed and post a status summary',
        cron: '0 * * * *'
    });
    db.run(`UPDATE automations SET nextRun = datetime('now', '-1 minute') WHERE id = @id`, { id: created.id });
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
    test('a due hourly automation runs through the chat pipeline and advances to the next hour', async () => {
        const created = createDueHourlyAutomation();
        const { client } = makeClient();
        const service = new AutomationService(client);

        const due = service.getDueAutomations();
        expect(due.map(a => a.id)).toEqual([created.id]);

        await service.executeAutomation(due[0]);

        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
        expect(handleChatInteraction.mock.calls[0][0]).toMatchObject({
            guildId: GUILD,
            channelId: CHANNEL,
            isAutomation: true,
            content: 'Check the lab sensor feed and post a status summary'
        });

        const row = db.get('SELECT lastRun, nextRun, isEnabled FROM automations WHERE id = @id', { id: created.id });
        expect(row.lastRun).toBeTruthy();
        expect(row.isEnabled).toBe(1);
        // Next run is the top of the next hour, in the future
        const nextRun = new Date(`${row.nextRun.replace(' ', 'T')}Z`);
        expect(nextRun.getTime()).toBeGreaterThan(Date.now());
        expect(nextRun.getUTCMinutes()).toBe(0);
        // And it is no longer due
        expect(service.getDueAutomations()).toHaveLength(0);
    });

    test('nextRun is advanced BEFORE the run executes (claim-before-run)', async () => {
        const created = createDueHourlyAutomation();
        const { client } = makeClient();
        const service = new AutomationService(client);

        let nextRunDuringExecution = null;
        handleChatInteraction.mockImplementation(async () => {
            nextRunDuringExecution = db.get(
                'SELECT nextRun FROM automations WHERE id = @id', { id: created.id }
            ).nextRun;
        });

        await service.executeAutomation(service.getDueAutomations()[0]);

        expect(nextRunDuringExecution).toBeTruthy();
        const during = new Date(`${nextRunDuringExecution.replace(' ', 'T')}Z`);
        expect(during.getTime()).toBeGreaterThan(Date.now());
    });
});

describe('restart recovery (persistence)', () => {
    test('a fresh service instance over the same database picks up the stored schedule', async () => {
        const created = createDueHourlyAutomation();

        // "Restart": a brand-new service object - no in-memory state carries over
        const { client } = makeClient();
        const rebooted = new AutomationService(client);

        const due = rebooted.getDueAutomations();
        expect(due.map(a => a.id)).toEqual([created.id]);

        await rebooted.executeAutomation(due[0]);
        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
    });

    test('paused automations stay paused across a restart and are never due', () => {
        createDueHourlyAutomation();
        automationManagerService.setEnabled({ userId: USER, scope: GUILD, name: 'hourly lab check', enabled: false });

        const rebooted = new AutomationService(makeClient().client);
        expect(rebooted.getDueAutomations()).toHaveLength(0);
    });
});

describe('no duplicate runs (idempotency)', () => {
    test('the same due fire executed twice (replayed due list, second poller) runs once', async () => {
        createDueHourlyAutomation();
        const { client } = makeClient();
        const service = new AutomationService(client);
        const [automation] = service.getDueAutomations();

        await service.executeAutomation(automation);
        await service.executeAutomation(automation); // replay of the same stale row

        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
    });

    test('a restart mid-execution does not re-run the claimed fire', async () => {
        createDueHourlyAutomation();
        const { client } = makeClient();
        const service = new AutomationService(client);
        const [automation] = service.getDueAutomations();

        // The process "dies" mid-run: the claim already advanced nextRun
        handleChatInteraction.mockRejectedValueOnce(new Error('process killed mid-run'));
        await service.executeAutomation(automation);

        // Reboot: the row is not due again until its next scheduled fire
        const rebooted = new AutomationService(makeClient().client);
        expect(rebooted.getDueAutomations()).toHaveLength(0);
        await rebooted.executeAutomation(automation); // even a replayed row is refused
        expect(handleChatInteraction).toHaveBeenCalledTimes(1);
    });
});

describe('failure handling (retry semantics)', () => {
    test('a failing run leaves the automation enabled and waits for the next fire - no retry storm', async () => {
        const created = createDueHourlyAutomation();
        const { client } = makeClient();
        const service = new AutomationService(client);

        handleChatInteraction.mockRejectedValueOnce(new Error('provider outage'));
        await service.executeAutomation(service.getDueAutomations()[0]);

        const row = db.get('SELECT lastRun, nextRun, isEnabled FROM automations WHERE id = @id', { id: created.id });
        expect(row.isEnabled).toBe(1);           // still alive
        expect(row.lastRun).toBeNull();          // the run did not complete
        const nextRun = new Date(`${row.nextRun.replace(' ', 'T')}Z`);
        expect(nextRun.getTime()).toBeGreaterThan(Date.now()); // not immediately due again
        expect(service.getDueAutomations()).toHaveLength(0);

        // The next scheduled fire works normally
        db.run(`UPDATE automations SET nextRun = datetime('now', '-1 minute') WHERE id = @id`, { id: created.id });
        await service.executeAutomation(service.getDueAutomations()[0]);
        expect(handleChatInteraction).toHaveBeenCalledTimes(2);
        expect(db.get('SELECT lastRun FROM automations WHERE id = @id', { id: created.id }).lastRun).toBeTruthy();
    });
});
