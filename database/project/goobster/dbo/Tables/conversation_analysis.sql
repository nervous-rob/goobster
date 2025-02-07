IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'conversation_analysis')
BEGIN
    CREATE TABLE [dbo].[conversation_analysis] (
    [id]                 UNIQUEIDENTIFIER DEFAULT (newid()) NOT NULL,
    [userId]             VARCHAR (255)    NOT NULL,
    [sentiment]          NVARCHAR (MAX)   NOT NULL,
    [style]              NVARCHAR (MAX)   NOT NULL,
    [energy]             NVARCHAR (MAX)   NOT NULL,
    [dominant_sentiment] AS               (json_value([sentiment],'$.dominant')) PERSISTED,
    [dominant_style]     AS               (json_value([style],'$.dominant')) PERSISTED,
    [energy_level]       AS               (json_value([energy],'$.level')) PERSISTED,
    [context]            NVARCHAR (MAX)   NOT NULL,
    [timestamp]          DATETIME2 (7)    DEFAULT (getutcdate()) NOT NULL,
    [model_id]           UNIQUEIDENTIFIER NULL,
    [provider]           NVARCHAR (50)    NULL,
    [confidence_scores]  NVARCHAR (MAX)   NULL,
    [analysis_metadata]  NVARCHAR (MAX)   NULL,
    [overall_confidence] AS               (json_value([confidence_scores],'$.overall')) PERSISTED,
    PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [FK_conversation_analysis_model] FOREIGN KEY ([model_id]) REFERENCES [dbo].[model_configs] ([id]),
    CONSTRAINT [FK_conversation_analysis_user] FOREIGN KEY ([userId]) REFERENCES [dbo].[UserPreferences] ([userId])
);
END
GO


IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_conversation_analysis_user_time' AND object_id = OBJECT_ID('dbo.conversation_analysis'))
BEGIN
    CREATE INDEX [IX_conversation_analysis_user_time] 
    ON [dbo].[conversation_analysis] ([userId], [timestamp])
END
-- if column does not exist, add it
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name = 'dominant_sentiment' AND object_id = OBJECT_ID('dbo.conversation_analysis'))
BEGIN
    ALTER TABLE [dbo].[conversation_analysis]
    ADD [dominant_sentiment] AS 
        JSON_VALUE([sentiment], '$.dominant') PERSISTED
END
GO
-- if column does not exist, add it
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name = 'dominant_style' AND object_id = OBJECT_ID('dbo.conversation_analysis'))
BEGIN
    ALTER TABLE [dbo].[conversation_analysis]
    ADD [dominant_style] AS 
        JSON_VALUE([style], '$.dominant') PERSISTED
END
GO

-- if column does not exist, add it
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE name = 'energy_level' AND object_id = OBJECT_ID('dbo.conversation_analysis'))
BEGIN
    ALTER TABLE [dbo].[conversation_analysis]
    ADD [energy_level] AS 
        JSON_VALUE([energy], '$.level') PERSISTED
END
GO

--DROP ALL INDEXES IF THEY EXIST
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_conversation_analysis_sentiment' AND object_id = OBJECT_ID('dbo.conversation_analysis'))
BEGIN
    DROP INDEX [IX_conversation_analysis_sentiment] ON [dbo].[conversation_analysis]
END
GO
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_conversation_analysis_style' AND object_id = OBJECT_ID('dbo.conversation_analysis'))
BEGIN
    DROP INDEX [IX_conversation_analysis_style] ON [dbo].[conversation_analysis]
END
GO
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_conversation_analysis_energy' AND object_id = OBJECT_ID('dbo.conversation_analysis'))
BEGIN
    DROP INDEX [IX_conversation_analysis_energy] ON [dbo].[conversation_analysis]
END
GO

-- Add indexes on computed columns
CREATE INDEX [IX_conversation_analysis_sentiment] 
ON [dbo].[conversation_analysis] ([dominant_sentiment])
GO

CREATE INDEX [IX_conversation_analysis_style] 
ON [dbo].[conversation_analysis] ([dominant_style])
GO

CREATE INDEX [IX_conversation_analysis_energy] 
ON [dbo].[conversation_analysis] ([energy_level])
GO 
CREATE NONCLUSTERED INDEX [IX_conversation_analysis_user_time]
    ON [dbo].[conversation_analysis]([userId] ASC, [timestamp] ASC);
GO

