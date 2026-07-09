/**
 * Unit tests for the Server Wrapped stats aggregation
 * (services/wrappedService.js), against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-wrapped-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const wrappedService = require('../services/wrappedService');

const GUILD = '400000000000000001';
const OTHER_GUILD = '400000000000000002';
const ALICE = '400000000000000011';
const BOB = '400000000000000012';
const GENERAL = '400000000000000021';
const MEMES = '400000000000000022';

// June 2026 is the wrapped window; July rows must be excluded.
const WINDOW = { guildId: GUILD, startDate: '2026-06-01', endDate: '2026-06-30' };

function seed() {
    const activity = [
        // [channelId, userId, day, count]
        [GENERAL, ALICE, '2026-06-05', 40],
        [GENERAL, BOB, '2026-06-05', 10],
        [GENERAL, ALICE, '2026-06-20', 5],
        [MEMES, BOB, '2026-06-20', 20],
        [MEMES, null, '2026-06-21', 8],       // anonymized rows still count in totals
        [GENERAL, ALICE, '2026-07-01', 99],   // outside window
    ];
    for (const [channelId, userId, day, messageCount] of activity) {
        db.run(
            `INSERT INTO guild_activity (guildId, channelId, userId, day, messageCount)
             VALUES (@g, @channelId, @userId, @day, @messageCount)`,
            { g: GUILD, channelId, userId, day, messageCount }
        );
    }
    // Different guild entirely - must never bleed in
    db.run(
        `INSERT INTO guild_activity (guildId, channelId, userId, day, messageCount)
         VALUES (@g, 'x', 'y', '2026-06-05', 1000)`,
        { g: OTHER_GUILD }
    );

    db.run(
        `INSERT INTO usage_log (guildId, userId, provider, model, operation, inputTokens, outputTokens, count, createdAt)
         VALUES (@g, @u, 'openai', 'gpt-test', 'chat', 100, 50, 2, '2026-06-10 12:00:00')`,
        { g: GUILD, u: ALICE }
    );
    db.run(
        `INSERT INTO usage_log (guildId, userId, provider, model, operation, inputTokens, outputTokens, count, createdAt)
         VALUES (@g, @u, 'openai', 'gpt-test', 'chat', 999, 999, 1, '2026-07-10 12:00:00')`,
        { g: GUILD, u: ALICE }
    );

    db.run(`INSERT INTO command_log (guildId, userId, command, createdAt) VALUES (@g, @u, 'recall', '2026-06-11 08:00:00')`, { g: GUILD, u: ALICE });
    db.run(`INSERT INTO command_log (guildId, userId, command, createdAt) VALUES (@g, @u, 'recall', '2026-06-12 08:00:00')`, { g: GUILD, u: ALICE });
    db.run(`INSERT INTO command_log (guildId, userId, command, createdAt) VALUES (@g, @u, 'joke', '2026-06-13 08:00:00')`, { g: GUILD, u: BOB });

    db.run(
        `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model, createdAt)
         VALUES (@g, @u, 'Alice', 'june memory', x'00000000', 1, 'test/model', '2026-06-15 10:00:00')`,
        { g: GUILD, u: ALICE }
    );
    db.run(`INSERT INTO facts (guildId, subjectType, content, createdAt) VALUES (@g, 'GUILD', 'movie night fridays', '2026-06-16 10:00:00')`, { g: GUILD });

    db.run(`INSERT INTO followups (guildId, channelId, userId, note, dueAt, status) VALUES (@g, @c, @u, 'done in june', '2026-06-18 09:00:00', 'DONE')`, { g: GUILD, c: GENERAL, u: ALICE });
    db.run(`INSERT INTO followups (guildId, channelId, userId, note, dueAt, status) VALUES (@g, @c, @u, 'still pending', '2026-06-19 09:00:00', 'PENDING')`, { g: GUILD, c: GENERAL, u: ALICE });
}

beforeAll(() => {
    seed();
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('resolvePeriod', () => {
    test('returns well-formed UTC date windows', () => {
        for (const key of ['this-month', 'last-month', 'this-year']) {
            const period = wrappedService.resolvePeriod(key);
            expect(period.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(period.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(period.startDate <= period.endDate).toBe(true);
            expect(period.label.length).toBeGreaterThan(0);
        }
    });

    test('last-month spans the full previous calendar month', () => {
        const period = wrappedService.resolvePeriod('last-month');
        expect(period.startDate.endsWith('-01')).toBe(true);
        const now = new Date();
        expect(period.endDate < wrappedService.resolvePeriod('this-month').startDate).toBe(true);
        expect(new Date(period.endDate) < now).toBe(true);
    });
});

describe('getWrappedStats', () => {
    let stats;

    beforeAll(() => {
        stats = wrappedService.getWrappedStats(WINDOW);
    });

    test('sums activity inside the window only, including anonymized rows', () => {
        expect(stats.activity.totalMessages).toBe(83); // 40+10+5+20+8
        expect(stats.activity.activeUsers).toBe(2);    // NULL userId doesn't count as a person
    });

    test('ranks top members (attributed only) and top channels', () => {
        expect(stats.activity.topMembers[0]).toEqual({ userId: ALICE, messages: 45 });
        expect(stats.activity.topMembers[1]).toEqual({ userId: BOB, messages: 30 });
        expect(stats.activity.topMembers).toHaveLength(2);

        expect(stats.activity.topChannels[0]).toEqual({ channelId: GENERAL, messages: 55 });
        expect(stats.activity.topChannels[1]).toEqual({ channelId: MEMES, messages: 28 });
    });

    test('finds the busiest day', () => {
        expect(stats.activity.busiestDay).toEqual({ day: '2026-06-05', messages: 50 });
    });

    test('aggregates AI usage, commands, and recall within the window', () => {
        expect(stats.ai.calls).toBe(2);          // count column, July row excluded
        expect(stats.ai.totalTokens).toBe(150);  // 100 + 50
        expect(stats.commands.total).toBe(3);
        expect(stats.commands.recall).toEqual({ calls: 2, uniqueUsers: 1 });
    });

    test('counts memory-system activity within the window', () => {
        expect(stats.memory.memoriesStored).toBe(1);
        expect(stats.memory.factsLearned).toBe(1);
        expect(stats.memory.followupsDelivered).toBe(1); // DONE only
    });

    test('returns zeros for a guild with no data', () => {
        const empty = wrappedService.getWrappedStats({
            guildId: '999999999999999999',
            startDate: '2026-06-01',
            endDate: '2026-06-30'
        });
        expect(empty.activity.totalMessages).toBe(0);
        expect(empty.activity.topMembers).toEqual([]);
        expect(empty.activity.busiestDay).toBeNull();
        expect(empty.ai.calls).toBe(0);
        expect(empty.memory.memoriesStored).toBe(0);
    });
});
