// TODO: Add proper handling for search request conflicts
// TODO: Add proper handling for search request validation
// TODO: Add proper handling for search request limits
// TODO: Add proper handling for search request expiration
// TODO: Add proper handling for search request state
// TODO: Add proper handling for search request permissions
// TODO: Add proper handling for search result persistence
// TODO: Add proper handling for search result validation
// TODO: Add proper handling for search result limits
// TODO: Add proper handling for search result expiration
// TODO: Add proper handling for search result state
// TODO: Add proper handling for search result cleanup

const { PermissionsBitField } = require('discord.js');
const { chunkMessage } = require('./index');
const { SEARCH_APPROVAL, getSearchApproval } = require('./guildSettings');
const aiService = require('../services/ai/instance');

class AISearchHandler {
    constructor() {
        this.searchQueue = new Map();
        this.searchResults = new Map();
    }

    async handleSearchRequest(interaction, query, reason) {
        try {
            // Check if search requires approval
            const requiresApproval = await getSearchApproval(interaction.guildId);
            if (requiresApproval) {
                // Create approval message
                const approvalMessage = await interaction.reply({
                    content: `🔍 Search Request:\nQuery: "${query}"\nReason: "${reason}"\n\nPlease approve or deny this search request.`,
                    components: [
                        {
                            type: 1,
                            components: [
                                {
                                    type: 2,
                                    style: 3,
                                    label: 'Approve',
                                    custom_id: 'search_approve'
                                },
                                {
                                    type: 2,
                                    style: 4,
                                    label: 'Deny',
                                    custom_id: 'search_deny'
                                }
                            ]
                        }
                    ],
                    ephemeral: true
                });

                // Store search request in queue
                this.searchQueue.set(interaction.id, {
                    query,
                    reason,
                    interaction,
                    approvalMessage
                });

                return;
            }

            // If no approval required, proceed with search
            await this.executeSearch(interaction, query, reason);
        } catch (error) {
            console.error('Error handling search request:', error);
            await interaction.reply({
                content: '❌ An error occurred while processing your search request.',
                ephemeral: true
            });
        }
    }

    async executeSearch(interaction, query, reason) {
        try {
            await interaction.deferReply();

            // Generate search response using AI service
            const response = await aiService.generateResponse({
                model: 'perplexity:sonar-pro',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful assistant that provides accurate and concise information based on real-time web search results.'
                    },
                    {
                        role: 'user',
                        content: `Search query: "${query}"\nReason: "${reason}"`
                    }
                ],
                temperature: 0.7,
                maxTokens: 2000
            });

            // Split response into chunks if needed
            const chunks = chunkMessage(response.content);
            
            // Send first chunk as reply
            await interaction.editReply(chunks[0]);

            // Send remaining chunks as follow-ups
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp(chunks[i]);
            }

            // Store search result
            this.searchResults.set(interaction.id, {
                query,
                response: response.content,
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('Error executing search:', error);
            await interaction.editReply({
                content: '❌ An error occurred while performing the search.',
                ephemeral: true
            });
        }
    }

    async handleSearchApproval(interaction) {
        const searchRequest = this.searchQueue.get(interaction.message.id);
        if (!searchRequest) {
            await interaction.reply({
                content: '❌ Search request not found.',
                ephemeral: true
            });
            return;
        }

        const { query, reason } = searchRequest;

        if (interaction.customId === 'search_approve') {
            // Remove from queue and execute search
            this.searchQueue.delete(interaction.message.id);
            await interaction.update({
                content: '✅ Search request approved. Processing...',
                components: []
            });
            await this.executeSearch(interaction, query, reason);
        } else if (interaction.customId === 'search_deny') {
            // Remove from queue and notify
            this.searchQueue.delete(interaction.message.id);
            await interaction.update({
                content: '❌ Search request denied.',
                components: []
            });
        }
    }

    async handleSearchResultRequest(interaction) {
        const searchResult = this.searchResults.get(interaction.message.id);
        if (!searchResult) {
            await interaction.reply({
                content: '❌ No search result found for this message.',
                ephemeral: true
            });
            return;
        }

        const { query, response, timestamp } = searchResult;
        const chunks = chunkMessage(`🔍 Search Query: "${query}"\n\n${response}`);
        
        // Send first chunk as reply
        await interaction.reply(chunks[0]);

        // Send remaining chunks as follow-ups
        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(chunks[i]);
        }
    }
}

module.exports = new AISearchHandler(); 