const { SlashCommandBuilder } = require('discord.js');
const { diagnoseDatabaseIssues, checkDatabaseHealth } = require('../../utils/chatHandler');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('diagdb')
		.setDescription('Diagnose database connectivity issues'),
	async execute(interaction) {
		// Only allow server admins to run this command
		if (!interaction.member.permissions.has('ADMINISTRATOR')) {
			return interaction.reply({
				content: 'Sorry, this command can only be used by server administrators.',
				ephemeral: true
			});
		}

		await interaction.deferReply();
		
		try {
			// First run a database health check
			await checkDatabaseHealth();
			
			// Then get detailed diagnostics
			const diagnosticResults = await diagnoseDatabaseIssues(interaction);
			
			await interaction.editReply({
				content: diagnosticResults,
				ephemeral: true
			});
		} catch (error) {
			console.error('Error in database diagnostic command:', error);
			await interaction.editReply({
				content: `Error running database diagnostics: ${error.message}`,
				ephemeral: true
			});
		}
	},
}; 