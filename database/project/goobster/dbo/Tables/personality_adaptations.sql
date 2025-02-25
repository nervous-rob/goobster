CREATE TABLE [dbo].[personality_adaptations] (
    [id]              UNIQUEIDENTIFIER DEFAULT (newid()) NOT NULL,
    [user_id]         BIGINT           NOT NULL,
    [energy_level]    VARCHAR (20)     NULL,
    [formality_level] VARCHAR (20)     NULL,
    [humor_level]     VARCHAR (20)     NULL,
    [confidence]      FLOAT (53)       NULL,
    [analysis_data]   NVARCHAR (MAX)   NULL,
    [created_at]      DATETIME2 (7)    DEFAULT (getutcdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

CREATE NONCLUSTERED INDEX [IX_personality_adaptations_user_time]
    ON [dbo].[personality_adaptations]([user_id] ASC, [created_at] ASC);
GO

