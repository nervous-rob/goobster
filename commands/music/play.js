const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { UrlPlayService, classifyUrl } = require('../../services/urlPlayService');
const { voiceService } = require('../../services/serviceManager');
const { parseTrackName } = require('../../utils/musicUtils');

const urlPlayService = new UrlPlayService();

// Helper function to check if a user is in the same voice channel as the bot
function isUserInBotVoiceChannel(interaction) {
    const botVoiceChannel = interaction.guild.members.me.voice.channel;
    if (!botVoiceChannel) return false;

    const userVoiceChannel = interaction.member.voice.channel;
    if (!userVoiceChannel) return false;

    return botVoiceChannel.id === userVoiceChannel.id;
}

function describeClassification(classification) {
    if (classification.source === 'spotify') {
        return `Spotify ${classification.kind}`;
    }
    return classification.kind === 'playlist' ? 'YouTube playlist' : 'YouTube video';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play audio from a YouTube or Spotify URL in your voice channel')
        .addStringOption(option =>
            option.setName('url')
                .setDescription('YouTube video/playlist URL or Spotify track/playlist/album URL')
                .setRequired(true)),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            const url = interaction.options.getString('url');
            const classification = classifyUrl(url);
            if (!classification) {
                await interaction.editReply('❌ Unsupported URL. Please provide a YouTube video/playlist link or a Spotify track/playlist/album link.');
                return;
            }

            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.editReply('❌ You need to be in a voice channel to play music!');
                return;
            }

            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
                await interaction.editReply('❌ I need permissions to join and speak in your voice channel.');
                return;
            }

            if (!voiceService._isInitialized) {
                await voiceService.initialize();
            }
            const musicService = voiceService.musicService;
            if (!musicService) {
                await interaction.editReply('❌ Music service is not initialized. Please try again later.');
                return;
            }

            // Connect right away so the download happens while we're already
            // in the channel. If music is already playing, keep the current
            // session and just queue behind it.
            if (!musicService.isPlaying || !musicService.connection) {
                await musicService.joinChannel(voiceChannel);
            }

            const sourceLabel = describeClassification(classification);
            await interaction.editReply(`🔗 ${sourceLabel} detected - fetching audio (cached tracks play instantly)...`);

            let firstTrack = null;
            let queuedCount = 0;
            // Serialize queue insertions: addToQueue auto-plays when idle, and
            // two near-simultaneous resolutions could otherwise both start.
            let queueChain = Promise.resolve();

            const onTrack = (track) => {
                queueChain = queueChain.then(async () => {
                    await musicService.addToQueue(track);
                    queuedCount++;
                    if (!firstTrack) {
                        firstTrack = track;
                        const { artist, title } = parseTrackName(track.name);
                        await interaction.editReply(
                            `▶️ Now playing: **${title}** by ${artist}` +
                            (classification.kind === 'video' || classification.kind === 'track'
                                ? ''
                                : `\n⏳ Downloading the rest of the ${sourceLabel}...`)
                        ).catch(() => {});
                    }
                }).catch(error => {
                    console.error('Error queueing resolved track:', error);
                });
                return queueChain;
            };

            const { tracks } = await urlPlayService.streamTracks(url, { onTrack });
            await queueChain;

            if (!firstTrack) {
                await interaction.editReply('⚠️ No playable audio was found for that URL.');
                return;
            }

            const { artist, title } = parseTrackName(firstTrack.name);
            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Now Playing')
                .setDescription(`🎵 ${title}\n   by ${artist}`)
                .addFields(
                    { name: 'Source', value: sourceLabel, inline: true },
                    { name: 'Tracks', value: `${tracks.length}`, inline: true },
                    { name: 'Volume', value: `${musicService.getVolume()}%`, inline: true }
                )
                .setTimestamp();

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

            const message = await interaction.editReply({ content: '', embeds: [embed], components: [row] });

            const collector = message.createMessageComponentCollector({ time: 300000 }); // 5 minutes

            collector.on('collect', async (i) => {
                if (!isUserInBotVoiceChannel(i)) {
                    return i.reply({
                        content: '❌ You need to be in the same voice channel as the bot to control music.',
                        ephemeral: true
                    });
                }

                switch (i.customId) {
                    case 'pause':
                        await musicService.pause();
                        embed.setFields(
                            { name: 'Status', value: '⏸️ Paused', inline: true },
                            { name: 'Volume', value: `${musicService.getVolume()}%`, inline: true }
                        );
                        row.components[0].setLabel('Resume').setCustomId('resume');
                        break;
                    case 'resume':
                        await musicService.resume();
                        embed.setFields(
                            { name: 'Status', value: '▶️ Playing', inline: true },
                            { name: 'Volume', value: `${musicService.getVolume()}%`, inline: true }
                        );
                        row.components[0].setLabel('Pause').setCustomId('pause');
                        break;
                    case 'skip':
                        await musicService.skip();
                        embed.setFields(
                            { name: 'Status', value: '⏭️ Skipped', inline: true },
                            { name: 'Volume', value: `${musicService.getVolume()}%`, inline: true }
                        );
                        break;
                    case 'stop':
                        await musicService.stop();
                        embed.setFields(
                            { name: 'Status', value: '⏹️ Stopped', inline: true },
                            { name: 'Volume', value: `${musicService.getVolume()}%`, inline: true }
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
            console.error('Play command error:', error);
            let errorMessage = error.message || 'An error occurred while processing your request.';
            // spotdl surfaces Spotify rate limits as "too many 429 error responses"
            if (/rate limit|429/i.test(errorMessage)) {
                errorMessage = 'Spotify rate limit reached. Add your own Spotify API credentials to config.json to avoid this, or try again in a few minutes.';
            }

            if (interaction.deferred) {
                await interaction.editReply({ content: `❌ ${errorMessage}` }).catch(() => {});
            } else {
                await interaction.reply({ content: `❌ ${errorMessage}`, ephemeral: true }).catch(() => {});
            }
        }
    },
};
