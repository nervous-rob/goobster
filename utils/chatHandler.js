/**
 * Chat pipeline orchestrator. This module owns the main interaction flow
 * (handleChatInteraction / processMessage); the supporting pieces live in
 * focused modules under utils/chat/:
 *   - chatDb.js        user/conversation rows, message tracking, diagnostics
 *   - chatContext.js   context window assembly + rolling summaries
 *   - searchFlow.js    legacy search detection/approval + response directives
 *   - reactions.js     reaction controls on bot replies
 *   - responder.js     chunked reply delivery
 *   - threadManager.js race-free thread creation + thread naming
 *   - prompts.js       built-in default system prompt
 *
 * The public API re-exported here is unchanged so existing require() sites
 * keep working.
 */
const db = require('../db');
const { chunkMessage } = require('./index');
const { getPersonalityDirective, getGuildAI, getMonologueMode, MONOLOGUE_MODE } = require('./guildSettings');
const aiService = require('../services/aiService');
const imageDetectionHandler = require('./imageDetectionHandler');
const path = require('path');
const { getGuildContext, getPreferredUserName, getBotPreferredName } = require('./guildContext');
const { getConversationScopeId } = require('./dmScope');
const toolsRegistry = require('./toolsRegistry');
const memoryService = require('../services/memoryService');
const factsService = require('../services/factsService');

