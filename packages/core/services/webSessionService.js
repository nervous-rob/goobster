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
const identityService = require('./identityService');

const SESSION_TTL_DAYS = 30;

/** @param {string} token */
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

class WebSessionService {
    /**
     * Create a session and return the raw token (stored only as a hash).
     *
     * `userId` is the principal id: a Discord snowflake for a legacy user
     * (the principal row is provisioned here if missing, so every portal
     * login leaves a resolvable identity behind) or a native `usr_<uuid>`
     * that must already exist in `principals`.
     * @param {Object} params
     * @param {string} params.userId - principal id
     * @param {string} [params.userName] - display name at login time
     * @param {string} [params.avatar] - Discord avatar hash, if any
     * @returns {{ token: string, expiresAt: string }}
     */
    async create({ userId, userName = null, avatar = null }) {
        const principalId = String(userId || '');
        if (identityService.isSnowflake(principalId)) {
            await identityService.ensureLegacyPrincipal({ discordId: principalId, displayName: userName });
        } else if (identityService.isNativeId(principalId)) {
            if (!(await identityService.getPrincipal(principalId))) {
                throw new Error('Unknown principal - native accounts must be created before they can sign in.');
            }
        } else {
            throw new Error('A principal id (Discord snowflake or usr_<uuid>) is required to create a web session.');
        }
        await this.pruneExpired();

        // Snapshot the account's session version so a later reset or
        // disable (which bumps it) invalidates this session on next use.
        const account = await identityService.getAccount(principalId);
        const token = crypto.randomBytes(32).toString('hex');
        const row = await db.get(
            `INSERT INTO web_sessions (tokenHash, userId, userName, avatar, expiresAt, lastSeenAt, authenticatedAt, sessionVersion)
             VALUES (@tokenHash, @userId, @userName, @avatar, @expiresAt, datetime('now'), datetime('now'), @sessionVersion)
             RETURNING expiresAt`,
            {
                tokenHash: hashToken(token),
                userId: principalId,
                userName,
                avatar,
                expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
                sessionVersion: account ? account.sessionVersion : null
            }
        );
        return { token, expiresAt: row.expiresAt };
    }

    /**
     * Resolve a raw token to its live session, updating lastSeenAt.
     * @param {string} token
     * @returns {{ id: number, userId: string, userName: string|null, avatar: string|null, authenticatedAt: string|null, sessionVersion: number|null }|null}
     */
    async get(token, { touch = true } = {}) {
        if (!token || typeof token !== 'string') return null;
        const row = await db.get(
            `SELECT id, userId, userName, avatar, authenticatedAt, sessionVersion FROM web_sessions
             WHERE tokenHash = @tokenHash AND expiresAt > datetime('now')`,
            { tokenHash: hashToken(token) }
        );
        if (!row) return null;
        if (touch) await db.run(
            `UPDATE web_sessions SET lastSeenAt = datetime('now') WHERE id = @id`,
            { id: row.id }
        );
        return {
            id: row.id,
            userId: row.userId,
            userName: row.userName,
            avatar: row.avatar,
            authenticatedAt: row.authenticatedAt || null,
            sessionVersion: row.sessionVersion == null ? null : Number(row.sessionVersion)
        };
    }

    /**
     * Record a fresh proof of identity on a live session (password re-auth),
     * so sensitive account changes can proceed without a new login.
     * @param {string} token
     * @returns {Promise<boolean>}
     */
    async markAuthenticated(token) {
        if (!token || typeof token !== 'string') return false;
        const result = await db.run(
            `UPDATE web_sessions SET authenticatedAt = datetime('now')
             WHERE tokenHash = @tokenHash AND expiresAt > datetime('now')`,
            { tokenHash: hashToken(token) }
        );
        return result.changes > 0;
    }

    /**
     * Whether a session's last authentication is within the recent-auth
     * window. Legacy rows without a timestamp are treated as stale.
     * @param {{ authenticatedAt?: string|null }} session
     * @param {number} withinMinutes
     */
    isRecentlyAuthenticated(session, withinMinutes) {
        const raw = session?.authenticatedAt;
        if (!raw) return false;
        const at = Date.parse(`${String(raw).replace(' ', 'T')}Z`);
        if (!Number.isFinite(at)) return false;
        return Date.now() - at <= withinMinutes * 60 * 1000;
    }

