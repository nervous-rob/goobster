CREATE TABLE [dbo].[UserPreferences] (
    [userId]    VARCHAR (255) NOT NULL,
    [memeMode]  BIT           DEFAULT ((0)) NULL,
    [updatedAt] DATETIME      DEFAULT (getdate()) NULL,
    PRIMARY KEY CLUSTERED ([userId] ASC)
);
GO

