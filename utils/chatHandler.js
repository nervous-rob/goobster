const { OpenAI } = require('openai');
const { sql, getConnection } = require('../azureDb');
const config = require('../config.json');
const { ThreadAutoArchiveDuration } = require('discord.js');
const AISearchHandler = require('./aiSearchHandler');
const { chunkMessage } = require('./index');

const openai = new OpenAI({ apiKey: config.openaiKey });

// Add a Map to track pending searches by channel
const pendingSearches = new Map();

// Add at the top with other constants
const threadLocks = new Map();

// Add near the top with other constants
const MAX_WORD_LENGTH = 500;

// Add near the top with other constants
const TRANSACTION_TIMEOUT = 30000; // 30 seconds

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

1. Acknowledge their request with enthusiasm
2. Use the /search command by replying with a message in this EXACT format (including quotes):
   "/search query:"your search query here" reason:"why you need this information""

Example responses:

When needing current info:
"Let me check the latest data on that! /search query:"current cryptocurrency market trends March 2024" reason:"User asked about crypto prices, and even a bot as clever as me needs up-to-date numbers to give accurate advice!""

When verifying facts:
"I want to make sure I give you the most accurate info! /search query:"latest Mars rover discoveries 2024" reason:"Need to verify recent Mars exploration data""

Remember:
- Be enthusiastic but professional
- Make search queries specific and focused
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

        const summary = completion.choices[0].message.content.trim();

        // Store the summary
        const transaction = await sql.transaction();
        await transaction.begin();

        try {
            await sql.query`
                INSERT INTO conversation_summaries (guildConversationId, summary, messageCount)
                VALUES (${guildConvId}, ${summary}, ${messages.length})
            `;

            await transaction.commit();
        } catch (dbError) {
            await transaction.rollback();
            console.error('Database Error:', dbError);
            throw new Error('Failed to store conversation summary in database.');
        }

        return summary;
    } catch (error) {
        console.error('Error summarizing context:', error);
        return null;
    }
}

