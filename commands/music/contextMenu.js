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

                try {
                    // Check if music service is initialized
                    if (!voiceService.musicService) {
                        return i.reply({
                            content: '❌ Music service is not initialized. Please try again later.',
                            ephemeral: true
                        });
                    }

                    switch (i.customId) {
                        case 'pause':
                            if (isMusicPlaying(i)) {
                                await voiceService.musicService.pause();
                                musicRow.components[0].setLabel('Resume').setCustomId('resume');
                            }
                            break;
                        case 'resume':
                            if (voiceService.musicService) {
                                await voiceService.musicService.resume();
                                musicRow.components[0].setLabel('Pause').setCustomId('pause');
                            }
                            break;
                        case 'skip':
                            if (isMusicPlaying(i)) {
                                await voiceService.musicService.skip();
                            }
                            break;
                        case 'stop':
                            if (isMusicPlaying(i)) {
                                await voiceService.musicService.stop();
                            }
                            break;
                        case 'volume':
                            // Show volume menu
                            await i.deferUpdate();
                            await i.editReply({
                                content: '🔊 Volume Control\nSelect a volume level:',
                                components: [volumeRow],
                                ephemeral: true
                            });
                            return;
                        case 'volume_level':
                            if (voiceService.musicService) {
                                await i.deferUpdate();
                                const level = parseInt(i.values[0]);
                                await voiceService.musicService.setVolume(level);
                                volumeRow.components[0].setPlaceholder(`Volume: ${level}%`);
                                
                                // Update the message content and components
                                let content = '🎵 Goobster Controls\n\nAnyone in the voice channel can use these controls!';
                                const playlistStatus = getPlaylistStatus(i);
                                if (playlistStatus) {
                                    const { currentTrack, isShuffleEnabled, isRepeatEnabled, remainingTracks } = playlistStatus;
                                    const { artist, title } = parseTrackName(currentTrack.name);
                                    content += `\n\nNow Playing: ${title}\nby ${artist}`;
                                    content += `\n${isShuffleEnabled ? '🔀 Shuffle: On' : ''} ${isRepeatEnabled ? '🔁 Repeat: On' : ''}`;
                                    content += `\nTracks remaining: ${remainingTracks}`;
                                }
                                content += `\n\nVolume set to ${level}%`;

                                const updatedComponents = [commonRow];
                                if (isMusicPlaying(i)) {
                                    updatedComponents.push(musicRow, volumeRow, playlistRow);
                                }

                                await i.editReply({
                                    content: content,
                                    components: updatedComponents,
                                    ephemeral: true
                                });
                            }
                            return;
                        case 'queue':
                            if (voiceService.musicService) {
                                const queue = voiceService.musicService.getQueue();
                                await createTrackListUI(i, queue, 'Music Queue');
                            }
                            break;
                        case 'shuffle':
                            if (voiceService.musicService) {
                                await voiceService.musicService.shufflePlaylist();
                                const status = getPlaylistStatus(i);
                                playlistRow.components[0].setLabel(status.isShuffleEnabled ? '🔀 Shuffle: On' : 'Shuffle');
                            }
                            break;
                        case 'repeat':
                            if (voiceService.musicService) {
                                await voiceService.musicService.toggleRepeat();
                                const status = getPlaylistStatus(i);
                                playlistRow.components[1].setLabel(status.isRepeatEnabled ? '🔁 Repeat: On' : 'Repeat');
                            }
                            break;
                        case 'playlist':
                            await handlePlaylistSelection(i);
                            break;
                    }

                    // Update the message content and components
                    let content = '🎵 Goobster Controls\n\nAnyone in the voice channel can use these controls!';
                    
                    const playlistStatus = getPlaylistStatus(i);
                    if (playlistStatus) {
                        const { currentTrack, isShuffleEnabled, isRepeatEnabled, remainingTracks } = playlistStatus;
                        const { artist, title } = parseTrackName(currentTrack.name);
                        
                        content += `\n\nNow Playing: ${title}\nby ${artist}`;
                        content += `\n${isShuffleEnabled ? '🔀 Shuffle: On' : ''} ${isRepeatEnabled ? '🔁 Repeat: On' : ''}`;
                        content += `\nTracks remaining: ${remainingTracks}`;
                    }

                    // Update the original message with current state
                    const updatedComponents = [commonRow];
                    if (isMusicPlaying(i)) {
                        updatedComponents.push(musicRow, volumeRow, playlistRow);
                    }

                    await i.update({
                        content: content,
                        components: updatedComponents
                    });
                } catch (error) {
                    console.error('Error handling control:', error);
                    await i.reply({ 
                        content: '❌ An error occurred while processing your request.',
                        ephemeral: true 
                    });
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