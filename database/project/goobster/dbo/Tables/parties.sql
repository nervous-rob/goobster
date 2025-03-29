-- First, find and drop any foreign keys that reference this table
DECLARE @sql NVARCHAR(MAX) = '';
SELECT @sql = @sql + 'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' + 
               QUOTENAME(OBJECT_NAME(parent_object_id)) + 
               ' DROP CONSTRAINT ' + QUOTENAME(name) + '; '
FROM sys.foreign_keys
WHERE referenced_object_id = OBJECT_ID('dbo.parties');

-- Execute the generated SQL to drop the foreign key constraints
IF LEN(@sql) > 0
    EXEC sp_executesql @sql;
GO

-- Drop the table if it exists
DROP TABLE IF EXISTS [dbo].[parties];
GO

CREATE TABLE [dbo].[parties] (
    [id]              INT            IDENTITY (1, 1) NOT NULL,
    [leaderId]        INT            NOT NULL,
    [createdAt]       DATETIME       DEFAULT (getdate()) NOT NULL,
    [isActive]        BIT            DEFAULT ((1)) NOT NULL,
    [adventureStatus] VARCHAR (20)   DEFAULT ('RECRUITING') NOT NULL,
    [settings]        NVARCHAR (MAX) DEFAULT ('{"maxSize": 4}') NOT NULL,
    [lastUpdated]     DATETIME       DEFAULT (getdate()) NOT NULL,
    [adventureId]     INT            NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [CHK_party_status] CHECK ([adventureStatus]='DISBANDED' OR [adventureStatus]='COMPLETED' OR [adventureStatus]='ACTIVE' OR [adventureStatus]='RECRUITING'),
    CONSTRAINT [FK_Parties_Adventures] FOREIGN KEY ([adventureId]) REFERENCES [dbo].[adventures] ([id]),
    CONSTRAINT [FK_Parties_Users] FOREIGN KEY ([leaderId]) REFERENCES [dbo].[users] ([id])
);
GO

CREATE NONCLUSTERED INDEX [IX_parties_status]
    ON [dbo].[parties]([adventureStatus] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_Parties_AdventureId]
    ON [dbo].[parties]([adventureId] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_Parties_LeaderId]
    ON [dbo].[parties]([leaderId] ASC);
GO

