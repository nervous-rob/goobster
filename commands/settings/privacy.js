const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const memoryService = require('../../services/memoryService');
const { getMemoryRetentionDays, setMemoryRetentionDays } = require('../../utils/guildSettings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('privacy')
        .setDescription('Control what Goobster remembers in this server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show retention and memory scope settings'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('retention')
                .setDescription('Auto-delete long-term memories older than N days')
                .addIntegerOption(option =>
                    option.setName('days')
                        .setDescription('Days to keep memories (0 = keep forever)')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(3650)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('exclude')
                .setDescription('Stop remembering a channel (and forget what\'s already stored from it)')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Channel Goobster must not remember')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('include')
                .setDescription('Resume remembering a previously excluded channel')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Channel to remember again')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Privacy settings are per-server.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (subcommand === 'status') {
            const retention = await getMemoryRetentionDays(guildId);
            const excluded = memoryService.getExcludedChannels(guildId);
            const stats = memoryService.getStats(guildId);

            await interaction.reply({
                content: [
                    '🔒 **Privacy settings for this server**',
                    '',
                    `**Memory retention:** ${retention ? `${retention} days (older memories auto-delete nightly)` : 'keep forever'}`,
                    `**Excluded channels:** ${excluded.length > 0 ? excluded.map(id => `<#${id}>`).join(', ') : 'none - all channels are remembered'}`,
                    `**Stored memories:** ${stats.count}`,
                    '',
                    '*Anyone can run `/what-do-you-know-about-me` and `/forget-me` for their own data.*'
                ].join('\n'),
                ephemeral: true
            });
        } else if (subcommand === 'retention') {
            const days = interaction.options.getInteger('days');
            const stored = await setMemoryRetentionDays(guildId, days);

            if (stored) {
                const purged = memoryService.applyRetention(guildId);
                await interaction.reply({
                    content: `🕐 Memories now expire after **${stored} days**.` +
                        (purged > 0 ? ` ${purged} existing ${purged === 1 ? 'memory' : 'memories'} past that window ${purged === 1 ? 'was' : 'were'} deleted now.` : ''),
                    ephemeral: true
                });
            } else {
                await interaction.reply({ content: '♾️ Memories are now kept forever (no retention window).', ephemeral: true });
            }
        } else if (subcommand === 'exclude') {
            const channel = interaction.options.getChannel('channel');
            const removed = memoryService.excludeChannel(guildId, channel.id);
            await interaction.reply({
                content: `🙈 I won't remember anything from <#${channel.id}> anymore.` +
                    (removed > 0 ? ` Also deleted ${removed} ${removed === 1 ? 'memory' : 'memories'} already stored from it.` : ''),
                ephemeral: true
            });
        } else if (subcommand === 'include') {
            const channel = interaction.options.getChannel('channel');
            const changed = memoryService.includeChannel(guildId, channel.id);
            await interaction.reply({
                content: changed > 0
                    ? `👀 I'll start remembering <#${channel.id}> again (from now on - past messages stay forgotten).`
                    : `<#${channel.id}> wasn't excluded, so nothing changed.`,
                ephemeral: true
            });
        }
    }
};
