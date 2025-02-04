CREATE TABLE [dbo].[adventures] (
    [id]           INT            IDENTITY (1, 1) NOT NULL,
    [title]        NVARCHAR (100) NOT NULL,
    [description]  NVARCHAR (MAX) NULL,
    [createdBy]    NVARCHAR (255) NOT NULL,
    [settings]     NVARCHAR (MAX) NOT NULL,
    [theme]        NVARCHAR (100) NULL,
    [setting]      NVARCHAR (MAX) NOT NULL,
    [plotSummary]  NVARCHAR (MAX) NOT NULL,
    [plotPoints]   NVARCHAR (MAX) NOT NULL,
    [keyElements]  NVARCHAR (MAX) NOT NULL,
    [winCondition] NVARCHAR (MAX) NOT NULL,
    [currentState] NVARCHAR (MAX) NULL,
    [status]       NVARCHAR (50)  DEFAULT ('initialized') NOT NULL,
    [metadata]     NVARCHAR (MAX) NULL,
    [startedAt]    DATETIME       DEFAULT (getdate()) NOT NULL,
    [completedAt]  DATETIME       NULL,
    [lastUpdated]  DATETIME       DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

CREATE NONCLUSTERED INDEX [IX_adventures_createdBy]
    ON [dbo].[adventures]([createdBy] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_adventures_status]
    ON [dbo].[adventures]([status] ASC);
GO

ALTER TABLE [dbo].[adventures]
    ADD CONSTRAINT [CHK_adventure_status] CHECK ([status]='failed' OR [status]='completed' OR [status]='active' OR [status]='initialized');
GO

