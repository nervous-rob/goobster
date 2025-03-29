-- First, find and drop any foreign keys that reference this table
DECLARE @sql NVARCHAR(MAX) = '';
SELECT @sql = @sql + 'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' + 
               QUOTENAME(OBJECT_NAME(parent_object_id)) + 
               ' DROP CONSTRAINT ' + QUOTENAME(name) + '; '
FROM sys.foreign_keys
WHERE referenced_object_id = OBJECT_ID('dbo.partyMembers');

-- Execute the generated SQL to drop the foreign key constraints
IF LEN(@sql) > 0
    EXEC sp_executesql @sql;
GO

-- Drop the table if it exists
DROP TABLE IF EXISTS [dbo].[partyMembers];
GO

CREATE TABLE [dbo].[partyMembers] (
    [id]             INT            IDENTITY (1, 1) NOT NULL,
    [partyId]        INT            NOT NULL,
    [userId]         BIGINT         NOT NULL,
    [adventurerName] NVARCHAR (100) NOT NULL,
    [backstory]      NVARCHAR (MAX) NULL,
    [memberType]     NVARCHAR (50)  DEFAULT ('member') NOT NULL,
    [joinedAt]       DATETIME       DEFAULT (getdate()) NOT NULL,
    [lastUpdated]    DATETIME       DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [CHK_member_type] CHECK ([memberType]='guest' OR [memberType]='member' OR [memberType]='leader'),
    CONSTRAINT [FK_partyMembers_parties] FOREIGN KEY ([partyId]) REFERENCES [dbo].[parties] ([id]),
    CONSTRAINT [FK_PartyMembers_Users] FOREIGN KEY ([userId]) REFERENCES [dbo].[users] ([id]),
    CONSTRAINT [UQ_party_member] UNIQUE NONCLUSTERED ([partyId] ASC, [userId] ASC)
);
GO

-- Add trigger to update lastUpdated
CREATE TRIGGER [dbo].[trg_partyMembers_update]
ON [dbo].[partyMembers]
AFTER UPDATE
AS
BEGIN
    UPDATE [dbo].[partyMembers]
    SET [lastUpdated] = GETDATE()
    WHERE [id] = (SELECT [id] FROM [deleted]);
END;
GO

CREATE NONCLUSTERED INDEX [IX_partyMembers_userId]
    ON [dbo].[partyMembers]([userId] ASC);
GO
