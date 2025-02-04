CREATE TABLE [dbo].[parties] (
    [id]              INT            IDENTITY (1, 1) NOT NULL,
    [leaderId]        NVARCHAR (255) NOT NULL,
    [createdAt]       DATETIME       DEFAULT (getdate()) NOT NULL,
    [isActive]        BIT            DEFAULT ((1)) NOT NULL,
    [adventureStatus] VARCHAR (20)   DEFAULT ('RECRUITING') NULL,
    [settings]        NVARCHAR (MAX) DEFAULT ('{"maxSize": 4}') NOT NULL,
    [lastUpdated]     DATETIME       DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

ALTER TABLE [dbo].[parties]
    ADD CONSTRAINT [CHK_party_status] CHECK ([adventureStatus]='DISBANDED' OR [adventureStatus]='COMPLETED' OR [adventureStatus]='ACTIVE' OR [adventureStatus]='RECRUITING');
GO

CREATE NONCLUSTERED INDEX [IX_parties_status]
    ON [dbo].[parties]([adventureStatus] ASC);
GO

