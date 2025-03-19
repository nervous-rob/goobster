const { SlashCommandBuilder } = require('discord.js');
const { PermissionFlagsBits } = require('discord.js');
const MusicService = require('../../services/voice/musicService');
const { ProgressTracker } = require('../../utils');
const config = require('../../config.json');
const path = require('path');
const fs = require('fs').promises;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generateallmusic')
        .setDescription('Generate and cache music for all moods (Admin only)')
        .addBooleanOption(option =>
            option.setName('force')
                .setDescription('Force regeneration even if files exist')
                .setRequired(false))
        .addIntegerOption(option => 
            option.setName('concurrency')
                .setDescription('Number of tracks to generate in parallel (1-3)')
                .setMinValue(1)
                .setMaxValue(3)
                .setRequired(false)),

    async execute(interaction, providedMusicService) {
        // Check if user has admin permission
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({ content: 'This command is only available to administrators.', ephemeral: true });
            return;
        }

        try {
            await interaction.deferReply();
            console.log('Deferred reply successfully for generateallmusic');
            
            const force = interaction.options.getBoolean('force') || false;
            let concurrency = interaction.options.getInteger('concurrency') || 1;
            
            // Verify config has required properties before creating service
            if (!config?.replicate?.apiKey) {
                await interaction.editReply(`❌ Error: Replicate API key is missing from the configuration.\n\nDebug info: Config has replicate object: ${config.replicate ? 'Yes' : 'No'}`);
                console.error('Missing Replicate API key in config. Config structure:', JSON.stringify({
                    hasReplicate: !!config.replicate,
                    hasReplicateApiKey: !!(config.replicate && config.replicate.apiKey)
                }));
                return;
            }
            
            // Use the provided music service or create a new one
            let musicService = providedMusicService;
            if (!musicService) {
                console.log('No music service provided, creating a new instance');
                musicService = new MusicService(config);
            }
            
            const moods = Object.keys(musicService.getMoodMap());
            
            // Get mood emojis for better visual feedback
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
            
            // Initialize progress tracker
            const progress = new ProgressTracker({
                interaction,
                type: 'music',
                itemName: moods,
                force,
                emoji: '🎵',
                updateInterval: 5000 // Slightly longer interval for multi-item tracking
            });
            
            await progress.start();
            await progress.update('preparing');
            
            // Track rate limiting for adaptive concurrency
            let rateLimitDetected = false;
            
            // Process moods with limited concurrency
            const processMood = async (mood) => {
                try {
                    // Update status to processing
                    await progress.markItem(mood, 'processing');
                    
                    const exists = await musicService.doesMoodMusicExist(mood);
                    if (exists && !force) {
                        await progress.markItem(mood, 'skipped');
                        return false; // Return false to indicate no rate limiting
                    }

                    // Generate the music
                    const result = await musicService.generateAndCacheMoodMusic(mood, force);
                    await progress.markItem(mood, 'completed');
                    
                    // Check if rate limiting was detected during this operation
                    return result && result.rateLimited;
                } catch (error) {
                    console.error(`Error generating music for mood ${mood}:`, error);
                    
                    // Check if this was a rate limiting error
                    const isRateLimit = error.message && (
                        error.message.includes('Rate limit') || 
                        error.message.includes('Too Many Requests') ||
                        (error.response && error.response.status === 429)
                    );
                    
                    // Add more detailed error info to the status
                    const errorType = isRateLimit ? 'Rate Limit' :
                                     error.message.includes('422') ? 'API Error (422)' : 
                                     error.message.includes('timeout') ? 'Timeout' : 
                                     error.message.includes('Too many consecutive errors') ? 'API Connection' : 'Unknown';
                    
                    await progress.markItem(mood, 'failed', { errorType, errorMessage: error.message });
                    return isRateLimit; // Return whether rate limiting was detected
                }
            };
            
            // Chunked processing with progress updates and adaptive concurrency
            for (let i = 0; i < moods.length; i += concurrency) {
                // Add delay if rate limiting was detected
                if (rateLimitDetected) {
                    const cooldownDelay = 30000; // 30 seconds cooldown
                    const warningMessage = `⚠️ Rate limiting detected! Reducing concurrency to ${concurrency} and waiting ${cooldownDelay/1000} seconds before continuing...`;
                    console.warn(warningMessage);
                    
                    // Add a delay
                    await new Promise(resolve => setTimeout(resolve, cooldownDelay));
                }
                
                const chunk = moods.slice(i, i + concurrency);
                
                // Start processing chunk
                const chunkPromises = chunk.map(mood => processMood(mood));
                
                // Wait for this chunk to complete
                const chunkResults = await Promise.all(chunkPromises);
                
                // Check if any rate limiting was detected in this chunk
                const wasRateLimited = chunkResults.some(result => result === true);
                
                if (wasRateLimited) {
                    rateLimitDetected = true;
                    
                    // Reduce concurrency if rate limiting was detected and concurrency > 1
                    if (concurrency > 1) {
                        concurrency--;
                        console.warn(`Reducing concurrency to ${concurrency} due to rate limiting`);
                    }
                }
            }

            // Complete with final status
            await progress.complete('completed');
            
        } catch (error) {
            console.error('Error in generateallmusic command:', error);
            const errorMessage = `❌ Error: ${error.message}\n\nDebug info: Replicate API key available in config: ${config.replicate?.apiKey ? 'Yes (key length: ' + config.replicate.apiKey.length + ')' : 'No'}`;
            
            try {
                await interaction.editReply(errorMessage);
            } catch (replyError) {
                console.error('Failed to send error message, trying alternative method:', replyError);
                
                // Last resort - try to send a new message to the channel
                try {
                    await interaction.channel.send(errorMessage);
                } catch (finalError) {
                    console.error('All attempts to send error message failed:', finalError);
                }
            }
        }
    },
}; 