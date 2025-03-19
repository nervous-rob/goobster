const { SlashCommandBuilder } = require('discord.js');
const MusicService = require('../../services/voice/musicService');
const config = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('regeneratemusic')
        .setDescription('Regenerate music for a specific mood')
        .addStringOption(option =>
            option.setName('mood')
                .setDescription('The mood of the music to regenerate')
                .setRequired(true)
                .addChoices(
                    { name: '⚔️ Battle', value: 'battle' },
                    { name: '🌄 Exploration', value: 'exploration' },
                    { name: '🔍 Mystery', value: 'mystery' },
                    { name: '🎉 Celebration', value: 'celebration' },
                    { name: '⚠️ Danger', value: 'danger' },
                    { name: '🌿 Peaceful', value: 'peaceful' },
                    { name: '😢 Sad', value: 'sad' },
                    { name: '🎭 Dramatic', value: 'dramatic' }
                )),

    async execute(interaction) {
        await interaction.deferReply();

        const mood = interaction.options.getString('mood');
        
        // Get the mood emoji
        const moodEmojis = {
            'battle': '⚔️',
            'exploration': '🌄',
            'mystery': '🔍',
            'celebration': '🎉',
            'danger': '⚠️',
            'peaceful': '🌿',
            'sad': '😢',
            'dramatic': '🎭'
        };
        const moodEmoji = moodEmojis[mood] || '🎵';
        
        try {
            await interaction.editReply(`${moodEmoji} Regenerating **${mood}** music... This may take a few minutes.`);
            
            const musicService = new MusicService(config);
            
            // Check if the music already exists
            const exists = await musicService.doesMoodMusicExist(mood);
            if (!exists) {
                await interaction.editReply(`${moodEmoji} Generating **${mood}** music for the first time... This may take a few minutes.`);
            }
            
            await musicService.generateAndCacheMoodMusic(mood, true); // true for force regenerate
            
            await interaction.editReply(`${moodEmoji} Successfully regenerated music for **${mood}** mood!\n\nUse \`/playmusic mood:${mood}\` to play it.`);
        } catch (error) {
            console.error(`Error regenerating music for mood ${mood}:`, error);
            await interaction.editReply(`❌ Failed to regenerate music for **${mood}** mood.\n\nError: ${error.message}\n\nPlease try again later.`);
        }
    },
}; 