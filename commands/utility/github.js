const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const githubService = require('../../services/githubService');
const repoWatchService = require('../../services/repoWatchService');
const { WATCHABLE_EVENTS } = require('../../services/repoWatchService');
const integrationAudit = require('../../services/integrationAudit');
const aiService = require('../../services/aiService');
const usageTracker = require('../../services/usageTracker');

const GITHUB_COLOR = 0x24292f;

/** Optional AI blurb; never throws, null without a provider. */
async function tryBlurb(prompt, usageContext) {
    try {
        const text = await aiService.generateText(prompt, { max_tokens: 220, temperature: 0.4, usageContext });
        return text?.trim() || null;
    } catch {
        return null;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('github')
        .setDescription('GitHub repository integration.')
        .addSubcommand(sub =>
            sub.setName('watch')
                .setDescription('Post repo events into a channel (also allowlists the repo for chat tools)')
                .addStringOption(opt => opt.setName('repo').setDescription('Repository (owner/name or URL)').setRequired(true))
                .addChannelOption(opt => opt.setName('channel').setDescription('Channel for events (default: here)').addChannelTypes(ChannelType.GuildText))
                .addStringOption(opt => opt.setName('events').setDescription(`Comma-separated: ${WATCHABLE_EVENTS.join(', ')} (default: all)`)))
        .addSubcommand(sub =>
            sub.setName('unwatch')
                .setDescription('Stop watching a repository')
                .addStringOption(opt => opt.setName('repo').setDescription('Repository (owner/name)').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('watches')
                .setDescription('List this server\'s watched repositories'))
        .addSubcommand(sub =>
            sub.setName('repo')
                .setDescription('Repository overview')
                .addStringOption(opt => opt.setName('repo').setDescription('Repository (owner/name or URL)').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('pr')
                .setDescription('Summarize a pull request')
                .addStringOption(opt => opt.setName('repo').setDescription('Repository (owner/name)').setRequired(true))
                .addIntegerOption(opt => opt.setName('number').setDescription('PR number').setRequired(true).setMinValue(1)))
        .addSubcommand(sub =>
            sub.setName('issue')
                .setDescription('Show an issue')
                .addStringOption(opt => opt.setName('repo').setDescription('Repository (owner/name)').setRequired(true))
                .addIntegerOption(opt => opt.setName('number').setDescription('Issue number').setRequired(true).setMinValue(1))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'GitHub integration only works in servers.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        const usageContext = { guildId: interaction.guildId, userId: interaction.user.id };
        usageTracker.logCommand({ command: 'github', guildId: interaction.guildId, userId: interaction.user.id });

        try {
            if (subcommand === 'watch' || subcommand === 'unwatch') {
                if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                    await interaction.reply({ content: '❌ You need Manage Server permission to manage repo watches.', ephemeral: true });
                    return;
                }
            }

            if (subcommand === 'watch') {
                await interaction.deferReply();
                const repo = githubService.parseRepo(interaction.options.getString('repo'));
                const channel = interaction.options.getChannel('channel') || interaction.channel;
                const eventsRaw = interaction.options.getString('events');
                const requested = eventsRaw
                    ? eventsRaw.split(',').map(event => event.trim().toLowerCase()).filter(Boolean)
                    : [];
                const invalid = requested.filter(event => !WATCHABLE_EVENTS.includes(event));
                if (invalid.length) {
                    await interaction.editReply(`❌ Unknown event(s): ${invalid.join(', ')}. Valid: ${WATCHABLE_EVENTS.join(', ')}`);
                    return;
                }

                // Validate the repo exists (and is visible with the current token) before storing.
                const repoData = await githubService.getRepo(repo);
                const events = repoWatchService.addWatch({
                    guildId: interaction.guildId,
                    channelId: channel.id,
                    repo,
                    events: requested,
                    createdBy: interaction.user.id
                });
                integrationAudit.record({
                    guildId: interaction.guildId, userId: interaction.user.id,
                    action: 'github.watch', detail: { repo, channelId: channel.id, events }
                });

                await interaction.editReply(
                    `👀 Watching **[${repoData.full_name}](${repoData.html_url})** in <#${channel.id}>\n` +
                    `- Events: ${events.join(', ')}\n` +
                    `- Chat tools may now read this repo in this server.\n` +
                    (repoData.private ? '- Note: this is a private repo — events require the webhook + token setup.\n' : '') +
                    '\nTo receive live events, add a webhook in the repo settings pointing at `/api/webhooks/github` (see `documentation/github_cursor_integration.md`).'
                );
                return;
            }

            if (subcommand === 'unwatch') {
                await interaction.deferReply();
                const repo = githubService.parseRepo(interaction.options.getString('repo'));
                const removed = repoWatchService.removeWatch(interaction.guildId, repo);
                if (removed) {
                    integrationAudit.record({
                        guildId: interaction.guildId, userId: interaction.user.id,
                        action: 'github.unwatch', detail: { repo }
                    });
                }
                await interaction.editReply(removed ? `🚫 No longer watching **${repo}**.` : `**${repo}** wasn't being watched.`);
                return;
            }

            if (subcommand === 'watches') {
                const watches = repoWatchService.listWatches(interaction.guildId);
                if (!watches.length) {
                    await interaction.reply({ content: 'No repositories are being watched in this server. Add one with `/github watch`.', ephemeral: true });
                    return;
                }
                const lines = watches.map(watch =>
                    `- **${watch.repo}** → <#${watch.channelId}> (${watch.events.join(', ')})`
                );
                await interaction.reply({
                    embeds: [new EmbedBuilder().setColor(GITHUB_COLOR).setTitle('👀 Watched repositories').setDescription(lines.join('\n'))],
                    ephemeral: true
                });
                return;
            }

            if (subcommand === 'repo') {
                await interaction.deferReply();
                const repo = githubService.parseRepo(interaction.options.getString('repo'));
                const [data, commits] = await Promise.all([
                    githubService.getRepo(repo),
                    githubService.listCommits(repo, { limit: 3 }).catch(() => [])
                ]);
                const embed = new EmbedBuilder()
                    .setColor(GITHUB_COLOR)
                    .setTitle(data.full_name)
                    .setURL(data.html_url)
                    .setDescription(data.description || null)
                    .addFields(
                        { name: 'Stars', value: String(data.stargazers_count), inline: true },
                        { name: 'Forks', value: String(data.forks_count), inline: true },
                        { name: 'Open issues', value: String(data.open_issues_count), inline: true },
                        { name: 'Default branch', value: data.default_branch, inline: true },
                        { name: 'Language', value: data.language || '—', inline: true },
                        { name: 'Updated', value: new Date(data.pushed_at).toUTCString(), inline: true }
                    );
                if (commits.length) {
                    embed.addFields({
                        name: 'Recent commits',
                        value: commits.map(commit =>
                            `[\`${commit.sha.slice(0, 7)}\`](${commit.html_url}) ${String(commit.commit.message).split('\n')[0].slice(0, 70)}`
                        ).join('\n')
                    });
                }
                await interaction.editReply({ embeds: [embed] });
                return;
            }

            if (subcommand === 'pr') {
                await interaction.deferReply();
                const repo = githubService.parseRepo(interaction.options.getString('repo'));
                const number = interaction.options.getInteger('number');
                const [pr, files] = await Promise.all([
                    githubService.getPullRequest(repo, number),
                    githubService.listPullRequestFiles(repo, number).catch(() => [])
                ]);

                const state = pr.merged ? 'merged' : pr.state;
                const fileList = files.slice(0, 20).map(file => `${file.status[0].toUpperCase()} ${file.filename} (+${file.additions}/-${file.deletions})`).join('\n');
                const blurb = await tryBlurb(
                    `Summarize this GitHub pull request in 2-3 plain sentences for a Discord channel (what it changes and why it matters). No preamble.\n\n` +
                    `Title: ${pr.title}\nAuthor: ${pr.user?.login}\nDescription:\n${String(pr.body || '(none)').slice(0, 2000)}\n\nChanged files:\n${fileList || '(unavailable)'}`,
                    usageContext
                );

                const embed = new EmbedBuilder()
                    .setColor(pr.merged ? 0x8250df : GITHUB_COLOR)
                    .setTitle(`#${pr.number} ${pr.title}`.slice(0, 250))
                    .setURL(pr.html_url)
                    .setDescription(blurb || String(pr.body || 'No description.').slice(0, 1000))
                    .addFields(
                        { name: 'State', value: state, inline: true },
                        { name: 'Author', value: pr.user?.login || '—', inline: true },
                        { name: 'Diff', value: `+${pr.additions}/-${pr.deletions} in ${pr.changed_files} files`, inline: true }
                    )
                    .setFooter({ text: repo })
                    .setTimestamp(new Date(pr.updated_at));
                await interaction.editReply({ embeds: [embed] });
                return;
            }

            if (subcommand === 'issue') {
                await interaction.deferReply();
                const repo = githubService.parseRepo(interaction.options.getString('repo'));
                const number = interaction.options.getInteger('number');
                const issue = await githubService.getIssue(repo, number);
                const embed = new EmbedBuilder()
                    .setColor(GITHUB_COLOR)
                    .setTitle(`#${issue.number} ${issue.title}`.slice(0, 250))
                    .setURL(issue.html_url)
                    .setDescription(String(issue.body || 'No description.').slice(0, 1500))
                    .addFields(
                        { name: 'State', value: issue.state, inline: true },
                        { name: 'Author', value: issue.user?.login || '—', inline: true },
                        { name: 'Comments', value: String(issue.comments), inline: true }
                    )
                    .setFooter({ text: repo })
                    .setTimestamp(new Date(issue.updated_at));
                await interaction.editReply({ embeds: [embed] });
                return;
            }
        } catch (error) {
            console.error('GitHub command failed:', error);
            // 10062 (Unknown interaction) / 40060 (already acknowledged) are
            // transient Discord-side races: no response can be delivered, and
            // retrying just cascades more errors.
            if (error.code === 10062 || error.code === 40060) return;
            const message = `❌ ${error.message || 'Something went wrong talking to GitHub.'}`;
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply(message);
                } else {
                    await interaction.reply({ content: message, ephemeral: true });
                }
            } catch (replyError) {
                console.error('GitHub command error reply failed:', replyError);
            }
        }
    }
};
