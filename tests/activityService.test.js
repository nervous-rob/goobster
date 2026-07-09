/**
 * Unit tests for the counts-only activity tracker (services/activityService.js)
 * that feeds /wrapped, against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-activity-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const activityService = require('../services/activityService');

const GUILD = '300000000000000001';
const CHANNEL = '300000000000000002';
const EXCLUDED_CHANNEL = '300000000000000003';
const USER = '300000000000000004';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('recordMessage', () => {
    test('creates one row per user/channel/day and increments it via UPSERT', () => {
        activityService.recordMessage({ guildId: GUILD, channelId: CHANNEL, userId: USER });
        activityService.recordMessage({ guildId: GUILD, channelId: CHANNEL, userId: USER });
        activityService.recordMessage({ guildId: GUILD, channelId: CHANNEL, userId: USER });

        const rows = db.all(
            'SELECT day, messageCount FROM guild_activity WHERE guildId = @g AND channelId = @c AND userId = @u',
            { g: GUILD, c: CHANNEL, u: USER }
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].messageCount).toBe(3);
        // day is stored as UTC 'YYYY-MM-DD'
        expect(rows[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('never stores message content - only counters', () => {
        const columns = db.all(`PRAGMA table_info(guild_activity)`).map(c => c.name);
        expect(columns.sort()).toEqual(['channelId', 'day', 'guildId', 'messageCount', 'userId']);
    });

    test('skips channels excluded via /privacy', () => {
        db.run(
            'INSERT INTO memory_channel_exclusions (guildId, channelId) VALUES (@g, @c)',
            { g: GUILD, c: EXCLUDED_CHANNEL }
        );

        activityService.recordMessage({ guildId: GUILD, channelId: EXCLUDED_CHANNEL, userId: USER });

        const count = db.get(
            'SELECT COUNT(*) AS c FROM guild_activity WHERE channelId = @c',
            { c: EXCLUDED_CHANNEL }
        ).c;
        expect(count).toBe(0);
    });

    test('ignores incomplete entries without throwing', () => {
        expect(() => activityService.recordMessage({ guildId: GUILD, channelId: null, userId: USER })).not.toThrow();
        expect(() => activityService.recordMessage({})).not.toThrow();
    });
});

describe('purgeChannel', () => {
    test('drops all activity rows for a channel', () => {
        const removed = activityService.purgeChannel(GUILD, CHANNEL);
        expect(removed).toBe(1);
        expect(db.get('SELECT COUNT(*) AS c FROM guild_activity WHERE channelId = @c', { c: CHANNEL }).c).toBe(0);
    });
});

describe('anonymizeUser / getUserStats', () => {
    test('nulls the userId but keeps counts', () => {
        db.run(
            `INSERT INTO guild_activity (guildId, channelId, userId, day, messageCount)
             VALUES (@g, @c, @u, '2026-07-01', 9)`,
            { g: GUILD, c: CHANNEL, u: USER }
        );

        expect(activityService.getUserStats({ guildId: GUILD, userId: USER })).toEqual({ rows: 1, messages: 9 });

        const changed = activityService.anonymizeUser({ userId: USER });
        expect(changed).toBe(1);

        expect(activityService.getUserStats({ guildId: GUILD, userId: USER })).toEqual({ rows: 0, messages: 0 });
        expect(db.get('SELECT SUM(messageCount) AS c FROM guild_activity WHERE userId IS NULL').c).toBe(9);
    });
});
