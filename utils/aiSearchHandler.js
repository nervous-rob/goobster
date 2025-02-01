const { PermissionsBitField } = require('discord.js');
const perplexityService = require('../services/perplexityService');

class AISearchHandler {
    static pendingRequests = new Map();
    static searchResults = new Map();

    static async requestSearch(interaction, query, reason) {
        const requestId = `${interaction.channelId}-${Date.now()}`;
        
        // Create permission request message with buttons
        const permissionMessage = await interaction.channel.send({
            content: `🔍 **Search Request**\n\nI'd like to search for information about:\n> ${query}\n\n**Reason:** ${reason}\n\nDo you approve this search?`,
            components: [{
                type: 1,
                components: [
                    {
                        type: 2,
                        custom_id: `approve_search_${requestId}`,
                        label: 'Approve Search',
                        style: 3 // Green
                    },
                    {
                        type: 2,
                        custom_id: `deny_search_${requestId}`,
                        label: 'Deny Search',
                        style: 4 // Red
                    }
                ]
            }]
        });

        // Store request details
        this.pendingRequests.set(requestId, {
            query,
            reason,
            interaction,
            messageId: permissionMessage.id,
            channelId: interaction.channelId,
            timestamp: Date.now()
        });

        // Clean up old requests after 5 minutes
        setTimeout(() => {
            if (this.pendingRequests.has(requestId)) {
                this.pendingRequests.delete(requestId);
                permissionMessage.edit({
                    content: '⏳ Search request expired.',
                    components: []
                }).catch(console.error);
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
            // Execute the search
            const searchResult = await perplexityService.search(request.query);
            
            // Store the result
            this.searchResults.set(requestId, {
                query: request.query,
                result: searchResult,
                timestamp: Date.now()
            });

            // Update the original message
            await interaction.message.edit({
                content: `✅ Search approved by ${interaction.user.tag}`,
                components: []
            });

            // Split the search results into chunks if needed
            const messageChunks = chunkMessage(searchResult, '🔍 **Search Results:**\n');
            
            // Send each chunk
            let resultMessageId;
            for (const [index, chunk] of messageChunks.entries()) {
                const message = await interaction.channel.send({
                    content: chunk + (index === messageChunks.length - 1 ? '\n\n*I\'ll now provide my analysis based on this information!*' : '')
                });
                
                // Store the ID of the first message
                if (index === 0) {
                    resultMessageId = message.id;
                }
            }

            // Clean up
            this.pendingRequests.delete(requestId);

            return {
                requestId,
                result: searchResult,
                resultMessageId
            };
        } catch (error) {
            console.error('Search execution error:', error);
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
            "I'll try my best to help without searching for current information! 😊"
        );

        this.pendingRequests.delete(requestId);
        return true;
    }

    static getSearchResult(requestId) {
        return this.searchResults.get(requestId);
    }

    static cleanupOldResults() {
        const now = Date.now();
        for (const [requestId, result] of this.searchResults.entries()) {
            if (now - result.timestamp > 3600000) { // 1 hour
                this.searchResults.delete(requestId);
            }
        }
    }
}

// Clean up old results periodically
setInterval(() => AISearchHandler.cleanupOldResults(), 3600000);

// Add function to chunk messages for Discord's 2000 character limit
function chunkMessage(message, prefix = '') {
    // Leave room for prefix and formatting
    const maxLength = 1900 - prefix.length;
    
    // If message is already short enough, return as single chunk
    if (message.length <= maxLength) {
        return [prefix + message];
    }
    
    // Split into chunks, preferring to split at paragraph breaks or sentences
    const chunks = [];
    let currentChunk = prefix;
    
    // Split into paragraphs first
    const paragraphs = message.split(/\n\n+/);
    
    for (const paragraph of paragraphs) {
        // If paragraph fits in current chunk, add it
        if (currentChunk.length + paragraph.length + 2 <= maxLength) {
            if (currentChunk !== prefix) {
                currentChunk += '\n\n';
            }
            currentChunk += paragraph;
        } else {
            // If current paragraph is too long, split it into sentences
            const sentences = paragraph.split(/(?<=[.!?])\s+/);
            
            for (const sentence of sentences) {
                // If sentence fits in current chunk, add it
                if (currentChunk.length + sentence.length + 1 <= maxLength) {
                    if (currentChunk !== prefix) {
                        currentChunk += ' ';
                    }
                    currentChunk += sentence;
                } else {
                    // If current chunk has content, push it and start new chunk
                    if (currentChunk !== prefix) {
                        chunks.push(currentChunk);
                        currentChunk = prefix + sentence;
                    } else {
                        // If sentence is too long, split it into words
                        const words = sentence.split(/\s+/);
                        for (const word of words) {
                            if (currentChunk.length + word.length + 1 <= maxLength) {
                                if (currentChunk !== prefix) {
                                    currentChunk += ' ';
                                }
                                currentChunk += word;
                            } else {
                                chunks.push(currentChunk);
                                currentChunk = prefix + word;
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Push final chunk if it has content
    if (currentChunk !== prefix) {
        chunks.push(currentChunk);
    }
    
    return chunks;
}

module.exports = AISearchHandler; 