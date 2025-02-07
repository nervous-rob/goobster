-- Create the table if it doesn't exist
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[UserPreferences]') AND type in (N'U'))
BEGIN
    CREATE TABLE [dbo].[UserPreferences] (
        [userId] VARCHAR(255) NOT NULL,
        [memeMode] BIT DEFAULT 0,
        [preferred_model_id] UNIQUEIDENTIFIER NULL,
        [personality_preset] NVARCHAR(50) DEFAULT 'helper',
        [personality_settings] NVARCHAR(MAX) NULL, -- JSON object for custom personality settings
        [updatedAt] DATETIME DEFAULT GETDATE(),
        PRIMARY KEY CLUSTERED ([userId] ASC),
        CONSTRAINT [FK_UserPreferences_model_configs] FOREIGN KEY ([preferred_model_id]) 
            REFERENCES [dbo].[model_configs] ([id])
    );
END
GO

-- Add new columns if they don't exist
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.UserPreferences') AND name = 'preferred_model_id')
BEGIN
    ALTER TABLE [dbo].[UserPreferences]
    ADD [preferred_model_id] UNIQUEIDENTIFIER NULL;

    -- Add the foreign key constraint if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_UserPreferences_model_configs')
    BEGIN
        ALTER TABLE [dbo].[UserPreferences]
        ADD CONSTRAINT [FK_UserPreferences_model_configs] 
        FOREIGN KEY ([preferred_model_id]) REFERENCES [dbo].[model_configs] ([id]);
    END
END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.UserPreferences') AND name = 'personality_preset')
BEGIN
    ALTER TABLE [dbo].[UserPreferences]
    ADD [personality_preset] NVARCHAR(50) DEFAULT 'helper';
END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.UserPreferences') AND name = 'personality_settings')
BEGIN
    ALTER TABLE [dbo].[UserPreferences]
    ADD [personality_settings] NVARCHAR(MAX) NULL;
END;
GO

-- Add index if it doesn't exist
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_UserPreferences_preferred_model')
BEGIN
    CREATE INDEX [IX_UserPreferences_preferred_model] 
    ON [dbo].[UserPreferences] ([preferred_model_id]);
END
GO

