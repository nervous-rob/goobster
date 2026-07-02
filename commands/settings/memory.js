const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const memoryService = require('../../services/memoryService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('memory')
        .setDescription('Manage Goobster\'s long-term memory for this server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show memory stats for this server'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('recall')
                .setDescription('Test what Goobster remembers about a topic')
                .addStringOption(option =>
                    option.setName('topic')
                        .setDescription('What to search memories for')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('forget')
                .setDescription('Delete ALL long-term memories for this server')),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Long-term memory is only available in servers.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'status') {
            const stats = memoryService.getStats(interaction.guildId);
            await interaction.reply({
                content: [
                    '🧠 **Long-term Memory Status**',
                    '',
                    `**Enabled:** ${stats.enabled ? '✅' : '❌'}`,
                    `**Stored memories:** ${stats.count}`,
                    `**Embedding backend:** ${stats.backend} (${stats.model})`,
                    stats.oldest ? `**Oldest memory:** ${stats.oldest}` : null,
                    stats.newest ? `**Newest memory:** ${stats.newest}` : null
                ].filter(Boolean).join('\n'),
                ephemeral: true
            });
        } else if (subcommand === 'recall') {
            await interaction.deferReply({ ephemeral: true });
            const topic = interaction.options.getString('topic');

            const memories = await memoryService.recall({
                guildId: interaction.guildId,
                query: topic
            });

            if (memories.length === 0) {
                await interaction.editReply(`I don't have any memories related to "${topic}".`);
                return;
            }

            const lines = memories.map(m =>
                `- [${m.createdAt?.split(' ')[0] || '?'}] **${m.authorName || 'someone'}** (${(m.similarity * 100).toFixed(0)}%): ${m.content.length > 150 ? m.content.slice(0, 150) + '…' : m.content}`
            );
            await interaction.editReply(`🧠 **Memories about "${topic}":**\n\n${lines.join('\n')}`);
        } else if (subcommand === 'forget') {
            const removed = memoryService.forgetGuild(interaction.guildId);
            await interaction.reply({
                content: `🗑️ Deleted ${removed} long-term ${removed === 1 ? 'memory' : 'memories'} for this server.`,
                ephemeral: true
            });
        }
    }
};
