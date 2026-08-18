/**
 * Unit tests for the web dashboard's personal usage stats
 * (webDashboardService.getUsageStats) and the DM-scope memory retention
 * setting (getRetention/setRetention).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-usage-retention-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const webDashboardService = require('@goobster/core/services/webDashboardService');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const USER = '600000000000000001';
const OTHER = '600000000000000002';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM usage_log');
    await db.run('DELETE FROM memory_embeddings');
    await db.run('DELETE FROM guild_settings');
});

async function seedUsage({ userId, provider = 'openai', model = 'gpt-test', operation = 'chat', input = 100, output = 50, daysAgo = 0, count = 1 }) {
    await db.run(
        `INSERT INTO usage_log (guildId, userId, provider, model, operation, inputTokens, outputTokens, count, createdAt)
         VALUES (@scope, @userId, @provider, @model, @operation, @input, @output, @count,
                 @daysAgoCutoff)`,
        { scope: dmScopeId(userId), userId, provider, model, operation, input, output, count, daysAgoCutoff: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) }
    );
}

describe('getUsageStats', () => {
    test('aggregates the user\'s own rows: totals, per-model, per-day', async () => {
        await seedUsage({ userId: USER, model: 'gpt-a', input: 100, output: 50, daysAgo: 0 });
        await seedUsage({ userId: USER, model: 'gpt-a', input: 200, output: 100, daysAgo: 1 });
        await seedUsage({ userId: USER, model: 'gpt-b', operation: 'image', input: 10, output: 5, daysAgo: 1 });
        // Another user's usage never leaks in
        await seedUsage({ userId: OTHER, model: 'gpt-a', input: 9999, output: 9999 });

        const stats = await webDashboardService.getUsageStats({ userId: USER, days: 30 });
        expect(stats.totals).toEqual({ calls: 3, inputTokens: 310, outputTokens: 155 });

        expect(stats.byModel).toHaveLength(2);
        expect(stats.byModel[0]).toMatchObject({ model: 'gpt-a', calls: 2, inputTokens: 300, outputTokens: 150 });
        expect(stats.byModel[1]).toMatchObject({ model: 'gpt-b', calls: 1 });

        expect(stats.byOperation.map(o => o.operation).sort()).toEqual(['chat', 'image']);

        expect(stats.byDay).toHaveLength(2);
        expect(stats.byDay[0].inputTokens).toBe(210); // yesterday: 200 + 10
        expect(stats.byDay[1].inputTokens).toBe(100); // today
    });

    test('the window filters old rows and days is clamped', async () => {
        await seedUsage({ userId: USER, input: 100, daysAgo: 0 });
        await seedUsage({ userId: USER, input: 100, daysAgo: 40 });

        expect((await webDashboardService.getUsageStats({ userId: USER, days: 7 })).totals.calls).toBe(1);
        expect((await webDashboardService.getUsageStats({ userId: USER, days: 90 })).totals.calls).toBe(2);
        // Nonsense clamps to sane defaults rather than erroring
        expect((await webDashboardService.getUsageStats({ userId: USER, days: 'nope' })).days).toBe(30);
        expect((await webDashboardService.getUsageStats({ userId: USER, days: 99999 })).days).toBe(365);
        expect((await webDashboardService.getUsageStats({ userId: USER, days: -5 })).days).toBe(1);
    });

    test('an empty history returns zeroed shapes, not errors', async () => {
        const stats = await webDashboardService.getUsageStats({ userId: USER });
        expect(stats.totals).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 });
        expect(stats.byModel).toEqual([]);
        expect(stats.byDay).toEqual([]);
    });
});

describe('memory retention (DM scope)', () => {
    const scope = dmScopeId(USER);

    async function seedMemory({ daysAgo, content = 'a memory' }) {
        await db.run(
            `INSERT INTO memory_embeddings (guildId, channelId, authorId, authorName, content, embedding, dims, model, createdAt)
             VALUES (@scope, 'chan', @userId, 'rob', @content, '[]', 3, 'test-model',
                     @daysAgoCutoff)`,
            { scope, userId: USER, content, daysAgoCutoff: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) }
        );
    }

    test('getRetention reports the stored window and memory count', async () => {
        await seedMemory({ daysAgo: 1 });
        expect(await webDashboardService.getRetention({ scope, userId: USER }))
            .toEqual({ retentionDays: null, memoryCount: 1 });
    });

    test('setRetention stores the window and purges immediately', async () => {
        await seedMemory({ daysAgo: 100, content: 'ancient' });
        await seedMemory({ daysAgo: 1, content: 'fresh' });

        const result = await webDashboardService.setRetention({ scope, userId: USER, days: 30 });
        expect(result.retentionDays).toBe(30);
        expect(result.purged).toBe(1);

        const remaining = await db.all('SELECT content FROM memory_embeddings WHERE guildId = @scope', { scope });
        expect(remaining.map(r => r.content)).toEqual(['fresh']);
        expect((await webDashboardService.getRetention({ scope, userId: USER })).retentionDays).toBe(30);
    });

    test('0 (or empty) clears the window back to keep-forever', async () => {
        await webDashboardService.setRetention({ scope, userId: USER, days: 30 });
        const cleared = await webDashboardService.setRetention({ scope, userId: USER, days: 0 });
        expect(cleared.retentionDays).toBeNull();
        expect((await webDashboardService.getRetention({ scope, userId: USER })).retentionDays).toBeNull();
    });

    test('validates the range', async () => {
        await expect(webDashboardService.setRetention({ scope, userId: USER, days: -1 }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_RETENTION' });
        await expect(webDashboardService.setRetention({ scope, userId: USER, days: 3651 }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_RETENTION' });
        await expect(webDashboardService.setRetention({ scope, userId: USER, days: 2.5 }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_RETENTION' });
    });

    test('DM scope only, and only your own', async () => {
        await expect(webDashboardService.setRetention({ scope: '123456789', userId: USER, days: 30 }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_SCOPE' });
        await expect(webDashboardService.setRetention({ scope: dmScopeId(OTHER), userId: USER, days: 30 }))
            .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
        await expect((async () => await webDashboardService.getRetention({ scope: dmScopeId(OTHER), userId: USER }))())
            .rejects.toThrow(expect.objectContaining({ status: 403 }));
    });
});
