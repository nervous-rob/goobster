const { SlashCommandBuilder } = require('discord.js');
const attentionService = require('@goobster/core/services/attentionService');
const attentionLedgerService = require('@goobster/core/services/attentionLedgerService');
const attentionPolicyService = require('@goobster/core/services/attentionPolicyService');
const attentionWatchService = require('@goobster/core/services/attentionWatchService');
const attentionConfig = require('@goobster/core/config/attentionConfig');

/**
 * /attention — the user's control surface for proactive attention.
 *
 * Deliberately a personal command rather than a server setting: attention is
 * per-person (its unit is your open loops, not a channel), so it is DM-capable
 * and needs no guild permission. Enrollment is explicit — until somebody runs
 * `/attention enable`, none of this runs for them.
 */

const INITIATIVE_BLURB = {
    observe: 'I notice and remember things but never reach out. Everything lands in the inbox for you to look at.',
    nudge: 'I may surface things I think are useful, including a DM when something genuinely warrants one.',
    assist: 'As nudge, plus I may do reversible, read-only work on your behalf and tell you what I found.',
    delegate: 'As assist, plus I may start pre-authorized kinds of action without asking first.'
};

const STATE_ICON = {
    candidate: '○',
    corroborated: '◐',
    active: '●',
    resolved: '✓',
    abandoned: '×'
};

function describeItem(item) {
    const bits = [];
    if (item.deadlineAt) bits.push(`due ${item.deadlineAt} UTC`);
    if (item.unresolved.length > 0) bits.push(`open: ${item.unresolved.join('; ')}`);
    return `${STATE_ICON[item.state] || '•'} **${item.subject}** _(${item.kind})_`
        + `${item.goal ? ` — ${item.goal}` : ''}`
        + `${bits.length > 0 ? `\n   ${bits.join(' · ')}` : ''}`;
}

