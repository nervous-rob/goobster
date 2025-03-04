const { OpenAI } = require('openai');
const { sql, getConnection } = require('../azureDb');
const config = require('../config.json');
const { ThreadAutoArchiveDuration } = require('discord.js');
const AISearchHandler = require('./aiSearchHandler');
const { chunkMessage } = require('./index');
const { getPrompt, getPromptWithGuildPersonality } = require('./memeMode');
const { getThreadPreference, THREAD_PREFERENCE, getPersonalityDirective } = require('./guildSettings');
const openaiService = require('../services/openaiService');
const imageDetectionHandler = require('./imageDetectionHandler');
const path = require('path');

const openai = new OpenAI({ apiKey: config.openaiKey });

// Add a Map to track pending searches by channel
const pendingSearches = new Map();

// Add a Map to track pending image generations by channel
const pendingImageGenerations = new Map();

// Add at the top with other constants
const threadLocks = new Map();

// Add near the top with other constants
const MAX_WORD_LENGTH = 500;

// Add near the top with other constants
const TRANSACTION_TIMEOUT = 30000; // 30 seconds

/**
 * Creates a placeholder thread ID for channel-only conversations
 * @param {string} channelId - The Discord channel ID
 * @returns {string} - A placeholder thread ID
 */
function createPlaceholderThreadId(channelId) {
    return `channel-${channelId}`;
}

// Add function to check if a search is pending
function isSearchPending(channelId, query) {
    const channelSearches = pendingSearches.get(channelId);
    if (!channelSearches) return false;
    
    // Clean up old searches (older than 5 minutes)
    const now = Date.now();
    for (const [key, timestamp] of channelSearches.entries()) {
        if (now - timestamp > 300000) { // 5 minutes
            channelSearches.delete(key);
        }
    }
    
    return channelSearches.has(query);
}

// Add function to track a new search
function trackSearch(channelId, query) {
    let channelSearches = pendingSearches.get(channelId);
    if (!channelSearches) {
        channelSearches = new Map();
        pendingSearches.set(channelId, channelSearches);
    }
    channelSearches.set(query, Date.now());
}

// Add function to remove a completed search
function completeSearch(channelId, query) {
    const channelSearches = pendingSearches.get(channelId);
    if (channelSearches) {
        channelSearches.delete(query);
        if (channelSearches.size === 0) {
            pendingSearches.delete(channelId);
        }
    }
}

const DEFAULT_PROMPT = `You are Goobster, a quirky and clever Discord bot with a passion for helping users and a dash of playful sass. You love making witty observations and dropping the occasional pun, but you always stay focused on being genuinely helpful.

Key Traits:
- Friendly and approachable, but not afraid to show personality
- Loves making clever wordplay and references when appropriate
- Takes pride in being accurate and helpful
- Excited about learning new things alongside users

You have access to real-time web search capabilities through the /search command. When users ask for current information or facts you're not certain about, you should:

1. Acknowledge their request 
2. Use the /search command by replying with a message in this EXACT format (including quotes):
   "/search query:"your search query here" reason:"why you need this information""

You also have image generation capabilities! When users ask you to create, draw, or generate an image, you can:

1. Acknowledge their request
2. Use the built-in image generation by replying with a message in this EXACT format (including quotes):
   "/generate image:"detailed description of what to generate" type:"CHARACTER|SCENE|LOCATION|ITEM" style:"fantasy|realistic|anime|comic|watercolor|oil_painting""

Example image generation responses:

For character portraits:
"I'd love to visualize that character for you! /generate image:"tall elven warrior with silver hair and emerald eyes, wearing ornate plate armor with flowing blue cape" type:"CHARACTER" style:"fantasy""

For scenes:
"Let me create that scene! /generate image:"futuristic cyberpunk city street at night with neon signs and flying cars" type:"SCENE" style:"realistic""

For locations:
"I'll draw that place for you! /generate image:"ancient stone temple ruins in a dense jungle with vines and statues" type:"LOCATION" style:"watercolor""

For items:
"Let me show you how I imagine that! /generate image:"ornate magical staff with glowing crystal and dragon motifs" type:"ITEM" style:"fantasy""

Example search responses:

When needing current info:
"Let me check the latest data on that! /search query:"current cryptocurrency market trends March 2024" reason:"User asked about crypto prices, and even a bot as clever as me needs up-to-date numbers to give accurate advice!""

When verifying facts:
"I want to make sure I give you the most accurate info! /search query:"latest Mars rover discoveries 2024" reason:"Need to verify recent Mars exploration data""

Remember:
- Be enthusiastic but professional
- Make search queries and image prompts specific and focused
- Use appropriate emojis and formatting to make responses engaging
- Stay helpful and informative while maintaining your quirky personality`;

const CONTEXT_WINDOW_SIZE = 20; // Number of messages to keep in active context
const SUMMARY_TRIGGER = 30; // Number of messages that triggers a summary

