CREATE TABLE [dbo].[model_configs]
(
    [id] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    [provider] NVARCHAR(50) NOT NULL,
    [model_name] NVARCHAR(50) NOT NULL,
    [api_version] NVARCHAR(10) NOT NULL DEFAULT 'v1',
    [max_tokens] INT NOT NULL DEFAULT 1000,
    [temperature] FLOAT NOT NULL DEFAULT 0.7,
    [capabilities] NVARCHAR(MAX) NOT NULL, -- JSON array of capabilities
    [rate_limit] INT NOT NULL DEFAULT 60, -- Requests per minute
    [is_active] BIT NOT NULL DEFAULT 1,
    [priority] INT NOT NULL DEFAULT 100, -- Lower number = higher priority
    [created_at] DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    [updated_at] DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT [UQ_model_configs_provider_model] UNIQUE ([provider], [model_name])
)
GO

-- Add indexes
CREATE INDEX [IX_model_configs_provider_model] ON [dbo].[model_configs] ([provider], [model_name])
CREATE INDEX [IX_model_configs_api_version] ON [dbo].[model_configs] ([api_version])
GO

-- Add default data
INSERT INTO [dbo].[model_configs] 
    ([provider], [model_name], [capabilities], [priority], [rate_limit])
VALUES 
    ('openai', 'gpt-4o', '["chat","search","adventure"]', 10, 60),
    ('anthropic', 'claude-3.5-sonnet', '["chat","search"]', 20, 50),
    ('google', 'gemini-pro', '["chat"]', 30, 40)
GO