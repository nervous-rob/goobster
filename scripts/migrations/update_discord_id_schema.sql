-- Discord ID Schema Update Script
-- This script updates the schema to properly handle Discord IDs which are too large for INT columns

-- First create a backup of affected tables
PRINT 'Creating backup tables...';
IF OBJECT_ID('partyMembers_backup', 'U') IS NULL
BEGIN
    SELECT * INTO partyMembers_backup FROM partyMembers;
END

IF OBJECT_ID('parties_backup', 'U') IS NULL
BEGIN
    SELECT * INTO parties_backup FROM parties;
END

-- Update users table first to ensure foreign key constraints work
PRINT 'Updating users table...';
IF COL_LENGTH('users', 'discordId') IS NOT NULL
BEGIN
    IF NOT EXISTS (
        SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'discordId' 
        AND DATA_TYPE IN ('varchar', 'nvarchar')
    )
    BEGIN
        PRINT 'Modifying discordId column in users table...';
        ALTER TABLE users ALTER COLUMN discordId NVARCHAR(255) NOT NULL;
        PRINT 'Users table updated successfully.';
    END
    ELSE
    BEGIN
        PRINT 'Users table already has correct schema.';
    END
END

-- Now update the partyMembers table
PRINT 'Updating partyMembers table...';

-- Check for and drop index on partyMembers.userId if it exists
IF EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_partyMembers_userId' AND object_id = OBJECT_ID('partyMembers'))
BEGIN
    PRINT 'Dropping index IX_partyMembers_userId...';
    DROP INDEX IX_partyMembers_userId ON partyMembers;
END

-- Look for any other indexes on partyMembers.userId
DECLARE @pmIndexesCursor CURSOR;
DECLARE @pmIndexName NVARCHAR(128);

SET @pmIndexesCursor = CURSOR FOR
    SELECT i.name
    FROM sys.indexes i
    INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE i.object_id = OBJECT_ID('partyMembers') AND c.name = 'userId';

OPEN @pmIndexesCursor;
FETCH NEXT FROM @pmIndexesCursor INTO @pmIndexName;

WHILE @@FETCH_STATUS = 0
BEGIN
    PRINT 'Dropping index ' + @pmIndexName + ' on partyMembers...';
    DECLARE @pmDropIndexSQL NVARCHAR(500) = 'DROP INDEX ' + @pmIndexName + ' ON partyMembers';
    EXEC sp_executesql @pmDropIndexSQL;
    FETCH NEXT FROM @pmIndexesCursor INTO @pmIndexName;
END

CLOSE @pmIndexesCursor;
DEALLOCATE @pmIndexesCursor;

-- Get foreign key constraint name for userId in partyMembers
DECLARE @pmConstraintName NVARCHAR(255);
SELECT @pmConstraintName = CONSTRAINT_NAME
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
WHERE TABLE_NAME = 'partyMembers' AND COLUMN_NAME = 'userId';

-- Drop the constraint if it exists
IF @pmConstraintName IS NOT NULL
BEGIN
    PRINT 'Dropping constraint ' + @pmConstraintName + ' from partyMembers table...';
    DECLARE @pmDropConstraintSQL NVARCHAR(500) = 'ALTER TABLE partyMembers DROP CONSTRAINT ' + @pmConstraintName;
    EXEC sp_executesql @pmDropConstraintSQL;
END

-- Also look for other constraints
DECLARE @pmConstraintsCursor CURSOR;
DECLARE @pmConstraintName2 NVARCHAR(128);

SET @pmConstraintsCursor = CURSOR FOR
    SELECT CONSTRAINT_NAME 
    FROM INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE
    WHERE TABLE_NAME = 'partyMembers' AND COLUMN_NAME = 'userId';

OPEN @pmConstraintsCursor;
FETCH NEXT FROM @pmConstraintsCursor INTO @pmConstraintName2;

WHILE @@FETCH_STATUS = 0
BEGIN
    PRINT 'Dropping constraint ' + @pmConstraintName2 + ' on partyMembers...';
    DECLARE @pmDropConstraintSQL2 NVARCHAR(500) = 'ALTER TABLE partyMembers DROP CONSTRAINT ' + @pmConstraintName2;
    EXEC sp_executesql @pmDropConstraintSQL2;
    FETCH NEXT FROM @pmConstraintsCursor INTO @pmConstraintName2;
END

CLOSE @pmConstraintsCursor;
DEALLOCATE @pmConstraintsCursor;

-- Check if we need to update partyMembers.userId column type
IF EXISTS (
    SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_NAME = 'partyMembers' 
    AND COLUMN_NAME = 'userId'
    AND DATA_TYPE NOT IN ('bigint')
)
BEGIN
    PRINT 'Updating partyMembers.userId column to BIGINT...';
    ALTER TABLE partyMembers ALTER COLUMN userId BIGINT NOT NULL;
    PRINT 'PartyMembers.userId column updated successfully.';
