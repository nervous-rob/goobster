CREATE TABLE [dbo].[users] (
    [id]                   INT            IDENTITY (1, 1) NOT NULL,
    [discordUsername]      NVARCHAR (255) NOT NULL,
    [discordId]            VARCHAR (255)  NOT NULL,
    [joinedAt]             DATETIME       DEFAULT (getdate()) NOT NULL,
    [activeConversationId] INT            NULL,
    [username]             NVARCHAR (50)  NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [FK_Users_Conversations] FOREIGN KEY ([activeConversationId]) REFERENCES [dbo].[conversations] ([id])
);
GO

ALTER TABLE [dbo].[users]
    ADD CONSTRAINT [FK_Users_Conversations] FOREIGN KEY ([activeConversationId]) REFERENCES [dbo].[conversations] ([id]);
GO

CREATE NONCLUSTERED INDEX [idx_users_discord]
    ON [dbo].[users]([discordUsername] ASC, [discordId] ASC);
GO

