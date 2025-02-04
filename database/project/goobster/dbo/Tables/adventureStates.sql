CREATE TABLE [dbo].[adventureStates] (
    [id]           INT            IDENTITY (1, 1) NOT NULL,
    [adventureId]  INT            NOT NULL,
    [currentScene] NVARCHAR (MAX) NOT NULL,
    [status]       NVARCHAR (50)  DEFAULT ('active') NOT NULL,
    [history]      NVARCHAR (MAX) DEFAULT ('[]') NOT NULL,
    [eventHistory] NVARCHAR (MAX) DEFAULT ('[]') NOT NULL,
    [metadata]     NVARCHAR (MAX) NOT NULL,
    [progress]     NVARCHAR (MAX) NOT NULL,
    [environment]  NVARCHAR (MAX) NOT NULL,
    [flags]        NVARCHAR (MAX) DEFAULT ('{}') NOT NULL,
    [variables]    NVARCHAR (MAX) DEFAULT ('{}') NOT NULL,
    [createdAt]    DATETIME       DEFAULT (getdate()) NOT NULL,
    [lastUpdated]  DATETIME       DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    FOREIGN KEY ([adventureId]) REFERENCES [dbo].[adventures] ([id])
);
GO

ALTER TABLE [dbo].[adventureStates]
    ADD CONSTRAINT [CHK_adventure_state_status] CHECK ([status]='failed' OR [status]='completed' OR [status]='paused' OR [status]='active');
GO

CREATE NONCLUSTERED INDEX [IX_adventureStates_adventureId]
    ON [dbo].[adventureStates]([adventureId] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_adventureStates_status]
    ON [dbo].[adventureStates]([status] ASC);
GO

