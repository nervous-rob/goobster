const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const aiService = require('../../services/aiService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('thoughtfulmode')
        .setDescription('Toggle Goobster\'s Thoughtful Mode (switches the underlying AI model).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Enable Thoughtful Mode (switch provider to Google Gemini)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable Thoughtful Mode (revert to GPT-4o)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show whether Thoughtful Mode is currently enabled')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'enable') {
            try {
                aiService.setProvider('gemini');
                const capabilities = aiService.getProviderCapabilities();
                
                let toolInfo = '';
                if (!capabilities.functionCalling) {
                    toolInfo = '\n\n**Note**: Gemini uses enhanced prompt-based tool integration instead of native function calling. All tools (search, image generation, music, etc.) are still available but work through natural language processing.';
                }

                await interaction.reply({
                    content: `🧠 **Thoughtful Mode has been enabled!**\n\nGoobster will now use **Gemini 2.5 Pro Preview** for all new responses.${toolInfo}`,
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
                aiService.setDefaultModel('gpt-4o');
                const capabilities = aiService.getProviderCapabilities();
                
                let toolInfo = '';
                if (capabilities.functionCalling) {
                    toolInfo = '\n\n**Note**: OpenAI provides native function calling support for all tools (search, image generation, music, etc.).';
                }

                await interaction.reply({
                    content: `💬 **Thoughtful Mode has been disabled!**\n\nGoobster has reverted to **OpenAI GPT-4o**.${toolInfo}`,
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
            const enabled = provider === 'gemini';
            const capabilities = aiService.getProviderCapabilities();

            let statusMessage = enabled
                ? '🧠 **Thoughtful Mode is currently enabled**\n\n**Provider**: Gemini 2.5 Pro Preview'
                : '💬 **Thoughtful Mode is currently disabled**\n\n**Provider**: OpenAI GPT-4o';

            // Add capability information
            statusMessage += '\n\n**Capabilities**:';
            statusMessage += `\n• Function Calling: ${capabilities.functionCalling ? '✅ Native' : '🔄 Prompt-based'}`;
            statusMessage += `\n• Streaming: ${capabilities.streaming ? '✅' : '❌'}`;
            statusMessage += `\n• Model Switching: ${capabilities.modelSwitching ? '✅' : '❌'}`;

            if (enabled) {
                statusMessage += '\n\n**Tool Integration**: Gemini uses enhanced prompt engineering to provide access to all tools (search, image generation, music, etc.) through natural language processing.';
            } else {
                statusMessage += '\n\n**Tool Integration**: OpenAI provides native function calling for seamless tool integration.';
            }

            await interaction.reply({
                content: statusMessage,
                ephemeral: true
            });
        }
    }
};
