/**
 * Column migrations shared by both database adapters.
 *
 * schema.sql only creates missing tables (CREATE TABLE IF NOT EXISTS), so
 * columns added to existing tables must be listed here and back-filled on
 * open. Each entry is [table, column, columnDdl] where columnDdl is written
 * in SQLite dialect (the Postgres adapter translates it).
 */

const COLUMN_MIGRATIONS = [
    ['guild_settings', 'proactive_mode',
        `proactive_mode TEXT NOT NULL DEFAULT 'DISABLED' CHECK (proactive_mode IN ('ENABLED', 'DISABLED'))`],
    ['guild_settings', 'monologue_mode',
        `monologue_mode TEXT NOT NULL DEFAULT 'DISABLED' CHECK (monologue_mode IN ('ENABLED', 'DISABLED'))`],
    ['guild_settings', 'reply_detection',
        `reply_detection TEXT NOT NULL DEFAULT 'ENABLED' CHECK (reply_detection IN ('ENABLED', 'DISABLED'))`],
    ['guild_settings', 'ai_provider', 'ai_provider TEXT'],
    ['guild_settings', 'ai_model', 'ai_model TEXT'],
    ['guild_settings', 'ai_reasoning_effort', 'ai_reasoning_effort TEXT'],
    ['guild_settings', 'memory_retention_days', 'memory_retention_days INTEGER'],
    // Per-user custom instructions (web portal settings dialog)
    ['UserPreferences', 'custom_instructions', 'custom_instructions TEXT'],
    // Web chat branching: a forked conversation points at its source
    ['web_conversations', 'parentConversationId', 'parentConversationId INTEGER'],
    ['web_conversations', 'branchedFromMessageId', 'branchedFromMessageId INTEGER'],
    ['agent_runs', 'threadId', 'threadId TEXT'],
    ['gba_run_clients', 'statusMessageId', 'statusMessageId TEXT'],
    // Parlor persona replies gained tool-generated attachments
    ['parlor_messages', 'attachments', 'attachments TEXT'],
    // Parlor Live: per-persona ElevenLabs voice (id resolved on save, name
    // snapshotted for display)
    ['parlor_personas', 'voiceId', 'voiceId TEXT'],
    ['parlor_personas', 'voiceName', 'voiceName TEXT'],
    // Multi-user parlors: 'user' rows carry which human member spoke
    ['parlor_messages', 'userId', 'userId TEXT'],
    ['parlor_messages', 'userName', 'userName TEXT'],
    // Invitations snapshot who they were sent to, so the host's roster
    // shows a person instead of a raw snowflake
    ['parlor_invites', 'inviteeName', 'inviteeName TEXT'],
    // Exchange: annualized realized volatility cached per symbol, the input
    // that prices every simulated option chain.
    ['stock_symbols', 'impliedVol', 'impliedVol REAL'],
    ['stock_symbols', 'ivUpdatedAt', 'ivUpdatedAt TEXT'],
    // Exchange: corporate-action sweep bookkeeping (dividends/splits)
    ['stock_symbols', 'corporateCheckedAt', 'corporateCheckedAt TEXT'],
    // Exchange: written (short) options share the option_positions table
    ['option_positions', 'side',
        `side TEXT NOT NULL DEFAULT 'LONG' CHECK (side IN ('LONG', 'SHORT'))`],
    // Exchange: group-event opt-in override and the perp/corporate settings
    ['exchange_settings', 'optInOverride',
        'optInOverride INTEGER NOT NULL DEFAULT 1 CHECK (optInOverride IN (0, 1))'],
    ['exchange_settings', 'futuresEnabled',
        'futuresEnabled INTEGER NOT NULL DEFAULT 0 CHECK (futuresEnabled IN (0, 1))'],
    ['exchange_settings', 'maxPerpLeverage',
        'maxPerpLeverage REAL NOT NULL DEFAULT 10 CHECK (maxPerpLeverage >= 1)'],
    ['exchange_settings', 'fundingRateDaily',
        'fundingRateDaily REAL NOT NULL DEFAULT 0.0003 CHECK (fundingRateDaily >= 0)'],
    ['exchange_settings', 'corporateActionsEnabled',
        'corporateActionsEnabled INTEGER NOT NULL DEFAULT 1 CHECK (corporateActionsEnabled IN (0, 1))'],
    // Recurring follow-ups: interval + human label, delivery bookkeeping
    ['followups', 'recurMinutes',
        'recurMinutes INTEGER CHECK (recurMinutes IS NULL OR recurMinutes > 0)'],
    ['followups', 'recurrence', 'recurrence TEXT'],
    ['followups', 'deliveryCount', 'deliveryCount INTEGER NOT NULL DEFAULT 0'],
    ['followups', 'lastDeliveredAt', 'lastDeliveredAt TEXT'],
    // MTGA deck library: content-hash dedupe key for Player.log re-imports
    ['mtga_decks', 'contentHash', 'contentHash TEXT'],
    // User knowledge graph extensions (documentation/user_knowledge_graph.md)
    ['memory_embeddings', 'distilledAt', 'distilledAt TEXT'],
    ['kg_nodes', 'scopeKey', `scopeKey TEXT NOT NULL DEFAULT ''`],
    ['kg_nodes', 'confidence', 'confidence REAL NOT NULL DEFAULT 0.5'],
    ['kg_nodes', 'source', `source TEXT NOT NULL DEFAULT 'monologue'`],
    ['kg_nodes', 'subjectType', `subjectType TEXT CHECK (subjectType IS NULL OR subjectType IN ('USER', 'GUILD'))`],
    ['kg_nodes', 'subjectId', 'subjectId TEXT'],
    ['kg_edges', 'scopeKey', `scopeKey TEXT NOT NULL DEFAULT ''`],
    ['kg_edges', 'relationKind', `relationKind TEXT CHECK (relationKind IS NULL OR relationKind IN ('causal', 'logical', 'associative', 'temporal', 'social'))`],
];

// Created post-migration (not schema.sql) so it runs after the threadId
// column exists on databases whose agent_runs predates it.
const POST_MIGRATION_STATEMENTS = [
    'CREATE INDEX IF NOT EXISTS idx_agent_runs_thread ON agent_runs(threadId)',
    `CREATE TABLE IF NOT EXISTS kg_artifacts (
        id INTEGER PRIMARY KEY,
        nodeId INTEGER NOT NULL UNIQUE REFERENCES kg_nodes(id) ON DELETE CASCADE,
        guildId TEXT NOT NULL,
        scopeKey TEXT NOT NULL DEFAULT '',
        authorId TEXT NOT NULL,
        originalName TEXT NOT NULL,
        mimeType TEXT,
        artifactKind TEXT NOT NULL DEFAULT 'other'
            CHECK (artifactKind IN ('image', 'pdf', 'markdown', 'code', 'document', 'other')),
        relativePath TEXT NOT NULL,
        sizeBytes INTEGER NOT NULL DEFAULT 0,
        contentHash TEXT,
        extractedText TEXT,
        channelId TEXT,
        messageId TEXT,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX IF NOT EXISTS idx_kg_artifacts_scope ON kg_artifacts(guildId, scopeKey)',
    'CREATE INDEX IF NOT EXISTS idx_kg_artifacts_author ON kg_artifacts(authorId)'
];

module.exports = { COLUMN_MIGRATIONS, POST_MIGRATION_STATEMENTS };
