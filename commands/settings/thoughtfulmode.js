const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const aiService = require('../../services/aiService');
const { getGuildAI, setGuildAI } = require('../../utils/guildSettings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('thoughtfulmode')
        .setDescription('Toggle Goobster\'s Thoughtful Mode (deeper reasoning at higher latency/cost).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Enable Thoughtful Mode (the provider\'s top model with high reasoning effort)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable Thoughtful Mode (revert to the default model)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show whether Thoughtful Mode is currently enabled')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (!interaction.guildId) {
            await interaction.reply({ content: 'Thoughtful Mode is a per-server setting.', ephemeral: true });
            return;
        }

        // The preset follows the guild's provider override when set,
        // otherwise the global provider.
        const currentSettings = await getGuildAI(interaction.guildId);
        const preset = aiService.getThoughtfulPreset(currentSettings.provider || undefined);

        if (subcommand === 'enable') {
            if (!preset) {
                await interaction.reply({
                    content: '❌ Thoughtful Mode needs a cloud AI provider (OpenAI, Anthropic, or Gemini). The current provider has no thoughtful tier.',
                    ephemeral: true
                });
                return;
            }
            try {
                await setGuildAI(interaction.guildId, preset);

                await interaction.reply({
                    content: `🧠 **Thoughtful Mode enabled for this server!**\n\nGoobster will use **${preset.model}** (${preset.provider}) with high reasoning effort here. Replies will be smarter but slower and more expensive. Other servers are unaffected.`,
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
                await setGuildAI(interaction.guildId, { provider: null, model: null, reasoningEffort: null });

                await interaction.reply({
                    content: `💬 **Thoughtful Mode disabled.**\n\nThis server is back on the default model (**${aiService.getDefaultModel()}**).`,
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
            const enabled = Boolean(preset)
                && currentSettings.model === preset.model
                && currentSettings.reasoningEffort === 'high';

            const statusMessage = enabled
                ? `🧠 **Thoughtful Mode is enabled in this server**\n\n**Model**: ${currentSettings.model} (high reasoning effort)`
                : `💬 **Thoughtful Mode is disabled in this server**\n\n**Model**: ${currentSettings.model || `${aiService.getDefaultModel()} (global default)`}`;

            await interaction.reply({
                content: statusMessage,
                ephemeral: true
            });
        }
    }
};
