const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const aiService = require('../../services/aiService');
const aiConfig = require('../../config/aiConfig');
const { getGuildAI, setGuildAI } = require('../../utils/guildSettings');

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

        if (!interaction.guildId) {
            await interaction.reply({ content: 'Thoughtful Mode is a per-server setting.', ephemeral: true });
            return;
        }

        if (subcommand === 'enable') {
            try {
                await setGuildAI(interaction.guildId, {
                    provider: 'openai',
                    model: aiConfig.openai.thoughtfulModel,
                    reasoningEffort: 'high'
                });

                await interaction.reply({
                    content: `🧠 **Thoughtful Mode enabled for this server!**\n\nGoobster will use **${aiConfig.openai.thoughtfulModel}** with high reasoning effort here. Replies will be smarter but slower and more expensive. Other servers are unaffected.`,
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
            const settings = await getGuildAI(interaction.guildId);
            const enabled = settings.model === aiConfig.openai.thoughtfulModel && settings.reasoningEffort === 'high';

            const statusMessage = enabled
                ? `🧠 **Thoughtful Mode is enabled in this server**\n\n**Model**: ${settings.model} (high reasoning effort)`
                : `💬 **Thoughtful Mode is disabled in this server**\n\n**Model**: ${settings.model || `${aiService.getDefaultModel()} (global default)`}`;

            await interaction.reply({
                content: statusMessage,
                ephemeral: true
            });
        }
    }
};