END
ELSE
BEGIN
    PRINT 'PartyMembers table userId column already has correct schema.';
END

-- Update the parties table
PRINT 'Updating parties table...';

-- Look for any indexes on parties.leaderId
DECLARE @pIndexesCursor CURSOR;
DECLARE @pIndexName NVARCHAR(128);

SET @pIndexesCursor = CURSOR FOR
    SELECT i.name
    FROM sys.indexes i
    INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE i.object_id = OBJECT_ID('parties') AND c.name = 'leaderId';

OPEN @pIndexesCursor;
FETCH NEXT FROM @pIndexesCursor INTO @pIndexName;

WHILE @@FETCH_STATUS = 0
BEGIN
    PRINT 'Dropping index ' + @pIndexName + ' on parties...';
    DECLARE @pDropIndexSQL NVARCHAR(500) = 'DROP INDEX ' + @pIndexName + ' ON parties';
    EXEC sp_executesql @pDropIndexSQL;
    FETCH NEXT FROM @pIndexesCursor INTO @pIndexName;
END

CLOSE @pIndexesCursor;
DEALLOCATE @pIndexesCursor;

-- Get foreign key constraint name for leaderId in parties
DECLARE @pConstraintName NVARCHAR(255);
SELECT @pConstraintName = CONSTRAINT_NAME
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
WHERE TABLE_NAME = 'parties' AND COLUMN_NAME = 'leaderId';

-- Drop the constraint if it exists
IF @pConstraintName IS NOT NULL
BEGIN
    PRINT 'Dropping constraint ' + @pConstraintName + ' from parties table...';
    DECLARE @pDropConstraintSQL NVARCHAR(500) = 'ALTER TABLE parties DROP CONSTRAINT ' + @pConstraintName;
    EXEC sp_executesql @pDropConstraintSQL;
END

-- Also look for other constraints on parties.leaderId
DECLARE @pConstraintsCursor CURSOR;
DECLARE @pConstraintName2 NVARCHAR(128);

SET @pConstraintsCursor = CURSOR FOR
    SELECT CONSTRAINT_NAME 
    FROM INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE
    WHERE TABLE_NAME = 'parties' AND COLUMN_NAME = 'leaderId';

OPEN @pConstraintsCursor;
FETCH NEXT FROM @pConstraintsCursor INTO @pConstraintName2;

WHILE @@FETCH_STATUS = 0
BEGIN
    PRINT 'Dropping constraint ' + @pConstraintName2 + ' on parties...';
    DECLARE @pDropConstraintSQL2 NVARCHAR(500) = 'ALTER TABLE parties DROP CONSTRAINT ' + @pConstraintName2;
    EXEC sp_executesql @pDropConstraintSQL2;
    FETCH NEXT FROM @pConstraintsCursor INTO @pConstraintName2;
END

CLOSE @pConstraintsCursor;
DEALLOCATE @pConstraintsCursor;

-- Check if we need to update parties.leaderId column type
IF EXISTS (
    SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_NAME = 'parties' 
    AND COLUMN_NAME = 'leaderId'
    AND DATA_TYPE NOT IN ('bigint')
)
BEGIN
    PRINT 'Updating parties.leaderId column to BIGINT...';
    ALTER TABLE parties ALTER COLUMN leaderId BIGINT NOT NULL;
    PRINT 'Parties.leaderId column updated successfully.';
END
ELSE
BEGIN
    PRINT 'Parties table leaderId column already has correct schema.';
END

-- Add back the foreign key constraints
PRINT 'Adding foreign key constraints back...';

-- Add constraint to partyMembers table
IF NOT EXISTS (
    SELECT * FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_TYPE = 'FOREIGN KEY' 
    AND TABLE_NAME = 'partyMembers'
    AND CONSTRAINT_NAME = 'FK_partyMembers_users'
)
BEGIN
    PRINT 'Adding FK_partyMembers_users constraint...';
    ALTER TABLE partyMembers ADD CONSTRAINT FK_partyMembers_users
    FOREIGN KEY (userId) REFERENCES users(id);
END

-- Add constraint to parties table
IF NOT EXISTS (
    SELECT * FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_TYPE = 'FOREIGN KEY' 
    AND TABLE_NAME = 'parties'
    AND CONSTRAINT_NAME = 'FK_parties_users'
)
BEGIN
    PRINT 'Adding FK_parties_users constraint...';
    ALTER TABLE parties ADD CONSTRAINT FK_parties_users
    FOREIGN KEY (leaderId) REFERENCES users(id);
END

-- Recreate the index on partyMembers.userId
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_partyMembers_userId' AND object_id = OBJECT_ID('partyMembers'))
BEGIN
    PRINT 'Recreating index IX_partyMembers_userId...';
    CREATE INDEX IX_partyMembers_userId ON partyMembers(userId);
END

PRINT 'Schema update completed successfully.'; 