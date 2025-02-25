CREATE TABLE [dbo].[guild_settings] (
    [guildId]           VARCHAR (255)  NOT NULL,
    [thread_preference] VARCHAR (20)   DEFAULT ('ALWAYS_CHANNEL') NOT NULL,
    [search_approval]   VARCHAR (20)   DEFAULT ('REQUIRED') NOT NULL,
    [createdAt]         DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    [updatedAt]         DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([guildId] ASC)
);
GO

-- Add constraint to ensure thread_preference is one of the allowed values
ALTER TABLE [dbo].[guild_settings]
    ADD CONSTRAINT [CHK_thread_preference] CHECK ([thread_preference]='ALWAYS_THREAD' OR [thread_preference]='ALWAYS_CHANNEL');
GO

-- Add constraint to ensure search_approval is one of the allowed values
ALTER TABLE [dbo].[guild_settings]
    ADD CONSTRAINT [CHK_search_approval] CHECK ([search_approval]='REQUIRED' OR [search_approval]='NOT_REQUIRED');
GO

-- Create index for faster lookups
CREATE NONCLUSTERED INDEX [idx_guild_settings_guild]
    ON [dbo].[guild_settings]([guildId] ASC);
GO 