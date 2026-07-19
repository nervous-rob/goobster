const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const privacyService = require('../../services/privacyService');
const usageTracker = require('../../services/usageTracker');

const CONFIRM_TIMEOUT_MS = 60 * 1000;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('forget-me')
        .setDescription('Erase everything Goobster knows about you, bot-wide. Cannot be undone.'),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Run this inside a server.', ephemeral: true });
            return;
        }

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('forgetme_confirm')
                .setLabel('Yes, erase everything')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('forgetme_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );

        const reply = await interaction.reply({
            content:
                '⚠️ **This will permanently erase everything I know about you, across the whole bot** - ' +
                'memories, facts, follow-ups, chat history, nicknames, and preferences. ' +
                'Usage rows are kept for cost accounting but anonymized (your ID is removed). ' +
                'Server facts and conversation summaries that mention you by name are scanned and deleted too.\n\n' +
                'This cannot be undone. Are you sure?',
            components: [confirmRow],
            ephemeral: true,
            fetchReply: true
        });

        let confirmation;
        try {
            confirmation = await reply.awaitMessageComponent({
                componentType: ComponentType.Button,
                filter: i => i.user.id === interaction.user.id,
                time: CONFIRM_TIMEOUT_MS
            });
        } catch {
            await interaction.editReply({ content: 'Timed out - nothing was deleted.', components: [] });
            return;
        }

        if (confirmation.customId === 'forgetme_cancel') {
            await confirmation.update({ content: 'Cancelled - nothing was deleted.', components: [] });
            return;
        }

        await confirmation.update({ content: '🗑️ Erasing everything I know about you…', components: [] });

        // Log before erasure; the erasure itself anonymizes this row
        usageTracker.logCommand({
            command: 'forget-me',
            guildId: interaction.guildId,
            userId: interaction.user.id
        });

        try {
            const extraNames = [
                interaction.user.username,
                interaction.user.globalName,
                interaction.member?.displayName
            ].filter(Boolean);

            const counts = privacyService.forgetUser({
                userId: interaction.user.id,
                extraNames
            });
            const audit = privacyService.auditUser({ userId: interaction.user.id });

            const lines = [
                '✅ **Done. Here\'s exactly what was erased:**',
                '',
                `- Memories written by you: **${counts.memories}**`,
                `- Facts about you: **${counts.userFacts}**`,
                `- Server facts mentioning your name: **${counts.reviewedGuildFacts}**`,
                `- Conversation summaries mentioning your name: **${counts.reviewedSummaries}**`,
                `- Follow-ups by/about you: **${counts.followups}**`,
                `- Private thoughts/notes mentioning your name: **${counts.reviewedThoughts}**`,
                `- Knowledge-graph nodes mentioning your name: **${counts.reviewedGraphNodes}**`,
                `- Chat history: **${counts.messages}** messages, **${counts.conversations}** conversations, **${counts.prompts}** prompts`,
                `- Nicknames: **${counts.nicknames}**, preferences: **${counts.preferences}**, profile: **${counts.profile}**`,
                `- Economy rows (wallet, ledger, stocks): **${counts.economy}**`,
                `- Usage rows anonymized (kept for cost accounting): **${counts.anonymizedUsageRows}**`,
                `- Activity counters anonymized (kept for server stats): **${counts.anonymizedActivityRows}**`,
                '',
                audit.total === 0
                    ? '🔎 Post-erasure audit: **zero rows** still attributed to you.'
                    : `⚠️ Post-erasure audit found ${audit.total} leftover rows - please report this as a bug.`,
                '',
                '*I\'ll naturally learn about you again if you keep chatting with me. If you want me to never remember a channel, an admin can use `/privacy exclude`.*'
            ];

            await interaction.editReply({ content: lines.join('\n'), components: [] });
        } catch (error) {
            console.error('Forget-me failed:', error);
            await interaction.editReply({
                content: `❌ Erasure failed and was rolled back - nothing was partially deleted: ${error.message}`,
                components: []
            });
        }
    }
};
