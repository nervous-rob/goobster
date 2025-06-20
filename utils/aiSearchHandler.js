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
const perplexityService = require('../services/perplexityService');
const { chunkMessage } = require('./index');
const { SEARCH_APPROVAL, getSearchApproval } = require('./guildSettings');

class AISearchHandler {
    static MAX_PENDING_REQUESTS = 1000;
    static MAX_SEARCH_RESULTS = 1000;
    static CLEANUP_INTERVAL = 300000; // 5 minutes
    
    // Initialize static Maps for tracking searches
    static searchResults = new Map();
    static pendingRequests = new Map();
    
    constructor() {
        // Set up periodic cleanup
        setInterval(() => this.cleanupOldResults(), AISearchHandler.CLEANUP_INTERVAL);
    }
    
    static cleanupOldResults() {
        const now = Date.now();
        
        // Cleanup more aggressively if near limit
        const maxAge = this.searchResults.size > this.MAX_SEARCH_RESULTS * 0.8 
            ? 1800000  // 30 minutes
            : 3600000; // 1 hour

        // Cleanup search results
        for (const [requestId, result] of this.searchResults.entries()) {
            if (now - result.timestamp > maxAge) {
                this.searchResults.delete(requestId);
            }
        }

        // Cleanup pending requests
        for (const [requestId, request] of this.pendingRequests.entries()) {
            if (now - request.timestamp > 900000) { // 15 minutes
                this.pendingRequests.delete(requestId);
            }
        }

        // Log cleanup metrics
        console.log('Search cache cleanup:', {
            remainingResults: this.searchResults.size,
            remainingRequests: this.pendingRequests.size,
            timestamp: new Date().toISOString()
        });
    }

    static async requestSearch(interaction, query, reason) {
        // Check limits before adding new request
        if (this.pendingRequests.size >= this.MAX_PENDING_REQUESTS) {
            throw new Error('Too many pending search requests. Please try again later.');
        }

        const requestId = `${interaction.channelId}-${Date.now()}`;
        
        // Check if search approval is required for this guild
        let requireApproval = true;
        if (interaction.guildId) {
            try {
                const approvalSetting = await getSearchApproval(interaction.guildId);
                requireApproval = approvalSetting === SEARCH_APPROVAL.REQUIRED;
            } catch (error) {
                console.error('Error checking search approval setting:', error);
                // Default to requiring approval if there's an error
                requireApproval = true;
            }
        }

        // Store request details
        this.pendingRequests.set(requestId, {
            query,
            reason,
            interaction,
            channelId: interaction.channelId,
            timestamp: Date.now(),
            requireApproval
        });

        // If approval is not required, automatically approve the search
        if (!requireApproval) {
            // Execute the search immediately
            try {
                console.log(`Auto-executing search without approval: "${query}"`);
                const searchResult = await perplexityService.search(query);
                const formattedResult = formatSearchResults(searchResult);

                // Store the result
                this.searchResults.set(requestId, {
                    result: formattedResult,
                    timestamp: Date.now()
                });

                // Clean up
                this.pendingRequests.delete(requestId);

                // Return result for further processing
                return { requestId: null, result: formattedResult };
            } catch (error) {
                console.error('Auto-search execution error:', error);
                this.pendingRequests.delete(requestId);
                await interaction.channel.send('❌ Error executing search. Please try again.');
                throw error;
            }
        } else {
            console.log(`Requesting approval for search: "${query}"`);
        }

        // Clean up old requests after 5 minutes
        setTimeout(() => {
            if (this.pendingRequests.has(requestId)) {
                this.pendingRequests.delete(requestId);
            }
        }, 300000);

        return requestId;
    }

    static async handleSearchApproval(requestId, interaction) {
        const request = this.pendingRequests.get(requestId);
        if (!request) {
            return null;
        }

        try {
            await interaction.message.edit({
                content: `✅ Search request approved by ${interaction.user.tag}`,
                components: []
            });

            const searchResult = await perplexityService.search(request.query);
            const formattedResult = formatSearchResults(searchResult);

            // Store the result
            this.searchResults.set(requestId, {
                result: formattedResult,
                timestamp: Date.now()
            });

            // Clean up
            this.pendingRequests.delete(requestId);

            return {
                requestId,
                result: formattedResult
            };
        } catch (error) {
            console.error('Search execution error:', error);
            this.pendingRequests.delete(requestId);
            await interaction.channel.send('❌ Error executing search. Please try again.');
            return null;
        }
    }

    static async handleSearchDenial(requestId, interaction) {
        const request = this.pendingRequests.get(requestId);
        if (!request) {
            return false;
        }

        await interaction.message.edit({
            content: `❌ Search request denied by ${interaction.user.tag}`,
            components: []
        });

        await interaction.channel.send(
            "I'll do my best to help based on my existing knowledge! 😊"
        );

        this.pendingRequests.delete(requestId);
        return true;
    }

    static getSearchResult(requestId) {
        return this.searchResults.get(requestId);
    }

    static async handleSearchResults(interaction, results) {
        try {
            const chunks = chunkMessage(results);
            
            // Send chunks sequentially
            for (const [index, chunk] of chunks.entries()) {
                if (index === 0) {
                    await interaction.editReply(chunk);
                } else {
                    await interaction.followUp(chunk);
                }
            }
            
            return true;
        } catch (error) {
            console.error('Error handling search results:', error);
            await interaction.editReply('Error formatting search results. Please try again.');
            return false;
        }
    }
}

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

module.exports = AISearchHandler; 