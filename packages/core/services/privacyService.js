const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');

/**
 * Privacy controls as product features: the data transparency report behind
 * /what-do-you-know-about-me and the full per-user erasure behind /forget-me.
 *
 * Erasure scope (see documentation/differentiation_strategy.md):
 * - DELETE: memory_embeddings (by authorId, plus everything in the user's
 *   DM scope), facts (USER-subject, plus the whole DM scope), followups
 *   created by or about the user, automations the user owns, web share
 *   links they created, the DM scope's guild_settings row (AI overrides,
 *   retention, directive), conversation history (messages,
 *   conversations, prompts, DM conversation containers and summaries),
 *   user_nicknames, UserPreferences, users row, all economy data
 *   (wallet, ledger, stock holdings, stock trades), tavern characters
 *   (sheet + party memberships), and the user's whole Parlor (personas
 *   with their note/tag workspaces, and parlor discussions - cascades),
 *   plus their footprint in OTHER people's shared parlors (memberships,
 *   invitations addressed to them, messages they authored there), the
 *   cached Discord friend roster in both directions (their own list and
 *   their appearance in anyone else's), user_integrations (stored
 *   Notion/GitHub API tokens - credentials are the most urgent thing to
 *   erase), the user's MTGA deck library (folders + decks; card rows
 *   cascade), pinned Workshop applets (web_applets), and the user's
 *   Observatory (project registry, job records, and the whole on-disk
 *   workspace tree; live jobs are cancelled first).
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
    async collectKnownNames({ userId, extraNames = [] }) {
        const names = new Set();

        for (const name of extraNames) {
            if (name) names.add(String(name).trim());
        }

        const nicknameRows = await db.all(
            'SELECT nickname FROM user_nicknames WHERE userId = @userId',
            { userId }
        );
        for (const row of nicknameRows) names.add(String(row.nickname).trim());

        const authorRows = await db.all(
            `SELECT DISTINCT authorName FROM memory_embeddings
             WHERE authorId = @userId AND authorName IS NOT NULL`,
            { userId }
        );
        for (const row of authorRows) names.add(String(row.authorName).trim());

        const userRow = await db.get(
            'SELECT discordUsername, username FROM users WHERE discordId = @userId',
            { userId }
        );
        if (userRow?.discordUsername) names.add(String(userRow.discordUsername).trim());
        if (userRow?.username) names.add(String(userRow.username).trim());

        // Tavern character names appear throughout adventure-log prose
        const characterRows = await db.all(
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
    async buildUserReport({ guildId, userId }) {
        const facts = await db.all(
            `SELECT content, source, updatedAt FROM facts
             WHERE guildId = @guildId AND subjectType = 'USER' AND subjectId = @userId
             ORDER BY updatedAt DESC, id DESC`,
            { guildId, userId }
        );

        const memories = await db.get(
            `SELECT COUNT(*) AS count, MIN(createdAt) AS oldest, MAX(createdAt) AS newest
             FROM memory_embeddings WHERE guildId = @guildId AND authorId = @userId`,
            { guildId, userId }
        );

        const followups = await db.all(
            `SELECT note, dueAt FROM followups
             WHERE guildId = @guildId AND userId = @userId AND status = 'PENDING'
             ORDER BY dueAt ASC`,
            { guildId, userId }
        );

        // Scheduled automations the user owns in this scope (recurring
        // prompts - /automation in guilds, the web portal's Tasks pane in
        // the DM scope)
        const automations = await db.all(
            `SELECT name, schedule, isEnabled, nextRun FROM automations
             WHERE guildId = @guildId AND userId = @userId
             ORDER BY name ASC`,
            { guildId, userId }
        );

        // Active read-only share links the user created (bot-wide, like
        // web conversations)
        const shareLinks = await db.get(
            'SELECT COUNT(*) AS c FROM web_share_links WHERE userId = @userId',
            { userId }
        );

        const nickname = await db.get(
            'SELECT nickname FROM user_nicknames WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );

        const preferences = await db.get(
            'SELECT memeMode, personality_preset, custom_instructions FROM UserPreferences WHERE userId = @userId',
            { userId }
        );

        const userRow = await db.get('SELECT id, joinedAt FROM users WHERE discordId = @userId', { userId });
        const conversations = userRow
            ? await db.get(
                `SELECT COUNT(DISTINCT c.id) AS conversationCount, COUNT(m.id) AS messageCount
                 FROM conversations c
                 LEFT JOIN messages m ON m.conversationId = c.id
                 WHERE c.userId = @internalId`,
                { internalId: userRow.id }
            )
            : { conversationCount: 0, messageCount: 0 };

        const usage = await db.get(
            `SELECT COUNT(*) AS count FROM usage_log
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );

        const activity = await db.get(
            `SELECT COALESCE(SUM(messageCount), 0) AS messages FROM guild_activity
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );

        const wallet = await db.get(
            'SELECT balance FROM economy_wallets WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        const economyTx = await db.get(
            'SELECT COUNT(*) AS c FROM economy_transactions WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        const stockHoldings = await db.get(
            'SELECT COUNT(*) AS c FROM stock_holdings WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        const stockTrades = await db.get(
            'SELECT COUNT(*) AS c FROM stock_trades WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );

        // Exchange: the margin account, its liabilities, and every derivative
        // position are personal financial data, same as the wallet.
        const exchangeAccount = await db.get(
            `SELECT accountType, leverage, goblinMode, marginLoan, liquidations
             FROM exchange_accounts WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );
        const exchangeCounts = await db.get(
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

        // The Observatory: simulation projects and their background jobs are
        // bot-wide personal data (workspaces live on disk keyed by user).
        const observatory = await db.get(
            `SELECT
                 (SELECT COUNT(*) FROM observatory_projects WHERE userId = @userId) AS projects,
                 (SELECT COUNT(*) FROM observatory_jobs WHERE userId = @userId) AS jobs,
                 (SELECT COUNT(*) FROM observatory_jobs
                  WHERE userId = @userId AND status = 'RUNNING') AS runningJobs,
                 (SELECT COUNT(*) FROM observatory_share_links WHERE userId = @userId) AS sharedDashboards`,
            { userId }
        );

        // The Parlor (web app): personas, their knowledge workspaces, and
        // discussions are bot-wide personal data, like conversations.
        const parlor = await db.get(
            `SELECT
                 (SELECT COUNT(*) FROM parlor_personas WHERE ownerId = @userId) AS personas,
                 (SELECT COUNT(*) FROM parlor_notes n
                  JOIN parlor_personas p ON p.id = n.personaId
                  WHERE p.ownerId = @userId) AS notes,
                 (SELECT COUNT(*) FROM parlor_conversations WHERE ownerId = @userId) AS discussions,
                 (SELECT COUNT(*) FROM parlor_members WHERE userId = @userId) AS sharedDiscussions,
                 (SELECT COUNT(*) FROM parlor_invites
                  WHERE inviteeId = @userId AND status = 'pending') AS pendingInvites`,
            { userId }
        );

        // The MTGA deck library (web app): imported Arena decks and their
        // folders are bot-wide personal data, like the Parlor.
        const mtga = await db.get(
            `SELECT
                 (SELECT COUNT(*) FROM mtga_folders WHERE userId = @userId) AS folders,
                 (SELECT COUNT(*) FROM mtga_decks WHERE userId = @userId) AS decks`,
            { userId }
        );

        // Personal platform integrations: report which providers are
        // connected (never the tokens themselves)
        const integrations = await db.all(
            `SELECT provider, accountLabel, createdAt FROM user_integrations
             WHERE userId = @userId ORDER BY provider`,
            { userId }
        );

        // Pinned Workshop applets (bot-wide personal data, like conversations)
        const applets = await db.get(
            'SELECT COUNT(*) AS c FROM web_applets WHERE userId = @userId',
            { userId }
        );

        // Cached Discord friend roster (synced by the Activity)
        const friends = await db.get(
            `SELECT
                 (SELECT COUNT(*) FROM user_friends WHERE ownerId = @userId) AS mine,
                 (SELECT COUNT(*) FROM user_friends WHERE friendId = @userId) AS listedBy`,
            { userId }
        );

        const tavernCharacter = await db.get(
            `SELECT name, calling, adventuresCompleted FROM tavern_characters
             WHERE guildId = @guildId AND userId = @userId`,
            { guildId, userId }
        );
        const tavernRoom = await db.get(
            'SELECT 1 AS ok FROM tavern_rooms WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        const tavernRelationships = await db.get(
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
            automations: automations.map(row => ({
                name: row.name,
                schedule: row.schedule,
                enabled: Boolean(row.isEnabled),
                nextRun: row.nextRun
            })),
            shareLinks: shareLinks?.c || 0,
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
            observatory: {
                projects: observatory?.projects || 0,
                jobs: observatory?.jobs || 0,
                runningJobs: observatory?.runningJobs || 0,
                sharedDashboards: observatory?.sharedDashboards || 0
            },
            parlor: {
                personas: parlor?.personas || 0,
                notes: parlor?.notes || 0,
                discussions: parlor?.discussions || 0,
                sharedDiscussions: parlor?.sharedDiscussions || 0,
                pendingInvites: parlor?.pendingInvites || 0
            },
            mtga: {
                folders: mtga?.folders || 0,
                decks: mtga?.decks || 0
            },
            applets: applets?.c || 0,
            friends: {
                cached: friends?.mine || 0,
                listedByOthers: friends?.listedBy || 0
            },
            integrations: integrations.map(row => ({
                provider: row.provider,
                account: row.accountLabel || null,
                connectedAt: row.createdAt
            })),
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
    async forgetUser({ userId, extraNames = [] }) {
        // Collect names BEFORE deleting the rows they come from
        const knownNames = await this.collectKnownNames({ userId, extraNames });
        const nameMatcher = this._buildNameMatcher(knownNames);
        const dmScope = dmScopeId(userId);

        const counts = await db.transaction(async () => {
            const counts = { knownNames };

            counts.memories = (await db.run(
                'DELETE FROM memory_embeddings WHERE authorId = @userId', { userId }
            )).changes;
            // DM-scope memories include the bot's side of the user's DMs
            counts.memories += (await db.run(
                'DELETE FROM memory_embeddings WHERE guildId = @dmScope', { dmScope }
            )).changes;

            counts.userFacts = (await db.run(
                `DELETE FROM facts WHERE subjectType = 'USER' AND subjectId = @userId`,
                { userId }
            )).changes;
            // Everything learned inside the user's DMs, regardless of subject
            counts.userFacts += (await db.run(
                'DELETE FROM facts WHERE guildId = @dmScope', { dmScope }
            )).changes;

            // Follow-ups created by/about the user (any status - erasure is erasure)
            counts.followups = (await db.run(
                'DELETE FROM followups WHERE userId = @userId', { userId }
            )).changes;

            // Scheduled automations the user owns (guild and DM scope) -
            // their prompt text is theirs, and an orphaned unattended agent
            // task must not keep running for a forgotten user.
            counts.automations = (await db.run(
                'DELETE FROM automations WHERE userId = @userId', { userId }
            )).changes;

            // Review pass 1: GUILD-subject facts that mention the user by name
            counts.reviewedGuildFacts = 0;
            if (nameMatcher) {
                const guildFacts = await db.all(
                    `SELECT id, content FROM facts WHERE subjectType = 'GUILD'`
                );
                for (const fact of guildFacts) {
                    if (nameMatcher.test(fact.content)) {
                        await db.run('DELETE FROM facts WHERE id = @id', { id: fact.id });
                        counts.reviewedGuildFacts++;
                    }
                }

                // Review pass 2: conversation summaries mentioning the user
                counts.reviewedSummaries = 0;
                const summaries = await db.all('SELECT id, summary FROM conversation_summaries');
                for (const row of summaries) {
                    if (nameMatcher.test(row.summary)) {
                        await db.run('DELETE FROM conversation_summaries WHERE id = @id', { id: row.id });
                        counts.reviewedSummaries++;
                    }
                }

                // Review pass 3: follow-up notes mentioning the user by name
                const notes = await db.all('SELECT id, note FROM followups');
                for (const row of notes) {
                    if (nameMatcher.test(row.note)) {
                        await db.run('DELETE FROM followups WHERE id = @id', { id: row.id });
                        counts.followups++;
                    }
                }

                // Review pass 4: internal-monologue thoughts and scratchpad
                // notes mentioning the user
                counts.reviewedThoughts = 0;
                const thoughts = await db.all('SELECT id, thought FROM monologue_thoughts');
                for (const row of thoughts) {
                    if (nameMatcher.test(row.thought)) {
                        await db.run('DELETE FROM monologue_thoughts WHERE id = @id', { id: row.id });
                        counts.reviewedThoughts++;
                    }
                }
                const padNotes = await db.all('SELECT id, content FROM monologue_scratchpad');
                for (const row of padNotes) {
                    if (nameMatcher.test(row.content)) {
                        await db.run('DELETE FROM monologue_scratchpad WHERE id = @id', { id: row.id });
                        counts.reviewedThoughts++;
                    }
                }

                // Review pass 5: knowledge-graph nodes whose label or content
                // mentions the user (incident edges cascade)
                counts.reviewedGraphNodes = 0;
                const graphNodes = await db.all('SELECT id, label, content FROM kg_nodes');
                for (const node of graphNodes) {
                    if (nameMatcher.test(node.label) || (node.content && nameMatcher.test(node.content))) {
                        await db.run('DELETE FROM kg_nodes WHERE id = @id', { id: node.id });
                        counts.reviewedGraphNodes++;
                    }
                }

                // Review pass 6: tavern adventure-log prose mentioning the
                // user or their character by name (recaps, checks, beats),
                // plus shared world lore (custom campaigns may write names)
                counts.reviewedTavernLog = 0;
                const tavernLogRows = await db.all('SELECT id, content FROM tavern_adventure_log');
                for (const row of tavernLogRows) {
                    if (nameMatcher.test(row.content)) {
                        await db.run('DELETE FROM tavern_adventure_log WHERE id = @id', { id: row.id });
                        counts.reviewedTavernLog++;
                    }
                }
                const loreRows = await db.all('SELECT id, name, content FROM tavern_lore');
                for (const row of loreRows) {
                    if (nameMatcher.test(row.name) || nameMatcher.test(row.content)) {
                        await db.run('DELETE FROM tavern_lore WHERE id = @id', { id: row.id });
                        counts.reviewedTavernLog++;
                    }
                }

                // Review pass 7: GBA run milestones - model-written
                // commentary that may credit audience advice by name
                counts.reviewedRunMilestones = 0;
                const milestoneRows = await db.all('SELECT id, text FROM gba_run_milestones');
                for (const row of milestoneRows) {
                    if (nameMatcher.test(row.text)) {
                        await db.run('DELETE FROM gba_run_milestones WHERE id = @id', { id: row.id });
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
            const userRow = await db.get('SELECT id FROM users WHERE discordId = @userId', { userId });
            if (userRow) {
                const internalId = userRow.id;
                await db.run('UPDATE users SET activeConversationId = NULL WHERE id = @internalId', { internalId });
                counts.messages += (await db.run(
                    `DELETE FROM messages WHERE conversationId IN
                        (SELECT id FROM conversations WHERE userId = @internalId)`,
                    { internalId }
                )).changes;
                counts.messages += (await db.run(
                    'DELETE FROM messages WHERE createdBy = @internalId', { internalId }
                )).changes;
                counts.conversations = (await db.run(
                    'DELETE FROM conversations WHERE userId = @internalId', { internalId }
                )).changes;
                counts.prompts = (await db.run(
                    'DELETE FROM prompts WHERE userId = @internalId', { internalId }
                )).changes;
                await db.run('DELETE FROM users WHERE id = @internalId', { internalId });
                counts.profile = 1;
            } else {
                counts.profile = 0;
            }

            // DM conversation containers: the user's messages/conversations
            // are already gone (above), so drop the summaries and the
            // guild_conversations rows keyed on their DM scope.
            counts.dmConversationRows = (await db.run(
                `DELETE FROM conversation_summaries WHERE guildConversationId IN
                    (SELECT id FROM guild_conversations WHERE guildId = @dmScope)`,
                { dmScope }
            )).changes;
            counts.dmConversationRows += (await db.run(
                'DELETE FROM guild_conversations WHERE guildId = @dmScope', { dmScope }
            )).changes;

            // The DM scope's settings row (AI overrides, personality
            // directive, memory retention) is per-user state too.
            counts.dmSettings = (await db.run(
                'DELETE FROM guild_settings WHERE guildId = @dmScope', { dmScope }
            )).changes;

            counts.nicknames = (await db.run(
                'DELETE FROM user_nicknames WHERE userId = @userId', { userId }
            )).changes;

            counts.preferences = (await db.run(
                'DELETE FROM UserPreferences WHERE userId = @userId', { userId }
            )).changes;

            // Web app sessions: logging the user out everywhere is part of
            // forgetting them.
            counts.webSessions = (await db.run(
                'DELETE FROM web_sessions WHERE userId = @userId', { userId }
            )).changes;

            // Share links go before their conversations: a forgotten user's
            // transcripts must stop being publicly readable.
            counts.webShareLinks = (await db.run(
                'DELETE FROM web_share_links WHERE userId = @userId', { userId }
            )).changes;

            // Pinned Workshop applets (copies of mini-apps from chat).
            // Delete before conversations so the FK SET NULL never leaves
            // an orphaned pin for a forgotten user.
            counts.webApplets = (await db.run(
                'DELETE FROM web_applets WHERE userId = @userId', { userId }
            )).changes;

            // Web chat conversation containers (their messages/summaries are
            // already gone via the DM-scope deletions above).
            counts.webConversations = (await db.run(
                'DELETE FROM web_conversations WHERE userId = @userId', { userId }
            )).changes;

            // The Parlor: personas cascade their whole knowledge workspace
            // (notes, tags, tag links, participant seats); discussions
            // cascade their messages, members, and invites.
            // foreign_keys is ON in db/index.js.
            counts.parlor = (await db.run(
                'DELETE FROM parlor_personas WHERE ownerId = @userId', { userId }
            )).changes;
            counts.parlor += (await db.run(
                'DELETE FROM parlor_conversations WHERE ownerId = @userId', { userId }
            )).changes;
            // The cached Discord friend roster (synced by the Activity):
            // both the user's own list and their appearance in anyone
            // else's. It re-syncs for those users next time they open the
            // Activity - this is a cache, never a source of truth.
            counts.friends = (await db.run(
                'DELETE FROM user_friends WHERE ownerId = @userId', { userId }
            )).changes;
            counts.friends += (await db.run(
                'DELETE FROM user_friends WHERE friendId = @userId', { userId }
            )).changes;

            // Stored platform API tokens (Notion/GitHub): credentials are
            // the most urgent thing to erase.
            counts.integrations = (await db.run(
                'DELETE FROM user_integrations WHERE userId = @userId', { userId }
            )).changes;

            // The MTGA deck library: decks first (their card rows cascade),
            // then the folders that grouped them.
            counts.mtga = (await db.run(
                'DELETE FROM mtga_decks WHERE userId = @userId', { userId }
            )).changes;
            counts.mtga += (await db.run(
                'DELETE FROM mtga_folders WHERE userId = @userId', { userId }
            )).changes;

            // Shared parlors (multi-user): memberships in OTHER people's
            // discussions, invitations addressed to the user, and the
            // messages they authored there are theirs - deleted outright.
            counts.parlor += (await db.run(
                'DELETE FROM parlor_members WHERE userId = @userId', { userId }
            )).changes;
            counts.parlor += (await db.run(
                'DELETE FROM parlor_invites WHERE inviteeId = @userId', { userId }
            )).changes;
            counts.parlor += (await db.run(
                'DELETE FROM parlor_messages WHERE userId = @userId', { userId }
            )).changes;

            // Economy: wallet, ledger, stock positions, and trade history are
            // all personal financial data - deleted outright (guild totals do
            // not depend on them, unlike usage/activity counters).
            counts.economy = (await db.run(
                'DELETE FROM economy_wallets WHERE userId = @userId', { userId }
            )).changes;
            counts.economy += (await db.run(
                'DELETE FROM economy_transactions WHERE userId = @userId', { userId }
            )).changes;
            counts.economy += (await db.run(
                'DELETE FROM stock_holdings WHERE userId = @userId', { userId }
            )).changes;
            counts.economy += (await db.run(
                'DELETE FROM stock_trades WHERE userId = @userId', { userId }
            )).changes;

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
                counts.exchange += (await db.run(`DELETE FROM ${table} WHERE userId = @userId`, { userId })).changes;
            }
            // A market's creator attribution is not worth keeping once they ask
            // to be forgotten; the market itself still settles from the feed.
            counts.exchange += (await db.run(
                'UPDATE prediction_markets SET createdBy = NULL WHERE createdBy = @userId', { userId }
            )).changes;

            // Tavern: the character sheet and party memberships are personal
            // data - deleted outright. Shared adventure records survive with
            // attribution removed (the review pass above already dropped
            // prose that names the user or their characters).
            counts.tavern = (await db.run(
                'DELETE FROM tavern_party_members WHERE userId = @userId', { userId }
            )).changes;
            counts.tavern += (await db.run(
                'DELETE FROM tavern_characters WHERE userId = @userId', { userId }
            )).changes;
            counts.tavern += (await db.run(
                'DELETE FROM tavern_npc_relationships WHERE userId = @userId', { userId }
            )).changes;
            counts.tavern += (await db.run(
                'DELETE FROM tavern_rooms WHERE userId = @userId', { userId }
            )).changes;
            await db.run(
                'UPDATE tavern_adventures SET createdBy = NULL WHERE createdBy = @userId', { userId }
            );
            await db.run(
                'UPDATE tavern_adventure_log SET userId = NULL WHERE userId = @userId', { userId }
            );
            // Scrub the user's id out of structured adventure state
            // (spotlight order, big-move flags, pending checks)
            const stateRows = await db.all(
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
                    await db.run(
                        'UPDATE tavern_adventures SET state = @state WHERE id = @id',
                        { id: row.id, state }
                    );
                } catch {
                    // unparseable state carries no attributable structure
                }
            }

            // Anonymize, don't delete: cost accounting keeps its token counts
            counts.anonymizedUsageRows = (await db.run(
                'UPDATE usage_log SET userId = NULL WHERE userId = @userId', { userId }
            )).changes;
            counts.anonymizedUsageRows += (await db.run(
                'UPDATE command_log SET userId = NULL WHERE userId = @userId', { userId }
            )).changes;

            // Activity counters likewise: userId nulled, counts kept so
            // server-wide /wrapped totals stay accurate. NULLs are distinct
            // in SQLite unique indexes, so this cannot hit a PK conflict.
            counts.anonymizedActivityRows = (await db.run(
                'UPDATE guild_activity SET userId = NULL WHERE userId = @userId', { userId }
            )).changes;

            return counts;
        });

        // Derived vectors must not outlive the memories they were computed
        // from: drop vec-index entries orphaned by the deletion above.
        await require('./memoryService').cleanupVecIndex();

        // Uploaded web chat images live on disk keyed by user; the message
        // rows referencing them are gone, so the files go too.
        counts.uploadedFiles = require('../utils/webUploads').deleteUserUploads(userId);

        // Observatory projects, jobs, and the on-disk workspace tree (live
        // jobs are cancelled first). Outside the transaction because it also
        // touches the filesystem, same as the uploads above.
        const observatory = await require('./observatoryService').forgetUser(userId);
        counts.observatoryProjects = observatory.projects;
        counts.observatoryJobs = observatory.jobs;
        counts.observatoryShareLinks = observatory.shareLinks;

        // Sandbox requests (they carry reasons/URLs the user wrote) go;
        // installed packages stay - they are shared host state - with the
        // requester/approver attribution nulled.
        const sandboxRequests = await require('./sandboxRequestService').forgetUser(userId);
        counts.sandboxRequests = sandboxRequests.requests;
        counts.anonymizedSandboxPackages = sandboxRequests.packagesAnonymized;

        return counts;
    }

    /**
     * Post-erasure audit: count rows still attributed to the user. Used by
     * tests and surfaced after /forget-me so "zero gaps" is provable.
     * @returns {{total: number, byTable: Object}}
     */
    async auditUser({ userId }) {
        const dmScope = dmScopeId(userId);
        const byTable = {
            memory_embeddings: (await db.get(
                'SELECT COUNT(*) AS c FROM memory_embeddings WHERE authorId = @userId OR guildId = @dmScope',
                { userId, dmScope }
            )).c,
            facts: (await db.get(
                `SELECT COUNT(*) AS c FROM facts
                 WHERE (subjectType = 'USER' AND subjectId = @userId) OR guildId = @dmScope`,
                { userId, dmScope }
            )).c,
            dm_conversations: (await db.get(
                'SELECT COUNT(*) AS c FROM guild_conversations WHERE guildId = @dmScope', { dmScope }
            )).c,
            dm_guild_settings: (await db.get(
                'SELECT COUNT(*) AS c FROM guild_settings WHERE guildId = @dmScope', { dmScope }
            )).c,
            followups: (await db.get(
                'SELECT COUNT(*) AS c FROM followups WHERE userId = @userId', { userId }
            )).c,
            automations: (await db.get(
                'SELECT COUNT(*) AS c FROM automations WHERE userId = @userId', { userId }
            )).c,
            web_share_links: (await db.get(
                'SELECT COUNT(*) AS c FROM web_share_links WHERE userId = @userId', { userId }
            )).c,
            users: (await db.get(
                'SELECT COUNT(*) AS c FROM users WHERE discordId = @userId', { userId }
            )).c,
            user_nicknames: (await db.get(
                'SELECT COUNT(*) AS c FROM user_nicknames WHERE userId = @userId', { userId }
            )).c,
            UserPreferences: (await db.get(
                'SELECT COUNT(*) AS c FROM UserPreferences WHERE userId = @userId', { userId }
            )).c,
            web_sessions: (await db.get(
                'SELECT COUNT(*) AS c FROM web_sessions WHERE userId = @userId', { userId }
            )).c,
            web_conversations: (await db.get(
                'SELECT COUNT(*) AS c FROM web_conversations WHERE userId = @userId', { userId }
            )).c,
            web_applets: (await db.get(
                'SELECT COUNT(*) AS c FROM web_applets WHERE userId = @userId', { userId }
            )).c,
            parlor_personas: (await db.get(
                'SELECT COUNT(*) AS c FROM parlor_personas WHERE ownerId = @userId', { userId }
            )).c,
            parlor_conversations: (await db.get(
                'SELECT COUNT(*) AS c FROM parlor_conversations WHERE ownerId = @userId', { userId }
            )).c,
            user_friends: (await db.get(
                `SELECT COUNT(*) AS c FROM user_friends
                 WHERE ownerId = @userId OR friendId = @userId`, { userId }
            )).c,
            parlor_members: (await db.get(
                'SELECT COUNT(*) AS c FROM parlor_members WHERE userId = @userId', { userId }
            )).c,
            parlor_invites: (await db.get(
                'SELECT COUNT(*) AS c FROM parlor_invites WHERE inviteeId = @userId', { userId }
            )).c,
            parlor_messages_authored: (await db.get(
                'SELECT COUNT(*) AS c FROM parlor_messages WHERE userId = @userId', { userId }
            )).c,
            user_integrations: (await db.get(
                'SELECT COUNT(*) AS c FROM user_integrations WHERE userId = @userId', { userId }
            )).c,
            mtga_folders: (await db.get(
                'SELECT COUNT(*) AS c FROM mtga_folders WHERE userId = @userId', { userId }
            )).c,
            mtga_decks: (await db.get(
                'SELECT COUNT(*) AS c FROM mtga_decks WHERE userId = @userId', { userId }
            )).c,
            usage_log: (await db.get(
                'SELECT COUNT(*) AS c FROM usage_log WHERE userId = @userId', { userId }
            )).c,
            command_log: (await db.get(
                'SELECT COUNT(*) AS c FROM command_log WHERE userId = @userId', { userId }
            )).c,
            guild_activity: (await db.get(
                'SELECT COUNT(*) AS c FROM guild_activity WHERE userId = @userId', { userId }
            )).c,
            economy_wallets: (await db.get(
                'SELECT COUNT(*) AS c FROM economy_wallets WHERE userId = @userId', { userId }
            )).c,
            economy_transactions: (await db.get(
                'SELECT COUNT(*) AS c FROM economy_transactions WHERE userId = @userId', { userId }
            )).c,
            stock_holdings: (await db.get(
                'SELECT COUNT(*) AS c FROM stock_holdings WHERE userId = @userId', { userId }
            )).c,
            stock_trades: (await db.get(
                'SELECT COUNT(*) AS c FROM stock_trades WHERE userId = @userId', { userId }
            )).c,
            exchange_accounts: (await db.get(
                'SELECT COUNT(*) AS c FROM exchange_accounts WHERE userId = @userId', { userId }
            )).c,
            short_positions: (await db.get(
                'SELECT COUNT(*) AS c FROM short_positions WHERE userId = @userId', { userId }
            )).c,
            option_positions: (await db.get(
                'SELECT COUNT(*) AS c FROM option_positions WHERE userId = @userId', { userId }
            )).c,
            option_trades: (await db.get(
                'SELECT COUNT(*) AS c FROM option_trades WHERE userId = @userId', { userId }
            )).c,
            exchange_orders: (await db.get(
                'SELECT COUNT(*) AS c FROM exchange_orders WHERE userId = @userId', { userId }
            )).c,
            prediction_positions: (await db.get(
                'SELECT COUNT(*) AS c FROM prediction_positions WHERE userId = @userId', { userId }
            )).c,
            exchange_events: (await db.get(
                'SELECT COUNT(*) AS c FROM exchange_events WHERE userId = @userId', { userId }
            )).c,
            perp_positions: (await db.get(
                'SELECT COUNT(*) AS c FROM perp_positions WHERE userId = @userId', { userId }
            )).c,
            exchange_optins: (await db.get(
                'SELECT COUNT(*) AS c FROM exchange_optins WHERE userId = @userId', { userId }
            )).c,
            tavern_characters: (await db.get(
                'SELECT COUNT(*) AS c FROM tavern_characters WHERE userId = @userId', { userId }
            )).c,
            tavern_party_members: (await db.get(
                'SELECT COUNT(*) AS c FROM tavern_party_members WHERE userId = @userId', { userId }
            )).c,
            tavern_adventure_log: (await db.get(
                'SELECT COUNT(*) AS c FROM tavern_adventure_log WHERE userId = @userId', { userId }
            )).c,
            tavern_npc_relationships: (await db.get(
                'SELECT COUNT(*) AS c FROM tavern_npc_relationships WHERE userId = @userId', { userId }
            )).c,
            tavern_rooms: (await db.get(
                'SELECT COUNT(*) AS c FROM tavern_rooms WHERE userId = @userId', { userId }
            )).c,
            observatory_projects: (await db.get(
                'SELECT COUNT(*) AS c FROM observatory_projects WHERE userId = @userId', { userId }
            )).c,
            observatory_jobs: (await db.get(
                'SELECT COUNT(*) AS c FROM observatory_jobs WHERE userId = @userId', { userId }
            )).c,
            observatory_share_links: (await db.get(
                'SELECT COUNT(*) AS c FROM observatory_share_links WHERE userId = @userId', { userId }
            )).c,
            sandbox_requests: (await db.get(
                'SELECT COUNT(*) AS c FROM sandbox_requests WHERE userId = @userId', { userId }
            )).c,
            sandbox_packages_attributed: (await db.get(
                `SELECT COUNT(*) AS c FROM sandbox_packages
                 WHERE requestedBy = @userId OR approvedBy = @userId`, { userId }
            )).c,
            // Not tables: files still on disk keyed by the user
            observatory_workspaces: (await require('./observatoryService').countUserData(userId)).workspaceDirs,
            web_upload_files: require('../utils/webUploads').countUserUploads(userId)
        };

        const total = Object.values(byTable).reduce((sum, c) => sum + c, 0);
        return { total, byTable };
    }
}

module.exports = new PrivacyService();
