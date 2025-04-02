const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

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

// Helper function to find matching track
async function findMatchingTrack(tracks, searchQuery) {
    const searchLower = searchQuery.toLowerCase();
    
    // First try exact match
    let match = tracks.find(track => {
        const { artist, title } = parseTrackName(track.name);
        const trackString = `${artist} - ${title}`.toLowerCase();
        return trackString === searchLower;
    });
    
    // If no exact match, try partial match
    if (!match) {
        match = tracks.find(track => {
            const { artist, title } = parseTrackName(track.name);
            const trackString = `${artist} - ${title}`.toLowerCase();
            return trackString.includes(searchLower);
        });
    }
    
    return match;
}

// Shared function to create track list UI
async function createTrackListUI(interaction, tracks, title = 'Available Tracks') {
    if (!tracks || tracks.length === 0) {
        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        await interaction[replyMethod]({ 
            content: 'No tracks found.',
            ephemeral: true
        });
        return null;
    }

    // Create search menu
    const searchRow = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('search')
                .setPlaceholder('Search tracks...')
                .addOptions(
                    tracks.slice(0, 25).map(track => ({
                        label: String(track.name || 'Unknown Track').slice(0, 100),
                        value: String(track.name || 'unknown').slice(0, 100),
                        description: formatTrackName(track).slice(0, 50)
                    }))
                )
        );

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

    // Split tracks into pages of 10
    const tracksPerPage = 10;
    const pages = [];
    for (let i = 0; i < tracks.length; i += tracksPerPage) {
        const pageTracks = tracks.slice(i, i + tracksPerPage);
        const description = pageTracks.map((track, index) => {
            const { artist, title } = parseTrackName(track.name);
            // Check if this is the queue view by looking for the addedAt property
            const dateString = track.addedAt
                ? new Date(track.addedAt).toLocaleDateString() // Use addedAt for queue
                : track.lastModified ? new Date(track.lastModified).toLocaleDateString() : 'Unknown'; // Fallback for list
            return `${i + index + 1}. ${title}\n   by ${artist}\n   Added: ${dateString}\n`;
        }).join('\n');
        
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(title)
            .setDescription(description)
            .setFooter({ text: `Page ${Math.floor(i / tracksPerPage) + 1} of ${Math.ceil(tracks.length / tracksPerPage)}` })
            .setTimestamp();
        
        pages.push(embed);
    }

    // Send first page with navigation
    const replyMethod = interaction.deferred ? 'editReply' : 'reply';
    const message = await interaction[replyMethod]({ 
        embeds: [pages[0]], 
        components: [searchRow, navRow],
        ephemeral: true
    });

    // Create button collector
    const collector = message.createMessageComponentCollector({ 
        time: 300000 // 5 minutes
    });

    let currentPage = 0;

    collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
            return i.reply({ 
                content: 'Only the command user can use these buttons!', 
                ephemeral: true 
            });
        }

        try {
            await i.deferUpdate();

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
                const trackIndex = tracks.findIndex(t => String(t.name) === selectedTrack);
                if (trackIndex !== -1) {
                    currentPage = Math.floor(trackIndex / tracksPerPage);
                }
            }

            await i.editReply({ 
                embeds: [pages[currentPage]], 
                components: [searchRow, navRow]
            });
        } catch (error) {
            console.error('Error handling track list interaction:', error);
            await i.followUp({ 
                content: 'An error occurred while updating the track list.',
                ephemeral: true 
            }).catch(() => {});
        }
    });

    collector.on('end', () => {
        // Disable buttons when collector ends
        navRow.components.forEach(button => button.setDisabled(true));
        searchRow.components.forEach(menu => menu.setDisabled(true));
        
        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        interaction[replyMethod]({ 
            embeds: [pages[currentPage]], 
            components: [searchRow, navRow],
            ephemeral: true
        }).catch(() => {});
    });

    return { message, collector };
}

module.exports = {
    parseTrackName,
    formatTrackName,
    findMatchingTrack,
    createTrackListUI
}; 