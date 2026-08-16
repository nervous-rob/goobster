/**
 * Unit tests for services/automationManagementService: the shared management
 * layer over the durable `automations` table used by the manageAutomation AI
 * tool and the /automation command. Covers schedule resolution (manual
 * patterns, raw cron, AI conversion), validation guardrails (cadence floor,
 * duplicate names, caps), and pause/resume/update/cancel semantics.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-automgmt-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('../services/aiService', () => ({
    chatText: jest.fn(),
    generateText: jest.fn()
}));

const db = require('../db');
const aiService = require('../services/aiService');
const automationManagementService = require('../services/automationManagementService');
const { resolveSchedule, getManualCron, MAX_AUTOMATIONS_PER_SCOPE } = automationManagementService;

const USER = '700000000000000001';
const OTHER = '700000000000000002';
const GUILD = '800000000000000001';
const CHANNEL = '900000000000000001';

const base = { userId: USER, scopeId: GUILD, channelId: CHANNEL };

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

describe('resolveSchedule', () => {
    test('resolves "every hour" from the manual patterns without a model call', async () => {
        const { cron, nextRun } = await resolveSchedule('every hour');
        expect(cron).toBe('0 * * * *');
        expect(aiService.chatText).not.toHaveBeenCalled();
        // Hourly cron fires at the top of the next hour
        expect(nextRun.getUTCMinutes()).toBe(0);
        expect(nextRun.getTime()).toBeGreaterThan(Date.now());
    });

    test('accepts a raw 5-part cron directly', async () => {
        const { cron } = await resolveSchedule('30 */2 * * *');
        expect(cron).toBe('30 */2 * * *');
        expect(aiService.chatText).not.toHaveBeenCalled();
    });

    test('falls back to AI conversion for other natural language', async () => {
        aiService.chatText.mockResolvedValue('15 9 * * 1-5');
        const { cron } = await resolveSchedule('weekday mornings at 9:15');
        expect(cron).toBe('15 9 * * 1-5');
        expect(aiService.chatText).toHaveBeenCalledTimes(1);
    });

    test('rejects nonsense the converter cannot interpret', async () => {
        aiService.chatText.mockResolvedValue('INVALID');
        await expect(resolveSchedule('purple monkey dishwasher')).rejects.toThrow(/Could not understand/);
    });

    test('enforces the 15-minute cadence floor', async () => {
        await expect(resolveSchedule('* * * * *')).rejects.toThrow(/at most every 15 minutes/);
        await expect(resolveSchedule('*/5 * * * *')).rejects.toThrow(/at most every 15 minutes/);
    });

    test('requires a schedule', async () => {
        await expect(resolveSchedule('   ')).rejects.toThrow(/schedule is required/i);
    });
});

describe('create', () => {
    test('creates an hourly automation persisted in SQLite', async () => {
        const created = await automationManagementService.create({
            ...base, name: 'lab-check', prompt: 'Check the lab feed for anomalies.', schedule: 'every hour'
        });
        expect(created.cron).toBe('0 * * * *');

        const row = db.get('SELECT * FROM automations WHERE id = @id', { id: created.id });
        expect(row).toMatchObject({
            userId: USER, guildId: GUILD, channelId: CHANNEL,
            name: 'lab-check', promptText: 'Check the lab feed for anomalies.',
            schedule: '0 * * * *', isEnabled: 1
        });
        expect(row.nextRun).toBeTruthy();
        expect(JSON.parse(row.metadata)).toMatchObject({
            createdVia: 'tool', originalSchedule: 'every hour'
        });
    });

    test('refuses a duplicate name instead of creating a second copy', async () => {
        await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p', schedule: 'every hour' });
        await expect(
            automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p2', schedule: 'daily' })
        ).rejects.toThrow(/already exists/);
        expect(db.get('SELECT COUNT(*) AS c FROM automations').c).toBe(1);
    });

    test('same name is fine for another user or scope', async () => {
        await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p', schedule: 'every hour' });
        await expect(automationManagementService.create({
            ...base, userId: OTHER, name: 'lab-check', prompt: 'p', schedule: 'every hour'
        })).resolves.toBeTruthy();
    });

    test('caps automations per user per scope', async () => {
        for (let i = 0; i < MAX_AUTOMATIONS_PER_SCOPE; i++) {
            await automationManagementService.create({ ...base, name: `job-${i}`, prompt: 'p', schedule: 'every hour' });
        }
        await expect(
            automationManagementService.create({ ...base, name: 'one-too-many', prompt: 'p', schedule: 'every hour' })
        ).rejects.toThrow(/cancel one first/);
    });

    test('validates name and prompt', async () => {
        await expect(
            automationManagementService.create({ ...base, name: '', prompt: 'p', schedule: 'every hour' })
        ).rejects.toThrow(/name is required/i);
        await expect(
            automationManagementService.create({ ...base, name: 'x'.repeat(61), prompt: 'p', schedule: 'every hour' })
        ).rejects.toThrow(/name is required/i);
        await expect(
            automationManagementService.create({ ...base, name: 'ok', prompt: '', schedule: 'every hour' })
        ).rejects.toThrow(/prompt is required/i);
        await expect(
            automationManagementService.create({ ...base, name: 'ok', prompt: 'x'.repeat(2001), schedule: 'every hour' })
        ).rejects.toThrow(/prompt is required/i);
    });
});