async function summarizeContext(messages, guildConvId) {
    try {
        const messageText = messages
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');

        const summaryPrompt = `Please provide a brief, bullet-point summary of the key points from this conversation. Focus on the most important information that would be relevant for future context:\n\n${messageText}`;

        const completion = await openai.chat.completions.create({
            messages: [{ role: 'user', content: summaryPrompt }],
            model: "gpt-4o",
            temperature: 0.7,
            max_tokens: 500
        });

        const summary = completion.choices[0].message.content;
        
        // Chunk the summary if needed
        const chunks = chunkMessage(summary);
        if (chunks.length > 1) {
            console.warn('Summary required chunking - may need to adjust summary length');
        }
        
        // Store the summary
        const transaction = await sql.transaction();
        await transaction.begin();

        try {
            await sql.query`
                INSERT INTO conversation_summaries (guildConversationId, summary, messageCount)
                VALUES (${guildConvId}, ${chunks[0]}, ${messages.length})
            `;

            await transaction.commit();
        } catch (dbError) {
            await transaction.rollback();
            console.error('Database Error:', dbError);
            throw new Error('Failed to store conversation summary in database.');
        }

        return chunks[0]; // Use first chunk as summary
    } catch (error) {
        console.error('Error summarizing context:', error);
        throw error;
    }
}

