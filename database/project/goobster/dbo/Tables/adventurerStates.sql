CREATE TABLE [dbo].[adventurerStates] (
    [id]            INT            IDENTITY (1, 1) NOT NULL,
    [adventureId]   INT            NOT NULL,
    [partyMemberId] INT            NOT NULL,
    [health]        INT            DEFAULT ((100)) NOT NULL,
    [status]        NVARCHAR (50)  DEFAULT ('ACTIVE') NULL,
    [conditions]    NVARCHAR (MAX) NULL,
    [inventory]     NVARCHAR (MAX) NULL,
    [lastUpdated]   DATETIME       DEFAULT (getdate()) NOT NULL,
    PRIMARY KEY CLUSTERED ([id] ASC),
    FOREIGN KEY ([adventureId]) REFERENCES [dbo].[adventures] ([id]),
    FOREIGN KEY ([partyMemberId]) REFERENCES [dbo].[partyMembers] ([id])
);
GO

ALTER TABLE [dbo].[adventurerStates]
    ADD CONSTRAINT [CHK_adventurer_status] CHECK ([status]='DEAD' OR [status]='INCAPACITATED' OR [status]='INJURED' OR [status]='ACTIVE');
GO

CREATE NONCLUSTERED INDEX [IX_adventurerStates_status]
    ON [dbo].[adventurerStates]([status] ASC);
GO

