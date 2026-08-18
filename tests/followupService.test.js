/**
 * Follow-up scheduling and delivery (services/followupService.js +
 * heartbeatService.deliverDueFollowups): recurrence parsing guardrails,
 * one-shot behavior staying unchanged, hourly recurrence end to end,
 * post-delivery rescheduling, retry-on-failure, restart recovery with
 * missed-occurrence catch-up, and duplicate-delivery prevention -
 * against a throwaway SQLite database with a mocked AI provider.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-followups-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

jest.mock('@goobster/core/services/aiService', () => ({
    generateText: jest.fn(),
    chat: jest.fn()
}));

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const followupService = require('@goobster/core/services/followupService');
const HeartbeatService = require('@goobster/core/services/heartbeatService');

const GUILD = '700000000000000001';
const CHANNEL = '700000000000000002';
const USER = '700000000000000003';

/** 'YYYY-MM-DD HH:MM:SS' UTC text for an epoch-ms instant. */
function utcText(ms) {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** Floor to whole seconds - the precision the followups table stores. */
function truncMs(ms) {
    return Math.floor(ms / 1000) * 1000;
}

function utcMs(text) {
    return new Date(`${text.replace(' ', 'T')}Z`).getTime();
}

/** Insert a followup row directly (bypasses the AI when-parser). */
async function insertFollowup({ dueAtMs, recurMinutes = null, recurrence = null, note = 'check the lab' }) {
    const result = await db.run(
        `INSERT INTO followups (guildId, channelId, userId, note, dueAt, recurMinutes, recurrence)
         VALUES (@GUILD, @CHANNEL, @USER, @note, @dueAt, @recurMinutes, @recurrence)`,
        { GUILD, CHANNEL, USER, note, dueAt: utcText(dueAtMs), recurMinutes, recurrence }
    );
    return Number(result.lastInsertRowid);
}

async function getRow(id) {
    return await db.get('SELECT * FROM followups WHERE id = @id', { id });
}

/** A heartbeat service around a stub Discord client with one text channel. */
function makeHeartbeat() {
    const sent = [];
    const channel = {
        isTextBased: () => true,
        send: jest.fn(async (payload) => { sent.push(payload); return { id: 'msg' }; })
    };
    const client = { channels: { fetch: jest.fn(async () => channel) } };
    return { heartbeat: new HeartbeatService(client), channel, sent };
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    jest.clearAllMocks();
    aiService.generateText.mockResolvedValue('On it - checking in as promised!');
    await db.run('DELETE FROM followups');
});

describe('parseRecurrence', () => {
    test('understands hourly/daily/weekly and "every N unit" phrasings', () => {
        expect(followupService.parseRecurrence('every hour')).toEqual({ minutes: 60, label: 'every hour' });
        expect(followupService.parseRecurrence('hourly')).toEqual({ minutes: 60, label: 'every hour' });
        expect(followupService.parseRecurrence('Every 2 Hours')).toEqual({ minutes: 120, label: 'every 2 hours' });
        expect(followupService.parseRecurrence('every 30 minutes')).toEqual({ minutes: 30, label: 'every 30 minutes' });
        expect(followupService.parseRecurrence('daily')).toEqual({ minutes: 1440, label: 'every day' });
        expect(followupService.parseRecurrence('each day')).toEqual({ minutes: 1440, label: 'every day' });
        expect(followupService.parseRecurrence('weekly')).toEqual({ minutes: 10080, label: 'every week' });
        expect(followupService.parseRecurrence('45 minutes')).toEqual({ minutes: 45, label: 'every 45 minutes' });
    });

    test('empty and "none"-style values mean one-shot', () => {
        expect(followupService.parseRecurrence(null)).toBeNull();
        expect(followupService.parseRecurrence(undefined)).toBeNull();
        expect(followupService.parseRecurrence('')).toBeNull();
        expect(followupService.parseRecurrence('once')).toBeNull();
        expect(followupService.parseRecurrence('none')).toBeNull();
    });

    test('rejects gibberish and intervals outside the guardrails', () => {
        expect(() => followupService.parseRecurrence('whenever you feel like it')).toThrow(/Couldn't understand/);
        expect(() => followupService.parseRecurrence('every 5 minutes')).toThrow(/at most every 15 minutes/);
        expect(() => followupService.parseRecurrence('every 400 days')).toThrow(/a year apart/);
    });
});

describe('schedule', () => {
    test('a one-shot follow-up works exactly as before (when parsed by the model)', async () => {
        const future = utcText(Date.now() + 2 * 60 * 60 * 1000);
        aiService.generateText.mockResolvedValueOnce(future);

        const created = await followupService.schedule({
            guildId: GUILD, channelId: CHANNEL, userId: USER,
            note: 'ask about the deploy', whenDescription: 'in 2 hours'
        });
        expect(created.dueAt).toBe(future);
        expect(created.recurrence).toBeNull();

        const row = await getRow(created.id);
        expect(row.status).toBe('PENDING');
        expect(row.recurMinutes).toBeNull();
        expect(row.deliveryCount).toBe(0);
    });

    test('an hourly recurring follow-up stores clear recurrence metadata', async () => {
        const future = utcText(Date.now() + 60 * 60 * 1000);
        aiService.generateText.mockResolvedValueOnce(future);

        const created = await followupService.schedule({
            guildId: GUILD, channelId: CHANNEL, userId: USER,
            note: 'check on the neurogene-lab observatory job',
            whenDescription: 'in an hour', repeat: 'every hour'
        });
        expect(created.recurrence).toBe('every hour');

        const row = await getRow(created.id);
        expect(row.recurMinutes).toBe(60);
        expect(row.recurrence).toBe('every hour');
        expect(row.status).toBe('PENDING');
    });

    test('a recurring follow-up without "when" starts one interval from now, with no model call', async () => {
        const before = Date.now();
        const created = await followupService.schedule({
            guildId: GUILD, channelId: CHANNEL, userId: USER,
            note: 'hourly lab check', repeat: 'hourly'
        });
        expect(aiService.generateText).not.toHaveBeenCalled();

        const dueMs = utcMs(created.dueAt);
        expect(dueMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 1000);
        expect(dueMs).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 1000);
    });

    test('needs either a time or a recurrence, and validates the recurrence up front', async () => {
        await expect(followupService.schedule({
            guildId: GUILD, channelId: CHANNEL, note: 'no timing at all'
        })).rejects.toThrow(/time \("when"\) or a recurrence/);

        await expect(followupService.schedule({
            guildId: GUILD, channelId: CHANNEL, note: 'too eager', repeat: 'every 1 minute'
        })).rejects.toThrow(/at most every 15 minutes/);
        expect(aiService.generateText).not.toHaveBeenCalled();
    });
});

