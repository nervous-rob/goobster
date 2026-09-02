/**
 * Web portal presence: who is online in the Goobster web app right now.
 *
 * There is deliberately no new table. Presence is derived from
 * web_sessions.lastSeenAt, which every authenticated API call refreshes
 * (webSessionService.get) and the portal's own event stream keeps warm
 * while a tab is open (the /api/app/events heartbeat touches the session).
 * A user is "online" when any live session was seen inside the window;
 * closing the tab lets the session go stale and the user drops offline on
 * their own. Derived, re-derivable, and shared across processes in the
 * split deployment (the sessions table is the common ground) - no new
 * privacy surface (/forget-me already deletes web_sessions).
 */

const db = require('../db');

// The portal event stream pings every 15s and touches the session; three
// missed beats plus slack means "the tab is gone", not "the network burped".
const ONLINE_WINDOW_SECONDS = 90;

class PresenceService {
    /**
     * Which of these users are online in the web portal right now.
     * @param {Array<string>} userIds - Discord user snowflakes
     * @returns {Promise<Set<string>>} the subset currently online
     */
    async onlineIds(userIds) {
        const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
        if (ids.length === 0) return new Set();
        const placeholders = ids.map((_, i) => `@id${i}`).join(', ');
        const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
        const rows = await db.all(
            `SELECT DISTINCT userId FROM web_sessions
             WHERE userId IN (${placeholders})
               AND expiresAt > datetime('now')
               AND lastSeenAt > datetime('now', '-${ONLINE_WINDOW_SECONDS} seconds')`,
            params
        );
        return new Set(rows.map(row => String(row.userId)));
    }

    /**
     * Whether one user is online in the web portal right now.
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    async isOnline(userId) {
        return (await this.onlineIds([userId])).has(String(userId));
    }
}

module.exports = new PresenceService();
module.exports.ONLINE_WINDOW_SECONDS = ONLINE_WINDOW_SECONDS;
