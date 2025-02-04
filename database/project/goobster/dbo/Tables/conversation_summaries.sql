CREATE TABLE [dbo].[conversation_summaries] (
    [id]                  INT           IDENTITY (1, 1) NOT NULL,
    [guildConversationId] INT           NOT NULL,
    [summary]             TEXT          NOT NULL,
    [messageCount]        INT           NOT NULL,
    [createdAt]           DATETIME2 (7) DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    FOREIGN KEY ([guildConversationId]) REFERENCES [dbo].[guild_conversations] ([id])
);
GO

CREATE NONCLUSTERED INDEX [idx_guild_conv_created]
    ON [dbo].[conversation_summaries]([guildConversationId] ASC, [createdAt] ASC);
GO

