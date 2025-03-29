CREATE TABLE [dbo].[user_preferences] (
    [id]               INT            IDENTITY (1, 1) NOT NULL,
    [userId]           NVARCHAR (255) NOT NULL,
    [guildId]          NVARCHAR (255) NOT NULL,
    [preferredName]    NVARCHAR (255) NULL,
    [interactionCount] INT            DEFAULT ((0)) NULL,
    [lastInteraction]  DATETIME2 (7)  NULL,
    [topics]           NVARCHAR (MAX) NULL,
    [sentimentScore]   FLOAT (53)     DEFAULT ((0)) NULL,
    [createdAt]        DATETIME2 (7)  DEFAULT (getutcdate()) NULL,
    [updatedAt]        DATETIME2 (7)  DEFAULT (getutcdate()) NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

-- Create trigger for updating user_preferences
CREATE TRIGGER TR_user_preferences_update
ON user_preferences
AFTER UPDATE
AS
BEGIN
    UPDATE user_preferences
    SET updatedAt = GETUTCDATE()
    FROM user_preferences u
    INNER JOIN inserted i ON u.id = i.id;
END;
GO

CREATE NONCLUSTERED INDEX [IX_user_preferences_user_guild]
    ON [dbo].[user_preferences]([userId] ASC, [guildId] ASC);
GO

ALTER TABLE [dbo].[user_preferences]
    ADD CONSTRAINT [UQ_user_guild] UNIQUE NONCLUSTERED ([userId] ASC, [guildId] ASC);
GO

