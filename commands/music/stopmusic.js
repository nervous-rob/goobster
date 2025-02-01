const { SlashCommandBuilder } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const MusicService = require('../../services/voice/musicService');
const config = require('../../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stopmusic')
        .setDescription('Stop the currently playing background music'),

    async execute(interaction) {
        try {
            await interaction.deferReply();

            // Check if user is in a voice channel
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.editReply('You need to be in a voice channel to stop music!');
                return;
            }

            // Get the voice connection for this guild
            const connection = getVoiceConnection(interaction.guild.id);
            if (!connection) {
                await interaction.editReply('No music is currently playing!');
                return;
            }

            // Initialize music service
            const musicService = new MusicService(config);

            // Fade out and stop the music
            await interaction.editReply('🎵 Fading out music...');
            await musicService.fadeOutAndStop();
            
            // Destroy the connection after fade out
            connection.destroy();

            await interaction.editReply('🎵 Music stopped!');
        } catch (error) {
            console.error('Error in stopmusic command:', error);
            // If we haven't replied yet, use reply, otherwise use editReply
            try {
                if (interaction.deferred) {
                    await interaction.editReply('An error occurred while stopping the music.');
                } else {
                    await interaction.reply('An error occurred while stopping the music.');
                }
            } catch (replyError) {
                console.error('Failed to send error message:', replyError);
            }
        }
    },
}; 