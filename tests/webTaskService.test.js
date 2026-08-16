/**
 * Unit tests for the web portal's scheduled tasks (services/webTaskService):
 * listing automations + followups, creating DM-scope tasks, cancel/toggle
 * ownership rules, validation guardrails, DM-scope execution through
 * automationService's pseudo-interaction, and /forget-me coverage.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-webtasks-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../utils/chatHandler', () => ({
    handleChatInteraction: jest.fn().mockResolvedValue(undefined)
}));

const db = require('../db');
const webTaskService = require('../services/webTaskService');
const { handleChatInteraction } = require('../utils/chatHandler');
const { dmScopeId } = require('../utils/dmScope');

const USER = '300000000000000001';
const OTHER = '300000000000000002';
const GUILD = '400000000000000001';
const DM_CHANNEL = '500000000000000001';

const client = {
    guilds: { cache: new Map([[GUILD, { name: 'Test Guild' }]]) },
    users: {
        fetch: jest.fn().mockResolvedValue({
            id: USER,
            username: 'rob',
            createDM: jest.fn().mockResolvedValue({ id: DM_CHANNEL })
        })
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
    handleChatInteraction.mockReset();
    handleChatInteraction.mockResolvedValue(undefined);
    db.run('DELETE FROM automations');
    db.run('DELETE FROM followups');
});

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe('createTask', () => {
    test('creates a recurring DM-scope automation delivered to the DM channel', async () => {
        const created = await webTaskService.createTask({
            client, userId: USER, name: 'Morning brief', prompt: 'Summarize my day', cron: '0 9 * * *'
        });
        expect(created.kind).toBe('automation');
        expect(created.nextRun).toBeTruthy();

        const row = db.get('SELECT * FROM automations WHERE id = @id', { id: created.id });
        expect(row.guildId).toBe(dmScopeId(USER));
        expect(row.channelId).toBe(DM_CHANNEL);
        expect(row.promptText).toBe('Summarize my day');
        expect(row.schedule).toBe('0 9 * * *');
        expect(row.isEnabled).toBe(1);
    });

    test('creates a one-shot followup with a future due time', async () => {
        const created = await webTaskService.createTask({
            client, userId: USER, name: 'Reminder', prompt: 'Ask me about the deploy', dueAt: FUTURE
        });
        expect(created.kind).toBe('followup');

        const row = db.get('SELECT * FROM followups WHERE id = @id', { id: created.id });
        expect(row.guildId).toBe(dmScopeId(USER));
        expect(row.channelId).toBe(DM_CHANNEL);
        expect(row.status).toBe('PENDING');
        expect(row.note).toBe('Ask me about the deploy');
    });

    test('validates name, prompt, and the cron/dueAt choice', async () => {
        const base = { client, userId: USER, prompt: 'p', cron: '0 9 * * *' };
        await expect(webTaskService.createTask({ ...base, name: '' }))
            .rejects.toMatchObject({ code: 'BAD_NAME' });
        await expect(webTaskService.createTask({ ...base, name: 'x'.repeat(61) }))
            .rejects.toMatchObject({ code: 'BAD_NAME' });
        await expect(webTaskService.createTask({ client, userId: USER, name: 'n', prompt: '', cron: '0 9 * * *' }))
            .rejects.toMatchObject({ code: 'BAD_PROMPT' });
        await expect(webTaskService.createTask({ client, userId: USER, name: 'n', prompt: 'p' }))
            .rejects.toMatchObject({ code: 'BAD_SCHEDULE' });
        await expect(webTaskService.createTask({ client, userId: USER, name: 'n', prompt: 'p', cron: '0 9 * * *', dueAt: FUTURE }))
            .rejects.toMatchObject({ code: 'BAD_SCHEDULE' });
    });

    test('rejects invalid and too-frequent cron expressions', async () => {
        await expect(webTaskService.createTask({
            client, userId: USER, name: 'bad', prompt: 'p', cron: 'not a cron'
        })).rejects.toMatchObject({ code: 'BAD_SCHEDULE' });
        await expect(webTaskService.createTask({
            client, userId: USER, name: 'spam', prompt: 'p', cron: '* * * * *'
        })).rejects.toMatchObject({ code: 'SCHEDULE_TOO_FREQUENT' });
        await expect(webTaskService.createTask({
            client, userId: USER, name: 'spam2', prompt: 'p', cron: '*/5 * * * *'
        })).rejects.toMatchObject({ code: 'SCHEDULE_TOO_FREQUENT' });
        // 15-minute cadence is the floor and is allowed
        const ok = await webTaskService.createTask({
            client, userId: USER, name: 'quarter-hourly', prompt: 'p', cron: '*/15 * * * *'
        });
        expect(ok.kind).toBe('automation');
    });

    test('rejects past / far-future due times and oversized one-shot prompts', async () => {
        await expect(webTaskService.createTask({
            client, userId: USER, name: 'r', prompt: 'p', dueAt: new Date(Date.now() - 1000).toISOString()
        })).rejects.toMatchObject({ code: 'BAD_DUE_AT' });
        await expect(webTaskService.createTask({
            client, userId: USER, name: 'r', prompt: 'p', dueAt: 'yesterday-ish'
        })).rejects.toMatchObject({ code: 'BAD_DUE_AT' });
        await expect(webTaskService.createTask({
            client, userId: USER, name: 'r', prompt: 'p',
            dueAt: new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000).toISOString()
        })).rejects.toMatchObject({ code: 'BAD_DUE_AT' });
        await expect(webTaskService.createTask({
            client, userId: USER, name: 'r', prompt: 'x'.repeat(501), dueAt: FUTURE
        })).rejects.toMatchObject({ code: 'BAD_PROMPT' });
    });

    test('enforces duplicate names and per-user caps', async () => {
        await webTaskService.createTask({ client, userId: USER, name: 'daily', prompt: 'p', cron: '0 9 * * *' });
        await expect(webTaskService.createTask({ client, userId: USER, name: 'daily', prompt: 'p', cron: '0 10 * * *' }))
            .rejects.toMatchObject({ status: 409, code: 'DUPLICATE_NAME' });

        for (let i = 1; i < 10; i++) {
            await webTaskService.createTask({ client, userId: USER, name: `task ${i}`, prompt: 'p', cron: '0 9 * * *' });
        }
        await expect(webTaskService.createTask({ client, userId: USER, name: 'one too many', prompt: 'p', cron: '0 9 * * *' }))
            .rejects.toMatchObject({ code: 'TOO_MANY_TASKS' });

        for (let i = 0; i < 10; i++) {
            await webTaskService.createTask({ client, userId: USER, name: `r${i}`, prompt: 'p', dueAt: FUTURE });
        }
        await expect(webTaskService.createTask({ client, userId: USER, name: 'r11', prompt: 'p', dueAt: FUTURE }))
            .rejects.toMatchObject({ code: 'TOO_MANY_TASKS' });
    });

    test('an unreachable DM is a clear 502, and an offline client a 503', async () => {
        const offlineClient = {};
        await expect(webTaskService.createTask({
            client: offlineClient, userId: USER, name: 'n', prompt: 'p', cron: '0 9 * * *'
        })).rejects.toMatchObject({ status: 503, code: 'BOT_OFFLINE' });

        const blockedClient = {
            users: { fetch: jest.fn().mockRejectedValue(new Error('Cannot send messages to this user')) }
        };
        await expect(webTaskService.createTask({
            client: blockedClient, userId: USER, name: 'n', prompt: 'p', cron: '0 9 * * *'
        })).rejects.toMatchObject({ status: 502, code: 'DM_UNAVAILABLE' });
    });
});

