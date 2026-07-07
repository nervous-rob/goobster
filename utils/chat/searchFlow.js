/**
 * Legacy search detection and approval workflow, plus handling of the
 * prompt-protocol directives (/search, /generate) that models without native
 * tool support emit in their text responses.
 *
 * Only used for providers without native web search (Ollama); OpenAI and
 * Gemini search mid-response via built-in tools.
 */
const db = require('../../db');
const aiService = require('../../services/aiService');
const AISearchHandler = require('../aiSearchHandler');
const imageDetectionHandler = require('../imageDetectionHandler');
const { chunkMessage } = require('../index');
const { getPromptWithGuildPersonality } = require('../memeMode');
const { getThreadPreference, THREAD_PREFERENCE } = require('../guildSettings');
const { getOrCreateThreadSafely } = require('./threadManager');
const { getOrCreateUser, createPlaceholderThreadId } = require('./chatDb');

// Track pending image generations by channel (in-flight guard)
const pendingImageGenerations = new Map();

// In-flight search deduplication, persisted in SQLite (pending_searches) so
// a restart between detection and completion cannot double-fire a search.
function isSearchPending(channelId, query) {
    try {
        // Clean up old searches (older than 5 minutes)
        db.run(`DELETE FROM pending_searches WHERE createdAt < datetime('now', '-5 minutes')`);
        return Boolean(db.get(
            'SELECT 1 FROM pending_searches WHERE channelId = @channelId AND query = @query',
            { channelId, query }
        ));
    } catch (error) {
        console.error('Error checking pending search:', error.message);
        return false;
    }
}

// Add function to track a new search
function trackSearch(channelId, query) {
    try {
        db.run(
            `INSERT INTO pending_searches (channelId, query) VALUES (@channelId, @query)
             ON CONFLICT(channelId, query) DO UPDATE SET createdAt = CURRENT_TIMESTAMP`,
            { channelId, query }
        );
    } catch (error) {
        console.error('Error tracking pending search:', error.message);
    }
}

// Add function to remove a completed search
function completeSearch(channelId, query) {
    try {
        db.run(
            'DELETE FROM pending_searches WHERE channelId = @channelId AND query = @query',
            { channelId, query }
        );
    } catch (error) {
        console.error('Error completing pending search:', error.message);
    }
}

// Add function to check for existing search requests
async function checkExistingSearchRequest(channel, query, botId) {
    try {
        const recentMessages = await channel.messages.fetch({ limit: 5 });
        return recentMessages.find(msg => 
            msg.author.id === botId && 
            msg.content.includes('Search Request') &&
            msg.content.includes(query)
        );
    } catch (error) {
        console.error('Error checking for existing search request:', {
            error: error.message || 'Unknown error',
            stack: error.stack || 'No stack trace available',
            channelId: channel.id,
            query
        });
        return null;
    }
}

