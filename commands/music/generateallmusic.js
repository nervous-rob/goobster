const { SlashCommandBuilder } = require('discord.js');
const MusicService = require('../../services/voice/musicService');
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

    async execute(interaction) {
        // Check if user has admin permission
        if (!interaction.member.permissions.has('ADMINISTRATOR')) {
            await interaction.reply({ content: 'This command is only available to administrators.', ephemeral: true });
            return;
        }

        // Save channel reference before deferring
        const channel = interaction.channel;
        let progressMessage = null;
        
        try {
            await interaction.deferReply();
            progressMessage = await interaction.fetchReply();
        } catch (error) {
            console.warn('Failed to defer reply, will use channel messages for updates:', error.message);
            try {
                progressMessage = await channel.send('🎵 Initializing music generation...');
            } catch (channelError) {
                console.error('Could not send message to channel:', channelError);
                return;
            }
        }

        const force = interaction.options.getBoolean('force') || false;
        let concurrency = interaction.options.getInteger('concurrency') || 1;
        
        try {
            // Verify config has required properties before creating service
            if (!config?.replicate?.apiKey) {
                await safeMessageUpdate(progressMessage, `❌ Error: Replicate API key is missing from the configuration.\n\nDebug info: Config has replicate object: ${config.replicate ? 'Yes' : 'No'}`);
                console.error('Missing Replicate API key in config. Config structure:', JSON.stringify({
                    hasReplicate: !!config.replicate,
                    hasReplicateApiKey: !!(config.replicate && config.replicate.apiKey)
                }));
                return;
            }
            
            const musicService = new MusicService(config);
            const moods = Object.keys(musicService.getMoodMap());
            
            await safeMessageUpdate(progressMessage, `🎵 Starting generation of ${moods.length} mood tracks with concurrency level ${concurrency}...`);
            
            let successCount = 0;
            let failCount = 0;
            let skipCount = 0;
            let rateLimitDetected = false;
            
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
            
            // Create progress table
            const createProgressTable = (moods, inProgress, status) => {
                let table = '```\n';
                table += 'MOOD          | STATUS      | EMOJI\n';
                table += '--------------|-------------|------\n';
                
                for (const mood of moods) {
                    const emoji = moodEmojis[mood] || '🎵';
                    let moodStatus = '⏳ Pending';
                    
                    if (status[mood]) {
                        moodStatus = status[mood];
                    }
                    
                    // Highlight in-progress moods
                    const isInProgress = inProgress.includes(mood);
                    
                    table += `${isInProgress ? '→ ' : '  '}${mood.padEnd(12)}| ${moodStatus.padEnd(11)}| ${emoji}\n`;
                }
                
                table += '```';
                return table;
            };
            
            // Keep track of each mood's status
            const moodStatus = {};
            
            // Process moods with limited concurrency
            const processMood = async (mood) => {
                try {
                    // Update status to processing
                    moodStatus[mood] = '🔄 Processing';
                    
                    const exists = await musicService.doesMoodMusicExist(mood);
                    if (exists && !force) {
                        skipCount++;
                        moodStatus[mood] = '⏭️ Skipped';
                        return false; // Return false to indicate no rate limiting
                    }

                    // Generate the music
                    const result = await musicService.generateAndCacheMoodMusic(mood, force);
                    successCount++;
                    moodStatus[mood] = '✅ Done';
                    
                    // Check if rate limiting was detected during this operation
                    return result && result.rateLimited;
                } catch (error) {
                    console.error(`Error generating music for mood ${mood}:`, error);
                    failCount++;
                    
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
                    
                    moodStatus[mood] = `❌ Failed (${errorType})`;
                    return isRateLimit; // Return whether rate limiting was detected
                }
            };
            
            // Helper function to safely update messages without throwing on expired interactions
            async function safeMessageUpdate(message, content) {
                try {
                    if (message) {
                        if (message.edit) {
                            await message.edit(content);
                        } else {
                            await message.channel.send(content);
                        }
                    } else {
                        await channel.send(content);
                    }
                } catch (error) {
                    console.warn('Could not update progress message, creating new message:', error.message);
                    try {
                        progressMessage = await channel.send(content);
                    } catch (channelError) {
                        console.error('Failed to send update to channel:', channelError);
                    }
                }
            }
            
            // Chunked processing with progress updates and adaptive concurrency
            for (let i = 0; i < moods.length; i += concurrency) {
                // Add delay if rate limiting was detected
                if (rateLimitDetected) {
                    const cooldownDelay = 30000; // 30 seconds cooldown
                    const warningMessage = `⚠️ Rate limiting detected! Reducing concurrency to ${concurrency} and waiting ${cooldownDelay/1000} seconds before continuing...`;
                    console.warn(warningMessage);
                    await safeMessageUpdate(progressMessage, `${warningMessage}\n\n${createProgressTable(moods, [], moodStatus)}`);
                    await new Promise(resolve => setTimeout(resolve, cooldownDelay));
                }
                
                const chunk = moods.slice(i, i + concurrency);
                
                // Update status of pending chunk
                await safeMessageUpdate(progressMessage, 
                    `🎵 Generating mood tracks... (${successCount + skipCount + failCount}/${moods.length})\n` +
                    `✅ Completed: ${successCount}  ⏭️ Skipped: ${skipCount}  ❌ Failed: ${failCount}` +
                    (rateLimitDetected ? `  ⚠️ Rate limiting detected` : '') + 
                    `\n\n${createProgressTable(moods, chunk, moodStatus)}`
                );
                
                // Start processing chunk
                const chunkPromises = chunk.map(mood => processMood(mood));
                
                // Update progress while this chunk is processing
                const updateInterval = setInterval(async () => {
                    const progressContent = 
                        `🎵 Generating mood tracks... (${successCount + skipCount + failCount}/${moods.length})\n` +
                        `✅ Completed: ${successCount}  ⏭️ Skipped: ${skipCount}  ❌ Failed: ${failCount}` +
                        (rateLimitDetected ? `  ⚠️ Rate limiting detected` : '') + 
                        `\n\n${createProgressTable(moods, chunk, moodStatus)}`;
                    
                    await safeMessageUpdate(progressMessage, progressContent).catch(console.error);
                }, 5000);
                
                // Wait for this chunk to complete
                const chunkResults = await Promise.all(chunkPromises);
                clearInterval(updateInterval);
                
                // Check if any rate limiting was detected in this chunk
                const wasRateLimited = chunkResults.some(result => result === true);
                
                if (wasRateLimited) {
                    rateLimitDetected = true;
                    
                    // Reduce concurrency if rate limiting was detected and concurrency > 1
                    if (concurrency > 1) {
                        concurrency--;
                        await safeMessageUpdate(progressMessage, 
                            `⚠️ Rate limiting detected! Reducing concurrency to ${concurrency}...\n\n` +
                            createProgressTable(moods, [], moodStatus)
                        );
                    }
                }
                
                // Update progress after chunk completes
                const progressContent = 
                    `🎵 Generating mood tracks... (${successCount + skipCount + failCount}/${moods.length})\n` +
                    `✅ Completed: ${successCount}  ⏭️ Skipped: ${skipCount}  ❌ Failed: ${failCount}` +
                    (rateLimitDetected ? `  ⚠️ Rate limiting detected` : '') + 
                    `\n\n${createProgressTable(moods, [], moodStatus)}`;
                
                await safeMessageUpdate(progressMessage, progressContent);
            }

            // Calculate completion percentage
            const completionPercent = Math.round((successCount / moods.length) * 100);
            
            const finalMessage = 
                `🎵 Music generation complete! (${completionPercent}% success rate)\n\n` +
                `✅ Successfully generated: ${successCount}\n` +
                `⏭️ Skipped (already exists): ${skipCount}\n` +
                `❌ Failed: ${failCount}\n` +
                (rateLimitDetected ? `⚠️ Rate limiting was encountered during generation\n` : '') +
                `\n${createProgressTable(moods, [], moodStatus)}` + 
                `\nUse \`/playmusic\` to enjoy the generated music!`;

            await safeMessageUpdate(progressMessage, finalMessage);
        } catch (error) {
            console.error('Error in generateallmusic command:', error);
            const errorMessage = `❌ Error: ${error.message}\n\nDebug info: Replicate API key available in config: ${config.replicate?.apiKey ? 'Yes (key length: ' + config.replicate.apiKey.length + ')' : 'No'}`;
            
            await safeMessageUpdate(progressMessage, errorMessage).catch(() => {
                // Last resort - try to send a new message to the channel
                channel.send(errorMessage).catch(console.error);
            });
        }
    },
}; 