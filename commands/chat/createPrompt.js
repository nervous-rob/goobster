const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

// Add a default system instruction about search capabilities when creating new prompts
const DEFAULT_SYSTEM_INSTRUCTIONS = `\n\nYou can use the /search command to access real-time information. When needed, format your search requests as: [/search query:"your search query" reason:"explanation of why you need this information"]. Always wait for user approval before proceeding with search-based responses.`;

module.exports = {
	data: new SlashCommandBuilder()
		.setName('createprompt')
		.setDescription('Creates a new prompt.')
		.addStringOption(option =>
			option.setName('text')
				.setDescription('The text of the prompt')
				.setRequired(true)
		)
		.addStringOption(option => // New label option
			option.setName('label')
				.setDescription('The label of the prompt')
				.setRequired(false) // Make it optional
		),
	async execute(interaction) {
		try {
			await getConnection(); // Ensure connection to the database
			const username = interaction.user.username;
			let text = interaction.options.getString('text');
			const label = interaction.options.getString('label'); // Fetch the label
			
			// Append search capabilities to custom prompts if not already included
			if (!text.includes('/search')) {
				text += DEFAULT_SYSTEM_INSTRUCTIONS;
			}

			// Fetch the user's ID from the users table
			const result = await sql.query`SELECT id FROM users WHERE username = ${username}`;
			const userId = result.recordset[0].id;

			await sql.query`INSERT INTO prompts (userId, prompt, label) VALUES (${userId}, ${text}, ${label})`; // Include the label in the insert query
			await interaction.reply(`Prompt created successfully.`);
		} catch (error) {
			console.error('Database operation error:', error);
			await interaction.reply('Failed to create prompt.');
		}
	},
};