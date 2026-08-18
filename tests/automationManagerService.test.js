/**
 * The shared automation management layer (services/automationManagerService):
 * name-keyed create/list/pause/resume/cancel within a conversation scope,
 * cron validation (5-part, 15-minute minimum gap), caps, duplicate names,
 * and ownership - the durable-automations contract behind the assistant's
 * manageAutomations tool.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-automgr-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const automationManagerService = require('@goobster/core/services/automationManagerService');
const { validateCron } = require('@goobster/core/services/automationManagerService');

const USER = '700000000000000001';
const OTHER = '700000000000000002';
const GUILD = '800000000000000001';
const CHANNEL = '900000000000000001';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM automations');
});

const create = async (overrides = {}) => await automationManagerService.create({
    userId: USER, scope: GUILD, channelId: CHANNEL,
    name: 'hourly lab check', prompt: 'Check the lab sensor feed and post a status summary',
    cron: '0 * * * *',
    ...overrides
});

describe('validateCron', () => {
    test('accepts an hourly schedule and returns its next fire', () => {
        const { cron, nextRun } = validateCron('0 * * * *');
        expect(cron).toBe('0 * * * *');
        expect(nextRun.getTime()).toBeGreaterThan(Date.now());
        expect(nextRun.getMinutes()).toBe(0);
    });

    test('rejects malformed and invalid expressions', () => {
        expect(() => validateCron('')).toThrow(expect.objectContaining({ code: 'BAD_SCHEDULE' }));
        expect(() => validateCron('0 * * *')).toThrow(expect.objectContaining({ code: 'BAD_SCHEDULE' }));
        expect(() => validateCron('not a cron at all')).toThrow(expect.objectContaining({ code: 'BAD_SCHEDULE' }));
    });

    test('enforces the 15-minute minimum gap between fires', () => {
        expect(() => validateCron('* * * * *')).toThrow(expect.objectContaining({ code: 'SCHEDULE_TOO_FREQUENT' }));
        expect(() => validateCron('*/5 * * * *')).toThrow(expect.objectContaining({ code: 'SCHEDULE_TOO_FREQUENT' }));
        expect(validateCron('*/15 * * * *').cron).toBe('*/15 * * * *'); // the floor is allowed
    });
});

describe('create', () => {
    test('creates a durable hourly automation row (persisted, enabled, scheduled)', async () => {
        const created = await create();
        expect(created.cron).toBe('0 * * * *');
        expect(created.nextRun.getTime()).toBeGreaterThan(Date.now());

        const row = await db.get('SELECT * FROM automations WHERE id = @id', { id: created.id });
        expect(row.userId).toBe(USER);
        expect(row.guildId).toBe(GUILD);
        expect(row.channelId).toBe(CHANNEL);
        expect(row.schedule).toBe('0 * * * *');
        expect(row.isEnabled).toBe(1);
        expect(row.nextRun).toBeTruthy();
        expect(JSON.parse(row.metadata)).toMatchObject({ createdVia: 'assistant', originalSchedule: '0 * * * *' });
    });

    test('validates name, prompt, and context', async () => {
        await expect((async () => await create({ name: '' }))()).rejects.toThrow(expect.objectContaining({ code: 'BAD_NAME' }));
        await expect((async () => await create({ name: 'x'.repeat(61) }))()).rejects.toThrow(expect.objectContaining({ code: 'BAD_NAME' }));
        await expect((async () => await create({ prompt: '' }))()).rejects.toThrow(expect.objectContaining({ code: 'BAD_PROMPT' }));
        await expect((async () => await create({ prompt: 'x'.repeat(2001) }))()).rejects.toThrow(expect.objectContaining({ code: 'BAD_PROMPT' }));
        await expect((async () => await create({ channelId: null }))()).rejects.toThrow(expect.objectContaining({ code: 'BAD_CONTEXT' }));
    });

    test('rejects duplicate names case-insensitively (re-asking is idempotent, not duplicating)', async () => {
        await create();
        await expect((async () => await create())()).rejects.toThrow(expect.objectContaining({ code: 'DUPLICATE_NAME' }));
        await expect((async () => await create({ name: 'HOURLY LAB CHECK' }))()).rejects.toThrow(expect.objectContaining({ code: 'DUPLICATE_NAME' }));
    });

    test('caps automations per user per scope at 10', async () => {
        for (let i = 0; i < 10; i++) await create({ name: `task ${i}` });
        await expect((async () => await create({ name: 'one too many' }))()).rejects.toThrow(expect.objectContaining({ code: 'TOO_MANY_TASKS' }));
        // A different scope has its own budget
        expect((await create({ name: 'elsewhere', scope: 'dm:' + USER })).id).toBeTruthy();
    });
});

describe('pause / resume / cancel / list', () => {
    test('pause clears nextRun; resume recomputes it', async () => {
        await create();
        const paused = await automationManagerService.setEnabled({ userId: USER, scope: GUILD, name: 'hourly lab check', enabled: false });
        expect(paused.enabled).toBe(false);
        let row = await db.get('SELECT isEnabled, nextRun FROM automations WHERE id = @id', { id: paused.id });
        expect(row.isEnabled).toBe(0);
        expect(row.nextRun).toBeNull();

        const resumed = await automationManagerService.setEnabled({ userId: USER, scope: GUILD, name: 'Hourly Lab Check', enabled: true });
        expect(resumed.enabled).toBe(true);
        row = await db.get('SELECT isEnabled, nextRun FROM automations WHERE id = @id', { id: resumed.id });
        expect(row.isEnabled).toBe(1);
        expect(row.nextRun).toBeTruthy();
    });

    test('cancel deletes the row', async () => {
        const created = await create();
        await automationManagerService.remove({ userId: USER, scope: GUILD, name: 'hourly lab check' });
        expect(await db.get('SELECT 1 AS ok FROM automations WHERE id = @id', { id: created.id })).toBeUndefined();
    });

    test('another user (or scope) cannot touch the automation', async () => {
        await create();
        await expect((async () => await automationManagerService.setEnabled({ userId: OTHER, scope: GUILD, name: 'hourly lab check', enabled: false }))())
            .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
        await expect((async () => await automationManagerService.remove({ userId: OTHER, scope: GUILD, name: 'hourly lab check' }))())
            .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
        await expect((async () => await automationManagerService.remove({ userId: USER, scope: 'dm:' + USER, name: 'hourly lab check' }))())
            .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    test('list reports status: schedule, enabled, last and next run', async () => {
        await create();
        await create({ name: 'daily brief', cron: '0 9 * * *' });
        await automationManagerService.setEnabled({ userId: USER, scope: GUILD, name: 'daily brief', enabled: false });

        const rows = await automationManagerService.list({ userId: USER, scope: GUILD });
        expect(rows).toHaveLength(2);
        const hourly = rows.find(r => r.name === 'hourly lab check');
        expect(hourly).toMatchObject({ cron: '0 * * * *', enabled: true, lastRun: null });
        expect(hourly.nextRun).toBeTruthy();
        const daily = rows.find(r => r.name === 'daily brief');
        expect(daily.enabled).toBe(false);
        expect(daily.nextRun).toBeNull();
        // Another user's listing never sees these
        expect(await automationManagerService.list({ userId: OTHER, scope: GUILD })).toHaveLength(0);
    });
});
