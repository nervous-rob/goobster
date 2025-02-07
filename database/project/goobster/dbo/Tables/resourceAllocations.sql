CREATE TABLE [dbo].[resourceAllocations] (
    [id]            INT            IDENTITY (1, 1) NOT NULL,
    [adventureId]   INT            NOT NULL,
    [resourceType]  NVARCHAR (50)  NOT NULL,
    [limits]        NVARCHAR (MAX) NOT NULL,
    [used]          INT            DEFAULT ((0)) NOT NULL,
    [lastReset]     DATETIME       DEFAULT (getdate()) NOT NULL,
    [resetInterval] INT            NOT NULL,
    [allocated]     INT            DEFAULT ((0)) NOT NULL,
    [metadata]      NVARCHAR (MAX) DEFAULT ('{}') NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [CHK_resource_type] CHECK ([resourceType]='api_calls' OR [resourceType]='images' OR [resourceType]='tokens'),
    FOREIGN KEY ([adventureId]) REFERENCES [dbo].[adventures] ([id])
);
GO

CREATE NONCLUSTERED INDEX [IX_resourceAllocations_type]
    ON [dbo].[resourceAllocations]([resourceType] ASC);
GO

ALTER TABLE [dbo].[resourceAllocations]
    ADD CONSTRAINT [CHK_resource_type] CHECK ([resourceType]='api_calls' OR [resourceType]='images' OR [resourceType]='tokens');
GO

