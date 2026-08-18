const db = require('../../db');

/**
 * The exchange's audit trail. `economy_transactions` records that points
 * moved; this records WHY - every automatic action the risk engine takes
 * (interest, borrow fees, fills, expiries, margin calls, liquidations,
 * settlements) plus the deliberate risk opt-ins a trader makes.
 *
 * Writes are wrapped like usageTracker.log: auditing must never break the
 * action it is auditing.
 */

const MAX_LIMIT = 200;

/**
 * @param {{guildId: string, userId?: string|null, eventType: string,
 *          symbol?: string|null, amount?: number|null, detail?: Object|null}} event
 */
async function record({ guildId, userId = null, eventType, symbol = null, amount = null, detail = null }) {
    try {
        await db.run(
            `INSERT INTO exchange_events (guildId, userId, eventType, symbol, amount, detail)
             VALUES (@guildId, @userId, @eventType, @symbol, @amount, @detail)`,
            {
                guildId,
                userId,
                eventType,
                symbol,
                amount: amount === null || amount === undefined ? null : Math.round(amount),
                detail: detail ? JSON.stringify(detail) : null
            }
        );
    } catch (error) {
        console.warn('[Exchange] Failed to record event:', error.message);
    }
}

/**
 * Recent events, newest first. Scoped to a guild, optionally to one user
 * and/or a set of event types.
 * @returns {Array<{id, userId, eventType, symbol, amount, detail: Object|null, createdAt}>}
 */
async function list({ guildId, userId = null, types = null, limit = 20 } = {}) {
    const bounded = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || 20));
    const filters = ['guildId = @guildId'];
    const params = { guildId, limit: bounded };
    if (userId) {
        filters.push('userId = @userId');
        params.userId = userId;
    }
    if (Array.isArray(types) && types.length > 0) {
        const placeholders = types.map((type, index) => {
            params[`type${index}`] = type;
            return `@type${index}`;
        });
        filters.push(`eventType IN (${placeholders.join(', ')})`);
    }

    return (await db.all(
        `SELECT id, userId, eventType, symbol, amount, detail, createdAt
         FROM exchange_events WHERE ${filters.join(' AND ')}
         ORDER BY id DESC LIMIT @limit`,
        params
    )).map(row => ({ ...row, detail: parseDetail(row.detail) }));
}

/** Event counts by type for a guild, for the economy dashboard. */
async function countsByType({ guildId, sinceDays = null } = {}) {
    const window = sinceDays ? "AND createdAt >= datetime('now', '-' || @sinceDays || ' days')" : '';
    return await db.all(
        `SELECT eventType, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS totalAmount
         FROM exchange_events WHERE guildId = @guildId ${window}
         GROUP BY eventType ORDER BY count DESC`,
        { guildId, sinceDays }
    );
}

function parseDetail(detail) {
    if (!detail) return null;
    try {
        return JSON.parse(detail);
    } catch {
        return { raw: detail };
    }
}

module.exports = { record, list, countsByType };
