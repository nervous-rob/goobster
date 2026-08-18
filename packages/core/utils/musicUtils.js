const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType } = require('discord.js');

// Map to store active collectors, keyed by user ID
const activeCollectors = new Map();

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

// Helper function to filter tracks based on a search query
function filterTracks(tracks, searchQuery) {
    if (!searchQuery) return [...tracks]; // Return all if query is empty
    const searchLower = searchQuery.toLowerCase();
    return tracks.filter(track => {
        const { artist, title } = parseTrackName(track.name);
        const trackString = `${artist} - ${title}`.toLowerCase();
        const titleOnlyString = title.toLowerCase();
        const artistOnlyString = artist.toLowerCase();
        // Match if query is in artist, title, or combined "artist - title"
        return trackString.includes(searchLower) || titleOnlyString.includes(searchLower) || artistOnlyString.includes(searchLower);
    });
}

// Helper function to generate pages from tracks
function generatePages(tracks, title, tracksPerPage, currentSearchQuery = null) {
    const pages = [];
    const baseTitle = currentSearchQuery ? `${title} (Search: "${currentSearchQuery}")` : title;

    for (let i = 0; i < tracks.length; i += tracksPerPage) {
        const pageTracks = tracks.slice(i, i + tracksPerPage);
        const description = pageTracks.map((track, index) => {
            const { artist, title: trackTitle } = parseTrackName(track.name);
            // Use addedAt for queue view, fallback to lastModified, then 'Unknown'
            const date = track.addedAt || track.lastModified;
            const dateString = date ? new Date(date).toLocaleDateString() : 'Unknown Date';
            return `${i + index + 1}. ${trackTitle}\n   by ${artist}\n   Date: ${dateString}\n`; // Consistent date label
        }).join('\n');
        
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(baseTitle)
            .setDescription(description || 'No tracks on this page.')
            .setFooter({ text: `Page ${Math.floor(i / tracksPerPage) + 1} of ${Math.ceil(tracks.length / tracksPerPage)} | ${tracks.length} Tracks Total` })
            .setTimestamp();
        
        pages.push(embed);
    }
    // Handle case where there are tracks but filtering results in none
    if (pages.length === 0 && tracks.length > 0) {
         const embed = new EmbedBuilder()
            .setColor('#ffcc00') // Use a different color for notice
            .setTitle(baseTitle)
            .setDescription(currentSearchQuery 
                ? `No tracks match the search query: "${currentSearchQuery}"` 
                : 'No tracks match the current filter.') // More specific message
             .setFooter({ text: `0 Tracks Found` })
            .setTimestamp();
        pages.push(embed);
    }
    return pages;
}

