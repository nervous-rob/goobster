const { SlashCommandBuilder } = require('discord.js');
const { PermissionFlagsBits } = require('discord.js');
const AmbientService = require('../../services/voice/ambientService');
const config = require('../../config.json');
const path = require('path');
const fs = require('fs').promises;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generateallambience')
        .setDescription('Generate and cache all ambient sound effects (Admin only)')
        .addBooleanOption(option =>
            option.setName('force')
                .setDescription('Force regeneration even if files exist')
                .setRequired(false))
        .addIntegerOption(option => 
            option.setName('concurrency')
                .setDescription('Number of tracks to generate in parallel (1-2)')
                .setMinValue(1)
                .setMaxValue(2)
                .setRequired(false)),

    async execute(interaction) {
        // Check if user has admin permission
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
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
                progressMessage = await channel.send('🎧 Initializing ambient sound generation...');
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
            
            // Initialize the ambient service
            const ambientService = new AmbientService(config);
            
            const ambienceTypes = Object.keys(ambientService.getAmbienceMap());
            
            await safeMessageUpdate(progressMessage, `🎧 Starting generation of ${ambienceTypes.length} ambient tracks with concurrency level ${concurrency}...`);
            
            let successCount = 0;
            let failCount = 0;
            let skipCount = 0;
            let rateLimitDetected = false;
            
            // Get ambience type emojis for better visual feedback
            const ambienceEmojis = {
                'forest': '🌲',
                'cave': '🕳️',
                'tavern': '🍺',
                'ocean': '🌊',
                'city': '🏙️',
                'dungeon': '⛓️',
                'camp': '🔥',
                'storm': '⛈️'
            };
            
            // Create progress table
            const createProgressTable = (types, inProgress, status) => {
                let table = '```\n';
                table += 'TYPE          | STATUS      | EMOJI\n';
                table += '--------------|-------------|------\n';
                
                for (const type of types) {
                    const emoji = ambienceEmojis[type] || '🎧';
                    let typeStatus = '⏳ Pending';
                    
                    if (status[type]) {
                        typeStatus = status[type];
                    }
                    
                    // Highlight in-progress types
                    const isInProgress = inProgress.includes(type);
                    
                    table += `${isInProgress ? '→ ' : '  '}${type.padEnd(12)}| ${typeStatus.padEnd(11)}| ${emoji}\n`;
                }
                
                table += '```';
                return table;
            };
            
            // Keep track of each type's status
            const typeStatus = {};
            
            // Process ambience types with limited concurrency
            const processAmbienceType = async (type) => {
                try {
                    // Update status to processing
                    typeStatus[type] = '🔄 Processing';
                    
                    const exists = await ambientService.doesAmbienceExist(type);
                    if (exists && !force) {
                        skipCount++;
                        typeStatus[type] = '⏭️ Skipped';
                        return false; // Return false to indicate no rate limiting
                    }

                    // Generate the ambient sound
                    await ambientService.generateAndCacheAmbience(type, force);
                    successCount++;
                    typeStatus[type] = '✅ Done';
                    
                    return false; // No rate limiting info in ambient service yet
                } catch (error) {
                    console.error(`Error generating ambient sound for ${type}:`, error);
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
                    
                    typeStatus[type] = `❌ Failed (${errorType})`;
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
            
            // Chunked processing with progress updates
            for (let i = 0; i < ambienceTypes.length; i += concurrency) {
                // Add delay if rate limiting was detected
                if (rateLimitDetected) {
                    const cooldownDelay = 30000; // 30 seconds cooldown
                    const warningMessage = `⚠️ Rate limiting detected! Reducing concurrency to ${concurrency} and waiting ${cooldownDelay/1000} seconds before continuing...`;
                    console.warn(warningMessage);
                    await safeMessageUpdate(progressMessage, `${warningMessage}\n\n${createProgressTable(ambienceTypes, [], typeStatus)}`);
                    await new Promise(resolve => setTimeout(resolve, cooldownDelay));
                }
                
                const chunk = ambienceTypes.slice(i, i + concurrency);
                
                // Update status of pending chunk
                await safeMessageUpdate(progressMessage, 
                    `🎧 Generating ambient tracks... (${successCount + skipCount + failCount}/${ambienceTypes.length})\n` +
                    `✅ Completed: ${successCount}  ⏭️ Skipped: ${skipCount}  ❌ Failed: ${failCount}` +
                    (rateLimitDetected ? `  ⚠️ Rate limiting detected` : '') + 
                    `\n\n${createProgressTable(ambienceTypes, chunk, typeStatus)}`
                );
                
                // Start processing chunk
                const chunkPromises = chunk.map(type => processAmbienceType(type));
                
                // Update progress while this chunk is processing
                const updateInterval = setInterval(async () => {
                    const progressContent = 
                        `🎧 Generating ambient tracks... (${successCount + skipCount + failCount}/${ambienceTypes.length})\n` +
                        `✅ Completed: ${successCount}  ⏭️ Skipped: ${skipCount}  ❌ Failed: ${failCount}` +
                        (rateLimitDetected ? `  ⚠️ Rate limiting detected` : '') + 
                        `\n\n${createProgressTable(ambienceTypes, chunk, typeStatus)}`;
                    
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
                            createProgressTable(ambienceTypes, [], typeStatus)
                        );
                    }
                }
                
                // Update progress after chunk completes
                const progressContent = 
                    `🎧 Generating ambient tracks... (${successCount + skipCount + failCount}/${ambienceTypes.length})\n` +
                    `✅ Completed: ${successCount}  ⏭️ Skipped: ${skipCount}  ❌ Failed: ${failCount}` +
                    (rateLimitDetected ? `  ⚠️ Rate limiting detected` : '') + 
                    `\n\n${createProgressTable(ambienceTypes, [], typeStatus)}`;
                
                await safeMessageUpdate(progressMessage, progressContent);
            }

            // Calculate completion percentage
            const completionPercent = Math.round((successCount / ambienceTypes.length) * 100);
            
            const finalMessage = 
                `🎧 Ambient sound generation complete! (${completionPercent}% success rate)\n\n` +
                `✅ Successfully generated: ${successCount}\n` +
                `⏭️ Skipped (already exists): ${skipCount}\n` +
                `❌ Failed: ${failCount}\n` +
                (rateLimitDetected ? `⚠️ Rate limiting was encountered during generation\n` : '') +
                `\n${createProgressTable(ambienceTypes, [], typeStatus)}` + 
                `\nUse \`/playambience\` to enjoy the generated ambient sounds!`;

            await safeMessageUpdate(progressMessage, finalMessage);
        } catch (error) {
            console.error('Error in generateallambience command:', error);
            const errorMessage = `❌ Error: ${error.message}\n\nDebug info: Replicate API key available in config: ${config.replicate?.apiKey ? 'Yes (key length: ' + config.replicate.apiKey.length + ')' : 'No'}`;
            
            await safeMessageUpdate(progressMessage, errorMessage).catch(() => {
                // Last resort - try to send a new message to the channel
                channel.send(errorMessage).catch(console.error);
            });
        }
    },
}; 