describe('list / pause / resume / update / cancel', () => {
    test('list reports status including schedule label and next run', async () => {
        await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p', schedule: 'every hour' });
        const rows = automationManagementService.list({ userId: USER, scopeId: GUILD });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            name: 'lab-check', cron: '0 * * * *', scheduleLabel: 'every hour',
            enabled: true, lastRun: null
        });
        expect(rows[0].nextRun).toBeTruthy();
        // Other users see nothing
        expect(automationManagementService.list({ userId: OTHER, scopeId: GUILD })).toHaveLength(0);
    });

    test('pause clears nextRun; resume recomputes it', async () => {
        await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p', schedule: 'every hour' });

        const paused = automationManagementService.setEnabled({ userId: USER, scopeId: GUILD, name: 'lab-check', enabled: false });
        expect(paused.enabled).toBe(false);
        let row = db.get('SELECT isEnabled, nextRun FROM automations WHERE name = @n', { n: 'lab-check' });
        expect(row).toEqual({ isEnabled: 0, nextRun: null });

        const resumed = automationManagementService.setEnabled({ userId: USER, scopeId: GUILD, name: 'lab-check', enabled: true });
        expect(resumed.enabled).toBe(true);
        expect(resumed.nextRun.getTime()).toBeGreaterThan(Date.now());
        row = db.get('SELECT isEnabled, nextRun FROM automations WHERE name = @n', { n: 'lab-check' });
        expect(row.isEnabled).toBe(1);
        expect(row.nextRun).toBeTruthy();
    });

    test('update edits the prompt without touching the schedule', async () => {
        const created = await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'old', schedule: 'every hour' });
        const before = db.get('SELECT nextRun FROM automations WHERE id = @id', { id: created.id });

        await automationManagementService.update({ userId: USER, scopeId: GUILD, name: 'lab-check', prompt: 'new task' });
        const row = db.get('SELECT promptText, schedule, nextRun FROM automations WHERE id = @id', { id: created.id });
        expect(row.promptText).toBe('new task');
        expect(row.schedule).toBe('0 * * * *');
        expect(row.nextRun).toBe(before.nextRun);
    });

    test('update reschedules and recomputes nextRun', async () => {
        const created = await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p', schedule: 'every hour' });
        const updated = await automationManagementService.update({
            userId: USER, scopeId: GUILD, name: 'lab-check', schedule: 'daily'
        });
        expect(updated.cron).toBe('0 0 * * *');
        const row = db.get('SELECT schedule, metadata FROM automations WHERE id = @id', { id: created.id });
        expect(row.schedule).toBe('0 0 * * *');
        expect(JSON.parse(row.metadata).originalSchedule).toBe('daily');
    });

    test('rescheduling a paused automation keeps it paused (no nextRun)', async () => {
        await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p', schedule: 'every hour' });
        automationManagementService.setEnabled({ userId: USER, scopeId: GUILD, name: 'lab-check', enabled: false });
        await automationManagementService.update({ userId: USER, scopeId: GUILD, name: 'lab-check', schedule: 'daily' });
        const row = db.get('SELECT isEnabled, nextRun, schedule FROM automations WHERE name = @n', { n: 'lab-check' });
        expect(row).toEqual({ isEnabled: 0, nextRun: null, schedule: '0 0 * * *' });
    });

    test('update requires something to change', async () => {
        await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p', schedule: 'every hour' });
        await expect(
            automationManagementService.update({ userId: USER, scopeId: GUILD, name: 'lab-check' })
        ).rejects.toThrow(/Nothing to update/);
    });

    test('cancel deletes the row; unknown names are refused', async () => {
        await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p', schedule: 'every hour' });
        expect(automationManagementService.remove({ userId: USER, scopeId: GUILD, name: 'lab-check' })).toEqual({ deleted: true });
        expect(db.get('SELECT COUNT(*) AS c FROM automations').c).toBe(0);
        expect(() =>
            automationManagementService.remove({ userId: USER, scopeId: GUILD, name: 'lab-check' })
        ).toThrow(/No automation named/);
    });

    test('ownership: another user cannot pause or cancel the row', async () => {
        await automationManagementService.create({ ...base, name: 'lab-check', prompt: 'p', schedule: 'every hour' });
        expect(() =>
            automationManagementService.setEnabled({ userId: OTHER, scopeId: GUILD, name: 'lab-check', enabled: false })
        ).toThrow(/No automation named/);
        expect(() =>
            automationManagementService.remove({ userId: OTHER, scopeId: GUILD, name: 'lab-check' })
        ).toThrow(/No automation named/);
    });
});

describe('getManualCron', () => {
    test('maps the documented shorthand patterns', () => {
        expect(getManualCron('every hour')).toBe('0 * * * *');
        expect(getManualCron('HOURLY')).toBe('0 * * * *');
        expect(getManualCron('every 30 minutes')).toBe('*/30 * * * *');
        expect(getManualCron('daily')).toBe('0 0 * * *');
        expect(getManualCron('weekly')).toBe('0 0 * * 0');
        expect(getManualCron('monthly')).toBe('0 0 1 * *');
        expect(getManualCron('every full moon')).toBeNull();
    });
});
