// TODO: Add proper handling for search API rate limits
// TODO: Add proper handling for search timeouts
// TODO: Add proper handling for API errors
// TODO: Add proper handling for long search results
// TODO: Add proper handling for malformed markdown
// TODO: Add proper handling for search query validation
// TODO: Add proper handling for message length limits
// TODO: Add proper handling for concurrent search requests
// TODO: Add proper handling for request approval timeouts
// TODO: Add proper handling for expired search requests

const { SlashCommandBuilder } = require('discord.js');
const perplexityService = require('../../services/perplexityService');
const AISearchHandler = require('../../utils/aiSearchHandler');
const { chunkMessage } = require('../../utils/index');
const { getPromptWithGuildPersonality } = require('../../utils/memeMode');
const aiService = require('../../services/aiService');

// Helper function to format search results for Discord
function formatSearchResults(results) {
    // Remove any existing Discord formatting characters that might interfere
    let formatted = results.replace(/([*_~`|])/g, '\\$1');
    
    // Split into sections if the response has headers
    const sections = formatted.split(/(?=#{1,3}\s)/);
    
    let formattedText = sections.map(section => {
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

    // Import chunkMessage at the top of the file if not already present
    return chunkMessage(formattedText);
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
                const requestId = await AISearchHandler.requestSearch(interaction, query, reason);
                const guildId = interaction.guild?.id;
                const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
                const response = await aiService.chat([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `I need to search for "${query}". ${reason ? `Reason: ${reason}` : ''}` }
                    ], {
                        preset: 'chat',
                        max_tokens: 150
                    });

                const chunks = chunkMessage(response);
                
                await interaction.editReply({
                    content: chunks[0],
                    ephemeral: true
                });
                
                for (let i = 1; i < chunks.length; i++) {
                    await interaction.followUp({
                        content: chunks[i],
                        ephemeral: true
                    });
                }
                return;
            }

            // Regular user search - execute immediately
            const searchResult = await perplexityService.search(query);
            const formattedResult = formatSearchResults(searchResult);
            const chunks = chunkMessage(`🔍 **Search Results:**\n\n${formattedResult}`);
            
            await interaction.editReply({
                content: chunks[0]
            });
            
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({
                    content: chunks[i]
                });
            }
        } catch (error) {
            console.error('Search command error:', error);
            await interaction.editReply({
                content: '❌ Sorry, I encountered an error while searching. Please try again later.',
                ephemeral: true
            });
        }
    },
}; 