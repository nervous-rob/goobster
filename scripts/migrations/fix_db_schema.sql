-- Database Schema Fix for Discord ID Handling
-- This script updates the users and messages tables to use BIGINT for IDs

SET NOCOUNT ON;
PRINT 'Starting database schema update for Discord ID handling...';

BEGIN TRY
    BEGIN TRANSACTION;

    -- ===== USERS TABLE =====
    PRINT 'STEP 1: Processing users table...';
    
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
        DROP TABLE users_backup;
        PRINT 'Dropped existing backup table.';
        SELECT * INTO users_backup FROM users;
        PRINT 'Created new backup table.';
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
    
    -- ===== MESSAGES TABLE =====
    PRINT 'STEP 2: Processing messages table...';
    
    -- Check if backup table already exists (in case of previous run)
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'messages_backup')
    BEGIN
        PRINT 'Creating backup of messages table...';
        -- Create a backup of the original table
        SELECT * INTO messages_backup FROM messages;
        PRINT 'Backup completed successfully.';
    END
    ELSE
    BEGIN
        PRINT 'Using existing messages backup table from previous run.';
    END

    -- Get table schema information to recreate later
    PRINT 'Retrieving messages table schema...';
    DECLARE @columnsInfo TABLE (
        column_name NVARCHAR(128),
        data_type NVARCHAR(128),
        max_length INT,
        is_nullable BIT,
        has_default BIT,
        default_definition NVARCHAR(MAX)
    );

    INSERT INTO @columnsInfo
    SELECT 
        c.name AS column_name,
        t.name AS data_type,
        c.max_length,
        c.is_nullable,
        CASE WHEN d.definition IS NOT NULL THEN 1 ELSE 0 END AS has_default,
        d.definition AS default_definition
    FROM 
        sys.columns c
    JOIN 
        sys.types t ON c.user_type_id = t.user_type_id
    LEFT JOIN 
        sys.default_constraints d ON c.default_object_id = d.object_id
    WHERE 
        c.object_id = OBJECT_ID('messages');

    -- Get all messages data to reinsert
    PRINT 'Retrieving all messages data...';
    SELECT * INTO #TempMessages FROM messages;
    
    -- ===== DROP FOREIGN KEYS =====
    PRINT 'STEP 3: Dropping all foreign key constraints...';
    
    -- Drop foreign keys that reference users or messages
    DECLARE @dropAllFKSQL NVARCHAR(MAX) = '';
    
    SELECT @dropAllFKSQL = @dropAllFKSQL + 
        'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' + 
        QUOTENAME(OBJECT_NAME(parent_object_id)) + 
        ' DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.foreign_keys
    WHERE referenced_object_id IN (OBJECT_ID('users'), OBJECT_ID('messages'))
       OR parent_object_id IN (OBJECT_ID('users'), OBJECT_ID('messages'));
    
    EXEC sp_executesql @dropAllFKSQL;
    
    -- ===== DROP CONSTRAINTS =====
    PRINT 'STEP 4: Dropping primary key constraints...';
    
    -- Drop primary key constraints on users
    DECLARE @dropUsersPKSQL NVARCHAR(MAX) = '';
    SELECT @dropUsersPKSQL = @dropUsersPKSQL + 
        'ALTER TABLE users DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.key_constraints
    WHERE [type] = 'PK'
    AND parent_object_id = OBJECT_ID('users');
    
    EXEC sp_executesql @dropUsersPKSQL;
    
    -- Drop primary key constraints on messages
    DECLARE @dropMessagesPKSQL NVARCHAR(MAX) = '';
    SELECT @dropMessagesPKSQL = @dropMessagesPKSQL + 
        'ALTER TABLE messages DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.key_constraints
    WHERE [type] = 'PK'
    AND parent_object_id = OBJECT_ID('messages');
    
    EXEC sp_executesql @dropMessagesPKSQL;
    
    -- ===== DROP TABLES =====
    PRINT 'STEP 5: Dropping original tables...';
    
    DROP TABLE messages;
    DROP TABLE users;
    
    -- ===== RECREATE USERS TABLE =====
    PRINT 'STEP 6: Recreating users table with BIGINT id...';
    
    CREATE TABLE users (
        id BIGINT IDENTITY(1,1) PRIMARY KEY, -- Changed from INT to BIGINT
        discordUsername NVARCHAR(255) NULL,
        discordId VARCHAR(255) NOT NULL,
        joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
        activeConversationId INT NULL,
        username NVARCHAR(50) NULL
    );
    
    -- Add unique constraints
    ALTER TABLE users
    ADD CONSTRAINT UQ_users_discordId UNIQUE (discordId);
    
    -- ===== RECREATE MESSAGES TABLE =====
    PRINT 'STEP 7: Recreating messages table with BIGINT createdBy...';
    
    -- Build CREATE TABLE statement
    DECLARE @createMessagesSQL NVARCHAR(MAX) = 'CREATE TABLE messages (';
    
    SELECT 
        @createMessagesSQL = @createMessagesSQL + 
        QUOTENAME(column_name) + ' ' + 
        CASE 
            WHEN column_name = 'createdBy' THEN 'BIGINT' -- Change createdBy to BIGINT
            ELSE data_type + 
                CASE 
                    WHEN data_type IN ('nvarchar', 'nchar', 'varchar', 'char') AND max_length = -1 THEN '(MAX)'
                    WHEN data_type IN ('nvarchar', 'nchar') THEN '(' + CAST(max_length/2 AS NVARCHAR) + ')'
                    WHEN data_type IN ('varchar', 'char') THEN '(' + CAST(max_length AS NVARCHAR) + ')'
                    ELSE ''
                END
        END + 
        CASE WHEN is_nullable = 1 THEN ' NULL' ELSE ' NOT NULL' END +
        CASE WHEN column_name = 'id' THEN ' IDENTITY(1,1) PRIMARY KEY' ELSE '' END +
        ', '
    FROM @columnsInfo;
    
    -- Remove trailing comma and space
    SET @createMessagesSQL = LEFT(@createMessagesSQL, LEN(@createMessagesSQL) - 1);
    SET @createMessagesSQL = @createMessagesSQL + ')';
    
    -- Execute CREATE TABLE statement
    EXEC sp_executesql @createMessagesSQL;
    
    -- Add back default constraints for messages
    DECLARE @addDefaultsSQL NVARCHAR(MAX) = '';
    
    SELECT 
        @addDefaultsSQL = @addDefaultsSQL + 
        'ALTER TABLE messages ADD DEFAULT ' + default_definition + ' FOR ' + QUOTENAME(column_name) + '; '
    FROM @columnsInfo
    WHERE has_default = 1;
    
    IF LEN(@addDefaultsSQL) > 0
    BEGIN
        EXEC sp_executesql @addDefaultsSQL;
    END
    
    -- ===== INSERT DATA =====
    PRINT 'STEP 8: Reinserting data into tables...';
    
    -- Insert users data
    PRINT 'Reinserting users data...';
    SET IDENTITY_INSERT users ON;
    
    INSERT INTO users (id, discordUsername, discordId, joinedAt, activeConversationId, username)
    SELECT id, discordUsername, discordId, joinedAt, activeConversationId, username
    FROM @users;
    
    SET IDENTITY_INSERT users OFF;
    
    DECLARE @usersMaxId INT;
    SELECT @usersMaxId = MAX(id) FROM users;
    IF @usersMaxId IS NOT NULL
    BEGIN
        DBCC CHECKIDENT ('users', RESEED, @usersMaxId);
    END
    
    -- Insert messages data
    PRINT 'Reinserting messages data...';
    SET IDENTITY_INSERT messages ON;
    
    -- Build column list for INSERT
    DECLARE @columnList NVARCHAR(MAX) = '';
    SELECT @columnList = @columnList + QUOTENAME(column_name) + ', '
    FROM @columnsInfo;
    SET @columnList = LEFT(@columnList, LEN(@columnList) - 1);
    
    -- Build INSERT statement
    DECLARE @insertSQL NVARCHAR(MAX) = 'INSERT INTO messages (' + @columnList + ') SELECT ' + @columnList + ' FROM #TempMessages';
    
    -- Execute INSERT statement
    EXEC sp_executesql @insertSQL;
    
    SET IDENTITY_INSERT messages OFF;
    
    DECLARE @messagesMaxId INT;
    SELECT @messagesMaxId = MAX(id) FROM messages;
    IF @messagesMaxId IS NOT NULL
    BEGIN
        DBCC CHECKIDENT ('messages', RESEED, @messagesMaxId);
    END
    
    -- ===== RECREATE FOREIGN KEYS =====
    PRINT 'STEP 9: Re-adding foreign keys...';
    
    -- Re-add foreign key from users to conversations
    IF EXISTS (
        SELECT * FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_NAME = 'conversations'
    )
    BEGIN
        PRINT 'Adding foreign key from users to conversations...';
        ALTER TABLE users
        ADD CONSTRAINT FK_users_conversations FOREIGN KEY (activeConversationId)
        REFERENCES conversations (id);
    END
    
    -- Re-add foreign key from messages to users
    PRINT 'Adding foreign key from messages to users...';
    ALTER TABLE messages
    ADD CONSTRAINT FK_messages_users FOREIGN KEY (createdBy)
    REFERENCES users (id);
    
    -- Re-add foreign key from messages to conversations
    IF EXISTS (
        SELECT * FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_NAME = 'conversations'
    )
    BEGIN
        PRINT 'Adding foreign key from messages to conversations...';
        ALTER TABLE messages
        ADD CONSTRAINT FK_messages_conversations FOREIGN KEY (conversationId)
        REFERENCES conversations (id);
    END
    
    -- ===== CLEANUP =====
    PRINT 'STEP 10: Cleaning up temporary data...';
    DROP TABLE #TempMessages;
    
    COMMIT TRANSACTION;
    PRINT 'Database schema update completed successfully!';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;
    
    PRINT 'Error updating schema: ' + ERROR_MESSAGE();
    PRINT 'Rolling back changes...';
    THROW;
END CATCH

-- ===== VERIFY CHANGES =====
PRINT 'Verifying schema changes...';

-- Check users table id column
PRINT 'Users table id column:';
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'id';

-- Check messages table createdBy column
PRINT 'Messages table createdBy column:';
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'messages' AND COLUMN_NAME = 'createdBy';

PRINT 'Schema update complete.'; 