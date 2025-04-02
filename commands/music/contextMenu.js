const { ContextMenuCommandBuilder } = require('@discordjs/builders');
const { 
    ApplicationCommandType,
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionFlagsBits 
} = require('discord.js');
const { parseTrackName, formatTrackName, createTrackListUI } = require('../../utils/musicUtils');
const { voiceService } = require('../../services/serviceManager');
const config = require('../../config.json');

// Helper function to check if a user is in the same voice channel as the bot
function isUserInBotVoiceChannel(interaction) {
    const botVoiceChannel = interaction.guild.members.me.voice.channel;
    if (!botVoiceChannel) return false;
    
    const userVoiceChannel = interaction.member.voice.channel;
    if (!userVoiceChannel) return false;
    
    return botVoiceChannel.id === userVoiceChannel.id;
}

// Helper function to check if the message is from Goobster
function isGoobsterMessage(message) {
    return message.author.id === message.client.user.id;
}

// Helper function to check if music is currently playing
function isMusicPlaying(interaction) {
    return voiceService.musicService && 
           voiceService.musicService.isPlaying && 
           voiceService.musicService.currentTrack;
}

// Helper function to get playlist status
function getPlaylistStatus(interaction) {
    if (!voiceService.musicService) return null;
    return voiceService.musicService.getQueueStatus();
}

// Add new helper function for playlist management
async function handlePlaylistSelection(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('playlist_modal')
        .setTitle('Playlist Management');

    // Create text inputs
    const playlistNameInput = new TextInputBuilder()
        .setCustomId('playlist_name')
        .setLabel('Playlist Name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter playlist name')
        .setRequired(true);

    const playlistActionInput = new TextInputBuilder()
        .setCustomId('playlist_action')
        .setLabel('Action (create/load/delete)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter action: create, load, or delete')
        .setRequired(true);

    // Add inputs to modal
    const firstActionRow = new ActionRowBuilder().addComponents(playlistNameInput);
    const secondActionRow = new ActionRowBuilder().addComponents(playlistActionInput);

    modal.addComponents(firstActionRow, secondActionRow);

    await interaction.showModal(modal);
}

