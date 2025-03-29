const { SlashCommandBuilder } = require('discord.js');
const AdventureService = require('../../services/adventure');
const PartyManager = require('../../services/adventure/managers/partyManager');
const logger = require('../../services/adventure/utils/logger');
const sql = require('mssql');

const adventureService = new AdventureService();
const partyManager = new PartyManager();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('makedecision')
        .setDescription('Make a decision in your current adventure')
        .addStringOption(option =>
            option.setName('decision')
                .setDescription('Your decision or action')
                .setRequired(true)),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            
            const userId = interaction.user.id;
            const decision = interaction.options.getString('decision');
            
            // Find the user's party using the PartyManager
            logger.debug('Finding party for user in makeDecision', { userId });
            const party = await partyManager.findPartyByMember(userId);

            // Validate party and adventure state
            if (!party) {
                logger.warn('No party found for user in makeDecision', { userId });
                throw {
                    userMessage: "You don't seem to be in any party right now. Use `/createparty` or `/joinparty` first."
                };
            }
            
            if (!party.adventureId || party.status !== 'ACTIVE') {
                logger.warn('Party found, but not in an active adventure', { userId, partyId: party.id, status: party.status, adventureId: party.adventureId });
                // Fetch adventure status separately for a more specific message (optional)
                let adventureStatus = 'unknown';
                if (party.adventureId) {
                    try {
                        const adventure = await adventureRepository.findById(null, party.adventureId); // Assuming findById doesn't need transaction for read
                        adventureStatus = adventure?.status || 'not found';
                    } catch (e) { logger.error('Could not fetch adventure status', e); }
                }
                throw {
                    userMessage: `Your party (ID: ${party.id}) isn't currently in an active adventure (Party Status: ${party.status}, Adventure Status: ${adventureStatus}). You might need to use \`/startadventure\` first.`
                };
            }

            const adventureId = party.adventureId;
            logger.info('Found active party and adventure for decision', { userId, partyId: party.id, adventureId });
            
            // Process the decision using the service
            const decisionResult = await adventureService.processDecision({
                userId,
                adventureId,
                decision,
                voiceChannel: interaction.member?.voice?.channel || null
            });

            // Construct the payload for editReply
            const replyPayload = {};
            if (decisionResult.response) {
                // Assuming decisionResult.response is the embed object description
                replyPayload.embeds = [decisionResult.response]; 
            }
            if (decisionResult.data?.sceneImage) {
                // Assuming sceneImage is the file path or buffer
                replyPayload.files = [decisionResult.data.sceneImage]; 
            }
            
            // Check if payload is empty before sending
            if (!replyPayload.embeds && !replyPayload.files) {
                logger.error('Decision response payload is empty', { decisionResult });
                throw new Error('Failed to generate a response for your decision.');
            }

            // Send the formatted response
            await interaction.editReply(replyPayload);

        } catch (error) {
            // Handle the special error structure from AdventureService
            const errorDetails = error.error || error;
            const errorResponse = error.response || error.message || 'Failed to process your decision. Please try again later.';
            
            logger.error('Failed to process decision', { 
                error: {
                    message: errorDetails.message,
                    code: errorDetails.code,
                    state: errorDetails.state,
                    stack: errorDetails.stack,
                    userMessage: errorDetails.userMessage
                },
                userId: interaction.user.id,
                decision: interaction.options.getString('decision'),
                adventureId: error.adventureId
            });
            
            // Ensure we're sending a string message
            const errorMessage = typeof errorResponse === 'string' ? errorResponse : 
                               errorDetails.userMessage || errorDetails.message || 
                               'Failed to process your decision. Please try again later.';
            
            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
};