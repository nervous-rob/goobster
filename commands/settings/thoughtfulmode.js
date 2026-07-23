const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const aiService = require('../../services/aiService');
const { getGuildAI, setGuildAI } = require('../../utils/guildSettings');
const { getConversationScopeId } = require('../../utils/dmScope');

module.exports = {
    // In a DM the preset is per-user (keyed on the DM scope) - registered
    // globally with DM contexts, see deploy-commands.js. ManageGuild still
    // gates the command inside servers.
    dmAllowed: true,
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
        // Guild id in servers, the user's DM scope in direct messages
        const scopeId = getConversationScopeId(interaction);
        const scopeLabel = interaction.guildId ? 'this server' : 'our DMs';

        // The preset follows the scope's provider override when set,
        // otherwise the global provider.
        const currentSettings = await getGuildAI(scopeId);
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
                await setGuildAI(scopeId, preset);

                await interaction.reply({
                    content: `🧠 **Thoughtful Mode enabled for ${scopeLabel}!**\n\nGoobster will use **${preset.model}** (${preset.provider}) with high reasoning effort here. Replies will be smarter but slower and more expensive. Other ${interaction.guildId ? 'servers' : 'conversations'} are unaffected.`,
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
                await setGuildAI(scopeId, { provider: null, model: null, reasoningEffort: null });

                await interaction.reply({
                    content: `💬 **Thoughtful Mode disabled.**\n\n${interaction.guildId ? 'This server is' : 'Our DMs are'} back on the default model (**${aiService.getDefaultModel()}**).`,
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
                ? `🧠 **Thoughtful Mode is enabled in ${scopeLabel}**\n\n**Model**: ${currentSettings.model} (high reasoning effort)`
                : `💬 **Thoughtful Mode is disabled in ${scopeLabel}**\n\n**Model**: ${currentSettings.model || `${aiService.getDefaultModel()} (global default)`}`;

            await interaction.reply({
                content: statusMessage,
                ephemeral: true
            });
        }
    }
};