describe('listTasks', () => {
    test('returns the user\'s automations (all scopes) and pending followups with labels', async () => {
        await webTaskService.createTask({ client, userId: USER, name: 'dm task', prompt: 'p', cron: '0 9 * * *' });
        db.run(
            `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
             VALUES (@userId, @guildId, 'chan', 'guild task', 'p', '0 8 * * *', datetime('now', '+1 hour'))`,
            { userId: USER, guildId: GUILD }
        );
        await webTaskService.createTask({ client, userId: USER, name: 'r', prompt: 'remind me', dueAt: FUTURE });
        // Someone else's rows never leak in
        db.run(
            `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule)
             VALUES (@userId, @guildId, 'chan', 'other task', 'p', '0 8 * * *')`,
            { userId: OTHER, guildId: GUILD }
        );

        const tasks = webTaskService.listTasks({ client, userId: USER });
        expect(tasks.automations).toHaveLength(2);
        const dmTask = tasks.automations.find(a => a.name === 'dm task');
        expect(dmTask.scope).toBe('dm');
        expect(dmTask.scopeName).toBe('Direct messages');
        const guildTask = tasks.automations.find(a => a.name === 'guild task');
        expect(guildTask.scope).toBe('guild');
        expect(guildTask.scopeName).toBe('Test Guild');

        expect(tasks.followups).toHaveLength(1);
        expect(tasks.followups[0].prompt).toBe('remind me');
    });

    test('cancelled followups disappear from the list', async () => {
        const created = await webTaskService.createTask({ client, userId: USER, name: 'r', prompt: 'p', dueAt: FUTURE });
        webTaskService.cancelFollowup({ userId: USER, followupId: created.id });
        expect(webTaskService.listTasks({ client, userId: USER }).followups).toHaveLength(0);
        expect(db.get('SELECT status FROM followups WHERE id = @id', { id: created.id }).status).toBe('CANCELLED');
    });

    test('recurring followups (scheduled from chat) list their recurrence and are cancellable', () => {
        const row = db.get(
            `INSERT INTO followups (guildId, channelId, userId, note, dueAt, recurMinutes, recurrence, deliveryCount)
             VALUES (@guildId, 'chan', @userId, 'hourly lab check', datetime('now', '+1 hour'), 60, 'every hour', 3)
             RETURNING id`,
            { guildId: GUILD, userId: USER }
        );

        const listed = webTaskService.listTasks({ client, userId: USER }).followups;
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            kind: 'followup', recurrence: 'every hour', recurMinutes: 60, deliveryCount: 3
        });

        // Cancelling ends the whole series (recurring rows stay PENDING)
        webTaskService.cancelFollowup({ userId: USER, followupId: row.id });
        expect(db.get('SELECT status FROM followups WHERE id = @id', { id: row.id }).status).toBe('CANCELLED');
        expect(webTaskService.listTasks({ client, userId: USER }).followups).toHaveLength(0);
    });
});

