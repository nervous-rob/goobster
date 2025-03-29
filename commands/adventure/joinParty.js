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
const AdventureService = require('../../services/adventure');
const logger = require('../../services/adventure/utils/logger');

const adventureService = new AdventureService();

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
        try {
            await interaction.deferReply();
            
            const userId = interaction.user.id;
            const partyId = interaction.options.getString('partyid');
            const adventurerName = interaction.options.getString('adventurername');
            const backstory = interaction.options.getString('backstory');
            
            logger.info('Joining party', { 
                userId, 
                partyId, 
                adventurerName, 
                hasBackstory: !!backstory
            });
            
            // Validate inputs
            if (!partyId || !partyId.trim()) {
                return await interaction.editReply('Please provide a valid party ID');
            }
            
            if (!adventurerName || !adventurerName.trim()) {
                return await interaction.editReply('Please provide a valid adventurer name');
            }
            
            // Join party using the service with all parameters
            const result = await adventureService.joinParty({
                userId,
                partyId,
                adventurerName,
                backstory,
                settings: {
                    voiceChannel: interaction.member?.voice?.channel?.id || null
                }
            });
            
            logger.debug('Join party successful', { 
                partyId, 
                userId, 
                memberCount: result?.data?.party?.members?.length || 'unknown' 
            });

            // Send the formatted response
            await interaction.editReply(result.response);

        } catch (error) {
            logger.error('Failed to join party', { 
                error: {
                    message: error.message,
                    stack: error.stack
                },
                userId: interaction.user.id
            });
            
            // Provide a user-friendly error message
            let errorMessage = 'Failed to join the party.';
            
            if (error.message.includes('already in a party')) {
                errorMessage = 'You are already in a party. Please leave your current party first.';
            } else if (error.message.includes('Adventurer name is required')) {
                errorMessage = 'Please provide a valid adventurer name.';
            } else if (error.message.includes('Party not found')) {
                errorMessage = 'Party not found. Please check the party ID and try again.';
            } else if (error.message.includes('Party is full')) {
                errorMessage = 'This party is full and cannot accept more members.';
            } else if (error.message.includes('Party cannot accept')) {
                errorMessage = 'This party is not accepting new members right now.';
            } else {
                errorMessage = error.message || 'Failed to join the party. Please try again later.';
            }
            
            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
}; 