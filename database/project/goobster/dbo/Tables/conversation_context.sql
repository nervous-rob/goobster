CREATE TABLE [dbo].[conversation_context] (
    [id]                  INT            IDENTITY (1, 1) NOT NULL,
    [guildConversationId] INT            NOT NULL,
    [contextSummary]      NVARCHAR (MAX) NULL,
    [lastUpdated]         DATETIME2 (7)  DEFAULT (getutcdate()) NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    FOREIGN KEY ([guildConversationId]) REFERENCES [dbo].[guild_conversations] ([id])
);
GO

CREATE NONCLUSTERED INDEX [IX_conversation_context_guild]
    ON [dbo].[conversation_context]([guildConversationId] ASC);
GO

