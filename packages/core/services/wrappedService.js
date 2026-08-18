const db = require('../db');
const aiService = require('./aiService');
const factsService = require('./factsService');

/**
 * Server Wrapped: Spotify-Wrapped-style recap stats for a guild, aggregated
 * from local SQLite (guild_activity counters, usage_log/command_log, the
 * memory system). Pure synchronous SQL - presentation lives in
 * utils/serverWrapped.js and the /wrapped command.
 */
class WrappedService {
    /**
     * Format a Date as 'YYYY-MM-DD' UTC.
     */
    _day(date) {
        return date.toISOString().slice(0, 10);
    }

    /**
     * Resolve a period keyword into a concrete UTC date window.
     * @param {('this-month'|'last-month'|'this-year')} period
     * @returns {{key: string, label: string, startDate: string, endDate: string}}
     */
    resolvePeriod(period = 'last-month') {
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth();
        const monthName = (y, m) =>
            new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

        if (period === 'this-month') {
            return {
                key: period,
                label: monthName(year, month),
                startDate: this._day(new Date(Date.UTC(year, month, 1))),
                endDate: this._day(now)
            };
        }
        if (period === 'this-year') {
            return {
                key: period,
                label: String(year),
                startDate: this._day(new Date(Date.UTC(year, 0, 1))),
                endDate: this._day(now)
            };
        }
        // last-month (default): first through last day of the previous month
        return {
            key: 'last-month',
            label: monthName(year, month - 1),
            startDate: this._day(new Date(Date.UTC(year, month - 1, 1))),
            endDate: this._day(new Date(Date.UTC(year, month, 0)))
        };
    }

    /**
     * Aggregate Wrapped stats for a guild over a date window (inclusive).
     * Every section degrades to zeros/empty when its source is empty, since
     * early months will have thin guild_activity data.
     *
     * @param {Object} params - { guildId, startDate, endDate } ('YYYY-MM-DD')
     * @returns {Object} stats
     */
    getWrappedStats({ guildId, startDate, endDate }) {
        const window = { guildId, startDate, endDate };
        // Timestamps in the other tables are 'YYYY-MM-DD HH:MM:SS' UTC text
        const tsWindow = { guildId, startTs: `${startDate} 00:00:00`, endTs: `${endDate} 23:59:59` };

        const activityTotals = db.get(
            `SELECT COALESCE(SUM(messageCount), 0) AS totalMessages,
                    COUNT(DISTINCT userId) AS activeUsers
             FROM guild_activity
             WHERE guildId = @guildId AND day BETWEEN @startDate AND @endDate`,
            window
        );

        const topMembers = db.all(
            `SELECT userId, SUM(messageCount) AS messages
             FROM guild_activity
             WHERE guildId = @guildId AND day BETWEEN @startDate AND @endDate
               AND userId IS NOT NULL
             GROUP BY userId
             ORDER BY messages DESC LIMIT 5`,
            window
        );

        const topChannels = db.all(
            `SELECT channelId, SUM(messageCount) AS messages
             FROM guild_activity
             WHERE guildId = @guildId AND day BETWEEN @startDate AND @endDate
             GROUP BY channelId
             ORDER BY messages DESC LIMIT 3`,
            window
        );

        const busiestDay = db.get(
            `SELECT day, SUM(messageCount) AS messages
             FROM guild_activity
             WHERE guildId = @guildId AND day BETWEEN @startDate AND @endDate
             GROUP BY day
             ORDER BY messages DESC, day ASC LIMIT 1`,
            window
        );

        const ai = db.get(
            `SELECT COALESCE(SUM(count), 0) AS calls,
                    COALESCE(SUM(inputTokens), 0) AS inputTokens,
                    COALESCE(SUM(outputTokens), 0) AS outputTokens
             FROM usage_log
             WHERE guildId = @guildId AND createdAt BETWEEN @startTs AND @endTs`,
            tsWindow
        );

        const commandsTotal = db.get(
            `SELECT COUNT(*) AS c FROM command_log
             WHERE guildId = @guildId AND createdAt BETWEEN @startTs AND @endTs`,
            tsWindow
        );

        const recall = db.get(
            `SELECT COUNT(*) AS calls, COUNT(DISTINCT userId) AS uniqueUsers
             FROM command_log
             WHERE guildId = @guildId AND command = 'recall'
               AND createdAt BETWEEN @startTs AND @endTs`,
            tsWindow
        );

        const memoriesStored = db.get(
            `SELECT COUNT(*) AS c FROM memory_embeddings
             WHERE guildId = @guildId AND createdAt BETWEEN @startTs AND @endTs`,
            tsWindow
        );

        const factsLearned = db.get(
            `SELECT COUNT(*) AS c FROM facts
             WHERE guildId = @guildId AND createdAt BETWEEN @startTs AND @endTs`,
            tsWindow
        );

        // followups has no completion timestamp; delivered = DONE with a due
        // date inside the window.
        const followupsDelivered = db.get(
            `SELECT COUNT(*) AS c FROM followups
             WHERE guildId = @guildId AND status = 'DONE'
               AND dueAt BETWEEN @startTs AND @endTs`,
            tsWindow
        );

        return {
            period: { startDate, endDate },
            activity: {
                totalMessages: activityTotals?.totalMessages || 0,
                activeUsers: activityTotals?.activeUsers || 0,
                topMembers,
                topChannels,
                busiestDay: busiestDay?.day ? busiestDay : null
            },
            ai: {
                calls: ai?.calls || 0,
                inputTokens: ai?.inputTokens || 0,
                outputTokens: ai?.outputTokens || 0,
                totalTokens: (ai?.inputTokens || 0) + (ai?.outputTokens || 0)
            },
            commands: {
                total: commandsTotal?.c || 0,
                recall: { calls: recall?.calls || 0, uniqueUsers: recall?.uniqueUsers || 0 }
            },
            memory: {
                memoriesStored: memoriesStored?.c || 0,
                factsLearned: factsLearned?.c || 0,
                followupsDelivered: followupsDelivered?.c || 0
            }
        };
    }

