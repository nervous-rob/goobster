CREATE TABLE [dbo].[conversation_analysis] (
    [id]                     UNIQUEIDENTIFIER DEFAULT (newid()) NOT NULL,
    [userId]                 BIGINT           NOT NULL,
    [sentiment]              NVARCHAR (MAX)   NOT NULL,
    [style]                  NVARCHAR (MAX)   NOT NULL,
    [energy]                 NVARCHAR (MAX)   NOT NULL,
    [dominant_sentiment]     AS               (json_value([sentiment],'$.dominant')) PERSISTED,
    [dominant_style]         AS               (json_value([style],'$.dominant')) PERSISTED,
    [energy_level]           AS               (json_value([energy],'$.level')) PERSISTED,
    [context]                NVARCHAR (MAX)   NOT NULL,
    [timestamp]              DATETIME2 (7)    DEFAULT (getutcdate()) NOT NULL,
    [model_id]               UNIQUEIDENTIFIER NULL,
    [provider]               NVARCHAR (50)    NULL,
    [confidence_scores]      NVARCHAR (MAX)   NULL,
    [analysis_metadata]      NVARCHAR (MAX)   NULL,
    [overall_confidence]     AS               (json_value([confidence_scores],'$.overall')) PERSISTED,
    [personality_preset]     NVARCHAR (50)    NULL,
    [personality_confidence] FLOAT (53)       NULL,
    [adaptation_success]     BIT              DEFAULT ((1)) NULL,
    [adaptation_metadata]    NVARCHAR (MAX)   NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

CREATE NONCLUSTERED INDEX [IX_conversation_analysis_confidence_composite]
    ON [dbo].[conversation_analysis]([userId] ASC, [overall_confidence] ASC, [personality_confidence] ASC)
    INCLUDE([personality_preset]);
GO

CREATE NONCLUSTERED INDEX [IX_conversation_analysis_style]
    ON [dbo].[conversation_analysis]([dominant_style] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_conversation_analysis_model]
    ON [dbo].[conversation_analysis]([model_id] ASC, [provider] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_conversation_analysis_user_time]
    ON [dbo].[conversation_analysis]([userId] ASC, [timestamp] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_conversation_analysis_energy]
    ON [dbo].[conversation_analysis]([energy_level] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_conversation_analysis_sentiment]
    ON [dbo].[conversation_analysis]([dominant_sentiment] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_conversation_analysis_personality]
    ON [dbo].[conversation_analysis]([userId] ASC, [personality_preset] ASC, [adaptation_success] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_conversation_analysis_confidence]
    ON [dbo].[conversation_analysis]([overall_confidence] ASC);
GO

