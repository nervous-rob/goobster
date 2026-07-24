const { EmbedBuilder } = require('discord.js');
const db = require('../db');

// Event keys guilds can subscribe to, and the GitHub webhook events they map to.
const WATCHABLE_EVENTS = ['push', 'pull_request', 'issues', 'release', 'ci'];
const GITHUB_EVENT_TO_KEY = {
    push: 'push',
    pull_request: 'pull_request',
    issues: 'issues',
    release: 'release',
    workflow_run: 'ci'
};

const GITHUB_COLOR = 0x24292f;
const FAILURE_COLOR = 0xda3633;
const MERGE_COLOR = 0x8250df;

/**
 * Repo watches: which guild channels follow which GitHub repositories, and
 * how incoming webhook events become Discord posts. The watch list doubles
 * as the per-guild repo allowlist for the GitHub chat tools — a repo must be
 * watched (admin action) before tools may read from it.
 */
class RepoWatchService {
    /** Add or replace a guild's watch on a repo. `events` is a subset of WATCHABLE_EVENTS. */
    addWatch({ guildId, channelId, repo, events, createdBy }) {
        const filtered = (events || []).filter(event => WATCHABLE_EVENTS.includes(event));
        const effective = filtered.length ? filtered : [...WATCHABLE_EVENTS];
        db.run(
            `INSERT INTO repo_watches (guildId, channelId, repo, events, createdBy)
             VALUES (@guildId, @channelId, @repo, @events, @createdBy)
             ON CONFLICT(guildId, repo) DO UPDATE SET
                channelId = excluded.channelId,
                events = excluded.events,
                createdBy = excluded.createdBy`,
            { guildId, channelId, repo, events: JSON.stringify(effective), createdBy }
        );
        return effective;
    }

    /** @returns {boolean} true when a watch existed and was removed */
    removeWatch(guildId, repo) {
        const result = db.run(
            'DELETE FROM repo_watches WHERE guildId = @guildId AND repo = @repo',
            { guildId, repo }
        );
        return (result?.changes ?? 0) > 0;
    }

    listWatches(guildId) {
        return db.all(
            'SELECT repo, channelId, events, createdBy, createdAt FROM repo_watches WHERE guildId = @guildId ORDER BY repo',
            { guildId }
        ).map(row => ({ ...row, events: JSON.parse(row.events) }));
    }

    /** Allowlist check for the GitHub chat tools: is this repo watched in this guild? */
    isRepoAllowed(guildId, repo) {
        return Boolean(db.get(
            'SELECT 1 AS ok FROM repo_watches WHERE guildId = @guildId AND repo = @repo',
            { guildId, repo }
        ));
    }

    /** Every watch (across guilds) subscribed to `eventKey` on `repo`. */
    findWatches(repo, eventKey) {
        return db.all(
            'SELECT guildId, channelId, events FROM repo_watches WHERE repo = @repo',
            { repo }
        ).filter(row => JSON.parse(row.events).includes(eventKey));
    }

    /**
     * Turn a verified GitHub webhook delivery into Discord posts in every
     * watching channel. Unknown/uninteresting events are ignored silently.
     * Never throws — webhook handling must not take down the receiver.
     *
     * @param {{client: import('discord.js').Client, event: string, payload: object, logger?: object}} params
     * @returns {Promise<number>} number of channels notified
     */
    async handleEvent({ client, event, payload, logger = console }) {
        try {
            const eventKey = GITHUB_EVENT_TO_KEY[event];
            const repo = payload?.repository?.full_name;
            if (!eventKey || !repo) return 0;

            const embed = this._buildEmbed(event, payload);
            if (!embed) return 0;

            const watches = this.findWatches(repo, eventKey);
            let delivered = 0;
            for (const watch of watches) {
                try {
                    const channel = await client.channels.fetch(watch.channelId);
                    if (!channel?.isTextBased?.()) continue;
                    await channel.send({ embeds: [embed] });
                    delivered += 1;
                } catch (error) {
                    logger.error?.(`Failed to deliver GitHub event to channel ${watch.channelId}:`, error);
                }
            }
            return delivered;
        } catch (error) {
            logger.error?.('GitHub webhook handling failed:', error);
            return 0;
        }
    }

