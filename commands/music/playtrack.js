const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionFlagsBits } = require('discord.js');
const SpotDLService = require('../../services/spotdl/spotdlService');
// const VoiceService = require('../../services/voice'); // Removed direct import
const { voiceService } = require('../../services/serviceManager'); // Import shared instance
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { filterTracks, createTrackListUI } = require('../../utils/musicUtils');
const config = require('../../config.json');

const spotdlService = new SpotDLService();
// const voiceService = new VoiceService(config); // Removed local instance

// Helper function to parse track names
function parseTrackName(filename) {
    if (!filename) return { artist: 'Unknown Artist', title: 'Unknown Track' };
    
    // Remove file extension and timestamp prefix if present
    const nameWithoutExt = filename.replace(/^\d+-/, '').replace(/\.(mp3|m4a|wav)$/i, '');
    
    // Split by the first occurrence of " - "
    const parts = nameWithoutExt.split(/ - (.+)/);
    
    if (parts.length === 1) {
        // If no separator found, return the whole name as title
        return { artist: 'Unknown Artist', title: nameWithoutExt };
    }
    
    return {
        artist: parts[0].trim(),
        title: parts[1].trim()
    };
}

// Helper function to format track name for display
function formatTrackName(track) {
    const { artist, title } = parseTrackName(track.name);
    return `${title}\n   by ${artist}`;
}

