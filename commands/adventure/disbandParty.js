const { SlashCommandBuilder } = require('discord.js');
const PartyManager = require('../../services/adventure/managers/partyManager');
const logger = require('../../services/adventure/utils/logger');

const partyManager = new PartyManager();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('disbandparty')
        .setDescription('Disband your current party')
        .addBooleanOption(option => 
            option.setName('forcecleanup')
                .setDescription('Force cleanup any inconsistent party data')
                .setRequired(false)),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            
            const userId = interaction.user.id;
            logger.info('Disbanding party attempt', { userId });
            
            // Check if force cleanup is requested
            const forceCleanup = interaction.options.getBoolean('forcecleanup');
            
            // If force cleanup is requested, do that first
            if (forceCleanup) {
                await interaction.editReply('Cleaning up party data...');
                
                try {
                    await partyManager.forceCleanupUserPartyRecords(userId);
                    logger.info('Forced cleanup completed', { userId });
                    return await interaction.editReply({ 
                        content: 'Party data has been cleaned up. You can create a new party with `/createparty`.'
                    });
                } catch (cleanupError) {
                    logger.error('Failed to cleanup party data', {
                        error: cleanupError.message,
                        stack: cleanupError.stack,
                        userId
                    });
                    // Continue with normal disband attempt
                }
            }
            
            // Find user's active party with detailed logging
            logger.debug('Looking for user party', { userId });
            
            const party = await partyManager.findPartyByMember(userId);
            
            if (!party) {
                logger.warn('No party found for user', { userId });
                throw {
                    code: 'NO_PARTY',
                    message: 'You are not in any party.'
                };
            }
            
            logger.info('Found party for user', { 
                partyId: party.id, 
                userId,
                isLeader: party.isLeader(userId),
                status: party.status || party.adventureStatus,
                memberCount: party.members?.length || 0
            });

            // Check if user is the party leader
            if (!party.isLeader(userId)) {
                throw {
                    code: 'NOT_LEADER',
                    message: 'Only the party leader can disband the party.'
                };
            }

            // Check if party is already disbanded
            if (party.status === 'DISBANDED') {
                throw {
                    code: 'ALREADY_DISBANDED',
                    message: 'This party has already been disbanded.'
                };
            }

            // Disband the party
            await partyManager.disbandParty(party.id);
            logger.info('Party disbanded successfully', { partyId: party.id, userId });

            await interaction.editReply({ 
                content: 'Your party has been disbanded. You can create a new one with `/createparty`.'
            });

        } catch (error) {
            logger.error('Failed to disband party', { 
                error: {
                    message: error.message,
                    code: error.code,
                    stack: error.stack
                },
                userId: interaction.user.id
            });

            const errorMessage = error.message || 'Failed to disband the party. Please try again later.';
            
            if (interaction.deferred) {
                await interaction.editReply({ content: `${errorMessage} (Try adding the \`forcecleanup\` option if you're having persistent issues.)` });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
}; 