const db = require('../db');
const memoryService = require('./memoryService');

/**
 * Counts-only server activity tracking (feeds /wrapped). One aggregated row
 * per user/channel/UTC-day - no message content is ever stored, consistent
 * with the privacy story. Recording must never break message handling, so
 * every write is wrapped and failures are swallowed (same contract as
 * usageTracker).
 */
class ActivityService {
    /**
     * Count one message. Skips channels excluded via /privacy.
     * @param {Object} entry - { guildId, channelId, userId }
     */
    recordMessage({ guildId, channelId, userId }) {
        try {
            if (!guildId || !channelId || !userId) return;
            if (memoryService.isChannelExcluded(guildId, channelId)) return;

            db.run(
                `INSERT INTO guild_activity (guildId, channelId, userId, day, messageCount)
                 VALUES (@guildId, @channelId, @userId, date('now'), 1)
                 ON CONFLICT(guildId, channelId, userId, day)
                 DO UPDATE SET messageCount = messageCount + 1`,
                { guildId, channelId, userId }
            );
        } catch (error) {
            console.warn('[ActivityService] Failed to record message:', error.message);
        }
    }

    /**
     * Drop all activity rows for a channel (privacy scope control - called
     * when a channel is excluded via /privacy, mirroring the memory purge).
     * @returns {number} rows removed
     */
    purgeChannel(guildId, channelId) {
        return db.run(
            'DELETE FROM guild_activity WHERE guildId = @guildId AND channelId = @channelId',
            { guildId, channelId }
        ).changes;
    }

    /**
     * Anonymize a user's activity rows (GDPR-style erasure): null the userId,
     * keep the counts so server totals stay accurate. NULL values are
     * distinct in SQLite unique indexes, so this never hits a PK conflict;
     * aggregation queries SUM across rows, so multiple NULL rows per key are
     * harmless.
     * @returns {number} rows anonymized
     */
    anonymizeUser({ userId }) {
        return db.run(
            'UPDATE guild_activity SET userId = NULL WHERE userId = @userId',
            { userId }
        ).changes;
    }

    /**
     * A user's activity footprint in a guild (for the transparency report).
     * @returns {{rows: number, messages: number}}
     */
    getUserStats({ guildId, userId }) {
        const row = db.get(
            `SELECT COUNT(*) AS rowCount, COALESCE(SUM(messageCount), 0) AS messages
             FROM guild_activity WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );
        return { rows: row?.rowCount || 0, messages: row?.messages || 0 };
    }
}

module.exports = new ActivityService();
