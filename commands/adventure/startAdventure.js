// TODO: Add proper handling for adventure initialization validation
// TODO: Add proper handling for adventure generation timeouts
// TODO: Add proper handling for adventure state persistence
// TODO: Add proper handling for adventure resource allocation
// TODO: Add proper handling for adventure party validation
// TODO: Add proper handling for adventure notifications
// TODO: Add proper handling for adventure permissions
// TODO: Add proper handling for adventure rate limiting
// TODO: Add proper handling for adventure metadata
// TODO: Add proper handling for adventure error recovery

const { SlashCommandBuilder } = require('discord.js');
const AdventureService = require('../../services/adventure');
const PartyManager = require('../../services/adventure/managers/partyManager');
const logger = require('../../services/adventure/utils/logger');

// Constants for timeouts
const COMMAND_TIMEOUT = 60000; // 1 minute for basic operations
const INITIALIZATION_TIMEOUT = 120000; // 2 minutes for full adventure initialization
const IMAGE_GENERATION_TIMEOUT = 120000; // 2 minutes for image generation

const adventureService = new AdventureService();
const partyManager = new PartyManager();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('startadventure')
        .setDescription('Start a new adventure')
        .addStringOption(option =>
            option.setName('theme')
                .setDescription('Optional theme for the adventure')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('difficulty')
                .setDescription('Set the difficulty level')
                .setRequired(false)
                .addChoices(
                    { name: 'Easy', value: 'easy' },
                    { name: 'Normal', value: 'normal' },
                    { name: 'Hard', value: 'hard' },
                    { name: 'Expert', value: 'expert' }
                )),

    async execute(interaction) {
        try {
            await interaction.deferReply({ 
                ephemeral: false,
                fetchReply: true,
                // Set a longer defer timeout since we know image generation takes time
                timeout: INITIALIZATION_TIMEOUT + 5000 // Add 5 seconds buffer
            });
            
            // Get user and guild IDs
            const userId = interaction.user.id;
            const guildId = interaction.guildId;

            // Initialize adventure service with user ID for personalization
            adventureService.setUserId(userId);
            
            // Add guild ID for personality directives if available
            if (guildId) {
                adventureService.setGuildId(guildId);
            }

            const theme = interaction.options.getString('theme');
            const difficulty = interaction.options.getString('difficulty') || 'normal';
            
            logger.info('Starting adventure', { 
                userId,
                theme,
                difficulty,
                hasVoiceChannel: !!interaction.member?.voice?.channel
            });

            // Find user's active party with timeout
            const partyPromise = partyManager.findPartyByMember(userId);
            const party = await Promise.race([
                partyPromise,
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Party lookup timed out')), COMMAND_TIMEOUT)
                )
            ]);

            if (!party) {
                throw {
                    code: 'NO_PARTY',
                    message: 'You need to create or join a party first using /createparty or /joinparty.'
                };
            }

            // Check if party is ready for adventure
            if (!party.canStartAdventure()) {
                throw {
                    code: 'PARTY_NOT_READY',
                    message: party.getReadinessMessage()
                };
            }

            // Initialize the adventure using the service with timeout
            const adventurePromise = adventureService.initializeAdventure({
                createdBy: userId,
                theme,
                difficulty,
                settings: {
                    maxPartySize: party.settings.maxSize || 4,
                    partyId: party.id,
                    voiceChannel: interaction.member?.voice?.channel || null,
                    timeoutMs: INITIALIZATION_TIMEOUT // Pass timeout to service
                }
            });

            const adventureResponse = await Promise.race([
                adventurePromise,
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Adventure initialization timed out')), INITIALIZATION_TIMEOUT)
                )
            ]);

            // Send the formatted response
            await interaction.editReply(adventureResponse.response);

        } catch (error) {
            logger.error('Failed to start adventure', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                userId: interaction.user.id,
                timestamp: new Date().toISOString()
            });

            let errorMessage = 'Failed to start the adventure. Please try again later.';
            
            // Handle known error types
            if (error.code === 'VALIDATION_ERROR') {
                errorMessage = error.message || 'Invalid adventure settings. Please check your inputs.';
            } else if (error.code === 'NO_PARTY') {
                errorMessage = error.message || 'You need to create or join a party first using /createparty or /joinparty.';
            } else if (error.code === 'PARTY_NOT_READY') {
                errorMessage = error.message || 'Your party is not ready to start an adventure yet.';
            } else if (error.message.includes('timed out')) {
                errorMessage = 'The adventure is taking longer than expected to start. Please try again.';
            }
            
            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
}; 