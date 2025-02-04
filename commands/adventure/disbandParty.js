const { SlashCommandBuilder } = require('discord.js');
const PartyManager = require('../../services/adventure/managers/partyManager');
const logger = require('../../services/adventure/utils/logger');

const partyManager = new PartyManager();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('disbandparty')
        .setDescription('Disband your current party'),

    async execute(interaction) {
        try {
            await interaction.deferReply();
            
            const userId = interaction.user.id;
            
            // Find user's active party
            const party = await partyManager.findPartyByMember(userId);
            
            if (!party) {
                throw {
                    code: 'NO_PARTY',
                    message: 'You are not in any party.'
                };
            }

            // Check if user is the party leader
            if (!party.isLeader(userId)) {
                throw {
                    code: 'NOT_LEADER',
                    message: 'Only the party leader can disband the party.'
                };
            }

            // Disband the party
            await partyManager.disbandParty(party.id);

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
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
}; 