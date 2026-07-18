const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getMonologueMode, setMonologueMode, MONOLOGUE_MODE } = require('../../utils/guildSettings');
const MonologueService = require('../../services/monologueService');
const knowledgeGraphService = require('../../services/knowledgeGraphService');

// Reuse the live service when the bot started one; otherwise a detached
// instance works fine for the DB-backed reads (thoughts, notes, stats).
function getService() {
    return MonologueService.instance || new MonologueService(null);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('monologue')
        .setDescription('Control Goobster\'s internal monologue (private thoughts, scratch pad, knowledge graph).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Let Goobster keep a private thought process about this server'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Stop the internal monologue (existing thoughts and graph are kept)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show monologue status: thoughts, scratch pad, and knowledge graph size'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('thoughts')
                .setDescription('Peek at Goobster\'s recent private thoughts and scratch pad'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('graph')
                .setDescription('Show the most salient knowledge graph nodes and their links'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('reset')
                .setDescription('Erase all private thoughts, scratch pad notes, and the knowledge graph')),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'The internal monologue only applies to servers.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const service = getService();

        if (subcommand === 'enable') {
            await setMonologueMode(guildId, MONOLOGUE_MODE.ENABLED);
            await interaction.reply(
                '💭 **Internal monologue enabled!**\n\n' +
                'I\'ll now keep a private thought process about this server:\n' +
                '- Reflect on conversations every so often (roughly twice an hour when things are active)\n' +
                '- Keep a scratch pad of working notes to myself\n' +
                '- Build a knowledge graph connecting concepts, facts, opinions, and experiences\n\n' +
                'My thoughts stay private, but they\'ll quietly inform how I chat. ' +
                'Peek anytime with `/monologue thoughts`, or turn this off with `/monologue disable`.'
            );
        } else if (subcommand === 'disable') {
            await setMonologueMode(guildId, MONOLOGUE_MODE.DISABLED);
            await interaction.reply(
                '💤 **Internal monologue disabled.** I\'ll stop reflecting on my own. ' +
                'Existing thoughts and my knowledge graph are kept - use `/monologue reset` to erase them.'
            );
        } else if (subcommand === 'status') {
            const mode = await getMonologueMode(guildId);
            const stats = service.getStats(guildId);

            const lines = [
                `💭 **Internal monologue:** ${mode === MONOLOGUE_MODE.ENABLED ? '✅ Enabled' : '❌ Disabled'}`,
                `📓 **Private thoughts:** ${stats.thoughts}${stats.lastThoughtAt ? ` (latest ${stats.lastThoughtAt} UTC)` : ''}`,
                `📝 **Scratch pad notes:** ${stats.notes}`,
                `🕸️ **Knowledge graph:** ${stats.graph.nodes} nodes, ${stats.graph.edges} links`
            ];
            await interaction.reply({ content: lines.join('\n'), ephemeral: true });
        } else if (subcommand === 'thoughts') {
            const thoughts = service.getRecentThoughts(guildId, 5);
            const notes = service.getScratchpad(guildId, 10);

            if (thoughts.length === 0 && notes.length === 0) {
                await interaction.reply({
                    content: 'My mind is a blank slate here - no private thoughts yet. ' +
                        'Enable the monologue with `/monologue enable` and give me some conversations to reflect on.',
                    ephemeral: true
                });
                return;
            }

            const lines = [];
            if (thoughts.length > 0) {
                lines.push('💭 **Recent private thoughts** (newest first):');
                lines.push(...thoughts.map(t => `- [${t.createdAt} UTC] ${t.thought}`));
            }
            if (notes.length > 0) {
                if (lines.length > 0) lines.push('');
                lines.push('📝 **Scratch pad:**');
                lines.push(...notes.map(n => `- ${n.content}`));
            }
            await interaction.reply({ content: lines.join('\n').slice(0, 1990), ephemeral: true });
        } else if (subcommand === 'graph') {
            const stats = knowledgeGraphService.getStats(guildId);
            if (stats.nodes === 0) {
                await interaction.reply({
                    content: 'My knowledge graph is empty here. Enable the monologue with `/monologue enable` and it will grow as I reflect.',
                    ephemeral: true
                });
                return;
            }

            const excerpt = knowledgeGraphService.describeForPrompt({ guildId, limit: 12 });
            const lines = [
                `🕸️ **Knowledge graph:** ${stats.nodes} nodes, ${stats.edges} links. Most salient right now:`,
                excerpt || '(nothing to show)'
            ];
            await interaction.reply({ content: lines.join('\n').slice(0, 1990), ephemeral: true });
        } else if (subcommand === 'reset') {
            const removed = service.resetGuild(guildId);
            await interaction.reply(
                `🧹 **Inner life erased.** Removed ${removed.thoughts} thought${removed.thoughts === 1 ? '' : 's'}, ` +
                `${removed.notes} scratch pad note${removed.notes === 1 ? '' : 's'}, and ` +
                `${removed.nodes} knowledge graph node${removed.nodes === 1 ? '' : 's'} (links included).`
            );
        }
    }
};