describe('ownership', () => {
    test('toggle/delete/cancel refuse another user\'s rows', async () => {
        const automation = await webTaskService.createTask({
            client, userId: USER, name: 'mine', prompt: 'p', cron: '0 9 * * *'
        });
        const followup = await webTaskService.createTask({
            client, userId: USER, name: 'r', prompt: 'p', dueAt: FUTURE
        });

        expect(() => webTaskService.setAutomationEnabled({ userId: OTHER, automationId: automation.id, enabled: false }))
            .toThrow(expect.objectContaining({ status: 404 }));
        expect(() => webTaskService.deleteAutomation({ userId: OTHER, automationId: automation.id }))
            .toThrow(expect.objectContaining({ status: 404 }));
        expect(() => webTaskService.cancelFollowup({ userId: OTHER, followupId: followup.id }))
            .toThrow(expect.objectContaining({ status: 404 }));

        // The owner can
        expect(webTaskService.setAutomationEnabled({ userId: USER, automationId: automation.id, enabled: false }))
            .toEqual({ id: automation.id, enabled: false });
        expect(db.get('SELECT nextRun FROM automations WHERE id = @id', { id: automation.id }).nextRun).toBeNull();
        expect(webTaskService.setAutomationEnabled({ userId: USER, automationId: automation.id, enabled: true }).enabled)
            .toBe(true);
        expect(db.get('SELECT nextRun FROM automations WHERE id = @id', { id: automation.id }).nextRun).toBeTruthy();
        expect(webTaskService.deleteAutomation({ userId: USER, automationId: automation.id })).toEqual({ deleted: true });
    });
});

