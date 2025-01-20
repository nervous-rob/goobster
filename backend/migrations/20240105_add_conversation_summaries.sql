-- Create conversation_summaries table
CREATE TABLE conversation_summaries (
    id INT IDENTITY(1,1) PRIMARY KEY,
    guildConversationId INT NOT NULL,
    summary TEXT NOT NULL,
    messageCount INT NOT NULL,
    createdAt DATETIME2 NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (guildConversationId) REFERENCES guild_conversations(id)
);

-- Add index for quick lookups
CREATE INDEX idx_guild_conv_created ON conversation_summaries(guildConversationId, createdAt); 