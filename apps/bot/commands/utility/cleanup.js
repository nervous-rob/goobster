const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('cleanup')
        .setDescription('Delete recent messages from Goobster')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Number of messages to check (default: 100)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(100)),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        
        const amount = interaction.options.getInteger('amount') || 100;
        const channel = interaction.channel;

        try {
            // Fetch recent messages
            const messages = await channel.messages.fetch({ limit: amount });
            
            // Filter for Goobster's messages (including embeds)
            const botMessages = messages.filter(msg => 
                msg.author.id === interaction.client.user.id || // Direct messages from Goobster
                (msg.embeds && msg.embeds.length > 0 && msg.author.bot) // Embed messages
            );
            
            // Delete the messages
            await channel.bulkDelete(botMessages, true);
            
            await interaction.editReply({
                content: `Successfully deleted ${botMessages.size} messages (including embeds).`,
                ephemeral: true
            });
        } catch (error) {
            console.error('Error cleaning up messages:', error);
            await interaction.editReply({
                content: 'There was an error trying to delete messages. Messages older than 14 days cannot be bulk deleted.',
                ephemeral: true
            });
        }
    },
}; 