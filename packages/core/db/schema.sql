-- Goobster SQLite schema (Raspberry Pi edition)
--
-- Rewritten natively for SQLite from the original Azure SQL (T-SQL) database
-- project. Conventions:
--   * INTEGER PRIMARY KEY columns auto-increment (rowid alias).
--   * Timestamps are stored as TEXT in UTC ('YYYY-MM-DD HH:MM:SS'),
--     produced by CURRENT_TIMESTAMP / datetime('now').
--   * Booleans are INTEGER 0/1.
--   * JSON payloads are stored as TEXT.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Core chat tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    discordUsername TEXT NOT NULL,
    discordId TEXT NOT NULL UNIQUE,
    joinedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activeConversationId INTEGER REFERENCES conversations(id),
    username TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discordUsername, discordId);

CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY,
    userId INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    label TEXT,
    isDefault INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prompts_userId ON prompts(userId);

CREATE TABLE IF NOT EXISTS guild_conversations (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    threadId TEXT NOT NULL,
    promptId INTEGER REFERENCES prompts(id),
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    channelId TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guild_conversations_channel ON guild_conversations(channelId);
CREATE INDEX IF NOT EXISTS idx_guild_thread ON guild_conversations(guildId, threadId);

CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY,
    userId INTEGER NOT NULL,
    promptId INTEGER REFERENCES prompts(id),
    guildConversationId INTEGER REFERENCES guild_conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_guild ON conversations(guildConversationId);
CREATE INDEX IF NOT EXISTS idx_conversations_userId ON conversations(userId);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversationId INTEGER NOT NULL REFERENCES conversations(id),
    message TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    guildConversationId INTEGER REFERENCES guild_conversations(id),
    isBot INTEGER NOT NULL DEFAULT 0,
    createdBy INTEGER NOT NULL REFERENCES users(id),
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_created_by ON messages(createdBy);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversationId, createdAt);
CREATE INDEX IF NOT EXISTS idx_messages_guild_conversation ON messages(guildConversationId, createdAt);

CREATE TABLE IF NOT EXISTS conversation_summaries (
    id INTEGER PRIMARY KEY,
    guildConversationId INTEGER NOT NULL REFERENCES guild_conversations(id),
    summary TEXT NOT NULL,
    messageCount INTEGER NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_guild_conv_created ON conversation_summaries(guildConversationId, createdAt);

-- ---------------------------------------------------------------------------
-- Settings and preferences
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS guild_settings (
    guildId TEXT PRIMARY KEY,
    thread_preference TEXT NOT NULL DEFAULT 'ALWAYS_CHANNEL'
        CHECK (thread_preference IN ('ALWAYS_THREAD', 'ALWAYS_CHANNEL')),
    search_approval TEXT NOT NULL DEFAULT 'REQUIRED'
        CHECK (search_approval IN ('REQUIRED', 'NOT_REQUIRED')),
    personality_directive TEXT,
    dynamic_response TEXT NOT NULL DEFAULT 'DISABLED'
        CHECK (dynamic_response IN ('ENABLED', 'DISABLED')),
    -- Answer a mention-free message when it replies to Goobster's own last message
    reply_detection TEXT NOT NULL DEFAULT 'ENABLED'
        CHECK (reply_detection IN ('ENABLED', 'DISABLED')),
    bot_nickname TEXT,
    proactive_mode TEXT NOT NULL DEFAULT 'DISABLED'
        CHECK (proactive_mode IN ('ENABLED', 'DISABLED')),
    monologue_mode TEXT NOT NULL DEFAULT 'DISABLED'
        CHECK (monologue_mode IN ('ENABLED', 'DISABLED')),
    ai_provider TEXT,
    ai_model TEXT,
    ai_reasoning_effort TEXT,
    -- NULL = keep long-term memories forever; N = purge raw memories older than N days
    memory_retention_days INTEGER,
    -- Per-scope ElevenLabs TTS voice: a guild's voice in servers, a user's
    -- personal voice under their dm:<userId> scope (web voice chat).
    -- NULL = the globally configured default voice.
    tts_voice_id TEXT,
    tts_voice_name TEXT,
    -- Speech playback speed multiplier (client-side), NULL = 1.0
    tts_voice_speed REAL CHECK (tts_voice_speed IS NULL OR (tts_voice_speed >= 0.5 AND tts_voice_speed <= 2.0)),
    -- Portal TTS accent id (utils/ttsAccent.js). NULL = no audio tag.
    tts_accent TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_nicknames (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    guildId TEXT NOT NULL,
    nickname TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (userId, guildId)
);

CREATE INDEX IF NOT EXISTS idx_user_nicknames_user_guild ON user_nicknames(userId, guildId);

-- userId is the Discord snowflake (stored as TEXT to avoid 53-bit JS precision loss)
CREATE TABLE IF NOT EXISTS UserPreferences (
    userId TEXT PRIMARY KEY,
    memeMode INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
    personality_preset TEXT DEFAULT 'helper',
    personality_settings TEXT,
    -- Per-user custom instructions (the ChatGPT-style "how should I respond"
    -- text), set from the web portal's settings dialog and applied to every
    -- chat surface. Deleted by /forget-me with the rest of the row.
    custom_instructions TEXT
);

-- ---------------------------------------------------------------------------
-- Automations (scheduled prompts)
-- ---------------------------------------------------------------------------

-- userId is the Discord snowflake (stored as TEXT to avoid 53-bit JS precision loss)
CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    name TEXT NOT NULL,
    promptText TEXT NOT NULL,
    schedule TEXT NOT NULL CHECK (length(schedule) > 0 AND length(schedule) <= 100),
    isEnabled INTEGER NOT NULL DEFAULT 1,
    lastRun TEXT,
    nextRun TEXT,
    metadata TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_automations_guild ON automations(guildId);
CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(userId);
CREATE INDEX IF NOT EXISTS idx_automations_next_run ON automations(nextRun);

-- Channels the bot must not remember (privacy scope control, managed via /privacy)
CREATE TABLE IF NOT EXISTS memory_channel_exclusions (
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, channelId)
);

-- ---------------------------------------------------------------------------
-- Long-term semantic memory (embeddings for cosine-similarity recall)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_embeddings (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    -- Set when consolidation has distilled this row into kg_nodes (provenance)
    distilledAt TEXT,
    channelId TEXT,
    authorId TEXT,
    authorName TEXT,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    dims INTEGER NOT NULL,
    model TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memory_guild_time ON memory_embeddings(guildId, createdAt);
CREATE INDEX IF NOT EXISTS idx_memory_guild_model ON memory_embeddings(guildId, model);

-- ---------------------------------------------------------------------------
-- Distilled facts (curated knowledge about users and servers)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    subjectType TEXT NOT NULL CHECK (subjectType IN ('USER', 'GUILD')),
    subjectId TEXT,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('model', 'consolidation', 'user')),
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(guildId, subjectType, subjectId);

-- ---------------------------------------------------------------------------
-- Self-scheduled follow-ups (created by the model or heartbeat).
-- One-shot rows (recurMinutes NULL) go PENDING -> DONE on delivery.
-- Recurring rows (recurMinutes set) stay PENDING: each delivery advances
-- dueAt by the interval (skipping missed occurrences after downtime) and
-- bumps deliveryCount; only cancellation ends the series.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY,
    -- Server-authored job-completion reminders preserve their source (#273).
    jobId INTEGER,
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    userId TEXT,
    note TEXT NOT NULL,
    dueAt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'CANCELLED')),
    recurMinutes INTEGER CHECK (recurMinutes IS NULL OR recurMinutes > 0),
    recurrence TEXT,
    deliveryCount INTEGER NOT NULL DEFAULT 0,
    lastDeliveredAt TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(status, dueAt);

-- ---------------------------------------------------------------------------
-- Pending web-search approval requests. Persisted so approve/deny buttons
-- keep working across a bot restart. Rows expire (15 minutes) via cleanup on
-- read/write; there is no background timer.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pending_search_requests (
    requestId TEXT PRIMARY KEY,
    guildId TEXT,
    channelId TEXT NOT NULL,
    query TEXT NOT NULL,
    reason TEXT,
    requireApproval INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Deduplication of in-flight searches per channel (5-minute window),
-- persisted so a restart cannot double-fire the same search prompt.
CREATE TABLE IF NOT EXISTS pending_searches (
    channelId TEXT NOT NULL,
    query TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channelId, query)
);

-- ---------------------------------------------------------------------------
-- Heartbeat state (proactive mode): survives restarts so the action cooldown
-- and per-guild mood are not reset every time the process bounces.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS heartbeat_state (
    guildId TEXT PRIMARY KEY,
    mood TEXT,
    -- Epoch milliseconds of the last proactive action (cooldown anchor)
    lastActionAt INTEGER,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Internal monologue (per-guild private thought process, opt-in via
-- /monologue). Thoughts are a journal of introspection ticks; the scratchpad
-- holds short working notes the persona curates for itself.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monologue_thoughts (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    thought TEXT NOT NULL,
    -- Channel that was observed during the tick, if any
    channelId TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_monologue_thoughts_guild_time ON monologue_thoughts(guildId, createdAt);

CREATE TABLE IF NOT EXISTS monologue_scratchpad (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_monologue_scratchpad_guild ON monologue_scratchpad(guildId, updatedAt);

-- ---------------------------------------------------------------------------
-- Knowledge graph (user + guild semantic network). Spec:
-- documentation/user_knowledge_graph.md
-- Nodes are distilled notes; edges are typed relationships; tags cluster
-- concepts; provenance links back to raw memories and legacy facts.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kg_nodes (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    -- '' = guild-wide monologue; 'GUILD' = server distilled; 'USER:<id>' = personal;
    -- 'PARLOR:<personaId>' = one Parlor persona workspace (same graph logic)
    scopeKey TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'concept'
        CHECK (type IN ('concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing', 'artifact')),
    label TEXT NOT NULL COLLATE NOCASE,
    content TEXT,
    salience REAL NOT NULL DEFAULT 0.5,
    confidence REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL DEFAULT 'monologue'
        CHECK (source IN ('monologue', 'consolidation', 'tool', 'migration', 'user', 'research', 'conversation')),
    -- Curation is the person's intent, independent of `source` (who wrote
    -- it): 'saved' = kept deliberately as reusable knowledge, 'memory' =
    -- distilled by Goobster (managed from Personal memory), 'unclassified' =
    -- legacy / undeclared. ADR 0008, documentation/knowledge_and_memory.md.
    curation TEXT NOT NULL DEFAULT 'unclassified'
        CHECK (curation IN ('saved', 'memory', 'unclassified')),
    subjectType TEXT CHECK (subjectType IS NULL OR subjectType IN ('USER', 'GUILD')),
    subjectId TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, scopeKey, label)
);

CREATE INDEX IF NOT EXISTS idx_kg_nodes_guild_salience ON kg_nodes(guildId, scopeKey, salience);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_scope_curation ON kg_nodes(guildId, scopeKey, curation);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_scope ON kg_nodes(guildId, scopeKey);

CREATE TABLE IF NOT EXISTS kg_edges (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT '',
    sourceId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    targetId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL COLLATE NOCASE,
    relationKind TEXT CHECK (relationKind IS NULL OR relationKind IN ('causal', 'logical', 'associative', 'temporal', 'social')),
    weight REAL NOT NULL DEFAULT 0.5,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, sourceId, targetId, relation)
);

CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(sourceId);
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(targetId);
CREATE INDEX IF NOT EXISTS idx_kg_edges_scope ON kg_edges(guildId, scopeKey);

CREATE TABLE IF NOT EXISTS kg_tags (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL COLLATE NOCASE,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, scopeKey, name)
);

CREATE TABLE IF NOT EXISTS kg_node_tags (
    nodeId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    tagId INTEGER NOT NULL REFERENCES kg_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (nodeId, tagId)
);

CREATE TABLE IF NOT EXISTS kg_provenance (
    id INTEGER PRIMARY KEY,
    nodeId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    sourceKind TEXT NOT NULL CHECK (sourceKind IN ('memory', 'fact', 'consolidation', 'monologue', 'tool', 'user', 'artifact', 'research_claim', 'research_source', 'expedition', 'parlor_conversation')),
    sourceId INTEGER,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (nodeId, sourceKind, sourceId)
);

CREATE INDEX IF NOT EXISTS idx_kg_provenance_source ON kg_provenance(sourceKind, sourceId);

