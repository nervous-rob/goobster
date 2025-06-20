const { sql, getConnection } = require('../azureDb');
const { ThreadAutoArchiveDuration } = require('discord.js');
const AISearchHandler = require('./aiSearchHandler');
const { chunkMessage } = require('./index');
const { getPrompt, getPromptWithGuildPersonality } = require('./memeMode');
const { getThreadPreference, THREAD_PREFERENCE, getPersonalityDirective } = require('./guildSettings');
const aiService = require('../services/aiService');
const imageDetectionHandler = require('./imageDetectionHandler');
const path = require('path');
const { setInterval } = require('timers');
const { getGuildContext, getPreferredUserName, getBotPreferredName } = require('./guildContext');
const toolsRegistry = require('./toolsRegistry');

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
 * Ensures the system_logs table exists and creates it if needed
 * @returns {Promise<void>}
 */
async function ensureSystemLogsTable() {
    try {
        const db = await getConnection();
        if (!db) {
            console.error('Failed to connect to database while ensuring system_logs table');
            return;
        }

        await db.query`
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'system_logs')
            BEGIN
                CREATE TABLE system_logs (
                    id INT IDENTITY(1,1) PRIMARY KEY,
                    log_level VARCHAR(20) NOT NULL,
                    message NVARCHAR(MAX) NOT NULL,
                    metadata NVARCHAR(MAX) NULL,
                    createdAt DATETIME2 DEFAULT GETUTCDATE() NOT NULL,
                    source VARCHAR(100) NULL,
                    error_code VARCHAR(50) NULL,
                    error_state VARCHAR(50) NULL,
                    CONSTRAINT CHK_log_level CHECK (log_level IN ('ERROR', 'WARN', 'INFO', 'DEBUG'))
                )

                CREATE INDEX IX_system_logs_createdAt ON system_logs(createdAt);
                CREATE INDEX IX_system_logs_level_date ON system_logs(log_level, createdAt);
            END
        `;

        console.log('System logs table check completed');
    } catch (error) {
        console.error('Error ensuring system_logs table:', error);
    }
}

/**
 * Logs a system event to the database
 * @param {string} level - The log level (ERROR, WARN, INFO, DEBUG)
 * @param {string} message - The log message
 * @param {Object} metadata - Additional metadata to store
 * @returns {Promise<void>}
 */
async function logSystemEvent(level, message, metadata = {}) {
    try {
        const db = await getConnection();
        if (!db) {
            console.error('Failed to connect to database while logging system event');
            return;
        }

        await db.query`
            INSERT INTO system_logs (log_level, message, metadata, source, error_code, error_state)
            VALUES (
                ${level},
                ${message},
                ${JSON.stringify(metadata)},
                ${metadata.source || null},
                ${metadata.error_code || null},
                ${metadata.error_state || null}
            )
        `;
    } catch (error) {
        console.error('Error logging system event:', error);
    }
}

// Schedule periodic database health checks
setInterval(checkDatabaseHealth, DB_HEALTH_CHECK_INTERVAL);

// Ensure system_logs table exists when module loads
ensureSystemLogsTable();

/**
 * Checks database health by performing basic query operations
 * @returns {Promise<boolean>} True if database is healthy
 */
