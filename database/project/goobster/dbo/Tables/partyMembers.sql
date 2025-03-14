CREATE TABLE [dbo].[partyMembers] (
    [id]             INT            IDENTITY (1, 1) NOT NULL,
    [partyId]        INT            NOT NULL,
    [userId]         BIGINT         NOT NULL,
    [adventurerName] NVARCHAR (100) NOT NULL,
    [backstory]      NVARCHAR (MAX) NULL,
    [memberType]     NVARCHAR (50)  DEFAULT ('member') NOT NULL,
    [joinedAt]       DATETIME       DEFAULT (getdate()) NOT NULL,
    [lastUpdated]    DATETIME       DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    CONSTRAINT [CHK_member_type] CHECK ([memberType]='guest' OR [memberType]='member' OR [memberType]='leader'),
    FOREIGN KEY ([partyId]) REFERENCES [dbo].[parties] ([id]),
    CONSTRAINT [UQ_party_member] UNIQUE NONCLUSTERED ([partyId] ASC, [userId] ASC)
);
GO

CREATE NONCLUSTERED INDEX [IX_partyMembers_userId]
    ON [dbo].[partyMembers]([userId] ASC);
GO

