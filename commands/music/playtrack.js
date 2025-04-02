const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const SpotDLService = require('../../services/spotdl/spotdlService');
const { getVoiceService } = require('../../services/voice');

const spotdlService = new SpotDLService();

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
        const voiceService = getVoiceService();

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

            switch (subcommand) {
                case 'play': {
                    const trackName = interaction.options.getString('track');
                    const trackUrl = await spotdlService.getTrackUrl(trackName);
                    
                    if (!voiceService) {
                        await interaction.editReply('Voice service is not initialized. Please try again later.');
                        return;
                    }

                    // Join voice channel and play the track
                    await voiceService.joinChannel(interaction.member.voice.channel);
                    await voiceService.playAudio(trackUrl);

                    const embed = new EmbedBuilder()
                        .setColor('#00ff00')
                        .setTitle('Now Playing')
                        .setDescription(`🎵 ${trackName}`)
                        .addFields(
                            { name: 'Status', value: '▶️ Playing', inline: true },
                            { name: 'Volume', value: `${voiceService.getVolume()}%`, inline: true }
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
                                await voiceService.pause();
                                embed.setFields(
                                    { name: 'Status', value: '⏸️ Paused', inline: true },
                                    { name: 'Volume', value: `${voiceService.getVolume()}%`, inline: true }
                                );
                                row.components[0].setLabel('Resume');
                                break;
                            case 'skip':
                                await voiceService.skip();
                                embed.setFields(
                                    { name: 'Status', value: '⏭️ Skipped', inline: true },
                                    { name: 'Volume', value: `${voiceService.getVolume()}%`, inline: true }
                                );
                                break;
                            case 'stop':
                                await voiceService.stop();
                                embed.setFields(
                                    { name: 'Status', value: '⏹️ Stopped', inline: true },
                                    { name: 'Volume', value: `${voiceService.getVolume()}%`, inline: true }
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
                    const queue = voiceService.getQueue();
                    if (!queue || queue.length === 0) {
                        await interaction.editReply('The queue is empty.');
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setColor('#0099ff')
                        .setTitle('Music Queue')
                        .setDescription(queue.map((track, index) => {
                            // Parse the filename to extract artist and song
                            const filename = String(track.name || 'Unknown Track').replace('.mp3', '');
                            const [artist, ...songParts] = filename.split(' - ');
                            const song = songParts.join(' - '); // Rejoin in case song title contains dashes
                            
                            return `${index + 1}. ${song}\n` +
                                   `   by ${artist}\n`;
                        }).join('\n'))
                        .setTimestamp();

                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                case 'skip': {
                    await voiceService.skip();
                    await interaction.editReply('⏭️ Skipped current track');
                    break;
                }

                case 'pause': {
                    await voiceService.pause();
                    await interaction.editReply('⏸️ Paused playback');
                    break;
                }

                case 'resume': {
                    await voiceService.resume();
                    await interaction.editReply('▶️ Resumed playback');
                    break;
                }

                case 'stop': {
                    await voiceService.stop();
                    await interaction.editReply('⏹️ Stopped playback and cleared queue');
                    break;
                }

                case 'volume': {
                    const level = interaction.options.getInteger('level');
                    await voiceService.setVolume(level);
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