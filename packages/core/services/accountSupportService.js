/**
 * The per-account support view (roadmap #256): what one person's work
 * cost and what went wrong with it, over a window. The operator reads it
 * from the Host room for any account; the person reads the same shape
 * for themselves in the Usage room. It is a read model over usage_log
 * (tokens), resource_events (everything else) and work_failures - no
 * prompt, reply or body text is ever part of it.
 */

const db = require('../db');
const workFailureService = require('./workFailureService');
const resourceEventService = require('./resourceEventService');

const MAX_DAYS = 365;

function boundDays(days) {
    const n = Math.trunc(Number(days));
    if (!Number.isFinite(n) || n < 1) return 30;
    return Math.min(MAX_DAYS, n);
}

function sinceText(days, now = new Date()) {
    return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
}

class AccountSupportService {
    /**
     * @param {{ principalId: string, days?: number, recentLimit?: number }} params
     * @returns {Promise<{ principalId: string, days: number, usage: { calls: number, inputTokens: number, outputTokens: number, totalTokens: number }, resources: Array, failures: { total: number, byKind: Array, byCode: Array, recent: Array } }>}
     */
    async view({ principalId, days = 30, recentLimit = 25 }) {
        const userId = String(principalId);
        const window = boundDays(days);
        const usage = await db.get(
            `SELECT COUNT(*) AS calls,
                    COALESCE(SUM(inputTokens), 0) AS inputTokens,
                    COALESCE(SUM(outputTokens), 0) AS outputTokens
             FROM usage_log WHERE userId = @userId AND createdAt >= @since`,
            { userId, since: sinceText(window) }
        );
        const summary = await workFailureService.summarize({ userId, days: window });
        const recent = await workFailureService.listForUser(userId, { limit: recentLimit, days: window });
        const inputTokens = Number(usage?.inputTokens || 0);
        const outputTokens = Number(usage?.outputTokens || 0);
        return {
            principalId: userId,
            days: window,
            usage: { calls: Number(usage?.calls || 0), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
            resources: await resourceEventService.totals({ userId, days: window }),
            failures: { ...summary, recent }
        };
    }

    /**
     * Roster decoration: failure counts per account in the window.
     * @returns {Promise<Map<string, number>>}
     */
    async failureCounts({ days = 30 } = {}) {
        return workFailureService.countByActor({ days: boundDays(days) });
    }
}

module.exports = new AccountSupportService();
module.exports.AccountSupportService = AccountSupportService;