    /** @returns {EmbedBuilder|null} null = event not worth posting */
    _buildEmbed(event, payload) {
        const repo = payload.repository?.full_name;
        const actor = payload.sender?.login || 'someone';

        if (event === 'push') {
            const commits = payload.commits || [];
            if (!commits.length) return null; // branch deletes, tag pushes
            const branch = String(payload.ref || '').replace('refs/heads/', '');
            const lines = commits.slice(0, 5).map(commit =>
                `[\`${commit.id.slice(0, 7)}\`](${commit.url}) ${String(commit.message).split('\n')[0].slice(0, 80)}`
            );
            if (commits.length > 5) lines.push(`…and ${commits.length - 5} more`);
            return new EmbedBuilder()
                .setColor(GITHUB_COLOR)
                .setTitle(`⬆️ ${commits.length} commit${commits.length === 1 ? '' : 's'} to ${repo}:${branch}`)
                .setURL(payload.compare || null)
                .setDescription(lines.join('\n'))
                .setFooter({ text: `pushed by ${actor}` })
                .setTimestamp();
        }

        if (event === 'pull_request') {
            const pr = payload.pull_request;
            const action = payload.action;
            let headline = null;
            let color = GITHUB_COLOR;
            if (action === 'opened') headline = '🔀 PR opened';
            else if (action === 'reopened') headline = '🔀 PR reopened';
            else if (action === 'ready_for_review') headline = '🔀 PR ready for review';
            else if (action === 'closed' && pr.merged) { headline = '🟣 PR merged'; color = MERGE_COLOR; }
            else if (action === 'closed') headline = '❌ PR closed';
            if (!headline) return null;
            return new EmbedBuilder()
                .setColor(color)
                .setTitle(`${headline}: #${pr.number} ${String(pr.title).slice(0, 200)}`)
                .setURL(pr.html_url)
                .setDescription(pr.body ? String(pr.body).slice(0, 300) : null)
                .setFooter({ text: `${repo} • by ${actor}` })
                .setTimestamp();
        }

        if (event === 'issues') {
            const issue = payload.issue;
            const action = payload.action;
            if (!['opened', 'reopened', 'closed'].includes(action)) return null;
            const emoji = action === 'closed' ? '✅' : '🐛';
            return new EmbedBuilder()
                .setColor(GITHUB_COLOR)
                .setTitle(`${emoji} Issue ${action}: #${issue.number} ${String(issue.title).slice(0, 200)}`)
                .setURL(issue.html_url)
                .setDescription(action === 'opened' && issue.body ? String(issue.body).slice(0, 300) : null)
                .setFooter({ text: `${repo} • by ${actor}` })
                .setTimestamp();
        }

        if (event === 'release') {
            if (payload.action !== 'published') return null;
            const release = payload.release;
            return new EmbedBuilder()
                .setColor(GITHUB_COLOR)
                .setTitle(`🚀 Release published: ${release.name || release.tag_name}`)
                .setURL(release.html_url)
                .setDescription(release.body ? String(release.body).slice(0, 1000) : null)
                .setFooter({ text: repo })
                .setTimestamp();
        }

        if (event === 'workflow_run') {
            // Failures only — green runs would drown the channel.
            const run = payload.workflow_run;
            if (payload.action !== 'completed' || run.conclusion !== 'failure') return null;
            return new EmbedBuilder()
                .setColor(FAILURE_COLOR)
                .setTitle(`❌ CI failed: ${run.name} on ${run.head_branch}`)
                .setURL(run.html_url)
                .setDescription(`Commit: \`${String(run.head_sha).slice(0, 7)}\` ${String(run.head_commit?.message || '').split('\n')[0].slice(0, 120)}`)
                .setFooter({ text: repo })
                .setTimestamp();
        }

        return null;
    }
}

module.exports = new RepoWatchService();
module.exports.RepoWatchService = RepoWatchService;
module.exports.WATCHABLE_EVENTS = WATCHABLE_EVENTS;
