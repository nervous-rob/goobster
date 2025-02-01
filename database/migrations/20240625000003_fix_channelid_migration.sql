-- Drop dependent foreign keys first
IF EXISTS (
    SELECT * FROM sys.foreign_keys
    WHERE name = 'FK_Messages_GuildConversations'
)
BEGIN
    ALTER TABLE messages DROP CONSTRAINT FK_Messages_GuildConversations;
END

-- Drop the index if exists
IF EXISTS (
    SELECT * FROM sys.indexes 
    WHERE name = 'idx_guild_conversations_channel'
)
BEGIN
    DROP INDEX idx_guild_conversations_channel ON guild_conversations;
END

-- Make column nullable temporarily
ALTER TABLE guild_conversations ALTER COLUMN channelId NVARCHAR(255) NULL;

-- Update existing records using threadId as fallback
UPDATE guild_conversations 
SET channelId = COALESCE(threadId, 'default-channel')
WHERE channelId IS NULL OR channelId = '0';

-- Make column non-nullable
ALTER TABLE guild_conversations ALTER COLUMN channelId NVARCHAR(255) NOT NULL;

-- Recreate index
CREATE NONCLUSTERED INDEX idx_guild_conversations_channel
ON guild_conversations (channelId);

-- Restore foreign key
ALTER TABLE messages WITH CHECK ADD 
CONSTRAINT FK_Messages_GuildConversations 
FOREIGN KEY (guildConversationId) 
REFERENCES guild_conversations (id); 