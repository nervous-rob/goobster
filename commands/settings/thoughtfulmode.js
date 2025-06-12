const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const aiService = require('../../services/aiService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('thoughtfulmode')
        .setDescription('Toggle Goobster\'s Thoughtful Mode (switches the underlying OpenAI model).')
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
                await interaction.reply({
                    content: '🧠 Thoughtful Mode has been **enabled**. Goobster will now use **Gemini 2.5 Pro Preview** for all new responses.',
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
                await interaction.reply({
                    content: '💬 Thoughtful Mode has been **disabled**. Goobster has reverted to **OpenAI GPT-4o**.',
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

            await interaction.reply({
                content: enabled
                    ? '🧠 Thoughtful Mode is currently **enabled** (provider: Gemini 2.5 Pro Preview).'
                    : '💬 Thoughtful Mode is currently **disabled** (provider: OpenAI GPT-4o).',
                ephemeral: true
            });
        }
    }
};
