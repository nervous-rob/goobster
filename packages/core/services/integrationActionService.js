const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db');
const integrationAudit = require('./integrationAudit');
const approvalExecutor = require('../utils/approvalExecutor');

// A proposal nobody confirms goes stale after this long.
const PENDING_TTL_MINUTES = 15;

/**
 * Confirmable integration actions. The chat tools never execute write-side
 * integration work directly: they store a pending action (SQLite, so a
 * pending confirmation survives a restart) and post Confirm/Cancel buttons.
 * A member with Manage Server resolves it; execution happens here.
 */
class IntegrationActionService {
    /**
     * Store a pending action and return the button message payload to post.
     * @param {{type: 'agent-launch'|'github-issue', guildId: string, channelId: string, requestedBy?: string, payload: object}} params
     * @returns {{id: number, message: object}}
     */
    async createPending({ type, guildId, channelId, requestedBy = null, payload }) {
        const result = await db.insert(
            `INSERT INTO pending_integration_actions (type, guildId, channelId, requestedBy, payload)
             VALUES (@type, @guildId, @channelId, @requestedBy, @payload)`,
            { type, guildId, channelId, requestedBy, payload: JSON.stringify(payload) }
        );
        const id = Number(result);

        const embed = new EmbedBuilder()
            .setColor(0xf0b429)
            .setTitle(type === 'agent-launch' ? '🤖 Launch a Cursor agent?' : '🐛 Create a GitHub issue?')
            .setDescription(this._describe(type, payload))
            .setFooter({ text: 'Requires Manage Server • expires in 15 minutes' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_intaction_${id}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`deny_intaction_${id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
        );

        return { id, message: { embeds: [embed], components: [row] } };
    }

    _describe(type, payload) {
        if (type === 'agent-launch') {
            return `**Repo:** ${payload.repo}${payload.branch ? ` (branch \`${payload.branch}\`)` : ''}\n**Task:** ${String(payload.prompt).slice(0, 800)}`;
        }
        return `**Repo:** ${payload.repo}\n**Title:** ${String(payload.title).slice(0, 200)}\n\n${String(payload.body || '').slice(0, 800)}`;
    }

    /** The pending row, or null when missing/already resolved/expired (expiry is persisted). */
    async getPending(id) {
        const row = await db.get('SELECT * FROM pending_integration_actions WHERE id = @id', { id });
        if (!row || row.status !== 'PENDING') return null;
        const expired = await db.get(
            `SELECT 1 AS stale FROM pending_integration_actions
             WHERE id = @id AND createdAt <= datetime('now', '-${PENDING_TTL_MINUTES} minutes')`,
            { id }
        );
        if (expired) {
            await this._resolve(id, 'EXPIRED', null);
            return null;
        }
        return { ...row, payload: JSON.parse(row.payload) };
    }

    async _resolve(id, status, resolvedBy) {
        await approvalExecutor.resolveFromPending(db, {
            table: 'pending_integration_actions', id, status, resolvedBy
        });
    }

    /**
     * Handle a Confirm/Cancel button press. Permission-checks the presser,
     * executes the action on confirm, and returns the message edit to apply
     * to the button message.
     * @param {'approve'|'deny'} action
     * @param {number} id
     * @param {import('discord.js').ButtonInteraction} interaction
     * @returns {Promise<{content?: string, embeds?: object[], components: []}>}
     */
    async handleButton(action, id, interaction) {
        const pending = await this.getPending(id);
        if (!pending) {
            const recovered = await approvalExecutor.finishStoredReceipt(db, {
                table: 'pending_integration_actions', id, status: 'CONFIRMED',
                resolvedBy: interaction.user.id
            });
            if (recovered) {
                return { content: '✅ Confirmed (recovered a stored receipt).', embeds: [], components: [] };
            }
            const row = await db.get(
                'SELECT status FROM pending_integration_actions WHERE id = @id', { id }
            );
            if (row?.status === 'EXECUTING') {
                return { content: '⏳ This request is already being processed.', embeds: [], components: [] };
            }
            return { content: '⌛ This request is no longer pending (already handled or expired).', embeds: [], components: [] };
        }
        if (pending.guildId !== interaction.guildId) {
            return { content: '❌ This request belongs to a different server.', embeds: [], components: [] };
        }
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            // Leave the buttons up for someone who can confirm.
            await interaction.followUp({ content: '❌ You need Manage Server permission to resolve this.', ephemeral: true });
            return null;
        }

        if (action === 'deny') {
            const cancelled = await approvalExecutor.resolveFromPending(db, {
                table: 'pending_integration_actions', id, status: 'CANCELLED',
                resolvedBy: interaction.user.id
            });
            if (!cancelled) {
                return { content: '⌛ This request is no longer pending (already handled or expired).', embeds: [], components: [] };
            }
            await integrationAudit.record({
                guildId: pending.guildId, userId: interaction.user.id,
                action: `${pending.type}.cancelled`, detail: { pendingId: id }
            });
            return { content: `🚫 Cancelled by <@${interaction.user.id}>.`, embeds: [], components: [] };
        }

        const claimed = await approvalExecutor.claimPending(db, {
            table: 'pending_integration_actions', id, resolvedBy: interaction.user.id
        });
        if (!claimed) {
            return { content: '⏳ This request is already being processed.', embeds: [], components: [] };
        }
        const work = { ...claimed, payload: JSON.parse(claimed.payload) };

        let executed = false;
        try {
            const edit = await this._execute(work, interaction);
            executed = true;
            await approvalExecutor.persistReceipt(db, {
                table: 'pending_integration_actions',
                id,
                resultJson: JSON.stringify({ ok: true })
            });
            await approvalExecutor.finishClaim(db, {
                table: 'pending_integration_actions',
                id,
                status: 'CONFIRMED',
                resolvedBy: interaction.user.id,
                resultJson: JSON.stringify({ ok: true })
            });
            return edit;
        } catch (error) {
            console.error(`Integration action ${id} (${work.type}) failed:`, error);
            const row = await db.get(
                'SELECT resultJson FROM pending_integration_actions WHERE id = @id',
                { id }
            );
            const hasReceipt = Boolean(row?.resultJson) || error.code === 'RECEIPT_UNCONFIRMED';
            if (hasReceipt) {
                if (error.code === 'RECEIPT_UNCONFIRMED' && !row?.resultJson) {
                    try {
                        await approvalExecutor.persistReceipt(db, {
                            table: 'pending_integration_actions',
                            id,
                            resultJson: JSON.stringify(error.result || { ok: true })
                        });
                    } catch { /* recoverStuckApprovals finishes a stored receipt */ }
                }
                await interaction.followUp({
                    content: `❌ ${error.message || 'The action finished but follow-up work failed.'} (Not retried — the side effect already happened.)`,
                    ephemeral: true
                }).catch(() => {});
                return null;
            }
            if (!executed) {
                await approvalExecutor.releaseClaim(db, { table: 'pending_integration_actions', id });
                await interaction.followUp({
                    content: `❌ ${error.message || 'The action failed.'} (Still pending — fix the problem and press Confirm again.)`,
                    ephemeral: true
                }).catch(() => {});
            } else {
                await interaction.followUp({
                    content: `❌ ${error.message || 'The action finished but the receipt could not be stored.'} (Not retried — the side effect may already have happened.)`,
                    ephemeral: true
                }).catch(() => {});
            }
            return null;
        }
    }

    async _execute(pending, interaction) {
        if (pending.type === 'agent-launch') return await this._executeAgentLaunch(pending, interaction);
        return await this._executeIssueCreate(pending, interaction);
    }

    async _executeAgentLaunch(pending, interaction) {
        const cursorAgentService = require('./cursorAgentService');
        const repoWatchService = require('./repoWatchService');
        const { repo, prompt, branch = null } = pending.payload;

        if (!await repoWatchService.isRepoAllowed(pending.guildId, repo)) {
            throw new Error(`${repo} is no longer allowlisted in this server.`);
        }

        const { agent, run } = await cursorAgentService.launchAgent({ prompt, repo, ref: branch, autoCreatePr: true });
        await this._persistSideEffect(pending.id, {
            ok: true, agentId: agent.id, runId: run.id, agentUrl: agent.url || null
        });
        const tracker = interaction.client.agentTrackerService;
        await tracker?.track({
            agentId: agent.id,
            runId: run.id,
            guildId: pending.guildId,
            channelId: pending.channelId,
            userId: interaction.user.id,
            repo,
            prompt,
            status: run.status || 'CREATING',
            agentUrl: agent.url || null
        });
        await integrationAudit.record({
            guildId: pending.guildId, userId: interaction.user.id,
            action: 'agent.launch', detail: { agentId: agent.id, repo, branch, via: 'chat-tool' }
        });

        // Mission control: updates and reply-follow-ups live in a thread off
        // the confirmation message.
        const thread = await tracker?.openThread({ message: interaction.message, agentId: agent.id, prompt });

        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`🤖 Agent launched: ${agent.name || String(prompt).slice(0, 80)}`)
            .setURL(agent.url || null)
            .setDescription(String(prompt).slice(0, 1000))
            .addFields(
                { name: 'Agent', value: `\`${agent.id}\``, inline: true },
                { name: 'Repo', value: repo, inline: true },
                { name: 'Status', value: run.status || 'CREATING', inline: true }
            )
            .setFooter({ text: thread ? 'Follow along in the thread — replies there become follow-ups.' : 'Updates will be posted in this channel.' })
            .setTimestamp();
        return { content: `✅ Confirmed by <@${interaction.user.id}>`, embeds: [embed], components: [] };
    }

