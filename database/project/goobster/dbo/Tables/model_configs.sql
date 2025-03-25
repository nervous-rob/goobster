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
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

CREATE NONCLUSTERED INDEX [IX_model_configs_provider]
    ON [dbo].[model_configs]([provider] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_model_configs_provider_model]
    ON [dbo].[model_configs]([provider] ASC, [model_name] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_model_configs_active]
    ON [dbo].[model_configs]([is_active] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_model_configs_api_version]
    ON [dbo].[model_configs]([api_version] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_model_configs_priority]
    ON [dbo].[model_configs]([priority] ASC);
GO

ALTER TABLE [dbo].[model_configs]
    ADD CONSTRAINT [UQ_model_configs_provider_model] UNIQUE NONCLUSTERED ([provider] ASC, [model_name] ASC);
GO

-- Clear existing data
TRUNCATE TABLE [dbo].[model_configs];
GO

-- Insert new model configurations
INSERT INTO [dbo].[model_configs] 
([provider], [model_name], [api_version], [max_tokens], [temperature], [capabilities], [rate_limit], [is_active], [priority])
VALUES
-- OpenAI Models
('openai', 'o1', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "reasoning": true, "thinking": true, "analysis": true, "context_window": 128000}', 60, 1, 100),
('openai', 'o1-mini', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "reasoning": true, "analysis": true, "context_window": 128000}', 60, 1, 90),
('openai', 'o3-mini', 'v1', 100000, 0.7, '{"chat": true, "completion": true, "reasoning": true, "analysis": true, "context_window": 200000}', 60, 1, 85),
('openai', 'gpt-4o', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "function-calling": true, "context_window": 128000}', 60, 1, 95),
('openai', 'gpt-3.5-turbo', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "context_window": 16385}', 60, 1, 80),

-- Anthropic Models
('anthropic', 'claude-3-7-sonnet-20250219', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "analysis": true, "reasoning": true, "thinking": true, "context_window": 200000}', 60, 1, 100),
('anthropic', 'claude-3-5-sonnet-20241022', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "analysis": true, "context_window": 200000}', 60, 1, 95),
('anthropic', 'claude-3-5-haiku-20241022', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "context_window": 200000}', 60, 1, 90),

-- Google Models
('google', 'gemini-2.0-pro', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "analysis": true, "reasoning": true, "thinking": true, "tool_use": true, "context_window": 2000000}', 60, 1, 100),
('google', 'gemini-2.0-flash', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "analysis": true, "multimodal": true, "context_window": 1000000}', 60, 1, 95),
('google', 'gemini-2.0-flash-lite', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "context_window": 1000000}', 60, 1, 90),
('google', 'gemini-1.5-pro', 'v1', 2048, 0.7, '{"chat": true, "completion": true, "analysis": true, "context_window": 32768}', 60, 1, 85),

-- Perplexity Models
('perplexity', 'sonar-pro', 'v1', 4096, 0.7, '{"chat": true, "completion": true, "search": true, "analysis": true, "context_window": 8192}', 60, 1, 95),
('perplexity', 'sonar-medium', 'v1', 2048, 0.7, '{"chat": true, "completion": true, "search": true, "context_window": 4096}', 60, 1, 90);
GO

