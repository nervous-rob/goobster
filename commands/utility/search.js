const { SlashCommandBuilder } = require('discord.js');
const perplexityService = require('../../services/perplexityService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search the web using Perplexity AI')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('What would you like to search for?')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const query = interaction.options.getString('query');
            const searchResult = await perplexityService.search(query);

            await interaction.editReply({
                content: `🔍 **Search Results:**\n${searchResult}`
            });
        } catch (error) {
            console.error('Search command error:', error);
            await interaction.editReply({
                content: '❌ Sorry, I encountered an error while searching. Please try again later.',
                ephemeral: true
            });
        }
    },
}; 