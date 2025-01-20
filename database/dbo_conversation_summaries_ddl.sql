SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[conversation_summaries](
	[id] [int] IDENTITY(1,1) NOT NULL,
	[guildConversationId] [int] NOT NULL,
	[summary] [text] NOT NULL,
	[messageCount] [int] NOT NULL,
	[createdAt] [datetime2](7) NOT NULL
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
ALTER TABLE [dbo].[conversation_summaries] ADD PRIMARY KEY CLUSTERED 
(
	[id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
CREATE NONCLUSTERED INDEX [idx_guild_conv_created] ON [dbo].[conversation_summaries]
(
	[guildConversationId] ASC,
	[createdAt] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, DROP_EXISTING = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
ALTER TABLE [dbo].[conversation_summaries] ADD  DEFAULT (getdate()) FOR [createdAt]
GO
ALTER TABLE [dbo].[conversation_summaries]  WITH CHECK ADD FOREIGN KEY([guildConversationId])
REFERENCES [dbo].[guild_conversations] ([id])
GO
