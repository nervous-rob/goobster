-- Add new columns to resourceAllocations table
ALTER TABLE [dbo].[resourceAllocations]
ADD [allocated] INT DEFAULT ((0)) NOT NULL,
    [metadata] NVARCHAR (MAX) DEFAULT ('{}') NOT NULL;
GO

-- Update existing rows with default values
UPDATE [dbo].[resourceAllocations]
SET [allocated] = 0,
    [metadata] = '{}';
GO 