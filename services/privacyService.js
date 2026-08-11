const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');

/**
 * Privacy controls as product features: the data transparency report behind
 * /what-do-you-know-about-me and the full per-user erasure behind /forget-me.
 *
 * Erasure scope (see documentation/differentiation_strategy.md):
 * - DELETE: memory_embeddings (by authorId, plus everything in the user's
 *   DM scope), facts (USER-subject, plus the whole DM scope), followups
 *   created by or about the user, conversation history (messages,
 *   conversations, prompts, DM conversation containers and summaries),
 *   user_nicknames, UserPreferences, users row, all economy data
 *   (wallet, ledger, stock holdings, stock trades), tavern characters
 *   (sheet + party memberships), and the user's whole Parlor (personas
 *   with their note/tag workspaces, and parlor discussions - cascades).
 * - ANONYMIZE: usage_log / command_log / guild_activity rows (userId nulled,
 *   counts kept), tavern adventure createdBy, and tavern log attribution.
 * - REVIEW: GUILD-subject facts, conversation_summaries, follow-up notes,
 *   internal-monologue thoughts/scratchpad notes, knowledge-graph nodes,
 *   and tavern adventure-log prose that mention the user by name without
 *   carrying their ID are scanned and deleted too.
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

        // Tavern character names appear throughout adventure-log prose
        const characterRows = db.all(
            'SELECT name FROM tavern_characters WHERE userId = @userId',
            { userId }
        );
        for (const row of characterRows) names.add(String(row.name).trim());

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

        // Exchange: the margin account, its liabilities, and every derivative
        // position are personal financial data, same as the wallet.
        const exchangeAccount = db.get(
            `SELECT accountType, leverage, goblinMode, marginLoan, liquidations
             FROM exchange_accounts WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );
        const exchangeCounts = db.get(
            `SELECT
                 (SELECT COUNT(*) FROM short_positions WHERE guildId = @guildId AND userId = @userId) AS shorts,
                 (SELECT COUNT(*) FROM option_positions WHERE guildId = @guildId AND userId = @userId) AS optionPositions,
                 (SELECT COUNT(*) FROM option_trades WHERE guildId = @guildId AND userId = @userId) AS optionTrades,
                 (SELECT COUNT(*) FROM exchange_orders WHERE guildId = @guildId AND userId = @userId) AS orders,
                 (SELECT COUNT(*) FROM prediction_positions WHERE guildId = @guildId AND userId = @userId) AS predictions,
                 (SELECT COUNT(*) FROM exchange_events WHERE guildId = @guildId AND userId = @userId) AS events,
                 (SELECT COUNT(*) FROM perp_positions WHERE guildId = @guildId AND userId = @userId) AS perps,
                 (SELECT COUNT(*) FROM exchange_optins WHERE guildId = @guildId AND userId = @userId) AS optIns`,
            { guildId, userId }
        );

        // The Parlor (web app): personas, their knowledge workspaces, and
        // discussions are bot-wide personal data, like conversations.
        const parlor = db.get(
            `SELECT
                 (SELECT COUNT(*) FROM parlor_personas WHERE ownerId = @userId) AS personas,
                 (SELECT COUNT(*) FROM parlor_notes n
                  JOIN parlor_personas p ON p.id = n.personaId
                  WHERE p.ownerId = @userId) AS notes,
                 (SELECT COUNT(*) FROM parlor_conversations WHERE ownerId = @userId) AS discussions`,
            { userId }
        );

        const tavernCharacter = db.get(
            `SELECT name, calling, adventuresCompleted FROM tavern_characters
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );
        const tavernRoom = db.get(
            'SELECT 1 AS ok FROM tavern_rooms WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        const tavernRelationships = db.get(
            `SELECT COUNT(*) AS c FROM tavern_npc_relationships
             WHERE guildId = @guildId AND userId = @userId AND score != 0`,
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
            },
            exchange: {
                accountType: exchangeAccount?.accountType || null,
                leverage: exchangeAccount?.leverage ?? null,
                goblinMode: Boolean(exchangeAccount?.goblinMode),
                marginLoan: exchangeAccount?.marginLoan ?? 0,
                liquidations: exchangeAccount?.liquidations ?? 0,
                shortPositions: exchangeCounts?.shorts || 0,
                optionPositions: exchangeCounts?.optionPositions || 0,
                optionTrades: exchangeCounts?.optionTrades || 0,
                orders: exchangeCounts?.orders || 0,
                eventContracts: exchangeCounts?.predictions || 0,
                engineEvents: exchangeCounts?.events || 0,
                perpPositions: exchangeCounts?.perps || 0,
                groupOptIns: exchangeCounts?.optIns || 0
            },
            parlor: {
                personas: parlor?.personas || 0,
                notes: parlor?.notes || 0,
                discussions: parlor?.discussions || 0
            },
            tavernCharacter: tavernCharacter || null,
            tavernRoom: Boolean(tavernRoom),
            tavernRelationships: tavernRelationships?.c || 0
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
        const dmScope = dmScopeId(userId);

        const counts = db.transaction(() => {
            const counts = { knownNames };

            counts.memories = db.run(
                'DELETE FROM memory_embeddings WHERE authorId = @userId', { userId }
            ).changes;
            // DM-scope memories include the bot's side of the user's DMs
            counts.memories += db.run(
                'DELETE FROM memory_embeddings WHERE guildId = @dmScope', { dmScope }
            ).changes;

            counts.userFacts = db.run(
                `DELETE FROM facts WHERE subjectType = 'USER' AND subjectId = @userId`,
                { userId }
            ).changes;
            // Everything learned inside the user's DMs, regardless of subject
            counts.userFacts += db.run(
                'DELETE FROM facts WHERE guildId = @dmScope', { dmScope }
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

                // Review pass 6: tavern adventure-log prose mentioning the
                // user or their character by name (recaps, checks, beats),
                // plus shared world lore (custom campaigns may write names)
                counts.reviewedTavernLog = 0;
                const tavernLogRows = db.all('SELECT id, content FROM tavern_adventure_log');
                for (const row of tavernLogRows) {
                    if (nameMatcher.test(row.content)) {
                        db.run('DELETE FROM tavern_adventure_log WHERE id = @id', { id: row.id });
                        counts.reviewedTavernLog++;
                    }
                }
                const loreRows = db.all('SELECT id, name, content FROM tavern_lore');
                for (const row of loreRows) {
                    if (nameMatcher.test(row.name) || nameMatcher.test(row.content)) {
                        db.run('DELETE FROM tavern_lore WHERE id = @id', { id: row.id });
                        counts.reviewedTavernLog++;
                    }
                }

                // Review pass 7: GBA run milestones - model-written
                // commentary that may credit audience advice by name
                counts.reviewedRunMilestones = 0;
                const milestoneRows = db.all('SELECT id, text FROM gba_run_milestones');
                for (const row of milestoneRows) {
                    if (nameMatcher.test(row.text)) {
                        db.run('DELETE FROM gba_run_milestones WHERE id = @id', { id: row.id });
                        counts.reviewedRunMilestones++;
                    }
                }
            } else {
                counts.reviewedSummaries = 0;
                counts.reviewedThoughts = 0;
                counts.reviewedGraphNodes = 0;
                counts.reviewedTavernLog = 0;
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

            // DM conversation containers: the user's messages/conversations
            // are already gone (above), so drop the summaries and the
            // guild_conversations rows keyed on their DM scope.
            counts.dmConversationRows = db.run(
                `DELETE FROM conversation_summaries WHERE guildConversationId IN
                    (SELECT id FROM guild_conversations WHERE guildId = @dmScope)`,
                { dmScope }
            ).changes;
            counts.dmConversationRows += db.run(
                'DELETE FROM guild_conversations WHERE guildId = @dmScope', { dmScope }
            ).changes;

            counts.nicknames = db.run(
                'DELETE FROM user_nicknames WHERE userId = @userId', { userId }
            ).changes;

            counts.preferences = db.run(
                'DELETE FROM UserPreferences WHERE userId = @userId', { userId }
            ).changes;

            // Web app sessions: logging the user out everywhere is part of
            // forgetting them.
            counts.webSessions = db.run(
                'DELETE FROM web_sessions WHERE userId = @userId', { userId }
            ).changes;

            // Web chat conversation containers (their messages/summaries are
            // already gone via the DM-scope deletions above).
            counts.webConversations = db.run(
                'DELETE FROM web_conversations WHERE userId = @userId', { userId }
            ).changes;

            // The Parlor: personas cascade their whole knowledge workspace
            // (notes, tags, tag links, participant seats); discussions
            // cascade their messages. foreign_keys is ON in db/index.js.
            counts.parlor = db.run(
                'DELETE FROM parlor_personas WHERE ownerId = @userId', { userId }
            ).changes;
            counts.parlor += db.run(
                'DELETE FROM parlor_conversations WHERE ownerId = @userId', { userId }
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

            // Exchange: the margin account, its loan, every derivative position,
            // and the engine's per-user event trail are the same kind of
            // personal financial data - deleted outright with the wallet.
            // Guild-wide rows (prediction_markets, exchange_settings) survive;
            // the market a user opened outlives them, but their stake does not.
            counts.exchange = 0;
            for (const table of [
                'exchange_accounts', 'short_positions', 'option_positions', 'option_trades',
                'exchange_orders', 'prediction_positions', 'exchange_events',
                'perp_positions', 'exchange_optins'
            ]) {
                counts.exchange += db.run(`DELETE FROM ${table} WHERE userId = @userId`, { userId }).changes;
            }
            // A market's creator attribution is not worth keeping once they ask
            // to be forgotten; the market itself still settles from the feed.
            counts.exchange += db.run(
                'UPDATE prediction_markets SET createdBy = NULL WHERE createdBy = @userId', { userId }
            ).changes;

            // Tavern: the character sheet and party memberships are personal
            // data - deleted outright. Shared adventure records survive with
            // attribution removed (the review pass above already dropped
            // prose that names the user or their characters).
            counts.tavern = db.run(
                'DELETE FROM tavern_party_members WHERE userId = @userId', { userId }
            ).changes;
            counts.tavern += db.run(
                'DELETE FROM tavern_characters WHERE userId = @userId', { userId }
            ).changes;
            counts.tavern += db.run(
                'DELETE FROM tavern_npc_relationships WHERE userId = @userId', { userId }
            ).changes;
            counts.tavern += db.run(
                'DELETE FROM tavern_rooms WHERE userId = @userId', { userId }
            ).changes;
            db.run(
                'UPDATE tavern_adventures SET createdBy = NULL WHERE createdBy = @userId', { userId }
            );
            db.run(
                'UPDATE tavern_adventure_log SET userId = NULL WHERE userId = @userId', { userId }
            );
            // Scrub the user's id out of structured adventure state
            // (spotlight order, big-move flags, pending checks)
            const stateRows = db.all(
                `SELECT id, state FROM tavern_adventures WHERE state LIKE '%' || @userId || '%'`,
                { userId }
            );
            for (const row of stateRows) {
                try {
                    const state = JSON.parse(row.state);
                    if (Array.isArray(state.spotlight)) state.spotlight = state.spotlight.filter(id => id !== userId);
                    if (state.bigMovesUsed) delete state.bigMovesUsed[userId];
                    if (state.autoSuccess) delete state.autoSuccess[userId];
                    if (state.lastCheck?.userId === userId) state.lastCheck = null;
                    db.run(
                        'UPDATE tavern_adventures SET state = @state WHERE id = @id',
                        { id: row.id, state }
                    );
                } catch {
                    // unparseable state carries no attributable structure
                }
            }

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
        const dmScope = dmScopeId(userId);
        const byTable = {
            memory_embeddings: db.get(
                'SELECT COUNT(*) AS c FROM memory_embeddings WHERE authorId = @userId OR guildId = @dmScope',
                { userId, dmScope }
            ).c,
            facts: db.get(
                `SELECT COUNT(*) AS c FROM facts
                 WHERE (subjectType = 'USER' AND subjectId = @userId) OR guildId = @dmScope`,
                { userId, dmScope }
            ).c,
            dm_conversations: db.get(
                'SELECT COUNT(*) AS c FROM guild_conversations WHERE guildId = @dmScope', { dmScope }
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
            web_sessions: db.get(
                'SELECT COUNT(*) AS c FROM web_sessions WHERE userId = @userId', { userId }
            ).c,
            web_conversations: db.get(
                'SELECT COUNT(*) AS c FROM web_conversations WHERE userId = @userId', { userId }
            ).c,
            parlor_personas: db.get(
                'SELECT COUNT(*) AS c FROM parlor_personas WHERE ownerId = @userId', { userId }
            ).c,
            parlor_conversations: db.get(
                'SELECT COUNT(*) AS c FROM parlor_conversations WHERE ownerId = @userId', { userId }
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
            ).c,
            exchange_accounts: db.get(
                'SELECT COUNT(*) AS c FROM exchange_accounts WHERE userId = @userId', { userId }
            ).c,
            short_positions: db.get(
                'SELECT COUNT(*) AS c FROM short_positions WHERE userId = @userId', { userId }
            ).c,
            option_positions: db.get(
                'SELECT COUNT(*) AS c FROM option_positions WHERE userId = @userId', { userId }
            ).c,
            option_trades: db.get(
                'SELECT COUNT(*) AS c FROM option_trades WHERE userId = @userId', { userId }
            ).c,
            exchange_orders: db.get(
                'SELECT COUNT(*) AS c FROM exchange_orders WHERE userId = @userId', { userId }
            ).c,
            prediction_positions: db.get(
                'SELECT COUNT(*) AS c FROM prediction_positions WHERE userId = @userId', { userId }
            ).c,
            exchange_events: db.get(
                'SELECT COUNT(*) AS c FROM exchange_events WHERE userId = @userId', { userId }
            ).c,
            perp_positions: db.get(
                'SELECT COUNT(*) AS c FROM perp_positions WHERE userId = @userId', { userId }
            ).c,
            exchange_optins: db.get(
                'SELECT COUNT(*) AS c FROM exchange_optins WHERE userId = @userId', { userId }
            ).c,
            tavern_characters: db.get(
                'SELECT COUNT(*) AS c FROM tavern_characters WHERE userId = @userId', { userId }
            ).c,
            tavern_party_members: db.get(
                'SELECT COUNT(*) AS c FROM tavern_party_members WHERE userId = @userId', { userId }
            ).c,
            tavern_adventure_log: db.get(
                'SELECT COUNT(*) AS c FROM tavern_adventure_log WHERE userId = @userId', { userId }
            ).c,
            tavern_npc_relationships: db.get(
                'SELECT COUNT(*) AS c FROM tavern_npc_relationships WHERE userId = @userId', { userId }
            ).c,
            tavern_rooms: db.get(
                'SELECT COUNT(*) AS c FROM tavern_rooms WHERE userId = @userId', { userId }
            ).c
        };

        const total = Object.values(byTable).reduce((sum, c) => sum + c, 0);
        return { total, byTable };
    }
}

module.exports = new PrivacyService();