async function handleAIResponse(response, interaction) {
    // Add null/undefined check at the beginning
    if (!response || typeof response !== 'string') {
        console.warn('handleAIResponse received null/undefined response:', response);
        return response; // Return as-is if not a string
    }
    
    // Check for search request
    const searchMatch = response.match(/\/search query:"([^"]+)"\s+reason:"([^"]+)"/);
    if (searchMatch) {
        const [, query, reason] = searchMatch;
        try {
            // Use consolidated check for existing search request
            const existingRequest = await checkExistingSearchRequest(
                interaction.channel,
                query,
                interaction.client.user.id
            );

            if (existingRequest) {
                return `I've already requested a search for "${query}". Please approve or deny that request first.`;
            }

            // Request search permission
            const requestData = await AISearchHandler.requestSearch(interaction, query, reason);
            if (requestData && requestData.requestId === null) {
                const guildId = interaction.guild?.id;
                const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
                const response = await aiService.chatText([
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `I need to search for "${query}". ${reason ? `Reason: ${reason}` : ''}` },
                        { role: 'system', content: `Here is relevant information: ${requestData.result}` }
                    ], {
                        preset: 'chat',
                        max_tokens: 150
                    });

                const chunks = chunkMessage(response);
                await interaction.editReply({ content: chunks[0], ephemeral: true });
                for (let i = 1; i < chunks.length; i++) {
                    await interaction.followUp({ content: chunks[i], ephemeral: true });
                }
                return null;
            }
            return `🔍 I've requested permission to search for information about "${query}". Please approve or deny the request.`;
        } catch (error) {
            console.error('Error requesting search permission:', {
                error: error.message || 'Unknown error',
                stack: error.stack || 'No stack trace available',
                query,
                reason
            });
            return `I apologize, but I encountered an error while trying to search for information. Let me try to help without the search.`;
        }
    }

    // Check for image generation intent
    const imageMatch = response.match(/\/generate image:"([^"]+)"\s+type:"([^"]+)"\s+style:"([^"]*)"/i);
    if (imageMatch) {
        const [, prompt, type, style] = imageMatch;
        try {
            // Check if we're already generating an image for this channel
            const channelId = interaction.channelId;
            if (pendingImageGenerations.has(channelId)) {
                return `I'm already working on generating an image. Please wait for that to complete first.`;
            }

            // Mark that we're generating an image
            pendingImageGenerations.set(channelId, Date.now());

            // Generate the image
            const imageType = type.toUpperCase();
            const validTypes = ['CHARACTER', 'SCENE', 'LOCATION', 'ITEM'];
            
            const finalType = validTypes.includes(imageType) ? imageType : 'SCENE';
            const finalStyle = style || 'fantasy';

            // Send a message indicating we're generating an image
            await interaction.editReply(`🎨 I'm generating an image of: ${prompt}\nThis might take a moment...`);

            // Generate the image
            const imagePath = await imageDetectionHandler.generateImage(prompt, finalType, finalStyle);
            
            // Clear the pending flag
            pendingImageGenerations.delete(channelId);

            // Return a special marker for the caller to handle
            return `__IMAGE_GENERATION_RESULT__${imagePath}__END_IMAGE_GENERATION__`;
        } catch (error) {
            // Clear the pending flag on error
            pendingImageGenerations.delete(interaction.channelId);
            
            console.error('Error generating image:', error);
            return `I apologize, but I encountered an error while trying to generate that image: ${error.message}`;
        }
    }

    return response;
}

/**
 * Uses AI to detect if a message requires a search
 * @param {string} message - The user's message
 * @returns {Promise<Object>} - Object with needsSearch flag and suggested query if needed
 */
async function detectSearchNeed(message) {
    try {
        // First, use a simple prompt to determine if the message needs a search
        const searchDetectionPrompt = `
You are an AI assistant that determines if a user message requires a web search to provide an accurate response.

User message: "${message}"

Analyze the message and determine if it:
1. Asks for current events, news, or time-sensitive information
2. Requests factual information that might change over time
3. Asks about specific data, statistics, or facts that you might not have in your training data
4. Explicitly asks to search for something

Respond with ONLY "true" if a web search is needed, or "false" if no search is needed.
`;

        const needsSearchResponse = await aiService.generateText(searchDetectionPrompt, {
            temperature: 0.1, // Low temperature for more deterministic response
            max_tokens: 10,   // Very short response needed
        });

        const needsSearch = needsSearchResponse.trim().toLowerCase() === 'true';

        if (needsSearch) {
            // If search is needed, use a second prompt to generate the optimal search query
            const searchQueryPrompt = `
You are an AI assistant that creates effective search queries based on user messages.

User message: "${message}"

Create a concise, specific search query that will find the most relevant information to answer this message.
Focus on the key information need and remove any unnecessary context or pleasantries.
Make sure to create a query that will find the MOST CURRENT information available.
DO NOT include specific years in the query unless the user explicitly asked about a specific year.
Respond with ONLY the search query text, nothing else.
`;

            const suggestedQuery = await aiService.generateText(searchQueryPrompt, {
                temperature: 0.3,
                max_tokens: 50,
                includeCurrentDate: true // Include current date in the prompt
            });

            return {
                needsSearch: true,
                suggestedQuery: suggestedQuery.trim(),
                reason: `User asked about information that may require a search: ${message}`
            };
        }

        return { needsSearch: false };
    } catch (error) {
        console.error('Error in AI-based search detection:', error);
        
        // Fall back to the original keyword-based detection if AI detection fails
        return fallbackDetectSearchNeed(message);
    }
}

/**
 * Fallback method using keyword matching to detect search needs
 * @param {string} message - The user's message
 * @returns {Object} - Object with needsSearch flag and suggested query if needed
 */
