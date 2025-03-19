const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const MusicService = require('../../services/voice/musicService');
const config = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playmusic')
        .setDescription('Play background music with a specific mood')
        .addStringOption(option =>
            option.setName('mood')
                .setDescription('The mood of the music to play')
                .setRequired(true)
                .addChoices(
                    { name: '⚔️ Battle', value: 'battle' },
                    { name: '🌄 Exploration', value: 'exploration' },
                    { name: '🔍 Mystery', value: 'mystery' },
                    { name: '🎉 Celebration', value: 'celebration' },
                    { name: '⚠️ Danger', value: 'danger' },
                    { name: '🌿 Peaceful', value: 'peaceful' },
                    { name: '😢 Sad', value: 'sad' },
                    { name: '🎭 Dramatic', value: 'dramatic' }
                ))
        .addBooleanOption(option =>
            option.setName('loop')
                .setDescription('Whether to loop the music continuously')
                .setRequired(false))
        .addNumberOption(option => 
            option.setName('volume')
                .setDescription('Set the volume (0.1-1.0)')
                .setMinValue(0.1)
                .setMaxValue(1.0)
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('regenerate')
                .setDescription('Regenerate the music even if it exists in cache')
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

            // Get options
            const mood = interaction.options.getString('mood');
            const shouldLoop = interaction.options.getBoolean('loop') ?? false;
            const volume = interaction.options.getNumber('volume') ?? config.audio.music.volume;
            const regenerate = interaction.options.getBoolean('regenerate') ?? false;
            
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

                // Get the mood emoji
                const moodEmojis = {
                    'battle': '⚔️',
                    'exploration': '🌄',
                    'mystery': '🔍',
                    'celebration': '🎉',
                    'danger': '⚠️',
                    'peaceful': '🌿',
                    'sad': '😢',
                    'dramatic': '🎭'
                };
                const moodEmoji = moodEmojis[mood] || '🎵';

                await interaction.editReply(`${moodEmoji} Loading ${mood} music${shouldLoop ? ' (looping enabled)' : ''}... Volume: ${Math.round(volume * 100)}%`);

                // Check if music exists in cache
                const exists = await musicService.doesMoodMusicExist(mood);
                
                if (!exists || regenerate) {
                    await interaction.editReply(`${moodEmoji} ${regenerate ? 'Regenerating' : 'Generating'} ${mood} music... This may take a few minutes.`);
                    if (regenerate && exists) {
                        await musicService.generateAndCacheMoodMusic(mood, true);
                    }
                }

                // Play the music (it will be generated and cached if it doesn't exist)
                console.log('Starting music playback:', { mood, shouldLoop, volume });
                const player = await musicService.playBackgroundMusic(mood, connection, shouldLoop);
                
                // Set volume if specified
                if (volume !== config.audio.music.volume) {
                    await musicService.setVolume(volume);
                }

                if (player) {
                    console.log('Music playback started successfully');
                    await interaction.editReply(
                        `${moodEmoji} Now playing **${mood}** music!\n` +
                        `• Volume: ${Math.round(volume * 100)}%\n` +
                        `• Looping: ${shouldLoop ? 'Enabled' : 'Disabled'}\n` +
                        `• Status: ${regenerate ? 'Newly Generated' : (exists ? 'From Cache' : 'Newly Generated')}\n\n` +
                        `Use \`/stopmusic\` to stop playback.`
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