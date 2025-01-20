SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[messages](
	[id] [int] IDENTITY(1,1) NOT NULL,
	[conversationId] [int] NOT NULL,
	[message] [nvarchar](max) NOT NULL,
	[createdAt] [datetime] NOT NULL,
	[guildConversationId] [int] NULL,
	[isBot] [bit] NOT NULL,
	[createdBy] [int] NOT NULL
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
ALTER TABLE [dbo].[messages] ADD PRIMARY KEY CLUSTERED 
(
	[id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
CREATE NONCLUSTERED INDEX [idx_messages_created_by] ON [dbo].[messages]
(
	[createdBy] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, DROP_EXISTING = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
ALTER TABLE [dbo].[messages] ADD  DEFAULT (getdate()) FOR [createdAt]
GO
ALTER TABLE [dbo].[messages] ADD  DEFAULT ((0)) FOR [isBot]
GO
ALTER TABLE [dbo].[messages]  WITH CHECK ADD FOREIGN KEY([conversationId])
REFERENCES [dbo].[conversations] ([id])
GO
ALTER TABLE [dbo].[messages]  WITH CHECK ADD  CONSTRAINT [FK_Messages_GuildConversations] FOREIGN KEY([guildConversationId])
REFERENCES [dbo].[guild_conversations] ([id])
GO
ALTER TABLE [dbo].[messages] CHECK CONSTRAINT [FK_Messages_GuildConversations]
GO
ALTER TABLE [dbo].[messages]  WITH CHECK ADD  CONSTRAINT [FK_Messages_Users] FOREIGN KEY([createdBy])
REFERENCES [dbo].[users] ([id])
GO
ALTER TABLE [dbo].[messages] CHECK CONSTRAINT [FK_Messages_Users]
GO
