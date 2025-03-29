-- Messages Schema Fix
-- This script updates the messages table to use BIGINT for createdBy

SET NOCOUNT ON;
PRINT 'Starting messages table schema update...';

BEGIN TRY
    BEGIN TRANSACTION;

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
        DROP TABLE messages_backup;
        PRINT 'Dropped existing backup table.';
        SELECT * INTO messages_backup FROM messages;
        PRINT 'Created new backup table.';
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

    -- Get all messages to reinsert
    PRINT 'Retrieving all messages data...';
    SELECT * INTO #TempMessages FROM messages;
    
    -- Drop foreign key constraints that reference messages
    PRINT 'Dropping foreign key constraints...';
    DECLARE @dropFKSQL NVARCHAR(MAX) = '';
    
    SELECT @dropFKSQL = @dropFKSQL + 
        'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' + 
        QUOTENAME(OBJECT_NAME(parent_object_id)) + 
        ' DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.foreign_keys
    WHERE referenced_object_id = OBJECT_ID('messages');
    
    EXEC sp_executesql @dropFKSQL;
    
    -- Drop constraints on messages
    PRINT 'Dropping constraints from messages table...';
    DECLARE @dropConstraintSQL NVARCHAR(MAX) = '';
    
    -- Primary Key constraints
    SELECT @dropConstraintSQL = @dropConstraintSQL + 
        'ALTER TABLE messages DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.key_constraints
    WHERE [type] = 'PK'
    AND parent_object_id = OBJECT_ID('messages');
    
    -- Foreign key constraints
    SELECT @dropConstraintSQL = @dropConstraintSQL + 
        'ALTER TABLE messages DROP CONSTRAINT ' + QUOTENAME(name) + '; '
    FROM sys.foreign_keys
    WHERE parent_object_id = OBJECT_ID('messages');
    
    -- Execute the drop statements
    IF LEN(@dropConstraintSQL) > 0
    BEGIN
        EXEC sp_executesql @dropConstraintSQL;
    END
    
    -- Drop old table and recreate it
    PRINT 'Dropping messages table...';
    DROP TABLE messages;
    
    -- Recreate table with BIGINT for createdBy
    PRINT 'Recreating messages table with updated schema...';
    DECLARE @createTableSQL NVARCHAR(MAX) = 'CREATE TABLE messages (';
    
    SELECT 
        @createTableSQL = @createTableSQL + 
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
    SET @createTableSQL = LEFT(@createTableSQL, LEN(@createTableSQL) - 1);
    SET @createTableSQL = @createTableSQL + ')';
    
    -- Execute CREATE TABLE statement
    EXEC sp_executesql @createTableSQL;
    PRINT 'Table recreated successfully.';
    
    -- Add back default constraints
    PRINT 'Adding default constraints...';
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
    
    -- Reinsert the data
    PRINT 'Reinserting messages data...';
    
    -- Enable IDENTITY_INSERT to preserve IDs
    PRINT 'Enabling IDENTITY_INSERT for messages table...';
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
    
    -- Disable IDENTITY_INSERT after inserting
    SET IDENTITY_INSERT messages OFF;
    
    -- Drop temporary table
    DROP TABLE #TempMessages;
    
    PRINT 'Setting identity column value to match the highest id...';
    DECLARE @maxId INT;
    SELECT @maxId = MAX(id) FROM messages;
    IF @maxId IS NOT NULL
    BEGIN
        DBCC CHECKIDENT ('messages', RESEED, @maxId);
    END
    
    -- Re-add foreign key to users
    IF EXISTS (
        SELECT * FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_NAME = 'users'
    )
    BEGIN
        PRINT 'Adding foreign key from messages to users...';
        ALTER TABLE messages
        ADD CONSTRAINT FK_messages_users FOREIGN KEY (createdBy)
        REFERENCES users (id);
    END
    
    -- Re-add foreign key to conversations
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
    
    PRINT 'Messages table schema updated successfully!';
    
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;
    
    PRINT 'Error updating messages schema: ' + ERROR_MESSAGE();
    THROW;
END CATCH

-- Verify the changes
PRINT 'Verifying schema changes...';
SELECT 
    COLUMN_NAME, 
    DATA_TYPE,
    CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'messages'
AND COLUMN_NAME = 'createdBy';

PRINT 'Schema update complete.'; 