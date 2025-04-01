const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const SpotDLService = require('../../services/spotdl/spotdlService');

const spotdlService = new SpotDLService();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playtrack')
        .setDescription('Play a downloaded track')
        .addStringOption(option =>
            option.setName('track')
                .setDescription('Name of the track to play')
                .setRequired(true)),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            
            // Check if user is in a voice channel
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.editReply('You need to be in a voice channel to play music!');
                return;
            }

            const trackName = interaction.options.getString('track');
            
            // Get track URL from blob storage
            const trackUrl = await spotdlService.getTrackUrl(trackName);
            
            // Get the music service from the client
            const musicService = interaction.client.musicService;
            if (!musicService) {
                await interaction.editReply('Music service is not initialized. Please try again later.');
                return;
            }

            // Join voice channel and play the track
            await musicService.joinChannel(voiceChannel);
            await musicService.playTrack(trackUrl);

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('Now Playing')
                .setDescription(`🎵 ${trackName}`)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('PlayTrack command error:', error);
            const errorMessage = error.message || 'An error occurred while playing the track.';
            
            if (interaction.deferred) {
                await interaction.editReply({ content: `❌ ${errorMessage}`, ephemeral: true });
            } else {
                await interaction.reply({ content: `❌ ${errorMessage}`, ephemeral: true });
            }
        }
    },
}; 