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

        await interaction.deferReply();

        const force = interaction.options.getBoolean('force') || false;
        const concurrency = interaction.options.getInteger('concurrency') || 1;
        
        try {
            // Verify config has required properties before creating service
            if (!config?.replicate?.apiKey) {
                await interaction.editReply(`❌ Error: Replicate API key is missing from the configuration.\n\nDebug info: Config has replicate object: ${config.replicate ? 'Yes' : 'No'}`);
                console.error('Missing Replicate API key in config. Config structure:', JSON.stringify({
                    hasReplicate: !!config.replicate,
                    hasReplicateApiKey: !!(config.replicate && config.replicate.apiKey)
                }));
                return;
            }
            
            const musicService = new MusicService(config);
            const moods = Object.keys(musicService.getMoodMap());
            
            await interaction.editReply(`🎵 Starting generation of ${moods.length} mood tracks with concurrency level ${concurrency}...`);
            
            let successCount = 0;
            let failCount = 0;
            let skipCount = 0;
            
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
                        return;
                    }

                    // Generate the music
                    await musicService.generateAndCacheMoodMusic(mood, force);
                    successCount++;
                    moodStatus[mood] = '✅ Done';
                } catch (error) {
                    console.error(`Error generating music for mood ${mood}:`, error);
                    failCount++;
                    
                    // Add more detailed error info to the status
                    const errorType = error.message.includes('422') ? 'API Error (422)' : 
                                     error.message.includes('timeout') ? 'Timeout' : 
                                     error.message.includes('Too many consecutive errors') ? 'API Connection' : 'Unknown';
                    moodStatus[mood] = `❌ Failed (${errorType})`;
                }
            };
            
            // Chunked processing with progress updates
            for (let i = 0; i < moods.length; i += concurrency) {
                const chunk = moods.slice(i, i + concurrency);
                const chunkPromises = chunk.map(mood => processMood(mood));
                
                // Update progress while this chunk is processing
                const updateInterval = setInterval(async () => {
                    const progressMessage = 
                        `🎵 Generating mood tracks... (${successCount + skipCount + failCount}/${moods.length})\n` +
                        `✅ Completed: ${successCount}  ⏭️ Skipped: ${skipCount}  ❌ Failed: ${failCount}\n\n` +
                        createProgressTable(moods, chunk, moodStatus);
                    
                    await interaction.editReply(progressMessage).catch(console.error);
                }, 5000);
                
                // Wait for this chunk to complete
                await Promise.all(chunkPromises);
                clearInterval(updateInterval);
                
                // Update progress after chunk completes
                const progressMessage = 
                    `🎵 Generating mood tracks... (${successCount + skipCount + failCount}/${moods.length})\n` +
                    `✅ Completed: ${successCount}  ⏭️ Skipped: ${skipCount}  ❌ Failed: ${failCount}\n\n` +
                    createProgressTable(moods, [], moodStatus);
                
                await interaction.editReply(progressMessage);
            }

            // Calculate completion percentage
            const completionPercent = Math.round((successCount / moods.length) * 100);
            
            const finalMessage = 
                `🎵 Music generation complete! (${completionPercent}% success rate)\n\n` +
                `✅ Successfully generated: ${successCount}\n` +
                `⏭️ Skipped (already exists): ${skipCount}\n` +
                `❌ Failed: ${failCount}\n\n` +
                createProgressTable(moods, [], moodStatus) + 
                `\nUse \`/playmusic\` to enjoy the generated music!`;

            await interaction.editReply(finalMessage);
        } catch (error) {
            console.error('Error in generateallmusic command:', error);
            await interaction.editReply(`❌ Error: ${error.message}\n\nDebug info: Replicate API key available in config: ${config.replicate?.apiKey ? 'Yes (key length: ' + config.replicate.apiKey.length + ')' : 'No'}`);
        }
    },
}; 