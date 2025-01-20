const { SlashCommandBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const { sql, getConnection } = require('../../azureDb');
const config = require('../../config.json');

const openai = new OpenAI({ apiKey: config.openaiKey });

module.exports = {
	data: new SlashCommandBuilder()
		.setName('viewconversations')
		.setDescription('Views a brief summary of each of the user\'s conversations.'),
	async execute(interaction) {
		try {
			await interaction.deferReply(); // Defer the reply
			await getConnection(); // Ensure connection to the database
			const username = interaction.user.username;

			// Fetch the user's ID from the database
			const userResult = await sql.query`SELECT id FROM users WHERE username = ${username}`;
			
			// Check if user exists
			if (!userResult.recordset || userResult.recordset.length === 0) {
				await interaction.followUp('You don\'t have an account yet. Please start a conversation first.');
				return;
			}

			const userId = userResult.recordset[0].id;

			// Fetch the user's conversations from the database
			const conversationsResult = await sql.query`SELECT id FROM conversations WHERE userId = ${userId}`;

			// Check if user has any conversations
			if (!conversationsResult.recordset || conversationsResult.recordset.length === 0) {
				await interaction.followUp('You don\'t have any conversations yet.');
				return;
			}

			// For each conversation, fetch the messages and generate a summary
			for (const conversation of conversationsResult.recordset) {
				const messagesResult = await sql.query`SELECT message FROM messages WHERE conversationId = ${conversation.id} ORDER BY createdAt ASC`;
				const messages = messagesResult.recordset.map(record => record.message);

				// Skip empty conversations
				if (messages.length === 0) {
					await interaction.followUp(`Conversation ${conversation.id}: No messages found.`);
					continue;
				}

				// Generate a summary using the OpenAI API
				const prompt = messages.join('\n');
				const systemMessage = {
					role: "system",
					content: `The following conversation has taken place:\n${prompt}\n\nWhat is a brief summary of this conversation?`
				};

				const completion = await openai.chat.completions.create({
					messages: [systemMessage],
					model: "gpt-4o",
				});
				const summary = completion.choices[0].message.content.trim();

				// Send a new message for each conversation
				await interaction.followUp(`Conversation ${conversation.id}: ${summary}`);
			}
		} catch (error) {
			console.error('Error:', error);
			await interaction.followUp('Failed to view conversations.');
		}
	},
};