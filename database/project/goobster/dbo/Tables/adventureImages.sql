CREATE TABLE [dbo].[adventureImages] (
    [id]              INT            IDENTITY (1, 1) NOT NULL,
    [adventureId]     INT            NOT NULL,
    [imageType]       NVARCHAR (50)  NOT NULL,
    [referenceKey]    NVARCHAR (100) NOT NULL,
    [imageUrl]        NVARCHAR (MAX) NOT NULL,
    [styleParameters] NVARCHAR (MAX) NULL,
    [generatedAt]     DATETIME       DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    FOREIGN KEY ([adventureId]) REFERENCES [dbo].[adventures] ([id])
);
GO