async function getContextWithSummary(thread, guildConvId, userId = null, interaction = null) {
    // Get recent messages
    let messages;
    let botUserId;
    let guildId = null;
    
    if (thread) {
        // If we have a thread, fetch messages from it
        messages = await thread.messages.fetch({ limit: CONTEXT_WINDOW_SIZE });
        botUserId = thread.client.user.id;
        guildId = thread.guild?.id;
    } else if (interaction && interaction.channel) {
        // If we don't have a thread but have a channel, fetch messages from the channel
        messages = await interaction.channel.messages.fetch({ limit: CONTEXT_WINDOW_SIZE });
        botUserId = interaction.client.user.id;
        guildId = interaction.guild?.id;
    } else {
        // If we have neither thread nor channel, return an empty array
        // The system prompt will be added by the calling function
        return [];
    }
    
    const conversationHistory = messages
        .reverse()
        .map(m => ({
            role: m.author.id === botUserId ? 'assistant' : 'user',
            content: m.content,
            messageId: m.id,
            authorId: m.author.id
        }))
        .filter(m => m.content && !m.content.startsWith('/'));

    // If user-specific context is requested, prioritize their messages
    if (userId) {
        conversationHistory.sort((a, b) => {
            if (a.authorId === userId && b.authorId !== userId) return -1;
            if (a.authorId !== userId && b.authorId === userId) return 1;
            return 0;
        });
    }

    // Handle message references and quotes
    for (let i = 0; i < conversationHistory.length; i++) {
        const msg = messages.find(m => m.id === conversationHistory[i].messageId);
        if (msg?.reference?.messageId) {
            const referencedMsg = messages.find(m => m.id === msg.reference.messageId);
            if (referencedMsg) {
                conversationHistory[i].content = `[Replying to: "${referencedMsg.content.substring(0, 50)}${referencedMsg.content.length > 50 ? '...' : ''}"]\n${conversationHistory[i].content}`;
            }
        }
    }

    // Don't add system prompt here - will be handled by the main chat handler
    // to ensure personality directive is applied correctly

    // Check if we need to generate a summary
    if (messages.size >= SUMMARY_TRIGGER) {
        const summaryResult = await sql.query`
            SELECT TOP 1 summary 
            FROM conversation_summaries 
            WHERE guildConversationId = ${guildConvId}
            ORDER BY createdAt DESC
        `;

        if (summaryResult.recordset.length > 0) {
            // Add summary as a system message at the beginning
            conversationHistory.unshift({
                role: 'system',
                content: `Previous conversation summary:\n${summaryResult.recordset[0].summary}`
            });
        } else {
            const summary = await summarizeContext(conversationHistory, guildConvId);
            if (summary) {
                // Add generated summary as a system message
                conversationHistory.unshift({
                    role: 'system',
                    content: `Previous conversation summary:\n${summary}`
                });
            }
        }
    }

    return conversationHistory;
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
            const requestId = await AISearchHandler.requestSearch(interaction, query, reason);
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

            // Return a special marker for the processMessage function to handle
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

Respond with ONLY "true" if a search is needed, or "false" if no search is needed.
`;

        const needsSearchResponse = await openaiService.generateText(searchDetectionPrompt, {
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

            const suggestedQuery = await openaiService.generateText(searchQueryPrompt, {
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

// Add this function to handle the search flow
async function handleSearchFlow(searchInfo, interaction, thread) {
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
        const requestId = await AISearchHandler.requestSearch(
            interaction,
            searchInfo.suggestedQuery,
            searchInfo.reason
        );
        
        // If requestId is null, it means the search was executed automatically
        // because approval is not required for this guild
        if (requestId === null) {
            completeSearch(channelId, searchInfo.suggestedQuery);
            return null; // Return null to indicate no further action is needed
        }

        // Update the permission request message to use chunking if needed
        const requestContent = `🔍 **Search Request**\n\nI'd like to gather some up-to-date information about:\n> ${searchInfo.suggestedQuery}\n\n**Reason:** ${searchInfo.reason}\n\nDo you approve this search?`;
        
        const messageChunks = chunkMessage(requestContent);
        
        // Send the permission request with buttons
        const permissionMessage = await (thread || interaction.channel).send({
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

        return `🔍 I've requested permission to search for information about "${searchInfo.suggestedQuery}". Please approve or deny the request.`;
    } catch (error) {
        // Make sure to remove the search tracking on error
        completeSearch(channelId, searchInfo.suggestedQuery);
        // Re-throw the error to be handled by the caller
        throw error;
    }
}

async function handleChatInteraction(interaction, thread = null) {
    let conversationId = null;
    let guildConvId = null;
    let userId = null;
    let botUserId = null;
    let db = null;
    const isSlashCommand = interaction.commandName === 'chat';
    const isVoiceInteraction = !isSlashCommand && 
                             interaction.commandName === 'voice' && 
                             interaction.options && 
                             typeof interaction.options.getString === 'function';
    
    try {
        // For slash commands, defer the reply immediately to prevent timeout
        if (isSlashCommand && !interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }
        
        // Initialize database connection first
        db = await getConnection();
        if (!db) {
            throw new Error('Failed to establish database connection');
        }

        // Get message content, checking both slash command and mention formats
        const userMessage = interaction.options?.getString?.('message') || 
                           interaction.options?.getString?.() || 
                           interaction.content;

        if (!userMessage) {
            throw new Error('No message provided. Please include a message to chat with me!');
        }

        if (typeof userMessage !== 'string') {
            throw new Error('Invalid message format. Please provide a text message.');
        }

        const trimmedMessage = userMessage.trim();
        if (trimmedMessage.length === 0) {
            throw new Error('Message cannot be empty. Please provide some text to chat with me!');
        }

        if (trimmedMessage.length > 2000) {
            throw new Error('Message is too long. Please keep your message under 2000 characters.');
        }

        // If this is a role-style mention of the bot, don't treat it as a role mention
        // This handles cases where the mention format is <@&botId> instead of <@botId>
        if (interaction.isRoleStyleBotMention) {
            console.log('Handling role-style bot mention as a direct mention');
        }

        // Get thread preference for this guild/conversation
        const threadPreference = await getThreadPreference(interaction.guildId);
        
        // If we don't have a thread but should, create one
        if (!thread && threadPreference === THREAD_PREFERENCE.ALWAYS) {
            const threadName = await getThreadName(interaction.user);
            thread = await getOrCreateThreadSafely(interaction.channel, threadName);
            
            if (!thread) {
                console.error(`Failed to create thread for conversation in guild ${interaction.guildId}`);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply('I had trouble creating a thread for our conversation. Let\'s chat here instead!');
                } else if (interaction.deferred) {
                    await interaction.editReply('I had trouble creating a thread for our conversation. Let\'s chat here instead!');
                }
            }
        }

        // Check if this message might need a search
        // Use the AI-based detection for more accurate results
        const searchInfo = await detectSearchNeed(trimmedMessage);
        
        if (searchInfo.needsSearch) {
            console.log('Search need detected:', {
                message: trimmedMessage,
                suggestedQuery: searchInfo.suggestedQuery,
                reason: searchInfo.reason
            });
            
            // Handle the search flow
            const searchResponse = await handleSearchFlow(searchInfo, interaction, thread);
            
            // If the search flow returned a response, we're done
            if (searchResponse) {
                // Get or create bot user first
                const botUserResult = await db.query`
                    SELECT id FROM users 
                    WHERE discordId = ${interaction.client.user.id}
                `;
                
                if (botUserResult.recordset.length === 0) {
                    await db.query`
                        INSERT INTO users (discordUsername, discordId, username) 
                        VALUES ('Goobster', ${interaction.client.user.id}, 'Goobster')
                    `;
                    const newBotUserResult = await db.query`
                        SELECT id FROM users 
                        WHERE discordId = ${interaction.client.user.id}
                    `;
                    botUserId = newBotUserResult.recordset[0].id;
                } else {
                    botUserId = botUserResult.recordset[0].id;
                }

                // Get guild conversation ID for recording message
                guildConvId = thread?.id || createPlaceholderThreadId(interaction.channel?.id || interaction.channelId);
                
                // Store the search request in the conversation context if needed
                if (conversationId) {
                    await db.query`
                        INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot, metadata) 
                        VALUES (${conversationId}, ${guildConvId}, ${botUserId}, ${searchResponse}, 1, ${JSON.stringify({ pendingSearch: true, query: searchInfo.suggestedQuery })})
                    `;
                }
                
                // Send response in chunks
                const chunks = chunkMessage(searchResponse);
                await sendChunkedResponse(interaction, chunks);
                return searchResponse;
            } else if (searchResponse === null) {
                // If searchResponse is null, it means the search was executed automatically
                // because approval is not required for this guild
                console.log('Search was executed automatically without approval');
                
                // We can continue with normal chat processing, but we'll skip the AI response
                // since the search results have already been sent
                return "Search executed automatically";
            }
            
            console.log('Continuing with normal chat after search handling');
        }

        console.log('Processing interaction:', {
            type: isVoiceInteraction ? 'voice' : (isSlashCommand ? 'slash' : 'mention'),
            message: trimmedMessage,
            messageLength: trimmedMessage.length,
            hasOptions: !!interaction.options,
            commandName: interaction.commandName
        });

        // Get or create bot user first
        const botUserResult = await db.query`
            SELECT id FROM users 
            WHERE discordId = ${interaction.client.user.id}
        `;
        
        if (botUserResult.recordset.length === 0) {
            await db.query`
                INSERT INTO users (discordUsername, discordId, username) 
                VALUES ('Goobster', ${interaction.client.user.id}, 'Goobster')
            `;
            const newBotUserResult = await db.query`
                SELECT id FROM users 
                WHERE discordId = ${interaction.client.user.id}
            `;
            botUserId = newBotUserResult.recordset[0].id;
        } else {
            botUserId = botUserResult.recordset[0].id;
        }

        // Initialize database records first
        // Get or create user
        const userResult = await db.query`
            SELECT id FROM users 
            WHERE discordId = ${interaction.user.id}
        `;

        if (userResult.recordset.length === 0) {
            await db.query`
                INSERT INTO users (discordUsername, discordId, username) 
                VALUES (${interaction.user.username}, ${interaction.user.id}, ${interaction.user.username})
            `;
            const newUserResult = await db.query`
                SELECT id FROM users 
                WHERE discordId = ${interaction.user.id}
            `;
            userId = newUserResult.recordset[0].id;
        } else {
            userId = userResult.recordset[0].id;
        }

        // Get or create guild conversation with thread ID
        const guildConvResult = await db.query`
            SELECT id FROM guild_conversations 
            WHERE guildId = ${interaction.guildId} 
            AND channelId = ${interaction.channel?.id || interaction.channelId}
            AND threadId = ${thread?.id || createPlaceholderThreadId(interaction.channel?.id || interaction.channelId)}
        `;
        
        if (guildConvResult.recordset.length === 0) {
            // Get default prompt
            const defaultPromptResult = await db.query`
                SELECT TOP 1 id FROM prompts 
                WHERE isDefault = 1
            `;
            
            const promptId = defaultPromptResult.recordset[0]?.id;
            
            await db.query`
                INSERT INTO guild_conversations 
                (guildId, channelId, threadId, promptId) 
                VALUES (
                    ${interaction.guildId}, 
                    ${interaction.channel?.id || interaction.channelId},
                    ${thread?.id || createPlaceholderThreadId(interaction.channel?.id || interaction.channelId)},
                    ${promptId}
                )
            `;
            const newGuildConvResult = await db.query`
                SELECT id FROM guild_conversations 
                WHERE guildId = ${interaction.guildId} 
                AND channelId = ${interaction.channel?.id || interaction.channelId}
                AND threadId = ${thread?.id || createPlaceholderThreadId(interaction.channel?.id || interaction.channelId)}
            `;
            guildConvId = newGuildConvResult.recordset[0].id;
        } else {
            guildConvId = guildConvResult.recordset[0].id;
        }

        // Get or create conversation
        const conversationResult = await db.query`
            SELECT id FROM conversations 
            WHERE userId = ${userId} 
            AND guildConversationId = ${guildConvId}
        `;
        
        if (conversationResult.recordset.length === 0) {
            await db.query`
                INSERT INTO conversations (userId, guildConversationId) 
                VALUES (${userId}, ${guildConvId})
            `;
            const newConversationResult = await db.query`
                SELECT id FROM conversations 
                WHERE userId = ${userId} 
                AND guildConversationId = ${guildConvId}
            `;
            conversationId = newConversationResult.recordset[0].id;
        } else {
            conversationId = conversationResult.recordset[0].id;
        }

        // Start typing indicator
        if (thread) {
            await thread.sendTyping();
        } else if (interaction.channel) {
            await interaction.channel.sendTyping();
        }

        // Get conversation history with summary management
        const conversationHistory = await getContextWithSummary(thread, guildConvId, userId, interaction);
        
        // Prepare conversation for OpenAI
        const promptResult = await db.query`
            SELECT prompt FROM prompts p
            JOIN guild_conversations gc ON gc.promptId = p.id
            WHERE gc.id = ${guildConvId}
        `;
        
        if (!promptResult.recordset.length) {
            throw new Error('Failed to retrieve conversation prompt.');
        }

        // Get the base prompt from the database
        let systemPrompt = promptResult.recordset[0].prompt;
        
        // Check if there's a personality directive for the guild
        const personalityDirective = await getPersonalityDirective(interaction.guildId, interaction.user.id);
        
        if (personalityDirective) {
            // Append the personality directive to the prompt
            systemPrompt = `${systemPrompt}

GUILD DIRECTIVE:
${personalityDirective}

This directive applies only in this server and overrides any conflicting instructions.`;
        }

        // Replace the system prompt in the first message of conversationHistory if it exists
        // This ensures we don't apply the personality directive twice
        if (conversationHistory.length > 0 && conversationHistory[0].role === 'system') {
            // Remove the first system message completely - we'll add our own
            conversationHistory.shift();
        }

        const apiMessages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user', content: trimmedMessage }
        ];
        
        // Generate response
        try {
            // Start typing indicator
            if (thread) {
                await thread.sendTyping();
            } else if (interaction.channel) {
                await interaction.channel.sendTyping();
            }
            
            const aiResponse = await openai.chat.completions.create({
                messages: apiMessages,
                model: "gpt-4o",
                temperature: 0.7,
                max_tokens: 1000
            });

            const responseContent = aiResponse.choices[0].message.content;
            
            // Process the response (check for search or image generation requests)
            const processedResponse = await handleAIResponse(responseContent, interaction);
            
            // Check if this is an image generation result
            if (processedResponse && processedResponse.startsWith('__IMAGE_GENERATION_RESULT__')) {
                // Extract the image path
                const imagePath = processedResponse
                    .replace('__IMAGE_GENERATION_RESULT__', '')
                    .replace('__END_IMAGE_GENERATION__', '');
                
                // Send the image
                await interaction.editReply("✨ Here's the generated image!");
                await interaction.channel.send({
                    files: [{
                        attachment: imagePath,
                        name: path.basename(imagePath)
                    }]
                });
                
                // Store messages in database with transaction
                const transaction = await db.transaction();
                await transaction.begin();
                
                try {
                    await executeWithTimeout(async () => {
                        // Store user message
                        await db.query`
                            INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot) 
                            VALUES (${conversationId}, ${guildConvId}, ${userId}, ${trimmedMessage}, 0)
                        `;
                        
                        // Store bot response as a simple note that an image was generated
                        await db.query`
                            INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot, metadata) 
                            VALUES (${conversationId}, ${guildConvId}, ${botUserId}, ${"I've generated an image based on your request."}, 1, ${JSON.stringify({ imageGenerated: true, prompt: trimmedMessage })})
                        `;
                    }, TRANSACTION_TIMEOUT);
                    
                    await transaction.commit();
                } catch (dbError) {
                    await transaction.rollback();
                    console.error('Database Error:', {
                        error: dbError.message,
                        stack: dbError.stack,
                        context: 'Transaction timeout or database error'
                    });
                    // Continue even if DB fails - we've already sent the image
                }
                
                return;
            }
            
            // For non-image responses, use existing chunking
            const chunks = chunkMessage(processedResponse);
            await sendChunkedResponse(interaction, chunks, false, thread);
            
            // Store messages in database with transaction
            const transaction = await db.transaction();
            await transaction.begin();
            
            try {
                await executeWithTimeout(async () => {
                    // Store user message
                    await db.query`
                        INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot) 
                        VALUES (${conversationId}, ${guildConvId}, ${userId}, ${trimmedMessage}, 0)
                    `;
                
                    // Store bot response
                    await db.query`
                        INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot) 
                        VALUES (${conversationId}, ${guildConvId}, ${botUserId}, ${processedResponse}, 1)
                    `;
                }, TRANSACTION_TIMEOUT);
                
                await transaction.commit();
            } catch (dbError) {
                await transaction.rollback();
                console.error('Database Error:', {
                    error: dbError.message,
                    stack: dbError.stack,
                    context: 'Transaction timeout or database error'
                });
                throw new Error('Failed to store conversation in database.');
            }
            
        } catch (error) {
            console.error('Error generating AI response:', {
                error: error.message || 'Unknown error',
                stack: error.stack,
                requestId: `${interaction.id}-${Date.now()}`,
                channel: interaction.channel?.name || 'unknown'
            });
            
            // Send error message with chunking
            const errorMessage = "I apologize, but I encountered an error while processing your request. Please try again.";
            const chunks = chunkMessage(errorMessage);
            await sendChunkedResponse(interaction, chunks, true);
        }
        
    } catch (error) {
        console.error('Error in chat handler:', {
            error: error.message || 'Unknown error',
            stack: error.stack || 'No stack trace available',
            context: {
                type: isVoiceInteraction ? 'voice' : (isSlashCommand ? 'slash' : 'mention'),
                userId,
                guildConvId,
                hasThread: !!thread
            }
        });

        const errorMessage = error.message || 'Sorry, I encountered an error while processing your message.';
        
        try {
            // If we have a thread, send the error there
            if (thread) {
                await thread.send({
                    content: `❌ Error: ${errorMessage}`,
                    allowedMentions: { users: [], roles: [] }
                });
            }
            
            // Always try to send an ephemeral reply to the user
            if (interaction.deferred) {
                await interaction.editReply({
                    content: `❌ ${errorMessage}`,
                    ephemeral: true
                });
            } else {
                await interaction.reply({
                    content: `❌ ${errorMessage}`,
                    ephemeral: true
                });
            }
        } catch (replyError) {
            console.error('Failed to send error message:', {
                error: replyError.message,
                stack: replyError.stack,
                originalError: error.message
            });
        }
    }
}