-- Per-node embeddings for workspace search (Parlor retrieval today;
-- available to any kg scope). Cascades with the node.
CREATE TABLE IF NOT EXISTS kg_node_embeddings (
    nodeId INTEGER PRIMARY KEY REFERENCES kg_nodes(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL,
    dims INTEGER NOT NULL,
    model TEXT NOT NULL,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kg_artifacts (
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
    -- Origin of a file found on the web (sourceUrl, pageUrl, credit,
    -- license, provider) - JSON, NULL for user uploads.
    metadataJson TEXT,
    channelId TEXT,
    messageId TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_kg_artifacts_scope ON kg_artifacts(guildId, scopeKey);
CREATE INDEX IF NOT EXISTS idx_kg_artifacts_author ON kg_artifacts(authorId);

-- Reflection runs: one row per knowledge-enrichment run over a graph scope
-- (manual button press or the scheduled routine). Restart-safe run state so
-- the web app can poll progress across processes; stale 'running' rows are
-- failed lazily. Spec: documentation/user_knowledge_graph.md
CREATE TABLE IF NOT EXISTS kg_reflection_runs (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT '',
    runTrigger TEXT NOT NULL DEFAULT 'manual' CHECK (runTrigger IN ('manual', 'scheduled')),
    requestedBy TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    -- JSON array of pass names, e.g. ["distill","weave","tidy"]
    passes TEXT NOT NULL,
    -- JSON object keyed by pass name with applied counts
    summary TEXT,
    error TEXT,
    startedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finishedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_kg_reflection_scope ON kg_reflection_runs(guildId, scopeKey, startedAt);

-- Note revision history (documentation/spitball_expeditions.md §27): a
-- bounded per-node trail of state snapshots, written whenever a node is
-- created or materially changed. Matters most now that autonomous research
-- can update existing notes - a human_edit revision is the record of the
-- user's preferred representation, and revert becomes possible later without
-- a schema rewrite. Rows cascade with the node (privacy rides kg_nodes).
CREATE TABLE IF NOT EXISTS kg_node_revisions (
    id INTEGER PRIMARY KEY,
    nodeId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    revisionNumber INTEGER NOT NULL,
    label TEXT NOT NULL,
    type TEXT,
    content TEXT,
    salience REAL,
    confidence REAL,
    source TEXT,
    changeKind TEXT NOT NULL DEFAULT 'update'
        CHECK (changeKind IN ('created', 'update', 'human_edit', 'research_expand', 'research_correct', 'reflection_merge', 'conflict_resolution')),
    -- The writer kind that caused the change (a node source value); user ids
    -- never land here - ownership is derivable from the node's scopeKey
    changedBy TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (nodeId, revisionNumber)
);

CREATE INDEX IF NOT EXISTS idx_kg_node_revisions_node ON kg_node_revisions(nodeId, revisionNumber);

-- Explicit transfers (ADR 0010, documentation/knowledge_and_memory.md): a
-- person's deliberate move of knowledge - an assistant answer saved as a
-- note, a note referenced from their private project, a note published
-- (copied) into a shared project or discussion. One row per move: who,
-- from what, to where, how, and who could read the destination then.
-- kg_provenance is untouched: it records evidence automated writers attach
-- to a node, not a person's transfer with an audience.
CREATE TABLE IF NOT EXISTS knowledge_transfers (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    sourceKind TEXT NOT NULL CHECK (sourceKind IN ('chat_message', 'note')),
    -- chat_message: the web conversation and the assistant reply it came from
    sourceConversationId INTEGER,
    sourceMessageId INTEGER,
    -- note: the original personal node. Survives its deletion (SET NULL) so
    -- a published copy can still say it was copied from a note now gone.
    sourceNodeId INTEGER REFERENCES kg_nodes(id) ON DELETE SET NULL,
    sourceLabel TEXT,
    targetKind TEXT NOT NULL CHECK (targetKind IN ('note', 'project', 'discussion')),
    -- kg_nodes.id / observatory_projects.id / parlor_conversations.id (no FK:
    -- listings join the target so a deleted destination disappears)
    targetId INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('reference', 'copy')),
    -- The node created in the destination scope (the note itself for a
    -- saved answer), or the transcript message a discussion copy became
    copyNodeId INTEGER REFERENCES kg_nodes(id) ON DELETE SET NULL,
    copyMessageId INTEGER,
    -- Retry receipt: preserve the request's source identity after note deletion.
    requestId TEXT,
    requestSourceNodeId INTEGER,
    -- JSON { kind, ownerId, memberIds, shared } - who could read the
    -- destination when the transfer happened
    audienceJson TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_knowledge_transfers_user ON knowledge_transfers(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_knowledge_transfers_source ON knowledge_transfers(sourceNodeId);
CREATE INDEX IF NOT EXISTS idx_knowledge_transfers_target ON knowledge_transfers(targetKind, targetId);
CREATE INDEX IF NOT EXISTS idx_knowledge_transfers_copy ON knowledge_transfers(copyNodeId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_transfers_request ON knowledge_transfers(userId, requestId);

-- ---------------------------------------------------------------------------
-- Server activity counters (counts only, no message content). Feeds the
-- /wrapped stats. userId becomes NULL when a user runs /forget-me
-- (anonymized, counts kept so server totals stay accurate).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS guild_activity (
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    userId TEXT,
    -- 'YYYY-MM-DD' UTC
    day TEXT NOT NULL,
    messageCount INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guildId, channelId, userId, day)
);

CREATE INDEX IF NOT EXISTS idx_guild_activity_guild_day ON guild_activity(guildId, day);

-- ---------------------------------------------------------------------------
-- Command usage counters (baseline metrics, e.g. /recall WAU)
-- ---------------------------------------------------------------------------

-- userId/guildId are Discord snowflakes (TEXT). One row per command invocation.
CREATE TABLE IF NOT EXISTS command_log (
    id INTEGER PRIMARY KEY,
    guildId TEXT,
    userId TEXT,
    command TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_command_log_command_time ON command_log(command, createdAt);
CREATE INDEX IF NOT EXISTS idx_command_log_guild_time ON command_log(guildId, createdAt);

-- ---------------------------------------------------------------------------
-- AI usage tracking (token counts per call)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY,
    guildId TEXT,
    userId TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    operation TEXT NOT NULL,
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    -- Cache counters are subsets of inputTokens (total prompt tokens).
    cacheReadTokens INTEGER NOT NULL DEFAULT 0,
    cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
    count INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_usage_guild_time ON usage_log(guildId, createdAt);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_log(createdAt);

-- ---------------------------------------------------------------------------
-- Economy: a per-guild point currency (name configurable, e.g. "Jimmy points")
-- powering the gambling games and the stock trading game. Balances are
-- INTEGER points (1 point = $1 in the stock game) and can never go negative.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS economy_settings (
    guildId TEXT PRIMARY KEY,
    currencyName TEXT NOT NULL DEFAULT 'points',
    startingBalance INTEGER NOT NULL DEFAULT 1000 CHECK (startingBalance >= 0),
    dailyAmount INTEGER NOT NULL DEFAULT 100 CHECK (dailyAmount >= 0),
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- userId is the Discord snowflake (TEXT, exceeds JS safe-integer range)
CREATE TABLE IF NOT EXISTS economy_wallets (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    lastDailyAt TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, userId)
);

CREATE INDEX IF NOT EXISTS idx_economy_wallets_guild_balance ON economy_wallets(guildId, balance);

-- Full ledger: one row per balance change (signed amount + resulting balance)
CREATE TABLE IF NOT EXISTS economy_transactions (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balanceAfter INTEGER NOT NULL,
    type TEXT NOT NULL,
    detail TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_economy_tx_user_time ON economy_transactions(guildId, userId, createdAt);

-- ---------------------------------------------------------------------------
-- Stock trading game: symbol metadata discovered via lookups (the "symbol
-- indicator database"), price snapshots for history/graphs, per-user holdings,
-- and the trade log (what was bought, when, and at what price).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_symbols (
    symbol TEXT PRIMARY KEY,
    name TEXT,
    exchange TEXT,
    currency TEXT,
    quoteType TEXT,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Snapshot rows recorded whenever a fresh quote is fetched; the recent window
-- doubles as a short-TTL quote cache and feeds the historical graphs.
CREATE TABLE IF NOT EXISTS stock_prices (
    id INTEGER PRIMARY KEY,
    symbol TEXT NOT NULL,
    price REAL NOT NULL CHECK (price > 0),
    asOf TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT NOT NULL DEFAULT 'yahoo'
);

CREATE INDEX IF NOT EXISTS idx_stock_prices_symbol_time ON stock_prices(symbol, asOf);

CREATE TABLE IF NOT EXISTS stock_holdings (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    symbol TEXT NOT NULL,
    units REAL NOT NULL CHECK (units > 0),
    -- Total points spent on the currently-held units (average cost basis)
    costBasis INTEGER NOT NULL DEFAULT 0 CHECK (costBasis >= 0),
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, userId, symbol)
);

CREATE TABLE IF NOT EXISTS stock_trades (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    units REAL NOT NULL CHECK (units > 0),
    -- Dollar price per unit at trade time (1 point = $1)
    price REAL NOT NULL CHECK (price > 0),
    -- Points moved: cost on BUY (positive), proceeds on SELL (positive)
    points INTEGER NOT NULL CHECK (points >= 0),
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_trades_user_time ON stock_trades(guildId, userId, createdAt);

-- ---------------------------------------------------------------------------
-- Live table-game journal (Activity multiplayer tables). One row per live
-- table, rewritten on every state change. Rows are transient: deleted when
-- the table closes. After a crash/restart, recovery refunds any bets that
-- were escrowed in an unfinished hand and clears the row.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS table_games (
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    gameType TEXT NOT NULL,
    -- Full serialized engine state (JSON)
    state TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, channelId)
);

-- ---------------------------------------------------------------------------
-- System logs (used by chat diagnostics)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY,
    log_level TEXT NOT NULL CHECK (log_level IN ('ERROR', 'WARN', 'INFO', 'DEBUG')),
    message TEXT NOT NULL,
    metadata TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source TEXT,
    error_code TEXT,
    error_state TEXT
);

CREATE INDEX IF NOT EXISTS idx_system_logs_createdAt ON system_logs(createdAt);
CREATE INDEX IF NOT EXISTS idx_system_logs_level_date ON system_logs(log_level, createdAt);

-- ---------------------------------------------------------------------------
-- Developer integrations: GitHub repo watches, tracked Cursor cloud-agent
-- runs, and the integration audit ledger (who triggered what).
-- ---------------------------------------------------------------------------

-- One watch per guild+repo: which channel gets events and which event keys
-- are subscribed (JSON array: push, pull_request, issues, release, ci).
-- Watched repos double as the per-guild allowlist for the GitHub chat tools.
CREATE TABLE IF NOT EXISTS repo_watches (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    repo TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    createdBy TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, repo)
);

CREATE INDEX IF NOT EXISTS idx_repo_watches_repo ON repo_watches(repo);

-- Cursor cloud-agent runs launched from Discord. One row per agent (runId is
-- the latest run); polled until status is terminal. threadId is the agent's
-- mission-control thread: updates post there and human replies become
-- follow-up runs.
CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY,
    agentId TEXT NOT NULL UNIQUE,
    runId TEXT NOT NULL,
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    threadId TEXT,
    userId TEXT,
    repo TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    prUrl TEXT,
    branch TEXT,
    summary TEXT,
    agentUrl TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_guild ON agent_runs(guildId, id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread ON agent_runs(threadId);

-- Audit ledger for externally visible integration actions.
CREATE TABLE IF NOT EXISTS integration_audit (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    userId TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_integration_audit_guild ON integration_audit(guildId, id);

-- ---------------------------------------------------------------------------
-- The Goobster Tavern + Adventure Mode ("Tavern Alpha").
-- Structured game state lives in deterministic records; prose (scene text,
-- recaps) lives in the adventure log. Never mix the two.
-- ---------------------------------------------------------------------------

-- One character per user per guild: the four-stat sheet (Might/Finesse/Wits/
-- Heart, +0..+3), a Calling (archetype), a complication, Spark (narrative
-- currency), health, inventory (JSON array of item names), and advancement.
CREATE TABLE IF NOT EXISTS tavern_characters (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    pronouns TEXT,
    origin TEXT NOT NULL,
    calling TEXT NOT NULL,
    might INTEGER NOT NULL DEFAULT 0 CHECK (might BETWEEN 0 AND 3),
    finesse INTEGER NOT NULL DEFAULT 0 CHECK (finesse BETWEEN 0 AND 3),
    wits INTEGER NOT NULL DEFAULT 0 CHECK (wits BETWEEN 0 AND 3),
    heart INTEGER NOT NULL DEFAULT 0 CHECK (heart BETWEEN 0 AND 3),
    complication TEXT NOT NULL,
    health INTEGER NOT NULL DEFAULT 10 CHECK (health >= 0),
    maxHealth INTEGER NOT NULL DEFAULT 10 CHECK (maxHealth > 0),
    spark INTEGER NOT NULL DEFAULT 1 CHECK (spark >= 0),
    inventory TEXT NOT NULL DEFAULT '[]',
    milestones INTEGER NOT NULL DEFAULT 0 CHECK (milestones >= 0),
    advancesSpent INTEGER NOT NULL DEFAULT 0 CHECK (advancesSpent >= 0),
    adventuresCompleted INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, userId)
);

CREATE INDEX IF NOT EXISTS idx_tavern_characters_guild ON tavern_characters(guildId);

-- One adventure per guild channel at a time (enforced in code, like
-- table_games). `state` is deterministic JSON: clocks, flags, used options,
-- spotlight order, big-move usage, and the last check (for Spark rerolls).
CREATE TABLE IF NOT EXISTS tavern_adventures (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    questId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'RECRUITING'
        CHECK (status IN ('RECRUITING', 'ACTIVE', 'COMPLETED', 'ABANDONED')),
    sceneId TEXT,
    state TEXT NOT NULL DEFAULT '{}',
    endingId TEXT,
    createdBy TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_tavern_adventures_guild ON tavern_adventures(guildId, status);
CREATE INDEX IF NOT EXISTS idx_tavern_adventures_channel ON tavern_adventures(channelId, status);

CREATE TABLE IF NOT EXISTS tavern_party_members (
    adventureId INTEGER NOT NULL REFERENCES tavern_adventures(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    characterId INTEGER NOT NULL REFERENCES tavern_characters(id) ON DELETE CASCADE,
    joinedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (adventureId, userId)
);

-- The story record: scene beats, player actions, check results (structured
-- detail JSON alongside the prose), events, and the final recap.
CREATE TABLE IF NOT EXISTS tavern_adventure_log (
    id INTEGER PRIMARY KEY,
    adventureId INTEGER NOT NULL REFERENCES tavern_adventures(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('SCENE', 'ACTION', 'CHECK', 'EVENT', 'RECAP')),
    userId TEXT,
    content TEXT NOT NULL,
    detail TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tavern_log_adventure ON tavern_adventure_log(adventureId, id);

-- Phase 2: the world remembers.

-- Per-member standing with each resident NPC (evolves through adventures via
-- the `npc` effect in campaign YAML). Score is clamped in code (-5..+5).
CREATE TABLE IF NOT EXISTS tavern_npc_relationships (
    guildId TEXT NOT NULL,
    npcKey TEXT NOT NULL,
    userId TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, npcKey, userId)
);

-- Guest Rooms: a member's personal space above the Tavern (description is
-- theirs; trophies render from their character's inventory).
CREATE TABLE IF NOT EXISTS tavern_rooms (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    description TEXT NOT NULL,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, userId)
);

-- The shared world record: lore entries (locations, factions, events,
-- artifacts, characters) written by adventure endings (`world:` in
-- endings.yaml). One entry per guild+kind+name; retellings update content.
CREATE TABLE IF NOT EXISTS tavern_lore (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('location', 'faction', 'event', 'artifact', 'character')),
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    sourceQuestId TEXT,
    sourceAdventureId INTEGER,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, kind, name)
);

CREATE INDEX IF NOT EXISTS idx_tavern_lore_guild ON tavern_lore(guildId, kind, name);

-- Confirmable integration actions (agent launches / issue creation proposed
-- from chat or voice). Rows persist so a pending confirmation survives a
-- restart; buttons resolve them.
CREATE TABLE IF NOT EXISTS pending_integration_actions (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('agent-launch', 'github-issue')),
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    requestedBy TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'EXECUTING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolvedAt TEXT,
    resolvedBy TEXT,
    -- Durable receipt after PENDING → EXECUTING → terminal (approval CAS).
    resultJson TEXT,
    -- Attempt id minted on claim; claimedAt is the recovery clock.
    attemptId TEXT,
    claimedAt TEXT
);

-- Operator-approved sandbox requests: package installs into the toolkit
-- overlay and data fetches into Observatory workspaces. The model only ever
-- proposes; a configured approver resolves via DM buttons. Rows persist so a
-- pending request survives a restart, and resolved rows are the audit trail.
CREATE TABLE IF NOT EXISTS sandbox_requests (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('package-install', 'data-fetch')),
    userId TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'EXECUTING', 'DENIED', 'EXPIRED', 'COMPLETED', 'FAILED')),
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolvedAt TEXT,
    resolvedBy TEXT,
    error TEXT,
    -- Durable receipt after PENDING → EXECUTING → terminal (approval CAS).
    resultJson TEXT,
    attemptId TEXT,
    claimedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_sandbox_requests_user ON sandbox_requests(userId, id);
CREATE INDEX IF NOT EXISTS idx_sandbox_requests_status ON sandbox_requests(status, id);

-- The sandbox package overlay inventory: every distribution installed into
-- data/sandbox/overlay by an approved package-install request, including
-- transitive dependencies. `requirement` keeps the exact hash-pinned pip
-- line so `npm run sandbox-python` can rebuild the overlay byte-for-byte;
-- `module` is the import name probed/advertised to the model (NULL for
-- dependencies nobody asked for by name).
CREATE TABLE IF NOT EXISTS sandbox_packages (
    id INTEGER PRIMARY KEY,
    pip TEXT NOT NULL UNIQUE,
    module TEXT,
    version TEXT NOT NULL,
    requirement TEXT NOT NULL,
    requestedBy TEXT,
    approvedBy TEXT,
    installedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Screen-vision companion pairings (/screenvision link + the desktop
-- companion app). Only the SHA-256 of the client token is stored; frames
-- themselves are never persisted anywhere.
CREATE TABLE IF NOT EXISTS screen_vision_clients (
    userId TEXT PRIMARY KEY,
    tokenHash TEXT NOT NULL,
    label TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastConnectedAt TEXT
);

-- GBA run harness pairings (/gbarun link + clients/gba-mcp/run-driver.js,
-- "Goobster Plays Pokemon" Phase 1). One harness per guild, bound to the
-- broadcast channel chosen at link time. Only the SHA-256 of the harness
-- token is stored; screenshots are posted to Discord, never persisted.
-- statusMessageId points at the live-updating status embed (Phase 3).
CREATE TABLE IF NOT EXISTS gba_run_clients (
    guildId TEXT PRIMARY KEY,
    channelId TEXT NOT NULL,
    tokenHash TEXT NOT NULL,
    label TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastConnectedAt TEXT,
    statusMessageId TEXT
);

-- Milestones reported by the GBA run agent (Phase 3): the run's durable
-- highlight reel, shown in /gbarun status and (Phase 4) the settlement
-- source for milestone bets. Text is model-written commentary.
CREATE TABLE IF NOT EXISTS gba_run_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId TEXT NOT NULL,
    turn INTEGER,
    text TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gba_run_milestones_guild ON gba_run_milestones(guildId, createdAt);

-- ============================================================================
-- The Jimbucks Exchange: margin, shorts, options, resting orders, and event
-- contracts layered on top of the point economy. Every wallet movement still
-- goes through economyService.adjust(); the tables below track POSITIONS and
-- LIABILITIES (which are not wallet money) plus the engine's own audit trail.
-- ============================================================================

-- Per-guild exchange rules. Absent row = the frozen defaults in
-- services/exchange/exchangeConfig.js (everything risky starts OFF).
CREATE TABLE IF NOT EXISTS exchange_settings (
    guildId TEXT PRIMARY KEY,
    marginEnabled INTEGER NOT NULL DEFAULT 0 CHECK (marginEnabled IN (0, 1)),
    optionsEnabled INTEGER NOT NULL DEFAULT 0 CHECK (optionsEnabled IN (0, 1)),
    zeroDteEnabled INTEGER NOT NULL DEFAULT 0 CHECK (zeroDteEnabled IN (0, 1)),
    predictionsEnabled INTEGER NOT NULL DEFAULT 0 CHECK (predictionsEnabled IN (0, 1)),
    maxLeverage REAL NOT NULL DEFAULT 2 CHECK (maxLeverage >= 1),
    -- Annual rates as decimals (0.08 = 8%/yr), accrued continuously by the risk engine
    interestRate REAL NOT NULL DEFAULT 0.08 CHECK (interestRate >= 0),
    borrowFeeRate REAL NOT NULL DEFAULT 0.05 CHECK (borrowFeeRate >= 0),
    -- Fraction of position value that must be covered by equity
    maintenanceMargin REAL NOT NULL DEFAULT 0.25 CHECK (maintenanceMargin > 0),
    shortMaintenanceMargin REAL NOT NULL DEFAULT 0.35 CHECK (shortMaintenanceMargin > 0),
    -- Minutes a margin call may sit before the engine force-liquidates
    marginCallGraceMinutes INTEGER NOT NULL DEFAULT 60 CHECK (marginCallGraceMinutes >= 0),
    -- Group events (the Wheel): treat every wallet as opted in unless the
    -- member explicitly opted out
    optInOverride INTEGER NOT NULL DEFAULT 1 CHECK (optInOverride IN (0, 1)),
    futuresEnabled INTEGER NOT NULL DEFAULT 0 CHECK (futuresEnabled IN (0, 1)),
    maxPerpLeverage REAL NOT NULL DEFAULT 10 CHECK (maxPerpLeverage >= 1),
    -- Daily funding rent on perp notional (0.0003 = 3 bps/day)
    fundingRateDaily REAL NOT NULL DEFAULT 0.0003 CHECK (fundingRateDaily >= 0),
    corporateActionsEnabled INTEGER NOT NULL DEFAULT 1 CHECK (corporateActionsEnabled IN (0, 1)),
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-user exchange account: cash vs margin, the loan ledger, and the
-- deliberate opt-in ("goblin mode") that unlocks same-day-expiry contracts.
CREATE TABLE IF NOT EXISTS exchange_accounts (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    accountType TEXT NOT NULL DEFAULT 'CASH' CHECK (accountType IN ('CASH', 'MARGIN')),
    leverage REAL NOT NULL DEFAULT 1 CHECK (leverage >= 1),
    goblinMode INTEGER NOT NULL DEFAULT 0 CHECK (goblinMode IN (0, 1)),
    -- Points borrowed from the house (a liability, never wallet money)
    marginLoan INTEGER NOT NULL DEFAULT 0 CHECK (marginLoan >= 0),
    -- Sub-point interest waiting to be capitalized into marginLoan
    accruedInterest REAL NOT NULL DEFAULT 0 CHECK (accruedInterest >= 0),
    lastInterestAt TEXT,
    -- Set when equity first fell under maintenance; cleared when cured
    marginCallAt TEXT,
    liquidations INTEGER NOT NULL DEFAULT 0 CHECK (liquidations >= 0),
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, userId)
);

-- Short positions. The long book stays in stock_holdings; a short is a
-- liability (units owed) whose proceeds were already credited to the wallet.
CREATE TABLE IF NOT EXISTS short_positions (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    symbol TEXT NOT NULL,
    units REAL NOT NULL CHECK (units > 0),
    -- Points credited when the position was opened (the basis to beat)
    proceeds INTEGER NOT NULL DEFAULT 0 CHECK (proceeds >= 0),
    avgPrice REAL NOT NULL CHECK (avgPrice > 0),
    -- Hard-to-borrow rent, accrued by the risk engine and paid on cover
    borrowFeeAccrued REAL NOT NULL DEFAULT 0 CHECK (borrowFeeAccrued >= 0),
    lastFeeAt TEXT,
    openedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, userId, symbol)
);

-- Long option positions (calls and puts). Premiums are simulated from the
-- underlying with Black-Scholes, contracts are cash-settled at expiry.
CREATE TABLE IF NOT EXISTS option_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    underlying TEXT NOT NULL,
    optionType TEXT NOT NULL CHECK (optionType IN ('CALL', 'PUT')),
    strike REAL NOT NULL CHECK (strike > 0),
    -- Expiry date (YYYY-MM-DD); settlement happens at EXPIRY_HOUR_UTC
    expiry TEXT NOT NULL,
    contracts INTEGER NOT NULL CHECK (contracts > 0),
    contractSize INTEGER NOT NULL DEFAULT 100 CHECK (contractSize > 0),
    -- LONG = bought (max loss: premium). SHORT = written (collects premium,
    -- pays intrinsic at settlement; margin requirement while open).
    side TEXT NOT NULL DEFAULT 'LONG' CHECK (side IN ('LONG', 'SHORT')),
    -- Per-share premium paid/collected and total points moved at open
    openPremium REAL NOT NULL CHECK (openPremium >= 0),
    costBasis INTEGER NOT NULL CHECK (costBasis >= 0),
    openIv REAL,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'EXPIRED', 'EXERCISED')),
    closePremium REAL,
    proceeds INTEGER,
    realizedPL INTEGER,
    closedAt TEXT,
    openedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_option_positions_open
    ON option_positions(status, expiry);
CREATE INDEX IF NOT EXISTS idx_option_positions_user
    ON option_positions(guildId, userId, status);
-- One open lot per contract per user, so repeat buys average into it
CREATE UNIQUE INDEX IF NOT EXISTS idx_option_positions_open_lot
    ON option_positions(guildId, userId, underlying, optionType, strike, expiry)
    WHERE status = 'OPEN';

-- Append-only option fill log (the "when and at what premium" record)
CREATE TABLE IF NOT EXISTS option_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    positionId INTEGER,
    underlying TEXT NOT NULL,
    optionType TEXT NOT NULL CHECK (optionType IN ('CALL', 'PUT')),
    strike REAL NOT NULL CHECK (strike > 0),
    expiry TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('BUY_TO_OPEN', 'SELL_TO_CLOSE', 'SELL_TO_OPEN', 'BUY_TO_CLOSE', 'EXPIRE', 'EXERCISE', 'ASSIGN')),
    contracts INTEGER NOT NULL CHECK (contracts > 0),
    premium REAL NOT NULL CHECK (premium >= 0),
    underlyingPrice REAL,
    iv REAL,
    points INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_option_trades_user_time
    ON option_trades(guildId, userId, createdAt);

