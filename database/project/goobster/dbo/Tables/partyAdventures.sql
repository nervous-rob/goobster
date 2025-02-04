CREATE TABLE [dbo].[partyAdventures] (
    [partyId]     INT      NOT NULL,
    [adventureId] INT      NOT NULL,
    [joinedAt]    DATETIME DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([partyId] ASC, [adventureId] ASC),
    FOREIGN KEY ([adventureId]) REFERENCES [dbo].[adventures] ([id]),
    FOREIGN KEY ([partyId]) REFERENCES [dbo].[parties] ([id])
);
GO

