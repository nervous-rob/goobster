const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');
const speechStyles = require('../../utils/speechStyles');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { voiceService } = require('../../services/serviceManager');
const config = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak')
        .setDescription('Speak text aloud in your voice channel (ElevenLabs)')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('The text to convert to speech')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('voice')
                .setDescription('The voice style to use')
                .setRequired(false)
                .setAutocomplete(false))
        .addStringOption(option =>
            option.setName('style')
                .setDescription('Special voice style or effect')
                .setRequired(false)
                .addChoices(
                    { name: '🎵 Sing', value: 'sing' },
                    { name: '😄 Happy', value: 'happy' },
                    { name: '😢 Sad', value: 'sad' },
                    { name: '😠 Angry', value: 'angry' },
                    { name: '🤔 Thinking', value: 'thinking' },
                    { name: '🎭 Dramatic', value: 'dramatic' },
                    { name: '🎬 Movie Trailer', value: 'movie_trailer' },
                    { name: '📻 Radio Host', value: 'radio_host' },
                    { name: '🎮 Game Announcer', value: 'game_announcer' },
                    { name: '🌟 Enthusiastic', value: 'enthusiastic' },
                    { name: '🤫 Whisper', value: 'whisper' },
                    { name: '🎪 Circus', value: 'circus' }
                ))
        .addBooleanOption(option =>
            option.setName('random_effects')
                .setDescription('Add random sound effects and emotions')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('emphasize')
                .setDescription('CAPITALIZE random words for emphasis')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('hesitate')
                .setDescription('Add hesitation marks (...) randomly')
                .setRequired(false))
        .setDefaultMemberPermissions(null)
        .setDMPermission(false),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            // Check if user is in a voice channel
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                return await interaction.editReply('You need to be in a voice channel to use this command.');
            }

            // Check bot permissions
            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
                return await interaction.editReply('I need permissions to join and speak in your voice channel.');
            }

            // Get command options
            let messageText = interaction.options.getString('message');
            const voiceOption = interaction.options.getString('voice') || config.elevenlabs?.voiceId || 'Rachel';
            const style = interaction.options.getString('style');
            const randomEffects = interaction.options.getBoolean('random_effects') || false;
            const emphasize = interaction.options.getBoolean('emphasize') || false;
            const hesitate = interaction.options.getBoolean('hesitate') || false;

            // Apply text modifications
            if (style) {
                messageText = speechStyles.applyStyle(messageText, style);
            }
            if (randomEffects) {
                messageText = speechStyles.addRandomEffects(messageText);
            }
            if (emphasize) {
                messageText = speechStyles.addEmphasis(messageText);
            }
            if (hesitate) {
                messageText = speechStyles.addHesitation(messageText);
            }

            // Create voice connection with proper error handling
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false
            });

            // Ensure connection is ready before streaming audio
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
            } catch {
                return await interaction.editReply('❌ Failed to establish voice connection.');
            }
            
            // No local player; ElevenLabs service will handle subscription
            
            // Add error handling for the connection
            connection.on('error', (error) => {
                console.error('Voice connection error:', error);
            });
            
            // Add state change handling for connection
            connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
                try {
                    // Try to reconnect if disconnected
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                    // Connection is reconnecting
                } catch (error) {
                    // Connection is not reconnecting, destroy and cleanup
                    connection.destroy();
                }
            });

            // Ensure voice service is initialised
            if (!voiceService._isInitialized) {
                await voiceService.initialize();
            }

            const ttsEngine = voiceService.tts;
            if (!ttsEngine || ttsEngine.disabled) {
                return await interaction.editReply('❌ Text-to-speech engine is not configured.');
            }

            // Allow users to override voice when ElevenLabs is the active engine
            try {
                const ElevenLabsTTSService = require('../../services/voice/elevenLabsTTSService');
                if (ttsEngine instanceof ElevenLabsTTSService && voiceOption) {
                    ttsEngine.voiceId = voiceOption;
                }
            } catch {}

            await interaction.editReply('🎙️ Generating speech...');

            await ttsEngine.textToSpeech(messageText, voiceChannel, connection);
            await interaction.editReply('✨ Speech generated!');

        } catch (error) {
            console.error('Error in speak command:', error);
            
            let errorMessage = '❌ Failed to speak the message. ';
            
            if (error.message.includes('Authentication failed')) {
                errorMessage += 'There seems to be an issue with the API configuration. Please contact the bot administrator.';
            } else if (error.message.includes('Rate limit')) {
                errorMessage += 'The service is currently busy. Please try again in a few minutes.';
            } else if (error.message.includes('No audio output')) {
                errorMessage += 'Failed to generate audio. Please try again with different text or settings.';
            } else {
                errorMessage += 'An unexpected error occurred. Please try again later.';
            }
            
            if (interaction.deferred) {
                await interaction.editReply(errorMessage);
            } else {
                await interaction.reply({
                    content: errorMessage,
                    ephemeral: true
                });
            }
        }
    }
}; 