describe('nextOccurrence (post-delivery rescheduling math)', () => {
    test('advances exactly one interval when delivered on time', () => {
        const due = utcText(Date.now() - 10 * 1000); // just came due
        const next = followupService.nextOccurrence(due, 60);
        expect(utcMs(next) - utcMs(due)).toBe(60 * 60 * 1000);
    });

    test('skips occurrences missed during downtime instead of bursting', () => {
        const due = utcText(Date.now() - 5.5 * 60 * 60 * 1000); // 5.5h of downtime, hourly
        const next = followupService.nextOccurrence(due, 60);
        expect(utcMs(next)).toBeGreaterThan(Date.now());
        // Still on the original grid: an exact multiple of the interval
        expect((utcMs(next) - utcMs(due)) % (60 * 60 * 1000)).toBe(0);
        expect(utcMs(next) - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    });
});

describe('recordDelivery', () => {
    test('one-shot: marked DONE with delivery bookkeeping', async () => {
        const id = await insertFollowup({ dueAtMs: Date.now() - 1000 });
        const outcome = await followupService.recordDelivery(await getRow(id));
        expect(outcome).toEqual({ recurring: false, advanced: true, nextDueAt: null });

        const row = await getRow(id);
        expect(row.status).toBe('DONE');
        expect(row.deliveryCount).toBe(1);
        expect(row.lastDeliveredAt).toBeTruthy();
    });

    test('recurring: rescheduled into the future and still PENDING', async () => {
        const dueMs = truncMs(Date.now() - 1000);
        const id = await insertFollowup({ dueAtMs: dueMs, recurMinutes: 60, recurrence: 'every hour' });
        const outcome = await followupService.recordDelivery(await getRow(id));
        expect(outcome.recurring).toBe(true);
        expect(outcome.advanced).toBe(true);

        const row = await getRow(id);
        expect(row.status).toBe('PENDING');
        expect(row.deliveryCount).toBe(1);
        expect(utcMs(row.dueAt)).toBeGreaterThan(Date.now());
        expect(utcMs(row.dueAt) - dueMs).toBe(60 * 60 * 1000);
    });

    test('a duplicate call with a stale row is a no-op (no double delivery accounting)', async () => {
        const id = await insertFollowup({ dueAtMs: Date.now() - 1000, recurMinutes: 60, recurrence: 'every hour' });
        const staleRow = await getRow(id);
        expect((await followupService.recordDelivery(staleRow)).advanced).toBe(true);
        expect(await followupService.recordDelivery(staleRow)).toEqual({ recurring: true, advanced: false, nextDueAt: null });
        expect((await getRow(id)).deliveryCount).toBe(1);
    });

    test('a cancelled follow-up is never advanced or completed', async () => {
        const id = await insertFollowup({ dueAtMs: Date.now() - 1000, recurMinutes: 60, recurrence: 'every hour' });
        const row = await getRow(id);
        await followupService.cancel(id);
        expect((await followupService.recordDelivery(row)).advanced).toBe(false);
        expect((await getRow(id)).status).toBe('CANCELLED');
        expect((await getRow(id)).deliveryCount).toBe(0);
    });
});

describe('heartbeat delivery of recurring follow-ups', () => {
    test('an hourly follow-up is delivered, rescheduled, and NOT redelivered next pass', async () => {
        const dueMs = Date.now() - 1000;
        const id = await insertFollowup({ dueAtMs: dueMs, recurMinutes: 60, recurrence: 'every hour' });
        const { heartbeat, sent } = makeHeartbeat();

        await heartbeat.deliverDueFollowups();
        expect(sent).toHaveLength(1);
        expect(sent[0].content).toMatch(/^⏰ /);

        const row = await getRow(id);
        expect(row.status).toBe('PENDING');
        expect(row.deliveryCount).toBe(1);
        expect(utcMs(row.dueAt)).toBeGreaterThan(Date.now());

        // The very next minute pass finds nothing due - no duplicate delivery
        await heartbeat.deliverDueFollowups();
        expect(sent).toHaveLength(1);
        expect((await getRow(id)).deliveryCount).toBe(1);
    });

    test('one-shot delivery still goes DONE (unchanged behavior)', async () => {
        const id = await insertFollowup({ dueAtMs: Date.now() - 1000 });
        const { heartbeat, sent } = makeHeartbeat();

        await heartbeat.deliverDueFollowups();
        expect(sent).toHaveLength(1);
        expect((await getRow(id)).status).toBe('DONE');
    });

    test('a failed send leaves the row untouched, and the next pass retries it', async () => {
        const dueMs = Date.now() - 1000;
        const id = await insertFollowup({ dueAtMs: dueMs, recurMinutes: 60, recurrence: 'every hour' });
        const { heartbeat, channel, sent } = makeHeartbeat();

        channel.send.mockRejectedValueOnce(new Error('Discord hiccup'));
        await heartbeat.deliverDueFollowups();
        expect(sent).toHaveLength(0);

        // Unchanged: still PENDING at the original due time, nothing recorded
        let row = await getRow(id);
        expect(row.status).toBe('PENDING');
        expect(utcMs(row.dueAt)).toBe(utcMs(utcText(dueMs)));
        expect(row.deliveryCount).toBe(0);

        // The retry pass succeeds and reschedules
        await heartbeat.deliverDueFollowups();
        expect(sent).toHaveLength(1);
        row = await getRow(id);
        expect(row.deliveryCount).toBe(1);
        expect(utcMs(row.dueAt)).toBeGreaterThan(Date.now());
    });

    test('overlapping delivery passes cannot double-send (re-entrancy guard)', async () => {
        await insertFollowup({ dueAtMs: Date.now() - 1000, recurMinutes: 60, recurrence: 'every hour' });
        const { heartbeat, sent } = makeHeartbeat();

        // Make the phrasing model call slow, as a >60s provider call would be
        let releaseModel;
        const modelGate = new Promise(resolve => { releaseModel = resolve; });
        aiService.generateText.mockImplementation(async () => {
            await modelGate;
            return 'Checking in!';
        });

        const firstPass = heartbeat.deliverDueFollowups();
        const secondPass = heartbeat.deliverDueFollowups(); // the next timer tick
        releaseModel();
        await Promise.all([firstPass, secondPass]);

        expect(sent).toHaveLength(1);
    });

    test('a vanished channel cancels the whole recurring series', async () => {
        const id = await insertFollowup({ dueAtMs: Date.now() - 1000, recurMinutes: 60, recurrence: 'every hour' });
        const { heartbeat, sent } = makeHeartbeat();
        heartbeat.client.channels.fetch.mockResolvedValue(null);

        await heartbeat.deliverDueFollowups();
        expect(sent).toHaveLength(0);
        expect((await getRow(id)).status).toBe('CANCELLED');
    });
});

describe('restart recovery', () => {
    test('a recurring follow-up survives a restart and catches up with ONE delivery', async () => {
        // Scheduled hourly, but the bot was "down" for 4.5 hours
        const dueMs = truncMs(Date.now() - 4.5 * 60 * 60 * 1000);
        const id = await insertFollowup({ dueAtMs: dueMs, recurMinutes: 60, recurrence: 'every hour' });

        // A restart is a fresh HeartbeatService over the same SQLite file
        const { heartbeat, sent } = makeHeartbeat();
        await heartbeat.deliverDueFollowups();

        expect(sent).toHaveLength(1); // one catch-up message, not 4
        const row = await getRow(id);
        expect(row.status).toBe('PENDING');
        expect(row.deliveryCount).toBe(1);
        // Next occurrence is in the future, still on the hourly grid
        expect(utcMs(row.dueAt)).toBeGreaterThan(Date.now());
        expect((utcMs(row.dueAt) - dueMs) % (60 * 60 * 1000)).toBe(0);

        // And the pass after that delivers nothing further
        await heartbeat.deliverDueFollowups();
        expect(sent).toHaveLength(1);
    });

    test('recurring metadata round-trips through the database untouched', async () => {
        const id = await insertFollowup({
            dueAtMs: Date.now() + 60 * 60 * 1000, recurMinutes: 120, recurrence: 'every 2 hours'
        });
        const row = await getRow(id);
        expect(row.recurMinutes).toBe(120);
        expect(row.recurrence).toBe('every 2 hours');
        const pending = await followupService.getPending(GUILD);
        expect(pending.find(f => f.id === id).recurrence).toBe('every 2 hours');
    });
});
