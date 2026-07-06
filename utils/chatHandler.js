const db = require('../db');
const { ThreadAutoArchiveDuration } = require('discord.js');
const AISearchHandler = require('./aiSearchHandler');
const { chunkMessage } = require('./index');
const { getPrompt, getPromptWithGuildPersonality } = require('./memeMode');
const { getThreadPreference, THREAD_PREFERENCE, getPersonalityDirective, getGuildAI } = require('./guildSettings');
const aiService = require('../services/aiService');
const imageDetectionHandler = require('./imageDetectionHandler');
const path = require('path');
const { setInterval } = require('timers');
const { getGuildContext, getPreferredUserName, getBotPreferredName } = require('./guildContext');
const toolsRegistry = require('./toolsRegistry');
const memoryService = require('../services/memoryService');
const factsService = require('../services/factsService');

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

// Add a global flag to track database connectivity state
let dbConnectivityOK = true;
let lastDbHealthCheck = Date.now();
const DB_HEALTH_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes

/**
 * Logs a system event to the database
 * @param {string} level - The log level (ERROR, WARN, INFO, DEBUG)
 * @param {string} message - The log message
 * @param {Object} metadata - Additional metadata to store
 * @returns {Promise<void>}
 */
async function logSystemEvent(level, message, metadata = {}) {
    try {
        db.run(
            `INSERT INTO system_logs (log_level, message, metadata, source, error_code, error_state)
             VALUES (@level, @message, @metadata, @source, @errorCode, @errorState)`,
            {
                level,
                message,
                metadata: JSON.stringify(metadata),
                source: metadata.source || null,
                errorCode: metadata.error_code || null,
                errorState: metadata.error_state || null
            }
        );
    } catch (error) {
        console.error('Error logging system event:', error);
    }
}

// Schedule periodic database health checks
setInterval(checkDatabaseHealth, DB_HEALTH_CHECK_INTERVAL).unref?.();

/**
 * Looks up a user by Discord ID, creating the record if needed.
 * @param {string} discordId - The Discord user ID (snowflake)
 * @param {string} username - Username to store when creating the record
 * @returns {number} Internal user id
 */
function getOrCreateUser(discordId, username) {
    const existing = db.get('SELECT id FROM users WHERE discordId = @discordId', { discordId });
    if (existing) return existing.id;

    const result = db.run(
        'INSERT INTO users (discordUsername, discordId, username) VALUES (@username, @discordId, @username)',
        { discordId, username }
    );
    return Number(result.lastInsertRowid);
}

/**
 * Looks up a conversation for a user within a guild conversation, creating it if needed.
 * @param {number} userId - Internal user id
 * @param {number} guildConvId - guild_conversations id
 * @returns {number} Conversation id
 */
function getOrCreateConversation(userId, guildConvId) {
    const existing = db.get(
        'SELECT id FROM conversations WHERE userId = @userId AND guildConversationId = @guildConvId',
        { userId, guildConvId }
    );
    if (existing) return existing.id;

    const result = db.run(
        'INSERT INTO conversations (userId, guildConversationId) VALUES (@userId, @guildConvId)',
        { userId, guildConvId }
    );
    return Number(result.lastInsertRowid);
}

/**
 * Checks database health by performing basic query operations
 * @returns {Promise<boolean>} True if database is healthy
 */
async function checkDatabaseHealth() {
    console.log('Performing database health check...');
    lastDbHealthCheck = Date.now();

    try {
        const userCount = db.get('SELECT COUNT(*) as count FROM users').count;
        const messageCount = db.get('SELECT COUNT(*) as count FROM messages').count;

        // Verify write access with a test insert that is rolled back with the transaction helper.
        db.transaction(() => {
            const result = db.run(
                `INSERT INTO system_logs (log_level, message, source)
                 VALUES ('DEBUG', 'DB health check - write test', 'checkDatabaseHealth')`
            );
            db.run('DELETE FROM system_logs WHERE id = @id', { id: Number(result.lastInsertRowid) });
        });

        console.log('Database health check successful', {
            userCount,
            messageCount,
            time: new Date().toISOString()
        });

        dbConnectivityOK = true;
        return true;
    } catch (error) {
        dbConnectivityOK = false;
        console.error('Database health check failed:', {
            error: error.message,
            code: error.code,
            timestamp: new Date().toISOString()
        });
        return false;
    }
}