// Add helper function for sending chunked responses
async function sendChunkedResponse(interaction, chunks, isError = false, existingThread = null) {
    try {
        // Use existing thread if provided, otherwise check thread preference
        let thread = existingThread;
        
        // Only check thread preference if no thread is provided and we're not already in a thread
        if (!thread && !interaction.channel?.isThread() && interaction.guildId) {
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
                } catch (error) {
                    console.error('Error creating/finding thread:', error);
                    // If we can't create a thread, use the channel directly
                    thread = null;
                }
            }
        } else if (interaction.channel?.isThread()) {
            thread = interaction.channel;
        }

        // For slash commands, use the interaction reply mechanism
        if (interaction.commandName === 'chat') {
            // Send first chunk as reply or edit
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(chunks[0]);
            } else {
                await interaction.reply(chunks[0]);
            }

            // Send remaining chunks as follow-ups
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp(chunks[i]);
            }
            
            // If we created a thread, send a message to direct the user there
            if (thread && !interaction.channel.isThread()) {
                await interaction.followUp({
                    content: `I've continued our conversation in a thread: ${thread}`,
                    ephemeral: true
                });
            }
        } 
        // For mentions, send to the appropriate channel based on thread preference
        else {
            const targetChannel = thread || interaction.channel;
            
            // Send all chunks to the target channel
            for (const chunk of chunks) {
                await targetChannel.send(chunk);
            }
            
            // If we created a thread, send a message to direct the user there
            if (thread && interaction.channel !== thread) {
                await interaction.channel.send({
                    content: `I've continued our conversation in a thread: ${thread}`,
                    allowedMentions: { users: [], roles: [] }
                });
            }
        }
    } catch (error) {
        console.error('Error sending chunked response:', {
            error: error.message,
            stack: error.stack,
            isErrorResponse: isError
        });
        
        // If this is already an error response, don't try again
        if (!isError) {
            const errorChunks = chunkMessage("I encountered an error while sending my response. Please try again.");
            await sendChunkedResponse(interaction, errorChunks, true);
        }
    }
}