-- Resting orders: limit, stop, stop-limit, and trailing stop. Evaluated by
-- the risk engine against fresh quotes; a fill runs the normal trade path.
CREATE TABLE IF NOT EXISTS exchange_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL', 'SHORT', 'COVER')),
    orderType TEXT NOT NULL CHECK (orderType IN ('LIMIT', 'STOP', 'STOP_LIMIT', 'TRAILING_STOP')),
    units REAL NOT NULL CHECK (units > 0),
    limitPrice REAL,
    stopPrice REAL,
    trailPercent REAL,
    -- High/low-water mark that a trailing stop tracks
    trailAnchor REAL,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'TRIGGERED', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')),
    filledPrice REAL,
    filledUnits REAL,
    points INTEGER,
    note TEXT,
    expiresAt TEXT,
    triggeredAt TEXT,
    closedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_exchange_orders_open ON exchange_orders(status, symbol);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_user ON exchange_orders(guildId, userId, status);

-- Binary event contracts ("Will AAPL close above $250 by Friday?"). Settled
-- deterministically from the underlying's price at resolvesAt - no oracle.
CREATE TABLE IF NOT EXISTS prediction_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId TEXT NOT NULL,
    question TEXT NOT NULL,
    symbol TEXT NOT NULL,
    comparator TEXT NOT NULL CHECK (comparator IN ('ABOVE', 'BELOW')),
    threshold REAL NOT NULL CHECK (threshold > 0),
    -- Trading closes at closesAt; the price is read at resolvesAt
    closesAt TEXT NOT NULL,
    resolvesAt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'SETTLED', 'VOID')),
    outcome TEXT CHECK (outcome IN ('YES', 'NO')),
    settlePrice REAL,
    settledAt TEXT,
    -- Max contracts one user may hold per side, so one whale can't own a market
    positionCap INTEGER NOT NULL DEFAULT 500 CHECK (positionCap > 0),
    createdBy TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prediction_markets_guild ON prediction_markets(guildId, status);

-- One row per user per market side; each contract settles at 100 points.
CREATE TABLE IF NOT EXISTS prediction_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketId INTEGER NOT NULL REFERENCES prediction_markets(id) ON DELETE CASCADE,
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
    contracts INTEGER NOT NULL CHECK (contracts > 0),
    -- Average price paid per contract, in points (1-99 of the 100 payout)
    avgPrice REAL NOT NULL CHECK (avgPrice > 0),
    cost INTEGER NOT NULL CHECK (cost >= 0),
    payout INTEGER,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SETTLED')),
    settledAt TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prediction_positions_lot
    ON prediction_positions(marketId, userId, side) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_prediction_positions_user
    ON prediction_positions(guildId, userId, status);

-- The exchange's own audit trail: everything the engine did on its own
-- (interest, borrow fees, fills, expiries, margin calls, liquidations,
-- settlements) plus deliberate risk opt-ins. Wallet movements stay in
-- economy_transactions; this explains WHY they happened.
CREATE TABLE IF NOT EXISTS exchange_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId TEXT NOT NULL,
    userId TEXT,
    eventType TEXT NOT NULL,
    symbol TEXT,
    amount INTEGER,
    detail TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_exchange_events_guild_time ON exchange_events(guildId, createdAt);
CREATE INDEX IF NOT EXISTS idx_exchange_events_user_time ON exchange_events(guildId, userId, createdAt);

-- Group-play opt-ins: who participates when a server-wide exchange event
-- (e.g. the Daily Ballistic Goblin Wheel) deploys wallets. An explicit row
-- always wins; with no row, the guild's optInOverride setting decides
-- (default ON: everyone with a wallet is in until they say otherwise).
CREATE TABLE IF NOT EXISTS exchange_optins (
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    optedIn INTEGER NOT NULL DEFAULT 1 CHECK (optedIn IN (0, 1)),
    -- Personal ceiling on how much of the wallet one event may deploy
    maxAllocationPercent REAL CHECK (maxAllocationPercent > 0 AND maxAllocationPercent <= 100),
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guildId, userId)
);

-- Perpetual futures: isolated-margin leveraged contracts on any USD symbol
-- (crypto pairs like BTC-USD included). The posted margin IS the maximum
-- loss; funding rent erodes it over time and the engine liquidates when the
-- mark crosses the liquidation price.
CREATE TABLE IF NOT EXISTS perp_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guildId TEXT NOT NULL,
    userId TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    -- Underlying units controlled: margin x leverage / entry price
    units REAL NOT NULL CHECK (units > 0),
    entryPrice REAL NOT NULL CHECK (entryPrice > 0),
    -- Points escrowed when the position opened (isolated: the max loss)
    margin INTEGER NOT NULL CHECK (margin > 0),
    leverage REAL NOT NULL CHECK (leverage >= 1),
    liquidationPrice REAL NOT NULL CHECK (liquidationPrice >= 0),
    fundingAccrued REAL NOT NULL DEFAULT 0 CHECK (fundingAccrued >= 0),
    lastFundingAt TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'LIQUIDATED')),
    exitPrice REAL,
    payout INTEGER,
    realizedPL INTEGER,
    closedAt TEXT,
    openedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_perp_positions_open ON perp_positions(status, guildId);
CREATE INDEX IF NOT EXISTS idx_perp_positions_user ON perp_positions(guildId, userId, status);

