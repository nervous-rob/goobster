CREATE TABLE [dbo].[conversations] (
    [id]                  INT    IDENTITY (1, 1) NOT NULL,
    [userId]              BIGINT NOT NULL,
    [promptId]            INT    NULL,
    [guildConversationId] INT    NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    FOREIGN KEY ([promptId]) REFERENCES [dbo].[prompts] ([id]),
    CONSTRAINT [FK_Conversations_GuildConversations] FOREIGN KEY ([guildConversationId]) REFERENCES [dbo].[guild_conversations] ([id]),
    CONSTRAINT [FK_Conversations_Prompts] FOREIGN KEY ([promptId]) REFERENCES [dbo].[prompts] ([id])
);
GO

ALTER TABLE [dbo].[conversations]
    ADD CONSTRAINT [FK_Conversations_GuildConversations] FOREIGN KEY ([guildConversationId]) REFERENCES [dbo].[guild_conversations] ([id]);
GO


ALTER TABLE [dbo].[conversations]
    ADD CONSTRAINT [FK_Conversations_Prompts] FOREIGN KEY ([promptId]) REFERENCES [dbo].[prompts] ([id]);
GO


CREATE NONCLUSTERED INDEX [IX_conversations_guild]
    ON [dbo].[conversations]([guildConversationId] ASC);
GO


CREATE NONCLUSTERED INDEX [IX_conversations_userId]
    ON [dbo].[conversations]([userId] ASC);
GO