// Add reaction handler for conversation branching
async function handleReactionAdd(reaction, user) {
    console.log('Reaction add triggered:', {
        emoji: reaction.emoji.name,
        user: user.tag,
        messageId: reaction.message.id,
        channelId: reaction.message.channel.id
    });

    if (user.bot) {
        console.log('Ignoring bot reaction');
        return;
    }

    const msg = reaction.message;
    console.log('Processing reaction:', reaction.emoji.name);

    try {
        if (reaction.emoji.name === '🔄') {
            console.log('Handling regenerate reaction');
            await msg.channel.sendTyping();
            
            try {
                // Find the user's message that triggered this response
                const messages = await msg.channel.messages.fetch({ limit: 50, before: msg.id });
                const userMessage = messages.find(m => !m.author.bot && m.content);
                
                if (!userMessage) {
                    await msg.reply("I couldn't find the original message to regenerate a response for.");
                    return;
                }

                // Get the current prompt
                const promptResult = await sql.query`
                    SELECT p.prompt 
                    FROM prompts p
                    JOIN guild_conversations gc ON gc.promptId = p.id
                    WHERE gc.threadId = ${msg.channel.id}
                `;

                if (!promptResult.recordset.length) {
                    await msg.reply("I couldn't find the conversation prompt to regenerate a response.");
                    return;
                }

                // Create a new completion with slightly higher temperature for variety
                const completion = await openai.chat.completions.create({
                    messages: [
                        { role: 'system', content: promptResult.recordset[0].prompt },
                        { role: 'user', content: userMessage.content }
                    ],
                    model: "gpt-4o",
                    temperature: 0.8,  // Slightly higher for variety
                    max_tokens: 500
                });

                const newResponse = completion.choices[0].message.content.trim();
                
                // Send the new response
                const response = await msg.reply({
                    content: `🔄 **Regenerated Response:**\n\n${newResponse}`,
                    allowedMentions: { users: [], roles: [] }
                });

                // Add the standard reaction controls
                await response.react('🔄');
                await response.react('📌');
                await response.react('🌳');
                await response.react('💡');
                await response.react('🔍');
                await response.react('📝');

            } catch (error) {
                console.error('Error in response regeneration:', error);
                await msg.reply("I encountered an error while regenerating the response. Please try again.");
            }
        } else if (reaction.emoji.name === '📌') {
            console.log('Handling pin reaction');
            try {
                await msg.pin();
                await msg.react('📍');
            } catch (pinError) {
                console.error('Error pinning message:', pinError);
                throw pinError;
            }
        } else if (reaction.emoji.name === '🌱') {
            // Create descriptive branch name from message content
            const branchTopic = msg.content
                .split(/[.!?]/)[0]  // Get first sentence
                .slice(0, 30)       // Take first 30 chars
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-');  // Convert to URL-friendly format

            const branchName = `branch-${branchTopic}-${msg.id.slice(-4)}`;
            
            // Create conversation branch
            const newThread = await msg.channel.threads.create({
                name: branchName,
                startMessage: msg,
                autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek
            });
            await newThread.send("🌱 New conversation branch created! Previous context will be maintained.");
        } else if (reaction.emoji.name === '💡') {
            // Mark as solution/helpful
            await msg.react('✨');
            await msg.reply("Marked as helpful solution! 💡");
        } else if (reaction.emoji.name === '🔍') {
            // Expand on this topic
            await msg.channel.sendTyping();
            
            // Create deep-dive prompt
            const deepDivePrompt = [
                { role: 'system', content: 'You are helping to expand on a previous response. Provide more detailed information, examples, and explanations about the topic. Be thorough but maintain clarity. Structure your response with clear sections using markdown headers.' },
                { role: 'user', content: `Please provide a detailed explanation and expansion of this topic: "${msg.content}"` }
            ];

            try {
                const completion = await openai.chat.completions.create({
                    messages: deepDivePrompt,
                    model: "gpt-4o",
                    temperature: 0.7,
                    max_tokens: 1000
                });

                const expandedResponse = completion.choices[0].message.content.trim();
                
                // Use the chunked reply utility
                const chunks = chunkMessage(expandedResponse);
                for (const chunk of chunks) {
                    await msg.channel.send(chunk);
                }
            } catch (error) {
                console.error('Error in deep-dive generation:', error);
                await msg.reply("I encountered an error while generating the detailed explanation. Please try again.");
            }
        } else if (reaction.emoji.name === '📝') {
            // Request summary of thread up to this point
            await msg.channel.sendTyping();
            
            try {
                // Fetch messages up to this point
                const messages = await msg.channel.messages.fetch({ 
                    limit: 100,
                    before: msg.id 
                });
                
                // Filter and format messages
                const conversationText = messages
                    .reverse()
                    .map(m => `${m.author.username}: ${m.content}`)
                    .join('\n');

                const summaryPrompt = [
                    { role: 'system', content: 'Create a concise but comprehensive summary of the conversation. Focus on key points, decisions, and important information. Use bullet points for clarity.' },
                    { role: 'user', content: `Please summarize this conversation:\n\n${conversationText}` }
                ];

                const completion = await openai.chat.completions.create({
                    messages: summaryPrompt,
                    model: "gpt-4o",
                    temperature: 0.7,
                    max_tokens: 500
                });

                const summary = completion.choices[0].message.content.trim();
                const response = await msg.reply({
                    content: `📝 **Conversation Summary:**\n\n${summary}`,
                    allowedMentions: { users: [], roles: [] }
                });

                // Add pin reaction for easy reference
                await response.react('📌');
            } catch (error) {
                console.error('Error generating summary:', error);
                await msg.reply("I encountered an error while generating the summary. Please try again.");
            }
        }
    } catch (error) {
        console.error('Error in handleReactionAdd:', error);
        // Try to notify the user of the error
        try {
            await msg.channel.send(`Error processing reaction: ${error.message}`);
        } catch (notifyError) {
            console.error('Could not notify user of error:', notifyError);
        }
    }
}

