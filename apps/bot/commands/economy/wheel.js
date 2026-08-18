const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { CronExpressionParser } = require('cron-parser');
const db = require('@goobster/core/db');
const economyService = require('@goobster/core/services/economyService');
const { EconomyError } = require('@goobster/core/services/economyService');
const { StockError } = require('@goobster/core/services/stockService');
const groupPlayService = require('@goobster/core/services/exchange/groupPlayService');
const wheelService = require('@goobster/core/services/exchange/wheelService');
const { ExchangeError } = require('@goobster/core/services/exchange/errors');
const usageTracker = require('@goobster/core/services/usageTracker');
const { WHEEL_MARKER, resolveNames, buildWheelEmbed } = require('@goobster/core/services/exchange/wheelPresenter');

// 13:30 UTC = 9:30 AM Eastern during DST (the Wheel keeps ritual time, not
// civil time - it does not chase daylight-saving transitions)
const DAILY_CRON = '30 13 * * 1-5';

/**
 * The Daily Ballistic Goblin Wheel: one spin picks the strike distance, a
 * second picks how much of every participant's wallet rides. Opt-in is
 * tracked per member; the guild override (ON by default) counts everyone
 * with a wallet as in until they personally opt out.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('wheel')
        .setDescription('The Ballistic Goblin Wheel - group call-buying, coordinates revealed by fate.')
        .addSubcommand(sub =>
            sub.setName('spin')
                .setDescription('Spin both wheels NOW and deploy for every participant (Manage Server)')
                .addStringOption(opt => opt.setName('symbol').setDescription('Underlying (default SPX)')))
        .addSubcommand(sub =>
            sub.setName('optin')
                .setDescription('Join the ritual')
                .addNumberOption(opt => opt.setName('max_percent').setDescription('Personal cap on how much of your wallet one spin may deploy').setMinValue(0.1).setMaxValue(100)))
        .addSubcommand(sub =>
            sub.setName('optout')
                .setDescription('Leave the ritual (wins over the server-wide override, always)'))
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Your opt-in state, the override, and the participant count'))
        .addSubcommand(sub =>
            sub.setName('participants')
                .setDescription('Who rides on the next spin'))
        .addSubcommand(sub =>
            sub.setName('override')
                .setDescription('The override-all switch: treat everyone as opted in (Manage Server)')
                .addBooleanOption(opt => opt.setName('enabled').setDescription('On or off').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('schedule')
                .setDescription('Spin daily at US market open, 9:30 AM ET, in this channel (Manage Server)'))
        .addSubcommand(sub =>
            sub.setName('unschedule')
                .setDescription('Stop the daily dedication (Manage Server)')),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The Wheel only spins in servers.', ephemeral: true });
            return;
        }

        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand();
        const { currencyName } = economyService.getSettings(guildId);
        usageTracker.logCommand({ command: 'wheel', guildId, userId });

        const needsManage = ['spin', 'override', 'schedule', 'unschedule'].includes(subcommand);
        if (needsManage && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({ content: '❌ That deploys (or governs) other people\'s wallets - it needs Manage Server.', ephemeral: true });
            return;
        }

        try {
            if (subcommand === 'spin') {
                await interaction.deferReply();
                const result = await wheelService.spin({
                    guildId, symbol: interaction.options.getString('symbol') || 'SPX'
                });
                const names = await resolveNames(interaction.guild, result.deployments.map(d => d.userId));
                await interaction.editReply({ embeds: [buildWheelEmbed(result, currencyName, names)] });

            } else if (subcommand === 'optin') {
                const state = groupPlayService.setOptIn({
                    guildId, userId, optedIn: true,
                    maxAllocationPercent: interaction.options.getNumber('max_percent')
                });
                await interaction.reply(
                    `🎡 **${interaction.user.username} joins the ritual.** ` +
                    `${state.maxAllocationPercent ? `Personal cap: **${state.maxAllocationPercent}%** of your wallet per spin.` : 'No personal cap - the allocation wheel decides.'} ` +
                    'Opt out any time with `/wheel optout`.'
                );

            } else if (subcommand === 'optout') {
                groupPlayService.setOptIn({ guildId, userId, optedIn: false });
                await interaction.reply(
                    `🛡️ **${interaction.user.username} steps away from the Wheel.** ` +
                    'Your opt-out wins over the server-wide override - no spin touches your wallet until you `/wheel optin` again.'
                );

            } else if (subcommand === 'status') {
                const mine = groupPlayService.effectiveOptIn(guildId, userId);
                const summary = groupPlayService.summarize(guildId);
                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle('🎡 Wheel status')
                        .setColor(0xfaa61a)
                        .setDescription(
                            `**You:** ${mine.optedIn ? '✅ in' : '❌ out'} (${mine.source === 'explicit' ? 'your own choice' : mine.source === 'override' ? 'server-wide override' : 'default'})` +
                            `${mine.maxAllocationPercent ? ` · personal cap ${mine.maxAllocationPercent}%` : ''}\n` +
                            `**Override-all:** ${summary.optInOverride ? 'ON - everyone with a wallet is in unless they opted out' : 'off - only explicit opt-ins ride'}\n` +
                            `**Explicit opt-ins:** ${summary.explicitOptIns} · **explicit opt-outs:** ${summary.explicitOptOuts}\n` +
                            `**Riding the next spin:** ${summary.participants} member(s)`
                        )]
                });

            } else if (subcommand === 'participants') {
                const participants = groupPlayService.listParticipants({ guildId });
                if (participants.length === 0) {
                    await interaction.reply('Nobody is riding the Wheel. `/wheel optin` to change that.');
                    return;
                }
                const names = await resolveNames(interaction.guild, participants.map(p => p.userId));
                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle(`🎡 ${participants.length} member(s) ride the next spin`)
                        .setColor(0xfaa61a)
                        .setDescription(participants.map(p =>
                            `${names.get(p.userId)} — ${p.source === 'explicit' ? 'opted in' : 'via override'}${p.maxAllocationPercent ? ` (cap ${p.maxAllocationPercent}%)` : ''}`
                        ).join('\n').slice(0, 4000))]
                });

            } else if (subcommand === 'override') {
                const enabled = interaction.options.getBoolean('enabled');
                groupPlayService.setOverride({ guildId, enabled, byUserId: userId });
                await interaction.reply(
                    enabled
                        ? '🎡 **Override-all ON.** Everyone with a wallet counts as opted in. An explicit `/wheel optout` still wins - even goblins honour a recorded no.'
                        : '🎡 **Override-all off.** Only members who ran `/wheel optin` ride from now on.'
                );

            } else if (subcommand === 'schedule') {
                const existing = db.get(
                    'SELECT id, channelId FROM automations WHERE guildId = @guildId AND promptText = @marker AND isEnabled = 1',
                    { guildId, marker: WHEEL_MARKER }
                );
                if (existing) {
                    await interaction.reply({
                        content: `🎡 The daily dedication already spins in <#${existing.channelId}>. \`/wheel unschedule\` first to move it.`,
                        ephemeral: true
                    });
                    return;
                }
                const nextRun = CronExpressionParser.parse(DAILY_CRON, { tz: 'UTC' }).next().toDate();
                db.run(
                    `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
                     VALUES (@userId, @guildId, @channelId, @name, @promptText, @schedule, @nextRun)`,
                    {
                        userId, guildId, channelId: interaction.channel.id,
                        name: 'Daily Ballistic Goblin Wheel Dedication',
                        promptText: WHEEL_MARKER, schedule: DAILY_CRON, nextRun
                    }
                );
                await interaction.reply(
                    '🎡 **The Daily Ballistic Goblin Wheel Dedication is scheduled.**\n' +
                    `- Channel: <#${interaction.channel.id}>\n` +
                    '- When: weekdays at 13:30 UTC (9:30 AM Eastern, US market open)\n' +
                    `- First spin: ${nextRun.toUTCString()}\n` +
                    'The Wheel demands its dedication. `/wheel optout` for the unbelievers.'
                );

            } else if (subcommand === 'unschedule') {
                const removed = db.run(
                    'DELETE FROM automations WHERE guildId = @guildId AND promptText = @marker',
                    { guildId, marker: WHEEL_MARKER }
                ).changes;
                await interaction.reply(removed > 0
                    ? '🎡 The daily dedication is silenced. The Wheel remembers.'
                    : 'There was no daily dedication scheduled.');
            }
        } catch (error) {
            const friendly = error instanceof ExchangeError || error instanceof EconomyError || error instanceof StockError;
            if (!friendly) console.error('Wheel command error:', error);
            const message = friendly ? `❌ ${error.message}` : '❌ The Wheel jammed. Something went wrong.';
            if (interaction.deferred || interaction.replied) await interaction.editReply(message);
            else await interaction.reply({ content: message, ephemeral: true });
        }
    },

    WHEEL_MARKER,
    buildWheelEmbed,
    resolveNames
};
