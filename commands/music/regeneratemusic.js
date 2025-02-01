const { SlashCommandBuilder } = require('discord.js');
const MusicService = require('../../services/voice/musicService');
const config = require('../../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('regeneratemusic')
        .setDescription('Regenerate music for a specific mood')
        .addStringOption(option =>
            option.setName('mood')
                .setDescription('The mood of the music to regenerate')
                .setRequired(true)
                .addChoices(
                    { name: 'Battle', value: 'battle' },
                    { name: 'Exploration', value: 'exploration' },
                    { name: 'Mystery', value: 'mystery' },
                    { name: 'Celebration', value: 'celebration' },
                    { name: 'Danger', value: 'danger' },
                    { name: 'Peaceful', value: 'peaceful' },
                    { name: 'Sad', value: 'sad' },
                    { name: 'Dramatic', value: 'dramatic' }
                )),

    async execute(interaction) {
        await interaction.deferReply();

        const mood = interaction.options.getString('mood');
        const musicService = new MusicService(config);

        try {
            await interaction.editReply(`🎵 Regenerating ${mood} music... This may take a few minutes.`);
            
            await musicService.generateAndCacheMoodMusic(mood, true); // true for force regenerate
            
            await interaction.editReply(`✅ Successfully regenerated music for ${mood} mood!`);
        } catch (error) {
            console.error(`Error regenerating music for mood ${mood}:`, error);
            await interaction.editReply(`❌ Failed to regenerate music for ${mood} mood. Please try again later.`);
        }
    },
}; 