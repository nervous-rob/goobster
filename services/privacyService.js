const db = require('../db');

/**
 * Privacy controls as product features: the data transparency report behind
 * /what-do-you-know-about-me and the full per-user erasure behind /forget-me.
 *
 * Erasure scope (see documentation/differentiation_strategy.md):
 * - DELETE: memory_embeddings (by authorId), facts (USER-subject), followups
 *   created by or about the user, conversation history (messages,
 *   conversations, prompts), user_nicknames, UserPreferences, users row.
 * - ANONYMIZE: usage_log / command_log rows (userId nulled, counts kept).
 * - REVIEW: GUILD-subject facts and conversation_summaries that mention the
 *   user by name without carrying their ID are scanned and deleted too.
 *
 * The bot's users/conversations tables are global (not per-guild), so
 * /forget-me erases the user across the whole bot instance - the honest
 * interpretation of "forget me" for a self-hosted bot.
 */
class PrivacyService {
    /**
     * Names the user is known by: username, display names, stored nicknames,
     * and the author names attached to their memories. Used for the
     * name-mention review scan.
     * @param {Object} params - { userId, extraNames: string[] }
     * @returns {string[]} unique, trimmed names (length >= 2)
     */
    collectKnownNames({ userId, extraNames = [] }) {
        const names = new Set();

        for (const name of extraNames) {
            if (name) names.add(String(name).trim());
        }

        const nicknameRows = db.all(
            'SELECT nickname FROM user_nicknames WHERE userId = @userId',
            { userId }
        );
        for (const row of nicknameRows) names.add(String(row.nickname).trim());

        const authorRows = db.all(
            `SELECT DISTINCT authorName FROM memory_embeddings
             WHERE authorId = @userId AND authorName IS NOT NULL`,
            { userId }
        );
        for (const row of authorRows) names.add(String(row.authorName).trim());

        const userRow = db.get(
            'SELECT discordUsername, username FROM users WHERE discordId = @userId',
            { userId }
        );
        if (userRow?.discordUsername) names.add(String(userRow.discordUsername).trim());
        if (userRow?.username) names.add(String(userRow.username).trim());

        return [...names].filter(n => n.length >= 2);
    }

