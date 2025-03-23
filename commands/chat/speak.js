const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');
const BarkTTSService = require('../../services/voice/barkTTSService');
const { joinVoiceChannel, createAudioPlayer, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const config = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speak')
        .setDescription('Convert text to speech using Bark AI and play it in your voice channel')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('The text to convert to speech')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('voice')
                .setDescription('The voice style to use')
                .setRequired(false)
                .addChoices(
                    { name: '👨 Default Male', value: 'en_speaker_6' },
                    { name: '👩 Default Female', value: 'en_speaker_9' },
                    { name: '📢 Announcer', value: 'announcer' },
                    { name: '📚 Narrator', value: 'en_speaker_3' },
                    { name: '👶 Young', value: 'en_speaker_5' },
                    { name: '👴 Senior', value: 'en_speaker_7' },
                    // Multilingual voices
                    { name: '🇩🇪 German', value: 'de_speaker_1' },
                    { name: '🇯🇵 Japanese', value: 'ja_speaker_1' },
                    { name: '🇪🇸 Spanish', value: 'es_speaker_1' },
                    { name: '🇫🇷 French', value: 'fr_speaker_1' },
                    { name: '🇮🇳 Hindi', value: 'hi_speaker_1' },
                    { name: '🇮🇹 Italian', value: 'it_speaker_1' },
                    { name: '🇰🇷 Korean', value: 'ko_speaker_1' },
                    { name: '🇵🇱 Polish', value: 'pl_speaker_1' },
                    { name: '🇧🇷 Portuguese', value: 'pt_speaker_1' },
                    { name: '🇷🇺 Russian', value: 'ru_speaker_1' },
                    { name: '🇹🇷 Turkish', value: 'tr_speaker_1' },
                    { name: '🇨🇳 Chinese', value: 'zh_speaker_1' }
                ))
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
            const voiceOption = interaction.options.getString('voice') || 'en_speaker_6';
            const style = interaction.options.getString('style');
            const randomEffects = interaction.options.getBoolean('random_effects') || false;
            const emphasize = interaction.options.getBoolean('emphasize') || false;
            const hesitate = interaction.options.getBoolean('hesitate') || false;

            // Apply text modifications
            if (style) {
                messageText = BarkTTSService.applyStyle(messageText, style);
            }
            if (randomEffects) {
                messageText = BarkTTSService.addRandomEffects(messageText);
            }
            if (emphasize) {
                messageText = BarkTTSService.addEmphasis(messageText);
            }
            if (hesitate) {
                messageText = BarkTTSService.addHesitation(messageText);
            }

            // Create voice connection with proper error handling
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false
            });
            
            // Create player and subscribe the connection to it
            const player = createAudioPlayer();
            connection.subscribe(player);
            
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

            // Initialize Bark TTS service
            const barkTTS = new BarkTTSService(config);
            
            await interaction.editReply('🎙️ Generating speech with Bark AI...');
            
            // Add a feedback indicator for model booting status
            let bootingMessageSent = false;
            const statusUpdateInterval = setInterval(async () => {
                if (!bootingMessageSent && barkTTS.isModelBooting) {
                    await interaction.editReply('🔄 The text-to-speech model is booting up. This may take several minutes the first time...');
                    bootingMessageSent = true;
                }
            }, 10000); // Check every 10 seconds
            
            try {
                // Use Bark to generate and play speech
                await barkTTS.textToSpeech(messageText, voiceChannel, connection, voiceOption);
                
                clearInterval(statusUpdateInterval);
                await interaction.editReply('✨ Speech generation complete!');
            } catch (error) {
                clearInterval(statusUpdateInterval);
                throw error;
            }

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