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
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolvedAt TEXT,
    resolvedBy TEXT
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
    expiresAt TEXT NOT NULL
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
    lastMessageAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_web_conversations_user ON web_conversations(userId, lastMessageAt);

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
    ownerId TEXT NOT NULL,
    title TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    lastMessageAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_parlor_conversations_owner ON parlor_conversations(ownerId, lastMessageAt);

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
