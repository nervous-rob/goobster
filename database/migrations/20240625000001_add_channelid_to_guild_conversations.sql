ALTER TABLE guild_conversations
ADD channelId NVARCHAR(255) NULL;

UPDATE guild_conversations 
SET channelId = '0';

ALTER TABLE guild_conversations
ALTER COLUMN channelId NVARCHAR(255) NOT NULL;