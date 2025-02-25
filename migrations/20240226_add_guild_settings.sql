-- Migration: Add guild_settings table
-- Date: 2024-02-26

-- Create guild_settings table if it doesn't exist
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'guild_settings')
BEGIN
    CREATE TABLE [dbo].[guild_settings] (
        [guildId]           VARCHAR (255)  NOT NULL,
        [thread_preference] VARCHAR (20)   DEFAULT ('ALWAYS_CHANNEL') NOT NULL,
        [createdAt]         DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
        [updatedAt]         DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
        PRIMARY KEY CLUSTERED ([guildId] ASC)
    );

    -- Add constraint to ensure thread_preference is one of the allowed values
    ALTER TABLE [dbo].[guild_settings]
        ADD CONSTRAINT [CHK_thread_preference] CHECK ([thread_preference]='ALWAYS_THREAD' OR [thread_preference]='ALWAYS_CHANNEL');

    -- Create index for faster lookups
    CREATE NONCLUSTERED INDEX [idx_guild_settings_guild]
        ON [dbo].[guild_settings]([guildId] ASC);
        
    PRINT 'Created guild_settings table';
END
ELSE
BEGIN
    PRINT 'guild_settings table already exists';
END 