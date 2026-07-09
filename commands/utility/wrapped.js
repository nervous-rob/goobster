const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { CronExpressionParser } = require('cron-parser');
const db = require('../../db');
const wrappedService = require('../../services/wrappedService');
const usageTracker = require('../../services/usageTracker');
const { WRAPPED_MARKER, buildWrappedMessage } = require('../../utils/serverWrapped');

// 1st of every month at 17:00 UTC
const MONTHLY_CRON = '0 17 1 * *';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('wrapped')
        .setDescription('Server Wrapped - a shareable recap of this server\'s activity.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('show')
                .setDescription('Post the Server Wrapped recap for a period')
                .addStringOption(option =>
                    option.setName('period')
                        .setDescription('Which period to wrap (default: last month)')
                        .addChoices(
                            { name: 'Last month', value: 'last-month' },
                            { name: 'This month', value: 'this-month' },
                            { name: 'This year', value: 'this-year' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('schedule')
                .setDescription('Post last month\'s Wrapped in this channel on the 1st of every month'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('unschedule')
                .setDescription('Stop the monthly Wrapped post')),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Server Wrapped only works in servers.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'show') {
            // Public on purpose: the whole point is sharing
            await interaction.deferReply();

            usageTracker.logCommand({
                command: 'wrapped',
                guildId: interaction.guildId,
                userId: interaction.user.id
            });

            try {
                const period = wrappedService.resolvePeriod(
                    interaction.options.getString('period') ?? 'last-month'
                );
                const message = await buildWrappedMessage({
                    guild: interaction.guild,
                    period,
                    usageContext: { guildId: interaction.guildId, userId: interaction.user.id }
                });
                await interaction.editReply(message);
            } catch (error) {
                console.error('Wrapped generation failed:', error);
                await interaction.editReply(`❌ Couldn't build the Wrapped: ${error.message}`);
            }
        } else if (subcommand === 'schedule' || subcommand === 'unschedule') {
            // Scheduling recurring content warrants Manage Guild
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                await interaction.reply({ content: '❌ You need Manage Server permission to manage the monthly Wrapped.', ephemeral: true });
                return;
            }

            if (subcommand === 'schedule') {
                const existing = db.get(
                    `SELECT id, channelId FROM automations
                     WHERE guildId = @guildId AND promptText = @marker AND isEnabled = 1`,
                    { guildId: interaction.guildId, marker: WRAPPED_MARKER }
                );
                if (existing) {
                    await interaction.reply({
                        content: `🎁 A monthly Wrapped is already scheduled in <#${existing.channelId}>. Run \`/wrapped unschedule\` first to move it.`,
                        ephemeral: true
                    });
                    return;
                }

                const nextRun = CronExpressionParser.parse(MONTHLY_CRON).next().toDate();
                db.run(
                    `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun)
                     VALUES (@userId, @guildId, @channelId, @name, @promptText, @schedule, @nextRun)`,
                    {
                        userId: interaction.user.id,
                        guildId: interaction.guildId,
                        channelId: interaction.channel.id,
                        name: 'Monthly Server Wrapped',
                        promptText: WRAPPED_MARKER,
                        schedule: MONTHLY_CRON,
                        nextRun
                    }
                );

                await interaction.reply({
                    content:
                        '🎁 **Monthly Wrapped scheduled!**\n\n' +
                        `- Channel: <#${interaction.channel.id}>\n` +
                        '- When: 1st of every month (17:00 UTC), covering the month that just ended\n' +
                        `- Next post: ${nextRun.toUTCString()}\n\n` +
                        'Manage it with `/wrapped unschedule` or the `/automation` command.',
                    ephemeral: true
                });
            } else {
                const removed = db.run(
                    'DELETE FROM automations WHERE guildId = @guildId AND promptText = @marker',
                    { guildId: interaction.guildId, marker: WRAPPED_MARKER }
                ).changes;

                await interaction.reply({
                    content: removed > 0
                        ? '🗑️ Monthly Wrapped unscheduled.'
                        : 'There was no monthly Wrapped scheduled.',
                    ephemeral: true
                });
            }
        }
    }
};
