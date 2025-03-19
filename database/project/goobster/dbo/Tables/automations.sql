CREATE TABLE [dbo].[automations] (
    [id]         INT            IDENTITY (1, 1) NOT NULL,
    [userId]     BIGINT         NOT NULL,
    [guildId]    VARCHAR (255)  NOT NULL,
    [channelId]  VARCHAR (255)  NOT NULL,
    [name]       NVARCHAR (100) NOT NULL,
    [promptText] NVARCHAR (MAX) NOT NULL,
    [schedule]   NVARCHAR (100) NOT NULL,
    [isEnabled]  BIT            DEFAULT ((1)) NOT NULL,
    [lastRun]    DATETIME2 (7)  NULL,
    [nextRun]    DATETIME2 (7)  NULL,
    [metadata]   NVARCHAR (MAX) NULL,
    [createdAt]  DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    [updatedAt]  DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

CREATE NONCLUSTERED INDEX [IX_automations_guild]
    ON [dbo].[automations]([guildId] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_automations_user]
    ON [dbo].[automations]([userId] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_automations_next_run]
    ON [dbo].[automations]([nextRun] ASC)
    INCLUDE([isEnabled]);
GO

ALTER TABLE [dbo].[automations]
    ADD CONSTRAINT [CHK_automation_schedule] CHECK (len([schedule])>(0) AND len([schedule])<=(100));
GO

