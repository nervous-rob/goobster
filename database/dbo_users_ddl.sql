SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[users](
	[id] [int] IDENTITY(1,1) NOT NULL,
	[discordUsername] [nvarchar](255) NOT NULL,
	[discordId] [nvarchar](255) NOT NULL,
	[joinedAt] [datetime] NOT NULL,
	[activeConversationId] [int] NULL,
	[username] [nvarchar](50) NOT NULL
) ON [PRIMARY]
GO
ALTER TABLE [dbo].[users] ADD PRIMARY KEY CLUSTERED 
(
	[id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
SET ANSI_PADDING ON
GO
CREATE NONCLUSTERED INDEX [idx_users_discord] ON [dbo].[users]
(
	[discordUsername] ASC,
	[discordId] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, DROP_EXISTING = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
ALTER TABLE [dbo].[users] ADD  DEFAULT (getdate()) FOR [joinedAt]
GO
ALTER TABLE [dbo].[users]  WITH CHECK ADD  CONSTRAINT [FK_Users_Conversations] FOREIGN KEY([activeConversationId])
REFERENCES [dbo].[conversations] ([id])
GO
ALTER TABLE [dbo].[users] CHECK CONSTRAINT [FK_Users_Conversations]
GO
