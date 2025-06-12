const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const openaiService = require('../../services/openaiService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('thoughtfulmode')
        .setDescription('Toggle Goobster\'s Thoughtful Mode (switches the underlying OpenAI model).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Enable Thoughtful Mode (use GPT-o3 for responses)'))
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
                openaiService.setDefaultModel('o3');
                await interaction.reply({
                    content: '🧠 Thoughtful Mode has been **enabled**. Goobster will now use **GPT-o3** for all new responses.',
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
                openaiService.setDefaultModel('gpt-4o');
                await interaction.reply({
                    content: '💬 Thoughtful Mode has been **disabled**. Goobster has reverted to **GPT-4o**.',
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
            const currentModel = openaiService.getDefaultModel();
            const enabled = currentModel === 'o3';

            await interaction.reply({
                content: enabled
                    ? '🧠 Thoughtful Mode is currently **enabled** (model: GPT-o3).'
                    : '💬 Thoughtful Mode is currently **disabled** (model: GPT-4o).',
                ephemeral: true
            });
        }
    }
};