    /**
     * Build a case-insensitive regex matching any known name on word
     * boundaries (so "Rob" doesn't match "problem").
     * @returns {RegExp|null} null when there are no usable names
     */
    _buildNameMatcher(names) {
        if (!names || names.length === 0) return null;
        const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        return new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped.join('|')})($|[^\\p{L}\\p{N}])`, 'iu');
    }

    /**
     * Everything Goobster knows about a user, for the transparency report.
     * Guild-scoped tables report the current guild; global tables report
     * bot-wide totals.
     * @param {Object} params - { guildId, userId }
     */
    buildUserReport({ guildId, userId }) {
        const facts = db.all(
            `SELECT content, source, updatedAt FROM facts
             WHERE guildId = @guildId AND subjectType = 'USER' AND subjectId = @userId
             ORDER BY updatedAt DESC, id DESC`,
            { guildId, userId }
        );

        const memories = db.get(
            `SELECT COUNT(*) AS count, MIN(createdAt) AS oldest, MAX(createdAt) AS newest
             FROM memory_embeddings WHERE guildId = @guildId AND authorId = @userId`,
            { guildId, userId }
        );

        const followups = db.all(
            `SELECT note, dueAt FROM followups
             WHERE guildId = @guildId AND userId = @userId AND status = 'PENDING'
             ORDER BY dueAt ASC`,
            { guildId, userId }
        );

        const nickname = db.get(
            'SELECT nickname FROM user_nicknames WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );

        const preferences = db.get(
            'SELECT memeMode, personality_preset FROM UserPreferences WHERE userId = @userId',
            { userId }
        );

        const userRow = db.get('SELECT id, joinedAt FROM users WHERE discordId = @userId', { userId });
        const conversations = userRow
            ? db.get(
                `SELECT COUNT(DISTINCT c.id) AS conversationCount, COUNT(m.id) AS messageCount
                 FROM conversations c
                 LEFT JOIN messages m ON m.conversationId = c.id
                 WHERE c.userId = @internalId`,
                { internalId: userRow.id }
            )
            : { conversationCount: 0, messageCount: 0 };

        const usage = db.get(
            `SELECT COUNT(*) AS count FROM usage_log
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );

        return {
            facts,
            memories: {
                count: memories?.count || 0,
                oldest: memories?.oldest || null,
                newest: memories?.newest || null
            },
            followups,
            nickname: nickname?.nickname || null,
            preferences: preferences || null,
            profile: userRow ? { joinedAt: userRow.joinedAt } : null,
            conversations: {
                count: conversations?.conversationCount || 0,
                messages: conversations?.messageCount || 0
            },
            usageRows: usage?.count || 0
        };
    }

    /**
     * Full per-user erasure across the bot instance. Synchronous by design so
     * the whole thing commits (or rolls back) as one transaction.
     * @param {Object} params - { userId, extraNames: string[] }
     * @returns {Object} per-table deletion/anonymization counts
     */
    forgetUser({ userId, extraNames = [] }) {
        // Collect names BEFORE deleting the rows they come from
        const knownNames = this.collectKnownNames({ userId, extraNames });
        const nameMatcher = this._buildNameMatcher(knownNames);

        const counts = db.transaction(() => {
            const counts = { knownNames };

            counts.memories = db.run(
                'DELETE FROM memory_embeddings WHERE authorId = @userId', { userId }
            ).changes;

            counts.userFacts = db.run(
                `DELETE FROM facts WHERE subjectType = 'USER' AND subjectId = @userId`,
                { userId }
            ).changes;

            // Follow-ups created by/about the user (any status - erasure is erasure)
            counts.followups = db.run(
                'DELETE FROM followups WHERE userId = @userId', { userId }
            ).changes;

            // Review pass 1: GUILD-subject facts that mention the user by name
            counts.reviewedGuildFacts = 0;
            if (nameMatcher) {
                const guildFacts = db.all(
                    `SELECT id, content FROM facts WHERE subjectType = 'GUILD'`
                );
                for (const fact of guildFacts) {
                    if (nameMatcher.test(fact.content)) {
                        db.run('DELETE FROM facts WHERE id = @id', { id: fact.id });
                        counts.reviewedGuildFacts++;
                    }
                }

                // Review pass 2: conversation summaries mentioning the user
                counts.reviewedSummaries = 0;
                const summaries = db.all('SELECT id, summary FROM conversation_summaries');
                for (const row of summaries) {
                    if (nameMatcher.test(row.summary)) {
                        db.run('DELETE FROM conversation_summaries WHERE id = @id', { id: row.id });
                        counts.reviewedSummaries++;
                    }
                }

                // Review pass 3: follow-up notes mentioning the user by name
                const notes = db.all('SELECT id, note FROM followups');
                for (const row of notes) {
                    if (nameMatcher.test(row.note)) {
                        db.run('DELETE FROM followups WHERE id = @id', { id: row.id });
                        counts.followups++;
                    }
                }
            } else {
                counts.reviewedSummaries = 0;
            }

            // Conversation history: the user's conversations (including bot
            // replies inside them), any stray messages they authored, their
            // prompts, then the users row itself.
            counts.messages = 0;
            counts.conversations = 0;
            counts.prompts = 0;
            const userRow = db.get('SELECT id FROM users WHERE discordId = @userId', { userId });
            if (userRow) {
                const internalId = userRow.id;
                db.run('UPDATE users SET activeConversationId = NULL WHERE id = @internalId', { internalId });
                counts.messages += db.run(
                    `DELETE FROM messages WHERE conversationId IN
                        (SELECT id FROM conversations WHERE userId = @internalId)`,
                    { internalId }
                ).changes;
                counts.messages += db.run(
                    'DELETE FROM messages WHERE createdBy = @internalId', { internalId }
                ).changes;
                counts.conversations = db.run(
                    'DELETE FROM conversations WHERE userId = @internalId', { internalId }
                ).changes;
                counts.prompts = db.run(
                    'DELETE FROM prompts WHERE userId = @internalId', { internalId }
                ).changes;
                db.run('DELETE FROM users WHERE id = @internalId', { internalId });
                counts.profile = 1;
            } else {
                counts.profile = 0;
            }

            counts.nicknames = db.run(
                'DELETE FROM user_nicknames WHERE userId = @userId', { userId }
            ).changes;

            counts.preferences = db.run(
                'DELETE FROM UserPreferences WHERE userId = @userId', { userId }
            ).changes;

            // Anonymize, don't delete: cost accounting keeps its token counts
            counts.anonymizedUsageRows = db.run(
                'UPDATE usage_log SET userId = NULL WHERE userId = @userId', { userId }
            ).changes;
            counts.anonymizedUsageRows += db.run(
                'UPDATE command_log SET userId = NULL WHERE userId = @userId', { userId }
            ).changes;

            return counts;
        });

        // Derived vectors must not outlive the memories they were computed
        // from: drop vec-index entries orphaned by the deletion above.
        require('./memoryService').cleanupVecIndex();

        return counts;
    }

    /**
     * Post-erasure audit: count rows still attributed to the user. Used by
     * tests and surfaced after /forget-me so "zero gaps" is provable.
     * @returns {{total: number, byTable: Object}}
     */
    auditUser({ userId }) {
        const byTable = {
            memory_embeddings: db.get(
                'SELECT COUNT(*) AS c FROM memory_embeddings WHERE authorId = @userId', { userId }
            ).c,
            facts: db.get(
                `SELECT COUNT(*) AS c FROM facts WHERE subjectType = 'USER' AND subjectId = @userId`,
                { userId }
            ).c,
            followups: db.get(
                'SELECT COUNT(*) AS c FROM followups WHERE userId = @userId', { userId }
            ).c,
            users: db.get(
                'SELECT COUNT(*) AS c FROM users WHERE discordId = @userId', { userId }
            ).c,
            user_nicknames: db.get(
                'SELECT COUNT(*) AS c FROM user_nicknames WHERE userId = @userId', { userId }
            ).c,
            UserPreferences: db.get(
                'SELECT COUNT(*) AS c FROM UserPreferences WHERE userId = @userId', { userId }
            ).c,
            usage_log: db.get(
                'SELECT COUNT(*) AS c FROM usage_log WHERE userId = @userId', { userId }
            ).c,
            command_log: db.get(
                'SELECT COUNT(*) AS c FROM command_log WHERE userId = @userId', { userId }
            ).c
        };

        const total = Object.values(byTable).reduce((sum, c) => sum + c, 0);
        return { total, byTable };
    }
}

module.exports = new PrivacyService();
