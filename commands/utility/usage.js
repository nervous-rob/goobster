const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const usageTracker = require('../../services/usageTracker');

function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('usage')
        .setDescription('Show AI usage (token counts) for this server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addIntegerOption(option =>
            option.setName('days')
                .setDescription('Time window in days (default 7)')
                .addChoices(
                    { name: 'Last 24 hours', value: 1 },
                    { name: 'Last 7 days', value: 7 },
                    { name: 'Last 30 days', value: 30 }
                )),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Usage tracking is per-server.', ephemeral: true });
            return;
        }

        const days = interaction.options.getInteger('days') ?? 7;
        const totals = usageTracker.getTotals({ guildId: interaction.guildId, days });
        const byModel = usageTracker.getSummary({ guildId: interaction.guildId, days });
        const topUsers = usageTracker.getTopUsers({ guildId: interaction.guildId, days });

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`📊 AI Usage - last ${days === 1 ? '24 hours' : `${days} days`}`)
            .setDescription(
                `**${totals.calls}** API calls | ` +
                `**${formatTokens(totals.inputTokens)}** input / **${formatTokens(totals.outputTokens)}** output tokens`
            )
            .setTimestamp();

        if (byModel.length > 0) {
            embed.addFields({
                name: 'By model',
                value: byModel.slice(0, 10).map(r =>
                    `\`${r.provider}/${r.model}\` (${r.operation}): ${r.calls} calls, ${formatTokens(r.inputTokens)} in / ${formatTokens(r.outputTokens)} out`
                ).join('\n'),
                inline: false
            });
        } else {
            embed.addFields({ name: 'By model', value: 'No usage recorded in this window.', inline: false });
        }

        if (topUsers.length > 0) {
            embed.addFields({
                name: 'Top users',
                value: topUsers.map(u => `<@${u.userId}>: ${u.calls} calls, ${formatTokens(u.totalTokens)} tokens`).join('\n'),
                inline: false
            });
        }

        embed.setFooter({ text: 'Note: heartbeat, consolidation, and memory calls without a user are included in totals.' });

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};
