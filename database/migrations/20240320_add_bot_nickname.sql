-- Add bot_nickname column if it doesn't exist
IF NOT EXISTS (
    SELECT * FROM sys.columns 
    WHERE name = 'bot_nickname' AND object_id = OBJECT_ID('guild_settings')
)
BEGIN
    ALTER TABLE guild_settings
    ADD bot_nickname NVARCHAR(32) NULL;

    PRINT 'Added bot_nickname column to guild_settings table';
END
ELSE
BEGIN
    PRINT 'bot_nickname column already exists in guild_settings table';
END
GO

-- Ensure the table exists for user nicknames
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'user_nicknames')
BEGIN
    CREATE TABLE user_nicknames (
        id INT IDENTITY(1,1) PRIMARY KEY,
        userId VARCHAR(255) NOT NULL,
        guildId VARCHAR(255) NOT NULL,
        nickname NVARCHAR(32) NOT NULL,
        createdAt DATETIME2 DEFAULT GETDATE() NOT NULL,
        updatedAt DATETIME2 DEFAULT GETDATE() NOT NULL,
        CONSTRAINT UQ_user_nicknames_user_guild UNIQUE (userId, guildId)
    );

    CREATE NONCLUSTERED INDEX idx_user_nicknames_user_guild
        ON user_nicknames(userId ASC, guildId ASC);

    PRINT 'Created user_nicknames table with indexes';
END
ELSE
BEGIN
    PRINT 'user_nicknames table already exists';
END
GO 