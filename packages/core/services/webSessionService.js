/**
 * Web app session store (SQLite-backed).
 *
 * Sessions for the browser web interface (web/appApi.js). Unlike the
 * Activity's transient in-memory sessions, these must survive restarts -
 * a Pi reboot should never log every web user out - so they live in the
 * web_sessions table. Only the SHA-256 of the token is stored (the
 * screen-vision pairing pattern); the raw token exists only in the user's
 * cookie.
 */

const crypto = require('node:crypto');
const db = require('../db');

const SESSION_TTL_DAYS = 30;

/** @param {string} token */
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

class WebSessionService {
    /**
     * Create a session and return the raw token (stored only as a hash).
     * @param {Object} params
     * @param {string} params.userId - Discord user snowflake
     * @param {string} [params.userName] - display name at login time
     * @param {string} [params.avatar] - Discord avatar hash, if any
     * @returns {{ token: string, expiresAt: string }}
     */
    create({ userId, userName = null, avatar = null }) {
        if (!/^\d{5,20}$/.test(String(userId || ''))) {
            throw new Error('A Discord user id is required to create a web session.');
        }
        this.pruneExpired();

        const token = crypto.randomBytes(32).toString('hex');
        const row = db.get(
            `INSERT INTO web_sessions (tokenHash, userId, userName, avatar, expiresAt, lastSeenAt)
             VALUES (@tokenHash, @userId, @userName, @avatar, datetime('now', @ttl), datetime('now'))
             RETURNING expiresAt`,
            {
                tokenHash: hashToken(token),
                userId: String(userId),
                userName,
                avatar,
                ttl: `+${SESSION_TTL_DAYS} days`
            }
        );
        return { token, expiresAt: row.expiresAt };
    }

    /**
     * Resolve a raw token to its live session, updating lastSeenAt.
     * @param {string} token
     * @returns {{ userId: string, userName: string|null, avatar: string|null }|null}
     */
    get(token) {
        if (!token || typeof token !== 'string') return null;
        const row = db.get(
            `SELECT id, userId, userName, avatar FROM web_sessions
             WHERE tokenHash = @tokenHash AND expiresAt > datetime('now')`,
            { tokenHash: hashToken(token) }
        );
        if (!row) return null;
        db.run(
            `UPDATE web_sessions SET lastSeenAt = datetime('now') WHERE id = @id`,
            { id: row.id }
        );
        return { userId: row.userId, userName: row.userName, avatar: row.avatar };
    }

    /**
     * Destroy one session (logout).
     * @param {string} token
     * @returns {boolean} whether a session was removed
     */
    destroy(token) {
        if (!token || typeof token !== 'string') return false;
        const result = db.run(
            'DELETE FROM web_sessions WHERE tokenHash = @tokenHash',
            { tokenHash: hashToken(token) }
        );
        return result.changes > 0;
    }

    /**
     * Destroy every session belonging to a user (used by /forget-me).
     * @param {string} userId
     * @returns {number} sessions removed
     */
    destroyAllForUser(userId) {
        const result = db.run(
            'DELETE FROM web_sessions WHERE userId = @userId',
            { userId: String(userId) }
        );
        return result.changes;
    }

    /** Remove expired rows (called opportunistically on create). */
    pruneExpired() {
        db.run(`DELETE FROM web_sessions WHERE expiresAt <= datetime('now')`);
    }
}

module.exports = new WebSessionService();
