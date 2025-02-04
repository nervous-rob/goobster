CREATE TABLE [dbo].[users_backup] (
    [id]                   INT           IDENTITY (1, 1) NOT NULL,
    [username]             NVARCHAR (50) NOT NULL,
    [joinedAt]             DATETIME      NOT NULL,
    [activeConversationId] INT           NULL
);
GO

