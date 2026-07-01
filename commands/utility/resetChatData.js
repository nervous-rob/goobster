const { SlashCommandBuilder } = require('discord.js');
const db = require('../../db');

module.exports = {
	data: new SlashCommandBuilder()
		.setName('resetchatdata')
		.setDescription('Deletes all of the user\'s prompts, conversations, and messages.'),
	async execute(interaction) {
		try {
			// Look up the user by Discord ID (more reliable than username)
			const user = db.get('SELECT id FROM users WHERE discordId = @discordId', { discordId: interaction.user.id });

			if (!user) {
				await interaction.reply({ content: 'No chat data found for your account.', ephemeral: true });
				return;
			}

			db.transaction(() => {
				db.run('UPDATE users SET activeConversationId = NULL WHERE id = @userId', { userId: user.id });
				db.run(
					'DELETE FROM messages WHERE conversationId IN (SELECT id FROM conversations WHERE userId = @userId)',
					{ userId: user.id }
				);
				db.run('DELETE FROM conversations WHERE userId = @userId', { userId: user.id });
				db.run('DELETE FROM prompts WHERE userId = @userId', { userId: user.id });
			});

			await interaction.reply('Your chat data has been reset.');
		} catch (error) {
			console.error('Database operation error:', error);
			await interaction.reply('Failed to reset chat data.');
		}
	},
};