// Handle modal submissions
async function handleModalSubmit(interaction) {
    if (interaction.customId === 'playlist_modal') {
        try {
            const playlistName = interaction.fields.getTextInputValue('playlist_name');
            const action = interaction.fields.getTextInputValue('playlist_action').toLowerCase();
            
            if (!['create', 'load', 'delete'].includes(action)) {
                await interaction.reply({
                    content: '❌ Invalid action. Please use: create, load, or delete',
                    ephemeral: true
                });
                return;
            }

            const guildId = interaction.guildId;
            let response = '';

            switch (action) {
                case 'create':
                    await voiceService.musicService.createPlaylist(guildId, playlistName);
                    response = `✅ Created new playlist: ${playlistName}`;
                    break;
                case 'load':
                    await voiceService.musicService.loadPlaylist(guildId, playlistName);
                    response = `✅ Loaded playlist: ${playlistName}`;
                    break;
                case 'delete':
                    await voiceService.musicService.deletePlaylist(guildId, playlistName);
                    response = `✅ Deleted playlist: ${playlistName}`;
                    break;
            }

            await interaction.reply({
                content: response,
                ephemeral: true
            });
        } catch (error) {
            console.error('Error handling playlist modal:', error);
            await interaction.reply({
                content: `❌ Error: ${error.message}`,
                ephemeral: true
            });
        }
    }
}

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName('Goobster Controls')
        .setType(ApplicationCommandType.Message),

    async execute(interaction) {
        try {
            // Check if the message is from Goobster
            if (!isGoobsterMessage(interaction.targetMessage)) {
                await interaction.reply({ 
                    content: '❌ This command can only be used on Goobster\'s messages.',
                    ephemeral: true 
                });
                return;
            }

            // Check if user is in the same voice channel as the bot
            if (!isUserInBotVoiceChannel(interaction)) {
                await interaction.reply({ 
                    content: '❌ You need to be in the same voice channel as the bot to use controls.',
                    ephemeral: true 
                });
                return;
            }

            // Create common controls that appear in all states
            const commonRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('volume')
                        .setLabel('Volume')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('queue')
                        .setLabel('Queue')
                        .setStyle(ButtonStyle.Secondary)
                );

            // Create music-specific controls
            const musicRow = new ActionRowBuilder()
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

            // Create volume control menu
            const volumeRow = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('volume_level')
                        .setPlaceholder('Volume: ' + (voiceService.musicService?.getVolume() || 100) + '%')
                        .addOptions([
                            { label: '0%', value: '0' },
                            { label: '25%', value: '25' },
                            { label: '50%', value: '50' },
                            { label: '75%', value: '75' },
                            { label: '100%', value: '100' }
                        ])
                );

            // Create playlist management row
            const playlistRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('shuffle')
                        .setLabel('Shuffle')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('repeat')
                        .setLabel('Repeat')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('playlist')
                        .setLabel('Playlists')
                        .setStyle(ButtonStyle.Secondary)
                );

            // Determine which components to show based on music state
            const components = [commonRow];
            if (isMusicPlaying(interaction)) {
                components.push(musicRow, volumeRow, playlistRow);
            }

            // Create response message based on state
            let content = '🎵 Goobster Controls\n\nAnyone in the voice channel can use these controls!';
            
            const playlistStatus = getPlaylistStatus(interaction);
            if (playlistStatus) {
                const { currentTrack, isShuffleEnabled, isRepeatEnabled, remainingTracks } = playlistStatus;
                const { artist, title } = parseTrackName(currentTrack.name);
                
                content += `\n\nNow Playing: ${title}\nby ${artist}`;
                content += `\n${isShuffleEnabled ? '🔀 Shuffle: On' : ''} ${isRepeatEnabled ? '🔁 Repeat: On' : ''}`;
                content += `\nTracks remaining: ${remainingTracks}`;
            }

            // Send the response with appropriate controls
            await interaction.reply({
                content: content,
                components: components,
                ephemeral: true
            });

            // Create button collector
            const collector = interaction.channel.createMessageComponentCollector({
                time: 300000 // 5 minutes
            });

            collector.on('collect', async (i) => {
                // Check if the user is in the same voice channel as the bot
                if (!isUserInBotVoiceChannel(i)) {
                    return i.reply({ 
                        content: '❌ You need to be in the same voice channel as the bot to use controls.',
                        ephemeral: true 
                    });
                }

                let needsGeneralUpdate = false; // Flag to trigger the general update logic

                try {
                    // Check if music service is initialized (moved here to avoid redundant checks)
                    if (!voiceService.musicService) {
                        await i.reply({ // Use reply here as we haven't deferred yet
                            content: '❌ Music service is not initialized. Please try again later.',
                            ephemeral: true
                        });
                        return; // Stop processing if no music service
                    }

                    switch (i.customId) {
                        case 'pause':
                            await i.deferUpdate(); // Defer first
                            if (isMusicPlaying(i)) {
                                await voiceService.musicService.pause();
                                musicRow.components[0].setLabel('Resume').setCustomId('resume');
                            }
                            needsGeneralUpdate = true; // Mark for general update
                            break; // Go to general update

                        case 'resume':
                            await i.deferUpdate();
                            await voiceService.musicService.resume();
                            musicRow.components[0].setLabel('Pause').setCustomId('pause');
                            needsGeneralUpdate = true;
                            break;

                        case 'skip':
                            await i.deferUpdate();
                            if (isMusicPlaying(i)) { 
                                await voiceService.musicService.skip();
                            }
                            // Need to update visuals regardless (might show next track or stopped state)
                            // Ensure pause/resume button is correct after skip
                            if (voiceService.musicService.isPlaying) {
                                 musicRow.components[0].setLabel('Pause').setCustomId('pause');
                            } else {
                                // If skipping last track stops playback, update button? Might be complex.
                                // Let getPlaylistStatus handle the display logic for now.
                            }
                            needsGeneralUpdate = true;
                            break;

                        case 'stop':
                            await i.deferUpdate();
                            if (isMusicPlaying(i)) { 
                               await voiceService.musicService.stop();
                            }
                            // No need to update button labels here, isMusicPlaying check will hide musicRow
                            needsGeneralUpdate = true;
                            break;

                        case 'volume':
                            // Volume button click: defer and show ONLY volume menu
                            await i.deferUpdate();
                            await i.editReply({
                                content: '🔊 Volume Control\nSelect a volume level:',
                                components: [volumeRow], // Only show volume row
                                ephemeral: true
                            });
                            return; // <- Return: Don't run general update

                        case 'volume_level':
                            // Volume selection: defer, set volume, update placeholder, mark for general update
                            await i.deferUpdate(); // Defer the select menu interaction
                            const level = parseInt(i.values[0]);
                            await voiceService.musicService.setVolume(level);
                            volumeRow.components[0].setPlaceholder(`Volume: ${level}%`);
                            needsGeneralUpdate = true; // Mark to refresh the main controls view
                            break; // Go to general update

                        case 'queue':
                            // Queue button click: defer and show queue UI
                            await i.deferUpdate();
                            const queue = voiceService.musicService.getQueue();
                            // createTrackListUI handles its own reply/editReply
                            await createTrackListUI(i, queue, 'Music Queue');
                            return; // <- Return: Don't run general update

                        case 'shuffle':
                            await i.deferUpdate();
                            await voiceService.musicService.shufflePlaylist(); 
                            // Update button label based on the NEW state
                            const shuffleStatus = getPlaylistStatus(i); 
                            playlistRow.components[0].setLabel(shuffleStatus.isShuffleEnabled ? '🔀 Shuffle: On' : 'Shuffle');
                            needsGeneralUpdate = true;
                            break;

                        case 'repeat':
                            await i.deferUpdate();
                            await voiceService.musicService.toggleRepeat();
                            // Update button label based on the NEW state
                            const repeatStatus = getPlaylistStatus(i); 
                            playlistRow.components[1].setLabel(repeatStatus.isRepeatEnabled ? '🔁 Repeat: On' : 'Repeat');
                            needsGeneralUpdate = true;
                            break;

                        case 'playlist':
                            // Playlist button click: show modal (handles its own reply)
                            await handlePlaylistSelection(i); // showModal is the reply
                            return; // <- Return: Don't run general update
                    }

                    // --- General Update Logic (runs if needsGeneralUpdate is true) ---
                    if (needsGeneralUpdate) {
                        let content = '🎵 Goobster Controls\n\nAnyone in the voice channel can use these controls!';
                        const playlistStatus = getPlaylistStatus(i);
                        if (playlistStatus) {
                            const { currentTrack, isShuffleEnabled, isRepeatEnabled, remainingTracks } = playlistStatus;
                             // Ensure pause/resume button reflects current state after action
                            if (voiceService.musicService.player.state.status === 'paused') {
                                musicRow.components[0].setLabel('Resume').setCustomId('resume');
                            } else {
                                musicRow.components[0].setLabel('Pause').setCustomId('pause');
                            }
                            // Update shuffle/repeat labels as well
                             playlistRow.components[0].setLabel(isShuffleEnabled ? '🔀 Shuffle: On' : 'Shuffle');
                             playlistRow.components[1].setLabel(isRepeatEnabled ? '🔁 Repeat: On' : 'Repeat');

                            if (currentTrack) {
                                const { artist, title } = parseTrackName(currentTrack.name);
                                content += `\n\nNow Playing: ${title}\nby ${artist}`;
                                content += `\n${isShuffleEnabled ? '🔀 Shuffle: On' : ''} ${isRepeatEnabled ? '🔁 Repeat: On' : ''}`;
                                content += `\nTracks remaining: ${remainingTracks}`;
                            } else {
                                content += '\n\nPlayback stopped.'; // Or Queue finished
                            }
                        } else {
                             content += '\n\nPlayback stopped.';
                        }

                        // Determine components based on *current* playing state
                        const updatedComponents = [commonRow];
                        if (isMusicPlaying(i)) { // isMusicPlaying checks service, isPlaying flag, and currentTrack
                            updatedComponents.push(musicRow, volumeRow, playlistRow);
                        } else {
                            // Show volume/queue/playlist even when stopped
                            updatedComponents.push(volumeRow, playlistRow); 
                        }

                        // Use editReply because we deferred 'i' in the cases leading here
                        await i.editReply({
                            content: content,
                            components: updatedComponents
                        });
                    }
                    // If needsGeneralUpdate was false (e.g., handled by return), we do nothing more here

                } catch (error) {
                    console.error('Error handling control:', error);
                     try {
                        // Use followUp for error messages as interaction might be acknowledged
                        await i.followUp({ 
                            content: '❌ An error occurred while processing your request.',
                            ephemeral: true 
                        });
                    } catch (followUpError) {
                         // Log if the followUp itself fails (e.g., interaction truly gone)
                         console.error('Error sending follow-up message:', followUpError);
                    }
                }
            });

            collector.on('end', () => {
                // Disable all buttons when collector ends
                const allComponents = [commonRow, musicRow, volumeRow, playlistRow];
                allComponents.forEach(row => {
                    row.components.forEach(component => {
                        if (component instanceof ButtonBuilder) {
                            component.setDisabled(true);
                        } else if (component instanceof StringSelectMenuBuilder) {
                            component.setDisabled(true);
                        }
                    });
                });

                interaction.editReply({ 
                    components: allComponents
                }).catch(() => {});
            });

        } catch (error) {
            console.error('Error in context menu:', error);
            await interaction.reply({ 
                content: '❌ An error occurred while processing your request.',
                ephemeral: true 
            });
        }
    },

    modalSubmit: handleModalSubmit
}; 