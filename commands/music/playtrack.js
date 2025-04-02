const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const SpotDLService = require('../../services/spotdl/spotdlService');
const VoiceService = require('../../services/voice');

const spotdlService = new SpotDLService();
const voiceService = new VoiceService();

// Helper function to parse track names
function parseTrackName(filename) {
    if (!filename) return { artist: 'Unknown Artist', title: 'Unknown Track' };
    
    // Remove file extension
    const nameWithoutExt = filename.replace(/\.(mp3|m4a|wav)$/i, '');
    
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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playtrack')
        .setDescription('Play and manage music tracks')
        .addSubcommand(subcommand =>
            subcommand
                .setName('play')
                .setDescription('Play a track')
                .addStringOption(option =>
                    option.setName('track')
                        .setDescription('Name of the track to play')
                        .setRequired(true)))
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
                        .setMaxValue(100))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            await interaction.deferReply();

            // Check if user is in a voice channel for relevant commands
            if (['play', 'pause', 'resume', 'skip', 'stop', 'volume'].includes(subcommand)) {
                const voiceChannel = interaction.member.voice.channel;
                if (!voiceChannel) {
                    await interaction.editReply('You need to be in a voice channel to use this command!');
                    return;
                }
            }

            // Initialize voice service if not already initialized
            if (!voiceService._isInitialized) {
                await voiceService.initialize();
            }

            switch (subcommand) {
                case 'play': {
                    const trackName = interaction.options.getString('track');
                    const trackUrl = await spotdlService.getTrackUrl(trackName);
                    
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized. Please try again later.');
                        return;
                    }

                    // Join voice channel and play the track
                    await voiceService.musicService.joinChannel(interaction.member.voice.channel);
                    await voiceService.musicService.playAudio(trackUrl);

                    const { artist, title } = parseTrackName(trackName);
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
                        if (i.user.id !== interaction.user.id) {
                            return i.reply({ content: 'Only the command user can use these controls!', ephemeral: true });
                        }

                        switch (i.customId) {
                            case 'pause':
                                await voiceService.musicService.pause();
                                embed.setFields(
                                    { name: 'Status', value: '⏸️ Paused', inline: true },
                                    { name: 'Volume', value: `${voiceService.musicService.getVolume()}%`, inline: true }
                                );
                                row.components[0].setLabel('Resume');
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

                    break;
                }

                case 'queue': {
                    if (!voiceService.musicService) {
                        await interaction.editReply('Music service is not initialized. Please try again later.');
                        return;
                    }

                    const queue = voiceService.musicService.getQueue();
                    if (!queue || queue.length === 0) {
                        await interaction.editReply('The queue is empty.');
                        return;
                    }

                    // Create search menu
                    const searchRow = new ActionRowBuilder()
                        .addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('search')
                                .setPlaceholder('Search tracks...')
                                .addOptions(
                                    queue.slice(0, 25).map(track => ({
                                        label: String(track.name || 'Unknown Track').slice(0, 100),
                                        value: String(track.name || 'unknown').slice(0, 100),
                                        description: formatTrackName(track).slice(0, 50)
                                    }))
                                )
                        );

                    const embed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Music Queue')
                        .setDescription(queue.map((track, index) => 
                            `${index + 1}. ${formatTrackName(track)}`
                        ).join('\n\n'))
                        .setTimestamp();

                    const message = await interaction.editReply({ 
                        embeds: [embed], 
                        components: [searchRow]
                    });

                    // Create button collector
                    const collector = message.createMessageComponentCollector({ 
                        time: 300000 // 5 minutes
                    });

                    collector.on('collect', async (i) => {
                        if (i.user.id !== interaction.user.id) {
                            return i.reply({ 
                                content: 'Only the command user can use these controls!', 
                                ephemeral: true 
                            });
                        }

                        if (i.customId === 'search') {
                            const selectedTrack = i.values[0];
                            const trackIndex = queue.findIndex(t => String(t.name) === selectedTrack);
                            if (trackIndex !== -1) {
                                // Highlight the selected track in the description
                                const description = queue.map((track, index) => {
                                    const formattedTrack = formatTrackName(track);
                                    return `${index + 1}. ${index === trackIndex ? '**' + formattedTrack + '**' : formattedTrack}`;
                                }).join('\n\n');

                                const updatedEmbed = new EmbedBuilder()
                                    .setColor('#0099ff')
                                    .setTitle('Music Queue')
                                    .setDescription(description)
                                    .setTimestamp();

                                await i.update({ 
                                    embeds: [updatedEmbed], 
                                    components: [searchRow]
                                });
                            }
                        }
                    });

                    collector.on('end', () => {
                        searchRow.components.forEach(menu => menu.setDisabled(true));
                        interaction.editReply({ 
                            embeds: [embed], 
                            components: [searchRow]
                        }).catch(() => {});
                    });

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