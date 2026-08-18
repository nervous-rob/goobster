const db = require('../../db');
const exchangeConfig = require('./exchangeConfig');
const exchangeEvents = require('./exchangeEvents');
const { ExchangeError } = require('./errors');

const MAX_PARTICIPANTS = 100;

/**
 * Group-play opt-ins: who participates when a server-wide exchange event
 * (the Daily Ballistic Goblin Wheel, or whatever ritual comes next) deploys
 * wallets.
 *
 * The consent model, in order of precedence:
 *   1. An explicit per-user record always wins - opting out is respected even
 *      while the override is on.
 *   2. With no record, the guild's `optInOverride` setting decides. It is ON
 *      by default: everyone with a wallet is in until they say otherwise.
 *   3. With the override off, only explicit opt-ins participate.
 *
 * Every opt-in state change lands in the exchange event log, so "who agreed
 * to this and when" is always answerable.
 */
class GroupPlayService {
    /** The explicit record for one member, or null when they never chose. */
    getOptIn(guildId, userId) {
        return db.get(
            'SELECT userId, optedIn, maxAllocationPercent, updatedAt FROM exchange_optins WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        ) || null;
    }

    /**
     * A member's effective participation and where it comes from.
     * @returns {{optedIn: boolean, source: 'explicit'|'override'|'default', maxAllocationPercent: number|null}}
     */
    effectiveOptIn(guildId, userId) {
        const record = this.getOptIn(guildId, userId);
        if (record) {
            return {
                optedIn: !!record.optedIn,
                source: 'explicit',
                maxAllocationPercent: record.maxAllocationPercent ?? null
            };
        }
        const { optInOverride } = exchangeConfig.get(guildId);
        return { optedIn: optInOverride, source: optInOverride ? 'override' : 'default', maxAllocationPercent: null };
    }

    /**
     * Record a member's own choice. `maxAllocationPercent` caps how much of
     * their wallet any single group event may deploy.
     */
    setOptIn({ guildId, userId, optedIn, maxAllocationPercent = null }) {
        let cap = null;
        if (maxAllocationPercent !== null && maxAllocationPercent !== undefined) {
            cap = Number(maxAllocationPercent);
            if (!Number.isFinite(cap) || cap <= 0 || cap > 100) {
                throw new ExchangeError('BAD_CAP', 'The allocation cap must be a percentage between 0 and 100.');
            }
        }
        db.run(
            `INSERT INTO exchange_optins (guildId, userId, optedIn, maxAllocationPercent)
             VALUES (@guildId, @userId, @optedIn, @cap)
             ON CONFLICT(guildId, userId) DO UPDATE SET
                 optedIn = excluded.optedIn,
                 maxAllocationPercent = COALESCE(excluded.maxAllocationPercent, maxAllocationPercent),
                 updatedAt = CURRENT_TIMESTAMP`,
            { guildId, userId, optedIn: optedIn ? 1 : 0, cap }
        );
        exchangeEvents.record({
            guildId, userId,
            eventType: optedIn ? 'group-opt-in' : 'group-opt-out',
            detail: { maxAllocationPercent: cap }
        });
        return this.effectiveOptIn(guildId, userId);
    }

    /**
     * Flip the guild-wide override ("everyone is in unless they said no").
     * Explicit opt-outs keep winning either way - the override sets the
     * default, it never erases a member's recorded choice.
     */
    setOverride({ guildId, enabled, byUserId = null }) {
        exchangeConfig.set(guildId, { optInOverride: !!enabled });
        exchangeEvents.record({
            guildId, userId: byUserId,
            eventType: enabled ? 'opt-in-override-on' : 'opt-in-override-off'
        });
        return exchangeConfig.get(guildId).optInOverride;
    }

    /**
     * Everyone a group event would deploy for, with their allocation caps.
     *
     * "Everyone in the guild" means everyone the economy knows: wallet
     * holders, plus explicit opt-ins who have no wallet yet (their wallet is
     * created with the starting balance at deploy time). Explicit opt-outs
     * are excluded no matter what the override says.
     * @returns {Array<{userId, source, maxAllocationPercent}>}
     */
    listParticipants({ guildId, limit = MAX_PARTICIPANTS, excludeUserIds = [] }) {
        const { optInOverride } = exchangeConfig.get(guildId);
        const explicit = db.all(
            'SELECT userId, optedIn, maxAllocationPercent FROM exchange_optins WHERE guildId = @guildId',
            { guildId }
        );
        const byUser = new Map(explicit.map(row => [row.userId, row]));
        const excluded = new Set(excludeUserIds);
        const participants = new Map();

        for (const row of explicit) {
            if (row.optedIn && !excluded.has(row.userId)) {
                participants.set(row.userId, {
                    userId: row.userId,
                    source: 'explicit',
                    maxAllocationPercent: row.maxAllocationPercent ?? null
                });
            }
        }

        if (optInOverride) {
            const wallets = db.all(
                'SELECT userId FROM economy_wallets WHERE guildId = @guildId ORDER BY balance DESC LIMIT @limit',
                { guildId, limit }
            );
            for (const { userId } of wallets) {
                if (excluded.has(userId) || participants.has(userId)) continue;
                const record = byUser.get(userId);
                if (record && !record.optedIn) continue; // an explicit "no" wins
                participants.set(userId, { userId, source: 'override', maxAllocationPercent: null });
            }
        }

        return [...participants.values()].slice(0, limit);
    }

    /** Counts for the status view. */
    summarize(guildId) {
        const { optInOverride } = exchangeConfig.get(guildId);
        const counts = db.get(
            `SELECT SUM(CASE WHEN optedIn = 1 THEN 1 ELSE 0 END) AS optIns,
                    SUM(CASE WHEN optedIn = 0 THEN 1 ELSE 0 END) AS optOuts
             FROM exchange_optins WHERE guildId = @guildId`,
            { guildId }
        );
        return {
            optInOverride,
            explicitOptIns: counts?.optIns || 0,
            explicitOptOuts: counts?.optOuts || 0,
            participants: this.listParticipants({ guildId }).length
        };
    }
}

module.exports = new GroupPlayService();
module.exports.MAX_PARTICIPANTS = MAX_PARTICIPANTS;
