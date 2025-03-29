CREATE TABLE [dbo].[interaction_metrics] (
    [id]           INT            IDENTITY (1, 1) NOT NULL,
    [userId]       NVARCHAR (255) NOT NULL,
    [guildId]      NVARCHAR (255) NOT NULL,
    [responseTime] INT            NULL,
    [success]      BIT            NULL,
    [errorType]    NVARCHAR (100) NULL,
    [timestamp]    DATETIME2 (7)  DEFAULT (getutcdate()) NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

CREATE NONCLUSTERED INDEX [IX_interaction_metrics_user_guild]
    ON [dbo].[interaction_metrics]([userId] ASC, [guildId] ASC);
GO

