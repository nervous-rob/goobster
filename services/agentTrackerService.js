const { EmbedBuilder } = require('discord.js');
const db = require('../db');
const cursorAgentService = require('./cursorAgentService');
const integrationsConfig = require('../config/integrationsConfig');

const STATUS_EMOJI = {
    CREATING: '⏳', PENDING: '⏳', QUEUED: '⏳', RUNNING: '🔧',
    FINISHED: '✅', ERROR: '❌', CANCELLED: '🛑', EXPIRED: '⌛'
};

/**
 * Tracks launched Cursor cloud-agent runs (`agent_runs` table) and posts
 * status changes back to the Discord channel that launched them.
 *
 * Primary mechanism is polling (works on a Pi behind NAT with no public
 * exposure); the optional Cursor webhook receiver feeds the same
 * `applyUpdate` path for instant updates when the server is reachable.
 * Tracked state lives in SQLite so restarts never orphan a run.
 */
class AgentTrackerService {
    constructor(client) {
        this.client = client;
        this.pollIntervalMs = integrationsConfig.cursor.pollIntervalMs;
        this.isRunning = false;
        this.timer = null;
    }

    start() {
        if (this.isRunning) return;
        if (!cursorAgentService.isConfigured()) {
            console.log('Agent tracker idle: Cursor integration not configured.');
            return;
        }
        this.isRunning = true;
        const loop = async () => {
            if (!this.isRunning) return;
            try {
                await this.pollActiveRuns();
            } catch (error) {
                console.error('Agent tracker poll failed:', error);
            }
            if (this.isRunning) this.timer = setTimeout(loop, this.pollIntervalMs);
        };
        this.timer = setTimeout(loop, this.pollIntervalMs);
        console.log('Agent tracker started');
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Record a newly launched (or followed-up) run so the poller watches it. */
    track({ agentId, runId, guildId, channelId, userId, repo, prompt, status, agentUrl }) {
        db.run(
            `INSERT INTO agent_runs (agentId, runId, guildId, channelId, userId, repo, prompt, status, agentUrl)
             VALUES (@agentId, @runId, @guildId, @channelId, @userId, @repo, @prompt, @status, @agentUrl)
             ON CONFLICT(agentId) DO UPDATE SET
                runId = excluded.runId,
                status = excluded.status,
                prompt = excluded.prompt,
                updatedAt = CURRENT_TIMESTAMP`,
            { agentId, runId, guildId, channelId, userId, repo, prompt: String(prompt).slice(0, 2000), status, agentUrl }
        );
    }

    /** Rows the poller still needs to watch. */
    getActiveRuns() {
        return db.all(
            `SELECT * FROM agent_runs
             WHERE status NOT IN ('FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED')`
        );
    }

    /** Recent tracked runs for a guild (newest first) for /agent status. */
    getRecentRuns(guildId, limit = 10) {
        return db.all(
            'SELECT * FROM agent_runs WHERE guildId = @guildId ORDER BY id DESC LIMIT @limit',
            { guildId, limit }
        );
    }

    getTrackedAgent(guildId, agentId) {
        return db.get(
            'SELECT * FROM agent_runs WHERE guildId = @guildId AND agentId = @agentId',
            { guildId, agentId }
        );
    }

    async pollActiveRuns() {
        for (const row of this.getActiveRuns()) {
            try {
                const run = await cursorAgentService.getRun(row.agentId, row.runId);
                const branchEntry = run.git?.branches?.find(branch => branch.prUrl) || run.git?.branches?.[0] || null;
                await this.applyUpdate({
                    agentId: row.agentId,
                    status: run.status,
                    summary: run.result || null,
                    prUrl: branchEntry?.prUrl || null,
                    branch: branchEntry?.branch || null
                });
            } catch (error) {
                if (error.code === 'NOT_FOUND') {
                    // Run disappeared server-side; stop polling it.
                    await this.applyUpdate({ agentId: row.agentId, status: 'EXPIRED', summary: 'Run no longer exists on the Cursor side.' });
                } else {
                    console.error(`Agent tracker: failed to poll ${row.agentId}:`, error);
                }
            }
        }
    }

    /**
     * Apply a status update (from polling or the Cursor webhook) and notify
     * the launch channel when something user-visible changed.
     */
    async applyUpdate({ agentId, status, summary = null, prUrl = null, branch = null }) {
        const row = db.get('SELECT * FROM agent_runs WHERE agentId = @agentId', { agentId });
        if (!row) return;

        const normalized = String(status || '').toUpperCase();
        const statusChanged = normalized && normalized !== row.status;
        const prAppeared = prUrl && prUrl !== row.prUrl;
        if (!statusChanged && !prAppeared) return;

        db.run(
            `UPDATE agent_runs SET
                status = @status,
                summary = COALESCE(@summary, summary),
                prUrl = COALESCE(@prUrl, prUrl),
                branch = COALESCE(@branch, branch),
                updatedAt = CURRENT_TIMESTAMP
             WHERE agentId = @agentId`,
            { agentId, status: normalized || row.status, summary, prUrl, branch }
        );

        await this._notify({ ...row, status: normalized || row.status, summary: summary || row.summary, prUrl: prUrl || row.prUrl, branch: branch || row.branch });
    }

    async _notify(row) {
        try {
            const channel = await this.client.channels.fetch(row.channelId);
            if (!channel?.isTextBased?.()) return;

            const emoji = STATUS_EMOJI[row.status] || '🤖';
            const embed = new EmbedBuilder()
                .setColor(row.status === 'FINISHED' ? 0x2ea043 : row.status === 'ERROR' ? 0xda3633 : 0x5865f2)
                .setTitle(`${emoji} Cursor agent ${row.status.toLowerCase()}: ${String(row.prompt).slice(0, 120)}`)
                .setDescription(row.summary ? String(row.summary).slice(0, 1000) : null)
                .setFooter({ text: row.repo || 'Cursor cloud agent' })
                .setTimestamp();
            if (row.agentUrl) embed.setURL(row.agentUrl);

            const links = [];
            if (row.prUrl) links.push(`**PR:** ${row.prUrl}`);
            else if (row.branch) links.push(`**Branch:** \`${row.branch}\``);
            if (links.length) {
                embed.addFields({ name: 'Output', value: links.join('\n') });
            }

            await channel.send({ content: row.status === 'FINISHED' || row.status === 'ERROR' ? `<@${row.userId}>` : undefined, embeds: [embed] });
        } catch (error) {
            console.error(`Agent tracker: failed to notify channel ${row.channelId}:`, error);
        }
    }
}

module.exports = AgentTrackerService;
