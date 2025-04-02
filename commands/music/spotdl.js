const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionFlagsBits } = require('discord.js');
const SpotDLService = require('../../services/spotdl/spotdlService');
const { findMatchingTrack, createTrackListUI } = require('../../utils/musicUtils');

const spotdlService = new SpotDLService();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('spotdl')
        .setDescription('Download and manage music tracks from Spotify')
        .addSubcommand(subcommand =>
            subcommand
                .setName('download')
                .setDescription('Download a track, playlist, or album from Spotify')
                .addStringOption(option =>
                    option.setName('url')
                        .setDescription('Spotify track, playlist, or album URL')
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

    async execute(interaction, musicService) {
        const subcommand = interaction.options.getSubcommand();

        try {
            await interaction.deferReply();

            switch (subcommand) {
                case 'download': {
                    const url = interaction.options.getString('url');
                    const saveAsPlaylist = interaction.options.getString('save_as_playlist');
                    
                    // Show loading message
                    await interaction.editReply('🎵 Downloading track(s)...' + (saveAsPlaylist ? ` and saving to playlist \'${saveAsPlaylist}\'` : ''));
                    
                    try {
                        const uploadedTracks = await spotdlService.downloadTrack(url);
                        let replyMessage = '';
                        if (uploadedTracks && uploadedTracks.length > 0) {
                            replyMessage = `✅ Downloaded and uploaded ${uploadedTracks.length} track(s) successfully!`;

                            if (saveAsPlaylist && musicService) {
                                await interaction.editReply(replyMessage + `\n�� Saving to playlist \'${saveAsPlaylist}\'...`);
                                try {
                                    const playlist = await musicService.createOrUpdatePlaylistFromTracks(
                                        interaction.guildId,
                                        saveAsPlaylist,
                                        uploadedTracks
                                    );
                                    replyMessage += `\n💾 Saved to playlist \'${saveAsPlaylist}\' (${playlist.tracks.length} total tracks).`;
                                } catch (playlistError) {
                                    console.error(`Error saving playlist ${saveAsPlaylist}:`, playlistError);
                                    replyMessage += `\n⚠️ Failed to save playlist \'${saveAsPlaylist}\': ${playlistError.message}`;
                                }
                            } else if (saveAsPlaylist && !musicService) {
                                replyMessage += `\n⚠️ Could not save playlist: Music service unavailable.`;
                            }

                        } else {
                            replyMessage = '⚠️ Download completed, but no tracks were uploaded. Please check logs.';
                        }
                        await interaction.editReply(replyMessage);
                    } catch (error) {
                        console.error('SpotDL download error caught in command:', error);
                        if (error.message.includes('rate limit')) {
                            await interaction.editReply('⚠️ Rate limit reached by SpotDL. Please try again in a few minutes.');
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
                        const track = await findMatchingTrack(tracks, searchQuery);
                        
                        if (!track) {
                            await interaction.editReply('❌ Track not found. Use `/spotdl list` to see available tracks.');
                            return;
                        }

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