const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const aiService = require('../../services/ai/instance').default;
const { createLogger } = require('../../utils/logger');

const logger = createLogger('AIRetryCommand');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('airetry')
        .setDescription('Configure AI retry and fallback settings')
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Set retry configuration')
                .addIntegerOption(option =>
                    option.setName('attempts')
                        .setDescription('Number of retry attempts (1-5)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(5))
                .addIntegerOption(option =>
                    option.setName('delay')
                        .setDescription('Delay between retries in milliseconds (100-5000)')
                        .setRequired(false)
                        .setMinValue(100)
                        .setMaxValue(5000)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View current retry configuration'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        try {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'set') {
                const attempts = interaction.options.getInteger('attempts');
                const delay = interaction.options.getInteger('delay');

                if (!attempts && !delay) {
                    await interaction.reply({
                        content: '❌ Please specify at least one setting to update.',
                        ephemeral: true
                    });
                    return;
                }

                if (attempts) {
                    aiService.setRetryAttempts(attempts);
                }
                if (delay) {
                    aiService.setRetryDelay(delay);
                }

                const currentAttempts = aiService.getRetryAttempts();
                const currentDelay = aiService.getRetryDelay();

                await interaction.reply({
                    content: `✅ Successfully updated retry settings:\n\n📝 Current configuration:\n• Retry attempts: ${currentAttempts}\n• Retry delay: ${currentDelay}ms`,
                    ephemeral: true
                });

            } else if (subcommand === 'view') {
                const currentAttempts = aiService.getRetryAttempts();
                const currentDelay = aiService.getRetryDelay();

                await interaction.reply({
                    content: `📝 Current retry configuration:\n• Retry attempts: ${currentAttempts}\n• Retry delay: ${currentDelay}ms`,
                    ephemeral: true
                });
            }
        } catch (error) {
            logger.error('Error in airetry command:', error);
            await interaction.reply({
                content: '❌ An error occurred while managing retry settings.',
                ephemeral: true
            });
        }
    }
}; 