const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('viewprompts')
		.setDescription('Views the user\'s prompts.'),
	async execute(interaction) {
		try {
			await getConnection(); // Ensure connection to the database
			const username = interaction.user.username;

			// Fetch the user's ID from the users table
			const userResult = await sql.query`SELECT id FROM users WHERE username = ${username}`;
			const userId = userResult.recordset[0].id;

			// Fetch the user's prompts from the prompts table
			const promptsResult = await sql.query`SELECT prompt, label FROM prompts WHERE userId = ${userId}`;
			const prompts = promptsResult.recordset;

			// Format the prompts for display
			let reply = 'Your prompts:\n';
			for (let i = 0; i < prompts.length; i++) {
				reply += `Prompt ${i+1}: ${prompts[i].prompt} (Label: ${prompts[i].label || 'None'})\n`;
			}

			await interaction.reply(reply);
		} catch (error) {
			console.error('Database operation error:', error);
			await interaction.reply('Failed to fetch prompts.');
		}
	},
};