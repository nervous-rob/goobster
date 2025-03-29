CREATE TABLE [dbo].[guild_settings] (
    [guildId]               VARCHAR (255)  NOT NULL,
    [thread_preference]     VARCHAR (20)   DEFAULT ('ALWAYS_CHANNEL') NOT NULL,
    [search_approval]       VARCHAR (20)   DEFAULT ('REQUIRED') NOT NULL,
    [createdAt]             DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    [updatedAt]             DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    [personality_directive] NVARCHAR (MAX) NULL,
    [dynamic_response]      VARCHAR (20)   DEFAULT ('DISABLED') NOT NULL,
    [bot_nickname]          NVARCHAR (32)  NULL,
    PRIMARY KEY CLUSTERED ([guildId] ASC),
    CONSTRAINT [CHK_dynamic_response] CHECK ([dynamic_response]='DISABLED' OR [dynamic_response]='ENABLED'),
    CONSTRAINT [CHK_search_approval] CHECK ([search_approval]='REQUIRED' OR [search_approval]='NOT_REQUIRED'),
    CONSTRAINT [CHK_thread_preference] CHECK ([thread_preference]='ALWAYS_THREAD' OR [thread_preference]='ALWAYS_CHANNEL')
);
GO

-- Add constraint to ensure thread_preference is one of the allowed values
-- Add constraint to ensure search_approval is one of the allowed values
-- Create index for faster lookups
CREATE NONCLUSTERED INDEX [idx_guild_settings_guild]
    ON [dbo].[guild_settings]([guildId] ASC);
GO 
