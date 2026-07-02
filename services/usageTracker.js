const db = require('../db');

/**
 * AI usage tracking. Providers log token counts here after every API call;
 * the /usage command reads summaries. Logging must never break a request,
 * so every write is wrapped and failures are swallowed.
 *
 * Callers thread attribution through provider opts as
 * opts.usageContext = { guildId, userId } - both optional.
 */
class UsageTracker {
    /**
     * Record one API call.
     * @param {Object} entry - { provider, model, operation, inputTokens, outputTokens, count, guildId, userId }
     */
    log({ provider, model, operation, inputTokens = 0, outputTokens = 0, count = 1, guildId = null, userId = null }) {
        try {
            db.run(
                `INSERT INTO usage_log (guildId, userId, provider, model, operation, inputTokens, outputTokens, count)
                 VALUES (@guildId, @userId, @provider, @model, @operation, @inputTokens, @outputTokens, @count)`,
                {
                    guildId,
                    userId,
                    provider,
                    model: model || 'unknown',
                    operation,
                    inputTokens: Math.max(0, Math.round(inputTokens || 0)),
                    outputTokens: Math.max(0, Math.round(outputTokens || 0)),
                    count
                }
            );
        } catch (error) {
            console.warn('[UsageTracker] Failed to log usage:', error.message);
        }
    }

    /**
     * Per-model summary for a window.
     * @param {Object} params - { guildId (null = all guilds), days }
     * @returns {Array<{provider, model, operation, calls, inputTokens, outputTokens}>}
     */
    getSummary({ guildId = null, days = 7 }) {
        const guildFilter = guildId ? 'AND guildId = @guildId' : '';
        return db.all(
            `SELECT provider, model, operation,
                    SUM(count) AS calls,
                    SUM(inputTokens) AS inputTokens,
                    SUM(outputTokens) AS outputTokens
             FROM usage_log
             WHERE createdAt >= datetime('now', '-' || @days || ' days') ${guildFilter}
             GROUP BY provider, model, operation
             ORDER BY inputTokens + outputTokens DESC`,
            { guildId, days }
        );
    }

    /**
     * Top users by token volume for a guild.
     */
    getTopUsers({ guildId, days = 7, limit = 5 }) {
        return db.all(
            `SELECT userId,
                    SUM(count) AS calls,
                    SUM(inputTokens + outputTokens) AS totalTokens
             FROM usage_log
             WHERE guildId = @guildId AND userId IS NOT NULL
               AND createdAt >= datetime('now', '-' || @days || ' days')
             GROUP BY userId
             ORDER BY totalTokens DESC LIMIT @limit`,
            { guildId, days, limit }
        );
    }

    /**
     * Grand totals for a window.
     */
    getTotals({ guildId = null, days = 7 }) {
        const guildFilter = guildId ? 'AND guildId = @guildId' : '';
        const row = db.get(
            `SELECT SUM(count) AS calls,
                    SUM(inputTokens) AS inputTokens,
                    SUM(outputTokens) AS outputTokens
             FROM usage_log
             WHERE createdAt >= datetime('now', '-' || @days || ' days') ${guildFilter}`,
            { guildId, days }
        );
        return {
            calls: row?.calls || 0,
            inputTokens: row?.inputTokens || 0,
            outputTokens: row?.outputTokens || 0
        };
    }
}

module.exports = new UsageTracker();
