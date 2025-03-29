-- Party Members Schema Fix
-- This script updates the partyMembers table to use BIGINT for userId

SET NOCOUNT ON;
PRINT 'Starting partyMembers table schema update...';

BEGIN TRY
    BEGIN TRANSACTION;

    -- Check if backup table already exists (in case of previous run)
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'partyMembers_backup')
    BEGIN
        PRINT 'Creating backup of partyMembers table...';
        -- Create a backup of the original table
        SELECT * INTO partyMembers_backup FROM partyMembers;
        PRINT 'Backup completed successfully.';
    END
    ELSE
    BEGIN
        PRINT 'Using existing backup table from previous run.';
    END

    -- Get all party members to reinsert
    PRINT 'Retrieving list of all party members...';
    DECLARE @members TABLE (
        id INT, 
        partyId INT, 
        userId INT, 
        adventurerName NVARCHAR(100), 
        backstory NVARCHAR(MAX), 
        memberType NVARCHAR(50), 
        joinedAt DATETIME, 
        lastUpdated DATETIME
    );
    
    INSERT INTO @members
    SELECT id, partyId, userId, adventurerName, backstory, memberType, joinedAt, lastUpdated
    FROM partyMembers;
    
    -- Drop foreign key constraints that reference partyMembers
    PRINT 'Dropping foreign key constraints...';
    DECLARE @dropFKSQL NVARCHAR(MAX) = '';
    
    SELECT @dropFKSQL = @dropFKSQL + 
        'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' + 
        QUOTENAME(OBJECT_NAME(parent_object_id)) + 
        ' DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.foreign_keys
    WHERE referenced_object_id = OBJECT_ID('partyMembers');
    
    EXEC sp_executesql @dropFKSQL;
    
    -- Drop constraints on partyMembers
    PRINT 'Dropping constraints from partyMembers table...';
    DECLARE @dropConstraintSQL NVARCHAR(MAX) = '';
    
    SELECT @dropConstraintSQL = @dropConstraintSQL + 
        'ALTER TABLE partyMembers DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.key_constraints
    WHERE [type] = 'PK'
    AND parent_object_id = OBJECT_ID('partyMembers');
    
    -- Get foreign key constraints from partyMembers to other tables
    SELECT @dropConstraintSQL = @dropConstraintSQL + 
        'ALTER TABLE partyMembers DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.foreign_keys
    WHERE parent_object_id = OBJECT_ID('partyMembers');
    
    -- Execute the drop statements
    IF LEN(@dropConstraintSQL) > 0
    BEGIN
        EXEC sp_executesql @dropConstraintSQL;
    END
    
    -- Drop old table and recreate it
    PRINT 'Dropping and recreating partyMembers table with updated schema...';
    DROP TABLE partyMembers;
    
    -- Recreate table with BIGINT for userId
    CREATE TABLE partyMembers (
        id INT IDENTITY(1,1) PRIMARY KEY,
        partyId INT NOT NULL,
        userId BIGINT NOT NULL, -- Changed from INT to BIGINT
        adventurerName NVARCHAR(100) NOT NULL,
        backstory NVARCHAR(MAX) NULL,
        memberType NVARCHAR(50) NOT NULL,
        joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
        lastUpdated DATETIME NOT NULL DEFAULT GETDATE()
    );
    
    -- Add back unique constraint
    PRINT 'Adding constraints to new table...';
    ALTER TABLE partyMembers 
    ADD CONSTRAINT UQ_party_member UNIQUE (partyId, userId);
    
    -- Add foreign key to parties table
    ALTER TABLE partyMembers
    ADD CONSTRAINT FK_partyMembers_parties FOREIGN KEY (partyId)
    REFERENCES parties (id);
    
    -- Add foreign key to users table - if users.id is BIGINT
    IF EXISTS (
        SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'id' 
        AND DATA_TYPE = 'bigint'
    )
    BEGIN
        ALTER TABLE partyMembers
        ADD CONSTRAINT FK_partyMembers_users FOREIGN KEY (userId)
        REFERENCES users (id);
    END
    
    -- Reinsert the data
    PRINT 'Reinserting party members data...';
    
    -- Enable IDENTITY_INSERT to preserve IDs
    PRINT 'Enabling IDENTITY_INSERT for partyMembers table...';
    SET IDENTITY_INSERT partyMembers ON;
    
    INSERT INTO partyMembers (id, partyId, userId, adventurerName, backstory, memberType, joinedAt, lastUpdated)
    SELECT id, partyId, userId, adventurerName, backstory, memberType, joinedAt, lastUpdated
    FROM @members;
    
    -- Disable IDENTITY_INSERT after inserting
    SET IDENTITY_INSERT partyMembers OFF;
    
    PRINT 'Setting identity column value to match the highest id...';
    DECLARE @maxId INT;
    SELECT @maxId = MAX(id) FROM partyMembers;
    IF @maxId IS NOT NULL
    BEGIN
        DBCC CHECKIDENT ('partyMembers', RESEED, @maxId);
    END
    
    PRINT 'PartyMembers table schema updated successfully!';
    
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;
    
    PRINT 'Error updating partyMembers schema: ' + ERROR_MESSAGE();
    THROW;
END CATCH

-- Verify the changes
PRINT 'Verifying schema changes...';
SELECT 
    COLUMN_NAME, 
    DATA_TYPE,
    CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'partyMembers'
AND COLUMN_NAME = 'userId';

PRINT 'Schema update complete.'; 