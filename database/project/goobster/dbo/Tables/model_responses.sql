CREATE TABLE [dbo].[model_responses]
(
    [id] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
    [request_id] NVARCHAR(50) NOT NULL,
    [api_version] NVARCHAR(10) NOT NULL DEFAULT 'v1',
    [model_config_id] UNIQUEIDENTIFIER NOT NULL,
    [message_id] INT NOT NULL,
    [user_id] VARCHAR(255) NOT NULL,
    [prompt_tokens] INT NOT NULL,
    [completion_tokens] INT NOT NULL,
    [total_tokens] INT NOT NULL,
    [latency_ms] INT NOT NULL,
    [success] BIT NOT NULL DEFAULT 1,
    [error_message] NVARCHAR(MAX) NULL,
    [error_code] NVARCHAR(50) NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT [FK_model_responses_model_config] FOREIGN KEY ([model_config_id]) 
        REFERENCES [dbo].[model_configs] ([id]),
    CONSTRAINT [FK_model_responses_message] FOREIGN KEY ([message_id]) 
        REFERENCES [dbo].[messages] ([id]),
    CONSTRAINT [FK_model_responses_user] FOREIGN KEY ([user_id])
        REFERENCES [dbo].[UserPreferences] ([userId])
)
GO

-- Add indexes for performance monitoring queries
CREATE INDEX [IX_model_responses_model_config] ON [dbo].[model_responses] ([model_config_id])
CREATE INDEX [IX_model_responses_created_at] ON [dbo].[model_responses] ([created_at])
CREATE INDEX [IX_model_responses_success] ON [dbo].[model_responses] ([success])
CREATE INDEX [IX_model_responses_request] ON [dbo].[model_responses] ([request_id], [api_version])
CREATE INDEX [IX_model_responses_user] ON [dbo].[model_responses] ([user_id], [created_at])
GO 