-- Corporate actions seen on the real feed (dividends and splits), recorded
-- once globally so each is applied to positions exactly once. Events observed
-- on a symbol's FIRST sweep are recorded without being applied - they predate
-- our knowledge of the symbol, and back-paying them would invent money.
CREATE TABLE IF NOT EXISTS corporate_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    actionType TEXT NOT NULL CHECK (actionType IN ('DIVIDEND', 'SPLIT')),
    eventDate TEXT NOT NULL,
    -- DIVIDEND: amount per share. SPLIT: the ratio (2 for 2:1, 0.5 for 1:2).
    value REAL NOT NULL CHECK (value > 0),
    applied INTEGER NOT NULL DEFAULT 1 CHECK (applied IN (0, 1)),
    processedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (symbol, actionType, eventDate)
);

-- ---------------------------------------------------------------------------
-- Per-user platform integrations (Notion, GitHub, ...): personal API tokens
-- connected through the web portal's Integrations dialog. Unlike sessions,
-- the raw token must be stored (it is replayed against the provider's API on
-- every tool call) - same trust model as config.json's GITHUB_TOKEN, scoped
-- to one user. accountLabel is a display snapshot ("Connected as ...")
-- captured when the token is verified. Deleted outright by /forget-me.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_integrations (
    userId TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('github', 'notion')),
    token TEXT NOT NULL,
    accountLabel TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastUsedAt TEXT,
    PRIMARY KEY (userId, provider)
);

-- ---------------------------------------------------------------------------
-- Web app sessions (browser login for the Goobster web interface). Only the
-- SHA-256 of the session token is stored (screen-vision pattern); sessions
-- survive restarts so a Pi reboot never logs everyone out. Deleted outright
-- by /forget-me.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS web_sessions (
    id INTEGER PRIMARY KEY,
    tokenHash TEXT NOT NULL UNIQUE,
    userId TEXT NOT NULL,
    userName TEXT,
    avatar TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastSeenAt TEXT,
    expiresAt TEXT NOT NULL,
    -- When the person last proved who they are on this session (login or
    -- re-auth); sensitive account changes require this to be recent.
    authenticatedAt TEXT,
    -- Snapshot of app_accounts.sessionVersion at creation; a mismatch means
    -- the account was reset/disabled since and the session is dead.
    sessionVersion INTEGER
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(userId);

-- Web chat conversations (the ChatGPT-style sidebar list). Each row names
-- one synthetic web channel ("web:<userId>:<key>") whose messages live in
-- the normal chat tables via guild_conversations. Deleted outright by
-- /forget-me along with the rest of the user's chat history.
CREATE TABLE IF NOT EXISTS web_conversations (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    channelId TEXT NOT NULL UNIQUE,
    title TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastMessageAt TEXT,
    -- Branching: a conversation forked from an earlier message keeps a
    -- pointer to its source so both branches stay reachable in the sidebar.
    parentConversationId INTEGER,
    branchedFromMessageId INTEGER
);

CREATE INDEX IF NOT EXISTS idx_web_conversations_user ON web_conversations(userId, lastMessageAt);

-- Read-only share links for web conversations. The token IS the capability:
-- it grants read access to exactly one conversation's message text and
-- nothing else (no attachments, no other conversations, no writes). It is
-- stored in plaintext - unlike session tokens (hashed because they grant
-- authenticated WRITE access), a share token only reveals content that
-- lives in the same database rows, so hashing would add no protection
-- against a database compromise while making "copy the link again later"
-- impossible. Revoking deletes the row. Deleted with the conversation and
-- by /forget-me.
CREATE TABLE IF NOT EXISTS web_share_links (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    conversationId INTEGER NOT NULL UNIQUE REFERENCES web_conversations(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_web_share_links_user ON web_share_links(userId);

-- The user's Discord friends, as reported by the Embedded App SDK's
-- getRelationships() inside the Activity (the ONLY surface where Discord
-- exposes a friend list - a bot token cannot read relationships). The
-- Activity syncs the roster here so the web app can offer a real people
-- picker (e.g. inviting a friend into a parlor discussion) instead of
-- asking for a raw snowflake. Cached, not authoritative: it is refreshed
-- on every Activity load and always re-derivable by opening the Activity
-- again. Names/avatars are snapshots for display. /forget-me deletes a
-- user's roster AND their appearance in anyone else's.
CREATE TABLE IF NOT EXISTS user_friends (
    ownerId TEXT NOT NULL,
    friendId TEXT NOT NULL,
    friendName TEXT,
    avatar TEXT,
    syncedAt TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (ownerId, friendId)
);

CREATE INDEX IF NOT EXISTS idx_user_friends_friend ON user_friends(friendId);

-- ---------------------------------------------------------------------------
-- The Parlor (web app): a multi-persona AI workspace where conversations
-- become persistent knowledge. Every table is keyed on the owning web
-- user's Discord snowflake (ownerId TEXT); personas, their knowledge
-- workspaces, and parlor discussions are private to that user and are
-- deleted outright by /forget-me. Notes carry their own embeddings
-- (per-note semantic search is a bounded brute-force scan - no vec index),
-- and the tag-first model means notes never link to each other directly:
-- shared tags ARE the graph.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS parlor_personas (
    id INTEGER PRIMARY KEY,
    ownerId TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    emoji TEXT,
    color TEXT,
    -- The persona's charter: who it is, how it thinks, what it cares about
    charter TEXT NOT NULL,
    -- Parlor Live: the persona's ElevenLabs voice, resolved through
    -- elevenLabsTTSService.resolveVoice at save time (bad names fail at
    -- edit time, never mid-session). NULL = a default voice picked from a
    -- small premade pool by persona id, so casts sound distinct anyway.
    -- voiceName snapshots the display name for the picker UI.
    voiceId TEXT,
    voiceName TEXT,
    -- The built-in Goobster seat (one per owner): auto-created for project
    -- parlors, undeletable, outside the persona cap. In a project-linked
    -- discussion its knowledge workspace is the project graph
    -- (PROJECT:<projectId>), not a PARLOR:<personaId> workspace.
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ownerId, name)
);

CREATE INDEX IF NOT EXISTS idx_parlor_personas_owner ON parlor_personas(ownerId);

CREATE TABLE IF NOT EXISTS parlor_notes (
    id INTEGER PRIMARY KEY,
    personaId INTEGER NOT NULL REFERENCES parlor_personas(id) ON DELETE CASCADE,
    title TEXT NOT NULL COLLATE NOCASE,
    content TEXT NOT NULL,
    -- 'user' = seeded/edited directly; 'conversation' = extracted by the
    -- persona's write-back step after a parlor turn
    source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'conversation')),
    sourceConversationId INTEGER,
    -- Semantic-search vector (same tagging rule as memory_embeddings:
    -- vectors are only compared when produced by the same model)
    embedding BLOB,
    dims INTEGER,
    model TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (personaId, title)
);

CREATE INDEX IF NOT EXISTS idx_parlor_notes_persona ON parlor_notes(personaId, updatedAt);

CREATE TABLE IF NOT EXISTS parlor_tags (
    id INTEGER PRIMARY KEY,
    personaId INTEGER NOT NULL REFERENCES parlor_personas(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (personaId, name)
);

CREATE INDEX IF NOT EXISTS idx_parlor_tags_persona ON parlor_tags(personaId);

CREATE TABLE IF NOT EXISTS parlor_note_tags (
    noteId INTEGER NOT NULL REFERENCES parlor_notes(id) ON DELETE CASCADE,
    tagId INTEGER NOT NULL REFERENCES parlor_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (noteId, tagId)
);

CREATE INDEX IF NOT EXISTS idx_parlor_note_tags_tag ON parlor_note_tags(tagId);

CREATE TABLE IF NOT EXISTS parlor_conversations (
    id INTEGER PRIMARY KEY,
    modelConfigJson TEXT,
    ownerId TEXT NOT NULL,
    title TEXT,
    -- Project parlor: the linked project's row id (one discussion per
    -- project, enforced in the service). Membership follows the project;
    -- deleting the project deletes the discussion. No FK on purpose: the
    -- project tables live in another feature area, and projectService
    -- deletes the linked discussion explicitly.
    projectId INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastMessageAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_parlor_conversations_owner ON parlor_conversations(ownerId, lastMessageAt);
CREATE INDEX IF NOT EXISTS idx_parlor_conversations_project ON parlor_conversations(projectId);

CREATE TABLE IF NOT EXISTS parlor_participants (
    conversationId INTEGER NOT NULL REFERENCES parlor_conversations(id) ON DELETE CASCADE,
    personaId INTEGER NOT NULL REFERENCES parlor_personas(id) ON DELETE CASCADE,
    joinedAt TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (conversationId, personaId)
);

CREATE TABLE IF NOT EXISTS parlor_messages (
    id INTEGER PRIMARY KEY,
    conversationId INTEGER NOT NULL REFERENCES parlor_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'persona')),
    -- Persona attribution; the name is snapshotted so transcripts survive
    -- persona deletion (the id nulls, the label stays readable)
    personaId INTEGER REFERENCES parlor_personas(id) ON DELETE SET NULL,
    personaName TEXT,
    content TEXT NOT NULL,
    -- Traceable context: JSON array of parlor_notes ids the reply was
    -- grounded on (the workspace notes retrieved before generation)
    contextNoteIds TEXT,
    -- JSON array of local file paths produced by tool calls during the
    -- reply (generated images, sandbox charts); re-served through the
    -- owner-bound web file route on read
    attachments TEXT,
    -- Human attribution for 'user' rows in shared discussions: which member
    -- spoke. The name is snapshotted (same rule as personaName) so
    -- transcripts stay readable after a member leaves. NULL on rows written
    -- before sharing existed (rendered as the owner).
    userId TEXT,
    userName TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parlor_messages_conversation ON parlor_messages(conversationId, id);

-- Human members of a shared parlor discussion (multi-user parlors). The
-- conversation's owner is NOT stored here - ownership stays on
-- parlor_conversations.ownerId; this table holds invited Discord friends
-- who accepted. Rows cascade with the discussion; /forget-me additionally
-- deletes a user's memberships in OTHER people's discussions.
CREATE TABLE IF NOT EXISTS parlor_members (
    conversationId INTEGER NOT NULL REFERENCES parlor_conversations(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    -- Display name snapshotted when the invite is accepted
    userName TEXT,
    invitedBy TEXT NOT NULL,
    joinedAt TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (conversationId, userId)
);

CREATE INDEX IF NOT EXISTS idx_parlor_members_user ON parlor_members(userId);

-- Pending/settled invitations to join a shared parlor discussion. Only the
-- discussion owner invites; the invitee accepts or declines from a Discord
-- DM button or the web app's invitation list. Rows cascade with the
-- discussion; /forget-me deletes rows addressed to the forgotten user.
CREATE TABLE IF NOT EXISTS parlor_invites (
    id INTEGER PRIMARY KEY,
    conversationId INTEGER NOT NULL REFERENCES parlor_conversations(id) ON DELETE CASCADE,
    inviterId TEXT NOT NULL,
    inviterName TEXT,
    inviteeId TEXT NOT NULL,
    -- Display name snapshotted when the invite is sent (same rule as
    -- inviterName), so the host's roster shows a person, not a snowflake
    inviteeName TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    respondedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_parlor_invites_conversation ON parlor_invites(conversationId, status);
CREATE INDEX IF NOT EXISTS idx_parlor_invites_invitee ON parlor_invites(inviteeId, status);

-- The Observatory: persistent, per-user simulation projects layered on top
-- of the code sandbox (services/observatoryService.js). A project names a
-- durable workspace directory at data/sandbox/projects/<userId>/<slug>/;
-- the rows here are the durable registry (restart-safe, per the SQLite
-- rule), the directory holds the actual files.
CREATE TABLE IF NOT EXISTS observatory_projects (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    -- Cosmetic card fields (COLUMN_MIGRATIONS back-fills existing rows)
    description TEXT,
    icon TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (userId, slug)
);

CREATE INDEX IF NOT EXISTS idx_observatory_projects_user ON observatory_projects(userId, updatedAt);

-- Background Observatory jobs: one row per detached run. The code is stored
-- so a job interrupted by a process restart (status INTERRUPTED, set by the
-- orphan reaper at startup) can be resumed from its own checkpoint later.
-- Segments count sandbox runs; resumeCount counts checkpoint restarts after
-- the timeout wall (bounded by observatoryConfig.maxResumes).
CREATE TABLE IF NOT EXISTS observatory_jobs (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    language TEXT NOT NULL,
    code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'RUNNING'
        CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'INTERRUPTED')),
    segments INTEGER NOT NULL DEFAULT 0,
    resumeCount INTEGER NOT NULL DEFAULT 0,
    exitCode INTEGER,
    -- Bounded tails of the LAST segment's streams (job forensics; full
    -- streams are byte-capped by the sandbox and not worth persisting)
    stdoutTail TEXT,
    stderrTail TEXT,
    -- Last observed mtime of the project's checkpoint.json (UTC text) -
    -- the resume decision compares this across segments
    checkpointAt TEXT,
    -- Auto-rendered frames video (renders/<file>.mp4 in the workspace)
    renderPath TEXT,
    error TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    finishedAt TEXT,
    -- The run lease: which process claimed the job, renewed while the
    -- loop is live. A RUNNING row whose heartbeat has gone stale and that
    -- no live loop in this process is driving is an orphan; a fresh
    -- heartbeat means another process legitimately owns it.
    lastHeartbeatAt TEXT,
    runnerId TEXT,
    -- Provenance (COLUMN_MIGRATIONS back-fills existing rows): which stored
    -- asset version this job executed (NULL for ad-hoc inline code), and
    -- what started it ('chat' | 'portal' | 'trigger' | 'resume').
    assetVersionId INTEGER,
    startedBy TEXT,
    triggerId INTEGER,
    -- Mission start-attempt correlation. Written before the job loop
    -- starts so a crash after INSERT still lets reconcileStartingSteps
    -- adopt the running child instead of marking the step FAILED.
    executionAttemptId TEXT,
    -- Per-attempt lease token. Heartbeat, segment writes, and finish
    -- require this value; a stolen/resumed job mints a new one so a
    -- recovered stalled worker cannot write into the new attempt.
    leaseToken TEXT,
    -- Owner-acknowledged cancel. The RUNNING claim stays until the
    -- owning loop (or a stale-lease reap) settles the row.
    cancelRequested INTEGER NOT NULL DEFAULT 0 CHECK (cancelRequested IN (0, 1)),
    -- Only jobs that existed before per-run dirs may read project-root
    -- checkpoint.json / frames/. New inserts always store 0.
    legacyWorkspace INTEGER NOT NULL DEFAULT 0 CHECK (legacyWorkspace IN (0, 1)),
    -- Explicit event parentage (COLUMN_MIGRATIONS back-fills existing rows
    -- with NULL): the settled job whose event trigger started this one.
    -- Cron, chat, portal, and other root jobs are NULL. Chain-depth walks
    -- this instead of guessing ancestry from timestamps.
    parentJobId INTEGER,
    -- Declared output contract frozen at insert (utils/outputContract.js):
    -- { resolvedAt, variables, outputs: [{ path, type, minBytes? }] }.
    -- NULL when the run declared nothing. Never re-read from the trigger.
    outputContractJson TEXT,
    -- Structured per-check verdict written at settlement:
    -- { ok, checkedAt, checks: [{ path, type, ok, reason, sizeBytes }] }
    outputContractResultJson TEXT,
    -- Stable machine reason behind a terminal status: EXIT_NONZERO,
    -- TIMED_OUT, CANCELLED, OUTPUT_CONTRACT_FAILED, RUN_ERROR,
    -- QUOTA_EXCEEDED, PROJECT_DELETED. NULL for COMPLETED and legacy rows.
    errorCode TEXT
);

