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

const { SlashCommandBuilder } = require('@discordjs/builders');
const { createLogger } = require('../../utils/logger');
const aiService = require('../../services/ai/instance');

const logger = createLogger('SearchCommand');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search for information on a topic')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('What to search for')
                .setRequired(true)),

    async execute(interaction) {
        try {
            const query = interaction.options.getString('query');
            
            // Generate search results using Perplexity service
            const searchPrompt = `
Generate a comprehensive search result for: "${query}"

Provide a well-structured response that:
1. Directly answers the query
2. Includes relevant facts and details
3. Cites sources when possible
4. Uses clear formatting and bullet points
5. Stays focused and concise

Return ONLY the search results, nothing else.`;

            const searchResponse = await aiService.generateResponse({
                messages: [
                    { role: 'system', content: 'You are an expert at providing accurate and well-structured search results.' },
                    { role: 'user', content: searchPrompt }
                ],
                model: 'perplexity:sonar-pro', // Use Perplexity's Sonar Pro model for search
                temperature: 0.3,
                maxTokens: 1000
            });

            await interaction.reply(searchResponse.content);
        } catch (error) {
            logger.error('Error executing search command:', error);
            await interaction.reply({
                content: 'Sorry, I encountered an error while searching. Please try again.',
                ephemeral: true
            });
        }
    }
}; 