async function handleReactionRemove(reaction, user) {
    if (user.bot) return;

    const msg = reaction.message;
    if (reaction.emoji.name === '📌') {
        // Unpin message if no 📌 reactions remain
        const pinReactions = msg.reactions.cache.get('📌');
        if (!pinReactions || pinReactions.count === 0) {
            try {
                await msg.unpin();
                // Remove the pin confirmation reaction if it exists
                const confirmReaction = msg.reactions.cache.get('📍');
                if (confirmReaction) {
                    await confirmReaction.remove();
                }
            } catch (error) {
                console.error('Error unpinning message:', error);
            }
        }
    }
    // Add other reaction removal handlers as needed
}

// Add this new function
async function getOrCreateThreadSafely(channel, threadName) {
    // If the channel is already a thread, just return it
    if (channel.isThread()) {
        return channel;
    }
    
    const lockKey = `${channel.id}-${threadName}`;
    if (threadLocks.has(lockKey)) {
        return await threadLocks.get(lockKey);
    }

    const lockPromise = (async () => {
        try {
            const threads = await channel.threads.fetch();
            let thread = threads.threads.find(t => t.name === threadName);
            
            if (!thread) {
                console.log(`Creating new thread "${threadName}" in channel ${channel.name}`);
                thread = await channel.threads.create({
                    name: threadName,
                    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                    reason: 'New Goobster chat thread'
                });
            } else {
                console.log(`Found existing thread "${threadName}" in channel ${channel.name}`);
            }

            // Make sure thread is unarchived
            if (thread.archived) {
                console.log(`Unarchiving thread "${threadName}"`);
                await thread.setArchived(false);
            }

            return thread;
        } catch (error) {
            console.error('Error in thread creation:', error);
            // Return the original channel as fallback
            return channel;
        }
    })();

    threadLocks.set(lockKey, lockPromise);
    try {
        return await lockPromise;
    } finally {
        threadLocks.delete(lockKey);
    }
}

