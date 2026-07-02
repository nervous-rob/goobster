const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { CronExpressionParser } = require('cron-parser');
const db = require('../../db');
const aiService = require('../../services/aiService');
const { generateDigest } = require('../../utils/channelDigest');

// Marker promptText that tells automationService to run a digest instead of chat
const DIGEST_MARKER = '__CHANNEL_DIGEST__';

/**
 * Convert natural language scheduling to a cron expression via a cheap
 * deterministic model call.
 */
async function convertToCron(schedule) {
    const cronText = (await aiService.generateText(
        `Convert this natural language schedule into a standard 5-part cron expression (minute hour day-of-month month day-of-week), with exactly one space between parts. Respond with ONLY the cron expression.

Examples:
- "every day at 9pm" -> "0 21 * * *"
- "weekdays at 8am" -> "0 8 * * 1-5"
- "every Sunday evening" -> "0 19 * * 0"

Schedule: "${schedule}"`,
        { temperature: 0.1, max_tokens: 20 }
    )).trim().replace(/^["']|["']$/g, '');

    // Validate before storing
    CronExpressionParser.parse(cronText);
    return cronText;
}

module.exports = {
    DIGEST_MARKER,

    data: new SlashCommandBuilder()
        .setName('digest')
        .setDescription('AI summaries of channel activity.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('now')
                .setDescription('Summarize this channel\'s recent activity')
                .addIntegerOption(option =>
                    option.setName('hours')
                        .setDescription('How far back to look (default 24, max 72)')
                        .setMinValue(1)
                        .setMaxValue(72)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('schedule')
                .setDescription('Schedule a recurring digest of this channel')
                .addStringOption(option =>
                    option.setName('when')
                        .setDescription('Natural language schedule, e.g. "every day at 9pm"')
                        .setRequired(true))
                .addIntegerOption(option =>
                    option.setName('hours')
                        .setDescription('Window each digest covers (default 24)')
                        .setMinValue(1)
                        .setMaxValue(72))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Digests only work in servers.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'now') {
            await interaction.deferReply();
            const hours = interaction.options.getInteger('hours') ?? 24;

            try {
                const digest = await generateDigest(interaction.channel, hours, {
                    usageContext: { guildId: interaction.guildId, userId: interaction.user.id }
                });

                if (!digest) {
                    await interaction.editReply(`It's been pretty quiet in here over the last ${hours} hours - not enough to digest!`);
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor('#43B581')
                    .setTitle(`📰 #${interaction.channel.name} - last ${hours}h`)
                    .setDescription(digest.slice(0, 4000))
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Digest generation failed:', error);
                await interaction.editReply(`❌ Couldn't generate the digest: ${error.message}`);
            }
        } else if (subcommand === 'schedule') {
            // Scheduling recurring content warrants Manage Guild
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                await interaction.reply({ content: '❌ You need Manage Server permission to schedule digests.', ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });
            const when = interaction.options.getString('when');
            const hours = interaction.options.getInteger('hours') ?? 24;

            try {
                const cron = await convertToCron(when);
                const nextRun = CronExpressionParser.parse(cron).next().toDate();

                db.run(
                    `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, nextRun, metadata)
                     VALUES (@userId, @guildId, @channelId, @name, @promptText, @schedule, @nextRun, @metadata)`,
                    {
                        userId: interaction.user.id,
                        guildId: interaction.guildId,
                        channelId: interaction.channel.id,
                        name: `Digest of #${interaction.channel.name}`,
                        promptText: DIGEST_MARKER,
                        schedule: cron,
                        nextRun,
                        metadata: JSON.stringify({ digest: { hours } })
                    }
                );

                await interaction.editReply(
                    `📰 **Digest scheduled!**\n\n` +
                    `- Channel: <#${interaction.channel.id}>\n` +
                    `- Schedule: \`${cron}\` (${when})\n` +
                    `- Window: last ${hours}h each run\n` +
                    `- Next run: ${nextRun.toUTCString()}\n\n` +
                    'Manage it with the `/automation` command.'
                );
            } catch (error) {
                console.error('Digest scheduling failed:', error);
                await interaction.editReply(`❌ Couldn't schedule that: ${error.message}`);
            }
        }
    }
};
