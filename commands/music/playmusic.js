const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const MusicService = require('../../services/voice/musicService');
const config = require('../../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playmusic')
        .setDescription('Play background music with a specific mood')
        .addStringOption(option =>
            option.setName('mood')
                .setDescription('The mood of the music to play')
                .setRequired(true)
                .addChoices(
                    { name: 'Battle', value: 'battle' },
                    { name: 'Exploration', value: 'exploration' },
                    { name: 'Mystery', value: 'mystery' },
                    { name: 'Celebration', value: 'celebration' },
                    { name: 'Danger', value: 'danger' },
                    { name: 'Peaceful', value: 'peaceful' },
                    { name: 'Sad', value: 'sad' },
                    { name: 'Dramatic', value: 'dramatic' }
                ))
        .addBooleanOption(option =>
            option.setName('loop')
                .setDescription('Whether to loop the music continuously')
                .setRequired(false)),

    async execute(interaction) {
        let connection = null;
        let musicService = null;
        
        try {
            await interaction.deferReply();

            // Check if user is in a voice channel
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.editReply('You need to be in a voice channel to play music!');
                return;
            }

            // Check bot permissions
            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has('Connect') || !permissions.has('Speak')) {
                await interaction.editReply('I need permissions to join and speak in your voice channel!');
                return;
            }

            // Initialize music service
            musicService = new MusicService(config);

            // Create voice connection with debug logging
            console.log('Creating voice connection for channel:', voiceChannel.id);
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false
            });

            // Set up connection state monitoring with enhanced logging
            connection.on(VoiceConnectionStatus.Connecting, () => {
                console.log('Voice Connection Status: Connecting', {
                    channelId: connection.joinConfig.channelId,
                    guildId: connection.joinConfig.guildId
                });
            });

            connection.on(VoiceConnectionStatus.Ready, () => {
                console.log('Voice Connection Status: Ready', {
                    channelId: connection.joinConfig.channelId,
                    guildId: connection.joinConfig.guildId,
                    ping: connection.ping
                });
            });

            connection.on(VoiceConnectionStatus.Signalling, () => {
                console.log('Voice Connection Status: Signalling', {
                    channelId: connection.joinConfig.channelId,
                    guildId: connection.joinConfig.guildId
                });
            });

            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                console.log('Voice Connection Status: Disconnected', {
                    channelId: connection.joinConfig.channelId,
                    guildId: connection.joinConfig.guildId,
                    state: connection.state
                });
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                    console.log('Attempting to reconnect...');
                } catch (error) {
                    console.log('Destroying connection due to disconnect');
                    if (connection) {
                        connection.destroy();
                    }
                    if (musicService) {
                        musicService.stopMusic();
                    }
                }
            });

            // Add error handler for connection
            connection.on('error', (error) => {
                console.error('Voice connection error:', error);
                cleanup();
            });

            // Handle command interruption
            const cleanup = () => {
                console.log('Cleaning up music resources');
                if (musicService) {
                    musicService.stopMusic();
                }
                if (connection) {
                    connection.destroy();
                }
            };

            // Add cleanup handlers
            process.once('SIGINT', cleanup);
            process.once('SIGTERM', cleanup);

            try {
                console.log('Waiting for connection to be ready...');
                // Wait for connection to be ready
                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                console.log('Connection is ready');

                // Get the selected mood and loop option
                const mood = interaction.options.getString('mood');
                const shouldLoop = interaction.options.getBoolean('loop') ?? false;

                await interaction.editReply(`🎵 Loading ${mood} music${shouldLoop ? ' (looping enabled)' : ''}...`);

                // Check if music exists in cache
                const exists = await musicService.doesMoodMusicExist(mood);
                if (!exists) {
                    await interaction.editReply(`🎵 Generating ${mood} music for the first time... This may take a few minutes.`);
                }

                // Play the music (it will be generated and cached if it doesn't exist)
                console.log('Starting music playback:', { mood, shouldLoop });
                const player = await musicService.playBackgroundMusic(mood, connection, shouldLoop);

                if (player) {
                    console.log('Music playback started successfully');
                    await interaction.editReply(
                        `🎵 Now playing ${mood} music${shouldLoop ? ' (looping enabled)' : ''}! ` +
                        `Use \`/stopmusic\` to stop.`
                    );

                    // Remove cleanup handlers if successful
                    process.off('SIGINT', cleanup);
                    process.off('SIGTERM', cleanup);
                } else {
                    console.error('Failed to get player from musicService');
                    await interaction.editReply('Failed to play music. Please try again.');
                    cleanup();
                }
            } catch (error) {
                console.error('Error in music playback:', error);
                await interaction.editReply('Failed to generate or play music. Please try again.');
                cleanup();
            }
        } catch (error) {
            console.error('Error in playmusic command:', error);
            try {
                await interaction.editReply('An error occurred while executing the command.');
            } catch (replyError) {
                console.error('Failed to send error message:', replyError);
            }
            // Ensure cleanup happens even on command error
            if (musicService || connection) {
                console.log('Cleaning up after command error');
                if (musicService) {
                    musicService.stopMusic();
                }
                if (connection) {
                    connection.destroy();
                }
            }
        }
    },
}; 