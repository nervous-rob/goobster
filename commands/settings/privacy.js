const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const memoryService = require('../../services/memoryService');
const activityService = require('../../services/activityService');
const { getMemoryRetentionDays, setMemoryRetentionDays } = require('../../utils/guildSettings');
const { getConversationScopeId } = require('../../utils/dmScope');

module.exports = {
    // DM admin rule: in a DM the user is the "admin" of their own dm:<userId>
    // scope, so status + retention work there (parity with the web portal's
    // memory retention setting). Channel exclusions stay guild-only.
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('privacy')
        .setDescription('Control what Goobster remembers here.')
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
        const subcommand = interaction.options.getSubcommand();
        // In a guild this is the guild id; in a DM it's the user's own
        // dm:<userId> scope (their DMs + web chats share it).
        const guildId = getConversationScopeId(interaction);
        const isDm = !interaction.guildId;

        if (isDm && (subcommand === 'exclude' || subcommand === 'include')) {
            await interaction.reply({
                content: 'Channel exclusions are a server feature - DMs have only one "channel".',
                ephemeral: true
            });
            return;
        }

        if (subcommand === 'status') {
            const retention = await getMemoryRetentionDays(guildId);
            const excluded = isDm ? [] : memoryService.getExcludedChannels(guildId);
            const stats = memoryService.getStats(guildId);

            await interaction.reply({
                content: [
                    `🔒 **Privacy settings for ${isDm ? 'your DMs & web chat' : 'this server'}**`,
                    '',
                    `**Memory retention:** ${retention ? `${retention} days (older memories auto-delete nightly)` : 'keep forever'}`,
                    ...(isDm ? [] : [`**Excluded channels:** ${excluded.length > 0 ? excluded.map(id => `<#${id}>`).join(', ') : 'none - all channels are remembered'}`]),
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
                if (purged > 0) memoryService.cleanupVecIndex();
                await interaction.reply({
                    content: `🕐 ${isDm ? 'Your DM/web-chat memories' : 'Memories'} now expire after **${stored} days**.` +
                        (purged > 0 ? ` ${purged} existing ${purged === 1 ? 'memory' : 'memories'} past that window ${purged === 1 ? 'was' : 'were'} deleted now.` : ''),
                    ephemeral: true
                });
            } else {
                await interaction.reply({ content: '♾️ Memories are now kept forever (no retention window).', ephemeral: true });
            }
        } else if (subcommand === 'exclude') {
            const channel = interaction.options.getChannel('channel');
            const removed = memoryService.excludeChannel(guildId, channel.id);
            const purgedActivity = activityService.purgeChannel(guildId, channel.id);
            await interaction.reply({
                content: `🙈 I won't remember anything from <#${channel.id}> anymore (memories and activity counts).` +
                    (removed > 0 ? ` Also deleted ${removed} ${removed === 1 ? 'memory' : 'memories'} already stored from it.` : '') +
                    (purgedActivity > 0 ? ` Purged ${purgedActivity} activity counter ${purgedActivity === 1 ? 'row' : 'rows'} too.` : ''),
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
