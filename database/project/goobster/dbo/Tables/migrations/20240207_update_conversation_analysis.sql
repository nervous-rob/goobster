-- Add new columns for analysis metadata
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.conversation_analysis') AND name = 'model_id')
BEGIN
    ALTER TABLE [dbo].[conversation_analysis]
    ADD [model_id] UNIQUEIDENTIFIER NULL,
        [provider] NVARCHAR(50) NULL,
        [confidence_scores] NVARCHAR(MAX) NULL,
        [analysis_metadata] NVARCHAR(MAX) NULL;

    -- Add foreign key constraint
    ALTER TABLE [dbo].[conversation_analysis]
    ADD CONSTRAINT [FK_conversation_analysis_model] FOREIGN KEY ([model_id]) REFERENCES [dbo].[model_configs] ([id]);
END
GO

-- Add computed column for overall confidence if it doesn't exist
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.conversation_analysis') AND name = 'overall_confidence')
BEGIN
    ALTER TABLE [dbo].[conversation_analysis]
    ADD [overall_confidence] AS 
        JSON_VALUE([confidence_scores], '$.overall') PERSISTED;
END
GO

-- Add new indexes if they don't exist
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_conversation_analysis_confidence')
BEGIN
    CREATE NONCLUSTERED INDEX [IX_conversation_analysis_confidence]
    ON [dbo].[conversation_analysis]([overall_confidence] ASC);
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_conversation_analysis_model')
BEGIN
    CREATE NONCLUSTERED INDEX [IX_conversation_analysis_model]
    ON [dbo].[conversation_analysis]([model_id] ASC, [provider] ASC);
END
GO 