const AISearchHandler = require('../utils/aiSearchHandler');
const perplexityService = require('../services/perplexityService');
const { OpenAI } = require('openai');
const config = require('../config.json');
const { chunkMessage } = require('../utils');

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
                        // Continue execution as the interaction might still be valid
                    }

                    if (action === 'approve') {
                        const result = await AISearchHandler.handleSearchApproval(requestId, interaction);
                        if (result) {
                            // Get the original conversation context
                            const messages = await interaction.channel.messages.fetch({ limit: 10 });
                            const originalQuestion = messages.find(m => 
                                !m.author.bot && 
                                (m.content.toLowerCase().includes('search') || 
                                 m.content.toLowerCase().includes('look up'))
                            );

                            if (originalQuestion) {
                                // Create a follow-up response using the search results
                                const initialResponse = await interaction.channel.send({
                                    content: "Now that I have the information, let me analyze it and provide a detailed response! 🤔"
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
                                    // Prepare context for the AI response
                                    const context = [
                                        { role: 'user', content: originalQuestion.content },
                                        { role: 'assistant', content: `I found this information: ${result.result}` },
                                        { role: 'user', content: 'Please analyze this information and provide a detailed, helpful response.' }
                                    ];

                                    // Generate AI response with the search results
                                    const completion = await openai.chat.completions.create({
                                        messages: context,
                                        model: "gpt-4o",
                                        temperature: 0.7,
                                        max_tokens: 500
                                    });

                                    // Get the response content
                                    const responseContent = completion.choices[0].message.content;

                                    // Split response into chunks if needed
                                    const chunks = chunkMessage(responseContent);
                                    
                                    // Send each chunk as a separate message
                                    let firstResponseMsg = null;
                                    for (let i = 0; i < chunks.length; i++) {
                                        const chunk = chunks[i];
                                        if (i === 0) {
                                            // Edit the initial message for the first chunk
                                            firstResponseMsg = await initialResponse.edit({
                                                content: chunk
                                            });
                                        } else {
                                            // Send additional chunks as new messages
                                            await interaction.channel.send({
                                                content: chunk
                                            });
                                        }
                                    }

                                    // Add reactions to the first message
                                    if (firstResponseMsg) {
                                        try {
                                            const reactions = [
                                                ['🔄', 'Regenerate'],
                                                ['📌', 'Pin important messages'],
                                                ['🌳', 'Branch conversation'],
                                                ['💡', 'Mark as solution'],
                                                ['🔍', 'Deep dive/expand'],
                                                ['📝', 'Summarize thread']
                                            ];

                                            // Add reactions with delay to avoid rate limits
                                            for (const [emoji, description] of reactions) {
                                                try {
                                                    await firstResponseMsg.react(emoji);
                                                    // Add a 250ms delay between reactions
                                                    await new Promise(resolve => setTimeout(resolve, 250));
                                                } catch (reactionError) {
                                                    if (reactionError.code === 10014) { // Unknown Emoji
                                                        console.warn(`Emoji ${emoji} not available:`, {
                                                            description,
                                                            error: reactionError.message
                                                        });
                                                        continue;
                                                    }
                                                    if (reactionError.code === 30016) { // Rate limited
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
                                            console.error('Error adding reactions:', {
                                                error: error.message || 'Unknown error',
                                                stack: error.stack || 'No stack trace available',
                                                messageId: firstResponseMsg.id
                                            });
                                            // Continue execution even if reactions fail
                                        }
                                    }
                                } catch (error) {
                                    console.error('Error generating AI response:', {
                                        error: error.message || 'Unknown error',
                                        stack: error.stack || 'No stack trace available',
                                        requestId,
                                        channel: interaction.channel?.name || 'Unknown channel'
                                    });

                                    // Try to edit the initial response, if it exists
                                    if (initialResponse) {
                                        await initialResponse.edit({
                                            content: "I apologize, but I encountered an error while analyzing the information. Please try again."
                                        }).catch(console.error);
                                    }

                                    // Set error state for proper handling in catch block
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
                
                // Handle error response based on interaction state
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