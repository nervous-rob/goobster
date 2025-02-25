CREATE TABLE [dbo].[prompts] (
    [id]        INT            IDENTITY (1, 1) NOT NULL,
    [userId]    BIGINT         NOT NULL,
    [prompt]    NVARCHAR (MAX) NOT NULL,
    [label]     NVARCHAR (50)  NULL,
    [isDefault] BIT            DEFAULT ((0)) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC)
);
GO


CREATE NONCLUSTERED INDEX [IX_prompts_userId]
    ON [dbo].[prompts]([userId] ASC)
    INCLUDE([label], [isDefault]);
GO

