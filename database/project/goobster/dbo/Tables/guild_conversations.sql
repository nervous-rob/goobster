CREATE TABLE [dbo].[guild_conversations] (
    [id]        INT            IDENTITY (1, 1) NOT NULL,
    [guildId]   VARCHAR (255)  NOT NULL,
    [threadId]  VARCHAR (255)  NOT NULL,
    [promptId]  INT            NOT NULL,
    [createdAt] DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    [updatedAt] DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    [channelId] NVARCHAR (255) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    FOREIGN KEY ([promptId]) REFERENCES [dbo].[prompts] ([id])
);
GO

CREATE NONCLUSTERED INDEX [idx_guild_conversations_channel]
    ON [dbo].[guild_conversations]([channelId] ASC);
GO

CREATE NONCLUSTERED INDEX [idx_guild_thread]
    ON [dbo].[guild_conversations]([guildId] ASC, [threadId] ASC);
GO

