-- Drop existing foreign keys on messages table
DECLARE @DropFKSQL NVARCHAR(MAX) = '';
SELECT @DropFKSQL = @DropFKSQL + 
    'ALTER TABLE [dbo].[messages] DROP CONSTRAINT ' + QUOTENAME(name) + ';'
FROM sys.foreign_keys
WHERE parent_object_id = OBJECT_ID('dbo.messages');

IF LEN(@DropFKSQL) > 0
BEGIN
    PRINT 'Dropping foreign keys from messages:';
    PRINT @DropFKSQL;
    EXEC sp_executesql @DropFKSQL;
END;
GO

-- Create backup of messages
IF OBJECT_ID('dbo.messages_backup', 'U') IS NOT NULL
    DROP TABLE dbo.messages_backup;

SELECT * INTO messages_backup FROM dbo.messages;
GO

-- Drop and recreate messages table
DROP TABLE dbo.messages;
GO

-- Recreate table with original schema plus new columns
CREATE TABLE [dbo].[messages](
    [id] [int] IDENTITY(1,1) NOT NULL,
    [conversationId] [int] NOT NULL,
    [message] [nvarchar](max) NOT NULL,
    [createdAt] [datetime] NOT NULL DEFAULT (getdate()),
    [guildConversationId] [int] NULL,
    [isBot] [bit] NOT NULL DEFAULT (0),
    [createdBy] [int] NOT NULL
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
GO

-- Add primary key constraint
ALTER TABLE [dbo].[messages] ADD PRIMARY KEY CLUSTERED 
(
    [id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY];
GO

-- Copy data from backup
SET IDENTITY_INSERT dbo.messages ON;
INSERT INTO dbo.messages (
    id, 
    conversationId, 
    message, 
    createdAt, 
    guildConversationId, 
    isBot,
    createdBy
)
SELECT 
    m.id,
    m.conversationId,
    m.message,
    m.createdAt,
    m.guildConversationId,
    ISNULL(m.isBot, 0),
    CASE 
        WHEN m.isBot = 1 THEN (SELECT TOP 1 id FROM users WHERE isBot = 1)
        ELSE c.userId
    END as createdBy
FROM messages_backup m
LEFT JOIN conversations c ON m.conversationId = c.id;
SET IDENTITY_INSERT dbo.messages OFF;
GO

-- Restore original foreign keys
ALTER TABLE [dbo].[messages] WITH CHECK ADD FOREIGN KEY([conversationId])
REFERENCES [dbo].[conversations] ([id]);

ALTER TABLE [dbo].[messages] WITH CHECK ADD CONSTRAINT [FK_Messages_GuildConversations] 
FOREIGN KEY([guildConversationId])
REFERENCES [dbo].[guild_conversations] ([id]);

-- Add new foreign key for createdBy
ALTER TABLE [dbo].[messages] WITH CHECK ADD CONSTRAINT [FK_Messages_Users] 
FOREIGN KEY([createdBy])
REFERENCES [dbo].[users] ([id]);
GO

-- Add indexes for performance
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_messages_created_by' AND object_id = OBJECT_ID('dbo.messages'))
    CREATE INDEX idx_messages_created_by ON dbo.messages(createdBy);
GO

-- Verify data integrity
IF EXISTS (
    SELECT m.id FROM messages_backup m
    LEFT JOIN messages n ON m.id = n.id
    WHERE n.id IS NULL
)
BEGIN
    RAISERROR ('Data integrity check failed: Some messages were not migrated correctly', 16, 1);
    RETURN;
END;

-- Print row counts for verification
SELECT 'Backup messages count' as [Table], COUNT(*) as [Count] FROM messages_backup
UNION ALL
SELECT 'New messages count', COUNT(*) FROM messages;
GO

-- Optional: Drop backup table if everything is successful
-- DROP TABLE dbo.messages_backup;
-- GO 