// Add this utility function
async function executeWithTimeout(promise, timeout) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error('Transaction timeout'));
        }, timeout);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        clearTimeout(timeoutId);
    }
}

// TODO: Add proper handling for message context management
// TODO: Add proper handling for message summary failures
// TODO: Add proper handling for message chunking failures
// TODO: Add proper handling for message fetch failures
// TODO: Add proper handling for message cleanup
// TODO: Add proper handling for message reference resolution
// TODO: Add proper handling for thread state management
// TODO: Add proper handling for thread creation failures
// TODO: Add proper handling for thread archival
// TODO: Add proper handling for thread lock timeouts

// Update the function that processes messages to incorporate guild personality directives
async function processMessage(message, isThread = false) {
    try {
        // ... existing code ...

        // Get guild ID for guild-specific settings
        const guildId = message.guild?.id;
        
        // Get base prompt
        let systemPrompt = DEFAULT_PROMPT;
        
        // Check if there's a personality directive for the guild
        if (guildId) {
            const personalityDirective = await getPersonalityDirective(guildId);
            if (personalityDirective) {
                // Append the personality directive to the prompt
                systemPrompt = `${systemPrompt}

GUILD DIRECTIVE:
${personalityDirective}

This directive applies only in this server and overrides any conflicting instructions.`;
            }
        }
        
        // Use the enhanced prompt for the message processing
        // ... continue with message processing using systemPrompt ...

        // Add image detection
        const imageRequest = await imageDetectionHandler.detectImageGenerationRequest(message.content);
        
        if (imageRequest.needsImage) {
            // Check if we're already generating an image for this channel
            if (pendingImageGenerations.has(message.channelId)) {
                await message.reply(`I'm already working on generating an image. Please wait for that to complete first.`);
                return;
            }

            // Mark that we're generating an image
            pendingImageGenerations.set(message.channelId, Date.now());

            try {
                // Extract image details
                const { prompt, type, style } = imageRequest.imageDetails;
                
                // Send a message indicating we're generating an image
                const processingMessage = await message.reply(`🎨 I'm generating an image of: ${prompt}\nThis might take a moment...`);
                
                // Generate the image
                const imagePath = await imageDetectionHandler.generateImage(
                    prompt, 
                    type || 'SCENE', 
                    style || 'fantasy'
                );
                
                // Send the image
                await processingMessage.edit(`✨ Here's your generated image of: ${prompt}`);
                await message.channel.send({
                    files: [{
                        attachment: imagePath,
                        name: path.basename(imagePath)
                    }]
                });
                
                // Clear the pending flag
                pendingImageGenerations.delete(message.channelId);
                return;
            } catch (error) {
                // Clear the pending flag on error
                pendingImageGenerations.delete(message.channelId);
                
                console.error('Error generating image:', error);
                await message.reply(`I apologize, but I encountered an error while trying to generate that image: ${error.message}`);
                return;
            }
        }

        // Continue with existing message processing...
    } catch (error) {
        console.error('Error processing message:', error);
        // ... existing error handling ...
    }
}

