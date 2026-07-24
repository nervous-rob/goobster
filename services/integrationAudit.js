const db = require('../db');

/**
 * Audit ledger for the developer integrations: one row per externally
 * visible action (watch added/removed, agent launched/followed-up/cancelled).
 * Guardrail requirement — write-side integration actions must be attributable
 * after the fact. Recording is wrapped like usageTracker.log: it must never
 * break the action it observes.
 */
module.exports = {
    /**
     * @param {{guildId: string, userId?: string|null, action: string, detail?: object|null}} entry
     */
    record({ guildId, userId = null, action, detail = null }) {
        try {
            db.run(
                `INSERT INTO integration_audit (guildId, userId, action, detail)
                 VALUES (@guildId, @userId, @action, @detail)`,
                { guildId, userId, action, detail: detail ? JSON.stringify(detail) : null }
            );
        } catch (error) {
            console.error('Failed to record integration audit entry:', error);
        }
    },

    /** Recent audit rows for a guild, newest first. */
    recent(guildId, limit = 20) {
        return db.all(
            `SELECT userId, action, detail, createdAt
             FROM integration_audit
             WHERE guildId = @guildId
             ORDER BY id DESC
             LIMIT @limit`,
            { guildId, limit }
        );
    }
};
