-- Drop all foreign keys that reference users first
DECLARE @DropFKSQL NVARCHAR(MAX) = '';
SELECT @DropFKSQL = @DropFKSQL + 
    'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' +
    QUOTENAME(OBJECT_NAME(parent_object_id)) + 
    ' DROP CONSTRAINT ' + QUOTENAME(name) + ';'
FROM sys.foreign_keys
WHERE referenced_object_id = OBJECT_ID('users');

IF LEN(@DropFKSQL) > 0
BEGIN
    PRINT 'Dropping foreign keys that reference users:';
    PRINT @DropFKSQL;
    EXEC sp_executesql @DropFKSQL;
END;
GO

-- Drop foreign keys from users table
DECLARE @DropUserFKSQL NVARCHAR(MAX) = '';
SELECT @DropUserFKSQL = @DropUserFKSQL + 
    'ALTER TABLE users DROP CONSTRAINT ' + QUOTENAME(name) + ';'
FROM sys.foreign_keys
WHERE parent_object_id = OBJECT_ID('users');

IF LEN(@DropUserFKSQL) > 0
BEGIN
    PRINT 'Dropping foreign keys from users:';
    PRINT @DropUserFKSQL;
    EXEC sp_executesql @DropUserFKSQL;
END;
GO

-- Store the restore SQL for later
CREATE TABLE #RestoreFK (
    RestoreSQL NVARCHAR(MAX)
);

INSERT INTO #RestoreFK (RestoreSQL)
SELECT 
    'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(fk.parent_object_id)) + '.' +
    QUOTENAME(OBJECT_NAME(fk.parent_object_id)) +
    ' ADD CONSTRAINT ' + QUOTENAME(fk.name) + 
    ' FOREIGN KEY (' + QUOTENAME(c.name) + ') REFERENCES users(id);'
FROM sys.foreign_keys fk
INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
INNER JOIN sys.columns c ON fkc.parent_object_id = c.object_id 
    AND fkc.parent_column_id = c.column_id
WHERE fk.referenced_object_id = OBJECT_ID('users');
GO

-- Create backup of existing data
IF OBJECT_ID('users_backup', 'U') IS NOT NULL
    DROP TABLE users_backup;

SELECT 
    id,
    username,
    joinedAt,
    activeConversationId
INTO users_backup 
FROM users;
GO

-- Drop existing table and create new one
DROP TABLE users;
GO

CREATE TABLE users (
    id INT IDENTITY(1,1) PRIMARY KEY,
    discordUsername NVARCHAR(255) NOT NULL,
    discordId NVARCHAR(255) NOT NULL,
    joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
    activeConversationId INT NULL,
    username NVARCHAR(50) NOT NULL
);
GO

-- Copy data from backup
SET IDENTITY_INSERT users ON;

INSERT INTO users (id, discordUsername, discordId, joinedAt, activeConversationId, username)
SELECT 
    id,
    username,
    CONCAT('legacy_', CAST(id AS NVARCHAR(50))),
    joinedAt,
    activeConversationId,
    username
FROM users_backup;

SET IDENTITY_INSERT users OFF;
GO

-- Restore foreign key for activeConversationId
ALTER TABLE users ADD CONSTRAINT FK_Users_Conversations 
FOREIGN KEY (activeConversationId) REFERENCES conversations(id);
GO

-- Restore other foreign keys
DECLARE @RestoreSQL NVARCHAR(MAX);
SELECT @RestoreSQL = RestoreSQL FROM #RestoreFK;

IF @RestoreSQL IS NOT NULL
BEGIN
    PRINT 'Restoring foreign keys:';
    PRINT @RestoreSQL;
    EXEC sp_executesql @RestoreSQL;
END;

DROP TABLE #RestoreFK;
GO

-- Add performance index
CREATE INDEX idx_users_discord ON users(discordUsername, discordId);
GO

-- Verify data integrity
IF EXISTS (
    SELECT u.id FROM users_backup u
    LEFT JOIN users n ON u.id = n.id
    WHERE n.id IS NULL
)
BEGIN
    RAISERROR ('Data integrity check failed: Some records were not migrated correctly', 16, 1);
    RETURN;
END;

-- Print row counts for verification
SELECT 'Backup table count' as [Table], COUNT(*) as [Count] FROM users_backup
UNION ALL
SELECT 'New table count', COUNT(*) FROM users;
GO

-- Optional: Drop backup table if everything is successful
-- DROP TABLE users_backup;
-- GO 