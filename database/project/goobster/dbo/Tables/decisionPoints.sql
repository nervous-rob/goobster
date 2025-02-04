CREATE TABLE [dbo].[decisionPoints] (
    [id]              INT            IDENTITY (1, 1) NOT NULL,
    [adventureId]     INT            NOT NULL,
    [partyMemberId]   INT            NOT NULL,
    [situation]       NVARCHAR (MAX) NOT NULL,
    [choices]         NVARCHAR (MAX) NOT NULL,
    [choiceMade]      NVARCHAR (MAX) NULL,
    [consequence]     NVARCHAR (MAX) NULL,
    [plotProgress]    NVARCHAR (MAX) NULL,
    [keyElementsUsed] NVARCHAR (MAX) NULL,
    [createdAt]       DATETIME       DEFAULT (getdate()) NOT NULL,
    [resolvedAt]      DATETIME       NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    FOREIGN KEY ([adventureId]) REFERENCES [dbo].[adventures] ([id]),
    FOREIGN KEY ([partyMemberId]) REFERENCES [dbo].[partyMembers] ([id])
);
GO

CREATE NONCLUSTERED INDEX [IX_decisionPoints_resolvedAt]
    ON [dbo].[decisionPoints]([resolvedAt] ASC);
GO

