const db = require('../db');

/**
 * Privacy controls as product features: the data transparency report behind
 * /what-do-you-know-about-me and the full per-user erasure behind /forget-me.
 *
 * Erasure scope (see documentation/differentiation_strategy.md):
 * - DELETE: memory_embeddings (by authorId), facts (USER-subject), followups
 *   created by or about the user, conversation history (messages,
 *   conversations, prompts), user_nicknames, UserPreferences, users row, and
 *   all economy data (wallet, ledger, stock holdings, stock trades).
 * - ANONYMIZE: usage_log / command_log / guild_activity rows (userId nulled,
 *   counts kept).
 * - REVIEW: GUILD-subject facts, conversation_summaries, follow-up notes,
 *   internal-monologue thoughts/scratchpad notes, and knowledge-graph nodes
 *   that mention the user by name without carrying their ID are scanned and
 *   deleted too.
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

        const activity = db.get(
            `SELECT COALESCE(SUM(messageCount), 0) AS messages FROM guild_activity
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );

        const wallet = db.get(
            'SELECT balance FROM economy_wallets WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        const economyTx = db.get(
            'SELECT COUNT(*) AS c FROM economy_transactions WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        const stockHoldings = db.get(
            'SELECT COUNT(*) AS c FROM stock_holdings WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        const stockTrades = db.get(
            'SELECT COUNT(*) AS c FROM stock_trades WHERE guildId = @guildId AND userId = @userId',
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
            usageRows: usage?.count || 0,
            activityMessages: activity?.messages || 0,
            economy: {
                balance: wallet ? wallet.balance : null,
                transactions: economyTx?.c || 0,
                stockHoldings: stockHoldings?.c || 0,
                stockTrades: stockTrades?.c || 0
            }
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

                // Review pass 4: internal-monologue thoughts and scratchpad
                // notes mentioning the user
                counts.reviewedThoughts = 0;
                const thoughts = db.all('SELECT id, thought FROM monologue_thoughts');
                for (const row of thoughts) {
                    if (nameMatcher.test(row.thought)) {
                        db.run('DELETE FROM monologue_thoughts WHERE id = @id', { id: row.id });
                        counts.reviewedThoughts++;
                    }
                }
                const padNotes = db.all('SELECT id, content FROM monologue_scratchpad');
                for (const row of padNotes) {
                    if (nameMatcher.test(row.content)) {
                        db.run('DELETE FROM monologue_scratchpad WHERE id = @id', { id: row.id });
                        counts.reviewedThoughts++;
                    }
                }

                // Review pass 5: knowledge-graph nodes whose label or content
                // mentions the user (incident edges cascade)
                counts.reviewedGraphNodes = 0;
                const graphNodes = db.all('SELECT id, label, content FROM kg_nodes');
                for (const node of graphNodes) {
                    if (nameMatcher.test(node.label) || (node.content && nameMatcher.test(node.content))) {
                        db.run('DELETE FROM kg_nodes WHERE id = @id', { id: node.id });
                        counts.reviewedGraphNodes++;
                    }
                }
            } else {
                counts.reviewedSummaries = 0;
                counts.reviewedThoughts = 0;
                counts.reviewedGraphNodes = 0;
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

            // Economy: wallet, ledger, stock positions, and trade history are
            // all personal financial data - deleted outright (guild totals do
            // not depend on them, unlike usage/activity counters).
            counts.economy = db.run(
                'DELETE FROM economy_wallets WHERE userId = @userId', { userId }
            ).changes;
            counts.economy += db.run(
                'DELETE FROM economy_transactions WHERE userId = @userId', { userId }
            ).changes;
            counts.economy += db.run(
                'DELETE FROM stock_holdings WHERE userId = @userId', { userId }
            ).changes;
            counts.economy += db.run(
                'DELETE FROM stock_trades WHERE userId = @userId', { userId }
            ).changes;

            // Anonymize, don't delete: cost accounting keeps its token counts
            counts.anonymizedUsageRows = db.run(
                'UPDATE usage_log SET userId = NULL WHERE userId = @userId', { userId }
            ).changes;
            counts.anonymizedUsageRows += db.run(
                'UPDATE command_log SET userId = NULL WHERE userId = @userId', { userId }
            ).changes;

            // Activity counters likewise: userId nulled, counts kept so
            // server-wide /wrapped totals stay accurate. NULLs are distinct
            // in SQLite unique indexes, so this cannot hit a PK conflict.
            counts.anonymizedActivityRows = db.run(
                'UPDATE guild_activity SET userId = NULL WHERE userId = @userId', { userId }
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
            ).c,
            guild_activity: db.get(
                'SELECT COUNT(*) AS c FROM guild_activity WHERE userId = @userId', { userId }
            ).c,
            economy_wallets: db.get(
                'SELECT COUNT(*) AS c FROM economy_wallets WHERE userId = @userId', { userId }
            ).c,
            economy_transactions: db.get(
                'SELECT COUNT(*) AS c FROM economy_transactions WHERE userId = @userId', { userId }
            ).c,
            stock_holdings: db.get(
                'SELECT COUNT(*) AS c FROM stock_holdings WHERE userId = @userId', { userId }
            ).c,
            stock_trades: db.get(
                'SELECT COUNT(*) AS c FROM stock_trades WHERE userId = @userId', { userId }
            ).c
        };

        const total = Object.values(byTable).reduce((sum, c) => sum + c, 0);
        return { total, byTable };
    }
}

module.exports = new PrivacyService();
