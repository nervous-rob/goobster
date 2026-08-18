const perplexityService = require('../services/perplexityService');
const { chunkMessage } = require('./index');
const { SEARCH_APPROVAL, getSearchApproval } = require('./guildSettings');
const db = require('../db');

// Pending approval requests live in SQLite (pending_search_requests) so the
// approve/deny buttons under a search prompt keep working when the bot
// restarts between the prompt and the button press.
const REQUEST_TTL_MINUTES = 15;

class AISearchHandler {
    static MAX_PENDING_REQUESTS = 1000;
    static MAX_SEARCH_RESULTS = 1000;

    // Recent search results, keyed by requestId (transient; consumers receive
    // results directly from the approval flow, this is only a short cache).
    static searchResults = new Map();

    static cleanupOldResults() {
        const now = Date.now();

        // Cleanup more aggressively if near limit
        const maxAge = this.searchResults.size > this.MAX_SEARCH_RESULTS * 0.8
            ? 1800000  // 30 minutes
            : 3600000; // 1 hour

        for (const [requestId, result] of this.searchResults.entries()) {
            if (now - result.timestamp > maxAge) {
                this.searchResults.delete(requestId);
            }
        }

        this._expirePendingRequests();
    }

    static _expirePendingRequests() {
        try {
            db.run(
                `DELETE FROM pending_search_requests
                 WHERE createdAt < datetime('now', '-' || @minutes || ' minutes')`,
                { minutes: REQUEST_TTL_MINUTES }
            );
        } catch (error) {
            console.error('Failed to expire pending search requests:', error.message);
        }
    }

    static _getPendingRequest(requestId) {
        this._expirePendingRequests();
        return db.get(
            'SELECT * FROM pending_search_requests WHERE requestId = @requestId',
            { requestId }
        );
    }

    static _deletePendingRequest(requestId) {
        try {
            db.run('DELETE FROM pending_search_requests WHERE requestId = @requestId', { requestId });
        } catch (error) {
            console.error('Failed to delete pending search request:', error.message);
        }
    }

    static async requestSearch(interaction, query, reason) {
        this._expirePendingRequests();

        const pendingCount = db.get('SELECT COUNT(*) AS count FROM pending_search_requests')?.count || 0;
        if (pendingCount >= this.MAX_PENDING_REQUESTS) {
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

        // If approval is not required, execute the search immediately
        if (!requireApproval) {
            try {
                console.log(`Auto-executing search without approval: "${query}"`);
                const searchResult = await perplexityService.search(query);
                const formattedResult = formatSearchResults(searchResult);

                this.searchResults.set(requestId, {
                    result: formattedResult,
                    timestamp: Date.now()
                });

                return { requestId: null, result: formattedResult };
            } catch (error) {
                console.error('Auto-search execution error:', error);
                await interaction.channel.send('❌ Error executing search. Please try again.');
                throw error;
            }
        }

        console.log(`Requesting approval for search: "${query}"`);
        db.run(
            `INSERT INTO pending_search_requests (requestId, guildId, channelId, query, reason, requireApproval)
             VALUES (@requestId, @guildId, @channelId, @query, @reason, 1)`,
            {
                requestId,
                guildId: interaction.guildId || null,
                channelId: interaction.channelId,
                query,
                reason: reason || null
            }
        );

        return requestId;
    }

    static async handleSearchApproval(requestId, interaction) {
        const request = this._getPendingRequest(requestId);
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

            this.searchResults.set(requestId, {
                result: formattedResult,
                timestamp: Date.now()
            });

            this._deletePendingRequest(requestId);

            return {
                requestId,
                result: formattedResult
            };
        } catch (error) {
            console.error('Search execution error:', error);
            this._deletePendingRequest(requestId);
            await interaction.channel.send('❌ Error executing search. Please try again.');
            return null;
        }
    }

    static async handleSearchDenial(requestId, interaction) {
        const request = this._getPendingRequest(requestId);
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

        this._deletePendingRequest(requestId);
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

// Periodic cleanup of cached results and expired approval requests.
// unref() so the timer never keeps the process alive (e.g. in tests).
setInterval(() => AISearchHandler.cleanupOldResults(), 300000).unref();

module.exports = AISearchHandler;
