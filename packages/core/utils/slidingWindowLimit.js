/**
 * Shared sliding-window rate limit (Phase 5c).
 *
 * Rows live in `web_rate_events` so every api replica shares one budget.
 * SQLite transactions serialize the check+insert; Postgres may admit one
 * extra event under a race, which is acceptable for these ceilings.
 * Redis is still not required (spec §11: only when N>1 pub/sub is real).
 */

const db = require('../db');

/**
 * Try to consume one slot in a sliding window.
 * @param {Object} params
 * @param {string} params.scope - bucket name (e.g. 'web_chat')
 * @param {string} params.subject - usually a userId
 * @param {number} params.max - inclusive ceiling inside the window
 * @param {number} params.windowMs
 * @returns {Promise<boolean>} true when the event was recorded
 */
async function consumeWindow({ scope, subject, max, windowMs }) {
    if (!scope || !subject) return true;
    const now = Date.now();
    const cutoff = now - Number(windowMs);
    return db.transaction(async () => {
        await db.run(
            `DELETE FROM web_rate_events
             WHERE scope = @scope AND subject = @subject AND createdAtMs < @cutoff`,
            { scope, subject, cutoff }
        );
        const row = await db.get(
            `SELECT COUNT(*) AS c FROM web_rate_events
             WHERE scope = @scope AND subject = @subject AND createdAtMs >= @cutoff`,
            { scope, subject, cutoff }
        );
        if ((row?.c || 0) >= max) return false;
        await db.run(
            `INSERT INTO web_rate_events (scope, subject, createdAtMs)
             VALUES (@scope, @subject, @now)`,
            { scope, subject, now }
        );
        return true;
    });
}

/**
 * Drop every rate-limit row for a user (/forget-me).
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function forgetSubject(userId) {
    return (await db.run(
        'DELETE FROM web_rate_events WHERE subject = @userId',
        { userId }
    )).changes;
}

module.exports = { consumeWindow, forgetSubject };
