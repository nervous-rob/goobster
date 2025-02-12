CREATE TABLE [dbo].[messages] (
    [id]                  INT            IDENTITY (1, 1) NOT NULL,
    [conversationId]      INT            NOT NULL,
    [message]             NVARCHAR (MAX) NOT NULL,
    [createdAt]           DATETIME       DEFAULT (getdate()) NOT NULL,
    [guildConversationId] INT            NULL,
    [isBot]               BIT            DEFAULT ((0)) NOT NULL,
    [createdBy]           INT            NOT NULL,
    [metadata]            NVARCHAR (MAX) NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    FOREIGN KEY ([conversationId]) REFERENCES [dbo].[conversations] ([id])
);
GO

CREATE NONCLUSTERED INDEX [idx_messages_created_by]
    ON [dbo].[messages]([createdBy] ASC);
GO

ALTER TABLE [dbo].[messages]
    ADD CONSTRAINT [FK_Messages_Users] FOREIGN KEY ([createdBy]) REFERENCES [dbo].[users] ([id]);
GO

ALTER TABLE [dbo].[messages]
    ADD CONSTRAINT [FK_Messages_GuildConversations] FOREIGN KEY ([guildConversationId]) REFERENCES [dbo].[guild_conversations] ([id]);
GO

