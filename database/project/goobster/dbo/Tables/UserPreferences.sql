CREATE TABLE [dbo].[UserPreferences] (
    [userId]               BIGINT           NOT NULL,
    [updatedAt]            DATETIME         DEFAULT (getdate()) NULL,
    [preferred_model_id]   UNIQUEIDENTIFIER NULL,
    [personality_preset]   NVARCHAR (50)    DEFAULT ('helper') NULL,
    [personality_settings] NVARCHAR (MAX)   NULL,
    [energy_level]         AS               (json_value([personality_settings],'$.energy')) PERSISTED,
    [humor_level]          AS               (json_value([personality_settings],'$.humor')) PERSISTED,
    [formality_level]      AS               (json_value([personality_settings],'$.formality')) PERSISTED,
    CONSTRAINT [PK_UserPreferences_userId] PRIMARY KEY CLUSTERED ([userId] ASC),
    CONSTRAINT [CHK_personality_preset] CHECK ([personality_preset]='helper' OR [personality_preset]='professional' OR [personality_preset]='casual' OR [personality_preset]='meme' OR [personality_preset]='alien' OR [personality_preset]='madProfessor' OR [personality_preset]='absoluteZero')
);
GO