CREATE INDEX IF NOT EXISTS idx_observatory_jobs_user ON observatory_jobs(userId, status);
CREATE INDEX IF NOT EXISTS idx_observatory_jobs_project ON observatory_jobs(projectId, id);
CREATE INDEX IF NOT EXISTS idx_observatory_jobs_execution_attempt
    ON observatory_jobs(executionAttemptId) WHERE executionAttemptId IS NOT NULL;
-- Event-trigger retries share a stable attempt key even after the child
-- settles. Legacy event jobs have NULL keys and remain valid on upgrade.
CREATE UNIQUE INDEX IF NOT EXISTS uq_observatory_jobs_event_attempt
    ON observatory_jobs(executionAttemptId)
    WHERE startedBy = 'trigger' AND parentJobId IS NOT NULL AND executionAttemptId IS NOT NULL;
-- Event catch-up scans a project's settled jobs by finishedAt.
CREATE INDEX IF NOT EXISTS idx_observatory_jobs_project_finished
    ON observatory_jobs(projectId, finishedAt);
-- Parent traversal (chain depth) and "children of job N" lookups.
CREATE INDEX IF NOT EXISTS idx_observatory_jobs_parent
    ON observatory_jobs(parentJobId) WHERE parentJobId IS NOT NULL;
-- One live execution per project. Duplicate RUNNING rows are parked as
-- INTERRUPTED in repairObservatoryJobs before this index is created.
CREATE UNIQUE INDEX IF NOT EXISTS uq_observatory_jobs_one_active
    ON observatory_jobs(projectId) WHERE status = 'RUNNING';

