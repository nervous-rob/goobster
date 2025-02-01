const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');
const VoiceService = require('../../services/voice');
const rateLimiter = require('../../utils/rateLimit');
const { handleChatInteraction } = require('../../utils/chatHandler');
const { VoiceConnectionStatus } = require('@discordjs/voice');
const config = require('../../config.json');

// Initialize voice service with proper error handling and config
const voiceService = new VoiceService(config);

// Set up error handling for voice service
voiceService.on('voiceError', async ({ userId, error }) => {
    console.error('Voice service error:', error);
    const session = voiceService.sessionManager.getSession(userId);
    if (session && session.interaction) {
        try {
            await session.interaction.followUp({
                content: 'An error occurred with the voice service. Please try again.',
                ephemeral: true
            });
        } catch (followUpError) {
            console.error('Error sending error followUp:', followUpError);
        }
    }
});

// Handle stream errors
voiceService.on('streamError', async ({ streamName, error, userId }) => {
    console.error(`Stream error in ${streamName}:`, error);
    const session = voiceService.sessionManager.getSession(userId);
    if (session && session.interaction) {
        try {
            await session.interaction.followUp({
                content: 'An error occurred with the audio stream. Please try again.',
                ephemeral: true
            });
        } catch (followUpError) {
            console.error('Error sending stream error followUp:', followUpError);
        }
    }
});

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
            await interaction.deferReply();

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                return await interaction.editReply('You need to be in a voice channel to use this command.');
            }

            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
                return await interaction.editReply('I need permissions to join and speak in your voice channel.');
            }

            const subcommand = interaction.options.getSubcommand();
            
            if (subcommand === 'stop') {
                if (!voiceService.sessionManager.isUserInSession(interaction.user.id)) {
                    return await interaction.editReply('You don\'t have an active voice session.');
                }

                try {
                    await voiceService.stopListening(interaction.user.id);
                    await interaction.editReply('Voice recognition stopped.');
                } catch (error) {
                    console.error('Error stopping voice recognition:', error);
                    await interaction.followUp({
                        content: 'Failed to stop voice recognition. The session will be forcefully cleaned up.',
                        ephemeral: true
                    });
                    // Force cleanup
                    voiceService.sessionManager.removeSession(interaction.user.id);
                }
                return;
            }

            // Check for existing session
            if (voiceService.sessionManager.isUserInSession(interaction.user.id)) {
                try {
                    // Attempt to clean up existing session
                    await voiceService.stopListening(interaction.user.id);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    console.error('Error cleaning up existing session:', error);
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

                // Start voice recognition with enhanced error handling
                const connection = await voiceService.startListening(
                    voiceChannel,
                    interaction.user,
                    async (text) => {
                        console.log('Received text from voice recognition:', text);
                        if (text.trim()) {
                            try {
                                pseudoInteraction.options = {
                                    getString: () => text
                                };
                                
                                const response = await handleChatInteraction(pseudoInteraction);
                                return response;
                            } catch (error) {
                                console.error('Error processing voice message:', error);
                                return 'I encountered an error processing your request. Please try again.';
                            }
                        }
                    }
                );

                // Store interaction reference for error handling
                voiceService.sessionManager.addSession(interaction.user.id, {
                    connection,
                    channelId: voiceChannel.id,
                    guildId: interaction.guildId,
                    interaction
                });

                await interaction.editReply('Voice recognition started! I\'m listening for your commands.');

                // Enhanced connection state handling
                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    console.log('Voice connection disconnected');
                    try {
                        await voiceService.stopListening(interaction.user.id);
                    } catch (error) {
                        console.error('Error during disconnect cleanup:', error);
                    }
                    await interaction.followUp({
                        content: 'Voice connection was disconnected.',
                        ephemeral: true
                    });
                });

                connection.on('error', async (error) => {
                    console.error('Voice connection error:', error);
                    try {
                        await voiceService.handleError(interaction.user.id, error);
                    } catch (handlingError) {
                        console.error('Error handling connection error:', handlingError);
                    }
                    await interaction.followUp({
                        content: 'Voice connection error occurred. Please try again.',
                        ephemeral: true
                    });
                });

            } catch (error) {
                console.error('Failed to start voice session:', error);
                try {
                    await voiceService.handleError(interaction.user.id, error);
                } catch (handlingError) {
                    console.error('Error handling session start error:', handlingError);
                }
                await interaction.editReply('Failed to start voice recognition. Please try again.');
            }
        } catch (error) {
            console.error('Error in voice command:', error);
            if (interaction.deferred) {
                await interaction.editReply('An error occurred while processing the voice command.');
            } else {
                await interaction.reply({
                    content: 'An error occurred while processing the voice command.',
                    ephemeral: true
                });
            }
        }
    }
}; 