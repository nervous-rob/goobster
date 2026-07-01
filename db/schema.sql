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

CREATE TABLE IF NOT EXISTS automations (
    id INTEGER PRIMARY KEY,
    userId INTEGER NOT NULL,
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
-- Adventure system
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS adventures (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    createdBy TEXT NOT NULL,
    settings TEXT NOT NULL,
    theme TEXT,
    setting TEXT NOT NULL,
    plotSummary TEXT NOT NULL,
    plotPoints TEXT NOT NULL,
    keyElements TEXT NOT NULL,
    winCondition TEXT NOT NULL,
    currentState TEXT,
    status TEXT NOT NULL DEFAULT 'initialized'
        CHECK (status IN ('initialized', 'active', 'completed', 'failed')),
    metadata TEXT,
    startedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completedAt TEXT,
    lastUpdated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_adventures_createdBy ON adventures(createdBy);
CREATE INDEX IF NOT EXISTS idx_adventures_status ON adventures(status);

CREATE TABLE IF NOT EXISTS parties (
    id INTEGER PRIMARY KEY,
    leaderId INTEGER NOT NULL REFERENCES users(id),
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    isActive INTEGER NOT NULL DEFAULT 1,
    adventureStatus TEXT NOT NULL DEFAULT 'RECRUITING'
        CHECK (adventureStatus IN ('RECRUITING', 'ACTIVE', 'COMPLETED', 'DISBANDED')),
    settings TEXT NOT NULL DEFAULT '{"maxSize": 4}',
    lastUpdated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    adventureId INTEGER REFERENCES adventures(id)
);

CREATE INDEX IF NOT EXISTS idx_parties_status ON parties(adventureStatus);
CREATE INDEX IF NOT EXISTS idx_parties_adventureId ON parties(adventureId);
CREATE INDEX IF NOT EXISTS idx_parties_leaderId ON parties(leaderId);

CREATE TABLE IF NOT EXISTS partyMembers (
    id INTEGER PRIMARY KEY,
    partyId INTEGER NOT NULL REFERENCES parties(id),
    userId INTEGER NOT NULL REFERENCES users(id),
    adventurerName TEXT NOT NULL,
    backstory TEXT,
    memberType TEXT NOT NULL DEFAULT 'member'
        CHECK (memberType IN ('leader', 'member', 'guest')),
    joinedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lastUpdated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (partyId, userId)
);

CREATE INDEX IF NOT EXISTS idx_partyMembers_userId ON partyMembers(userId);

CREATE TRIGGER IF NOT EXISTS trg_partyMembers_update
AFTER UPDATE ON partyMembers
BEGIN
    UPDATE partyMembers SET lastUpdated = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS partyAdventures (
    partyId INTEGER NOT NULL REFERENCES parties(id),
    adventureId INTEGER NOT NULL REFERENCES adventures(id),
    joinedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (partyId, adventureId)
);

CREATE TABLE IF NOT EXISTS adventureStates (
    id INTEGER PRIMARY KEY,
    adventureId INTEGER NOT NULL REFERENCES adventures(id),
    currentScene TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'failed')),
    history TEXT NOT NULL DEFAULT '[]',
    eventHistory TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL,
    progress TEXT NOT NULL,
    environment TEXT NOT NULL,
    flags TEXT NOT NULL DEFAULT '{}',
    variables TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lastUpdated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_adventureStates_adventureId ON adventureStates(adventureId);
CREATE INDEX IF NOT EXISTS idx_adventureStates_status ON adventureStates(status);

CREATE TABLE IF NOT EXISTS adventurerStates (
    id INTEGER PRIMARY KEY,
    adventureId INTEGER NOT NULL REFERENCES adventures(id),
    partyMemberId INTEGER NOT NULL REFERENCES partyMembers(id),
    health INTEGER NOT NULL DEFAULT 100,
    status TEXT DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'INJURED', 'INCAPACITATED', 'DEAD')),
    conditions TEXT,
    inventory TEXT,
    lastUpdated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_adventurerStates_status ON adventurerStates(status);

CREATE TABLE IF NOT EXISTS adventureImages (
    id INTEGER PRIMARY KEY,
    adventureId INTEGER NOT NULL REFERENCES adventures(id),
    imageType TEXT NOT NULL,
    referenceKey TEXT NOT NULL,
    imageUrl TEXT NOT NULL,
    styleParameters TEXT,
    generatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS decisionPoints (
    id INTEGER PRIMARY KEY,
    adventureId INTEGER NOT NULL REFERENCES adventures(id),
    partyMemberId INTEGER NOT NULL REFERENCES partyMembers(id),
    situation TEXT NOT NULL,
    choices TEXT NOT NULL,
    choiceMade TEXT,
    consequence TEXT,
    plotProgress TEXT,
    keyElementsUsed TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolvedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_decisionPoints_resolvedAt ON decisionPoints(resolvedAt);

CREATE TABLE IF NOT EXISTS resourceAllocations (
    id INTEGER PRIMARY KEY,
    adventureId INTEGER NOT NULL REFERENCES adventures(id),
    resourceType TEXT NOT NULL CHECK (resourceType IN ('tokens', 'images', 'api_calls')),
    limits TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    lastReset TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resetInterval INTEGER NOT NULL,
    allocated INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_resourceAllocations_type ON resourceAllocations(resourceType);