describe('DM-scope execution (automationService)', () => {
    test('a due DM automation runs through the chat pipeline as a DM pseudo-interaction', async () => {
        const AutomationService = require('../services/automationService');
        const created = await webTaskService.createTask({
            client, userId: USER, name: 'brief', prompt: 'Summarize the news', cron: '0 9 * * *'
        });
        // Make the row due: execution now claims (advances nextRun) before
        // running, and only due rows can be claimed.
        db.run(`UPDATE automations SET nextRun = datetime('now', '-1 minute') WHERE id = @id`, { id: created.id });
        const automation = db.get('SELECT * FROM automations WHERE id = @id', { id: created.id });

        const sent = [];
        const dmChannel = {
            id: DM_CHANNEL,
            send: jest.fn(async (payload) => { sent.push(payload); return { id: 'm1' }; }),
            sendTyping: jest.fn()
        };
        const execClient = {
            channels: { fetch: jest.fn().mockResolvedValue(dmChannel) },
            users: { fetch: jest.fn().mockResolvedValue({ id: USER, username: 'rob' }) }
        };

        handleChatInteraction.mockImplementation(async (interaction) => {
            await interaction.reply('All quiet today.');
        });

        const service = new AutomationService(execClient);
        await service.executeAutomation(automation);

        // The pseudo-interaction is DM-shaped: no guild, the owner's user,
        // the DM channel - so the pipeline resolves the dm:<userId> scope.
        const interaction = handleChatInteraction.mock.calls[0][0];
        expect(interaction.guild).toBeNull();
        expect(interaction.guildId).toBeNull();
        expect(interaction.user.id).toBe(USER);
        expect(interaction.channelId).toBe(DM_CHANNEL);
        expect(interaction.isAutomation).toBe(true);
        expect(interaction.options.getString()).toBe('Summarize the news');
        expect(interaction.sourceDescription).toContain('scheduled task');

        // Delivery lands in the DM with the scheduled-task banner
        expect(sent[0].content).toContain('Scheduled Task');
        expect(sent[0].content).toContain('All quiet today.');

        // The responder's preferred capability delivers banner-first and
        // chunked (DMs keep Discord's 2000-char cap)
        expect(typeof interaction.sendFullResponse).toBe('function');
        await interaction.sendFullResponse('y'.repeat(4200));
        const chunked = sent.slice(1);
        expect(chunked.length).toBeGreaterThan(1);
        expect(chunked[0].content).toContain('Scheduled Task');
        expect(chunked.every(m => m.content.length <= 2000)).toBe(true);

        // lastRun/nextRun advance so it doesn't re-fire immediately
        const after = db.get('SELECT lastRun, nextRun FROM automations WHERE id = @id', { id: automation.id });
        expect(after.lastRun).toBeTruthy();
        expect(after.nextRun).toBeTruthy();
    });
});

describe('privacy coverage', () => {
    test('/forget-me deletes the user\'s automations and the audit counts them', async () => {
        const privacyService = require('../services/privacyService');
        await webTaskService.createTask({ client, userId: USER, name: 'brief', prompt: 'p', cron: '0 9 * * *' });
        db.run(
            `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule)
             VALUES (@userId, @guildId, 'chan', 'guild one', 'p', '0 8 * * *')`,
            { userId: USER, guildId: GUILD }
        );

        expect(privacyService.auditUser({ userId: USER }).byTable.automations).toBe(2);
        const counts = privacyService.forgetUser({ userId: USER });
        expect(counts.automations).toBe(2);
        expect(privacyService.auditUser({ userId: USER }).byTable.automations).toBe(0);
    });

    test('the transparency report lists scoped automations and share-link count', () => {
        const privacyService = require('../services/privacyService');
        db.run(
            `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
             VALUES (@userId, @scope, 'chan', 'dm brief', 'p', '0 9 * * *', datetime('now', '+1 hour'))`,
            { userId: USER, scope: dmScopeId(USER) }
        );
        const report = privacyService.buildUserReport({ guildId: dmScopeId(USER), userId: USER });
        expect(report.automations).toHaveLength(1);
        expect(report.automations[0]).toMatchObject({ name: 'dm brief', enabled: true });
        expect(report.shareLinks).toBe(0);
    });
});
