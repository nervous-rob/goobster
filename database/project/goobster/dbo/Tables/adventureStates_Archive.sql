CREATE TABLE [dbo].[adventureStates_Archive] (
    [id]           INT            NOT NULL,
    [adventureId]  INT            NOT NULL,
    [currentScene] NVARCHAR (MAX) NOT NULL,
    [status]       NVARCHAR (50)  NOT NULL,
    [history]      NVARCHAR (MAX) NOT NULL,
    [eventHistory] NVARCHAR (MAX) NOT NULL,
    [metadata]     NVARCHAR (MAX) NOT NULL,
    [progress]     NVARCHAR (MAX) NOT NULL,
    [environment]  NVARCHAR (MAX) NOT NULL,
    [flags]        NVARCHAR (MAX) NOT NULL,
    [variables]    NVARCHAR (MAX) NOT NULL,
    [createdAt]    DATETIME       NOT NULL,
    [lastUpdated]  DATETIME       NOT NULL,
    [archivedAt]   DATETIME       DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC) WITH (DATA_COMPRESSION = PAGE)
);
GO

