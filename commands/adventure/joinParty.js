// TODO: Add proper handling for party join validation
// TODO: Add proper handling for party member limits
// TODO: Add proper handling for party role assignments
// TODO: Add proper handling for party join timeouts
// TODO: Add proper handling for party state updates
// TODO: Add proper handling for party join notifications
// TODO: Add proper handling for party member permissions
// TODO: Add proper handling for party join conflicts
// TODO: Add proper handling for party join persistence
// TODO: Add proper handling for party join recovery

const { SlashCommandBuilder } = require('discord.js');
const { isDeployment, getAdventureService, getLogger } = require('./utils/deploymentHelper');

// Get instances conditionally
const adventureService = getAdventureService();
const logger = getLogger();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('joinparty')
        .setDescription('Join an existing adventure party')
        .addStringOption(option =>
            option.setName('partyid')
                .setDescription('The ID of the party to join')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('adventurername')
                .setDescription('Your adventurer name')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('backstory')
                .setDescription('Your character\'s backstory')
                .setRequired(false)),

    async execute(interaction) {
        // Skip execution during deployment
        if (isDeployment) {
            return;
        }
        
        try {
            await interaction.deferReply();
            
            const userId = interaction.user.id;
            const partyId = interaction.options.getString('partyid');
            const adventurerName = interaction.options.getString('adventurername');
            const backstory = interaction.options.getString('backstory');
            
            // Join party using the service
            const response = await adventureService.joinParty({
                userId,
                partyId,
                adventurerName,
                backstory,
                settings: {
                    voiceChannel: interaction.member?.voice?.channel || null
                }
            });

            // Send the formatted response
            await interaction.editReply(response);

        } catch (error) {
            logger.error('Failed to join party', { error });
            const errorMessage = error.userMessage || 'Failed to join the party. Please try again later.';
            
            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
}; 