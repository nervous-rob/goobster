-- Add isDefault column to prompts table
ALTER TABLE prompts
ADD isDefault BIT NOT NULL DEFAULT 0;

-- Create guild_conversations table
CREATE TABLE guild_conversations (
    id INT IDENTITY(1,1) PRIMARY KEY,
    guildId VARCHAR(255) NOT NULL,
    threadId VARCHAR(255) NOT NULL,
    promptId INT NOT NULL,
    createdAt DATETIME2 NOT NULL DEFAULT GETDATE(),
    updatedAt DATETIME2 NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (promptId) REFERENCES prompts(id)
);

-- Add index for quick lookups
CREATE INDEX idx_guild_thread ON guild_conversations(guildId, threadId);

-- Add guildConversationId to messages table
ALTER TABLE messages
ADD guildConversationId INT NULL;

-- Add foreign key constraint
ALTER TABLE messages
ADD CONSTRAINT FK_Messages_GuildConversations
FOREIGN KEY (guildConversationId) REFERENCES guild_conversations(id);

-- Add isBot column to messages
ALTER TABLE messages
ADD isBot BIT NOT NULL DEFAULT 0; 