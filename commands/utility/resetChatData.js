const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('resetchatdata')
		.setDescription('Deletes all of the user\'s prompts, conversations, and messages.'),
	async execute(interaction) {
		try {
			await getConnection(); // Ensure connection to the database
			const username = interaction.user.username;

			// Fetch the user's ID from the users table
			const userResult = await sql.query`SELECT id FROM users WHERE username = ${username}`;
			const userId = userResult.recordset[0].id;

			// Set the activeConversationId to NULL for the user
			await sql.query`UPDATE users SET activeConversationId = NULL WHERE id = ${userId}`;

			// Delete the user's messages
			await sql.query`DELETE FROM messages WHERE conversationId IN (SELECT id FROM conversations WHERE userId = ${userId})`;

			// Delete the user's conversations
			await sql.query`DELETE FROM conversations WHERE userId = ${userId}`;

			// Delete the user's prompts
			await sql.query`DELETE FROM prompts WHERE userId = ${userId}`;

			await interaction.reply('Your chat data has been reset.');
		} catch (error) {
			console.error('Database operation error:', error);
			await interaction.reply('Failed to reset chat data.');
		}
	},
};