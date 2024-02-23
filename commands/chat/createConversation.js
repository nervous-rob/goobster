const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('createconversation')
		.setDescription('Creates a new conversation.')
		.addStringOption(option =>
			option.setName('promptlabel')
				.setDescription('The label of the prompt for the conversation')
				.setRequired(false)
		)
		.addIntegerOption(option =>
			option.setName('promptid')
				.setDescription('The ID of the prompt for the conversation')
				.setRequired(false)
		),
	async execute(interaction) {
		try {
			await getConnection(); // Ensure connection to the database
			const username = interaction.user.username;
			const promptLabel = interaction.options.getString('promptlabel');
			const promptId = interaction.options.getInteger('promptid');
			
			// Fetch the user's ID from the database
			const userResult = await sql.query`SELECT id FROM users WHERE username = ${username}`;
			const userId = userResult.recordset[0].id;

			let promptIdToUse;
			if (promptId) {
				// If prompt ID is provided, use it
				promptIdToUse = promptId;
			} else if (promptLabel) {
				// If prompt label is provided, fetch the corresponding prompt ID
				const promptResult = await sql.query`SELECT id FROM prompts WHERE label = ${promptLabel} AND userId = ${userId}`;
				promptIdToUse = promptResult.recordset[0].id;
			} else {
				throw new Error('Either prompt ID or prompt label must be provided.');
			}

            await sql.query`INSERT INTO conversations (userId, promptId) VALUES (${userId}, ${promptIdToUse})`;

            // Get the ID of the newly created conversation
            const conversationResult = await sql.query`SELECT id FROM conversations WHERE userId = ${userId} ORDER BY id DESC`;
            const conversationId = conversationResult.recordset[0].id;
            
            // Update the active conversation ID for the user
            await sql.query`UPDATE users SET activeConversationId = ${conversationId} WHERE id = ${userId}`;
            
            await interaction.reply(`Conversation created successfully. The active conversation ID for user ${username} has been updated to ${conversationId}.`);
		} catch (error) {
			console.error('Database operation error:', error);
			await interaction.reply('Failed to create conversation.');
		}
	},
};