-- Add metadata column if it doesn't exist
IF NOT EXISTS (
    SELECT * FROM sys.columns 
    WHERE object_id = OBJECT_ID('messages') 
    AND name = 'metadata'
)
BEGIN
    ALTER TABLE messages
    ADD metadata NVARCHAR(MAX) NULL;
END 