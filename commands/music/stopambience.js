const { SlashCommandBuilder } = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const AmbientService = require('../../services/voice/ambientService');
const config = require('../../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stopambience')
        .setDescription('Stop playing ambient sound effects'),

    async execute(interaction) {
        try {
            // Get the voice connection for this guild
            const connection = getVoiceConnection(interaction.guildId);
            
            if (!connection) {
                await interaction.reply('No ambient sounds are currently playing.');
                return;
            }

            // Initialize ambient service and stop playback
            const ambientService = new AmbientService(config);
            ambientService.stopAmbience();
            
            // Destroy the connection if no other audio is playing
            connection.destroy();

            await interaction.reply('🎧 Stopped playing ambient sounds.');
        } catch (error) {
            console.error('Error stopping ambient sounds:', error);
            await interaction.reply('Failed to stop ambient sounds. Please try again.');
        }
    },
}; 