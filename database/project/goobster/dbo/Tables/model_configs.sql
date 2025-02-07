CREATE TABLE [dbo].[model_configs] (
    [id]           UNIQUEIDENTIFIER DEFAULT (newid()) NOT NULL,
    [provider]     NVARCHAR (50)    NOT NULL,
    [model_name]   NVARCHAR (50)    NOT NULL,
    [api_version]  NVARCHAR (10)    DEFAULT ('v1') NOT NULL,
    [max_tokens]   INT              DEFAULT ((1000)) NOT NULL,
    [temperature]  FLOAT (53)       DEFAULT ((0.7)) NOT NULL,
    [capabilities] NVARCHAR (MAX)   NOT NULL,
    [rate_limit]   INT              DEFAULT ((60)) NOT NULL,
    [is_active]    BIT              DEFAULT ((1)) NOT NULL,
    [priority]     INT              DEFAULT ((100)) NOT NULL,
    [created_at]   DATETIME2 (7)    DEFAULT (getutcdate()) NOT NULL,
    [updated_at]   DATETIME2 (7)    DEFAULT (getutcdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [UQ_model_configs_provider_model] UNIQUE NONCLUSTERED ([provider] ASC, [model_name] ASC)
);
GO

-- Add indexes
CREATE INDEX [IX_model_configs_provider_model] ON [dbo].[model_configs] ([provider], [model_name])
CREATE INDEX [IX_model_configs_api_version] ON [dbo].[model_configs] ([api_version])
GO

-- Add default data
INSERT INTO [dbo].[model_configs] 
    ([provider], [model_name], [capabilities], [priority], [rate_limit])
VALUES 
    ('openai', 'gpt-4o', '["chat","search","adventure","analysis"]', 10, 60),
    ('anthropic', 'claude-3.5-sonnet', '["chat","search","adventure","analysis"]', 20, 50),
    ('google', 'gemini-pro', '["chat"]', 30, 40)
GO
CREATE NONCLUSTERED INDEX [IX_model_configs_api_version]
    ON [dbo].[model_configs]([api_version] ASC);
GO


CREATE NONCLUSTERED INDEX [IX_model_configs_provider_model]
    ON [dbo].[model_configs]([provider] ASC, [model_name] ASC);
GO

