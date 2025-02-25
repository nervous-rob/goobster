-- Add search_approval column to guild_settings table if it doesn't exist
IF NOT EXISTS (
    SELECT * FROM sys.columns 
    WHERE name = 'search_approval' AND object_id = OBJECT_ID('guild_settings')
)
BEGIN
    -- Add the column with default value
    ALTER TABLE [dbo].[guild_settings]
    ADD [search_approval] VARCHAR(20) DEFAULT 'REQUIRED' NOT NULL;
    
    -- Add constraint to ensure search_approval is one of the allowed values
    ALTER TABLE [dbo].[guild_settings]
    ADD CONSTRAINT [CHK_search_approval] CHECK ([search_approval]='REQUIRED' OR [search_approval]='NOT_REQUIRED');
    
    PRINT 'Added search_approval column to guild_settings table';
END
ELSE
BEGIN
    PRINT 'search_approval column already exists in guild_settings table';
END
GO 