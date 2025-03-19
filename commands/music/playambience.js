const { SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const AmbientService = require('../../services/voice/ambientService');
const config = require('../../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('playambience')
        .setDescription('Play ambient sound effects')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('The type of ambient sound to play')
                .setRequired(true)
                .addChoices(
                    { name: 'Forest', value: 'forest' },
                    { name: 'Cave', value: 'cave' },
                    { name: 'Tavern', value: 'tavern' },
                    { name: 'Ocean', value: 'ocean' },
                    { name: 'City', value: 'city' },
                    { name: 'Dungeon', value: 'dungeon' },
                    { name: 'Camp', value: 'camp' },
                    { name: 'Storm', value: 'storm' }
                ))
        .addNumberOption(option =>
            option.setName('volume')
                .setDescription('Volume of the ambient sound (0.1 to 1.0)')
                .setRequired(false)
                .setMinValue(0.1)
                .setMaxValue(1.0)),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            const channel = interaction.channel;
            let progressMessage = await interaction.fetchReply();

            // Check if user is in a voice channel
            const voiceChannel = interaction.member.voice.channel;
            if (!voiceChannel) {
                await interaction.editReply('You need to be in a voice channel to play ambient sounds!');
                return;
            }

            // Check bot permissions
            const permissions = voiceChannel.permissionsFor(interaction.client.user);
            if (!permissions.has('Connect') || !permissions.has('Speak')) {
                await interaction.editReply('I need permissions to join and speak in your voice channel!');
                return;
            }

            // Get the selected type and volume
            const type = interaction.options.getString('type');
            const volume = interaction.options.getNumber('volume') ?? 0.3;
            
            // Get type emoji for better visual feedback
            const typeEmojis = {
                'forest': '🌲',
                'cave': '🕳️',
                'tavern': '🍺',
                'ocean': '🌊',
                'city': '🏙️',
                'dungeon': '⛓️',
                'camp': '🔥',
                'storm': '⛈️'
            };
            const typeEmoji = typeEmojis[type] || '🎧';
            
            // Helper function to safely update messages
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
            
            // Create a status table
            const createStatusTable = (type, status) => {
                const emoji = typeEmojis[type] || '🎧';
                
                let table = '```\n';
                table += 'TYPE          | STATUS      | EMOJI\n';
                table += '--------------|-------------|------\n';
                table += `  ${type.padEnd(12)}| ${status.padEnd(11)}| ${emoji}\n`;
                table += '```';
                
                return table;
            };

            // Initialize ambient service
            const ambientService = new AmbientService(config);
            
            await safeMessageUpdate(progressMessage, `${typeEmoji} Preparing to play **${type}** ambient sounds...\n\n${createStatusTable(type, '🔄 Preparing')}`);

            // Create voice connection
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false
            });

            try {
                // Wait for connection to be ready
                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

                // Check if ambience exists in cache
                const exists = await ambientService.doesAmbienceExist(type);
                
                if (!exists) {
                    await safeMessageUpdate(progressMessage, `${typeEmoji} Generating **${type}** ambient sounds for the first time...\n\n${createStatusTable(type, '🔄 Generating')}`);
                    
                    // Set up interval to update progress message
                    let dots = 0;
                    const progressInterval = setInterval(async () => {
                        dots = (dots + 1) % 4;
                        const loadingDots = '.'.repeat(dots);
                        await safeMessageUpdate(progressMessage, `${typeEmoji} Generating **${type}** ambient sounds${loadingDots}\n\n${createStatusTable(type, `🔄 Generating${loadingDots}`)}`);
                    }, 5000);
                    
                    try {
                        // Play the ambience (this will trigger generation)
                        const resource = await ambientService.playAmbience(type, connection, volume);
                        
                        // Clear the interval and update final status
                        clearInterval(progressInterval);
                        
                        if (resource) {
                            await safeMessageUpdate(progressMessage, 
                                `${typeEmoji} Successfully generated and playing **${type}** ambient sounds!\n\n` +
                                `${createStatusTable(type, '▶️ Playing')}\n\n` +
                                `• Volume: ${Math.round(volume * 100)}%\n` +
                                `• Status: Newly Generated\n\n` +
                                `Use \`/stopambience\` to stop playback.`
                            );
                        } else {
                            await safeMessageUpdate(progressMessage, `❌ Failed to play ambient sounds.\n\n${createStatusTable(type, '❌ Failed')}`);
                            connection.destroy();
                        }
                    } catch (error) {
                        // Clear the interval and handle error
                        clearInterval(progressInterval);
                        
                        const errorType = 
                            error.message.includes('Rate limit') || error.message.includes('Too Many Requests') || (error.response && error.response.status === 429) ? 'Rate Limit' :
                            error.message.includes('422') ? 'API Error (422)' : 
                            error.message.includes('timeout') ? 'Timeout' : 
                            error.message.includes('Too many consecutive errors') ? 'API Connection' : 'Unknown';
                        
                        console.error(`Error generating ambient sound for ${type}:`, error);
                        await safeMessageUpdate(progressMessage, 
                            `❌ Failed to generate **${type}** ambient sounds.\n\n` +
                            `${createStatusTable(type, `❌ Failed (${errorType})`)}\n\n` +
                            `Error: ${error.message}\n\nPlease try again later.`
                        );
                        connection.destroy();
                    }
                } else {
                    await safeMessageUpdate(progressMessage, `${typeEmoji} Loading **${type}** ambient sounds from cache...\n\n${createStatusTable(type, '🔄 Loading')}`);
                    
                    // Play the ambience from cache
                    const resource = await ambientService.playAmbience(type, connection, volume);
                    
                    if (resource) {
                        await safeMessageUpdate(progressMessage, 
                            `${typeEmoji} Now playing **${type}** ambient sounds!\n\n` +
                            `${createStatusTable(type, '▶️ Playing')}\n\n` +
                            `• Volume: ${Math.round(volume * 100)}%\n` + 
                            `• Status: From Cache\n\n` +
                            `Use \`/stopambience\` to stop playback.`
                        );
                    } else {
                        await safeMessageUpdate(progressMessage, `❌ Failed to play ambient sounds.\n\n${createStatusTable(type, '❌ Failed')}`);
                        connection.destroy();
                    }
                }

                // Set up cleanup when the bot is disconnected
                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    try {
                        await Promise.race([
                            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                        ]);
                        // Seems to be reconnecting to a new channel - ignore disconnect
                    } catch (error) {
                        // Seems to be a real disconnect which SHOULDN'T be recovered from
                        connection.destroy();
                        ambientService.stopAmbience();
                    }
                });
            } catch (error) {
                console.error('Error playing ambient sounds:', error);
                await safeMessageUpdate(progressMessage, `❌ Error setting up voice connection: ${error.message}\n\nPlease try again later.`);
                connection.destroy();
            }
        } catch (error) {
            console.error('Error in playambience command:', error);
            try {
                await interaction.editReply('An error occurred while executing the command.');
            } catch (replyError) {
                console.error('Failed to send error message:', replyError);
            }
        }
    },
}; 