    /**
     * Optional flavor: a short AI-written "month in review" blurb from the
     * top stats plus a few server facts. Never throws - returns null when no
     * AI provider is usable or the window is empty.
     *
     * @param {Object} stats - from getWrappedStats
     * @param {Object} options - { guildId, guildName, periodLabel, usageContext }
     * @returns {Promise<string|null>}
     */
    async buildBlurb(stats, { guildId, guildName, periodLabel, usageContext } = {}) {
        try {
            if (!stats || (stats.activity.totalMessages === 0 && stats.ai.calls === 0)) return null;

            const facts = factsService.getGuildFacts(guildId, 5).map(f => `- ${f.content}`);
            const summary = [
                `Server: ${guildName || 'this server'}`,
                `Period: ${periodLabel || `${stats.period.startDate} to ${stats.period.endDate}`}`,
                `Messages counted: ${stats.activity.totalMessages} from ${stats.activity.activeUsers} people`,
                stats.activity.busiestDay ? `Busiest day: ${stats.activity.busiestDay.day} (${stats.activity.busiestDay.messages} messages)` : null,
                `AI calls: ${stats.ai.calls} (${stats.ai.totalTokens} tokens)`,
                `New long-term memories: ${stats.memory.memoriesStored}, facts learned: ${stats.memory.factsLearned}`,
                facts.length > 0 ? `Known server facts:\n${facts.join('\n')}` : null
            ].filter(Boolean).join('\n');

            const blurb = await aiService.chatText([
                {
                    role: 'system',
                    content: 'You are Goobster, a quirky Discord bot writing the intro blurb for a "Server Wrapped" recap card. Write 2-3 warm, playful sentences celebrating the server\'s period in review, grounded ONLY in the stats provided. No headings, no bullet points, no emojis, under 60 words.'
                },
                { role: 'user', content: summary }
            ], {
                preset: 'chat',
                max_tokens: 200,
                usageContext
            });

            return blurb?.trim() || null;
        } catch (error) {
            console.warn('[WrappedService] Blurb generation skipped:', error.message);
            return null;
        }
    }
}

module.exports = new WrappedService();
