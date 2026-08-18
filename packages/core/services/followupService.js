const db = require('../db');
const aiService = require('./aiService');

const MAX_PENDING_PER_GUILD = 25;
// Recurrence guardrails: match the portal cron floor (15 minutes between
// fires) and cap the interval at roughly a year.
const MIN_RECUR_MINUTES = 15;
const MAX_RECUR_MINUTES = 366 * 24 * 60;

/** 'YYYY-MM-DD HH:MM:SS' UTC text (the format the followups table uses). */
function toUtcText(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** Epoch ms for a 'YYYY-MM-DD HH:MM:SS' UTC text timestamp. */
function utcTextToMs(text) {
    return new Date(`${String(text).replace(' ', 'T')}Z`).getTime();
}

/** Human label for an interval, e.g. 60 -> "every hour", 2880 -> "every 2 days". */
function describeRecurrence(minutes) {
    const units = [
        { name: 'week', minutes: 7 * 24 * 60 },
        { name: 'day', minutes: 24 * 60 },
        { name: 'hour', minutes: 60 },
        { name: 'minute', minutes: 1 }
    ];
    const unit = units.find(u => minutes % u.minutes === 0);
    const count = minutes / unit.minutes;
    return count === 1 ? `every ${unit.name}` : `every ${count} ${unit.name}s`;
}

/**
 * Self-scheduled follow-ups: "ask Rob tomorrow how the deploy went".
 * Created by the model via the scheduleFollowUp tool (or by the heartbeat),
 * delivered by heartbeatService's minute loop when due.
 *
 * One-shot rows go PENDING -> DONE on delivery. Recurring rows (an hourly
 * Observatory check-in, a daily standup nudge) carry an interval
 * (recurMinutes + a human recurrence label) and stay PENDING: each
 * successful delivery atomically advances dueAt to the next occurrence in
 * the future - skipping occurrences missed while the bot was down, so a
 * restart never causes a burst of duplicate deliveries - until cancelled.
 */
class FollowupService {
    /**
     * Convert a natural-language time ("tomorrow afternoon", "in 2 hours")
     * to a UTC datetime string using a cheap deterministic model call.
     * @returns {Promise<string>} 'YYYY-MM-DD HH:MM:SS' (UTC)
     */
    async parseWhen(whenDescription) {
        const now = new Date();
        const prompt = `Current date and time (UTC): ${now.toISOString()}
Convert this scheduling request into a single UTC datetime: "${whenDescription}"

Rules:
- Respond with ONLY the datetime in the exact format: YYYY-MM-DD HH:MM:SS
- It must be in the future. If the request is vague ("tomorrow afternoon"), pick a sensible time (e.g. 15:00 local becomes the UTC equivalent; assume UTC-6 if no timezone is implied).
- If the request has no time information at all, respond with: INVALID`;

        const result = (await aiService.generateText(prompt, {
            temperature: 0.1,
            max_tokens: 30
        })).trim();

        const match = result.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
        if (!match) {
            throw new Error(`Couldn't understand when "${whenDescription}" is.`);
        }

        const dueAt = match[0];
        if (new Date(`${dueAt.replace(' ', 'T')}Z`) <= now) {
            throw new Error(`"${whenDescription}" appears to be in the past.`);
        }
        return dueAt;
    }

    /**
     * Parse a recurrence description deterministically (no model call):
     * "hourly", "daily", "weekly", "every hour", "every 2 hours",
     * "every 30 minutes", "each day"... Returns null for empty/one-time
     * values, throws on anything unintelligible or outside the guardrails.
     * @param {string|null} repeatDescription
     * @returns {{minutes: number, label: string}|null}
     */
    parseRecurrence(repeatDescription) {
        if (repeatDescription === null || repeatDescription === undefined) return null;
        const clean = String(repeatDescription).trim().toLowerCase();
        if (!clean || ['none', 'no', 'once', 'never'].includes(clean)) return null;

        const aliases = { hourly: 60, daily: 24 * 60, nightly: 24 * 60, weekly: 7 * 24 * 60 };
        let minutes = aliases[clean];
        if (minutes === undefined) {
            const match = clean.match(/^(?:every|each)?\s*(\d+)?\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)$/);
            if (!match) {
                throw new Error(`Couldn't understand the recurrence "${repeatDescription}". Try "every hour", "every 2 hours", or "daily".`);
            }
            const count = match[1] ? parseInt(match[1], 10) : 1;
            const unitMinutes = { m: 1, h: 60, d: 24 * 60, w: 7 * 24 * 60 }[match[2][0]];
            minutes = count * unitMinutes;
        }

        if (minutes < MIN_RECUR_MINUTES) {
            throw new Error(`Recurring follow-ups may repeat at most ${describeRecurrence(MIN_RECUR_MINUTES)} (asked for ${describeRecurrence(minutes)}).`);
        }
        if (minutes > MAX_RECUR_MINUTES) {
            throw new Error(`Recurring follow-ups may repeat at most a year apart (asked for ${describeRecurrence(minutes)}).`);
        }
        return { minutes, label: describeRecurrence(minutes) };
    }

    /**
     * Schedule a follow-up. `repeat` (natural-language recurrence, e.g.
     * "every hour") makes it recurring; without it the follow-up is
     * one-shot, exactly as before. For a recurring follow-up `whenDescription`
     * is optional - the first delivery defaults to one interval from now.
     * @param {Object} params - { guildId, channelId, userId, note, whenDescription, repeat }
     * @returns {Promise<{id: number, dueAt: string, recurrence: string|null}>}
     */
    async schedule({ guildId, channelId, userId = null, note, whenDescription = null, repeat = null }) {
        if (!guildId || !channelId || !note) {
            throw new Error('Follow-ups need a guild, channel, and note.');
        }

        const recurrence = this.parseRecurrence(repeat);
        if (!whenDescription && !recurrence) {
            throw new Error('Follow-ups need a time ("when") or a recurrence ("repeat").');
        }

        const pending = await db.get(
            `SELECT COUNT(*) AS count FROM followups WHERE guildId = @guildId AND status = 'PENDING'`,
            { guildId }
        );
        if ((pending?.count || 0) >= MAX_PENDING_PER_GUILD) {
            throw new Error('Too many pending follow-ups in this server already.');
        }

        const dueAt = whenDescription
            ? await this.parseWhen(whenDescription)
            : toUtcText(new Date(Date.now() + recurrence.minutes * 60_000));
        const newId = await db.insert(
            `INSERT INTO followups (guildId, channelId, userId, note, dueAt, recurMinutes, recurrence)
             VALUES (@guildId, @channelId, @userId, @note, @dueAt, @recurMinutes, @recurrence)`,
            {
                guildId, channelId, userId,
                note: String(note).slice(0, 500),
                dueAt,
                recurMinutes: recurrence?.minutes || null,
                recurrence: recurrence?.label || null
            }
        );

        return { id: newId, dueAt, recurrence: recurrence?.label || null };
    }

    /**
     * All follow-ups that are due now (UTC).
     */
    async getDue() {
        return await db.all(
            `SELECT * FROM followups
             WHERE status = 'PENDING' AND dueAt <= datetime('now')
             ORDER BY dueAt ASC LIMIT 20`
        );
    }

    /**
     * Pending follow-ups for a guild (for heartbeat context / status).
     */
    async getPending(guildId, limit = 10) {
        return await db.all(
            `SELECT id, note, dueAt, userId, recurrence FROM followups
             WHERE guildId = @guildId AND status = 'PENDING'
             ORDER BY dueAt ASC LIMIT @limit`,
            { guildId, limit }
        );
    }

    /**
     * The next occurrence of a recurring follow-up strictly in the future:
     * dueAt + k*interval with the smallest k >= 1 that lands past `nowMs`.
     * Occurrences missed while the bot was down are skipped, so downtime
     * yields one catch-up delivery, never a burst.
     * @param {string} dueAt - 'YYYY-MM-DD HH:MM:SS' UTC
     * @param {number} recurMinutes
     * @param {number} [nowMs]
     * @returns {string} 'YYYY-MM-DD HH:MM:SS' UTC
     */
    nextOccurrence(dueAt, recurMinutes, nowMs = Date.now()) {
        const base = utcTextToMs(dueAt);
        const step = recurMinutes * 60_000;
        const missed = Math.max(0, Math.floor((nowMs - base) / step));
        return toUtcText(new Date(base + (missed + 1) * step));
    }

    /**
     * Record a successful delivery. One-shot follow-ups are marked DONE;
     * recurring ones are rescheduled to their next future occurrence and
     * stay PENDING. Both updates are guarded (status, and for recurring
     * rows the exact dueAt being delivered) so a duplicate call - an
     * overlapping delivery pass, a stale row - is a no-op instead of a
     * double delivery or a skipped occurrence.
     * @param {Object} followup - a row from getDue()
     * @returns {{recurring: boolean, advanced: boolean, nextDueAt: string|null}}
     */
    async recordDelivery(followup) {
        const now = new Date();
        if (followup.recurMinutes) {
            const nextDueAt = this.nextOccurrence(followup.dueAt, followup.recurMinutes, now.getTime());
            const changes = (await db.run(
                `UPDATE followups
                 SET dueAt = @nextDueAt, deliveryCount = deliveryCount + 1, lastDeliveredAt = @now
                 WHERE id = @id AND status = 'PENDING' AND dueAt = @dueAt`,
                { id: followup.id, nextDueAt, now, dueAt: followup.dueAt }
            )).changes;
            return { recurring: true, advanced: changes > 0, nextDueAt: changes > 0 ? nextDueAt : null };
        }

        const changes = (await db.run(
            `UPDATE followups
             SET status = 'DONE', deliveryCount = deliveryCount + 1, lastDeliveredAt = @now
             WHERE id = @id AND status = 'PENDING'`,
            { id: followup.id, now }
        )).changes;
        return { recurring: false, advanced: changes > 0, nextDueAt: null };
    }

    async markDone(id) {
        return (await db.run(`UPDATE followups SET status = 'DONE' WHERE id = @id`, { id })).changes;
    }

    async cancel(id) {
        return (await db.run(`UPDATE followups SET status = 'CANCELLED' WHERE id = @id AND status = 'PENDING'`, { id })).changes;
    }
}

module.exports = new FollowupService();
module.exports.MIN_RECUR_MINUTES = MIN_RECUR_MINUTES;
module.exports.MAX_RECUR_MINUTES = MAX_RECUR_MINUTES;
