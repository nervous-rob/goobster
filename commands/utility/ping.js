const { SlashCommandBuilder } = require('discord.js');
const { sql, getConnection } = require('../../azureDb');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('ping')
		.setDescription('Replies with Pong and checks DB connectivity!'),
	async execute(interaction) {
		// Defer the reply immediately to prevent timeout
		await interaction.deferReply();
		
		try {
			const pool = await getConnection();
			if (!pool) {
				return await interaction.editReply('Pong! (Database connection failed)');
			}
			
			const result = await sql.query`SELECT TOP 1 name FROM sys.databases`;
			await interaction.editReply(`Pong! DB Connection Successful. Sample DB Name: ${result.recordset[0].name}`);
		} catch (error) {
			console.error('Database connection error:', error);
			await interaction.editReply('Pong! Database connection failed. Please try again later.');
		}
	},
};
