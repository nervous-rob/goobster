const { SlashCommandBuilder } = require('discord.js');
const AdventureService = require('../../services/adventure');
const logger = require('../../services/adventure/utils/logger');

const adventureService = new AdventureService();

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
            
            // Process the decision using the service
            const response = await adventureService.processDecision({
                userId,
                decision,
                voiceChannel: interaction.member?.voice?.channel || null
            });

            // Send the formatted response
            await interaction.editReply(response);

        } catch (error) {
            logger.error('Failed to process decision', { error });
            const errorMessage = error.userMessage || 'Failed to process your decision. Please try again later.';
            
            if (interaction.deferred) {
                await interaction.editReply({ content: errorMessage });
            } else {
                await interaction.reply({ content: errorMessage, ephemeral: true });
            }
        }
    },
};