function fallbackDetectSearchNeed(message) {
    const searchIndicators = [
        /current|latest|recent|news|today|yesterday|this week|this month|this year/i,
        /look up|search|find|check|get/i,
        /what is|who is|where is|when is|why is|how is/i,
        /what are|who are|where are|when are|why are|how are/i,
    ];

    // Check if the message contains time-sensitive or search-related keywords
    const needsSearch = searchIndicators.some(pattern => pattern.test(message));

    if (needsSearch) {
        // Extract the main topic for search by looking for key phrases
        let searchTopic = '';

        // Common patterns for search requests
        const searchPatterns = [
            /(?:can you |could you |please |)(?:search|look up|find)(?: for| about|) (.*?)(?:\.|\?|!|$)/i,  // "search for X"
            /(?:what|who|where|when|why|how) (?:is|are|was|were|do|does|did) (.*?)(?:\.|\?|!|$)/i,  // "what is X"
            /(?:tell me about|find information on|get details on) (.*?)(?:\.|\?|!|$)/i,  // "tell me about X"
            /(?:I want to know|I need to know|I'd like to know) (?:about |more about |)(.*?)(?:\.|\?|!|$)/i,  // "I want to know about X"
            /(?:what's|who's|where's|when's|why's|how's) (.*?)(?:\.|\?|!|$)/i,  // "what's X"
        ];

        for (const pattern of searchPatterns) {
            const match = message.match(pattern);
            if (match && match[1]) {
                searchTopic = match[1].trim();
                break;
            }
        }

        // If no pattern matched, try to extract based on trigger words
        if (!searchTopic) {
            const triggerWords = ['look up', 'search', 'find', 'check', 'get', 'latest', 'current'];
            for (const word of triggerWords) {
                const index = message.toLowerCase().indexOf(word);
                if (index !== -1) {
                    searchTopic = message.slice(index + word.length).split(/[,.!?]/)[0].trim();
                    break;
                }
            }
        }

        // If we found a topic, return the search info
        if (searchTopic) {
            return {
                needsSearch: true,
                suggestedQuery: searchTopic,
                reason: `User asked about current information regarding: ${searchTopic}`
            };
        }
    }

    return { needsSearch: false };
}

// Handle the search flow. The trimmedMessage parameter contains the user's
// original message and is used when generating the immediate response after an
// auto-approved search.
async function handleSearchFlow(searchInfo, interaction, thread, trimmedMessage) {
    const channelId = thread?.id || interaction.channel.id;
    
    // Check if this search is already pending
    if (isSearchPending(channelId, searchInfo.suggestedQuery)) {
        return `I'm already processing a search for "${searchInfo.suggestedQuery}". Please wait for that to complete first.`;
    }
    
    // Track this new search
    trackSearch(channelId, searchInfo.suggestedQuery);
    
    try {
        // If thread is not provided, try to get it from the interaction
        if (!thread && interaction.channel && !interaction.channel.isThread() && interaction.guildId) {
            // Get the guild's thread preference
            const threadPreference = await getThreadPreference(interaction.guildId);
            
            // If preference is ALWAYS_THREAD, create/use a thread
            if (threadPreference === THREAD_PREFERENCE.ALWAYS_THREAD) {
                const channelName = interaction.channel.name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
                const threadName = `goobster-chat-${channelName}`;
                
                try {
                    thread = await getOrCreateThreadSafely(interaction.channel, threadName);
                    
                    // Send welcome message only for newly created threads
                    if (!thread.messages.cache.size) {
                        await thread.send(
                            "👋 Hi! I've created this thread for our conversation. " +
                            "You can continue chatting with me here by:\n" +
                            "1. Using `/chat` command\n" +
                            `2. Mentioning me (@${interaction.client.user.username})\n\n` +
                            "The thread will keep our conversation organized and maintain context!"
                        );
                    }
                    
                    // Notify the user that we've created a thread
                    if (interaction.channel !== thread) {
                        await interaction.channel.send({
                            content: `I've continued our conversation in a thread: ${thread}`,
                            allowedMentions: { users: [], roles: [] }
                        });
                    }
                } catch (error) {
                    console.error('Error creating/finding thread:', error);
                    // If we can't create a thread, use the channel directly
                    thread = null;
                }
            }
        } else if (interaction.channel?.isThread()) {
            thread = interaction.channel;
        }

        // Use consolidated check for existing search request
        const existingRequest = await checkExistingSearchRequest(
            thread || interaction.channel,
            searchInfo.suggestedQuery,
            interaction.client.user.id
        );

        if (existingRequest) {
            completeSearch(channelId, searchInfo.suggestedQuery);
            return `I've already requested a search for "${searchInfo.suggestedQuery}". Please approve or deny that request first.`;
        }

        // Request search permission
        const requestData = await AISearchHandler.requestSearch(
            interaction,
            searchInfo.suggestedQuery,
            searchInfo.reason
        );

        // If requestId is null, it means the search was executed automatically
        // because approval is not required for this guild
        if (requestData && requestData.requestId === null) {
            completeSearch(channelId, searchInfo.suggestedQuery);

            // Generate final response using the search result
            const guildId = interaction.guild?.id;
            const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
            const conversationHistory = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: trimmedMessage },
                { role: 'system', content: `Here is relevant information to help answer the question: ${requestData.result}` }
            ];

            const responseContent = await aiService.chatText(conversationHistory, {
                preset: 'chat',
                max_tokens: 500
            });

            await interaction.editReply(responseContent);
            return null; // Indicate no further action
        }

        // Approval required: requestSearch returned the request ID as a string
        const requestId = typeof requestData === 'string' ? requestData : requestData?.requestId;

        // Update the permission request message to use chunking if needed
        const requestContent = `🔍 **Search Request**\n\nI'd like to gather some up-to-date information about:\n> ${searchInfo.suggestedQuery}\n\n**Reason:** ${searchInfo.reason}\n\nDo you approve this search?`;
        
        const messageChunks = chunkMessage(requestContent);
        
        // Send the permission request with buttons
        await (thread || interaction.channel).send({
            content: messageChunks[0], // First chunk
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

        // Send any additional chunks as follow-up messages
        for (let i = 1; i < messageChunks.length; i++) {
            await (thread || interaction.channel).send({
                content: messageChunks[i]
            });
        }

        // If we received a search response, try to store it in the database
        const searchResponse = `🔍 I've requested permission to search for information about "${searchInfo.suggestedQuery}". Please approve or deny the request.`;
        try {
            const localBotUserId = getOrCreateUser(interaction.client.user.id, 'Goobster');

            // Resolve the guild conversation row for this channel/thread
            const localThreadId = thread?.id || createPlaceholderThreadId(interaction.channel?.id || interaction.channelId);
            const guildConvRow = db.get(
                `SELECT id FROM guild_conversations
                 WHERE guildId = @guildId AND channelId = @channelId AND threadId = @threadId`,
                {
                    guildId: interaction.guildId,
                    channelId: interaction.channel?.id || interaction.channelId,
                    threadId: localThreadId
                }
            );

            if (guildConvRow) {
                const userRow = db.get('SELECT id FROM users WHERE discordId = @discordId', { discordId: interaction.user.id });
                if (userRow) {
                    const conversationRow = db.get(
                        'SELECT id FROM conversations WHERE userId = @userId AND guildConversationId = @guildConvId',
                        { userId: userRow.id, guildConvId: guildConvRow.id }
                    );

                    if (conversationRow) {
                        db.run(
                            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot, metadata)
                             VALUES (@conversationId, @guildConvId, @createdBy, @message, 1, @metadata)`,
                            {
                                conversationId: conversationRow.id,
                                guildConvId: guildConvRow.id,
                                createdBy: localBotUserId,
                                message: searchResponse,
                                metadata: JSON.stringify({ pendingSearch: true, query: searchInfo.suggestedQuery })
                            }
                        );
                    }
                }
            }
        } catch (dbError) {
            console.error('Database error during search processing:', dbError);
            // Continue with the search response even if DB operations fail
        }

        return searchResponse;
    } catch (error) {
        // Make sure to remove the search tracking on error
        completeSearch(channelId, searchInfo.suggestedQuery);
        // Re-throw the error to be handled by the caller
        throw error;
    }
}

module.exports = {
    pendingImageGenerations,
    isSearchPending,
    trackSearch,
    completeSearch,
    checkExistingSearchRequest,
    handleAIResponse,
    detectSearchNeed,
    fallbackDetectSearchNeed,
    handleSearchFlow
};
