-- Only add column if it doesn't exist
IF NOT EXISTS (
    SELECT * FROM sys.columns 
    WHERE object_id = OBJECT_ID('messages') 
    AND name = 'guildConversationId'
)
BEGIN
    ALTER TABLE messages
    ADD guildConversationId INT NULL;
END

-- Only add constraint if it doesn't exist
IF NOT EXISTS (
    SELECT * FROM sys.foreign_keys 
    WHERE name = 'FK_Messages_GuildConversations'
)
BEGIN
    ALTER TABLE messages WITH CHECK 
    ADD CONSTRAINT FK_Messages_GuildConversations
    FOREIGN KEY (guildConversationId)
    REFERENCES guild_conversations(id);
END 