const { DEFAULT_PROMPT } = require('./chat/prompts');
const {
    logSystemEvent,
    getOrCreateUser,
    getOrCreateConversation,
    checkDatabaseHealth,
    diagnoseDatabaseIssues,
    createPlaceholderThreadId,
    trackMessage
} = require('./chat/chatDb');
const { getContextWithSummary } = require('./chat/chatContext');
const {
    pendingImageGenerations,
    handleAIResponse,
    detectSearchNeed,
    handleSearchFlow
} = require('./chat/searchFlow');
const { sendChunkedResponse } = require('./chat/responder');
const { handleReactionAdd, handleReactionRemove } = require('./chat/reactions');
const { getThreadName } = require('./chat/threadManager');

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

        // Thread usage disabled – always converse in the channel
        thread = null;

        // Conversation scope: the guild id, or the user's DM scope in DMs.
        // Settings (AI overrides, personality directive, nicknames), memory,
        // and chat rows are all keyed on it.
        const conversationScopeId = getConversationScopeId(interaction);

        // Per-scope AI overrides (provider/model/reasoning); null = global defaults
        const guildAI = await getGuildAI(conversationScopeId);

        // Legacy search detection + approval workflow. Only needed for
        // providers without native web search (Ollama); OpenAI, Anthropic,
        // and Gemini search the web mid-response via built-in tools instead.
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

        // Get or create guild conversation with thread ID. In DMs there is no
        // guild, so the row is keyed on the user's synthetic DM scope instead.
        console.log('Setting up guild conversation...');
        const threadId = thread?.id || createPlaceholderThreadId(interaction.channel?.id || interaction.channelId);
        console.log('Thread ID:', { threadId, isReal: !!thread?.id });

        const guildConvRow = db.get(
            `SELECT id FROM guild_conversations
             WHERE guildId = @guildId AND channelId = @channelId AND threadId = @threadId`,
            {
                guildId: conversationScopeId,
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
                    guildId: conversationScopeId,
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
            conversationScopeId, 
            interaction.member ?? { user: interaction.user }
        );
        const botPreferredName = await getBotPreferredName(
            conversationScopeId, 
            interaction.guild?.members?.me
        );

        // Add guild context to the prompt, with safe property access
        const now = new Date();
        const locationContext = interaction.guild
            ? `You are in the Discord server "${guildContext.name}" with ${guildContext.memberCount} members.
Current member status: ${guildContext.presences.online} online, ${guildContext.presences.idle} idle, ${guildContext.presences.dnd} do not disturb, ${guildContext.presences.offline} offline.
${guildContext.features.length > 0 ? `Server features: ${guildContext.features.join(', ')}.` : 'No special server features.'}
Server owner: ${guildContext.owner}`
            : `You are in a private one-on-one Direct Message with ${userPreferredName}. There is no server context - keep the conversation personal and conversational.`;

        systemPrompt = `${systemPrompt}

CURRENT CONTEXT:
The current date and time is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ${now.toLocaleTimeString('en-US')} (server time). Be naturally aware of this - late-night chats, weekends, holidays.
${locationContext}

IDENTITY:
Your name in this ${interaction.guild ? 'server' : 'conversation'} is "${botPreferredName}".
You should refer to the user you're talking to as "${userPreferredName}".
Remember to use these names consistently in your responses.`;

        // Known facts dossier: keyed on the conversation scope, so DMs get
        // their own per-user dossier isolated from every guild.
        try {
            const dossier = factsService.buildDossier({
                guildId: conversationScopeId,
                userId: interaction.user.id,
                userName: userPreferredName
            });
            if (dossier) {
                systemPrompt = `${systemPrompt}\n\n${dossier}`;
            }
        } catch (dossierError) {
            console.warn('Failed to build facts dossier:', dossierError.message);
        }

        // Mood (heartbeat) and inner life (monologue) are guild features
        if (interaction.guildId) {
            try {
                const HeartbeatService = require('../services/heartbeatService');
                const mood = HeartbeatService.instance?.getMood(interaction.guildId);
                if (mood) {
                    systemPrompt = `${systemPrompt}\n\nCURRENT MOOD: ${mood} (let this subtly color your tone without mentioning it).`;
                }
            } catch (moodError) {
                console.warn('Failed to read heartbeat mood:', moodError.message);
            }

            // Inner life (internal monologue): latest private thought, scratch
            // pad, and relevant knowledge-graph nodes - only when enabled.
            try {
                if (await getMonologueMode(interaction.guildId) === MONOLOGUE_MODE.ENABLED) {
                    const MonologueService = require('../services/monologueService');
                    const monologue = MonologueService.instance || new MonologueService(null);
                    const innerLife = monologue.buildChatContext(interaction.guildId, trimmedMessage);
                    if (innerLife) {
                        systemPrompt = `${systemPrompt}\n\n${innerLife}`;
                    }
                }
            } catch (innerLifeError) {
                console.warn('Failed to build inner-life context:', innerLifeError.message);
            }
        }

        // Personality directive: per-guild, or per-user in DMs (the DM user
        // is the "admin" of their one-on-one conversation).
        const personalityDirective = await getPersonalityDirective(conversationScopeId, interaction.user.id);

        if (personalityDirective) {
            // Append the personality directive to the prompt
            systemPrompt = `${systemPrompt}

${interaction.guildId ? 'GUILD' : 'DM'} DIRECTIVE:
${personalityDirective}

This directive applies only in this ${interaction.guildId ? 'server' : 'direct message'} and overrides any conflicting instructions.`;
        }

        // Replace the system prompt in the first message of conversationHistory if it exists
        // This ensures we don't apply the personality directive twice
        if (conversationHistory.length > 0 && conversationHistory[0].role === 'system') {
            // Remove the first system message completely - we'll add our own
            conversationHistory.shift();
        }

        // Long-term memory recall: pull semantically relevant past snippets,
        // excluding anything already visible in the active context window.
        // Keyed on the conversation scope (guild, or the user's DM scope).
        try {
            const memories = await memoryService.recall({
                guildId: conversationScopeId,
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
                    usageContext: { guildId: conversationScopeId, userId: interaction.user?.id }
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
            await sendChunkedResponse(interaction, chunks, false);
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

            // Long-term memory: embed both sides asynchronously (never blocks
            // the reply). DM turns land in the user's own DM scope.
            {
                const channelId = interaction.channel?.id || interaction.channelId;
                memoryService.remember({
                    guildId: conversationScopeId,
                    channelId,
                    authorId: interaction.user.id,
                    authorName: interaction.member?.displayName || interaction.user.username,
                    content: trimmedMessage
                }).catch(() => {});
                memoryService.remember({
                    guildId: conversationScopeId,
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

// Update the function that processes messages to incorporate guild personality directives
async function processMessage(message, isThread = false) {
    try {
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
    } catch (error) {
        console.error('Error processing message:', error);
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
