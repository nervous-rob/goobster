const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('ping')
		.setDescription('Replies with Pong and checks DB connectivity!'),
	async execute(interaction) {
		try {
			await getConnection(); // Ensure connection to the database
			const result = await sql.query`SELECT TOP 1 name FROM sys.databases`; // Test query
			await interaction.reply(`Pong! DB Connection Successful. Sample DB Name: ${result.recordset[0].name}`);
		} catch (error) {
			console.error('Database connection error:', error);
			await interaction.reply('Pong! But, failed to connect to the database.');
		}
	},
};
