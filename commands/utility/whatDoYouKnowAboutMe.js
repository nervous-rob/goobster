const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const privacyService = require('../../services/privacyService');
const usageTracker = require('../../services/usageTracker');
const { dmScopeId } = require('../../utils/dmScope');

module.exports = {
    // In a DM the report covers the user's DM scope
    // (registered globally with DM contexts, see deploy-commands.js)
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('what-do-you-know-about-me')
        .setDescription('See everything Goobster has stored about you (private reply).'),

    async execute(interaction) {
        // Guild-scoped tables report the current guild; in a DM they report
        // the user's DM scope instead.
        const scopeId = interaction.guildId || dmScopeId(interaction.user.id);
        const scopeLabel = interaction.guildId ? 'in this server' : 'in our DMs';

        await interaction.deferReply({ ephemeral: true });

        usageTracker.logCommand({
            command: 'what-do-you-know-about-me',
            guildId: interaction.guildId,
            userId: interaction.user.id
        });

        try {
            const report = privacyService.buildUserReport({
                guildId: scopeId,
                userId: interaction.user.id
            });

            const embed = new EmbedBuilder()
                .setColor('#43B581')
                .setTitle('🔍 What I know about you')
                .setDescription(
                    'Everything below lives in a local SQLite database on the machine running me - ' +
                    'no third-party storage. Use `/forget-me` to erase all of it.'
                )
                .setTimestamp();

            if (report.facts.length > 0) {
                const factLines = report.facts.map(f => `- ${f.content} *(${f.source})*`);
                let block = '';
                for (const line of factLines) {
                    if (block.length + line.length + 1 > 1024) break;
                    block += (block ? '\n' : '') + line;
                }
                embed.addFields({ name: `Facts about you ${scopeLabel} (${report.facts.length})`, value: block, inline: false });
            } else {
                embed.addFields({ name: `Facts about you ${scopeLabel}`, value: 'None stored.', inline: false });
            }

            embed.addFields({
                name: `Your memories ${scopeLabel}`,
                value: report.memories.count > 0
                    ? `${report.memories.count} remembered messages (oldest ${report.memories.oldest?.split(' ')[0]}, newest ${report.memories.newest?.split(' ')[0]})`
                    : 'None stored.',
                inline: false
            });

            if (report.followups.length > 0) {
                embed.addFields({
                    name: `Pending follow-ups about you (${report.followups.length})`,
                    value: report.followups.map(f => `- [${f.dueAt} UTC] ${f.note}`).join('\n').slice(0, 1024),
                    inline: false
                });
            }

            const misc = [
                `**Nickname:** ${report.nickname || 'none set'}`,
                `**Preferences:** ${report.preferences ? `meme mode ${report.preferences.memeMode ? 'on' : 'off'}, preset "${report.preferences.personality_preset}"` : 'none stored'}`,
                `**Profile:** ${report.profile ? `created ${report.profile.joinedAt}` : 'none (you never ran /createuser or chatted)'}`,
                `**Chat history (bot-wide):** ${report.conversations.count} conversations, ${report.conversations.messages} messages`,
                `**Usage rows ${scopeLabel}:** ${report.usageRows} (token counts for cost tracking)`,
                `**Activity counters ${scopeLabel}:** ${report.activityMessages} messages counted (counts only, no content - feeds \`/wrapped\`)`,
                `**Economy ${scopeLabel}:** ${report.economy.balance === null
                    ? 'no wallet'
                    : `${report.economy.balance.toLocaleString()} point balance, ${report.economy.transactions} ledger entries, ${report.economy.stockHoldings} stock positions, ${report.economy.stockTrades} trades`}`
            ];
            embed.addFields({ name: 'Everything else', value: misc.join('\n'), inline: false });

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Data report failed:', error);
            await interaction.editReply(`❌ Couldn't build your report: ${error.message}`);
        }
    }
};