// Shared function to create track list UI
async function createTrackListUI(interaction, initialTracks, title = 'Available Tracks') {
    if (!initialTracks || initialTracks.length === 0) {
        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        await interaction[replyMethod]({ 
            content: 'No tracks found.',
            ephemeral: true
        });
        return null;
    }

    const userId = interaction.user.id;
    if (activeCollectors.has(userId)) {
        const oldCollector = activeCollectors.get(userId);
        if (!oldCollector.ended) {
            oldCollector.stop('New list requested');
        }
        activeCollectors.delete(userId); // Clean up just in case
    }

    let currentTracks = [...initialTracks]; // Use a mutable copy for sorting/filtering
    let currentPage = 0;
    const tracksPerPage = 10;
    let currentSort = { field: null, direction: 1 }; // null, 'title', 'date'. direction 1=asc, -1=desc
    let currentSearchQuery = null; // Track the active search query
    const searchModalCustomId = `search_modal_${interaction.id}`; // Unique ID for the modal
    const searchInputCustomId = `search_input_${interaction.id}`;

    // Initial Page Generation
    let pages = generatePages(currentTracks, title, tracksPerPage, currentSearchQuery);

    // --- Action Row (Sort, Search, Clear) ---
    const actionRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('sort_title')
                .setLabel('Sort Title')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔡'),
            new ButtonBuilder()
                .setCustomId('sort_date')
                .setLabel('Sort Date')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📅'),
            new ButtonBuilder()
                .setCustomId('search_button')
                .setLabel('Search')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🔍'),
             new ButtonBuilder()
                .setCustomId('clear_search_button')
                .setLabel('Show All')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('✖️')
                .setDisabled(true) // Initially disabled
        );

    // Navigation buttons
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

    // Send first page with new action row and navigation
    const replyMethod = interaction.deferred ? 'editReply' : 'reply';
    const message = await interaction[replyMethod]({ 
        embeds: [pages[0]], 
        components: [actionRow, navRow], // Use actionRow, remove sortRow
        ephemeral: true
    });

    // Create collector for Buttons AND Modal Submits related to this message
    // Note: Filtering ModalSubmit directly in message collector is tricky
    // We'll handle modal display in button collect and rely on modal submit handler elsewhere
    // OR use awaitModalSubmit (simpler for now, despite blocking warning)
    const collector = message.createMessageComponentCollector({ 
        filter: (i) => i.user.id === userId, // Filter only user's interactions
        time: 300000 // 5 minutes 
    });

    activeCollectors.set(userId, collector);

    collector.on('collect', async (i) => {
        // No need for user ID check again due to filter

        try {
             // Handle Button Interactions
            if (i.isButton()) {
                // --- Search Button --- 
                // Handle Search first, as it uses showModal (an initial response) 
                // and cannot be deferred beforehand.
                if (i.customId === 'search_button') {
                    const modal = new ModalBuilder()
                        .setCustomId(searchModalCustomId)
                        .setTitle('Search Tracks');
                    const searchInput = new TextInputBuilder()
                        .setCustomId(searchInputCustomId)
                        .setLabel("Enter artist or title")
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('e.g., Queen, Bohemian Rhapsody')
                        .setRequired(true);
                    const firstActionRow = new ActionRowBuilder().addComponents(searchInput);
                    modal.addComponents(firstActionRow);
                    
                    // Show the modal *instead* of deferring the button interaction
                    await i.showModal(modal);

                    // Wait for the modal submission
                    const filter = (modalInteraction) => 
                        modalInteraction.customId === searchModalCustomId && modalInteraction.user.id === userId;
                    try {
                        const modalSubmitInteraction = await i.awaitModalSubmit({ filter, time: 60000 }); // 60 seconds timeout
                        
                        // Defer the MODAL submission interaction before processing
                        await modalSubmitInteraction.deferUpdate(); 

                        currentSearchQuery = modalSubmitInteraction.fields.getTextInputValue(searchInputCustomId);
                        currentTracks = filterTracks(initialTracks, currentSearchQuery); // Filter original list
                        currentSort = { field: null, direction: 1 }; // Reset sort after search
                        
                        // Update view after successful modal submit
                        pages = generatePages(currentTracks, title, tracksPerPage, currentSearchQuery);
                        currentPage = 0;
                        const currentEmbed = pages[currentPage] || generatePages([], title, tracksPerPage, currentSearchQuery)[0];
                        actionRow.components.find(c => c.data.custom_id === 'clear_search_button').setDisabled(false);
                        
                        // Edit the original reply (which the collector is attached to)
                        // Use modalSubmitInteraction.editReply (or message.edit if preferred, but this targets the reply context)
                        // Using message.edit might be safer if modal interaction token expires quickly
                        await message.edit({ 
                            embeds: [currentEmbed],
                            components: [actionRow, navRow] 
                        });
                        return; // Exit collect handler after processing modal

                    } catch (err) {
                         // Modal timed out or other error
                         console.log(`[Collector ${userId}] Modal timed out or failed for search.`);
                         // No update needed if modal fails/times out
                         // We didn't defer the original button click, so no explicit followup needed here
                         return; 
                    }
                } 
                
                // --- For all other buttons, defer the update first --- 
                await i.deferUpdate(); 
                let needsUpdate = false;
                let resetView = false; // Flag to indicate full view reset (search/clear)

                // --- Navigation --- 
                if (i.customId === 'first') { currentPage = 0; needsUpdate = true; }
                else if (i.customId === 'prev') { currentPage = Math.max(0, currentPage - 1); needsUpdate = true; }
                else if (i.customId === 'next') { currentPage = Math.min(pages.length - 1, currentPage + 1); needsUpdate = true; }
                else if (i.customId === 'last') { currentPage = pages.length - 1; needsUpdate = true; }
                
                // --- Sorting --- 
                else if (i.customId === 'sort_title') {
                    currentSort = { field: 'title', direction: 1 };
                    currentTracks.sort((a, b) => parseTrackName(a.name).title.localeCompare(parseTrackName(b.name).title));
                    resetView = true;
                } else if (i.customId === 'sort_date') {
                    currentSort = { field: 'date', direction: -1 }; 
                    currentTracks.sort((a, b) => {
                         const dateA = a.addedAt || a.lastModified || 0;
                         const dateB = b.addedAt || b.lastModified || 0;
                         if (!dateA && !dateB) return 0;
                         if (!dateA) return 1 * currentSort.direction;
                         if (!dateB) return -1 * currentSort.direction;
                         return (dateA - dateB) * currentSort.direction;
                    });
                    resetView = true;
                }

                // --- Clear Search Button --- 
                else if (i.customId === 'clear_search_button') {
                    currentSearchQuery = null;
                    currentTracks = [...initialTracks]; // Reset to original list
                    currentSort = { field: null, direction: 1 }; // Reset sort
                    resetView = true;
                }

                // --- Update pages and message for non-search buttons --- 
                if (resetView) {
                    pages = generatePages(currentTracks, title, tracksPerPage, currentSearchQuery);
                    currentPage = 0;
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    currentPage = Math.max(0, Math.min(currentPage, pages.length - 1));
                    const currentEmbed = pages[currentPage] || generatePages([], title, tracksPerPage, currentSearchQuery)[0]; // Fallback embed

                    // Update button states
                    actionRow.components.forEach(component => {
                        if (component.data.custom_id === 'clear_search_button') {
                            component.setDisabled(!currentSearchQuery); // Enable only if search is active
                        }
                        // Potentially update sort button appearance based on currentSort
                    });

                    // Use i.editReply here as we deferred this interaction 'i'
                    await i.editReply({ 
                        embeds: [currentEmbed],
                        components: [actionRow, navRow] 
                    });
                }
            }
            // --- Handle Select Menu (If we were still using one) ---
            // else if (i.isStringSelectMenu() && i.customId === 'search_select') { ... }

        } catch (error) {
            console.warn(`[Collector ${userId}] Error during collect: ${error.message} (Code: ${error.code})`);
            if (error.code === 10062) { // Unknown Interaction
                collector.stop('unknownInteraction');
            } else if (error.code === 40060 || error.message.includes('already been acknowledged')) { 
                 // Usually safe to ignore
            } else {
                console.error(`[Collector ${userId}] Detailed error handling track list interaction:`, error);
                try {
                    // Use followUp as editReply might fail if deferUpdate also failed
                    await i.followUp({ 
                        content: 'An error occurred while processing your action.',
                        ephemeral: true 
                    });
                } catch (followUpError) {
                    if (followUpError.code !== 10062) { // Avoid logging if interaction is just gone
                       console.error(`[Collector ${userId}] Error sending follow-up message:`, followUpError);
                    }
                }
            }
        }
    });

    collector.on('end', (collected, reason) => {
        activeCollectors.delete(userId);
        if (message && !message.deleted) {
            // Disable all components
            actionRow.components.forEach(button => button.setDisabled(true));
            navRow.components.forEach(button => button.setDisabled(true)); 
            
            const finalEmbed = pages[currentPage] || generatePages([], title, tracksPerPage, currentSearchQuery)[0];

            message.edit({ 
                 embeds: [finalEmbed], 
                 components: [actionRow, navRow] 
            }).catch(editError => {
                 if ([10008, 10062, 40060].includes(editError.code)) { 
                     // Non-critical errors
                 } else {
                     console.error(`[Collector End ${userId}] Error disabling components:`, editError);
                 }
            });
        } 
    });

    return { message, collector };
}

module.exports = {
    parseTrackName,
    formatTrackName,
    filterTracks,
    createTrackListUI
}; 