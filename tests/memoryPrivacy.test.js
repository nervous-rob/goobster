/**
 * Unit tests for memory privacy controls (channel exclusions, retention) and
 * the command usage counter, against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-memory-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const memoryService = require('../services/memoryService');
const usageTracker = require('../services/usageTracker');

const GUILD = '300000000000000001';
const CHANNEL = '400000000000000001';

function insertMemory({ channelId = null, content, ageDays = 0 }) {
    db.run(
        `INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model, createdAt)
         VALUES (@g, @c, 'u1', 'Someone', @content, x'00000000', 1, 'test/model', datetime('now', '-' || @ageDays || ' days'))`,
        { g: GUILD, c: channelId, content, ageDays }
    );
}

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

describe('channel exclusions', () => {
    test('remember() refuses excluded channels without touching the embedder', async () => {
        memoryService.excludeChannel(GUILD, CHANNEL);
        expect(memoryService.isChannelExcluded(GUILD, CHANNEL)).toBe(true);

        const stored = await memoryService.remember({
            guildId: GUILD,
            channelId: CHANNEL,
            authorId: 'u1',
            authorName: 'Someone',
            content: 'a secret long enough to pass the length filter'
        });
        expect(stored).toBe(false);
        expect(db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @g', { g: GUILD }).c).toBe(0);
    });

    test('excluding a channel purges memories already stored from it', () => {
        memoryService.includeChannel(GUILD, CHANNEL);
        insertMemory({ channelId: CHANNEL, content: 'stored before exclusion' });
        insertMemory({ channelId: 'other-channel', content: 'different channel' });

        const removed = memoryService.excludeChannel(GUILD, CHANNEL);
        expect(removed).toBe(1);

        const remaining = db.all('SELECT content FROM memory_embeddings WHERE guildId = @g', { g: GUILD });
        expect(remaining.map(r => r.content)).toEqual(['different channel']);
    });

    test('include/exclude round-trips through getExcludedChannels', () => {
        expect(memoryService.getExcludedChannels(GUILD)).toEqual([CHANNEL]);
        memoryService.includeChannel(GUILD, CHANNEL);
        expect(memoryService.getExcludedChannels(GUILD)).toEqual([]);
    });
});

describe('retention', () => {
    test('applyRetention deletes only memories older than the window', () => {
        db.run(
            `INSERT INTO guild_settings (guildId, memory_retention_days) VALUES (@g, 30)
             ON CONFLICT(guildId) DO UPDATE SET memory_retention_days = 30`,
            { g: GUILD }
        );
        insertMemory({ content: 'ancient memory', ageDays: 45 });
        insertMemory({ content: 'fresh memory', ageDays: 5 });

        const removed = memoryService.applyRetention(GUILD);
        expect(removed).toBe(1);

        const contents = db.all('SELECT content FROM memory_embeddings WHERE guildId = @g', { g: GUILD }).map(r => r.content);
        expect(contents).toContain('fresh memory');
        expect(contents).not.toContain('ancient memory');
    });

    test('no retention window means nothing is deleted', () => {
        db.run('UPDATE guild_settings SET memory_retention_days = NULL WHERE guildId = @g', { g: GUILD });
        insertMemory({ content: 'very old but kept', ageDays: 400 });
        expect(memoryService.applyRetention(GUILD)).toBe(0);
    });

    test('applyRetentionAll covers every guild with a window set', () => {
        db.run('UPDATE guild_settings SET memory_retention_days = 30 WHERE guildId = @g', { g: GUILD });
        expect(memoryService.applyRetentionAll()).toBe(1); // the 400-day-old row
    });
});

describe('command counter', () => {
    test('logCommand + getCommandStats count calls and unique users', () => {
        usageTracker.logCommand({ command: 'recall', guildId: GUILD, userId: 'u1' });
        usageTracker.logCommand({ command: 'recall', guildId: GUILD, userId: 'u1' });
        usageTracker.logCommand({ command: 'recall', guildId: GUILD, userId: 'u2' });
        usageTracker.logCommand({ command: 'other', guildId: GUILD, userId: 'u3' });

        const stats = usageTracker.getCommandStats({ command: 'recall', guildId: GUILD, days: 7 });
        expect(stats.calls).toBe(3);
        expect(stats.uniqueUsers).toBe(2);

        const allGuilds = usageTracker.getCommandStats({ command: 'recall', days: 7 });
        expect(allGuilds.calls).toBe(3);
    });
});
