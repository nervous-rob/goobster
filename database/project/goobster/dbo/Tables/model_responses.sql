CREATE TABLE [dbo].[model_responses] (
    [id]                UNIQUEIDENTIFIER DEFAULT (newid()) NOT NULL,
    [request_id]        NVARCHAR (50)    NULL,
    [api_version]       NVARCHAR (10)    NOT NULL,
    [model_config_id]   UNIQUEIDENTIFIER NOT NULL,
    [message_id]        INT              NULL,
    [user_id]           BIGINT           NULL,
    [prompt_tokens]     INT              NOT NULL,
    [completion_tokens] INT              NOT NULL,
    [total_tokens]      INT              NOT NULL,
    [latency_ms]        INT              NOT NULL,
    [success]           BIT              NOT NULL,
    [error_message]     NVARCHAR (MAX)   NULL,
    [error_code]        NVARCHAR (50)    NULL,
    [created_at]        DATETIME2 (7)    DEFAULT (getutcdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

CREATE NONCLUSTERED INDEX [IX_model_responses_model_config]
    ON [dbo].[model_responses]([model_config_id] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_model_responses_request]
    ON [dbo].[model_responses]([request_id] ASC, [api_version] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_model_responses_created_at]
    ON [dbo].[model_responses]([created_at] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_model_responses_user]
    ON [dbo].[model_responses]([user_id] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_model_responses_success]
    ON [dbo].[model_responses]([success] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_model_responses_composite]
    ON [dbo].[model_responses]([user_id] ASC, [success] ASC, [created_at] ASC)
    INCLUDE([latency_ms], [total_tokens]);
GO

ALTER TABLE [dbo].[model_responses]
    ADD CONSTRAINT [DF_model_responses_success] DEFAULT ((1)) FOR [success];
GO

ALTER TABLE [dbo].[model_responses]
    ADD CONSTRAINT [DF_model_responses_api_version] DEFAULT ('v1') FOR [api_version];
GO

ALTER TABLE [dbo].[model_responses]
    ADD CONSTRAINT [FK_model_responses_message] FOREIGN KEY ([message_id]) REFERENCES [dbo].[messages] ([id]);
GO

