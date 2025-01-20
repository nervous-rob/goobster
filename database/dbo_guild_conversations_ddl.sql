SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[guild_conversations](
	[id] [int] IDENTITY(1,1) NOT NULL,
	[guildId] [varchar](255) NOT NULL,
	[threadId] [varchar](255) NOT NULL,
	[promptId] [int] NOT NULL,
	[createdAt] [datetime2](7) NOT NULL,
	[updatedAt] [datetime2](7) NOT NULL
) ON [PRIMARY]
GO
ALTER TABLE [dbo].[guild_conversations] ADD PRIMARY KEY CLUSTERED 
(
	[id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
SET ANSI_PADDING ON
GO
CREATE NONCLUSTERED INDEX [idx_guild_thread] ON [dbo].[guild_conversations]
(
	[guildId] ASC,
	[threadId] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, DROP_EXISTING = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
ALTER TABLE [dbo].[guild_conversations] ADD  DEFAULT (getdate()) FOR [createdAt]
GO
ALTER TABLE [dbo].[guild_conversations] ADD  DEFAULT (getdate()) FOR [updatedAt]
GO
ALTER TABLE [dbo].[guild_conversations]  WITH CHECK ADD FOREIGN KEY([promptId])
REFERENCES [dbo].[prompts] ([id])
GO
