-- Users Schema Fix
-- This script updates the users table to use BIGINT for id

SET NOCOUNT ON;
PRINT 'Starting users table schema update...';

BEGIN TRY
    BEGIN TRANSACTION;

    -- Check if backup table already exists (in case of previous run)
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'users_backup')
    BEGIN
        PRINT 'Creating backup of users table...';
        -- Create a backup of the original table
        SELECT * INTO users_backup FROM users;
        PRINT 'Backup completed successfully.';
    END
    ELSE
    BEGIN
        PRINT 'Using existing backup table from previous run.';
    END

    -- Get all users to reinsert
    PRINT 'Retrieving list of all users...';
    DECLARE @users TABLE (
        id INT, 
        discordUsername NVARCHAR(255), 
        discordId VARCHAR(255), 
        joinedAt DATETIME, 
        activeConversationId INT,
        username NVARCHAR(50)
    );
    
    INSERT INTO @users
    SELECT id, discordUsername, discordId, joinedAt, activeConversationId, username
    FROM users;
    
    -- Drop foreign key constraints that reference users
    PRINT 'Dropping foreign key constraints...';
    DECLARE @dropFKSQL NVARCHAR(MAX) = '';
    
    SELECT @dropFKSQL = @dropFKSQL + 
        'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' + 
        QUOTENAME(OBJECT_NAME(parent_object_id)) + 
        ' DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.foreign_keys
    WHERE referenced_object_id = OBJECT_ID('users');
    
    EXEC sp_executesql @dropFKSQL;
    
    -- Drop constraints on users
    PRINT 'Dropping constraints from users table...';
    DECLARE @dropConstraintSQL NVARCHAR(MAX) = '';
    
    SELECT @dropConstraintSQL = @dropConstraintSQL + 
        'ALTER TABLE users DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.key_constraints
    WHERE [type] = 'PK'
    AND parent_object_id = OBJECT_ID('users');
    
    -- Get foreign key constraints from users to other tables
    SELECT @dropConstraintSQL = @dropConstraintSQL + 
        'ALTER TABLE users DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.foreign_keys
    WHERE parent_object_id = OBJECT_ID('users');
    
    -- Execute the drop statements
    IF LEN(@dropConstraintSQL) > 0
    BEGIN
        EXEC sp_executesql @dropConstraintSQL;
    END
    
    -- Drop old table and recreate it
    PRINT 'Dropping and recreating users table with updated schema...';
    DROP TABLE users;
    
    -- Recreate table with BIGINT for id
    CREATE TABLE users (
        id BIGINT IDENTITY(1,1) PRIMARY KEY, -- Changed from INT to BIGINT
        discordUsername NVARCHAR(255) NULL,
        discordId VARCHAR(255) NOT NULL,
        joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
        activeConversationId INT NULL,
        username NVARCHAR(50) NULL
    );
    
    -- Add unique constraints
    PRINT 'Adding constraints to new table...';
    ALTER TABLE users
    ADD CONSTRAINT UQ_users_discordId UNIQUE (discordId);
    
    -- Re-add foreign key from users to conversations
    IF EXISTS (
        SELECT * FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_NAME = 'conversations'
    )
    BEGIN
        PRINT 'Re-adding foreign key to conversations table...';
        ALTER TABLE users
        ADD CONSTRAINT FK_users_conversations FOREIGN KEY (activeConversationId)
        REFERENCES conversations (id);
    END
    
    -- Reinsert the data
    PRINT 'Reinserting users data...';
    
    -- Enable IDENTITY_INSERT to preserve IDs
    PRINT 'Enabling IDENTITY_INSERT for users table...';
    SET IDENTITY_INSERT users ON;
    
    INSERT INTO users (id, discordUsername, discordId, joinedAt, activeConversationId, username)
    SELECT id, discordUsername, discordId, joinedAt, activeConversationId, username
    FROM @users;
    
    -- Disable IDENTITY_INSERT after inserting
    SET IDENTITY_INSERT users OFF;
    
    PRINT 'Setting identity column value to match the highest id...';
    DECLARE @maxId INT;
    SELECT @maxId = MAX(id) FROM users;
    IF @maxId IS NOT NULL
    BEGIN
        DBCC CHECKIDENT ('users', RESEED, @maxId);
    END
    
    -- Now recreate the foreign keys that pointed to the users table
    PRINT 'Recreating foreign keys to users table...';
    
    -- Foreign key from messages to users
    IF EXISTS (
        SELECT * FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_NAME = 'messages'
    )
    BEGIN
        PRINT 'Adding foreign key from messages to users...';
        ALTER TABLE messages
        ADD CONSTRAINT FK_messages_users FOREIGN KEY (createdBy)
        REFERENCES users (id);
    END
    
    -- Foreign key from partyMembers to users
    IF EXISTS (
        SELECT * FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_NAME = 'partyMembers'
    )
    BEGIN
        PRINT 'Adding foreign key from partyMembers to users...';
        ALTER TABLE partyMembers
        ADD CONSTRAINT FK_partyMembers_users FOREIGN KEY (userId)
        REFERENCES users (id);
    END
    
    PRINT 'Users table schema updated successfully!';
    
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;
    
    PRINT 'Error updating users schema: ' + ERROR_MESSAGE();
    THROW;
END CATCH

-- Verify the changes
PRINT 'Verifying schema changes...';
SELECT 
    COLUMN_NAME, 
    DATA_TYPE,
    CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'users'
AND COLUMN_NAME = 'id';

PRINT 'Schema update complete.'; 