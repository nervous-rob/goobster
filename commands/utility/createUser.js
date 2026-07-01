const { SlashCommandBuilder } = require('discord.js');
const db = require('../../db');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('createuser')
		.setDescription('Creates a new user in the database.'),
	async execute(interaction) {
		try {
			const discordUsername = interaction.user.username;
			const discordId = interaction.user.id;

			// Check if user already exists
			const existingUser = db.get('SELECT id FROM users WHERE discordId = @discordId', { discordId });

			if (existingUser) {
				await interaction.reply({ 
					content: 'You already have an account!',
					ephemeral: true 
				});
				return;
			}

			// Create new user
			db.run(
				`INSERT INTO users (discordUsername, discordId, username)
				 VALUES (@discordUsername, @discordId, @discordUsername)`,
				{ discordUsername, discordId }
			);

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