-- Read-only share links for Observatory project dashboards (one per
-- project, the web_share_links pattern): the unguessable token is the
-- capability, revoking (or deleting the project, or /forget-me) kills the
-- URL instantly. The shared page is the server-generated dashboard HTML -
-- self-contained, so no other file becomes reachable through the token.
CREATE TABLE IF NOT EXISTS observatory_share_links (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    projectId INTEGER NOT NULL UNIQUE REFERENCES observatory_projects(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_observatory_share_links_user ON observatory_share_links(userId);

-- Project assets: named, versioned source artifacts owned by a Project
-- (services/projectAssetService.js). Source lives in the DB (not the
-- workspace) so the portal and the split-deployment api can render apps
-- without touching the bot's disk. An asset is a stable identity; a
-- version is an immutable snapshot. Head is currentVersionId.
CREATE TABLE IF NOT EXISTS project_assets (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    -- Denormalized owner so erasure and audits never need a join
    userId TEXT NOT NULL,
    -- Asset identity within the project ("dashboard", "ingest", "readme")
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('app', 'script', 'note')),
    -- Head pointer; NULL only transiently during creation
    currentVersionId INTEGER,
    -- Approved cross-project Observatory reads (JSON): { observatoryRead: ["slug"] }.
    -- Empty/null means no extra grants. Own-project reads are Phase 4.
    grantsJson TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (projectId, slug)
);

CREATE TABLE IF NOT EXISTS project_asset_versions (
    id INTEGER PRIMARY KEY,
    assetId INTEGER NOT NULL REFERENCES project_assets(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    -- Monotonic per-asset sequence (1, 2, 3, ...) - the user-facing "v7"
    version INTEGER NOT NULL,
    -- app: 'html' | 'svg'; script: 'python' | 'javascript'; note: 'markdown'
    language TEXT NOT NULL,
    source TEXT NOT NULL,
    contentHash TEXT NOT NULL,
    -- One-line commit-message-style note ("added error bars")
    note TEXT,
    -- Where this version came from: 'chat' (saved from a Study fence),
    -- 'portal' (edited in the project pane), 'agent' (tool call),
    -- 'migration' (imported from web_applets)
    origin TEXT NOT NULL DEFAULT 'chat'
        CHECK (origin IN ('chat', 'portal', 'agent', 'migration')),
    -- Chat provenance when saved from a conversation (soft links, like
    -- web_applets today)
    conversationId INTEGER,
    messageId INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (assetId, version)
);

CREATE INDEX IF NOT EXISTS idx_project_assets_project ON project_assets(projectId, kind);
CREATE INDEX IF NOT EXISTS idx_project_assets_user ON project_assets(userId);
CREATE INDEX IF NOT EXISTS idx_project_asset_versions_asset
    ON project_asset_versions(assetId, version);
CREATE INDEX IF NOT EXISTS idx_project_asset_versions_user ON project_asset_versions(userId);

-- Project triggers: project-scoped automations with first-class actions
-- (services/projectTriggerService.js). Cron rows join the existing
-- automation minute loop; event rows fire from the job-settle path.
-- The guild/channel `automations` table is a different feature and is
-- left alone.
CREATE TABLE IF NOT EXISTS project_triggers (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    -- When it fires
    kind TEXT NOT NULL CHECK (kind IN ('cron', 'event')),
    -- kind='cron': 5-field cron, evaluated in UTC (the automations contract)
    schedule TEXT,
    nextRun TEXT,
    -- kind='event': a project-scoped domain event on THIS project.
    -- 'job_completed' | 'job_failed' | 'job_settled' (any terminal state)
    eventTopic TEXT,
    -- What it does
    action TEXT NOT NULL CHECK (action IN ('run_script', 'render', 'fetch_data', 'agent_prompt')),
    -- run_script: the asset to run (head version at fire time)
    actionAssetId INTEGER REFERENCES project_assets(id) ON DELETE SET NULL,
    -- JSON knobs: { background, fps, url, filename, prompt, ... } - validated
    -- per-action at write time, re-validated at fire time
    actionParams TEXT,
    isEnabled INTEGER NOT NULL DEFAULT 1 CHECK (isEnabled IN (0, 1)),
    lastRun TEXT,
    -- 'ok' | 'failed' | 'skipped' + short detail, for the portal list
    lastOutcome TEXT,
    -- Chaining guard: an event trigger never fires on a job it started
    -- itself unless allowSelfChain=1 (JSON in actionParams), and never
    -- more than maxChainDepth times per root job.
    -- Actor who created the row (userId stays the owner; fire uses owner).
    createdBy TEXT,
    -- Event source filters (kind='event' only; COLUMN_MIGRATIONS back-fills
    -- NULL = legacy project-wide behaviour). sourceAssetId: fire only when
    -- the settled job executed a version of this script asset.
    -- sourceTriggerId: fire only when the settled job was started by this
    -- trigger. Both present = both must match. Deliberately no FK: a
    -- deleted target leaves the trigger inert (the audit flags it) instead
    -- of silently widening it back to project-wide.
    sourceAssetId INTEGER,
    sourceTriggerId INTEGER,
    -- Settlement of the most recent job this trigger STARTED (a run_script
    -- child), written when that job settles. lastOutcome says whether the
    -- dispatch worked ("started: job #12, awaiting settlement"); this says
    -- how the stage itself ended - the two are deliberately separate.
    lastJobOutcome TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_triggers_project ON project_triggers(projectId);
CREATE INDEX IF NOT EXISTS idx_project_triggers_next_run ON project_triggers(nextRun);
CREATE INDEX IF NOT EXISTS idx_project_triggers_user ON project_triggers(userId);

-- One row per (event trigger, settled source job): the identity of a
-- processed event. The settle path and startup catch-up both claim by
-- inserting here, so two matching jobs that finished in the same second
-- are two events (not one), and an older job examined after a newer one
-- is still delivered. project_triggers.lastRun stays a display cursor.
--
-- status: STARTED (claimed, dispatch in flight) -> DELIVERED (the child
-- job row exists / the action ran) | RETRYABLE (sandbox busy, active-job
-- cap: re-dispatched by retryEventDeliveries after nextAttemptAt, up to
-- MAX_DELIVERY_ATTEMPTS) | FAILED (permanent: bad script, gone project,
-- attempts exhausted) | SKIPPED (chain guard, allowlist). A STARTED row
-- left behind by a crash is reaped as RETRYABLE after a lease window.
CREATE TABLE IF NOT EXISTS project_trigger_deliveries (
    id INTEGER PRIMARY KEY,
    triggerId INTEGER NOT NULL REFERENCES project_triggers(id) ON DELETE CASCADE,
    sourceJobId INTEGER NOT NULL REFERENCES observatory_jobs(id) ON DELETE CASCADE,
    projectId INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('STARTED', 'DELIVERED', 'RETRYABLE', 'FAILED', 'SKIPPED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    -- The downstream job a run_script action created (DELIVERED only).
    childJobId INTEGER,
    detail TEXT,
    nextAttemptAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (triggerId, sourceJobId)
);

CREATE INDEX IF NOT EXISTS idx_project_trigger_deliveries_retry
    ON project_trigger_deliveries(status, nextAttemptAt);
CREATE INDEX IF NOT EXISTS idx_project_trigger_deliveries_child
    ON project_trigger_deliveries(childJobId);
CREATE INDEX IF NOT EXISTS idx_project_trigger_deliveries_project
    ON project_trigger_deliveries(projectId, updatedAt);

-- Accepted collaborators. The owner is observatory_projects.userId and
-- never has a row here; role exists for forward-compat (all rows are
-- 'collaborator' until a 'viewer' tier is ever wanted).
CREATE TABLE IF NOT EXISTS project_members (
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    userName TEXT,
    role TEXT NOT NULL DEFAULT 'collaborator' CHECK (role IN ('collaborator')),
    invitedBy TEXT NOT NULL,
    joinedAt TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (projectId, userId)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(userId);

-- Only the owner invites; invitee accepts/declines from a Discord DM
-- button or the portal invitation list. Mirrors parlor_invites exactly
-- (status lifecycle, name snapshots, /forget-me deletes rows addressed
-- to the forgotten user).
CREATE TABLE IF NOT EXISTS project_invites (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    inviterId TEXT NOT NULL,
    inviterName TEXT,
    inviteeId TEXT NOT NULL,
    inviteeName TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    respondedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_project_invites_project ON project_invites(projectId, status);
CREATE INDEX IF NOT EXISTS idx_project_invites_invitee ON project_invites(inviteeId, status);

-- ---------------------------------------------------------------------------
-- MTGA deck library (services/mtgaService.js, the web portal's Decks pane):
-- Magic: The Gathering Arena deck exports imported by pasting Arena's
-- "Export to clipboard" text. Personal data (user-scoped, not guild-scoped);
-- deleted outright by /forget-me. The original export text is kept verbatim
-- on the deck row so re-exporting back into Arena is always lossless; the
-- per-card rows are the parsed, queryable view of the same list.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mtga_folders (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (userId, name)
);

CREATE INDEX IF NOT EXISTS idx_mtga_folders_user ON mtga_folders(userId, name);

CREATE TABLE IF NOT EXISTS mtga_decks (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    -- NULL = unfiled; deleting a folder keeps its decks (ON DELETE SET
    -- NULL drops them back to Unfiled - never silently deletes a deck).
    folderId INTEGER REFERENCES mtga_folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    format TEXT,
    -- Arena's export text, verbatim (the lossless re-export source)
    rawText TEXT NOT NULL,
    -- SHA-256 of the normalized card list (board|name|count, sorted) - the
    -- dedupe key that keeps re-imports of the same Player.log from
    -- duplicating the library. Content-based, so a rename doesn't defeat it.
    contentHash TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mtga_decks_user ON mtga_decks(userId, updatedAt);
CREATE INDEX IF NOT EXISTS idx_mtga_decks_folder ON mtga_decks(folderId);

-- One row per distinct card line: board partitions the list the way the
-- Arena export does (Deck / Sideboard / Commander / Companion).
CREATE TABLE IF NOT EXISTS mtga_deck_cards (
    id INTEGER PRIMARY KEY,
    deckId INTEGER NOT NULL REFERENCES mtga_decks(id) ON DELETE CASCADE,
    board TEXT NOT NULL DEFAULT 'main'
        CHECK (board IN ('main', 'sideboard', 'commander', 'companion')),
    name TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count > 0),
    setCode TEXT,
    collectorNumber TEXT
);

CREATE INDEX IF NOT EXISTS idx_mtga_deck_cards_deck ON mtga_deck_cards(deckId, board, id);
CREATE INDEX IF NOT EXISTS idx_mtga_deck_cards_name ON mtga_deck_cards(name);

-- Arena card catalog cache (services/mtgaCardService.js): Arena's numeric
-- card ids resolved to names via Scryfall, cached forever - printings are
-- immutable. Global, not per-user (card names are public facts), so it is
-- deliberately outside the /forget-me scope.
CREATE TABLE IF NOT EXISTS mtga_cards (
    arenaId INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    setCode TEXT,
    collectorNumber TEXT,
    fetchedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pinned mini-apps from web chat (html/svg fences the assistant wrote).
-- A pin copies the source so the Workshop can reopen it after the chat
-- is gone. Discovered (unpinned) applets are scanned from messages on
-- demand and never stored. Deleted outright by /forget-me.
CREATE TABLE IF NOT EXISTS web_applets (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    contentHash TEXT NOT NULL,
    title TEXT NOT NULL,
    language TEXT NOT NULL CHECK (language IN ('html', 'svg')),
    source TEXT NOT NULL,
    conversationId INTEGER REFERENCES web_conversations(id) ON DELETE SET NULL,
    messageId INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastOpenedAt TEXT,
    -- Approved capability grants for this pin (JSON): { observatoryRead: ["slug"] }.
    -- Empty/null means the owner has not approved any Observatory reads yet.
    grantsJson TEXT,
    -- Soft link to the project asset created by the Workshop pin migration
    -- (or a later Promote). No FK: the pin outlives a deleted asset so the
    -- inbox can remigrate. JOIN to project_assets for the "migrated" badge.
    migratedAssetId INTEGER,
    UNIQUE (userId, contentHash)
);

CREATE INDEX IF NOT EXISTS idx_web_applets_user ON web_applets(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_web_applets_migrated ON web_applets(migratedAssetId);

-- Durable one-time data-backfill markers (not schema). Keyed by a stable
-- string; upserted after a successful pass so operators can see what ran.
CREATE TABLE IF NOT EXISTS data_migrations (
    key TEXT PRIMARY KEY,
    appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner-bound generated files served at /api/app/files/:id (chat images,
-- parlor tool output, Observatory workspace downloads). Files live on the
-- shared data volume; this table is the registry so an api restart (or a
-- second replica) can still authorize the download. TTL-pruned; deleted
-- outright by /forget-me.
CREATE TABLE IF NOT EXISTS web_generated_files (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (userId, path)
);

CREATE INDEX IF NOT EXISTS idx_web_generated_files_user ON web_generated_files(userId, createdAt);

-- Personalized new-chat suggestions for the Study's empty state
-- (services/webSuggestionService.js): one cached row per active portal
-- user, regenerated lazily when older than a day. A pure cache of an
-- expensive AI derivation - losing it only means the next portal visit
-- regenerates. Deleted outright by /forget-me.
CREATE TABLE IF NOT EXISTS web_suggested_queries (
    userId TEXT PRIMARY KEY,
    -- JSON array of short suggested opening queries
    suggestionsJson TEXT NOT NULL,
    generatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Shared sliding-window rate-limit events (Phase 5c). Chat / parlor / voice
-- (and other web surfaces) record one row per consume so N api replicas
-- share one budget. Pruned on consume; deleted by /forget-me.
CREATE TABLE IF NOT EXISTS web_rate_events (
    id INTEGER PRIMARY KEY,
    scope TEXT NOT NULL,
    subject TEXT NOT NULL,
    createdAtMs INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_rate_events_lookup
    ON web_rate_events(scope, subject, createdAtMs);

-- Cross-replica in-flight web chat turn (Phase 5c). The replica that
-- claimed the turn also holds the AbortController in process memory;
-- other replicas read this row for 409 / stop / status. turnId lets a
-- late release from an evicted turn leave its successor alone.
CREATE TABLE IF NOT EXISTS web_live_turns (
    userId TEXT PRIMARY KEY,
    turnId TEXT NOT NULL,
    startedAtMs INTEGER NOT NULL,
    conversationId INTEGER,
    aborted INTEGER NOT NULL DEFAULT 0 CHECK (aborted IN (0, 1)),
    -- Snapshot of the in-flight reply (draft + thinking/tool steps) so a
    -- browser that left and came back can restore progress without waiting
    -- for the turn to settle.
    progressJson TEXT,
    -- Last time the turn showed progress (token, tool start/result,
    -- typing). The watchdog evicts a turn that has gone quiet, not one
    -- that is merely old: a long project turn is still working.
    lastActivityAtMs INTEGER
);

-- Follow-up Study messages waiting for the current in-flight turn to
-- finish. Drained one at a time through startTurn (same per-user lock).
CREATE TABLE IF NOT EXISTS web_chat_queue (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    conversationId INTEGER,
    position INTEGER NOT NULL,
    message TEXT NOT NULL,
    imagesJson TEXT,
    filesJson TEXT,
    incognito INTEGER NOT NULL DEFAULT 0 CHECK (incognito IN (0, 1)),
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_web_chat_queue_user ON web_chat_queue (userId, position);

-- ---------------------------------------------------------------------------
-- The attention ledger (services/attention*.js, documentation/attention.md).
--
-- The knowledge graph answers "what does Goobster know?". This layer answers
-- the different question "what currently matters to this person?" - a small,
-- volatile working set of open loops that initiative is reasoned about
-- against. An attention item is NOT a task and NOT an automation: it is
-- something Goobster believes to be currently relevant, with confidence and
-- provenance, which may quietly expire without ever being acted on.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS attention_items (
    id INTEGER PRIMARY KEY,
    -- Conversation scope the loop was observed in ('dm:<userId>' or a guild id)
    guildId TEXT NOT NULL,
    -- Attention is per-person, not per-channel: this is whose loop it is
    userId TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'open_question'
        CHECK (kind IN ('goal', 'commitment', 'deadline', 'open_question',
                        'waiting_for', 'opportunity', 'concern')),
    -- Short stable handle ("dbt demo") - the item's identity within a scope
    subject TEXT NOT NULL COLLATE NOCASE,
    -- What Goobster believes the person is trying to reach
    goal TEXT,
    -- JSON array of the still-unresolved threads inside this loop
    unresolved TEXT,
    -- Lifecycle: a mined loop starts uncertain and has to earn promotion.
    state TEXT NOT NULL DEFAULT 'candidate'
        CHECK (state IN ('candidate', 'corroborated', 'active', 'resolved', 'abandoned')),
    importance REAL NOT NULL DEFAULT 0.5,
    -- How sure Goobster is that it understands the loop correctly
    confidence REAL NOT NULL DEFAULT 0.5,
    -- Per-item initiative ceiling; NULL inherits the user's policy level
    allowedInitiative TEXT
        CHECK (allowedInitiative IS NULL
               OR allowedInitiative IN ('observe', 'nudge', 'assist', 'delegate')),
    -- Agency-boundary bucket (research / calendar / github / ...)
    category TEXT NOT NULL DEFAULT 'general',
    deadlineAt TEXT,
    lastActivityAt TEXT,
    -- Past this the loop is stale by construction and stops being surfaced
    expiresAt TEXT,
    -- Independent corroborations seen (candidate -> corroborated promotion)
    corroborations INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    resolvedAt TEXT,
    UNIQUE (guildId, userId, kind, subject)
);

CREATE INDEX IF NOT EXISTS idx_attention_items_user ON attention_items(userId, state);
CREATE INDEX IF NOT EXISTS idx_attention_items_scope ON attention_items(guildId, userId, state);
CREATE INDEX IF NOT EXISTS idx_attention_items_deadline ON attention_items(state, deadlineAt);

-- Why Goobster believes an item exists. Same traceability contract as
-- kg_provenance: every mined loop can be traced back to its evidence, which
-- is what makes an uncertain candidate reviewable rather than a hallucination.
CREATE TABLE IF NOT EXISTS attention_provenance (
    id INTEGER PRIMARY KEY,
    itemId INTEGER NOT NULL REFERENCES attention_items(id) ON DELETE CASCADE,
    sourceKind TEXT NOT NULL
        CHECK (sourceKind IN ('memory', 'kg_node', 'message', 'observatory_job',
                              'followup', 'automation', 'reflection', 'user',
                              'tool', 'event')),
    sourceId TEXT,
    detail TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (itemId, sourceKind, sourceId)
);

CREATE INDEX IF NOT EXISTS idx_attention_provenance_item ON attention_provenance(itemId);

-- The assistant inbox: one row per intervention Goobster considered worth
-- surfacing, with the score inputs that produced the decision.
--
-- dedupeKey is the load-bearing column. Candidates are re-derived
-- deterministically from durable state on every sweep, so idempotence comes
-- from "a notice with this key already exists", not from remembering events.
CREATE TABLE IF NOT EXISTS attention_notices (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    itemId INTEGER REFERENCES attention_items(id) ON DELETE SET NULL,
    dedupeKey TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    title TEXT NOT NULL,
    detail TEXT,
    -- Score inputs, kept so "why did you tell me this?" is answerable and so
    -- thresholds can be calibrated against real outcomes
    urgency REAL NOT NULL DEFAULT 0,
    importance REAL NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0,
    actionability REAL NOT NULL DEFAULT 0,
    interruptionCost REAL NOT NULL DEFAULT 0,
    score REAL NOT NULL DEFAULT 0,
    -- How loudly this was allowed to land (after policy clamping)
    disposition TEXT NOT NULL DEFAULT 'inbox'
        CHECK (disposition IN ('inbox', 'mention', 'dm', 'urgent')),
    status TEXT NOT NULL DEFAULT 'surfaced'
        CHECK (status IN ('surfaced', 'delivered', 'opened', 'dismissed',
                          'acted_on', 'snoozed', 'expired')),
    reason TEXT,
    deliveredAt TEXT,
    snoozeUntil TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (userId, dedupeKey)
);

CREATE INDEX IF NOT EXISTS idx_attention_notices_user ON attention_notices(userId, status, createdAt);
CREATE INDEX IF NOT EXISTS idx_attention_notices_pending
    ON attention_notices(userId, disposition, status);

-- Intervention outcomes, per category. Dismissal is feedback: these rows are
-- what raise the bar for categories a person keeps waving off, and lower it
-- for the ones they act on.
CREATE TABLE IF NOT EXISTS attention_feedback (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    noticeId INTEGER REFERENCES attention_notices(id) ON DELETE SET NULL,
    category TEXT NOT NULL DEFAULT 'general',
    signal TEXT NOT NULL
        CHECK (signal IN ('surfaced', 'opened', 'dismissed', 'acted_on',
                          'snoozed', 'useful', 'annoying')),
    score REAL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attention_feedback_user
    ON attention_feedback(userId, category, createdAt);

-- Watches: the third scheduling primitive. A follow-up waits for a TIME and
-- an automation repeats on a CRON; a watch waits for a CONDITION - one
-- domain event matching a topic (and optional payload predicate) triggers a
-- full agent turn once, then the watch is spent. No cron job involved.
CREATE TABLE IF NOT EXISTS attention_watches (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    -- Conversation scope the turn runs in ('dm:<userId>' or a guild id)
    guildId TEXT NOT NULL,
    channelId TEXT,
    label TEXT NOT NULL COLLATE NOCASE,
    -- Domain event topic, optionally trailing-wildcard ('observatory.*')
    topic TEXT NOT NULL,
    -- JSON map of payload fields that must match for the watch to fire
    condition TEXT,
    promptText TEXT NOT NULL,
    itemId INTEGER REFERENCES attention_items(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'ARMED'
        CHECK (status IN ('ARMED', 'FIRING', 'FIRED', 'EXPIRED', 'CANCELLED', 'FAILED')),
    fireCount INTEGER NOT NULL DEFAULT 0,
    maxFires INTEGER NOT NULL DEFAULT 1,
    expiresAt TEXT,
    lastFiredAt TEXT,
    lastError TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    -- Mission start-attempt correlation (see observatory_jobs.executionAttemptId)
    executionAttemptId TEXT,
    UNIQUE (userId, label)
);

CREATE INDEX IF NOT EXISTS idx_attention_watches_armed ON attention_watches(status, topic);
CREATE INDEX IF NOT EXISTS idx_attention_watches_user ON attention_watches(userId, status);
CREATE INDEX IF NOT EXISTS idx_attention_watches_execution_attempt
    ON attention_watches(executionAttemptId) WHERE executionAttemptId IS NOT NULL;

-- Per-user initiative policy. Enrollment is explicit (same opt-in shape as
-- /proactive and /monologue): no row means the attention system does not run
-- for that person at all.
CREATE TABLE IF NOT EXISTS attention_policies (
    userId TEXT PRIMARY KEY,
    -- The initiative spectrum, least to most agency
    initiative TEXT NOT NULL DEFAULT 'nudge'
        CHECK (initiative IN ('observe', 'nudge', 'assist', 'delegate')),
    -- JSON map of category -> { proactiveRead, proactiveCompute, externalWrite }
    boundaries TEXT,
    -- Do-not-disturb window, minutes from UTC midnight (NULL = always open).
    -- Inbox notices still accumulate; only outbound contact is held.
    quietStartMinute INTEGER,
    quietEndMinute INTEGER,
    maxContactsPerDay INTEGER NOT NULL DEFAULT 3,
    contactCooldownMinutes INTEGER NOT NULL DEFAULT 180,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Personal heartbeat bookkeeping, in the database because cooldowns and
-- budgets must survive a restart (the heartbeat_state rule, per person).
CREATE TABLE IF NOT EXISTS attention_state (
    userId TEXT PRIMARY KEY,
    lastSweepAt TEXT,
    lastContactAt TEXT,
    -- Set by a domain event so the next sweep looks at this person first
    -- instead of waiting for their turn in the rotation
    dirtyAt TEXT,
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Spitball Expeditions: autonomous research runs that grow a region of the
-- user's knowledge graph (user-facing name: Spitball). Spec:
-- documentation/spitball_expeditions.md
--
-- An Expedition runs recursive Cycles: plan -> search -> Sources -> Claims ->
-- atomic Notes/Tags/Connections -> legalizer -> coverage -> Leads -> next
-- cycle. Generated knowledge lives in the existing kg_* tables and is only
-- ever written through the knowledge graph legalizer; the tables here hold
-- the durable research state and the evidence trail
-- (kg_provenance.sourceKind 'research_claim' -> research_claims.id).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS spitball_expeditions (
    id INTEGER PRIMARY KEY,
    modelConfigJson TEXT,
    userId TEXT NOT NULL,
    -- Where generated knowledge is written. A personal expedition targets the
    -- user's personal graph: guildId 'dm:<userId>' (portal default) or a real
    -- guild snowflake, scopeKey 'USER:<userId>'.
    guildId TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT '',
    -- The immutable research inputs (the Seed never changes even as cycles
    -- expand away from the exact phrase; the Intent stays visible to every
    -- cycle so recursion cannot drift from the user's purpose)
    seed TEXT NOT NULL,
    lensId TEXT,
    lensText TEXT,
    intent TEXT,
    depth TEXT NOT NULL DEFAULT 'standard'
        CHECK (depth IN ('focused', 'standard', 'deep')),
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED')),
    -- Hard budgets, resolved from the depth preset at creation time so the
    -- run is reproducible even if presets are retuned later
    maxCycles INTEGER NOT NULL DEFAULT 3,
    maxSources INTEGER NOT NULL DEFAULT 25,
    maxNotes INTEGER NOT NULL DEFAULT 60,
    currentCycle INTEGER NOT NULL DEFAULT 0,
    -- Whole-run rollups kept current after each cycle so list views are cheap
    sourcesAccepted INTEGER NOT NULL DEFAULT 0,
    notesCreated INTEGER NOT NULL DEFAULT 0,
    edgesCreated INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    stopReason TEXT,
    lastError TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    startedAt TEXT,
    finishedAt TEXT,
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    -- The run lease: which process claimed the run, renewed between pipeline
    -- stages. A RUNNING row whose heartbeat has gone stale
    -- (spitballConfig.staleRunMinutes) and that no live loop in this process
    -- is driving is an orphan; a fresh heartbeat means another process
    -- legitimately owns it.
    runnerId TEXT,
    lastHeartbeatAt TEXT,
    -- Research brief: how wide/deep to search given seed + intent (JSON).
    -- Written before cycle 1 and updated as units are discovered/covered.
    researchBriefJson TEXT,
    -- When a budget stop leaves the original intent unfinished, a structured
    -- proposal the owner can accept to run more cycles (JSON).
    continuationProposalJson TEXT,
    -- Optional project target (documentation/projects_redesign_plan.md §13).
    -- When set, generated knowledge writes to guildId dm:<ownerId>,
    -- scopeKey PROJECT:<projectId>. Budgets still charge this row's userId.
    projectId INTEGER,
    -- Mission start-attempt correlation (see observatory_jobs.executionAttemptId)
    executionAttemptId TEXT
);

CREATE INDEX IF NOT EXISTS idx_spitball_expeditions_user ON spitball_expeditions(userId, status, id);
CREATE INDEX IF NOT EXISTS idx_spitball_expeditions_execution_attempt
    ON spitball_expeditions(executionAttemptId) WHERE executionAttemptId IS NOT NULL;

-- One row per Expedition Cycle. Durable status per cycle so the UI can
-- recover across bot/api process boundaries; the frontier columns carry the
-- compact recursive state (never a prior model transcript).
CREATE TABLE IF NOT EXISTS spitball_expedition_cycles (
    id INTEGER PRIMARY KEY,
    expeditionId INTEGER NOT NULL REFERENCES spitball_expeditions(id) ON DELETE CASCADE,
    cycleNumber INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'RUNNING'
        CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
    -- Structured stage outputs (bounded JSON; caps in spitballConfig)
    researchPlanJson TEXT,
    -- Compact recursive input handed to this cycle: original seed/lens/intent,
    -- previous Leads, new-knowledge summaries, unresolved questions, coverage,
    -- avoid-repeating list
    frontierInputJson TEXT,
    -- Ranked Leads this cycle produced for the next one
    frontierOutputJson TEXT,
    coverageSummaryJson TEXT,
    -- Exact legalized results (auditability: what the run actually changed)
    sourceCount INTEGER NOT NULL DEFAULT 0,
    sourcesAccepted INTEGER NOT NULL DEFAULT 0,
    claimsExtracted INTEGER NOT NULL DEFAULT 0,
    notesProposed INTEGER NOT NULL DEFAULT 0,
    notesCreated INTEGER NOT NULL DEFAULT 0,
    notesMerged INTEGER NOT NULL DEFAULT 0,
    edgesCreated INTEGER NOT NULL DEFAULT 0,
    tagsAdded INTEGER NOT NULL DEFAULT 0,
    conflictsFound INTEGER NOT NULL DEFAULT 0,
    noveltyScore REAL,
    coverageScore REAL,
    startedAt TEXT NOT NULL DEFAULT (datetime('now')),
    finishedAt TEXT,
    lastError TEXT,
    UNIQUE (expeditionId, cycleNumber)
);

CREATE INDEX IF NOT EXISTS idx_spitball_cycles_expedition ON spitball_expedition_cycles(expeditionId, cycleNumber);

-- Normalized research Sources: every provider adapter produces this shape
-- before downstream processing. Rows are user-scoped (MVP privacy rule) and
-- cascade with their expedition; dedupe within an expedition is by canonical
-- URL (NULLs stay distinct on both engines) and content hash in the service.
CREATE TABLE IF NOT EXISTS research_sources (
    id INTEGER PRIMARY KEY,
    expeditionId INTEGER NOT NULL REFERENCES spitball_expeditions(id) ON DELETE CASCADE,
    cycleId INTEGER REFERENCES spitball_expedition_cycles(id) ON DELETE SET NULL,
    userId TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'web',
    sourceType TEXT,
    url TEXT,
    canonicalUrl TEXT,
    title TEXT,
    author TEXT,
    publisher TEXT,
    publishedAt TEXT,
    retrievedAt TEXT NOT NULL DEFAULT (datetime('now')),
    contentHash TEXT,
    -- Bounded normalized text (cap in spitballConfig). Large originals belong
    -- in kg_artifacts, never here.
    extractedText TEXT,
    metadataJson TEXT,
    relevanceScore REAL,
    qualityScore REAL,
    noveltyScore REAL,
    accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
    rejectionReason TEXT,
    UNIQUE (expeditionId, canonicalUrl)
);

CREATE INDEX IF NOT EXISTS idx_research_sources_expedition ON research_sources(expeditionId, accepted);
CREATE INDEX IF NOT EXISTS idx_research_sources_user ON research_sources(userId);

-- Structured evidence units extracted from an accepted Source. Claims are
-- the provenance bridge: a generated note's kg_provenance row points at a
-- claim ('research_claim'), and the claim resolves to its source here - so
-- "why does this note say this?" always has an answer.
CREATE TABLE IF NOT EXISTS research_claims (
    id INTEGER PRIMARY KEY,
    sourceId INTEGER NOT NULL REFERENCES research_sources(id) ON DELETE CASCADE,
    expeditionId INTEGER NOT NULL REFERENCES spitball_expeditions(id) ON DELETE CASCADE,
    cycleId INTEGER REFERENCES spitball_expedition_cycles(id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'factual'
        CHECK (kind IN ('factual', 'interpretive', 'quantitative', 'causal', 'historical', 'methodological', 'reported_opinion', 'hypothesis')),
    confidence REAL NOT NULL DEFAULT 0.5,
    sourceLocation TEXT,
    metadataJson TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_research_claims_source ON research_claims(sourceId);
CREATE INDEX IF NOT EXISTS idx_research_claims_expedition ON research_claims(expeditionId, cycleId);

-- Research briefs (roadmap #254, documentation/research_brief.md): a private
-- artifact written from one Expedition's stored sources and claims. The
-- generated text is immutable once the row is READY - generatedJson and its
-- hash are written exactly once and no code path updates them; every later
-- change lives in the separate edit overlay (overlayJson) or the owner's
-- review record (reviewJson). Acceptance and actual use are explicit owner
-- actions, recorded apart from generation success and apart from the
-- owner-judged quality gates. Rows cascade with the expedition and are
-- denormalized on userId (the expedition's owner) for erasure and audit;
-- payer records who was charged for the generation call (the expedition's
-- billing rule: the project owner for a project expedition).
CREATE TABLE IF NOT EXISTS expedition_briefs (
    id INTEGER PRIMARY KEY,
    expeditionId INTEGER NOT NULL REFERENCES spitball_expeditions(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    payer TEXT,
    status TEXT NOT NULL DEFAULT 'GENERATING'
        CHECK (status IN ('GENERATING', 'READY', 'FAILED')),
    -- Immutable once READY: { summary, findings, limitations, citations,
    -- evidenceNotes, evidence } plus its sha256 for integrity checks
    generatedJson TEXT,
    generatedHash TEXT,
    generatedAt TEXT,
    promptVersion INTEGER,
    modelProvider TEXT,
    modelName TEXT,
    -- A failed generation keeps its row (the attempt counts toward cost);
    -- the machine code and clipped message, never model output
    errorCode TEXT,
    lastError TEXT,
    -- The edit overlay: { edits: [{ target, text, type, note, editedAt }] };
    -- target is 'summary', 'finding:<id>' or 'limitation:<id>', type is
    -- 'wording' | 'factual'. Optimistic concurrency through overlayRevision.
    overlayJson TEXT,
    overlayRevision INTEGER NOT NULL DEFAULT 0,
    -- The owner's review: per-finding marks (supported / unsupported /
    -- missing a qualification), the three judged gates and notes. Every
    -- field starts unset; a blank field is unreviewed, never a pass.
    reviewJson TEXT,
    reviewRevision INTEGER NOT NULL DEFAULT 0,
    -- Explicit owner actions, independent of generation and of quality
    acceptedAt TEXT,
    usedAt TEXT,
    useNote TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expedition_briefs_expedition ON expedition_briefs(expeditionId, id);
CREATE INDEX IF NOT EXISTS idx_expedition_briefs_user ON expedition_briefs(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_expedition_briefs_payer ON expedition_briefs(payer) WHERE payer IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Project Missions: durable intent and evaluation for one piece of project
-- work (services/projectMissionService.js). The model proposes a plan;
-- code owns permissions, budgets, transitions, and what counts as done.
-- One open mission per project (DRAFT/APPROVED/ACTIVE/BLOCKED/REVIEW).
-- COMPLETED and CANCELLED free the slot. Spec: documentation/projects.md.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_missions (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    -- Denormalized owner so erasure and audits never need a join
    userId TEXT NOT NULL,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    -- JSON array of { id, text } — measurable success criteria
    successCriteriaJson TEXT NOT NULL,
    -- Optional UTC deadline (YYYY-MM-DD HH:MM:SS)
    deadline TEXT,
    -- Optional JSON { maxExpeditions, maxJobs, maxWatches, notes }
    budgetJson TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'REVIEW', 'COMPLETED', 'CANCELLED')),
    -- Final review comparing evidence against the original criteria (JSON)
    reviewJson TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    approvedAt TEXT,
    approvedBy TEXT,
    -- Monotonic plan revision. Approval freezes approvedRevision to this
    -- value; any later plan mutation increments planRevision and clears
    -- the approval so the human must confirm the new plan.
    planRevision INTEGER NOT NULL DEFAULT 1,
    approvedRevision INTEGER,
    startedAt TEXT,
    completedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_project_missions_project ON project_missions(projectId, status);
CREATE INDEX IF NOT EXISTS idx_project_missions_user ON project_missions(userId, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_missions_one_open
    ON project_missions(projectId)
    WHERE status IN ('DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'REVIEW');

CREATE TABLE IF NOT EXISTS project_mission_steps (
    id INTEGER PRIMARY KEY,
    missionId INTEGER NOT NULL REFERENCES project_missions(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('expedition', 'job', 'watch', 'human')),
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'READY', 'STARTING', 'RUNNING', 'BLOCKED', 'DONE', 'SKIPPED', 'FAILED')),
    -- JSON array of step ids that must be DONE before this one is READY
    dependsOnJson TEXT,
    requiresApproval INTEGER NOT NULL DEFAULT 0 CHECK (requiresApproval IN (0, 1)),
    -- Soft links to existing subsystems (no FK: those rows have their own life)
    expeditionId INTEGER,
    jobId INTEGER,
    watchId INTEGER,
    actionParamsJson TEXT,
    -- Claim token for READY → STARTING → RUNNING. Concurrent startStep
    -- callers lose the atomic UPDATE; a crash mid-launch leaves STARTING
    -- for reconcileStartingSteps to repair. The same token is written
    -- onto the child job / expedition / watch so an unlinked child can
    -- be adopted after a crash.
    executionAttemptId TEXT,
    -- Actor who claimed the start (project-authorized). Cancel of the
    -- child uses the child's own owner row, not this field.
    startedByUserId TEXT,
    -- Plan revision this step was added under. Starting a step requires
    -- it to be at or below the mission's approvedRevision.
    planRevision INTEGER NOT NULL DEFAULT 0,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    startedAt TEXT,
    finishedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_project_mission_steps_mission
    ON project_mission_steps(missionId, sortOrder);
CREATE INDEX IF NOT EXISTS idx_project_mission_steps_user ON project_mission_steps(userId);
CREATE INDEX IF NOT EXISTS idx_project_mission_steps_job ON project_mission_steps(jobId);
CREATE INDEX IF NOT EXISTS idx_project_mission_steps_expedition ON project_mission_steps(expeditionId);
CREATE INDEX IF NOT EXISTS idx_project_mission_steps_watch ON project_mission_steps(watchId);

CREATE TABLE IF NOT EXISTS project_mission_evidence (
    id INTEGER PRIMARY KEY,
    missionId INTEGER NOT NULL REFERENCES project_missions(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    -- Optional link to a success-criterion id from successCriteriaJson
    criterionId TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('claim', 'note', 'job', 'artifact')),
    -- research_claims.id / kg_nodes.id / observatory_jobs.id / project_assets.id
    refId INTEGER NOT NULL,
    label TEXT,
    polarity TEXT NOT NULL DEFAULT 'for'
        CHECK (polarity IN ('for', 'against', 'neutral')),
    -- { scope: 'project'|'imported', expeditionId?, sourceProjectId? }
    provenanceJson TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_mission_evidence_mission
    ON project_mission_evidence(missionId);
CREATE INDEX IF NOT EXISTS idx_project_mission_evidence_user
    ON project_mission_evidence(userId);
-- One link per (mission, criterion, kind, ref). Existing NULL criterionId
-- rows are rewritten to '' in repairMissionUniques before this index is
-- created, so uniqueness is NULL-safe on both engines.
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_mission_evidence_unique
    ON project_mission_evidence(missionId, criterionId, kind, refId);

-- Append-only timeline. Never UPDATE/DELETE except via mission CASCADE.
CREATE TABLE IF NOT EXISTS project_mission_events (
    id INTEGER PRIMARY KEY,
    missionId INTEGER NOT NULL REFERENCES project_missions(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    kind TEXT NOT NULL,
    payloadJson TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_mission_events_mission
    ON project_mission_events(missionId, id);
CREATE INDEX IF NOT EXISTS idx_project_mission_events_user
    ON project_mission_events(userId);

-- Human-originated confirmation receipts. The agent tool cannot mint
-- these; approve() and complete() each consume one bound to the current
-- planRevision. kind distinguishes the two human-only verbs.
CREATE TABLE IF NOT EXISTS project_mission_approval_receipts (
    id INTEGER PRIMARY KEY,
    missionId INTEGER NOT NULL REFERENCES project_missions(id) ON DELETE CASCADE,
    userId TEXT NOT NULL,
    nonce TEXT NOT NULL,
    planRevision INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('portal', 'discord')),
    kind TEXT NOT NULL DEFAULT 'approve' CHECK (kind IN ('approve', 'complete')),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    expiresAt TEXT NOT NULL,
    consumedAt TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_mission_approval_receipts_nonce
    ON project_mission_approval_receipts(nonce);
CREATE INDEX IF NOT EXISTS idx_project_mission_approval_receipts_mission
    ON project_mission_approval_receipts(missionId, consumedAt);

-- Thin decision record written when a mission completes (the Learn phase).
-- Full Decision Records (reopen conditions, prediction vs outcome) come later.
CREATE TABLE IF NOT EXISTS project_decisions (
    id INTEGER PRIMARY KEY,
    projectId INTEGER NOT NULL REFERENCES observatory_projects(id) ON DELETE CASCADE,
    missionId INTEGER REFERENCES project_missions(id) ON DELETE SET NULL,
    userId TEXT NOT NULL,
    question TEXT NOT NULL,
    alternativesJson TEXT,
    evidenceJson TEXT,
    selectedAction TEXT,
    expectedOutcomesJson TEXT,
    reopenWhen TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_decisions_project ON project_decisions(projectId, id);
CREATE INDEX IF NOT EXISTS idx_project_decisions_user ON project_decisions(userId);
CREATE INDEX IF NOT EXISTS idx_project_decisions_mission ON project_decisions(missionId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_decisions_one_per_mission
    ON project_decisions(missionId)
    WHERE missionId IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Self-knowledge: Goobster's own documentation, seeded from the repository
-- (documentation/**/*.md, README.md, operator docs under data/self-docs/).
-- One row per chunk of a document; the seeder is idempotent on contentHash.
-- Not per-user data: no privacy erasure path needed.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS self_docs (
    id INTEGER PRIMARY KEY,
    -- Stable document id derived from the repo-relative path, e.g.
    -- documentation/code_sandbox or documentation/skills/troubleshooting
    slug TEXT NOT NULL,
    relPath TEXT NOT NULL,
    title TEXT NOT NULL,
    -- guide | reference | standards | decision | skill
    kind TEXT NOT NULL DEFAULT 'reference',
    summary TEXT,
    -- Skill docs: one line saying when the procedure applies (front matter)
    useWhen TEXT,
    -- JSON array of lowercase tags (front matter)
    tags TEXT,
    chunkIndex INTEGER NOT NULL,
    -- Title > Section > Subsection breadcrumb for the chunk
    headingPath TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    contentHash TEXT NOT NULL,
    -- Optional semantic-search vector (same tagging rule as memory_embeddings:
    -- vectors are only compared when produced by the same model)
    embedding BLOB,
    dims INTEGER,
    model TEXT,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (slug, chunkIndex)
);

CREATE INDEX IF NOT EXISTS idx_self_docs_kind ON self_docs(kind);

-- ---------------------------------------------------------------------------
-- Unified User Settings and Revisions
-- ---------------------------------------------------------------------------

-- Synced personal preferences. Existing AI/voice/instructions stay in their
-- authoritative stores (guild_settings, user_nicknames, UserPreferences,
-- attention_policies); this table stores newly introduced synced preferences.
CREATE TABLE IF NOT EXISTS user_settings (
    userId TEXT PRIMARY KEY,
    schemaVersion INTEGER NOT NULL DEFAULT 1,
    preferencesJson TEXT NOT NULL DEFAULT '{}',
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Durable per-user, per-section revision records for optimistic concurrency control
-- across the unified settings facade and multiple authoritative storage tables.
CREATE TABLE IF NOT EXISTS user_setting_revisions (
    userId TEXT NOT NULL,
    section TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (userId, section)
);


-- ---------------------------------------------------------------------------
-- Application identity (shared-instance Increment A)
-- ---------------------------------------------------------------------------
-- A principal is the canonical application identity every surface resolves
-- to. Legacy principals keep the Discord snowflake as their id so no
-- history, dm:<userId> scope, or project directory has to be rewritten;
-- native principals get an opaque usr_<uuid> id. The id format grants no
-- authority - portal entry needs an app_accounts row (an entitlement), and
-- guild access still needs a linked Discord identity plus a real
-- membership check.
CREATE TABLE IF NOT EXISTS principals (
    id TEXT PRIMARY KEY,
    displayName TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Portal entitlement. A principal without a row here has no application
-- account (historical bot users are not granted one by backfill).
-- entitlement records why the account exists: an accepted invitation, an
-- explicit migration of an existing Discord user, the operator bootstrap,
-- or open sign-up with a verified email address.
CREATE TABLE IF NOT EXISTS app_accounts (
    principalId TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
    loginName TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'operator')),
    entitlement TEXT NOT NULL CHECK (entitlement IN ('invite', 'migration', 'bootstrap', 'open')),
    credentialVersion INTEGER NOT NULL DEFAULT 1,
    sessionVersion INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- External identities linked to a principal. One external subject belongs
-- to exactly one principal; credential material never lives here.
CREATE TABLE IF NOT EXISTS auth_identities (
    id INTEGER PRIMARY KEY,
    principalId TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    issuer TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_principal ON auth_identities(principalId);

-- Native credentials (shared-instance Increment B). One salted, memory-hard
-- hash per principal; paramsJson records the algorithm and cost so a later
-- cost change re-hashes on next use instead of invalidating everyone.
CREATE TABLE IF NOT EXISTS password_credentials (
    principalId TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
    hash TEXT NOT NULL,
    paramsJson TEXT NOT NULL,
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-use invitations issued by an operator. Only the SHA-256 of the
-- token is stored; redemption is one atomic UPDATE so a race has exactly
-- one winner. An invite is not a login credential.
CREATE TABLE IF NOT EXISTS account_invites (
    id INTEGER PRIMARY KEY,
    tokenHash TEXT NOT NULL UNIQUE,
    issuedBy TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'operator')),
    note TEXT,
    expiresAt TEXT NOT NULL,
    consumedAt TEXT,
    consumedBy TEXT,
    revokedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Operator-issued, single-use, short-lived password reset tokens (hashed).
-- Distinct from invitations and from OAuth state.
CREATE TABLE IF NOT EXISTS recovery_tokens (
    id INTEGER PRIMARY KEY,
    tokenHash TEXT NOT NULL UNIQUE,
    principalId TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('password_reset')),
    issuedBy TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    consumedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recovery_tokens_principal ON recovery_tokens(principalId);

-- "Connect Discord" intents: the OAuth state nonce (hashed) bound to the
-- signed-in principal and session that started the link, so the callback
-- can tell a link from a login and refuse a state minted for someone else.
CREATE TABLE IF NOT EXISTS oauth_link_states (
    stateHash TEXT PRIMARY KEY,
    principalId TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    sessionId INTEGER NOT NULL,
    provider TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One optional email address per account (shared-instance Increment B.1).
-- `normalized` is the lower-cased, trimmed form and is unique across the
-- installation; `verifiedAt` is set only by a consumed verification token.
-- A verified address is a login identifier and the self-service recovery
-- channel; an unverified one is neither.
CREATE TABLE IF NOT EXISTS account_emails (
    principalId TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    normalized TEXT NOT NULL UNIQUE,
    verifiedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-use, short-lived email verification tokens (hashed). `normalized`
-- pins the address the link was sent to, so changing the address on the
-- account invalidates links mailed to the previous one.
CREATE TABLE IF NOT EXISTS email_tokens (
    id INTEGER PRIMARY KEY,
    tokenHash TEXT NOT NULL UNIQUE,
    principalId TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify')),
    normalized TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    consumedAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_principal ON email_tokens(principalId);

-- Open sign-ups waiting for their email to be verified. Nothing here is
-- an account: no principal, no app_accounts row, no credential. Verifying
-- the (hashed) token creates all three in one transaction; a sign-up that
-- is never verified expires and is pruned. One pending row per address -
-- signing up again replaces the earlier attempt.
CREATE TABLE IF NOT EXISTS pending_registrations (
    id INTEGER PRIMARY KEY,
    tokenHash TEXT NOT NULL UNIQUE,
    loginName TEXT NOT NULL,
    displayName TEXT,
    emailAddress TEXT NOT NULL,
    emailNormalized TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    paramsJson TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- The in-app inbox (shared-instance Increment C, spec §6). Every result
-- produced by unattended work for one person - a due reminder, a scheduled
-- task's reply, a watch that fired, an invitation, a notice the attention
-- system decided to raise - is written here FIRST, then optionally echoed
-- to Discord. `discordStatus` records that echo separately, so a failed DM
-- never loses the result and a retry never re-runs the work. Items are the
-- person's private data: erased by /forget-me, counted by auditUser.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbox_items (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    kind TEXT NOT NULL
        CHECK (kind IN ('reminder', 'task', 'watch', 'notice', 'invite', 'project', 'expedition', 'system')),
    title TEXT NOT NULL,
    body TEXT,
    -- Where it came from: 'followup:12', 'automation:3', 'watch:7', ...
    sourceType TEXT,
    sourceId TEXT,
    -- Portal deep link (path under /app), when there is somewhere to go
    link TEXT,
    -- JSON array of { url, name } attachments re-served by the file route
    attachmentsJson TEXT,
    -- Idempotency for producers that may re-derive the same result
    dedupeKey TEXT,
    readAt TEXT,
    archivedAt TEXT,
    -- The optional Discord echo of this item, tracked separately from the
    -- item itself: 'skipped' (no Discord identity / adapter), 'sent', 'failed'
    discordStatus TEXT NOT NULL DEFAULT 'skipped'
        CHECK (discordStatus IN ('skipped', 'sent', 'failed')),
    discordError TEXT,
    discordSentAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inbox_items_user ON inbox_items(userId, archivedAt, createdAt);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_dedupe ON inbox_items(userId, dedupeKey);

-- ---------------------------------------------------------------------------
-- Guided tutorials (Increment F1). Per-account, per-tutorial, versioned
-- progress with optimistic concurrency. Tour events never write user
-- knowledge, spend a provider call, or send an invitation. Feedback rows
-- are optional quality signals (F1 stores the table for erasure; the
-- feedback API arrives with authored tours). Spec:
-- documentation/guided_tutorials_spec.md.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tutorial_progress (
    accountId TEXT NOT NULL,
    tutorialId TEXT NOT NULL,
    version INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'not_started'
        CHECK (status IN (
            'not_started', 'in_progress', 'paused',
            'skipped', 'completed', 'finished_with_skips'
        )),
    currentStepId TEXT,
    completedStepIdsJson TEXT NOT NULL DEFAULT '[]',
    skippedStepIdsJson TEXT NOT NULL DEFAULT '[]',
    unavailableStepIdsJson TEXT NOT NULL DEFAULT '[]',
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (accountId, tutorialId, version)
);

CREATE INDEX IF NOT EXISTS idx_tutorial_progress_account
    ON tutorial_progress(accountId, updatedAt);

CREATE TABLE IF NOT EXISTS tutorial_events (
    accountId TEXT NOT NULL,
    tutorialId TEXT NOT NULL,
    version INTEGER NOT NULL,
    eventId TEXT NOT NULL,
    action TEXT NOT NULL,
    generation INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    stepId TEXT,
    -- Snapshot of progress after the event (idempotent retries return this)
    resultJson TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (accountId, tutorialId, version, eventId)
);

CREATE INDEX IF NOT EXISTS idx_tutorial_events_account
    ON tutorial_events(accountId, createdAt);

CREATE TABLE IF NOT EXISTS tutorial_preferences (
    accountId TEXT PRIMARY KEY,
    -- Account-level auto-start; does not rewrite completion history
    autoStart INTEGER NOT NULL DEFAULT 1 CHECK (autoStart IN (0, 1)),
    -- First-login Home orientation offered once (Pause/Escape does not re-seize)
    orientationOfferedAt TEXT,
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tutorial_feedback (
    id INTEGER PRIMARY KEY,
    accountId TEXT NOT NULL,
    tutorialId TEXT NOT NULL,
    version INTEGER NOT NULL,
    stepId TEXT,
    signal TEXT NOT NULL
        CHECK (signal IN ('unclear', 'couldnt_find', 'didnt_work')),
    freeText TEXT,
    route TEXT,
    errorCode TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tutorial_feedback_account
    ON tutorial_feedback(accountId, createdAt);
-- Short-lived execution admission. Lock rows serialize contenders on both engines.
CREATE TABLE IF NOT EXISTS admission_locks (resource TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS execution_admissions (
    id TEXT PRIMARY KEY,
    resource TEXT NOT NULL,
    actorId TEXT,
    scopeId TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'finished')),
    createdAt BIGINT NOT NULL,
    startedAt BIGINT,
    expiresAt BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_admission_resource ON execution_admissions(resource, expiresAt);

-- Installation-wide state that must survive a restart and be seen by every
-- process (documentation/backup_and_restore.md). One JSON value per key;
-- the 'paused' key is what a restored instance comes back with.
CREATE TABLE IF NOT EXISTS instance_state (
    key TEXT PRIMARY KEY,
    valueJson TEXT NOT NULL,
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per failed piece of work (roadmap #256): chat turns, research
-- runs, code runs, automations, deliveries. workId is the join key shared
-- with usage_reservations and resource_events. Never a prompt or a message
-- body - `reason` is a short operator-readable phrase. Erasure nulls the
-- actor and keeps the row, as usage_log does.
CREATE TABLE IF NOT EXISTS work_failures (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    workId TEXT,
    phase TEXT,
    code TEXT NOT NULL,
    reason TEXT,
    actor TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_failures_actor ON work_failures(actor, createdAt);
CREATE INDEX IF NOT EXISTS idx_work_failures_work ON work_failures(kind, workId);

-- Non-token cost (roadmap #256): search calls, sandbox seconds, retries -
-- one row per event, keyed by the same (workKind, workId) as work_failures
-- and usage_reservations so cost per accepted result is one join. Never a
-- query string or a body. Erasure nulls actor and payer, keeps the row.
CREATE TABLE IF NOT EXISTS resource_events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    provider TEXT,
    workKind TEXT,
    workId TEXT,
    actor TEXT,
    payer TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_resource_events_work ON resource_events(workKind, workId);
CREATE INDEX IF NOT EXISTS idx_resource_events_actor ON resource_events(actor, createdAt);
CREATE INDEX IF NOT EXISTS idx_resource_events_time ON resource_events(createdAt);

-- Token budget reservations (#248): held before admission, settled from
-- provider usage, released if work never started. Uncertain paid outcomes
-- settle at the estimate with reconcile = 1; never automatically retried.
CREATE TABLE IF NOT EXISTS usage_reservations (
    id INTEGER PRIMARY KEY,
    actor TEXT,
    payer TEXT NOT NULL,
    workKind TEXT NOT NULL,
    workId TEXT NOT NULL,
    admissionId TEXT,
    estimatedTokens INTEGER NOT NULL DEFAULT 0,
    actualTokens INTEGER,
    reconcile INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'settled', 'released')),
    idempotencyKey TEXT,
    expiresAt TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_reservations_idem ON usage_reservations(idempotencyKey);
CREATE INDEX IF NOT EXISTS idx_usage_reservations_payer ON usage_reservations(payer, createdAt);
CREATE INDEX IF NOT EXISTS idx_usage_reservations_work ON usage_reservations(workKind, workId);

-- What the operator changed (roadmap #256): accounts, invitations, sign-up,
-- limits and instance settings. Shown in the Host room; kept one year.
-- detailJson is small structured detail (a status, a role), never a token,
-- a password or an address. Erasure nulls actor and target, keeps the row.
CREATE TABLE IF NOT EXISTS operator_audit (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    actor TEXT,
    target TEXT,
    detailJson TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_operator_audit_time ON operator_audit(createdAt);
CREATE INDEX IF NOT EXISTS idx_operator_audit_actor ON operator_audit(actor, createdAt);

-- Inbox context references. No snapshot or draft content is stored here.
-- Deliberately no Inbox FK: a deleted item remains a removable, unavailable
-- chip and fails closed at send, rather than silently changing the question.
CREATE TABLE IF NOT EXISTS conversation_contexts (
    id INTEGER PRIMARY KEY,
    userId TEXT NOT NULL,
    inboxItemId INTEGER NOT NULL,
    webConversationId INTEGER REFERENCES web_conversations(id) ON DELETE CASCADE,
    parlorConversationId INTEGER REFERENCES parlor_conversations(id) ON DELETE CASCADE,
    CHECK ((webConversationId IS NOT NULL AND parlorConversationId IS NULL)
        OR (webConversationId IS NULL AND parlorConversationId IS NOT NULL)),
    UNIQUE (webConversationId, userId),
    UNIQUE (parlorConversationId, userId)
);
CREATE INDEX IF NOT EXISTS idx_conversation_contexts_owner ON conversation_contexts(userId, inboxItemId);
