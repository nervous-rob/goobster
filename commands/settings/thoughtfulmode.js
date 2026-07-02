const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const aiService = require('../../services/aiService');
const aiConfig = require('../../config/aiConfig');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('thoughtfulmode')
        .setDescription('Toggle Goobster\'s Thoughtful Mode (deeper reasoning at higher latency/cost).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription(`Enable Thoughtful Mode (${aiConfig.openai.thoughtfulModel} with high reasoning effort)`))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription(`Disable Thoughtful Mode (revert to ${aiConfig.openai.chatModel})`))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show whether Thoughtful Mode is currently enabled')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'enable') {
            try {
                aiService.setProvider('openai');
                aiService.setDefaultModel(aiConfig.openai.thoughtfulModel);
                aiService.setDefaultReasoningEffort('high');

                await interaction.reply({
                    content: `🧠 **Thoughtful Mode has been enabled!**\n\nGoobster will now use **${aiConfig.openai.thoughtfulModel}** with high reasoning effort for all new responses. Replies will be smarter but slower and more expensive.`,
                    ephemeral: true
                });
            } catch (err) {
                console.error('Failed to enable Thoughtful Mode:', err);
                await interaction.reply({
                    content: '❌ Failed to enable Thoughtful Mode. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'disable') {
            try {
                aiService.setProvider('openai');
                aiService.setDefaultModel(aiConfig.openai.chatModel);
                aiService.setDefaultReasoningEffort(null);

                await interaction.reply({
                    content: `💬 **Thoughtful Mode has been disabled!**\n\nGoobster has reverted to **${aiConfig.openai.chatModel}**.`,
                    ephemeral: true
                });
            } catch (err) {
                console.error('Failed to disable Thoughtful Mode:', err);
                await interaction.reply({
                    content: '❌ Failed to disable Thoughtful Mode. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'status') {
            const provider = aiService.getProvider();
            const model = aiService.getDefaultModel();
            const enabled = provider === 'openai' && model === aiConfig.openai.thoughtfulModel;
            const capabilities = aiService.getProviderCapabilities();

            let statusMessage = enabled
                ? `🧠 **Thoughtful Mode is currently enabled**\n\n**Model**: ${model} (high reasoning effort)`
                : `💬 **Thoughtful Mode is currently disabled**\n\n**Provider**: ${provider} (${model})`;

            statusMessage += '\n\n**Capabilities**:';
            statusMessage += `\n• Function Calling: ${capabilities.functionCalling === 'native' ? '✅ Native' : '🔄 Prompt-based'}`;
            statusMessage += `\n• Streaming: ${capabilities.streaming ? '✅' : '❌'}`;
            statusMessage += `\n• Model Switching: ${capabilities.modelSwitching ? '✅' : '❌'}`;

            await interaction.reply({
                content: statusMessage,
                ephemeral: true
            });
        }
    }
};
