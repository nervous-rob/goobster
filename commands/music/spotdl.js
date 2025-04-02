const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const SpotDLService = require('../../services/spotdl/spotdlService');

const spotdlService = new SpotDLService();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('spotdl')
        .setDescription('Download and manage Spotify tracks')
        .addSubcommand(subcommand =>
            subcommand
                .setName('download')
                .setDescription('Download a track from Spotify')
                .addStringOption(option =>
                    option.setName('url')
                        .setDescription('Spotify track, playlist, or album URL')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all downloaded tracks'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete a downloaded track')
                .addStringOption(option =>
                    option.setName('track')
                        .setDescription('Name of the track to delete')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('bulk-delete')
                .setDescription('Delete multiple tracks at once')
                .addStringOption(option =>
                    option.setName('tracks')
                        .setDescription('Comma-separated list of track names to delete')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            switch (subcommand) {
                case 'download': {
                    await interaction.deferReply();
                    const url = interaction.options.getString('url');
                    
                    try {
                        const result = await spotdlService.downloadTrack(url);
                        
                        const embed = new EmbedBuilder()
                            .setColor('#00ff00')
                            .setTitle('Track Downloaded')
                            .setDescription(`Successfully downloaded: ${result.name}`)
                            .addFields(
                                { name: 'Artist', value: result.artist || 'Unknown', inline: true },
                                { name: 'Album', value: result.album || 'Unknown', inline: true },
                                { name: 'Duration', value: result.duration || 'Unknown', inline: true }
                            )
                            .setTimestamp();
                        
                        await interaction.editReply({ embeds: [embed] });
                    } catch (error) {
                        if (error.message.includes('rate limit')) {
                            const embed = new EmbedBuilder()
                                .setColor('#ff9900')
                                .setTitle('Rate Limit Reached')
                                .setDescription('Spotify API rate limit reached. Please try again in a few minutes.')
                                .setTimestamp();
                            
                            await interaction.editReply({ embeds: [embed], ephemeral: true });
                            return;
                        }
                        throw error;
                    }
                    break;
                }

                case 'list': {
                    await interaction.deferReply();
                    const tracks = await spotdlService.listTracks();
                    
                    if (tracks.length === 0) {
                        await interaction.editReply('No tracks found.');
                        return;
                    }

                    // Create navigation buttons
                    const navRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('first')
                                .setLabel('First')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('prev')
                                .setLabel('Previous')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId('next')
                                .setLabel('Next')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId('last')
                                .setLabel('Last')
                                .setStyle(ButtonStyle.Primary)
                        );

                    // Create search and sort menu
                    const searchRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('search')
                                .setPlaceholder('Search tracks...')
                                .addOptions(
                                    tracks.slice(0, 25).map(track => ({
                                        label: String(track.name || 'Unknown Track').slice(0, 100),
                                        value: String(track.name || 'unknown').slice(0, 100),
                                        description: `Added: ${new Date(track.lastModified).toLocaleDateString()}`.slice(0, 50)
                                    }))
                                )
                        );

                    // Create action buttons
                    const actionRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('sort')
                                .setLabel('Sort')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId('preview')
                                .setLabel('Preview')
                                .setStyle(ButtonStyle.Success)
                        );

                    // Split tracks into pages of 10
                    const tracksPerPage = 10;
                    const pages = [];
                    for (let i = 0; i < tracks.length; i += tracksPerPage) {
                        const pageTracks = tracks.slice(i, i + tracksPerPage);
                        const description = pageTracks.map((track, index) => {
                            // Parse the filename to extract artist and song
                            const filename = String(track.name || 'Unknown Track').replace('.mp3', '');
                            const [artist, ...songParts] = filename.split(' - ');
                            const song = songParts.join(' - '); // Rejoin in case song title contains dashes
                            
                            return `${i + index + 1}. ${song}\n` +
                                   `   by ${artist}\n` +
                                   `   Added: ${new Date(track.lastModified).toLocaleDateString()}\n`;
                        }).join('\n');
                        
                        const embed = new EmbedBuilder()
                            .setColor('#0099ff')
                            .setTitle('Downloaded Tracks')
                            .setDescription(description)
                            .setFooter({ text: `Page ${Math.floor(i / tracksPerPage) + 1} of ${Math.ceil(tracks.length / tracksPerPage)}` })
                            .setTimestamp();
                        
                        pages.push(embed);
                    }

                    // Send first page with navigation
                    const message = await interaction.editReply({ 
                        embeds: [pages[0]], 
                        components: [searchRow, navRow, actionRow]
                    });

                    // Create button collector
                    const collector = message.createMessageComponentCollector({ 
                        time: 300000 // 5 minutes
                    });

                    let currentPage = 0;
                    let sortedTracks = [...tracks];

                    collector.on('collect', async (i) => {
                        if (i.user.id !== interaction.user.id) {
                            return i.reply({ 
                                content: 'Only the command user can use these buttons!', 
                                ephemeral: true 
                            });
                        }

                        if (i.customId === 'first') {
                            currentPage = 0;
                        } else if (i.customId === 'prev') {
                            currentPage = Math.max(0, currentPage - 1);
                        } else if (i.customId === 'next') {
                            currentPage = Math.min(pages.length - 1, currentPage + 1);
                        } else if (i.customId === 'last') {
                            currentPage = pages.length - 1;
                        } else if (i.customId === 'search') {
                            const selectedTrack = i.values[0];
                            const trackIndex = sortedTracks.findIndex(t => String(t.name) === selectedTrack);
                            if (trackIndex !== -1) {
                                currentPage = Math.floor(trackIndex / tracksPerPage);
                            }
                        } else if (i.customId === 'sort') {
                            const sortRow = new ActionRowBuilder()
                                .addComponents(
                                    new StringSelectMenuBuilder()
                                        .setCustomId('sort_type')
                                        .setPlaceholder('Sort by...')
                                        .addOptions([
                                            { label: 'Name (A-Z)', value: 'name_asc' },
                                            { label: 'Name (Z-A)', value: 'name_desc' },
                                            { label: 'Date Added (Newest)', value: 'date_desc' },
                                            { label: 'Date Added (Oldest)', value: 'date_asc' }
                                        ])
                                );
                            
                            await i.update({ components: [searchRow, navRow, actionRow, sortRow] });
                            return;
                        } else if (i.customId === 'sort_type') {
                            const sortType = i.values[0];
                            switch (sortType) {
                                case 'name_asc':
                                    sortedTracks.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
                                    break;
                                case 'name_desc':
                                    sortedTracks.sort((a, b) => String(b.name || '').localeCompare(String(a.name || '')));
                                    break;
                                case 'date_desc':
                                    sortedTracks.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
                                    break;
                                case 'date_asc':
                                    sortedTracks.sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));
                                    break;
                            }
                            currentPage = 0;
                        } else if (i.customId === 'preview') {
                            const currentTrack = sortedTracks[currentPage * tracksPerPage];
                            if (currentTrack) {
                                try {
                                    const previewUrl = await spotdlService.getTrackUrl(currentTrack.name);
                                    await i.reply({
                                        content: `Preview URL for "${String(currentTrack.name)}": ${previewUrl}\nThis URL will expire in 1 hour.`,
                                        ephemeral: true
                                    });
                                } catch (error) {
                                    await i.reply({
                                        content: 'Failed to generate preview URL. Please try again.',
                                        ephemeral: true
                                    });
                                }
                                return;
                            }
                        }

                        await i.update({ 
                            embeds: [pages[currentPage]], 
                            components: [searchRow, navRow, actionRow]
                        });
                    });

                    collector.on('end', () => {
                        // Disable buttons when collector ends
                        navRow.components.forEach(button => button.setDisabled(true));
                        searchRow.components.forEach(menu => menu.setDisabled(true));
                        actionRow.components.forEach(button => button.setDisabled(true));
                        interaction.editReply({ 
                            embeds: [pages[currentPage]], 
                            components: [searchRow, navRow, actionRow]
                        }).catch(() => {});
                    });

                    break;
                }

                case 'delete': {
                    await interaction.deferReply();
                    const trackName = interaction.options.getString('track');
                    
                    await spotdlService.deleteTrack(trackName);
                    
                    const embed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('Track Deleted')
                        .setDescription(`Successfully deleted: ${trackName}`)
                        .setTimestamp();
                    
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                case 'bulk-delete': {
                    await interaction.deferReply();
                    const tracksString = interaction.options.getString('tracks');
                    const trackNames = tracksString.split(',').map(name => name.trim());
                    
                    const results = await Promise.allSettled(
                        trackNames.map(name => spotdlService.deleteTrack(name))
                    );
                    
                    const successful = results.filter(r => r.status === 'fulfilled').length;
                    const failed = results.filter(r => r.status === 'rejected').length;
                    
                    const embed = new EmbedBuilder()
                        .setColor(failed === 0 ? '#00ff00' : '#ff9900')
                        .setTitle('Bulk Delete Results')
                        .setDescription(`Successfully deleted: ${successful} tracks\nFailed to delete: ${failed} tracks`)
                        .setTimestamp();
                    
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }
            }
        } catch (error) {
            console.error('SpotDL command error:', error);
            const errorMessage = error.message || 'An error occurred while processing your request.';
            
            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('Error')
                .setDescription(`❌ ${errorMessage}`)
                .setTimestamp();
            
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [embed], ephemeral: true });
            } else {
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        }
    },
}; 