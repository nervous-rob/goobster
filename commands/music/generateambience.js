const { SlashCommandBuilder } = require('discord.js');
const AmbientService = require('../../services/voice/ambientService');
const { ProgressTracker } = require('../../utils');
const config = require('../../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('generateambience')
        .setDescription('Generate ambient sound for a specific environment')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('The type of ambient sound to generate')
                .setRequired(true)
                .addChoices(
                    { name: '🌲 Forest', value: 'forest' },
                    { name: '🕳️ Cave', value: 'cave' },
                    { name: '🍺 Tavern', value: 'tavern' },
                    { name: '🌊 Ocean', value: 'ocean' },
                    { name: '🏙️ City', value: 'city' },
                    { name: '⛓️ Dungeon', value: 'dungeon' },
                    { name: '🔥 Camp', value: 'camp' },
                    { name: '⛈️ Storm', value: 'storm' }
                ))
        .addBooleanOption(option =>
            option.setName('force')
                .setDescription('Force regeneration even if files exist')
                .setRequired(false)),

    async execute(interaction) {
        console.log('Starting generateambience command execution');
        
        try {
            await interaction.deferReply();
            console.log('Deferred reply successfully');
            
            const type = interaction.options.getString('type');
            const force = interaction.options.getBoolean('force') || false;
            console.log(`Generating ${type} ambience with force=${force}`);
            
            // Get the type emoji
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
            
            // Initialize the ambient service
            const ambientService = new AmbientService(config);
            console.log('AmbientService initialized');
            
            // Check if the ambient sound already exists
            let exists = false;
            try {
                exists = await ambientService.doesAmbienceExist(type);
                console.log(`${type} ambience exists: ${exists}`);
            } catch (error) {
                console.error('Error checking if ambience exists:', error);
                await interaction.editReply(`❌ Error checking if ambience exists: ${error.message}`);
                return;
            }
            
            // Initialize the progress tracker
            const progress = new ProgressTracker({
                interaction,
                type: 'ambience',
                itemName: type,
                exists,
                force,
                emoji: typeEmojis[type] || '🎧'
            });
            
            // Start tracking progress
            await progress.start();
            
            // Handle the case when ambient sound already exists and force is false
            if (exists && !force) {
                console.log(`${type} ambience already exists and force is false, skipping generation`);
                await progress.complete('skipped');
                return;
            }
            
            // Update to generating/regenerating status
            await progress.update(exists ? 'regenerating' : 'generating');
            
            try {
                // Generate the ambient sound
                console.log(`Starting ambience generation for ${type} with force=${force}`);
                await ambientService.generateAndCacheAmbience(type, force);
                console.log(`Ambience generation completed successfully for ${type}`);
                
                // Complete with success
                await progress.complete('completed');
            } catch (error) {
                // Handle generation error
                console.error(`Error generating ambience for ${type}:`, error);
                
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
            console.error(`Top-level error in generateambience command:`, error);
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