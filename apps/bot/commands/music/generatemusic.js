const { SlashCommandBuilder } = require('discord.js');
const MusicService = require('@goobster/core/services/voice/musicService');
const { ProgressTracker } = require('@goobster/core/utils');
const config = require('../../../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generatemusic')
        .setDescription('Generate music for a specific mood')
        .addStringOption(option =>
            option.setName('mood')
                .setDescription('The mood of the music to generate')
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
                ))
        .addBooleanOption(option =>
            option.setName('force')
                .setDescription('Force regeneration even if files exist')
                .setRequired(false)),

    async execute(interaction) {
        console.log('Starting generatemusic command execution');
        
        try {
            await interaction.deferReply();
            console.log('Deferred reply successfully');
            
            const mood = interaction.options.getString('mood');
            const force = interaction.options.getBoolean('force') || false;
            console.log(`Generating ${mood} music with force=${force}`);
            
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
            
            // Initialize the music service
            const musicService = new MusicService(config);
            console.log('MusicService initialized');
            
            // Check if the music already exists
            let exists = false;
            try {
                exists = await musicService.doesMoodMusicExist(mood);
                console.log(`${mood} music exists: ${exists}`);
            } catch (error) {
                console.error('Error checking if music exists:', error);
                await interaction.editReply(`❌ Error checking if music exists: ${error.message}`);
                return;
            }
            
            // Initialize the progress tracker
            const progress = new ProgressTracker({
                interaction,
                type: 'music',
                itemName: mood,
                exists,
                force,
                emoji: moodEmojis[mood] || '🎵',
                useTable: true
            });
            
            // Start tracking progress
            await progress.start();
            
            // Handle existing music without force regeneration
            if (exists && !force) {
                console.log(`${mood} music already exists and force is false, skipping generation`);
                await progress.complete('skipped');
                return;
            }
            
            // Update to generating/regenerating status
            await progress.update(exists ? 'regenerating' : 'generating');
            
            try {
                // Actually generate the music
                console.log(`Starting music generation for ${mood} with force=${force}`);
                await musicService.generateAndCacheMoodMusic(mood, force);
                console.log(`Music generation completed successfully for ${mood}`);
                
                // Complete with success
                await progress.complete('completed');
            } catch (error) {
                // Handle generation error
                console.error(`Error generating music for ${mood}:`, error);
                
                // Determine error type
                let errorType = 'Unknown';
                if (error.message) {
                    if (error.message.includes('Rate limit') || 
                        error.message.includes('Too Many Requests') || 
                        (error.response && error.response.status === 429)) {
                        errorType = 'Rate Limit';
                    } else if (error.message.includes('422')) {
                        errorType = 'API Error (422)';
                    } else if (error.message.includes('timeout')) {
                        errorType = 'Timeout';
                    } else if (error.message.includes('Too many consecutive errors')) {
                        errorType = 'API Connection';
                    }
                }
                
                // Complete with failure
                await progress.complete('failed', {
                    errorType,
                    errorMessage: error.message
                });
            }
        } catch (error) {
            console.error(`Top-level error in generatemusic command:`, error);
            try {
                await interaction.editReply(`❌ Error executing command: ${error.message}\n\nPlease try again later.`);
            } catch (replyError) {
                console.error('Failed to send top-level error message:', replyError);
                try {
                    await interaction.reply(`❌ Error executing command: ${error.message}\n\nPlease try again later.`);
                } catch (finalError) {
                    console.error('All attempts to send error message failed:', finalError);
                }
            }
        }
    },
}; 