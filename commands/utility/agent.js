const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const cursorAgentService = require('../../services/cursorAgentService');
const repoWatchService = require('../../services/repoWatchService');
const githubService = require('../../services/githubService');
const integrationAudit = require('../../services/integrationAudit');
const usageTracker = require('../../services/usageTracker');

const CURSOR_COLOR = 0x5865f2;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('agent')
        .setDescription('Launch and manage Cursor cloud coding agents.')
        .addSubcommand(sub =>
            sub.setName('launch')
                .setDescription('Launch a coding agent against a watched repository')
                .addStringOption(opt => opt.setName('repo').setDescription('Repository (owner/name, must be watched)').setRequired(true))
                .addStringOption(opt => opt.setName('prompt').setDescription('What the agent should do').setRequired(true))
                .addStringOption(opt => opt.setName('branch').setDescription('Starting branch (default: repo default)'))
                .addStringOption(opt => opt.setName('model').setDescription('Model ID (default: account default)'))
                .addBooleanOption(opt => opt.setName('auto_pr').setDescription('Open a PR when done (default: true)')))
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Recent agent runs launched from this server'))
        .addSubcommand(sub =>
            sub.setName('followup')
                .setDescription('Send a follow-up prompt to an agent')
                .addStringOption(opt => opt.setName('agent_id').setDescription('Agent id (bc-...)').setRequired(true))
                .addStringOption(opt => opt.setName('prompt').setDescription('Follow-up instructions').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('cancel')
                .setDescription('Cancel an agent\'s active run')
                .addStringOption(opt => opt.setName('agent_id').setDescription('Agent id (bc-...)').setRequired(true))),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Agent management only works in servers.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        usageTracker.logCommand({ command: 'agent', guildId: interaction.guildId, userId: interaction.user.id });

        if (!cursorAgentService.isConfigured()) {
            await interaction.reply({
                content: '❌ The Cursor integration is not configured. Set `CURSOR_API_KEY` (see `documentation/github_cursor_integration.md`).',
                ephemeral: true
            });
            return;
        }

        const tracker = interaction.client.agentTrackerService;

        try {
            if (subcommand === 'status') {
                const rows = tracker?.getRecentRuns(interaction.guildId) || [];
                if (!rows.length) {
                    await interaction.reply({ content: 'No agents have been launched from this server yet. Try `/agent launch`.', ephemeral: true });
                    return;
                }
                const lines = rows.map(row => {
                    const link = row.prUrl ? ` — [PR](${row.prUrl})` : row.agentUrl ? ` — [view](${row.agentUrl})` : '';
                    return `- \`${row.agentId}\` **${row.status}** — ${String(row.prompt).slice(0, 80)}${link}`;
                });
                await interaction.reply({
                    embeds: [new EmbedBuilder().setColor(CURSOR_COLOR).setTitle('🤖 Cursor agent runs').setDescription(lines.join('\n').slice(0, 4000))],
                    ephemeral: true
                });
                return;
            }

            // Everything below spends compute or changes agent state.
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                await interaction.reply({ content: '❌ You need Manage Server permission to launch or control agents.', ephemeral: true });
                return;
            }

            if (subcommand === 'launch') {
                await interaction.deferReply();
                const repo = githubService.parseRepo(interaction.options.getString('repo'));
                const prompt = interaction.options.getString('prompt');
                const branch = interaction.options.getString('branch');
                const model = interaction.options.getString('model');
                const autoCreatePr = interaction.options.getBoolean('auto_pr') ?? true;

                // Guardrail: agents only run against repos an admin has explicitly
                // allowlisted for this server via /github watch.
                if (!repoWatchService.isRepoAllowed(interaction.guildId, repo)) {
                    await interaction.editReply(`❌ **${repo}** isn't allowlisted here. A server admin must run \`/github watch repo:${repo}\` first.`);
                    return;
                }

                const { agent, run } = await cursorAgentService.launchAgent({ prompt, repo, ref: branch, autoCreatePr, model });
                tracker?.track({
                    agentId: agent.id,
                    runId: run.id,
                    guildId: interaction.guildId,
                    channelId: interaction.channelId,
                    userId: interaction.user.id,
                    repo,
                    prompt,
                    status: run.status || 'CREATING',
                    agentUrl: agent.url || null
                });
                integrationAudit.record({
                    guildId: interaction.guildId, userId: interaction.user.id,
                    action: 'agent.launch', detail: { agentId: agent.id, repo, branch, model, autoCreatePr }
                });

                const embed = new EmbedBuilder()
                    .setColor(CURSOR_COLOR)
                    .setTitle(`🤖 Agent launched: ${agent.name || String(prompt).slice(0, 80)}`)
                    .setURL(agent.url || null)
                    .setDescription(String(prompt).slice(0, 1000))
                    .addFields(
                        { name: 'Agent', value: `\`${agent.id}\``, inline: true },
                        { name: 'Repo', value: repo, inline: true },
                        { name: 'Status', value: run.status || 'CREATING', inline: true }
                    )
                    .setFooter({ text: 'Updates will be posted in this channel.' })
                    .setTimestamp();
                await interaction.editReply({ embeds: [embed] });

                // Mission control: a thread off the launch message. Updates
                // post there and replies become follow-ups.
                const replyMessage = await interaction.fetchReply().catch(() => null);
                const thread = await tracker?.openThread({ message: replyMessage, agentId: agent.id, prompt });
                if (thread) {
                    embed.setFooter({ text: 'Follow along in the thread — replies there become follow-ups.' });
                    await interaction.editReply({ embeds: [embed] }).catch(() => {});
                }
                return;
            }

            if (subcommand === 'followup' || subcommand === 'cancel') {
                await interaction.deferReply();
                const agentId = interaction.options.getString('agent_id').trim();
                const row = tracker?.getTrackedAgent(interaction.guildId, agentId);
                if (!row) {
                    await interaction.editReply(`❌ No agent \`${agentId}\` was launched from this server. See \`/agent status\`.`);
                    return;
                }

                if (subcommand === 'followup') {
                    const prompt = interaction.options.getString('prompt');
                    const run = await cursorAgentService.followUp(agentId, prompt);
                    const runData = run.run || run;
                    tracker?.track({
                        agentId,
                        runId: runData.id,
                        guildId: row.guildId,
                        channelId: row.channelId,
                        userId: interaction.user.id,
                        repo: row.repo,
                        prompt,
                        status: runData.status || 'CREATING',
                        agentUrl: row.agentUrl
                    });
                    integrationAudit.record({
                        guildId: interaction.guildId, userId: interaction.user.id,
                        action: 'agent.followup', detail: { agentId }
                    });
                    await interaction.editReply(`📨 Follow-up sent to \`${agentId}\` — updates will post here.`);
                } else {
                    await cursorAgentService.cancelRun(agentId, row.runId);
                    integrationAudit.record({
                        guildId: interaction.guildId, userId: interaction.user.id,
                        action: 'agent.cancel', detail: { agentId, runId: row.runId }
                    });
                    await interaction.editReply(`🛑 Cancel requested for \`${agentId}\`.`);
                }
                return;
            }
        } catch (error) {
            console.error('Agent command failed:', error);
            const message = `❌ ${error.message || 'Something went wrong talking to the Cursor API.'}`;
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message);
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        }
    }
};
