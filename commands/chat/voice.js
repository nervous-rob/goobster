// TODO: Add proper handling for voice connection timeouts
// TODO: Add proper handling for voice recognition failures
// TODO: Add proper handling for voice session cleanup
// TODO: Add proper handling for voice quality monitoring
// TODO: Add proper handling for voice state transitions
// TODO: Add proper handling for voice permission validation
// TODO: Add proper handling for voice resource management
// TODO: Add proper handling for voice session persistence
// TODO: Add proper handling for voice error recovery
// TODO: Add proper handling for voice rate limiting

const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');
const rateLimiter = require('../../utils/rateLimit');
const { handleChatInteraction } = require('../../utils/chatHandler');
const { VoiceConnectionStatus } = require('@discordjs/voice');
const config = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Start or stop voice interaction with Goobster')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Start voice interaction'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('stop')
                .setDescription('Stop voice interaction'))
        .setDefaultMemberPermissions(null)
        .setDMPermission(false),

    async execute(interaction) {
        try {
            const voiceService = interaction.client.voiceService;
            if (!voiceService) {
                return await interaction.reply({
                    content: 'Voice service is not initialized. Please try again later.',
                    ephemeral: true
                });
            }

            await interaction.deferReply();

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                return await interaction.editReply('You need to be in a voice channel to use this command.');
            }

            // Add debug logging for permissions
            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            console.log('Voice channel permissions:', {
                channel: voiceChannel.name,
                hasConnect: permissions.has(PermissionFlagsBits.Connect),
                hasSpeak: permissions.has(PermissionFlagsBits.Speak),
                userId: interaction.user.id,
                timestamp: new Date().toISOString()
            });

            if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
                return await interaction.editReply('I need permissions to join and speak in your voice channel.');
            }

            const subcommand = interaction.options.getSubcommand();
            
            if (subcommand === 'stop') {
                if (!voiceService.sessionManager.isUserInSession(interaction.user.id)) {
                    return await interaction.editReply('You don\'t have an active voice session.');
                }

                try {
                    console.log('Stopping voice recognition for user:', {
                        userId: interaction.user.id,
                        timestamp: new Date().toISOString()
                    });
                    await voiceService.stopListening(interaction.user.id);
                    await interaction.editReply('Voice recognition stopped.');
                } catch (error) {
                    console.error('Error stopping voice recognition:', {
                        error: error.message,
                        userId: interaction.user.id,
                        stack: error.stack,
                        timestamp: new Date().toISOString()
                    });
                    await interaction.followUp({
                        content: 'Failed to stop voice recognition. The session will be forcefully cleaned up.',
                        ephemeral: true
                    });
                    voiceService.sessionManager.removeSession(interaction.user.id);
                }
                return;
            }

            // Check for existing session with debug logging
            if (voiceService.sessionManager.isUserInSession(interaction.user.id)) {
                console.log('Cleaning up existing session for user:', {
                    userId: interaction.user.id,
                    timestamp: new Date().toISOString()
                });
                try {
                    await voiceService.stopListening(interaction.user.id);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    console.error('Error cleaning up existing session:', {
                        error: error.message,
                        userId: interaction.user.id,
                        stack: error.stack,
                        timestamp: new Date().toISOString()
                    });
                    return await interaction.editReply('Failed to clean up existing session. Please try again in a few moments.');
                }
            }

            try {
                // Create pseudo-interaction for chat handling
                const pseudoInteraction = {
                    user: interaction.user,
                    guildId: interaction.guildId,
                    channel: interaction.channel,
                    client: interaction.client,
                    deferReply: async () => {},
                    editReply: async (response) => {
                        if (typeof response === 'string') {
                            return response;
                        }
                        return response.content;
                    },
                    reply: async (response) => {
                        if (typeof response === 'string') {
                            return response;
                        }
                        return response.content;
                    }
                };

                console.log('Starting voice recognition for user:', {
                    userId: interaction.user.id,
                    channelId: voiceChannel.id,
                    timestamp: new Date().toISOString()
                });

                // Start voice recognition with enhanced error handling and debug logging
                const connection = await voiceService.startListening(
                    voiceChannel,
                    interaction.user,
                    async (text) => {
                        console.log('Received text from voice recognition:', {
                            text,
                            userId: interaction.user.id,
                            timestamp: new Date().toISOString()
                        });
                        if (text.trim()) {
                            try {
                                pseudoInteraction.options = {
                                    getString: () => text
                                };
                                
                                const response = await handleChatInteraction(pseudoInteraction);
                                return response;
                            } catch (error) {
                                console.error('Error processing voice message:', {
                                    error: error.message,
                                    text,
                                    userId: interaction.user.id,
                                    stack: error.stack,
                                    timestamp: new Date().toISOString()
                                });
                                return 'I encountered an error processing your request. Please try again.';
                            }
                        }
                    }
                );

                // Set up event handlers for this connection
                voiceService.once('voiceError', async ({ userId, error }) => {
                    if (userId === interaction.user.id) {
                        console.error('Voice service error:', {
                            error: error.message,
                            userId,
                            stack: error.stack,
                            timestamp: new Date().toISOString()
                        });
                        await interaction.followUp({
                            content: 'An error occurred with the voice service. Please check your microphone settings and try again.',
                            ephemeral: true
                        }).catch(console.error);
                    }
                });

                voiceService.once('silenceWarning', async ({ userId, duration }) => {
                    if (userId === interaction.user.id) {
                        await interaction.followUp({
                            content: 'I haven\'t heard anything for 20 seconds. Voice recognition will stop after 40 seconds of silence. Please speak if you want to continue.',
                            ephemeral: true
                        }).catch(console.error);
                    }
                });

                voiceService.once('voiceStart', async ({ userId }) => {
                    if (userId === interaction.user.id) {
                        await interaction.followUp({
                            content: 'I hear you speaking! Processing your voice...',
                            ephemeral: true
                        }).catch(console.error);
                    }
                });

                // Store interaction reference with debug logging
                voiceService.sessionManager.addSession(interaction.user.id, {
                    connection,
                    channelId: voiceChannel.id,
                    guildId: interaction.guildId,
                    interaction
                });

                console.log('Voice session created:', {
                    userId: interaction.user.id,
                    channelId: voiceChannel.id,
                    timestamp: new Date().toISOString()
                });

                await interaction.editReply(
                    'Voice recognition started! I\'m listening for your commands.\n' +
                    'Please speak clearly and check that your microphone is working properly.\n' +
                    'I will warn you after 20 seconds of silence and stop after 40 seconds of no audio.\n' +
                    'You\'ll receive notifications when I detect your voice and process your commands.'
                );

                // Enhanced connection state handling with debug logging
                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    console.log('Voice connection disconnected:', {
                        userId: interaction.user.id,
                        timestamp: new Date().toISOString()
                    });
                    try {
                        await voiceService.stopListening(interaction.user.id);
                    } catch (error) {
                        console.error('Error during disconnect cleanup:', {
                            error: error.message,
                            userId: interaction.user.id,
                            stack: error.stack,
                            timestamp: new Date().toISOString()
                        });
                    }
                    await interaction.followUp({
                        content: 'Voice connection was disconnected. Please try the command again if you want to continue.',
                        ephemeral: true
                    }).catch(console.error);
                });

                connection.on(VoiceConnectionStatus.Destroyed, async () => {
                    console.log('Voice connection destroyed:', {
                        userId: interaction.user.id,
                        timestamp: new Date().toISOString()
                    });
                    try {
                        await voiceService.stopListening(interaction.user.id);
                    } catch (error) {
                        console.error('Error during destroy cleanup:', {
                            error: error.message,
                            userId: interaction.user.id,
                            stack: error.stack,
                            timestamp: new Date().toISOString()
                        });
                    }
                });

                // Add error handling for the connection
                connection.on('error', async (error) => {
                    console.error('Voice connection error:', {
                        error: error.message,
                        userId: interaction.user.id,
                        stack: error.stack,
                        timestamp: new Date().toISOString()
                    });
                    try {
                        await voiceService.handleError(interaction.user.id, error);
                    } catch (handlingError) {
                        console.error('Error handling connection error:', handlingError);
                    }
                    await interaction.followUp({
                        content: 'Voice connection error occurred. Please check your microphone settings and try again.',
                        ephemeral: true
                    }).catch(console.error);
                });

            } catch (error) {
                console.error('Failed to start voice session:', {
                    error: error.message,
                    userId: interaction.user.id,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
                try {
                    await voiceService.handleError(interaction.user.id, error);
                } catch (handlingError) {
                    console.error('Error handling session start error:', handlingError);
                }
                await interaction.editReply('Failed to start voice recognition. Please check your microphone settings and try again.');
            }
        } catch (error) {
            console.error('Error in voice command:', {
                error: error.message,
                userId: interaction.user.id,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            if (interaction.deferred) {
                await interaction.editReply('An error occurred while processing the voice command. Please check your microphone settings and try again.');
            } else {
                await interaction.reply({
                    content: 'An error occurred while processing the voice command. Please check your microphone settings and try again.',
                    ephemeral: true
                });
            }
        }
    }
}; 