// Helper function to check if a user is in the same voice channel as the bot
function isUserInBotVoiceChannel(interaction) {
    const botVoiceChannel = interaction.guild.members.me.voice.channel;
    if (!botVoiceChannel) return false;
    
    const userVoiceChannel = interaction.member.voice.channel;
    if (!userVoiceChannel) return false;
    
    return botVoiceChannel.id === userVoiceChannel.id;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playtrack')
        .setDescription('Play and manage music tracks')
        .addSubcommand(subcommand =>
            subcommand
                .setName('play')
                .setDescription('Play a track or add it to the queue')
                .addStringOption(option =>
                    option.setName('track')
                        .setDescription('Name of the track to play/queue (artist - title)')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all available tracks'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('queue')
                .setDescription('Show the current queue'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('skip')
                .setDescription('Skip the current track'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('pause')
                .setDescription('Pause the current track'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('resume')
                .setDescription('Resume the current track'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('stop')
                .setDescription('Stop playback and clear the queue'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('volume')
                .setDescription('Adjust the volume')
                .addIntegerOption(option =>
                    option.setName('level')
                        .setDescription('Volume level (0-100)')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(100)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('playlist_create')
                .setDescription('Create a new empty playlist')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('The name for the new playlist')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('playlist_add')
                .setDescription('Add a track to a playlist')
                .addStringOption(option =>
                    option.setName('playlist_name')
                        .setDescription('The name of the playlist')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('track')
                        .setDescription('Name of the track to add (search query)')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('playlist_play')
                .setDescription('Play a specific playlist')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('The name of the playlist to play')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('playlist_list')
                .setDescription('List all your saved playlists'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('playlist_delete')
                .setDescription('Delete a playlist')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('The name of the playlist to delete')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('play_all')
                .setDescription('Play all available tracks in order'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('shuffle_all')
                .setDescription('Play all available tracks in shuffle mode'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('playlist_create_from_search')
                .setDescription('Create a new playlist from track search results')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('The name for the new playlist')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('search_query')
                        .setDescription('The search query for tracks to include')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            await interaction.deferReply();

            // Check if user is in a voice channel for relevant commands
            if (['play', 'pause', 'resume', 'skip', 'stop', 'volume'].includes(subcommand)) {
                const voiceChannel = interaction.member.voice.channel;
                if (!voiceChannel) {
                    await interaction.editReply('❌ You need to be in a voice channel to use this command!');
                    return;
                }

                // For commands other than 'play', check if user is in the same channel as the bot
                if (subcommand !== 'play' && !isUserInBotVoiceChannel(interaction)) {
                    await interaction.editReply('❌ You need to be in the same voice channel as the bot to control music.');
                    return;
                }

                // Check bot permissions
                const permissions = voiceChannel.permissionsFor(interaction.client.user);
                if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
                    await interaction.editReply('❌ I need permissions to join and speak in your voice channel.');
                    return;
                }
            }

            // Initialize voice service if not already initialized
            if (!voiceService._isInitialized) {
                await voiceService.initialize();
            }

            switch (subcommand) {
                case 'play': {
                    const searchQuery = interaction.options.getString('track');
                    
                    // Show loading message
                    await interaction.editReply('🎵 Searching for track...');
                    
                    try {
                        const tracks = await spotdlService.listTracks();
                        // Use filterTracks and take the first result
                        const matchingTracks = filterTracks(tracks, searchQuery);
                        
                        if (matchingTracks.length === 0) {
                            await interaction.editReply('❌ Track not found. Use `/playtrack list` to see available tracks.');
                            return;
                        }
                        
                        // Select the first match
                        const track = matchingTracks[0]; 

                        // Get the playable URL first
                        const trackUrl = await spotdlService.getTrackUrl(track.name);
                        // Add the URL to the track object
                        const playableTrack = { ...track, url: trackUrl }; 
                        
                        if (!voiceService.musicService) {
                            await interaction.editReply('Music service is not initialized. Please try again later.');
                            return;
                        }

                        const { artist, title } = parseTrackName(track.name);

                        // Check if already playing - if so, queue instead of playing immediately
                        if (voiceService.musicService.isPlaying) {
                            // Pass the full track object (without url) to the queue
                            const queued = await voiceService.musicService.addToQueue(track); 
                            if (queued) {
                                await interaction.editReply(`✅ Queued: **${title}** by ${artist}`);
                            } else {
                                await interaction.editReply(`❌ Failed to queue: **${title}** by ${artist}`);
                            }
                            return; // Don't continue to play logic
                        }

                        // If not playing, join channel and play immediately
                        try {
                            await voiceService.musicService.joinChannel(interaction.member.voice.channel);
                            // Pass the full playableTrack object to playAudio
                            await voiceService.musicService.playAudio(playableTrack); 
                        } catch (joinPlayError) {
                            console.error('Error joining channel or playing audio:', joinPlayError);
                            await interaction.editReply(`❌ Error starting playback: ${joinPlayError.message}`);
                            return;
                        }

                        const embed = new EmbedBuilder()
                            .setColor('#00ff00')
                            .setTitle('Now Playing')
                            .setDescription(`🎵 ${title}\n   by ${artist}`)
                            .addFields(
                                { name: 'Status', value: '▶️ Playing', inline: true },
                                { name: 'Volume', value: `${voiceService.musicService.getVolume()}%`, inline: true }
                            )
                            .setTimestamp();

                        // Add playback controls
                        const row = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('pause')
                                    .setLabel('Pause')
                                    .setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder()
                                    .setCustomId('skip')
                                    .setLabel('Skip')
                                    .setStyle(ButtonStyle.Primary),
                                new ButtonBuilder()
                                    .setCustomId('stop')
                                    .setLabel('Stop')
                                    .setStyle(ButtonStyle.Danger)
                            );

                        const message = await interaction.editReply({ embeds: [embed], components: [row] });

                        // Create button collector
                        const collector = message.createMessageComponentCollector({ time: 300000 }); // 5 minutes

                        collector.on('collect', async (i) => {
                            // Check if the user is in the same voice channel as the bot
                            if (!isUserInBotVoiceChannel(i)) {
                                return i.reply({ 
                                    content: '❌ You need to be in the same voice channel as the bot to control music.',
                                    ephemeral: true 
                                });
                            }

                            switch (i.customId) {
                                case 'pause':
                                    await voiceService.musicService.pause();
                                    embed.setFields(
                                        { name: 'Status', value: '⏸️ Paused', inline: true },
                                        { name: 'Volume', value: `${voiceService.musicService.getVolume()}%`, inline: true }
                                    );
                                    row.components[0].setLabel('Resume').setCustomId('resume');
                                    break;
                                case 'resume':
                                    await voiceService.musicService.resume();
                                    embed.setFields(
                                        { name: 'Status', value: '▶️ Playing', inline: true },
                                        { name: 'Volume', value: `${voiceService.musicService.getVolume()}%`, inline: true }
                                    );
                                    row.components[0].setLabel('Pause').setCustomId('pause');
                                    break;
                                case 'skip':
                                    await voiceService.musicService.skip();
                                    embed.setFields(
                                        { name: 'Status', value: '⏭️ Skipped', inline: true },
                                        { name: 'Volume', value: `${voiceService.musicService.getVolume()}%`, inline: true }
                                    );
                                    break;
                                case 'stop':
                                    await voiceService.musicService.stop();
                                    embed.setFields(
                                        { name: 'Status', value: '⏹️ Stopped', inline: true },
                                        { name: 'Volume', value: `${voiceService.musicService.getVolume()}%`, inline: true }
                                    );
                                    break;
                            }

                            await i.update({ embeds: [embed], components: [row] });
                        });

                        collector.on('end', () => {
                            row.components.forEach(button => button.setDisabled(true));
                            interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {});
                        });
                    } catch (error) {
                        if (error.message.includes('rate limit')) {
                            await interaction.editReply('⚠️ Rate limit reached. Please try again in a few minutes.');
                            return;
                        }
                        throw error;
                    }
                    break;
                }

                case 'list': {
                    await interaction.editReply('📋 Loading available tracks...');
                    const tracks = await spotdlService.listTracks();
                    await createTrackListUI(interaction, tracks, 'Available Tracks');
                    break;
                }

                case 'queue': {
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized. Please try again later.');
                        return;
                    }

                    const queue = voiceService.musicService.getQueue();
                    await createTrackListUI(interaction, queue, 'Music Queue');
                    break;
                }

                case 'skip': {
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized. Please try again later.');
                        return;
                    }
                    await voiceService.musicService.skip();
                    await interaction.editReply('⏭️ Skipped current track');
                    break;
                }

                case 'pause': {
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized. Please try again later.');
                        return;
                    }
                    await voiceService.musicService.pause();
                    await interaction.editReply('⏸️ Paused playback');
                    break;
                }

                case 'resume': {
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized. Please try again later.');
                        return;
                    }
                    await voiceService.musicService.resume();
                    await interaction.editReply('▶️ Resumed playback');
                    break;
                }

                case 'stop': {
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized. Please try again later.');
                        return;
                    }
                    await voiceService.musicService.stop();
                    await interaction.editReply('⏹️ Stopped playback and cleared queue');
                    break;
                }

                case 'volume': {
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized. Please try again later.');
                        return;
                    }
                    const level = interaction.options.getInteger('level');
                    await voiceService.musicService.setVolume(level);
                    await interaction.editReply(`🔊 Volume set to ${level}%`);
                    break;
                }

                case 'playlist_create': {
                    const playlistName = interaction.options.getString('name');
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized.');
                        return;
                    }
                    try {
                        await voiceService.musicService.createPlaylist(interaction.guildId, playlistName);
                        await interaction.editReply(`✅ Playlist \'${playlistName}\' created successfully.`);
                    } catch (error) {
                        console.error('Error creating playlist:', error);
                        await interaction.editReply(`❌ Error creating playlist: ${error.message}`);
                    }
                    break;
                }

                case 'playlist_add': {
                    const playlistName = interaction.options.getString('playlist_name');
                    const searchQuery = interaction.options.getString('track');
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized.');
                        return;
                    }
                    await interaction.editReply(`🔍 Searching for track '${searchQuery}' to add to playlist '${playlistName}'...`);
                    try {
                        const tracks = await spotdlService.listTracks();
                        // Use filterTracks and take the first result
                        const matchingTracks = filterTracks(tracks, searchQuery);
                        
                        if (matchingTracks.length === 0) {
                            await interaction.editReply(`❌ Track not found matching '${searchQuery}'.`);
                            return;
                        }
                        
                        // Select the first match
                        const track = matchingTracks[0]; 
                        
                        await voiceService.musicService.addToPlaylist(interaction.guildId, playlistName, track);
                        const { title, artist } = parseTrackName(track.name);
                        await interaction.editReply(`✅ Added **${title}** by ${artist} to playlist '${playlistName}'.`);
                    } catch (error) {
                        console.error('Error adding to playlist:', error);
                        await interaction.editReply(`❌ Error adding to playlist: ${error.message}`);
                    }
                    break;
                }

                case 'playlist_play': {
                    const playlistName = interaction.options.getString('name');
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized.');
                        return;
                    }
                    await interaction.editReply(`🎵 Attempting to play playlist '${playlistName}'...`);
                    try {
                        await voiceService.musicService.joinChannel(interaction.member.voice.channel);
                        await voiceService.musicService.playPlaylist(interaction.guildId, playlistName);
                        // Initial reply is handled by playPlaylist/playNextTrack internally or subsequent events
                        // We can just confirm the action started
                         await interaction.editReply(`▶️ Started playing playlist '${playlistName}'.`);
                    } catch (error) {
                        console.error('Error playing playlist:', error);
                        await interaction.editReply(`❌ Error playing playlist '${playlistName}': ${error.message}`);
                    }
                    break;
                }

                case 'playlist_list': {
                     if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized.');
                        return;
                    }
                    await interaction.editReply('📋 Loading playlists...');
                    try {
                        const playlists = await voiceService.musicService.listPlaylists(interaction.guildId);
                        if (!playlists || playlists.length === 0) {
                             await interaction.editReply('You have no saved playlists.');
                             return;
                        }
                        const embed = new EmbedBuilder()
                            .setColor('#0099ff')
                            .setTitle('Saved Playlists')
                            .setDescription(playlists.map((name, index) => `${index + 1}. ${name}`).join('\n'))
                            .setTimestamp();
                        await interaction.editReply({ embeds: [embed] });
                    } catch (error) {
                        console.error('Error listing playlists:', error);
                        await interaction.editReply(`❌ Error listing playlists: ${error.message}`);
                    }
                    break;
                }

                case 'playlist_delete': {
                    const playlistName = interaction.options.getString('name');
                     if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized.');
                        return;
                    }
                    await interaction.editReply(`🗑️ Attempting to delete playlist '${playlistName}'...`);
                    try {
                        await voiceService.musicService.deletePlaylist(interaction.guildId, playlistName);
                        await interaction.editReply(`✅ Playlist '${playlistName}' deleted successfully.`);
                    } catch (error) {
                        console.error('Error deleting playlist:', error);
                        await interaction.editReply(`❌ Error deleting playlist '${playlistName}': ${error.message}`);
                    }
                    break;
                }

                case 'play_all': {
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized.');
                        return;
                    }
                     await interaction.editReply(`🎵 Attempting to play all tracks...`);
                    try {
                        await voiceService.musicService.joinChannel(interaction.member.voice.channel);
                        const result = await voiceService.musicService.playAllTracks();
                        await interaction.editReply(`▶️ Playing all ${result.totalTracks} tracks. Now playing: **${result.currentTrack.title}** by ${result.currentTrack.artist}`);
                    } catch (error) {
                        console.error('Error playing all tracks:', error);
                        await interaction.editReply(`❌ Error playing all tracks: ${error.message}`);
                    }
                    break;
                }

                 case 'shuffle_all': {
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized.');
                        return;
                    }
                    await interaction.editReply(`🔀 Attempting to shuffle and play all tracks...`);
                    try {
                        await voiceService.musicService.joinChannel(interaction.member.voice.channel);
                        const result = await voiceService.musicService.shuffleAllTracks(); // Need to add this method
                        await interaction.editReply(`🔀 Shuffling all ${result.totalTracks} tracks. Now playing: **${result.currentTrack.title}** by ${result.currentTrack.artist}`);
                    } catch (error) {
                        console.error('Error shuffling all tracks:', error);
                        await interaction.editReply(`❌ Error shuffling all tracks: ${error.message}`);
                    }
                    break;
                }

                case 'playlist_create_from_search': {
                    const playlistName = interaction.options.getString('name');
                    const searchQuery = interaction.options.getString('search_query');
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized.');
                        return;
                    }
                    
                    await interaction.editReply(`🔍 Searching for tracks matching "${searchQuery}" to create playlist "${playlistName}"...`);
                    
                    try {
                        // 1. Get all tracks
                        const allTracks = await spotdlService.listTracks();
                        
                        // 2. Filter tracks based on search query
                        const filteredTracks = filterTracks(allTracks, searchQuery);
                        
                        if (filteredTracks.length === 0) {
                            await interaction.editReply(`❌ No tracks found matching "${searchQuery}". Playlist not created.`);
                            return;
                        }
                        
                        // 3. Create playlist with the filtered tracks (requires modification in MusicService)
                        await voiceService.musicService.createPlaylist(interaction.guildId, playlistName, filteredTracks);
                        
                        await interaction.editReply(`✅ Playlist "${playlistName}" created successfully with ${filteredTracks.length} tracks found matching "${searchQuery}".`);
                        
                    } catch (error) {
                        console.error('Error creating playlist from search:', error);
                        // Handle specific errors like playlist already exists if needed
                        if (error.message.toLowerCase().includes('already exists')) {
                             await interaction.editReply(`❌ Playlist "${playlistName}" already exists. Please choose a different name.`);
                        } else {
                             await interaction.editReply(`❌ Error creating playlist: ${error.message}`);
                        }
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('PlayTrack command error:', error);
            const errorMessage = error.message || 'An error occurred while processing your request.';
            
            if (interaction.deferred) {
                await interaction.editReply({ content: `❌ ${errorMessage}`, ephemeral: true });
            } else {
                await interaction.reply({ content: `❌ ${errorMessage}`, ephemeral: true });
            }
        }
    },
}; 