    async _executeIssueCreate(pending, interaction) {
        const githubService = require('./githubService');
        const { repo, title, body = '' } = pending.payload;

        const issue = await githubService.createIssue(repo, { title, body });
        await this._persistSideEffect(pending.id, {
            ok: true, issueUrl: issue.html_url, number: issue.number
        });
        await integrationAudit.record({
            guildId: pending.guildId, userId: interaction.user.id,
            action: 'github.issue-create', detail: { repo, number: issue.number, via: 'chat-tool' }
        });

        const embed = new EmbedBuilder()
            .setColor(0x2ea043)
            .setTitle(`🐛 Issue created: #${issue.number} ${issue.title}`.slice(0, 250))
            .setURL(issue.html_url)
            .setFooter({ text: repo })
            .setTimestamp();
        return { content: `✅ Confirmed by <@${interaction.user.id}>`, embeds: [embed], components: [] };
    }

    /**
     * Write the receipt immediately after the external side effect so a
     * later audit/thread failure cannot release the claim and retry.
     */
    async _persistSideEffect(id, result) {
        try {
            await approvalExecutor.persistReceipt(db, {
                table: 'pending_integration_actions',
                id,
                resultJson: JSON.stringify(result)
            });
        } catch (error) {
            const wrapped = new Error(error.message || 'RECEIPT_UNCONFIRMED');
            wrapped.code = 'RECEIPT_UNCONFIRMED';
            wrapped.result = result;
            throw wrapped;
        }
    }
}

module.exports = new IntegrationActionService();
module.exports.IntegrationActionService = IntegrationActionService;
module.exports.PENDING_TTL_MINUTES = PENDING_TTL_MINUTES;
