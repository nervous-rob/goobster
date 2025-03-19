CREATE TABLE [dbo].[user_nicknames] (
    [id]        INT            IDENTITY (1, 1) NOT NULL,
    [userId]    VARCHAR (255)  NOT NULL,
    [guildId]   VARCHAR (255)  NOT NULL,
    [nickname]  NVARCHAR (32)  NOT NULL,
    [createdAt] DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    [updatedAt] DATETIME2 (7)  DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [UQ_user_nicknames_user_guild] UNIQUE ([userId], [guildId])
);
GO

-- Create index for faster lookups
CREATE NONCLUSTERED INDEX [idx_user_nicknames_user_guild]
    ON [dbo].[user_nicknames]([userId] ASC, [guildId] ASC);
GO 