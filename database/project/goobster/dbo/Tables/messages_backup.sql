CREATE TABLE [dbo].[messages_backup] (
    [id]                  INT            IDENTITY (1, 1) NOT NULL,
    [conversationId]      INT            NOT NULL,
    [message]             NVARCHAR (MAX) NOT NULL,
    [createdAt]           DATETIME       NOT NULL,
    [guildConversationId] INT            NULL,
    [isBot]               BIT            NOT NULL,
    [createdBy]           INT            NOT NULL
);
GO

