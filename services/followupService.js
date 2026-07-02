const db = require('../db');
const aiService = require('./aiService');

const MAX_PENDING_PER_GUILD = 25;

/**
 * One-shot self-scheduled follow-ups: "ask Rob tomorrow how the deploy went".
 * Created by the model via the scheduleFollowUp tool (or by the heartbeat),
 * delivered by heartbeatService's minute loop when due.
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
     * Schedule a follow-up.
     * @param {Object} params - { guildId, channelId, userId, note, whenDescription }
     * @returns {Promise<{id: number, dueAt: string}>}
     */
    async schedule({ guildId, channelId, userId = null, note, whenDescription }) {
        if (!guildId || !channelId || !note) {
            throw new Error('Follow-ups need a guild, channel, and note.');
        }

        const pending = db.get(
            `SELECT COUNT(*) AS count FROM followups WHERE guildId = @guildId AND status = 'PENDING'`,
            { guildId }
        );
        if ((pending?.count || 0) >= MAX_PENDING_PER_GUILD) {
            throw new Error('Too many pending follow-ups in this server already.');
        }

        const dueAt = await this.parseWhen(whenDescription);
        const result = db.run(
            `INSERT INTO followups (guildId, channelId, userId, note, dueAt)
             VALUES (@guildId, @channelId, @userId, @note, @dueAt)`,
            { guildId, channelId, userId, note: String(note).slice(0, 500), dueAt }
        );

        return { id: Number(result.lastInsertRowid), dueAt };
    }

    /**
     * All follow-ups that are due now (UTC).
     */
    getDue() {
        return db.all(
            `SELECT * FROM followups
             WHERE status = 'PENDING' AND dueAt <= datetime('now')
             ORDER BY dueAt ASC LIMIT 20`
        );
    }

    /**
     * Pending follow-ups for a guild (for heartbeat context / status).
     */
    getPending(guildId, limit = 10) {
        return db.all(
            `SELECT id, note, dueAt, userId FROM followups
             WHERE guildId = @guildId AND status = 'PENDING'
             ORDER BY dueAt ASC LIMIT @limit`,
            { guildId, limit }
        );
    }

    markDone(id) {
        return db.run(`UPDATE followups SET status = 'DONE' WHERE id = @id`, { id }).changes;
    }

    cancel(id) {
        return db.run(`UPDATE followups SET status = 'CANCELLED' WHERE id = @id AND status = 'PENDING'`, { id }).changes;
    }
}

module.exports = new FollowupService();
