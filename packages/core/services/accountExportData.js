/** Explicit account export inventory. Never enumerate credentials or arbitrary tables. */
const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');

const PROJECTS = 'SELECT id FROM observatory_projects WHERE userId = @userId';
const PERSONAS = 'SELECT id FROM parlor_personas WHERE ownerId = @userId';
const NODES = `SELECT id FROM kg_nodes WHERE
    (guildId = @scope AND scopeKey = @userScope)
    OR (guildId = @scope AND scopeKey IN (SELECT 'PROJECT:' || id FROM observatory_projects WHERE userId = @userId))
    OR scopeKey IN (SELECT 'PARLOR:' || id FROM parlor_personas WHERE ownerId = @userId)`;
const EXPEDITIONS = 'SELECT id FROM spitball_expeditions WHERE userId = @userId';
const PARLORS = `SELECT id FROM parlor_conversations WHERE ownerId = @userId
    AND (projectId IS NULL OR projectId IN (${PROJECTS}))`;
const MISSIONS = `SELECT id FROM project_missions WHERE projectId IN (${PROJECTS})`;
const ASSETS = `SELECT id FROM project_assets WHERE projectId IN (${PROJECTS})`;
const PRIVATE_CHATS = `SELECT gc.id FROM guild_conversations gc WHERE gc.guildId = @scope`;
const OWNED_SONGS = 'SELECT id FROM studio_songs WHERE ownerId = @userId';
const DM_THREADS = 'SELECT id FROM dm_threads WHERE lowId = @userId OR highId = @userId';

/**
 * [table, where, columns = '*', order = '1, 2']. Credentials never appear:
 * the secret columns of push_subscriptions, user_integrations,
 * screen_vision_clients and mcp_tokens are left out of `columns` (TRANSIENT
 * below is only the second line of defence).
 */
