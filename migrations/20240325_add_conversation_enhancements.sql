BEGIN TRANSACTION;

-- Create user preferences table
CREATE TABLE user_preferences (
    id INT IDENTITY(1,1) PRIMARY KEY,
    userId NVARCHAR(255) NOT NULL,
    guildId NVARCHAR(255) NOT NULL,
    preferredName NVARCHAR(255),
    interactionCount INT DEFAULT 0,
    lastInteraction DATETIME2,
    topics NVARCHAR(MAX),
    sentimentScore FLOAT DEFAULT 0,
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    updatedAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_user_guild UNIQUE (userId, guildId)
);

-- Create interaction metrics table
CREATE TABLE interaction_metrics (
    id INT IDENTITY(1,1) PRIMARY KEY,
    userId NVARCHAR(255) NOT NULL,
    guildId NVARCHAR(255) NOT NULL,
    responseTime INT,
    success BIT,
    errorType NVARCHAR(100),
    timestamp DATETIME2 DEFAULT GETUTCDATE()
);

-- Create conversation context table
CREATE TABLE conversation_context (
    id INT IDENTITY(1,1) PRIMARY KEY,
    guildConversationId INT NOT NULL,
    contextSummary NVARCHAR(MAX),
    lastUpdated DATETIME2 DEFAULT GETUTCDATE(),
    FOREIGN KEY (guildConversationId) REFERENCES guild_conversations(id)
);

-- Add indexes for performance
CREATE INDEX IX_user_preferences_user_guild ON user_preferences(userId, guildId);
CREATE INDEX IX_interaction_metrics_user_guild ON interaction_metrics(userId, guildId);
CREATE INDEX IX_conversation_context_guild ON conversation_context(guildConversationId);

COMMIT; 