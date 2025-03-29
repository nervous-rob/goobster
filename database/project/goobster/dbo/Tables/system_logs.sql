CREATE TABLE [dbo].[system_logs] (
    [id]          INT            IDENTITY (1, 1) NOT NULL,
    [log_level]   VARCHAR (20)   NOT NULL,
    [message]     NVARCHAR (MAX) NOT NULL,
    [metadata]    NVARCHAR (MAX) NULL,
    [createdAt]   DATETIME2 (7)  DEFAULT (getutcdate()) NOT NULL,
    [source]      VARCHAR (100)  NULL,
    [error_code]  VARCHAR (50)   NULL,
    [error_state] VARCHAR (50)   NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO

CREATE NONCLUSTERED INDEX [IX_system_logs_createdAt]
    ON [dbo].[system_logs]([createdAt] ASC);
GO

CREATE NONCLUSTERED INDEX [IX_system_logs_level_date]
    ON [dbo].[system_logs]([log_level] ASC, [createdAt] ASC);
GO

ALTER TABLE [dbo].[system_logs]
    ADD CONSTRAINT [CHK_log_level] CHECK ([log_level]='DEBUG' OR [log_level]='INFO' OR [log_level]='WARN' OR [log_level]='ERROR');
GO

