// TODO: Add proper handling for interaction state management
// TODO: Add proper handling for interaction state persistence
// TODO: Add proper handling for interaction button state
// TODO: Add proper handling for interaction context loss
// TODO: Add proper handling for interaction timeouts
// TODO: Add proper handling for interaction response timeouts
// TODO: Add proper handling for interaction cleanup
// TODO: Add proper handling for interaction error recovery
// TODO: Add proper handling for interaction deferral failures
// TODO: Add proper handling for interaction followup failures

const AISearchHandler = require('../utils/aiSearchHandler');
const perplexityService = require('../services/perplexityService');
const { OpenAI } = require('openai');
const config = require('../config.json');
const { chunkMessage } = require('../utils');
const { getPrompt, getPromptWithGuildPersonality } = require('../utils/memeMode');

const openai = new OpenAI({ apiKey: config.openaiKey });

module.exports = {
    name: 'interactionCreate',
    async execute(interaction) {
        let interactionState = {
            deferred: false,
            replied: false,
            error: null
        };

        try {
            // Handle button interactions
            if (interaction.isButton()) {
                const [action, type, requestId] = interaction.customId.split('_');
                
                if (type === 'search') {
                    try {
                        await interaction.deferUpdate();
                        interactionState.deferred = true;
                    } catch (deferError) {
                        console.warn('Failed to defer interaction update:', {
                            error: deferError.message,
                            customId: interaction.customId
                        });
                    }

                    if (action === 'approve') {
                        const result = await AISearchHandler.handleSearchApproval(requestId, interaction);
                        if (result) {
                            // Get the original conversation context
                            const messages = await interaction.channel.messages.fetch({ limit: 10 });
                            const originalQuestion = messages.find(m => 
                                !m.author.bot && 
                                m.id === interaction.message.reference?.messageId || 
                                messages.filter(msg => !msg.author.bot).first()
                            );

                            if (originalQuestion) {
                                const initialResponse = await interaction.channel.send({
                                    content: "🤔 Let me think about that for a moment..."
                                }).catch(error => {
                                    console.error('Failed to send initial response:', {
                                        error: error.message,
                                        channelId: interaction.channel.id
                                    });
                                    return null;
                                });

                                if (!initialResponse) {
                                    throw new Error('Failed to send initial response message');
                                }

                                try {
                                    // Get system prompt with meme mode and guild personality
                                    const guildId = interaction.guild?.id;
                                    const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
                                    
                                    // Build conversation history with search results
                                    const conversationHistory = [
                                        { role: 'system', content: systemPrompt },
                                        { role: 'user', content: originalQuestion.content },
                                        { role: 'system', content: `Here is relevant information to help answer the question: ${result.result}` }
                                    ];

                                    const completion = await openai.chat.completions.create({
                                        messages: conversationHistory,
                                        model: "gpt-4o",
                                        temperature: 0.7,
                                        max_tokens: 500
                                    });

                                    const responseContent = completion.choices[0].message.content;

                                    let firstResponseMsg = await initialResponse.edit({
                                        content: responseContent
                                    });

                                    // Add reactions for interaction
                                    const reactions = [
                                        ['🔄', 'Regenerate'],
                                        ['📌', 'Pin important messages'],
                                        ['🌳', 'Branch conversation'],
                                        ['💡', 'Mark as solution'],
                                        ['🔍', 'Deep dive/expand'],
                                        ['📝', 'Summarize thread']
                                    ];

                                    for (const [emoji, description] of reactions) {
                                        try {
                                            await firstResponseMsg.react(emoji);
                                            await new Promise(resolve => setTimeout(resolve, 250));
                                        } catch (reactionError) {
                                            if (reactionError.code === 10014) {
                                                console.warn(`Emoji ${emoji} not available:`, {
                                                    description,
                                                    error: reactionError.message
                                                });
                                                continue;
                                            }
                                            if (reactionError.code === 30016) {
                                                console.warn('Rate limited while adding reactions, waiting...');
                                                await new Promise(resolve => setTimeout(resolve, 5000));
                                                try {
                                                    await firstResponseMsg.react(emoji);
                                                } catch (retryError) {
                                                    console.warn(`Failed to add ${description} reaction after retry:`, {
                                                        emoji,
                                                        error: retryError.message
                                                    });
                                                }
                                                continue;
                                            }
                                            console.warn(`Failed to add ${description} reaction:`, {
                                                emoji,
                                                error: reactionError.message
                                            });
                                        }
                                    }
                                } catch (error) {
                                    console.error('Error generating AI response:', {
                                        error: error.message || 'Unknown error',
                                        stack: error.stack || 'No stack trace available',
                                        requestId,
                                        channel: interaction.channel?.name || 'Unknown channel'
                                    });

                                    if (initialResponse) {
                                        await initialResponse.edit({
                                            content: "I apologize, but I encountered an error while analyzing the information. Please try again."
                                        }).catch(console.error);
                                    }

                                    const request = AISearchHandler.pendingRequests.get(requestId);
                                    if (request) {
                                        AISearchHandler.pendingRequests.delete(requestId);
                                    }

                                    interactionState.error = error;
                                }
                            }
                        }
                    }

                    if (action === 'deny') {
                        await AISearchHandler.handleSearchDenial(requestId, interaction)
                            .catch(error => {
                                console.error('Failed to handle search denial:', {
                                    error: error.message,
                                    requestId
                                });
                                interactionState.error = error;
                            });
                    }
                }
            }
        } catch (error) {
            console.error('Error in interaction handler:', {
                error: error.message || 'Unknown error',
                stack: error.stack || 'No stack trace available',
                interaction: {
                    type: interaction.type,
                    customId: interaction.customId,
                    user: interaction.user?.tag,
                    channel: interaction.channel?.name
                },
                state: interactionState
            });

            try {
                const errorMessage = '❌ An error occurred while processing your interaction.';
                
                if (!interactionState.replied) {
                    if (interactionState.deferred) {
                        await interaction.followUp({
                            content: errorMessage,
                            ephemeral: true,
                            allowedMentions: { users: [], roles: [] }
                        });
                    } else {
                        await interaction.reply({
                            content: errorMessage,
                            ephemeral: true,
                            allowedMentions: { users: [], roles: [] }
                        });
                    }
                    interactionState.replied = true;
                }
            } catch (replyError) {
                console.error('Failed to send error message:', {
                    error: replyError.message,
                    stack: replyError.stack,
                    originalError: error.message,
                    state: interactionState
                });
            }
        }
    }
}; 