const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');
const SpotDLService = require('../../services/spotdl/spotdlService');
const { filterTracks, createTrackListUI } = require('../../utils/musicUtils');
const { voiceService } = require('../../services/serviceManager');

const spotdlService = new SpotDLService();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('spotdl')
        .setDescription('Download and manage music tracks from Spotify or YouTube')
        .addSubcommand(subcommand =>
            subcommand
                .setName('download')
                .setDescription('Download a track, playlist, or album from Spotify or YouTube')
                .addStringOption(option =>
                    option.setName('url')
                        .setDescription('Spotify track/playlist/album URL or YouTube video/playlist URL')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('save_as_playlist')
                        .setDescription('Optional: Save downloaded tracks as a new/updated playlist')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all downloaded tracks'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete a track')
                .addStringOption(option =>
                    option.setName('track')
                        .setDescription('Name of the track to delete (artist - title)')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            await interaction.deferReply();

            // Check if voiceService is initialized
            if (!voiceService) {
                await interaction.editReply('❌ Voice service is not initialized. Please try again later.');
                return;
            }

            // Check if musicService is initialized
            if (!voiceService.musicService) {
                await interaction.editReply('❌ Music service is not initialized. Please try again later.');
                return;
            }

            switch (subcommand) {
                case 'download': {
                    const url = interaction.options.getString('url');
                    const saveAsPlaylist = interaction.options.getString('save_as_playlist');
                    
                    // Show loading message
                    await interaction.editReply('🎵 Checking for existing tracks...');
                    
                    try {
                        const uploadedTracks = await spotdlService.downloadTrack(url);
                        let replyMessage = '';
                        
                        if (uploadedTracks && uploadedTracks.length > 0) {
                            // Check if these tracks were already in the system
                            const existingTracks = await spotdlService.listTracks();
                            const existingTrackNames = existingTracks.map(t => t.name);
                            const newTracks = uploadedTracks.filter(t => !existingTrackNames.includes(t.name));
                            
                            if (newTracks.length > 0) {
                                replyMessage = `✅ Downloaded and uploaded ${newTracks.length} new track(s) successfully!`;
                            } else {
                                replyMessage = `✅ Found ${uploadedTracks.length} existing track(s) in the system.`;
                            }

                            if (saveAsPlaylist) {
                                await interaction.editReply(replyMessage + `\n💾 Saving to playlist '${saveAsPlaylist}'...`);
                                try {
                                    // Confirm the downloaded files landed in local storage
                                    // (downloadTrack returns { name, url } entries)
                                    const storedTracks = await spotdlService.listTracks();
                                    const storedTrackNames = new Set(storedTracks.map(t => t.name));

                                    const formattedTracks = uploadedTracks
                                        .filter(track => {
                                            if (storedTrackNames.has(track.name)) return true;
                                            console.warn(`Downloaded track not found in storage: ${track.name}`);
                                            return false;
                                        })
                                        .map(track => storedTracks.find(t => t.name === track.name));

                                    if (formattedTracks.length === 0) {
                                        replyMessage += `\n⚠️ No valid tracks found in storage to add to playlist.`;
                                        await interaction.editReply(replyMessage);
                                        return;
                                    }

                                    const playlist = await voiceService.musicService.createOrUpdatePlaylistFromTracks(
                                        interaction.guildId,
                                        saveAsPlaylist,
                                        formattedTracks
                                    );
                                    replyMessage += `\n💾 Saved ${playlist.tracks.length} tracks to playlist '${saveAsPlaylist}'.`;
                                } catch (playlistError) {
                                    console.error(`Error saving playlist ${saveAsPlaylist}:`, playlistError);
                                    replyMessage += `\n⚠️ Failed to save playlist '${saveAsPlaylist}': ${playlistError.message}`;
                                }
                            }
                        } else {
                            replyMessage = '⚠️ No tracks were found or downloaded. Please check the URL and try again.';
                        }
                        await interaction.editReply(replyMessage);
                    } catch (error) {
                        console.error('SpotDL download error caught in command:', error);
                        // spotdl surfaces Spotify rate limits as "too many 429 error responses"
                        if (/rate limit|429/i.test(error.message)) {
                            await interaction.editReply('⚠️ Spotify rate limit reached. Add your own Spotify API credentials to config.json to avoid this, or try again in a few minutes.');
                            return;
                        }
                        throw error;
                    }
                    break;
                }

                case 'list': {
                    await interaction.editReply('📋 Loading downloaded tracks...');
                    const tracks = await spotdlService.listTracks();
                    await createTrackListUI(interaction, tracks, 'Downloaded Tracks');
                    break;
                }

                case 'delete': {
                    const searchQuery = interaction.options.getString('track');
                    
                    // Show loading message
                    await interaction.editReply('🗑️ Searching for track...');
                    
                    try {
                        const tracks = await spotdlService.listTracks();
                        const matchingTracks = filterTracks(tracks, searchQuery);
                        
                        if (matchingTracks.length === 0) {
                            await interaction.editReply('❌ Track not found. Use `/spotdl list` to see available tracks.');
                            return;
                        }
                        
                        const track = matchingTracks[0];

                        await spotdlService.deleteTrack(track.name);
                        await interaction.editReply('✅ Track deleted successfully!');
                    } catch (error) {
                        if (error.message.includes('rate limit')) {
                            await interaction.editReply('⚠️ Rate limit reached. Please try again in a few minutes.');
                            return;
                        }
                        throw error;
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('SpotDL command error:', error);
            const errorMessage = error.message || 'An error occurred while processing your request.';
            
            if (interaction.deferred) {
                await interaction.editReply({ content: `❌ ${errorMessage}`, ephemeral: true });
            } else {
                await interaction.reply({ content: `❌ ${errorMessage}`, ephemeral: true });
            }
        }
    },
}; 