    /**
     * Refresh a live session's lastSeenAt without resolving it (the portal
     * event stream's keep-warm: an open tab holds one SSE connection, and
     * its heartbeat touches the session so presenceService keeps counting
     * the user as online). Fire-and-forget cheap UPDATE; expired or unknown
     * tokens are a no-op.
     * @param {string} token
     */
    async touch(token) {
        if (!token || typeof token !== 'string') return;
        await db.run(
            `UPDATE web_sessions SET lastSeenAt = datetime('now')
             WHERE tokenHash = @tokenHash AND expiresAt > datetime('now')`,
            { tokenHash: hashToken(token) }
        );
    }

    /**
     * Destroy one session (logout).
     * @param {string} token
     * @returns {boolean} whether a session was removed
     */
    async destroy(token) {
        if (!token || typeof token !== 'string') return false;
        const result = await db.run(
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
    async destroyAllForUser(userId) {
        const result = await db.run(
            'DELETE FROM web_sessions WHERE userId = @userId',
            { userId: String(userId) }
        );
        return result.changes;
    }

    /** Remove expired rows (called opportunistically on create). */
    async pruneExpired() {
        await db.run(`DELETE FROM web_sessions WHERE expiresAt <= datetime('now')`);
    }

    /**
     * Safe metadata for the Account & devices list (AC02). Never returns tokenHash.
     * @param {string} userId
     * @param {{ currentToken?: string|null }} [opts]
     */
    async listForUser(userId, { currentToken = null } = {}) {
        await this.pruneExpired();
        const rows = await db.all(
            `SELECT id, userName, avatar, createdAt, lastSeenAt, expiresAt, tokenHash
             FROM web_sessions
             WHERE userId = @userId AND expiresAt > datetime('now')
             ORDER BY lastSeenAt DESC, createdAt DESC`,
            { userId: String(userId) }
        );
        const currentHash = currentToken ? hashToken(currentToken) : null;
        return rows.map((row) => ({
            id: row.id,
            userName: row.userName || null,
            avatar: row.avatar || null,
            createdAt: row.createdAt,
            lastSeenAt: row.lastSeenAt,
            expiresAt: row.expiresAt,
            current: Boolean(currentHash && row.tokenHash === currentHash)
        }));
    }

    /**
     * Revoke one of the caller's sessions. Refusing to revoke the current
     * session here keeps "sign out other devices" distinct from logout.
     */
    async revokeForUser(userId, sessionId, { currentToken = null } = {}) {
        const id = Number(sessionId);
        if (!Number.isInteger(id) || id <= 0) {
            const error = new Error('Invalid session id.');
            error.status = 400;
            error.code = 'BAD_SESSION';
            throw error;
        }
        const row = await db.get(
            'SELECT id, tokenHash FROM web_sessions WHERE id = @id AND userId = @userId',
            { id, userId: String(userId) }
        );
        if (!row) {
            const error = new Error('That session is gone or is not yours.');
            error.status = 404;
            error.code = 'SESSION_NOT_FOUND';
            throw error;
        }
        if (currentToken && row.tokenHash === hashToken(currentToken)) {
            const error = new Error('Use Sign out to end the session on this device.');
            error.status = 400;
            error.code = 'CURRENT_SESSION';
            throw error;
        }
        const result = await db.run(
            'DELETE FROM web_sessions WHERE id = @id AND userId = @userId',
            { id, userId: String(userId) }
        );
        return { revoked: result.changes > 0, id };
    }

    async revokeOthers(userId, currentToken) {
        if (!currentToken) {
            const error = new Error('The current session is required to keep you signed in.');
            error.status = 400;
            error.code = 'BAD_SESSION';
            throw error;
        }
        const result = await db.run(
            `DELETE FROM web_sessions
             WHERE userId = @userId AND tokenHash != @tokenHash`,
            { userId: String(userId), tokenHash: hashToken(currentToken) }
        );
        return { revoked: result.changes };
    }
}

module.exports = new WebSessionService();
