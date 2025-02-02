const { SlashCommandBuilder } = require('discord.js');
const perplexityService = require('../../services/perplexityService');
const AISearchHandler = require('../../utils/aiSearchHandler');

// Helper function to format search results for Discord
function formatSearchResults(results) {
    // Remove any existing Discord formatting characters that might interfere
    let formatted = results.replace(/([*_~`|])/g, '\\$1');
    
    // Split into sections if the response has headers
    const sections = formatted.split(/(?=#{1,3}\s)/);
    
    return sections.map(section => {
        // Format headers properly for Discord
        section = section.replace(/^###\s+(.+)$/gm, '**__$1__**');
        section = section.replace(/^##\s+(.+)$/gm, '__$1__');
        section = section.replace(/^#\s+(.+)$/gm, '**$1**');
        
        // Format lists properly
        section = section.replace(/^\*\s+(.+)$/gm, '• $1');
        section = section.replace(/^-\s+(.+)$/gm, '• $1');
        
        // Format code blocks properly
        section = section.replace(/```(\w+)?\n([\s\S]+?)```/g, '```\n$2```');
        
        // Format links properly
        section = section.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 (<$2>)');
        
        return section;
    }).join('\n\n');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search the web using Perplexity AI')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('What would you like to search for?')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('(AI Only) Reason for search request')
                .setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const query = interaction.options.getString('query');
            const reason = interaction.options.getString('reason');

            // Check if this is an AI request
            if (interaction.user.id === interaction.client.user.id) {
                // Request permission for search
                const requestId = await AISearchHandler.requestSearch(interaction, query, reason);
                await interaction.editReply({
                    content: `🤖 I've requested permission to search for information about "${query}". Please wait for approval.`,
                    ephemeral: true
                });
                return;
            }

            // Regular user search - execute immediately
            const searchResult = await perplexityService.search(query);
            const formattedResult = formatSearchResults(searchResult);
            
            await interaction.editReply({
                content: `🔍 **Search Results:**\n\n${formattedResult}`
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