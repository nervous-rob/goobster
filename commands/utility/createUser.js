const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('createuser')
		.setDescription('Creates a new user in the database.'),
	async execute(interaction) {
		try {
			await getConnection(); // Ensure connection to the database
			const username = interaction.user.username;
			await sql.query`INSERT INTO users (username, joinedAt) VALUES (${username}, ${new Date()})`;
			await interaction.reply(`User ${username} created successfully.`);
		} catch (error) {
			console.error('Database operation error:', error);
			await interaction.reply('Failed to create user.');
		}
	},
};