async function getContextWithSummary(thread, guildConvId, userId = null) {
    // Get recent messages
    const messages = await thread.messages.fetch({ limit: CONTEXT_WINDOW_SIZE });
    const conversationHistory = messages
        .reverse()
        .map(m => ({
            role: m.author.id === thread.client.user.id ? 'assistant' : 'user',
            content: m.content,
            messageId: m.id, // Store Discord message ID for reference
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

    // Check if we need to generate a summary
    if (messages.size >= SUMMARY_TRIGGER) {
        const summaryResult = await sql.query`
            SELECT TOP 1 summary 
            FROM conversation_summaries 
            WHERE guildConversationId = ${guildConvId}
            ORDER BY createdAt DESC
        `;

        if (summaryResult.recordset.length > 0) {
            conversationHistory.unshift({
                role: 'system',
                content: `Previous conversation summary:\n${summaryResult.recordset[0].summary}`
            });
        } else {
            const summary = await summarizeContext(conversationHistory, guildConvId);
            if (summary) {
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
    return response;
}

// Add this function after the handleAIResponse function
async function detectSearchNeed(message) {
    // Keywords and patterns that indicate a need for current information
    const searchIndicators = [
        /latest|current|recent|new|update|today|now/i,
        /look up|search|find|check|get/i,
        /odds|scores|news|weather|price|status|standings/i,
        /what is|what are|who is|who are|when is|when are|where is|where are/i
    ];

    // Check if the message contains time-sensitive or search-related keywords
    const needsSearch = searchIndicators.some(pattern => pattern.test(message));
    
    if (needsSearch) {
        // Extract the main topic for search by looking for key phrases
        let searchTopic = '';
        
        // Common patterns for search requests
        const patterns = [
            /look up (.*?)(?:\.|\?|!|$)/i,  // "look up X"
            /search for (.*?)(?:\.|\?|!|$)/i,  // "search for X"
            /find (?:out )?(?:about )?(.*?)(?:\.|\?|!|$)/i,  // "find out about X"
            /what (?:is|are) (.*?)(?:\.|\?|!|$)/i,  // "what is/are X"
            /latest (.*?)(?:\.|\?|!|$)/i,  // "latest X"
            /current (.*?)(?:\.|\?|!|$)/i  // "current X"
        ];

        // Try each pattern until we find a match
        for (const pattern of patterns) {
            const match = message.match(pattern);
            if (match && match[1]) {
                searchTopic = match[1].trim();
                break;
            }
        }

        // If no pattern matched, try to extract the relevant part after common trigger words
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
        if (!thread && interaction.channel) {
            if (interaction.channel.isThread()) {
                thread = interaction.channel;
            } else {
                // Create or find existing thread
                const channelName = interaction.channel.name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
                const threadName = `goobster-chat-${channelName}`;
                
                try {
                    const threads = await interaction.channel.threads.fetch();
                    thread = threads.threads.find(t => t.name === threadName);
                    
                    if (!thread) {
                        thread = await interaction.channel.threads.create({
                            name: threadName,
                            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                            reason: 'New Goobster chat thread'
                        });
                    }

                    // Make sure thread is unarchived
                    if (thread.archived) {
                        await thread.setArchived(false);
                    }
                } catch (error) {
                    console.error('Error creating/finding thread:', error);
                    // If we can't create a thread, use the channel directly
                    thread = interaction.channel;
                }
            }
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

        // Create permission request message with buttons
        const permissionMessage = await (thread || interaction.channel).send({
            content: `🔍 **Search Request**\n\nI'd like to gather some up-to-date information about:\n> ${searchInfo.suggestedQuery}\n\n**Reason:** ${searchInfo.reason}\n\nDo you approve this search?`,
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

        // Return null to prevent additional messages
        return null;
    } catch (error) {
        // Make sure to remove the search tracking on error
        completeSearch(channelId, searchInfo.suggestedQuery);
        // Re-throw the error to be handled by the caller
        throw error;
    }
}

async function handleChatInteraction(interaction) {
    let thread = null;
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

        // For mentions and non-voice interactions, we need to handle the thread
        if (!isVoiceInteraction && interaction.channel) {
            if (interaction.channel.isThread()) {
                thread = interaction.channel;
            } else {
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
                    throw new Error('Failed to create or access thread. Please try again.');
                }
            }
        }

        // Get or create guild conversation with thread ID
        const guildConvResult = await db.query`
            SELECT id FROM guild_conversations 
            WHERE guildId = ${interaction.guildId} 
            AND channelId = ${interaction.channel?.id || interaction.channelId}
            AND threadId = ${thread?.id}
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
                    ${thread?.id},
                    ${promptId}
                )
            `;
            const newGuildConvResult = await db.query`
                SELECT id FROM guild_conversations 
                WHERE guildId = ${interaction.guildId} 
                AND channelId = ${interaction.channel?.id || interaction.channelId}
                AND threadId = ${thread?.id}
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

        // Check if the message needs a search
        const searchInfo = await detectSearchNeed(trimmedMessage);
        
        // If search is needed, handle it first
        if (searchInfo.needsSearch) {
            const searchResponse = await handleSearchFlow(searchInfo, interaction, thread);
            
            // Only proceed with message handling if there's a response
            if (searchResponse) {
                // Store the search request in the conversation context
                await db.query`
                    INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot, metadata) 
                    VALUES (${conversationId}, ${guildConvId}, ${botUserId}, ${searchResponse}, 1, ${JSON.stringify({ pendingSearch: true, query: searchInfo.suggestedQuery })})
                `;
                
                // Send the response
                if (thread) {
                    await thread.send(searchResponse);
                } else {
                    await interaction.channel.send(searchResponse);
                }
            }
            return;
        }

        // For voice interactions, we want direct responses without threads
        if (isVoiceInteraction) {
            console.log('Handling voice interaction with message:', trimmedMessage);
            const apiMessages = [
                { role: 'system', content: 'You are a helpful AI assistant. Keep your responses concise and natural for voice conversation.' },
                { role: 'user', content: trimmedMessage }
            ];

            const completion = await openai.chat.completions.create({
                messages: apiMessages,
                model: "gpt-4o",
                temperature: 0.7,
                max_tokens: 150  // Keep responses shorter for voice
            });

            const response = completion.choices[0].message.content.trim();
            console.log('Generated voice response:', response);
            return response;
        }

        // Start typing indicator
        if (thread) {
            await thread.sendTyping();
        }

        // Only defer reply for slash commands
        if (isSlashCommand) {
            await interaction.deferReply();
        }

        // Get conversation history with summary management
        const conversationHistory = await getContextWithSummary(thread, guildConvId, userId);
        
        // Prepare conversation for OpenAI
        const promptResult = await db.query`
            SELECT prompt FROM prompts p
            JOIN guild_conversations gc ON gc.promptId = p.id
            WHERE gc.id = ${guildConvId}
        `;
        
        if (!promptResult.recordset.length) {
            throw new Error('Failed to retrieve conversation prompt.');
        }

        const apiMessages = [
            { role: 'system', content: promptResult.recordset[0].prompt },
            ...conversationHistory,
            { role: 'user', content: trimmedMessage }
        ];
        
        // Generate response
        try {
            // Start typing indicator
            await thread.sendTyping();
            
            const completion = await openai.chat.completions.create({
                messages: apiMessages,
                model: "gpt-4o",
                temperature: 0.7,
                max_tokens: 500
            });

            let response = completion.choices[0].message.content.trim();
            
            // Handle potential search requests in the AI's response
            response = await handleAIResponse(response, interaction);
            
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
                        VALUES (${conversationId}, ${guildConvId}, ${botUserId}, ${response}, 1)
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

            // Only send checkmark for slash commands, and only once
            if (isSlashCommand) {
                await interaction.editReply({
                    content: '✅',
                    allowedMentions: { users: [], roles: [], repliedUser: true }
                });
            }
            
            // If we don't have a thread yet, create one
            if (!thread && interaction.channel) {
                const channelName = interaction.channel.name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
                const threadName = `goobster-chat-${channelName}`;
                
                try {
                    const threads = await interaction.channel.threads.fetch();
                    thread = threads.threads.find(t => t.name === threadName);
                    
                    if (!thread) {
                        thread = await interaction.channel.threads.create({
                            name: threadName,
                            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                            reason: 'New Goobster chat thread'
                        });
                    }

                    if (thread.archived) {
                        await thread.setArchived(false);
                    }
                } catch (error) {
                    console.error('Error creating/finding thread:', error);
                    throw new Error('Failed to create or access thread. Please try again.');
                }
            }
            
            // Split and send the response in chunks
            const messageChunks = chunkMessage(response);
            let firstResponseMsg = null;
            
            // Send each chunk
            for (let i = 0; i < messageChunks.length; i++) {
                const chunk = messageChunks[i];
                const prefix = messageChunks.length > 1 ? `Part ${i + 1}/${messageChunks.length}:\n\n` : '';
                const responseMsg = await thread.send(prefix + chunk);
                
                if (i === 0) {
                    firstResponseMsg = responseMsg;
                }
            }
            
            // Add reactions only to the first message
            if (firstResponseMsg) {
                await firstResponseMsg.react('🔄');  // Regenerate
                await firstResponseMsg.react('📌');  // Pin important messages
                await firstResponseMsg.react('🌳');  // Branch conversation
                await firstResponseMsg.react('💡');  // Mark as solution
                await firstResponseMsg.react('🔍');  // Deep dive/expand
                await firstResponseMsg.react('📝');  // Summarize thread
            }
            
        } catch (error) {
            console.error('Error in response generation:', error);
            throw error;
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
                    max_tokens: 1000  // Increased for more detailed response
                });

                const expandedResponse = completion.choices[0].message.content.trim();
                
                // Split response into chunks of max 1900 characters (leaving room for formatting)
                // Split at markdown headers or double newlines to maintain formatting
                const chunks = chunkMessage(expandedResponse);

                for (const chunk of chunks) {
                    await interaction.channel.send({
                        content: chunk
                    });
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
    const lockKey = `${channel.id}-${threadName}`;
    if (threadLocks.has(lockKey)) {
        return await threadLocks.get(lockKey);
    }

    const lockPromise = (async () => {
        try {
            const threads = await channel.threads.fetch();
            let thread = threads.threads.find(t => t.name === threadName);
            
            if (!thread) {
                thread = await channel.threads.create({
                    name: threadName,
                    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                    reason: 'New Goobster chat thread'
                });
            }

            // Make sure thread is unarchived
            if (thread.archived) {
                await thread.setArchived(false);
            }

            return thread;
        } catch (error) {
            console.error('Error in thread creation:', error);
            throw error;
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

module.exports = {
    handleChatInteraction,
    handleReactionAdd,
    handleReactionRemove
}; 