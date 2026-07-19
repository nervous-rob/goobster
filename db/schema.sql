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
    personality_settings TEXT
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
-- Self-scheduled follow-ups (one-shot, created by the model or heartbeat)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    channelId TEXT NOT NULL,
    userId TEXT,
    note TEXT NOT NULL,
    dueAt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'CANCELLED')),
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
-- Knowledge graph (per-guild semantic network maintained by the internal
-- monologue). Nodes hold concepts/facts/opinions/experiences; edges are
-- typed semantic relationships between them. Edge rows cascade when either
-- endpoint node is deleted (foreign_keys is ON in db/index.js).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kg_nodes (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'concept'
        CHECK (type IN ('concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing')),
    label TEXT NOT NULL COLLATE NOCASE,
    content TEXT,
    -- 0..1: how central this node currently is to the persona's inner life
    salience REAL NOT NULL DEFAULT 0.5,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, label)
);

CREATE INDEX IF NOT EXISTS idx_kg_nodes_guild_salience ON kg_nodes(guildId, salience);

CREATE TABLE IF NOT EXISTS kg_edges (
    id INTEGER PRIMARY KEY,
    guildId TEXT NOT NULL,
    sourceId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    targetId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL COLLATE NOCASE,
    -- 0..1: strength of the semantic relationship
    weight REAL NOT NULL DEFAULT 0.5,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (guildId, sourceId, targetId, relation)
);

CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(sourceId);
CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(targetId);

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
