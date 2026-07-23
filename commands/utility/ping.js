const { SlashCommandBuilder } = require('discord.js');
const db = require('../../db');

module.exports = {
	// Registered globally with DM contexts (see deploy-commands.js)
	dmAllowed: true,
	data: new SlashCommandBuilder()
		.setName('ping')
		.setDescription('Replies with Pong and checks DB connectivity!'),
	async execute(interaction) {
		// Defer the reply immediately to prevent timeout
		await interaction.deferReply();
		
		try {
			const result = db.get('SELECT sqlite_version() AS version');
			const latency = Math.round(interaction.client.ws.ping);
			await interaction.editReply(
				`Pong! 🏓 Gateway latency: ${latency}ms. Database OK (SQLite ${result.version}).`
			);
		} catch (error) {
			console.error('Database connection error:', error);
			await interaction.editReply('Pong! Database check failed. Please try again later.');
		}
	},
};
