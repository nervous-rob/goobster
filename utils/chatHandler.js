const { OpenAI } = require('openai');
const { sql, getConnection } = require('../azureDb');
const config = require('../config.json');
const { ThreadAutoArchiveDuration } = require('discord.js');

const openai = new OpenAI({ apiKey: config.openaiKey });

const DEFAULT_PROMPT = `You are Goobster, a friendly and helpful Discord bot. You have a quirky personality and love to help users with various tasks. You can engage in casual conversation, answer questions, or help with specific tasks. You should be concise but friendly in your responses. You should maintain context of the conversation within the thread.`;

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
        await sql.query`
            INSERT INTO conversation_summaries (guildConversationId, summary, messageCount)
            VALUES (${guildConvId}, ${summary}, ${messages.length})
        `;

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

async function handleChatInteraction(interaction) {
    let thread = null;
    const isSlashCommand = interaction.commandName === 'chat';
    const isVoiceInteraction = !isSlashCommand && 
                             interaction.commandName === 'voice' && 
                             interaction.options && 
                             typeof interaction.options.getString === 'function';
    
    try {
        // Get message content, checking both slash command and mention formats
        const userMessage = interaction.options?.getString?.('message') || 
                           interaction.options?.getString?.() || 
                           interaction.content;

        if (!userMessage) {
            throw new Error('No message provided.');
        }

        console.log('Processing interaction:', {
            type: isVoiceInteraction ? 'voice' : (isSlashCommand ? 'slash' : 'mention'),
            message: userMessage,
            hasOptions: !!interaction.options,
            commandName: interaction.commandName
        });

        // For voice interactions, we want direct responses without threads
        if (isVoiceInteraction) {
            console.log('Handling voice interaction with message:', userMessage);
            const apiMessages = [
                { role: 'system', content: 'You are a helpful AI assistant. Keep your responses concise and natural for voice conversation.' },
                { role: 'user', content: userMessage }
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

        // For mentions and non-voice interactions, we need to handle the thread
        if (!isVoiceInteraction && interaction.channel) {
            // Check if we're already in a thread
            if (interaction.channel.isThread()) {
                thread = interaction.channel;
            } else {
                // Look for existing thread or create new one
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
                        
                        // Send welcome message in new thread
                        await thread.send(
                            "👋 Hi! I've created this thread for our conversation. " +
                            "You can continue chatting with me here by:\n" +
                            "1. Using `/chat` command\n" +
                            `2. Mentioning me (@${interaction.client.user.username})\n\n` +
                            "The thread will keep our conversation organized and maintain context!"
                        );
                    }

                    // Make sure thread is unarchived
                    if (thread.archived) {
                        await thread.setArchived(false);
                    }

                    // For mentions, send the response directly in the thread
                    if (!isSlashCommand) {
                        // Send initial response in original channel
                        await thread.send({
                            content: userMessage,
                            allowedMentions: { users: [], roles: [] }
                        });
                    } else {
                        // For slash commands, use the original reply method
                        await interaction.reply({ 
                            content: `I've moved our conversation to a thread: ${thread.toString()}`,
                            allowedMentions: { users: [], roles: [] }
                        });
                    }
                } catch (threadError) {
                    console.error('Error creating/finding thread:', threadError);
                    throw new Error('Failed to create or access thread. Please try again.');
                }
            }
        }

        // Start typing indicator
        if (thread) {
            await thread.sendTyping();
        }

        // Only defer reply for slash commands
        if (isSlashCommand) {
            await interaction.deferReply();
        }

        const db = await getConnection();
        
        // Get or create user
        let userResult = await sql.query`
            SELECT id, activeConversationId 
            FROM users 
            WHERE discordUsername = ${interaction.user.username}
        `;
        
        let userId;
        if (userResult.recordset.length === 0) {
            // Create new user
            await sql.query`
                INSERT INTO users (discordUsername, discordId) 
                VALUES (${interaction.user.username}, ${interaction.user.id})
            `;
            userResult = await sql.query`
                SELECT id FROM users 
                WHERE discordUsername = ${interaction.user.username}
            `;
            userId = userResult.recordset[0].id;
            
            // Create default prompt for the user
            await sql.query`
                INSERT INTO prompts (userId, label, prompt, isDefault) 
                VALUES (${userId}, 'Master Goobster', ${DEFAULT_PROMPT}, 1)
            `;
        } else {
            userId = userResult.recordset[0].id;
        }
        
        // Get or create thread for this channel
        const channelName = interaction.channel.name.replace(/[^a-z0-9-_]/gi, '-').toLowerCase();
        const threadName = `goobster-chat-${channelName}`;
        
        // Check if we're already in a thread
        if (interaction.channel.isThread()) {
            thread = interaction.channel;
        } else {
            try {
                const threads = await interaction.channel.threads.fetch();
                thread = threads.threads.find(t => t.name === threadName);
                
                if (!thread) {
                    thread = await interaction.channel.threads.create({
                        name: threadName,
                        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                        reason: 'New Goobster chat thread'
                    });
                    
                    // Send welcome message in new thread
                    await thread.send(
                        "👋 Hi! I've created this thread for our conversation. " +
                        "You can continue chatting with me here by:\n" +
                        "1. Using `/chat` command\n" +
                        `2. Mentioning me (@${interaction.client.user.username})\n\n` +
                        "The thread will keep our conversation organized and maintain context!"
                    );
                }

                // Make sure thread is unarchived
                if (thread.archived) {
                    await thread.setArchived(false);
                }
            } catch (threadError) {
                console.error('Error creating/finding thread:', threadError);
                throw new Error('Failed to create or access thread. Please try again.');
            }
        }

        if (!thread || !thread.id) {
            throw new Error('Failed to access thread. Please try again.');
        }
        
        // Get or create guild conversation
        let guildConvResult = await sql.query`
            SELECT gc.id, gc.promptId 
            FROM guild_conversations gc
            WHERE gc.guildId = ${interaction.guildId} 
            AND gc.threadId = ${thread.id}
        `;
        
        let guildConvId, promptId;
        if (guildConvResult.recordset.length === 0) {
            // Get default prompt from the user who started the conversation
            const promptResult = await sql.query`
                SELECT id FROM prompts 
                WHERE userId = ${userId} 
                AND isDefault = 1
            `;

            if (!promptResult.recordset.length) {
                // Create default prompt if it doesn't exist
                await sql.query`
                    INSERT INTO prompts (userId, label, prompt, isDefault) 
                    VALUES (${userId}, 'Master Goobster', ${DEFAULT_PROMPT}, 1)
                `;
                const newPromptResult = await sql.query`
                    SELECT id FROM prompts 
                    WHERE userId = ${userId} 
                    AND isDefault = 1
                `;
                promptId = newPromptResult.recordset[0].id;
            } else {
                promptId = promptResult.recordset[0].id;
            }
            
            // Create guild conversation
            await sql.query`
                INSERT INTO guild_conversations (guildId, threadId, promptId) 
                VALUES (${interaction.guildId}, ${thread.id}, ${promptId})
            `;
            guildConvResult = await sql.query`
                SELECT id, promptId FROM guild_conversations 
                WHERE guildId = ${interaction.guildId} 
                AND threadId = ${thread.id}
            `;
        }
        guildConvId = guildConvResult.recordset[0].id;
        promptId = guildConvResult.recordset[0].promptId;

        // Create or get user's conversation for this guild conversation
        let conversationResult = await sql.query`
            SELECT id FROM conversations 
            WHERE userId = ${userId}
            AND promptId = ${promptId}
        `;

        let conversationId;
        if (conversationResult.recordset.length === 0) {
            // Create new conversation
            await sql.query`
                INSERT INTO conversations (userId, promptId) 
                VALUES (${userId}, ${promptId})
            `;
            conversationResult = await sql.query`
                SELECT id FROM conversations 
                WHERE userId = ${userId}
                AND promptId = ${promptId}
            `;
        }
        conversationId = conversationResult.recordset[0].id;

        // Update user's active conversation
        await sql.query`
            UPDATE users 
            SET activeConversationId = ${conversationId}
            WHERE id = ${userId}
        `;
        
        // Ensure bot user exists
        const botUserResult = await sql.query`
            SELECT id FROM users 
            WHERE discordId = ${interaction.client.user.id}
        `;
        
        let botUserId;
        if (botUserResult.recordset.length === 0) {
            // Create bot user with bot's own information
            await sql.query`
                INSERT INTO users (discordUsername, discordId, username) 
                VALUES ('GoobyGPT', ${interaction.client.user.id}, 'GoobyGPT')
            `;
            const newBotUserResult = await sql.query`
                SELECT id FROM users 
                WHERE discordId = ${interaction.client.user.id}
            `;
            botUserId = newBotUserResult.recordset[0].id;
        } else {
            botUserId = botUserResult.recordset[0].id;
        }
        
        // Get conversation history with summary management
        const conversationHistory = await getContextWithSummary(thread, guildConvId, userId);
        
        // Prepare conversation for OpenAI
        const promptResult = await sql.query`
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
            { role: 'user', content: userMessage }
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
            }).catch(async (error) => {
                console.error('OpenAI API Error:', error);
                if (error.response?.status === 429) {
                    await thread.send("I'm a bit overwhelmed right now. Please try again in a moment.");
                } else {
                    await thread.send("I encountered an error generating a response. Please try again.");
                }
                throw error;
            });
            
            const response = completion.choices[0].message.content.trim();
            
            // Store messages in database with transaction
            const transaction = new sql.Transaction();
            await transaction.begin();
            
            try {
                // Store user message
                await transaction.request().query`
                    INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot) 
                    VALUES (${conversationId}, ${guildConvId}, ${userId}, ${userMessage}, 0)
                `;
                
                // Store bot response
                await transaction.request().query`
                    INSERT INTO messages (conversationId, guildConversationId, createdBy, message, isBot) 
                    VALUES (${conversationId}, ${guildConvId}, ${botUserId}, ${response}, 1)
                `;
                
                await transaction.commit();
            } catch (dbError) {
                await transaction.rollback();
                console.error('Database Error:', dbError);
                throw new Error('Failed to store conversation in database.');
            }
            
            // Send response in thread with reaction controls
            const responseMsg = await thread.send(response);
            await responseMsg.react('🔄');  // Regenerate
            await responseMsg.react('📌');  // Pin important messages
            await responseMsg.react('🌳');  // Branch conversation
            await responseMsg.react('💡');  // Mark as solution
            await responseMsg.react('🔍');  // Deep dive/expand
            await responseMsg.react('📝');  // Summarize thread
            
            // Handle the final reply based on interaction type
            if (isSlashCommand) {
                await interaction.editReply({
                    content: `I've responded in the thread: ${thread.toString()}`,
                    allowedMentions: { users: [], roles: [], repliedUser: true }
                });
            } else {
                await interaction.editReply('✅');
            }
            
        } catch (error) {
            console.error('Error in response generation:', error);
            throw error;
        }
        
    } catch (error) {
        console.error('Error in chat handler:', error);
        const errorMessage = error.message || 'Sorry, I encountered an error while processing your message.';
        
        if (thread) {
            // If we have a thread, send the error there
            await thread.send(`Error: ${errorMessage}`);
        }
        
        await interaction.editReply({
            content: errorMessage,
            allowedMentions: { users: [], roles: [], repliedUser: true }
        });
    }
}

