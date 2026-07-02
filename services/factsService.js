const db = require('../db');

// Caps keep prompts small and prevent unbounded growth
const MAX_FACTS_PER_USER = 50;
const MAX_FACTS_PER_GUILD_SUBJECT = 100;
const DOSSIER_LIMIT = 12;

/**
 * Distilled facts: curated knowledge about users and servers, separate from
 * raw message embeddings. Facts are short declarative statements ("Rob is
 * building a Raspberry Pi cluster") created by the model via tools, by the
 * nightly memory consolidation job, or by users.
 */
class FactsService {
    /**
     * Add a fact. Deduplicates on exact content per subject.
     * @param {Object} fact - { guildId, subjectType: 'USER'|'GUILD', subjectId, content, source }
     * @returns {number|null} fact id, or null when skipped
     */
    addFact({ guildId, subjectType, subjectId = null, content, source = 'model' }) {
        const trimmed = String(content || '').trim();
        if (!guildId || !trimmed || trimmed.length > 500) return null;

        const existing = db.get(
            `SELECT id FROM facts
             WHERE guildId = @guildId AND subjectType = @subjectType
               AND (subjectId = @subjectId OR (subjectId IS NULL AND @subjectId IS NULL))
               AND content = @content`,
            { guildId, subjectType, subjectId, content: trimmed }
        );
        if (existing) {
            db.run(`UPDATE facts SET updatedAt = CURRENT_TIMESTAMP WHERE id = @id`, { id: existing.id });
            return existing.id;
        }

        const result = db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content, source)
             VALUES (@guildId, @subjectType, @subjectId, @content, @source)`,
            { guildId, subjectType, subjectId, content: trimmed, source }
        );

        this._prune(guildId, subjectType, subjectId);
        return Number(result.lastInsertRowid);
    }

    _prune(guildId, subjectType, subjectId) {
        const max = subjectType === 'USER' ? MAX_FACTS_PER_USER : MAX_FACTS_PER_GUILD_SUBJECT;
        db.run(
            `DELETE FROM facts
             WHERE guildId = @guildId AND subjectType = @subjectType
               AND (subjectId = @subjectId OR (subjectId IS NULL AND @subjectId IS NULL))
               AND id NOT IN (
                   SELECT id FROM facts
                   WHERE guildId = @guildId AND subjectType = @subjectType
                     AND (subjectId = @subjectId OR (subjectId IS NULL AND @subjectId IS NULL))
                   ORDER BY updatedAt DESC, id DESC LIMIT @max
               )`,
            { guildId, subjectType, subjectId, max }
        );
    }

    /**
     * Remove facts matching a description (case-insensitive substring).
     * @returns {number} rows removed
     */
    removeFacts({ guildId, subjectType = null, subjectId = null, match }) {
        const pattern = `%${String(match || '').trim()}%`;
        if (!guildId || pattern === '%%') return 0;

        let sql = `DELETE FROM facts WHERE guildId = @guildId AND content LIKE @pattern`;
        const params = { guildId, pattern };
        if (subjectType) {
            sql += ` AND subjectType = @subjectType`;
            params.subjectType = subjectType;
        }
        if (subjectId) {
            sql += ` AND subjectId = @subjectId`;
            params.subjectId = subjectId;
        }
        return db.run(sql, params).changes;
    }

    /**
     * Facts about a specific user in a guild (newest-touched first).
     */
    getUserFacts(guildId, userId, limit = DOSSIER_LIMIT) {
        return db.all(
            `SELECT content, updatedAt FROM facts
             WHERE guildId = @guildId AND subjectType = 'USER' AND subjectId = @userId
             ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
            { guildId, userId, limit }
        );
    }

    /**
     * Server-wide facts (newest-touched first).
     */
    getGuildFacts(guildId, limit = DOSSIER_LIMIT) {
        return db.all(
            `SELECT content, updatedAt FROM facts
             WHERE guildId = @guildId AND subjectType = 'GUILD'
             ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
            { guildId, limit }
        );
    }

    /**
     * Format a dossier block for the system prompt. Returns null when empty.
     * @param {Object} params - { guildId, userId, userName }
     */
    buildDossier({ guildId, userId, userName }) {
        const userFacts = userId ? this.getUserFacts(guildId, userId) : [];
        const guildFacts = this.getGuildFacts(guildId);
        if (userFacts.length === 0 && guildFacts.length === 0) return null;

        const sections = [];
        if (userFacts.length > 0) {
            sections.push(`About ${userName || 'this user'}:\n${userFacts.map(f => `- ${f.content}`).join('\n')}`);
        }
        if (guildFacts.length > 0) {
            sections.push(`About this server:\n${guildFacts.map(f => `- ${f.content}`).join('\n')}`);
        }

        return `KNOWN FACTS (from your long-term memory - use naturally, don't recite):
${sections.join('\n\n')}`;
    }

    getStats(guildId) {
        const row = db.get(
            `SELECT
                SUM(CASE WHEN subjectType = 'USER' THEN 1 ELSE 0 END) AS userFacts,
                SUM(CASE WHEN subjectType = 'GUILD' THEN 1 ELSE 0 END) AS guildFacts
             FROM facts WHERE guildId = @guildId`,
            { guildId }
        );
        return { userFacts: row?.userFacts || 0, guildFacts: row?.guildFacts || 0 };
    }

    forgetGuild(guildId) {
        return db.run('DELETE FROM facts WHERE guildId = @guildId', { guildId }).changes;
    }
}

module.exports = new FactsService();