module.exports = {
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('attention')
        .setDescription('Control whether Goobster keeps track of your open loops and reaches out on his own.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Let Goobster track what matters to you and decide when to speak up')
                .addStringOption(option =>
                    option
                        .setName('initiative')
                        .setDescription('How much initiative he gets (default: nudge)')
                        .addChoices(
                            { name: 'observe - notices, never reaches out', value: 'observe' },
                            { name: 'nudge - may surface useful things', value: 'nudge' },
                            { name: 'assist - may also do read-only work', value: 'assist' },
                            { name: 'delegate - may take pre-authorized action', value: 'delegate' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Stop proactive attention (your ledger and settings are kept)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show your initiative level, open loops, and armed watches'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('inbox')
                .setDescription('Everything Goobster noticed but did not interrupt you about'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('dismiss')
                .setDescription('Dismiss a notice (which also teaches him to raise that kind less)')
                .addIntegerOption(option =>
                    option
                        .setName('id')
                        .setDescription('The notice id from /attention inbox')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('quiet')
                .setDescription('Set do-not-disturb hours (UTC), or clear them')
                .addIntegerOption(option =>
                    option.setName('start').setDescription('Start hour, 0-23 (omit both to clear)'))
                .addIntegerOption(option =>
                    option.setName('end').setDescription('End hour, 0-23')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('budget')
                .setDescription('Cap how often he may reach out')
                .addIntegerOption(option =>
                    option.setName('per-day').setDescription('Maximum DMs per day (0-20)'))
                .addIntegerOption(option =>
                    option.setName('cooldown').setDescription('Minimum minutes between DMs (5-1440)')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('watches')
                .setDescription('Show the conditions he is currently waiting on')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const userId = interaction.user.id;

        if (subcommand === 'enable') {
            const initiative = interaction.options.getString('initiative') || 'nudge';
            const policy = await attentionPolicyService.setInitiative(userId, initiative);
            await interaction.reply({
                content: '🧭 **Proactive attention enabled.**\n\n'
                    + `Initiative level: **${policy.initiative}** — ${INITIATIVE_BLURB[policy.initiative]}\n\n`
                    + 'From now on I keep a small ledger of your open loops — commitments, deadlines, things '
                    + 'you are waiting on — and check whether anything about them changed. Most of what I notice '
                    + 'will quietly land in `/attention inbox` rather than reaching you; I only DM you when '
                    + `something clears a fairly high bar, at most ${policy.maxContactsPerDay}x a day and no more `
                    + `often than every ${policy.contactCooldownMinutes} minutes.\n\n`
                    + 'Dismissing things teaches me to raise that kind less. Turn it all off with `/attention disable`.',
                ephemeral: true
            });
            return;
        }

        if (subcommand === 'disable') {
            const had = await attentionPolicyService.disable(userId);
            await interaction.reply({
                content: had
                    ? '😴 **Proactive attention disabled.** I will not reach out or track new loops. '
                        + 'Your ledger and settings are kept, so re-enabling picks up where you left off '
                        + '(use `/forget-me` to erase everything instead).'
                    : 'Proactive attention was not enabled.',
                ephemeral: true
            });
            return;
        }

        if (subcommand === 'status') {
            const policy = await attentionPolicyService.get(userId);
            if (!policy) {
                await interaction.reply({
                    content: 'Proactive attention is off. Turn it on with `/attention enable`.',
                    ephemeral: true
                });
                return;
            }
            const stats = await attentionLedgerService.getStats(userId);
            const items = await attentionLedgerService.listItems({ userId, limit: 10 });
            const notices = await attentionService.listNotices({ userId, limit: 100 });
            const watches = await attentionWatchService.list({ userId });

            const lines = [
                `🧭 **Proactive attention:** ${policy.enabled ? '✅ on' : '❌ off'}`,
                `**Initiative:** ${policy.initiative} — ${INITIATIVE_BLURB[policy.initiative]}`,
                `**Contact budget:** up to ${policy.maxContactsPerDay}/day, ${policy.contactCooldownMinutes} min apart`,
                policy.quietStartMinute === null
                    ? '**Quiet hours:** none set'
                    : `**Quiet hours:** ${String(Math.floor(policy.quietStartMinute / 60)).padStart(2, '0')}:00–${String(Math.floor(policy.quietEndMinute / 60)).padStart(2, '0')}:00 UTC`,
                '',
                `**Open loops:** ${stats.active} active, ${stats.corroborated} corroborated, ${stats.candidate} unconfirmed`,
                `**Inbox:** ${notices.length} waiting · **Watches armed:** ${watches.length}`
            ];
            if (items.length > 0) {
                lines.push('', '**What I am tracking:**', ...items.map(describeItem));
            }
            await interaction.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true });
            return;
        }

        if (subcommand === 'inbox') {
            const notices = await attentionService.listNotices({ userId, limit: 20 });
            if (notices.length === 0) {
                await interaction.reply({
                    content: 'Nothing in the inbox. Either nothing changed, or nothing that changed was worth your time.',
                    ephemeral: true
                });
                return;
            }
            const lines = notices.map(notice => {
                // Quiet things get a hollow bullet; things that reached out got a solid one.
                const bullet = notice.disposition === 'inbox' ? '○' : '●';
                return `${bullet} \`#${notice.id}\` **${notice.title}**`
                    + `${notice.detail ? `\n   ${notice.detail}` : ''}`
                    + `\n   _${notice.category} · score ${notice.score.toFixed(2)} · ${notice.disposition}${notice.reason ? ` · ${notice.reason}` : ''}_`;
            });
            await interaction.reply({
                content: ['**🔔 Goobster noticed**', '', ...lines].join('\n').slice(0, 1900)
                    + '\n\nDismiss one with `/attention dismiss id:<n>` — that also teaches me to raise that kind less.',
                ephemeral: true
            });
            return;
        }

        if (subcommand === 'dismiss') {
            const noticeId = interaction.options.getInteger('id');
            const notice = await attentionService.actOnNotice({ userId, noticeId, action: 'dismiss' });
            await interaction.reply({
                content: notice
                    ? `👍 Dismissed "${notice.title}". I will raise ${notice.category} things a little less readily.`
                    : `❌ No notice \`#${noticeId}\` of yours. Check \`/attention inbox\`.`,
                ephemeral: true
            });
            return;
        }

        if (subcommand === 'quiet') {
            const start = interaction.options.getInteger('start');
            const end = interaction.options.getInteger('end');
            try {
                const policy = await attentionPolicyService.setQuietHours({
                    userId,
                    startMinute: start === null ? null : start * 60,
                    endMinute: end === null ? null : end * 60
                });
                await interaction.reply({
                    content: policy.quietStartMinute === null
                        ? '🔔 Quiet hours cleared.'
                        : `🌙 Quiet hours set to ${String(start).padStart(2, '0')}:00–${String(end).padStart(2, '0')}:00 UTC. `
                            + 'I will not reach out during that window; things still accumulate in the inbox.',
                    ephemeral: true
                });
            } catch (error) {
                await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
            }
            return;
        }

        if (subcommand === 'budget') {
            const perDay = interaction.options.getInteger('per-day');
            const cooldown = interaction.options.getInteger('cooldown');
            if (perDay === null && cooldown === null) {
                await interaction.reply({
                    content: 'Give me `per-day`, `cooldown`, or both.',
                    ephemeral: true
                });
                return;
            }
            const policy = await attentionPolicyService.setBudget({
                userId,
                maxContactsPerDay: perDay,
                contactCooldownMinutes: cooldown
            });
            await interaction.reply({
                content: `📉 Budget set: at most **${policy.maxContactsPerDay}** DMs a day, `
                    + `at least **${policy.contactCooldownMinutes}** minutes apart.`
                    + (policy.maxContactsPerDay === 0
                        ? ' At zero I will never DM you — everything goes to the inbox.'
                        : ''),
                ephemeral: true
            });
            return;
        }

        if (subcommand === 'watches') {
            const watches = await attentionWatchService.list({
                userId,
                statuses: ['ARMED', 'FIRED', 'FAILED']
            });
            if (watches.length === 0) {
                await interaction.reply({
                    content: 'No watches. Ask me to "let you know how something turns out" and I will arm one — '
                        + 'a watch waits for a condition instead of a clock.',
                    ephemeral: true
                });
                return;
            }
            const lines = watches.map(watch =>
                `${watch.status === 'ARMED' ? '🔔' : watch.status === 'FIRED' ? '✅' : '⚠️'} **${watch.label}** `
                + `on \`${watch.topic}\`${watch.condition ? ` ${JSON.stringify(watch.condition)}` : ''}`
                + `\n   ${watch.prompt.slice(0, 160)}`
                + `${watch.lastFiredAt ? `\n   _fired ${watch.lastFiredAt} UTC_` : ''}`
                + `${watch.lastError ? `\n   _failed: ${watch.lastError}_` : ''}`
            );
            await interaction.reply({
                content: ['**Watches**', '', ...lines].join('\n').slice(0, 1900),
                ephemeral: true
            });
            return;
        }

        await interaction.reply({
            content: `Unknown subcommand. Levels available: ${attentionConfig.INITIATIVE_LEVELS.join(', ')}.`,
            ephemeral: true
        });
    }
};
