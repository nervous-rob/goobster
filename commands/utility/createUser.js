const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('createuser')
		.setDescription('Creates a new user in the database.'),
	async execute(interaction) {
		try {
			await getConnection(); // Ensure connection to the database
			const discordUsername = interaction.user.username;
			const discordId = interaction.user.id;

			// Check if user already exists
			const existingUser = await sql.query`
				SELECT id FROM users WHERE discordId = ${discordId}
			`;

			if (existingUser.recordset.length > 0) {
				await interaction.reply({ 
					content: 'You already have an account!',
					ephemeral: true 
				});
				return;
			}

			// Create new user
			await sql.query`
				INSERT INTO users (
					discordUsername,
					discordId,
					username,
					joinedAt
				) VALUES (
					${discordUsername},
					${discordId},
					${discordUsername},
					${new Date()}
				)
			`;

			await interaction.reply({ 
				content: `Account created successfully! Welcome, ${discordUsername}!`,
				ephemeral: true 
			});
		} catch (error) {
			console.error('Database operation error:', error);
			await interaction.reply({ 
				content: 'Failed to create user account. Please try again.',
				ephemeral: true 
			});
		}
	},
};