async function checkDatabaseHealth() {
    console.log('Performing database health check...');
    lastDbHealthCheck = Date.now();
    
    try {
        const db = await getConnection();
        if (!db) {
            throw new Error('Failed to establish database connection');
        }
        
        // Try to query a simple table
        const userCountResult = await db.query`SELECT COUNT(*) as count FROM users`;
        const messageCountResult = await db.query`SELECT COUNT(*) as count FROM messages`;
        
        // Try a test insert and then delete it to verify write permissions
        // Use a transaction to make sure we don't leave test data
        const transaction = await db.transaction();
        await transaction.begin();
        
        try {
            // First check if we have any existing records to use for our test
            const existingGcResult = await transaction.request().query`
                SELECT TOP 1 id FROM guild_conversations
            `;
            
            if (existingGcResult.recordset && existingGcResult.recordset.length > 0) {
                // Use an existing guild conversation ID for our test
                const existingGcId = existingGcResult.recordset[0].id;
                
                // Test insertion with a valid foreign key
                const testResult = await transaction.request().query`
                    INSERT INTO conversation_summaries (guildConversationId, summary, messageCount)
                    OUTPUT INSERTED.id
                    VALUES (${existingGcId}, 'DB Health Check - Please ignore and delete', 0)
                `;
                
                if (testResult.recordset && testResult.recordset.length > 0) {
                    const testId = testResult.recordset[0].id;
                    // Delete our test data
                    await transaction.request().query`DELETE FROM conversation_summaries WHERE id = ${testId}`;
                }
            } else {
                // If no guild conversations exist, we can test insert into users table instead
                const testUserResult = await transaction.request().query`
                    INSERT INTO users (discordUsername, discordId, username) 
                    OUTPUT INSERTED.id
                    VALUES ('DBHealthTest', 'health-check-0000', 'HealthTest')
                `;
                
                if (testUserResult.recordset && testUserResult.recordset.length > 0) {
                    const testUserId = testUserResult.recordset[0].id;
                    await transaction.request().query`DELETE FROM users WHERE id = ${testUserId}`;
                }
            }
            
            // If we get here without errors, commit successful test
            await transaction.commit();
        } catch (txError) {
            // If any errors in the transaction, roll back
            await transaction.rollback();
            throw txError;
        }
        
        console.log('Database health check successful', {
            userCount: userCountResult.recordset[0].count,
            messageCount: messageCountResult.recordset[0].count,
            time: new Date().toISOString()
        });
        
        dbConnectivityOK = true;
        return true;
    } catch (error) {
        dbConnectivityOK = false;
        console.error('Database health check failed:', {
            error: error.message,
            code: error.code,
            number: error.number,
            state: error.state,
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
        
        // Step 1: Check if we can connect to the database
        const db = await getConnection();
        if (!db) {
            return "❌ Can't establish connection to the database. This could be due to network issues, incorrect credentials, or the database server being down.";
        }
        
        // Step 2: Check if we can read from tables
        let hasReadPermission = true;
        let hasWritePermission = true;
        let detailedErrors = [];
        
        try {
            await db.query`SELECT TOP 1 * FROM users`;
        } catch (error) {
            hasReadPermission = false;
            detailedErrors.push(`Read Error: ${error.message}`);
        }
        
        // Step 3: Check if we can write to tables
        const testUserId = interaction.user.id;
        const testUsername = interaction.user.username;
        
        try {
            // Start a transaction we can roll back
            const transaction = await db.transaction();
            await transaction.begin();
            
            // Try to insert a test message in a transaction (will be rolled back)
            await transaction.request().query(`
                DECLARE @TestUserId INT;
                
                IF NOT EXISTS (SELECT 1 FROM users WHERE discordId = '${testUserId}')
                BEGIN
                    INSERT INTO users (discordUsername, discordId, username)
                    VALUES ('${testUsername}', '${testUserId}', '${testUsername}');
                    
                    SELECT @TestUserId = SCOPE_IDENTITY();
                END
                ELSE
                BEGIN
                    SELECT @TestUserId = id FROM users WHERE discordId = '${testUserId}';
                END
            `);
            
            // Roll back the transaction to avoid making actual changes
            await transaction.rollback();
            
        } catch (error) {
            hasWritePermission = false;
            detailedErrors.push(`Write Error: ${error.message}`);
        }
        
        // Generate diagnostic message
        let diagnosticMessage = "**Database Diagnostic Results**\n";
        
        if (hasReadPermission && hasWritePermission) {
            diagnosticMessage += "✅ Database connection and permissions appear to be working correctly.\n";
            
            // Check recent message counts
            const recentMessageCount = await db.query`
                SELECT COUNT(*) as count FROM messages 
                WHERE createdAt > DATEADD(day, -1, GETDATE())
            `;
            
            const recentUtcMessageCount = await db.query`
                SELECT COUNT(*) as count FROM messages 
                WHERE createdAt > DATEADD(day, -1, GETUTCDATE())
            `;
            
            // Check total message counts
            const totalMessageCount = await db.query`
                SELECT COUNT(*) as count FROM messages
            `;
            
            // Get the most recent message
            const mostRecentMessage = await db.query`
                SELECT TOP 1 id, CONVERT(VARCHAR, createdAt, 120) as timestamp, isBot
                FROM messages
                ORDER BY createdAt DESC
            `;
            
            // Get the storage success rate (last 50 attempts)
            const storageAttempts = await db.query`
                SELECT TOP 50 
                    id, 
                    CONVERT(VARCHAR, createdAt, 120) as timestamp,
                    message
                FROM messages
                WHERE message LIKE '%message storage%'
                OR message LIKE '%transaction%committed%'
                ORDER BY createdAt DESC
            `;
            
            diagnosticMessage += `✅ Found ${recentMessageCount.recordset[0].count} messages stored in the last 24 hours (using GETDATE()).\n`;
            diagnosticMessage += `✅ Found ${recentUtcMessageCount.recordset[0].count} messages stored in the last 24 hours (using GETUTCDATE()).\n`;
            diagnosticMessage += `✅ Total message count in database: ${totalMessageCount.recordset[0].count}\n`;
            
            if (mostRecentMessage.recordset && mostRecentMessage.recordset.length > 0) {
                const msg = mostRecentMessage.recordset[0];
                diagnosticMessage += `✅ Most recent message (ID: ${msg.id}) was stored at ${msg.timestamp} (${msg.isBot ? 'bot' : 'user'} message)\n`;
            } else {
                diagnosticMessage += `⚠️ No messages found in the database.\n`;
            }
            
            if (storageAttempts.recordset && storageAttempts.recordset.length > 0) {
                diagnosticMessage += `\n**Recent Storage Attempts:**\n`;
                storageAttempts.recordset.slice(0, 5).forEach(attempt => {
                    diagnosticMessage += `- ${attempt.timestamp}: ${attempt.message.substring(0, 100)}...\n`;
                });
            }
            
            // Check for recent errors
            let recentErrorsInfo = '';
            try {
                // First check if system_logs table exists
                const tableExistsResult = await db.query`
                    SELECT COUNT(*) as count 
                    FROM INFORMATION_SCHEMA.TABLES 
                    WHERE TABLE_NAME = 'system_logs'
                `;
                
                if (tableExistsResult.recordset[0].count > 0) {
                    const recentErrors = await db.query`
                        SELECT TOP 10
                            id,
                            CONVERT(VARCHAR, createdAt, 120) as timestamp,
                            message
                        FROM system_logs
                        WHERE log_level = 'ERROR'
                        AND createdAt > DATEADD(day, -1, GETUTCDATE())
                        ORDER BY createdAt DESC
                    `;
                    
                    if (recentErrors.recordset && recentErrors.recordset.length > 0) {
                        recentErrorsInfo = `\n**Recent Errors (Last 24h):**\n`;
                        recentErrors.recordset.forEach(error => {
                            recentErrorsInfo += `- ${error.timestamp}: ${error.message.substring(0, 100)}...\n`;
                        });
                    } else {
                        recentErrorsInfo = "\n**Recent Errors:** No errors logged in the last 24 hours.\n";
                    }
                } else {
                    recentErrorsInfo = "\n**Recent Errors:** System logs table not found in database.\n";
                }
            } catch (logError) {
                console.error('Error querying system logs:', logError);
                recentErrorsInfo = "\n**Recent Errors:** Unable to retrieve error logs - system_logs table may not exist.\n";
            }

            diagnosticMessage += recentErrorsInfo;
            
            // Verify the createdAt column configuration
            const columnInfo = await db.query`
                SELECT 
                    COLUMN_NAME,
                    DATA_TYPE,
                    IS_NULLABLE,
                    COLUMN_DEFAULT
                FROM 
                    INFORMATION_SCHEMA.COLUMNS
                WHERE 
                    TABLE_NAME = 'messages' 
                    AND COLUMN_NAME = 'createdAt'
            `;
            
            if (columnInfo.recordset && columnInfo.recordset.length > 0) {
                const col = columnInfo.recordset[0];
                diagnosticMessage += `\n**Message CreatedAt Column Info:**\n`;
                diagnosticMessage += `- Data Type: ${col.DATA_TYPE}\n`;
                diagnosticMessage += `- Is Nullable: ${col.IS_NULLABLE}\n`;
                diagnosticMessage += `- Default Value: ${col.COLUMN_DEFAULT || 'None'}\n`;
            }
            
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

        const summary = await aiService.chat([
            { role: 'user', content: summaryPrompt }
        ], {
            temperature: 0.7,
            max_tokens: 500
        });
        
        // Chunk the summary if needed
        const chunks = chunkMessage(summary);
        
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
            const requestData = await AISearchHandler.requestSearch(interaction, query, reason);
            if (requestData && requestData.requestId === null) {
                const guildId = interaction.guild?.id;
                const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
                const response = await aiService.chat([
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

Respond with ONLY "true" if a search is needed, or "false" if no search is needed.
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

            const responseContent = await aiService.chat(conversationHistory, {
                preset: 'chat',
                max_tokens: 500
            });

            await interaction.editReply(responseContent);
            return null; // Indicate no further action
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

        // If we received a search response, try to store it in the database
        const searchResponse = `🔍 I've requested permission to search for information about "${searchInfo.suggestedQuery}". Please approve or deny the request.`;
        try {
            // Use local variables only - don't modify parent scope variables
            const db = await getConnection();
            if (db) {
                // Get bot ID
                const botUserResult = await db.query`
                    SELECT id FROM users 
                    WHERE discordId = ${interaction.client.user.id}
                `;
                
                let localBotUserId;
                if (botUserResult.recordset.length === 0) {
                    await db.query`
                        INSERT INTO users (discordUsername, discordId, username) 
                        VALUES ('Goobster', ${interaction.client.user.id}, 'Goobster')
                    `;
                    const newBotUserResult = await db.query`
                        SELECT id FROM users 
                        WHERE discordId = ${interaction.client.user.id}
                    `;
                    localBotUserId = newBotUserResult.recordset[0].id;
                } else {
                    localBotUserId = botUserResult.recordset[0].id;
                }

                // Get guild conversation ID for recording message
                const localGuildConvId = thread?.id || createPlaceholderThreadId(interaction.channel?.id || interaction.channelId);
                
                // Look up any existing conversation
                let localConversationId = null;
                const userResult = await db.query`
                    SELECT id FROM users 
                    WHERE discordId = ${interaction.user.id}
                `;
                
                if (userResult.recordset.length > 0) {
                    const localUserId = userResult.recordset[0].id;
                    const conversationResult = await db.query`
                        SELECT id FROM conversations 
                        WHERE userId = ${localUserId} 
                        AND guildConversationId = ${localGuildConvId}
                    `;
                    
                    if (conversationResult.recordset.length > 0) {
                        localConversationId = conversationResult.recordset[0].id;
                    }
                }
                
                // Store the search request in the conversation context if we have a valid conversation
                if (localConversationId) {
                    try {
                        await db.query`
                            INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot, metadata) 
                            VALUES (${localConversationId}, ${localGuildConvId}, ${localBotUserId}, ${searchResponse}, 1, ${JSON.stringify({ pendingSearch: true, query: searchInfo.suggestedQuery })})
                        `;
                    } catch (dbError) {
                        console.error('Database Error - Failed to store search request message:', {
                            error: dbError.message,
                            errorCode: dbError.code || 'unknown',
                            number: dbError.number, 
                            state: dbError.state,
                            stack: dbError.stack,
                            context: 'Error storing search request',
                            conversationId: localConversationId,
                            guildConvId: localGuildConvId,
                            query: searchInfo.suggestedQuery
                        });
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
    let db = null;
    const isSlashCommand = interaction.commandName === 'chat';
    const isVoiceInteraction = !isSlashCommand && 
                             interaction.commandName === 'voice' && 
                             interaction.options && 
                             typeof interaction.options.getString === 'function';
    
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
        
        // Initialize database connection first
        db = await getConnection();
        if (!db) {
            console.error('Database Connection Error:', {
                context: 'Failed to establish database connection for chat interaction',
                userMessagePreview: userMessage ? (userMessage.substring(0, 50) + (userMessage.length > 50 ? '...' : '')) : 'N/A',
                guildId: interaction.guildId,
                channelId: interaction.channel?.id || interaction.channelId,
                threadId: thread?.id,
                isSlashCommand,
                isVoiceInteraction,
                timestamp: new Date().toISOString()
            });
            throw new Error('Failed to establish database connection. I can still chat with you, but I might not be able to remember our conversation.');
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

        // Get thread preference for this guild/conversation - safely handle missing guild
        let threadPreference = THREAD_PREFERENCE.ALWAYS_CHANNEL; // Default
        if (interaction.guildId) {
            threadPreference = await getThreadPreference(interaction.guildId);
        }
        
        // Thread usage disabled – always converse in the channel
        thread = null;

        // Check if this message might need a search
        // Use the AI-based detection for more accurate results
        const searchInfo = await detectSearchNeed(trimmedMessage);
        
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
            } catch (error) {
                console.error('Error in search handling:', error);
                // Send an error message to the user
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({
                        content: `❌ Error processing search: ${error.message}`,
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: `❌ Error processing search: ${error.message}`,
                        ephemeral: true
                    });
                }
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

        const userResult = await db.query`
            SELECT id FROM users 
            WHERE discordId = ${interaction.user.id}
        `;

        let userId;
        if (userResult.recordset.length === 0) {
            console.log('Creating new user record...');
            await db.query`
                INSERT INTO users (discordUsername, discordId, username) 
                VALUES (${interaction.user.username}, ${interaction.user.id}, ${interaction.user.username})
            `;
            const newUserResult = await db.query`
                SELECT id FROM users 
                WHERE discordId = ${interaction.user.id}
            `;
            userId = newUserResult.recordset[0].id;
            console.log('Created new user record', { userId });
        } else {
            userId = userResult.recordset[0].id;
            console.log('Found existing user record', { userId });
        }

        // Get or create bot user first
        console.log('Setting up bot user...');
        const botUserResult = await db.query`
            SELECT id FROM users 
            WHERE discordId = ${interaction.client.user.id}
        `;

        let botUserId;
        if (botUserResult.recordset.length === 0) {
            console.log('Creating bot user record...');
            await db.query`
                INSERT INTO users (discordUsername, discordId, username) 
                VALUES ('Goobster', ${interaction.client.user.id}, 'Goobster')
            `;
            const newBotUserResult = await db.query`
                SELECT id FROM users 
                WHERE discordId = ${interaction.client.user.id}
            `;
            botUserId = newBotUserResult.recordset[0].id;
            console.log('Created bot user record', { botUserId });
        } else {
            botUserId = botUserResult.recordset[0].id;
            console.log('Found existing bot user record', { botUserId });
        }

        // Get or create guild conversation with thread ID
        console.log('Setting up guild conversation...');
        const threadId = thread?.id || createPlaceholderThreadId(interaction.channel?.id || interaction.channelId);
        console.log('Thread ID:', { threadId, isReal: !!thread?.id });

        const guildConvResult = await db.query`
            SELECT id FROM guild_conversations 
            WHERE guildId = ${interaction.guildId} 
            AND channelId = ${interaction.channel?.id || interaction.channelId}
            AND threadId = ${threadId}
        `;

        let guildConvId;
        if (guildConvResult.recordset.length === 0) {
            console.log('Creating new guild conversation...');
            // Get default prompt
            const defaultPromptResult = await db.query`
                SELECT TOP 1 id FROM prompts 
                WHERE isDefault = 1
            `;
            
            const promptId = defaultPromptResult.recordset[0]?.id;
            console.log('Using prompt ID:', { promptId });
            
            const insertResult = await db.query`
                INSERT INTO guild_conversations 
                (guildId, channelId, threadId, promptId) 
                OUTPUT INSERTED.id
                VALUES (
                    ${interaction.guildId}, 
                    ${interaction.channel?.id || interaction.channelId},
                    ${threadId},
                    ${promptId}
                )
            `;
            guildConvId = insertResult.recordset[0].id;
            console.log('Created new guild conversation', { guildConvId });
        } else {
            guildConvId = guildConvResult.recordset[0].id;
            console.log('Found existing guild conversation', { guildConvId });
        }

        // Get or create conversation
        console.log('Setting up user conversation...');
        const conversationResult = await db.query`
            SELECT id FROM conversations 
            WHERE userId = ${userId} 
            AND guildConversationId = ${guildConvId}
        `;

        let conversationId;
        if (conversationResult.recordset.length === 0) {
            console.log('Creating new conversation...');
            const insertResult = await db.query`
                INSERT INTO conversations (userId, guildConversationId) 
                OUTPUT INSERTED.id
                VALUES (${userId}, ${guildConvId})
            `;
            conversationId = insertResult.recordset[0].id;
            console.log('Created new conversation', { conversationId });
        } else {
            conversationId = conversationResult.recordset[0].id;
            console.log('Found existing conversation', { conversationId });
        }

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
        systemPrompt = `${systemPrompt}

CURRENT CONTEXT:
You are in the ${interaction.guild ? `Discord server "${guildContext.name}"` : 'a Direct Message'} with ${guildContext.memberCount} members.
Current member status: ${guildContext.presences.online} online, ${guildContext.presences.idle} idle, ${guildContext.presences.dnd} do not disturb, ${guildContext.presences.offline} offline.
${guildContext.features.length > 0 ? `Server features: ${guildContext.features.join(', ')}.` : 'No special server features.'}
${interaction.guild ? `Server owner: ${guildContext.owner}` : ''}

IDENTITY:
Your name in this ${interaction.guild ? 'server' : 'conversation'} is "${botPreferredName}".
You should refer to the user you're talking to as "${userPreferredName}".
Remember to use these names consistently in your responses.`;

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
            
            // -- Function-calling capable request --
            let assistantResponseText = null;
            let messagesForModel = [...apiMessages];

            const functionDefs = toolsRegistry.getDefinitions();
            const providerCapabilities = aiService.getProviderCapabilities();

            // Allow up to two tool invocations to avoid infinite loops
            for (let depth = 0; depth < 3; depth++) {
                const chatOptions = {
                    preset: 'chat',
                    max_tokens: 1000
                };

                // Add function definitions if the provider supports them or uses prompt-based integration
                if (functionDefs.length > 0) {
                    chatOptions.functions = functionDefs;
                }

                const llmResponse = await aiService.chat(messagesForModel, chatOptions);

                // Handle different response formats (OpenAI vs Gemini)
                let choice;
                if (llmResponse.choices && llmResponse.choices[0]) {
                    choice = llmResponse.choices[0];
                } else if (typeof llmResponse === 'string') {
                    // Direct string response from Gemini without function calling
                    assistantResponseText = llmResponse;
                    break;
                } else {
                    assistantResponseText = 'I had trouble thinking of a reply.';
                    break;
                }

                // If the LLM wants to call a function
                if (choice.finish_reason === 'function_call' || choice.message?.function_call) {
                    const { name, arguments: argsJson } = choice.message.function_call;
                    let fnResult;
                    try {
                        const parsedArgs = JSON.parse(argsJson || '{}');
                        parsedArgs.interactionContext = interaction;
                        fnResult = await toolsRegistry.execute(name, parsedArgs);
                        
                        // Debug logging for Azure DevOps results
                        if (name.includes('DevOps') || name.includes('WorkItem')) {
                            console.log(`Azure DevOps tool "${name}" executed successfully`);
                            console.log('Result type:', typeof fnResult);
                            console.log('Result length:', typeof fnResult === 'string' ? fnResult.length : 'N/A');
                            console.log('Result preview:', typeof fnResult === 'string' ? 
                                fnResult.substring(0, 200) + (fnResult.length > 200 ? '...' : '') : 
                                JSON.stringify(fnResult).substring(0, 200));
                        }
                    } catch (toolErr) {
                        console.error(`Tool execution error for ${name}:`, toolErr);
                        fnResult = `Error executing tool ${name}: ${toolErr.message}`;
                    }

                    // Handle function results differently for different providers
                    const currentProvider = aiService.getProvider();
                    
                    if (currentProvider === 'openai') {
                        // OpenAI understands the 'function' role
                        messagesForModel.push(choice.message);
                        messagesForModel.push({
                            role: 'function',
                            name,
                            content: typeof fnResult === 'string' ? fnResult : JSON.stringify(fnResult)
                        });
                    } else {
                        // Gemini doesn't understand 'function' role, so format as user message
                        const resultContent = typeof fnResult === 'string' ? fnResult : JSON.stringify(fnResult);
                        const truncatedResult = resultContent.length > 2000 ? 
                            resultContent.substring(0, 2000) + '... (truncated)' : 
                            resultContent;
                        
                        messagesForModel.push({
                            role: 'user',
                            content: `Tool "${name}" executed successfully. Result: ${truncatedResult}

Please provide a user-friendly summary of these results.`
                        });
                        
                        console.log(`Formatted tool result for Gemini (length: ${truncatedResult.length})`);
                    }
                    
                    continue; // Next round – let the model craft the user-visible reply
                }

                assistantResponseText = choice.message?.content || '';
                break;
            }

            const responseContent = assistantResponseText;
            
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
                        console.log('Storing user message...');
                        const userMsgResult = await db.query`
                            INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot) 
                            OUTPUT INSERTED.id, INSERTED.createdAt
                            VALUES (${conversationId}, ${guildConvId}, ${userId}, ${trimmedMessage}, 0)
                        `;
                        console.log('User message stored successfully', {
                            messageId: userMsgResult.recordset?.[0]?.id || 'unknown',
                            createdAt: userMsgResult.recordset?.[0]?.createdAt || 'unknown'
                        });
                    
                        // Store bot response as a simple note that an image was generated
                        console.log('Storing bot response for image generation...');
                        const botMsgResult = await db.query`
                            INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot, metadata) 
                            OUTPUT INSERTED.id, INSERTED.createdAt
                            VALUES (${conversationId}, ${guildConvId}, ${botUserId}, ${"I've generated an image based on your request."}, 1, ${JSON.stringify({ imageGenerated: true, prompt: trimmedMessage })})
                        `;
                        console.log('Bot response for image generation stored successfully', {
                            messageId: botMsgResult.recordset?.[0]?.id || 'unknown',
                            createdAt: botMsgResult.recordset?.[0]?.createdAt || 'unknown'
                        });
                    }, TRANSACTION_TIMEOUT);
                    
                    await transaction.commit();
                    console.log('Image generation message storage transaction committed successfully');
                } catch (dbError) {
                    await transaction.rollback();
                    console.error('Database Error - Failed to store image generation messages:', {
                        error: dbError.message,
                        errorCode: dbError.code || 'unknown',
                        number: dbError.number,
                        state: dbError.state,
                        stack: dbError.stack,
                        context: 'Transaction timeout or database error during image generation',
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
            
            // For non-image responses, use existing chunking
            const chunks = chunkMessage(processedResponse);
            await sendChunkedResponse(interaction, chunks, false, thread);
            
            // Store messages in database with transaction
            const transaction = await db.transaction();
            await transaction.begin();
            
            try {
                console.log('Starting message storage transaction', {
                    conversationId,
                    guildConvId,
                    userMessagePreview: trimmedMessage.substring(0, 50) + (trimmedMessage.length > 50 ? '...' : '')
                });
                
                // Store user message
                const userMsgResult = await transaction.request().query`
                    INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot) 
                    OUTPUT INSERTED.id, INSERTED.createdAt
                    VALUES (${conversationId}, ${guildConvId}, ${userId}, ${trimmedMessage}, 0)
                `;
                
                console.log('User message stored:', {
                    messageId: userMsgResult.recordset?.[0]?.id,
                    createdAt: userMsgResult.recordset?.[0]?.createdAt
                });

                // Store bot response
                const botMsgResult = await transaction.request().query`
                    INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot) 
                    OUTPUT INSERTED.id, INSERTED.createdAt
                    VALUES (${conversationId}, ${guildConvId}, ${botUserId}, ${processedResponse}, 1)
                `;
                
                console.log('Bot message stored:', {
                    messageId: botMsgResult.recordset?.[0]?.id,
                    createdAt: botMsgResult.recordset?.[0]?.createdAt
                });

                await transaction.commit();
                console.log('Message storage transaction committed successfully');

                // Verify the messages were stored
                const verifyMessages = await db.query`
                    SELECT id, conversationId, guildConversationId, createdBy, createdAt
                    FROM messages
                    WHERE id IN (${userMsgResult.recordset[0].id}, ${botMsgResult.recordset[0].id})
                `;

                console.log('Message storage verification:', {
                    foundMessages: verifyMessages.recordset.length,
                    messages: verifyMessages.recordset.map(m => ({
                        id: m.id,
                        conversationId: m.conversationId,
                        guildConvId: m.guildConversationId,
                        createdBy: m.createdBy,
                        createdAt: m.createdAt
                    }))
                });
            } catch (error) {
                await transaction.rollback();
                console.error('Error storing messages:', error);
                throw error;
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
                // Only include these if they've been initialized
                hasThread: !!thread,
                // Safely reference fields that might not be initialized
                hasUserId: !!userId,
                hasGuildConvId: !!guildConvId
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
                const newResponse = await aiService.chat([
                        { role: 'system', content: promptResult.recordset[0].prompt },
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
                const expandedResponse = await aiService.chat(deepDivePrompt, {
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

                const summary = await aiService.chat(
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

// Add this utility function
async function executeWithTimeout(promise, timeout) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Transaction timeout after ${timeout}ms`));
        }, timeout);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } catch (error) {
        // Add additional context to timeout errors
        if (error.message.includes('Transaction timeout')) {
            console.error('Database Transaction Timeout:', {
                timeout: `${timeout}ms`,
                error: error.message,
                stack: error.stack,
                time: new Date().toISOString()
            });
        }
        throw error;
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
            console.error('Failed to connect to database for message tracking', {
                guildConvId,
                discordUserId,
                messagePreview: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
                role
            });
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
        console.error('Error tracking message in database:', {
            error: error.message,
            errorCode: error.code || 'unknown',
            number: error.number,
            state: error.state,
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

        const threadName = (await aiService.chat([
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
    logSystemEvent,
    ensureSystemLogsTable
}; 