/**
 * Diagnoses database connection issues with detailed reporting
 * @param {Object} interaction - The Discord interaction object
 * @returns {Promise<string>} Diagnostic message
 */
async function diagnoseDatabaseIssues(interaction) {
    try {
        console.log('Running database diagnostics...');

        let hasReadPermission = true;
        let hasWritePermission = true;
        const detailedErrors = [];

        try {
            db.get('SELECT * FROM users LIMIT 1');
        } catch (error) {
            hasReadPermission = false;
            detailedErrors.push(`Read Error: ${error.message}`);
        }

        try {
            db.transaction(() => {
                const result = db.run(
                    `INSERT INTO system_logs (log_level, message, source)
                     VALUES ('DEBUG', 'DB diagnostics - write test', 'diagnoseDatabaseIssues')`
                );
                db.run('DELETE FROM system_logs WHERE id = @id', { id: Number(result.lastInsertRowid) });
            });
        } catch (error) {
            hasWritePermission = false;
            detailedErrors.push(`Write Error: ${error.message}`);
        }

        let diagnosticMessage = "**Database Diagnostic Results**\n";

        if (hasReadPermission && hasWritePermission) {
            diagnosticMessage += "✅ Database connection and permissions appear to be working correctly.\n";

            const recentMessageCount = db.get(
                "SELECT COUNT(*) as count FROM messages WHERE createdAt > datetime('now', '-1 day')"
            );
            const totalMessageCount = db.get('SELECT COUNT(*) as count FROM messages');
            const mostRecentMessage = db.get(
                'SELECT id, createdAt as timestamp, isBot FROM messages ORDER BY createdAt DESC LIMIT 1'
            );

            diagnosticMessage += `✅ Found ${recentMessageCount.count} messages stored in the last 24 hours.\n`;
            diagnosticMessage += `✅ Total message count in database: ${totalMessageCount.count}\n`;

            if (mostRecentMessage) {
                diagnosticMessage += `✅ Most recent message (ID: ${mostRecentMessage.id}) was stored at ${mostRecentMessage.timestamp} (${mostRecentMessage.isBot ? 'bot' : 'user'} message)\n`;
            } else {
                diagnosticMessage += `⚠️ No messages found in the database.\n`;
            }

            // Check for recent errors in system logs
            const recentErrors = db.all(
                `SELECT id, createdAt as timestamp, message
                 FROM system_logs
                 WHERE log_level = 'ERROR' AND createdAt > datetime('now', '-1 day')
                 ORDER BY createdAt DESC LIMIT 10`
            );

            if (recentErrors.length > 0) {
                diagnosticMessage += `\n**Recent Errors (Last 24h):**\n`;
                recentErrors.forEach(error => {
                    diagnosticMessage += `- ${error.timestamp}: ${error.message.substring(0, 100)}...\n`;
                });
            } else {
                diagnosticMessage += "\n**Recent Errors:** No errors logged in the last 24 hours.\n";
            }

            // Database file statistics
            const pageCount = db.getDb().pragma('page_count', { simple: true });
            const pageSize = db.getDb().pragma('page_size', { simple: true });
            const dbSizeMb = ((pageCount * pageSize) / (1024 * 1024)).toFixed(2);
            diagnosticMessage += `\n**Database Info:**\n- Engine: SQLite (better-sqlite3)\n- Size: ${dbSizeMb} MB\n- Journal mode: ${db.getDb().pragma('journal_mode', { simple: true })}\n`;
        } else {
            if (!hasReadPermission) {
                diagnosticMessage += "❌ Cannot read from database tables. This may be a permissions issue.\n";
            }

            if (!hasWritePermission) {
                diagnosticMessage += "❌ Cannot write to database tables. This may be a permissions issue.\n";
            }

            diagnosticMessage += "\nDetailed Errors:\n";
            detailedErrors.forEach(error => {
                diagnosticMessage += `- ${error}\n`;
            });
        }

        return diagnosticMessage;

    } catch (error) {
        console.error('Error in database diagnosis:', error);
        return `Failed to complete database diagnosis: ${error.message}`;
    }
}

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

        const summary = await aiService.chatText([
            { role: 'user', content: summaryPrompt }
        ], {
            temperature: 0.7,
            max_tokens: 500
        });
        
        // Chunk the summary if needed
        const chunks = chunkMessage(summary);

        // Store the summary
        try {
            db.run(
                `INSERT INTO conversation_summaries (guildConversationId, summary, messageCount)
                 VALUES (@guildConvId, @summary, @messageCount)`,
                { guildConvId, summary: chunks[0], messageCount: messages.length }
            );
        } catch (dbError) {
            console.error('Database Error:', dbError);
            throw new Error('Failed to store conversation summary in database.', { cause: dbError });
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
        .map(m => {
            const isBot = m.author.id === botUserId;
            const speakerName = isBot ? 'Goobster' : (m.member?.displayName || m.author.username || 'Unknown');

            // Pre-pend the speaker name for clarity when not the bot
            const contentPrefix = isBot ? '' : `${speakerName}: `;

            return {
                role: isBot ? 'assistant' : 'user',
                content: `${contentPrefix}${m.content}`.trim(),
                messageId: m.id,
                authorId: m.author.id
            };
        })
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
        const summaryRow = db.get(
            `SELECT summary FROM conversation_summaries
             WHERE guildConversationId = @guildConvId
             ORDER BY createdAt DESC LIMIT 1`,
            { guildConvId }
        );

        if (summaryRow) {
            // Add summary as a system message at the beginning
            conversationHistory.unshift({
                role: 'system',
                content: `Previous conversation summary:\n${summaryRow.summary}`
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

async function handleChatInteraction(interaction, thread = null) {
    let conversationId = null;
    let guildConvId = null;
    let userId = null;
    let botUserId = null;
    let userResponseSent = false; // Track if we've sent any response to the user
    
    const isSlashCommand = interaction.commandName === 'chat';
    const isVoiceInteraction = !isSlashCommand && 
                             interaction.commandName === 'voice' && 
                             interaction.options && 
                             typeof interaction.options.getString === 'function';
    
    // GUARANTEED RESPONSE SYSTEM - Ensures user ALWAYS gets a response
    const guaranteedResponse = async (message, isError = false) => {
        if (userResponseSent) {
            console.log('Response already sent, skipping guaranteed response');
            return;
        }
        
        try {
            const chunks = chunkMessage(message);
            await sendChunkedResponse(interaction, chunks, isError);
            userResponseSent = true;
            console.log('Guaranteed response sent successfully');
        } catch (error) {
            console.error('Failed to send guaranteed response:', error);
            // Last resort - try basic reply
            try {
                if (interaction.deferred) {
                    await interaction.editReply({
                        content: message,
                        ephemeral: isError
                    });
                } else if (!interaction.replied) {
                    await interaction.reply({
                        content: message,
                        ephemeral: isError
                    });
                }
                userResponseSent = true;
            } catch (finalError) {
                console.error('CRITICAL: Failed to send any response to user:', finalError);
                // This should never happen, but if it does, we've logged it
            }
        }
    };
    
    try {
        // Log interaction details for debugging
        console.log('Interaction details:', {
            hasGuild: !!interaction.guild,
            guildId: interaction.guildId,
            channelId: interaction.channelId || interaction.channel?.id,
            userId: interaction.user?.id,
            isSlashCommand,
            isVoiceInteraction
        });

        // For slash commands, defer the reply immediately to prevent timeout
        if (isSlashCommand && !interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        // Get message content, checking both slash command and mention formats
        const userMessage = interaction.options?.getString?.('message') || 
                           interaction.options?.getString?.() || 
                           interaction.content;

        if (!userMessage) {
            await guaranteedResponse('No message provided. Please include a message to chat with me!', true);
            return;
        }

        if (typeof userMessage !== 'string') {
            await guaranteedResponse('Invalid message format. Please provide a text message.', true);
            return;
        }

        const trimmedMessage = userMessage.trim();
        if (trimmedMessage.length === 0) {
            await guaranteedResponse('Message cannot be empty. Please provide some text to chat with me!', true);
            return;
        }

        if (trimmedMessage.length > 2000) {
            await guaranteedResponse('Message is too long. Please keep your message under 2000 characters.', true);
            return;
        }

        // If this is a role-style mention of the bot, don't treat it as a role mention
        // This handles cases where the mention format is <@&botId> instead of <@botId>
        if (interaction.isRoleStyleBotMention) {
            console.log('Handling role-style bot mention as a direct mention');
        }

        // Get thread preference for this guild/conversation - safely handle missing guild
        let threadPreference = THREAD_PREFERENCE.ALWAYS_CHANNEL; // Default
        if (interaction.guildId) {
            threadPreference = await getThreadPreference(interaction.guildId);
        }
        
        // Thread usage disabled – always converse in the channel
        thread = null;

        // Per-guild AI overrides (provider/model/reasoning); null = global defaults
        const guildAI = interaction.guildId
            ? await getGuildAI(interaction.guildId)
            : { provider: null, model: null, reasoningEffort: null };

        // Legacy search detection + approval workflow. Only needed for
        // providers without native web search (Ollama); OpenAI and Gemini
        // search the web mid-response via built-in tools instead.
        const searchInfo = aiService.supportsNativeWebSearch(guildAI.provider || undefined)
            ? { needsSearch: false }
            : await detectSearchNeed(trimmedMessage);

        if (searchInfo.needsSearch) {
            console.log('Search need detected:', {
                message: trimmedMessage,
                suggestedQuery: searchInfo.suggestedQuery,
                reason: searchInfo.reason
            });
            
            try {
                // Handle the search flow
                const searchResponse = await handleSearchFlow(searchInfo, interaction, thread, trimmedMessage);
                
                // If the search flow returned a response, we're done
                if (searchResponse) {
                    // Just send the response in chunks - database storing happens in handleSearchFlow
                    const chunks = chunkMessage(searchResponse);
                    await sendChunkedResponse(interaction, chunks);
                    userResponseSent = true;
                    return searchResponse;
                } else if (searchResponse === null) {
                    // If searchResponse is null, it means the search was executed automatically
                    // because approval is not required for this guild
                    console.log('Search was executed automatically without approval');
                    
                    // We can continue with normal chat processing, but we'll skip the AI response
                    // since the search results have already been sent
                    userResponseSent = true;
                    return "Search executed automatically";
                }
                
                console.log('Continuing with normal chat after search handling');
            } catch (error) {
                console.error('Error in search handling:', error);
                // Send an error message to the user
                await guaranteedResponse(`❌ Error processing search: ${error.message}`, true);
                return;
            }
        }

        console.log('Processing interaction:', {
            type: isVoiceInteraction ? 'voice' : (isSlashCommand ? 'slash' : 'mention'),
            message: trimmedMessage,
            messageLength: trimmedMessage.length,
            hasOptions: !!interaction.options,
            commandName: interaction.commandName
        });

        // Initialize database records first
        // Get or create user
        console.log('Starting database initialization...', {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            channelId: interaction.channel?.id || interaction.channelId
        });

        userId = getOrCreateUser(interaction.user.id, interaction.user.username);
        console.log('User record ready', { userId });

        // Get or create bot user
        botUserId = getOrCreateUser(interaction.client.user.id, 'Goobster');
        console.log('Bot user record ready', { botUserId });

        // Get or create guild conversation with thread ID
        console.log('Setting up guild conversation...');
        const threadId = thread?.id || createPlaceholderThreadId(interaction.channel?.id || interaction.channelId);
        console.log('Thread ID:', { threadId, isReal: !!thread?.id });

        const guildConvRow = db.get(
            `SELECT id FROM guild_conversations
             WHERE guildId = @guildId AND channelId = @channelId AND threadId = @threadId`,
            {
                guildId: interaction.guildId,
                channelId: interaction.channel?.id || interaction.channelId,
                threadId
            }
        );

        if (!guildConvRow) {
            console.log('Creating new guild conversation...');
            const defaultPrompt = db.get('SELECT id FROM prompts WHERE isDefault = 1 LIMIT 1');
            const promptId = defaultPrompt?.id ?? null;
            console.log('Using prompt ID:', { promptId });

            const insertResult = db.run(
                `INSERT INTO guild_conversations (guildId, channelId, threadId, promptId)
                 VALUES (@guildId, @channelId, @threadId, @promptId)`,
                {
                    guildId: interaction.guildId,
                    channelId: interaction.channel?.id || interaction.channelId,
                    threadId,
                    promptId
                }
            );
            guildConvId = Number(insertResult.lastInsertRowid);
            console.log('Created new guild conversation', { guildConvId });
        } else {
            guildConvId = guildConvRow.id;
            console.log('Found existing guild conversation', { guildConvId });
        }

        // Get or create conversation
        conversationId = getOrCreateConversation(userId, guildConvId);
        console.log('Conversation ready', { conversationId });

        // Log all IDs before proceeding
        console.log('All IDs ready for message storage:', {
            userId,
            botUserId,
            guildConvId,
            conversationId,
            threadId
        });

        // Start typing indicator
        if (thread) {
            await thread.sendTyping();
        } else if (interaction.channel) {
            await interaction.channel.sendTyping();
        }

        // Get conversation history with summary management
        const conversationHistory = await getContextWithSummary(thread, guildConvId, userId, interaction);

        // Prepare conversation prompt: use the prompt linked to this guild
        // conversation, falling back to the built-in default.
        const promptRow = db.get(
            `SELECT p.prompt FROM prompts p
             JOIN guild_conversations gc ON gc.promptId = p.id
             WHERE gc.id = @guildConvId`,
            { guildConvId }
        );

        let systemPrompt = promptRow?.prompt || DEFAULT_PROMPT;
        
        // Get guild context and nickname information
        // Make sure we safely access properties and handle missing guild info
        const guildContext = await getGuildContext(interaction.guild);
        const userPreferredName = await getPreferredUserName(
            interaction.user.id, 
            interaction.guildId, 
            interaction.member
        );
        const botPreferredName = await getBotPreferredName(
            interaction.guildId, 
            interaction.guild?.members?.me
        );

        // Add guild context to the prompt, with safe property access
        const now = new Date();
        systemPrompt = `${systemPrompt}

CURRENT CONTEXT:
The current date and time is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ${now.toLocaleTimeString('en-US')} (server time). Be naturally aware of this - late-night chats, weekends, holidays.
You are in the ${interaction.guild ? `Discord server "${guildContext.name}"` : 'a Direct Message'} with ${guildContext.memberCount} members.
Current member status: ${guildContext.presences.online} online, ${guildContext.presences.idle} idle, ${guildContext.presences.dnd} do not disturb, ${guildContext.presences.offline} offline.
${guildContext.features.length > 0 ? `Server features: ${guildContext.features.join(', ')}.` : 'No special server features.'}
${interaction.guild ? `Server owner: ${guildContext.owner}` : ''}

IDENTITY:
Your name in this ${interaction.guild ? 'server' : 'conversation'} is "${botPreferredName}".
You should refer to the user you're talking to as "${userPreferredName}".
Remember to use these names consistently in your responses.`;

        // Known facts dossier + current mood (from the heartbeat, when active)
        if (interaction.guildId) {
            try {
                const dossier = factsService.buildDossier({
                    guildId: interaction.guildId,
                    userId: interaction.user.id,
                    userName: userPreferredName
                });
                if (dossier) {
                    systemPrompt = `${systemPrompt}\n\n${dossier}`;
                }

                const HeartbeatService = require('../services/heartbeatService');
                const mood = HeartbeatService.instance?.getMood(interaction.guildId);
                if (mood) {
                    systemPrompt = `${systemPrompt}\n\nCURRENT MOOD: ${mood} (let this subtly color your tone without mentioning it).`;
                }
            } catch (dossierError) {
                console.warn('Failed to build facts dossier:', dossierError.message);
            }
        }

        // Check if there's a personality directive for the guild
        let personalityDirective = null;
        if (interaction.guildId) {
            personalityDirective = await getPersonalityDirective(interaction.guildId, interaction.user.id);
        }

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

        // Long-term memory recall: pull semantically relevant past snippets,
        // excluding anything already visible in the active context window.
        if (interaction.guildId) {
            try {
                const memories = await memoryService.recall({
                    guildId: interaction.guildId,
                    query: trimmedMessage,
                    excludeContents: conversationHistory.map(m => m.content)
                });
                const memoryBlock = memoryService.formatForPrompt(memories);
                if (memoryBlock) {
                    systemPrompt = `${systemPrompt}\n\n${memoryBlock}`;
                }
            } catch (memoryError) {
                console.warn('Memory recall failed, continuing without memories:', memoryError.message);
            }
        }

        // Vision: collect image attachments from mentions (pseudo-interaction)
        // or the /chat command's image option
        const imageUrls = [];
        if (Array.isArray(interaction.imageUrls)) {
            imageUrls.push(...interaction.imageUrls);
        }
        const slashAttachment = interaction.options?.getAttachment?.('image');
        if (slashAttachment?.contentType?.startsWith('image/')) {
            imageUrls.push(slashAttachment.url);
        }

        const userTurn = { role: 'user', content: trimmedMessage };
        if (imageUrls.length > 0) {
            userTurn.images = imageUrls.slice(0, 4);
        }

        const apiMessages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            userTurn
        ];
        
        // Generate response
        try {
            // Start typing indicator
            if (thread) {
                await thread.sendTyping();
            } else if (interaction.channel) {
                await interaction.channel.sendTyping();
            }
            
            // -- Function-calling capable request --
            let assistantResponseText = null;
            let messagesForModel = [...apiMessages];

            const functionDefs = toolsRegistry.getDefinitions();

            // Progressive streaming: edit the deferred reply as text arrives.
            // Edits are throttled and chained so they never interleave.
            const STREAM_EDIT_INTERVAL_MS = 1500;
            let streamedText = '';
            let lastStreamEdit = 0;
            let streamEditChain = Promise.resolve();
            const canStream = Boolean(interaction.deferred && typeof interaction.editReply === 'function');
            const onDelta = (delta) => {
                streamedText += delta;
                const now = Date.now();
                if (now - lastStreamEdit >= STREAM_EDIT_INTERVAL_MS) {
                    lastStreamEdit = now;
                    const preview = streamedText.length > 1900 ? streamedText.slice(0, 1900) + '…' : streamedText;
                    streamEditChain = streamEditChain
                        .then(() => interaction.editReply(preview + ' ▌'))
                        .catch(() => { /* ignore transient edit failures during streaming */ });
                }
            };

            // Allow up to two tool invocations to avoid infinite loops
            for (let depth = 0; depth < 3; depth++) {
                const chatOptions = {
                    preset: 'chat',
                    max_tokens: 1000,
                    usageContext: { guildId: interaction.guildId, userId: interaction.user?.id }
                };

                // Apply per-guild AI overrides
                if (guildAI.provider) chatOptions.provider = guildAI.provider;
                if (guildAI.model) chatOptions.model = guildAI.model;
                if (guildAI.reasoningEffort) chatOptions.reasoning_effort = guildAI.reasoningEffort;

                if (functionDefs.length > 0) {
                    chatOptions.functions = functionDefs;
                }
                // Let the model search the web natively when the provider supports it
                if (aiService.supportsNativeWebSearch(guildAI.provider || undefined)) {
                    chatOptions.webSearch = true;
                }
                if (canStream) {
                    streamedText = '';
                    chatOptions.onDelta = onDelta;
                }

                const { content, toolCalls } = await aiService.chat(messagesForModel, chatOptions);

                // If the LLM wants to call tools, execute them and loop
                if (toolCalls && toolCalls.length > 0) {
                    messagesForModel.push({ role: 'assistant', content, toolCalls });

                    for (const call of toolCalls) {
                        let fnResult;
                        try {
                            const parsedArgs = JSON.parse(call.arguments || '{}');
                            parsedArgs.interactionContext = interaction;
                            fnResult = await toolsRegistry.execute(call.name, parsedArgs);

                            // Handle special result format with _display and _data
                            if (fnResult && typeof fnResult === 'object' && fnResult._display && fnResult._data) {
                                console.log(`Tool ${call.name} returned structured data with display format`);
                                fnResult = fnResult._display; // Use the display version for user-facing output
                            }
                        } catch (toolErr) {
                            console.error(`Tool execution error for ${call.name}:`, toolErr);
                            fnResult = `Error executing tool ${call.name}: ${toolErr.message}`;

                            // If this is a critical tool failure and we can't continue, send a response
                            if (depth === 2) { // On the last attempt
                                console.warn('Tool execution failed on final attempt, sending error response');
                                await guaranteedResponse(
                                    `I encountered an error while executing the ${call.name} tool: ${toolErr.message}. Please try again or rephrase your request.`,
                                    true
                                );
                                return;
                            }
                        }

                        messagesForModel.push({
                            role: 'tool',
                            toolCallId: call.id,
                            name: call.name,
                            content: typeof fnResult === 'string' ? fnResult : JSON.stringify(fnResult)
                        });
                    }

                    continue; // Next round – let the model craft the user-visible reply
                }

                assistantResponseText = content || '';
                break;
            }

            // Let any in-flight streamed edit settle before the final reply
            await streamEditChain;

            const responseContent = assistantResponseText;
            
            // Check if we got an empty or null response from AI
            if (!responseContent || responseContent.trim() === '') {
                console.warn('Empty AI response after tool execution, providing fallback');
                await guaranteedResponse(
                    "I executed your request successfully, but I'm having trouble generating a proper response. " +
                    "The operation may have completed - please check the results or try asking about the status.", 
                    false
                );
                return;
            }
            
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
                userResponseSent = true; // Mark that we've sent a response
                
                // Store messages in database with transaction
                try {
                    db.transaction(() => {
                        db.run(
                            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot)
                             VALUES (@conversationId, @guildConvId, @createdBy, @message, 0)`,
                            { conversationId, guildConvId, createdBy: userId, message: trimmedMessage }
                        );

                        db.run(
                            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot, metadata)
                             VALUES (@conversationId, @guildConvId, @createdBy, @message, 1, @metadata)`,
                            {
                                conversationId,
                                guildConvId,
                                createdBy: botUserId,
                                message: "I've generated an image based on your request.",
                                metadata: JSON.stringify({ imageGenerated: true, prompt: trimmedMessage })
                            }
                        );
                    });
                    console.log('Image generation message storage committed successfully');
                } catch (dbError) {
                    console.error('Database Error - Failed to store image generation messages:', {
                        error: dbError.message,
                        stack: dbError.stack,
                        conversationId: conversationId,
                        guildConvId: guildConvId,
                        userMessagePreview: trimmedMessage.substring(0, 50) + (trimmedMessage.length > 50 ? '...' : '')
                    });
                    // Continue even if DB fails - we've already sent the image
                    // But add a warning message to the user
                    await interaction.channel.send({
                        content: "⚠️ Note: I encountered an issue storing this conversation in my memory. Your image was generated successfully, but I might not remember this conversation in the future.",
                        allowedMentions: { users: [], roles: [] }
                    }).catch(msgError => {
                        console.error('Failed to send storage error message:', msgError);
                    });
                }
                
                return;
            }
            
            // GUARANTEED RESPONSE - Ensure we always send a response
            if (!processedResponse || processedResponse.trim() === '') {
                console.warn('Empty or null AI response detected, providing fallback response');
                await guaranteedResponse(
                    "I processed your request, but I'm having trouble formulating a response right now. " +
                    "Please try rephrasing your message or try again in a moment.", 
                    false
                );
                return;
            }

            // For non-image responses, use existing chunking
            const chunks = chunkMessage(processedResponse);
            await sendChunkedResponse(interaction, chunks, false, thread);
            userResponseSent = true; // Mark that we've sent a response
            
            // Store messages in database with transaction
            try {
                console.log('Storing messages', {
                    conversationId,
                    guildConvId,
                    userMessagePreview: trimmedMessage.substring(0, 50) + (trimmedMessage.length > 50 ? '...' : '')
                });

                const { userMsgId, botMsgId } = db.transaction(() => {
                    const userMsg = db.run(
                        `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot)
                         VALUES (@conversationId, @guildConvId, @createdBy, @message, 0)`,
                        { conversationId, guildConvId, createdBy: userId, message: trimmedMessage }
                    );

                    const botMsg = db.run(
                        `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot)
                         VALUES (@conversationId, @guildConvId, @createdBy, @message, 1)`,
                        { conversationId, guildConvId, createdBy: botUserId, message: processedResponse }
                    );

                    return {
                        userMsgId: Number(userMsg.lastInsertRowid),
                        botMsgId: Number(botMsg.lastInsertRowid)
                    };
                });

                console.log('Message storage committed successfully', { userMsgId, botMsgId });
            } catch (error) {
                console.error('Error storing messages:', error);
                throw error;
            }

            // Long-term memory: embed both sides asynchronously (never blocks the reply)
            if (interaction.guildId) {
                const channelId = interaction.channel?.id || interaction.channelId;
                memoryService.remember({
                    guildId: interaction.guildId,
                    channelId,
                    authorId: interaction.user.id,
                    authorName: interaction.member?.displayName || interaction.user.username,
                    content: trimmedMessage
                }).catch(() => {});
                memoryService.remember({
                    guildId: interaction.guildId,
                    channelId,
                    authorId: interaction.client.user.id,
                    authorName: 'Goobster',
                    content: processedResponse
                }).catch(() => {});
            }
            
        } catch (error) {
            console.error('Error generating AI response:', {
                error: error.message || 'Unknown error',
                stack: error.stack,
                requestId: `${interaction.id}-${Date.now()}`,
                channel: interaction.channel?.name || 'unknown'
            });
            
            // Use guaranteed response for AI processing errors
            await guaranteedResponse(
                "I apologize, but I encountered an error while processing your request. Please try again.", 
                true
            );
        }
        
    } catch (error) {
        console.error('Error in chat handler:', {
            error: error.message || 'Unknown error',
            stack: error.stack || 'No stack trace available',
            context: {
                type: isVoiceInteraction ? 'voice' : (isSlashCommand ? 'slash' : 'mention'),
                // Only include these if they've been initialized
                hasThread: !!thread,
                // Safely reference fields that might not be initialized
                hasUserId: !!userId,
                hasGuildConvId: !!guildConvId
            }
        });

        const errorMessage = error.message || 'Sorry, I encountered an error while processing your message.';
        
        // Use guaranteed response system for all top-level errors
        await guaranteedResponse(`❌ ${errorMessage}`, true);
    } finally {
        // FINAL SAFETY NET - If somehow no response was sent, send one now
        if (!userResponseSent) {
            console.warn('CRITICAL: No response was sent to user, sending final fallback response');
            try {
                if (interaction.deferred && !interaction.replied) {
                    await interaction.editReply({
                        content: "I apologize, but something went wrong and I couldn't process your request properly. Please try again.",
                        ephemeral: true
                    });
                } else if (!interaction.replied) {
                    await interaction.reply({
                        content: "I apologize, but something went wrong and I couldn't process your request properly. Please try again.",
                        ephemeral: true
                    });
                }
            } catch (finalError) {
                console.error('CRITICAL: Could not send final fallback response:', finalError);
            }
        }
    }
}

// Add helper function for sending chunked responses
async function sendChunkedResponse(interaction, chunks, isError = false) {
    try {
        // Use existing thread if provided, otherwise check thread preference
        let thread = interaction.channel;
        
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

                // Get the current prompt (falls back to the default prompt)
                const promptRow = db.get(
                    `SELECT p.prompt
                     FROM prompts p
                     JOIN guild_conversations gc ON gc.promptId = p.id
                     WHERE gc.threadId = @threadId`,
                    { threadId: msg.channel.id }
                );

                // Create a new completion with slightly higher temperature for variety
                const newResponse = await aiService.chatText([
                        { role: 'system', content: promptRow?.prompt || DEFAULT_PROMPT },
                        { role: 'user', content: userMessage.content }
                    ], {
                        preset: 'creative',
                        max_tokens: 500
                    });

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
                const expandedResponse = await aiService.chatText(deepDivePrompt, {
                    preset: 'chat',
                    max_tokens: 1000
                });

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

                const summary = await aiService.chatText(
                    summaryPrompt,
                    {
                        temperature: 0.7,
                        max_tokens: 500
                    }
                );

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
        const userId = getOrCreateUser(discordUserId, `user_${discordUserId}`);
        const conversationId = getOrCreateConversation(userId, guildConvId);

        db.run(
            `INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot)
             VALUES (@conversationId, @guildConvId, @createdBy, @message, @isBot)`,
            {
                conversationId,
                guildConvId,
                createdBy: userId,
                message,
                isBot: role === 'assistant'
            }
        );
    } catch (error) {
        console.error('Error tracking message in database:', {
            error: error.message,
            stack: error.stack,
            guildConvId,
            discordUserId,
            messagePreview: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
            role
        });
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

        let threadName = (await aiService.chatText([
            { role: 'user', content: prompt }
        ], {
            preset: 'chat',
            max_tokens: 20
        })).trim();
        
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
    getThreadName,
    diagnoseDatabaseIssues,
    checkDatabaseHealth,
    logSystemEvent
}; 