/**
 * Tracks a message in the conversation history
 * @param {string} guildConvId - The guild conversation ID
 * @param {string} discordUserId - The Discord user ID
 * @param {string} message - The message content
 * @param {string} role - The role ('user' or 'assistant')
 */
async function trackMessage(guildConvId, discordUserId, message, role) {
    try {
        // Connect to database
        const db = await getConnection();
        if (!db) {
            console.error('Failed to connect to database for message tracking');
            return;
        }

        // Get or create user
        const userResult = await db.query`
            SELECT id FROM users 
            WHERE discordId = ${discordUserId}
        `;

        let userId;
        if (userResult.recordset.length === 0) {
            // Create a placeholder username if we don't have it
            const username = `user_${discordUserId}`;
            await db.query`
                INSERT INTO users (discordUsername, discordId, username) 
                VALUES (${username}, ${discordUserId}, ${username})
            `;
            const newUserResult = await db.query`
                SELECT id FROM users 
                WHERE discordId = ${discordUserId}
            `;
            userId = newUserResult.recordset[0].id;
        } else {
            userId = userResult.recordset[0].id;
        }

        // Get conversation
        const conversationResult = await db.query`
            SELECT id FROM conversations 
            WHERE userId = ${userId} 
            AND guildConversationId = ${guildConvId}
        `;

        let conversationId;
        if (conversationResult.recordset.length === 0) {
            await db.query`
                INSERT INTO conversations (userId, guildConversationId) 
                VALUES (${userId}, ${guildConvId})
            `;
            const newConversationResult = await db.query`
                SELECT id FROM conversations 
                WHERE userId = ${userId} 
                AND guildConversationId = ${guildConvId}
            `;
            conversationId = newConversationResult.recordset[0].id;
        } else {
            conversationId = conversationResult.recordset[0].id;
        }

        // Store the message
        await db.query`
            INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot) 
            VALUES (${conversationId}, ${guildConvId}, ${userId}, ${message}, ${role === 'assistant' ? 1 : 0})
        `;
    } catch (error) {
        console.error('Error tracking message in database:', error);
        // Don't throw the error, just log it - we don't want to interrupt the flow
    }
}

/**
 * Generate a thread name based on the user
 * @param {Object} user - The Discord user object
 * @returns {string} - A thread name
 */
async function getThreadName(user) {
    try {
        // Generate thread name using OpenAI
        const prompt = `
Generate a short, creative, and friendly thread name for a conversation with a user named ${user.username}.
The name should be related to having a chat or conversation in a fun way.
Keep it under 30 characters (including spaces) and make it appropriate for all ages.
Return ONLY the thread name without any quotation marks or additional text.
`;

        const threadNameResponse = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.8,
            max_tokens: 20
        });

        let threadName = threadNameResponse.choices[0].message.content.trim();
        
        // Ensure thread name meets Discord requirements
        if (threadName.length > 100) {
            threadName = threadName.substring(0, 97) + '...';
        }
        
        // Fall back to a basic name if generation fails or is empty
        if (!threadName) {
            threadName = `Chat with ${user.username}`;
        }
        
        return threadName;
    } catch (error) {
        console.error('Error generating thread name:', error);
        return `Chat with ${user.username}`;
    }
}

module.exports = {
    handleChatInteraction,
    handleReactionAdd,
    handleReactionRemove,
    processMessage,
    trackMessage,
    getThreadName
}; 