// Add reaction handler for conversation branching
async function handleReactionAdd(reaction, user) {
    if (user.bot) return;

    const msg = reaction.message;
    if (reaction.emoji.name === '🔄') {
        // Regenerate response
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
        // Pin message for future reference
        await msg.pin();
        await msg.react('📍'); // Confirm pin
    } else if (reaction.emoji.name === '🌳') {
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
            const chunks = expandedResponse.split(/(?=###|\n\n)/).reduce((acc, chunk) => {
                const lastChunk = acc[acc.length - 1];
                
                // If adding this chunk would exceed limit, start a new chunk
                if (lastChunk && (lastChunk + chunk).length < 1900) {
                    acc[acc.length - 1] = lastChunk + chunk;
                } else {
                    acc.push(chunk);
                }
                
                return acc;
            }, ['']);

            // Send each chunk as a separate message
            let firstResponse = null;
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const isFirst = i === 0;
                const content = isFirst ? 
                    `🔍 **Detailed Expansion:**\n\n${chunk}` : 
                    chunk;
                
                const response = await msg.reply({
                    content,
                    allowedMentions: { users: [], roles: [] }
                });

                // Store first response for adding reactions
                if (isFirst) {
                    firstResponse = response;
                }
            }

            // Add navigation reactions to the first message only
            if (firstResponse) {
                await firstResponse.react('📌');  // Allow pinning the detailed response
                await firstResponse.react('🔍');  // Allow further expansion if needed
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

module.exports = {
    handleChatInteraction,
    handleReactionAdd,
    handleReactionRemove
}; 