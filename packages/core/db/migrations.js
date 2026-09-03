/**
 * Column migrations shared by both database adapters.
 *
 * schema.sql only creates missing tables (CREATE TABLE IF NOT EXISTS), so
 * columns added to existing tables must be listed here and back-filled on
 * open. Each entry is [table, column, columnDdl] where columnDdl is written
 * in SQLite dialect (the Postgres adapter translates it).
 *
 * Both adapters run these (and their constraint migrations) *before*
 * schema.sql, so its CREATE INDEX statements may freely name columns added
 * here; a table that does not exist yet is skipped, since schema.sql is
 * about to create it with the column already in place.
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
    // Per-scope TTS voice: a guild's voice in servers, a user's personal
    // voice under the dm:<userId> scope (Study voice chat / read-aloud)
    ['guild_settings', 'tts_voice_id', 'tts_voice_id TEXT'],
    ['guild_settings', 'tts_voice_name', 'tts_voice_name TEXT'],
    ['guild_settings', 'tts_voice_speed',
        'tts_voice_speed REAL CHECK (tts_voice_speed IS NULL OR (tts_voice_speed >= 0.5 AND tts_voice_speed <= 2.0))'],
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
    // Spitball Expeditions: run ownership as durable state (which process
    // claimed the run), part of the heartbeat lease that orphan detection
    // checks instead of assuming a single runner process.
    ['spitball_expeditions', 'runnerId', 'runnerId TEXT'],
    // Seed+intent research brief and an end-of-run "more cycles?" proposal.
    ['spitball_expeditions', 'researchBriefJson', 'researchBriefJson TEXT'],
    ['spitball_expeditions', 'continuationProposalJson', 'continuationProposalJson TEXT'],
    // Workshop pins: approved applet capability grants (Observatory reads).
    ['web_applets', 'grantsJson', 'grantsJson TEXT'],
];

module.exports = { COLUMN_MIGRATIONS };