const INVENTORY = [
    ['user_ai_connections', 'userId = @userId', 'userId, completionUrl, enabled, modelsJson, updatedAt'],
    ['principals', 'id = @userId'],
    ['users', 'discordId = @userId'],
    ['account_emails', 'principalId = @userId', 'principalId, address, verifiedAt, createdAt'],
    ['user_settings', 'userId = @userId'], ['user_setting_revisions', 'userId = @userId'], ['UserPreferences', 'userId = @userId'],
    ['guild_settings', 'guildId = @scope'], ['user_nicknames', 'userId = @userId'],
    ['kg_nodes', `id IN (${NODES})`],
    ['kg_edges', `sourceId IN (${NODES}) AND targetId IN (${NODES})`],
    ['kg_node_tags', `nodeId IN (${NODES})`],
    ['kg_tags', `id IN (SELECT tagId FROM kg_node_tags WHERE nodeId IN (${NODES}))`],
    ['kg_provenance', `nodeId IN (${NODES})`], ['kg_artifacts', `nodeId IN (${NODES})`],
    ['kg_node_revisions', `nodeId IN (${NODES})`],
    ['knowledge_transfers', `userId = @userId OR copyNodeId IN (${NODES})`],
    ['memory_embeddings', 'guildId = @scope OR authorId = @userId', 'id, guildId, channelId, authorId, authorName, content, dims, model, createdAt, distilledAt'],
    ['facts', "guildId = @scope OR (subjectType = 'USER' AND subjectId = @userId)"],
    ['web_conversations', 'userId = @userId'],
    ['guild_conversations', 'guildId = @scope'],
    ['conversations', `guildConversationId IN (${PRIVATE_CHATS}) OR (guildConversationId IS NULL AND userId IN (SELECT id FROM users WHERE discordId = @userId))`],
    ['messages', `guildConversationId IN (${PRIVATE_CHATS}) OR (guildConversationId IS NULL AND conversationId IN (SELECT id FROM conversations WHERE guildConversationId IS NULL AND userId IN (SELECT id FROM users WHERE discordId = @userId)))`],
    ['prompts', 'userId IN (SELECT id FROM users WHERE discordId = @userId)'],
    ['parlor_personas', 'ownerId = @userId'], ['parlor_notes', `personaId IN (${PERSONAS})`],
    ['parlor_tags', `personaId IN (${PERSONAS})`],
    ['parlor_note_tags', `noteId IN (SELECT id FROM parlor_notes WHERE personaId IN (${PERSONAS}))`],
    ['parlor_conversations', `id IN (${PARLORS})`], ['parlor_messages', `conversationId IN (${PARLORS})`],
    ['parlor_participants', `conversationId IN (${PARLORS})`],
    ['parlor_members', `conversationId IN (${PARLORS})`],
    ['observatory_projects', 'userId = @userId'], ['project_members', `projectId IN (${PROJECTS})`],
    ['project_assets', `projectId IN (${PROJECTS})`], ['project_asset_versions', `assetId IN (${ASSETS})`],
    ['observatory_jobs', `projectId IN (${PROJECTS})`], ['project_triggers', `projectId IN (${PROJECTS})`],
    ['project_missions', `id IN (${MISSIONS})`],
    ...['project_mission_steps', 'project_mission_evidence', 'project_mission_events'].map(t => [t, `missionId IN (${MISSIONS})`]),
    ['project_decisions', `projectId IN (${PROJECTS})`],
    ['spitball_expeditions', 'userId = @userId'], ['spitball_expedition_cycles', `expeditionId IN (${EXPEDITIONS})`],
    ['research_sources', `userId = @userId AND expeditionId IN (${EXPEDITIONS})`],
    ['research_claims', `sourceId IN (SELECT id FROM research_sources WHERE userId = @userId) AND expeditionId IN (${EXPEDITIONS})`],
    ['expedition_briefs', 'userId = @userId'],
    ['followed_sources', 'userId = @userId'],
    ['followed_source_entries', 'sourceId IN (SELECT id FROM followed_sources WHERE userId = @userId)'],
    ...['followups', 'automations', 'attention_items', 'attention_notices', 'attention_feedback', 'attention_watches',
        'attention_policies', 'inbox_items', 'web_applets'].map(t => [t, 'userId = @userId']),
    ...['tutorial_progress', 'tutorial_preferences', 'tutorial_feedback'].map(t => [t, 'accountId = @userId']),
    ['attention_provenance', 'itemId IN (SELECT id FROM attention_items WHERE userId = @userId)'],
    // The secret hash stays out of the archive. The label and prefix are
    // enough to see which clients were connected (documentation/mcp.md).
    ['mcp_tokens', 'userId = @userId', 'id, userId, label, tokenPrefix, scope, createdAt, lastUsedAt, revokedAt, expiresAt'],

    // Optional-feature stores (#322). Disabling a feature never hides its
    // rows from the person who owns them, so these are exported whatever
    // `data/features.json` says.
    ['economy_wallets', 'userId = @userId', '*', 'guildId'],
    ['economy_transactions', 'userId = @userId', '*', 'id'],
    ['stock_holdings', 'userId = @userId', '*', 'guildId, symbol'],
    ['stock_trades', 'userId = @userId', '*', 'id'],
    ['exchange_accounts', 'userId = @userId', '*', 'guildId'],
    ['short_positions', 'userId = @userId', '*', 'guildId, symbol'],
    ['option_positions', 'userId = @userId', '*', 'id'],
    ['option_trades', 'userId = @userId', '*', 'id'],
    ['exchange_orders', 'userId = @userId', '*', 'id'],
    ['prediction_positions', 'userId = @userId', '*', 'id'],
    ['exchange_events', 'userId = @userId', '*', 'id'],
    ['perp_positions', 'userId = @userId', '*', 'id'],
    ['exchange_optins', 'userId = @userId', '*', 'guildId'],
    ['tavern_characters', 'userId = @userId'],
    ['tavern_party_members', 'userId = @userId', '*', 'adventureId'],
    ['tavern_npc_relationships', 'userId = @userId', '*', 'guildId, npcKey'],
    ['tavern_rooms', 'userId = @userId', '*', 'guildId'],
    ['tavern_adventure_log', 'userId = @userId', '*', 'id'],
    ['studio_songs', 'ownerId = @userId', '*', 'id'],
    ['studio_song_members', `userId = @userId OR songId IN (${OWNED_SONGS})`, '*', 'songId, userId'],
    ['push_subscriptions', 'userId = @userId', 'id, userId, userAgent, createdAt, lastSeenAt, lastSentAt, failCount', 'id'],
    ['friendships', 'lowId = @userId OR highId = @userId', '*', 'id'],
    ['dm_threads', 'lowId = @userId OR highId = @userId', '*', 'id'],
    ['dm_participants', `threadId IN (${DM_THREADS})`, '*', 'threadId, userId'],
    ['dm_messages', `threadId IN (${DM_THREADS})`, '*', 'id'],
    ['user_integrations', 'userId = @userId', 'userId, provider, accountLabel, createdAt, updatedAt, lastUsedAt', 'provider'],
    ['sandbox_requests', 'userId = @userId', 'id, type, userId, payload, status, createdAt, resolvedAt, resolvedBy, error, resultJson', 'id'],
    ['sandbox_packages', 'requestedBy = @userId', 'id, pip, module, version, requirement, requestedBy, approvedBy, installedAt', 'id'],
    ['agent_runs', 'userId = @userId', '*', 'id'],
    ['pending_integration_actions', 'requestedBy = @userId', 'id, type, guildId, channelId, requestedBy, payload, status, createdAt, resolvedAt, resolvedBy, resultJson', 'id'],
    ['integration_audit', 'userId = @userId', '*', 'id'],
    ['repo_watches', 'createdBy = @userId', '*', 'id'],
    ['screen_vision_clients', 'userId = @userId', 'userId, label, createdAt, lastConnectedAt', 'userId']
];
const TRANSIENT = new Set(['claimToken', 'leaseToken', 'runnerId', 'executionAttemptId', 'claimUntil', 'tokenHash']);
function cleanRow(table, row, userId) {
    const result = Object.fromEntries(Object.entries(row).filter(([key]) => !TRANSIENT.has(key)));
    if (table === 'knowledge_transfers' && row.userId !== userId) {
        // The publisher is public; the original private note and its audience are not.
        return { id: row.id, userId: row.userId, targetKind: row.targetKind, targetId: row.targetId,
            copyNodeId: row.copyNodeId, mode: row.mode, createdAt: row.createdAt };
    }
    return result;
}
async function snapshot(userId, { maxRows = 100000, maxTextBytes = 64 * 1024 * 1024 } = {}) {
    const params = { userId, scope: dmScopeId(userId), userScope: `USER:${userId}` };
    return db.transaction(async () => {
        if (db.engine === 'postgres') await db.run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const data = {};
        let rows = 0, bytes = 0;
        for (const [table, where, columns = '*', fixedOrder] of INVENTORY) {
            data[table] = [];
            for (let offset = 0; ; offset += 250) {
                const order = fixedOrder || (table === 'tutorial_progress' ? 'accountId, tutorialId, version' : '1, 2');
                const page = await db.all(`SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 250 OFFSET @offset`, { ...params, offset });
                for (const row of page) {
                    const clean = cleanRow(table, row, userId);
                    bytes += Buffer.byteLength(JSON.stringify(clean));
                    if (++rows > maxRows || bytes > maxTextBytes) { const e = new Error('Export exceeds the record limit.'); e.code = 'EXPORT_LIMIT'; throw e; }
                    data[table].push(clean);
                }
                if (page.length < 250) break;
            }
        }
        return data;
    });
}
module.exports = { snapshot, INVENTORY };
