// TODO: Add proper handling for party creation validation
// TODO: Add proper handling for party size limits
// TODO: Add proper handling for party member roles
// TODO: Add proper handling for party state persistence
// TODO: Add proper handling for party creation timeouts
// TODO: Add proper handling for party cleanup
// TODO: Add proper handling for party permissions
// TODO: Add proper handling for party metadata
// TODO: Add proper handling for party events
// TODO: Add proper handling for party error recovery

const { SlashCommandBuilder } = require('discord.js');
const PartyManager = require('../../services/adventure/managers/partyManager');
const logger = require('../../services/adventure/utils/logger');
const responseFormatter = require('../../services/adventure/utils/responseFormatter');

const partyManager = new PartyManager();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('createparty')
        .setDescription('Create a new adventure party')
        .addStringOption(option =>
            option.setName('adventurername')
                .setDescription('Your adventurer name')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('backstory')
                .setDescription('Your character\'s backstory')
                .setRequired(false)),

    async execute(interaction) {
        const userId = interaction.user.id;
        
        try {
            await interaction.deferReply();
            
            const adventurerName = interaction.options.getString('adventurername', true);
            const backstory = interaction.options.getString('backstory');

            if (!adventurerName || adventurerName.trim().length === 0) {
                throw new Error('Please provide a valid adventurer name');
            }
            
            // Create party using the party manager
            const party = await partyManager.createParty({
                leaderId: userId,
                adventurerName: adventurerName.trim(),
                backstory: backstory?.trim(),
                settings: {
                    voiceChannel: interaction.member?.voice?.channel || null
                }
            });

            // Format the response
            const response = responseFormatter.formatPartyCreation({
                party,
                leader: {
                    userId,
                    adventurerName,
                    backstory
                }
            });

            // Send the formatted response
            await interaction.editReply(response);

        } catch (error) {
            logger.error('Failed to create party', { 
                error: {
                    message: error.message,
                    code: error.code,
                    state: error.state,
                    stack: error.stack
                },
                userId,
                adventurerName: interaction.options.getString('adventurername')
            });

            // Provide more specific error messages
            let errorMessage = 'Failed to create the party. Please try again later.';
            if (error.message.includes('Adventurer name is required') || 
                error.message.includes('provide a valid adventurer name')) {
                errorMessage = 'Please provide a valid adventurer name.';
            }
            
            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    }
}; 