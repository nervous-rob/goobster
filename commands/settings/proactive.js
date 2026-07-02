const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getProactiveMode, setProactiveMode, PROACTIVE_MODE } = require('../../utils/guildSettings');
const factsService = require('../../services/factsService');
const followupService = require('../../services/followupService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('proactive')
        .setDescription('Control Goobster\'s proactive mode (his "heartbeat" - unprompted participation).')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Let Goobster occasionally chime in, react, and follow up on his own'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Goobster only responds when addressed'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show proactive mode status, known facts, and pending follow-ups')),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Proactive mode only applies to servers.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'enable') {
            await setProactiveMode(interaction.guildId, PROACTIVE_MODE.ENABLED);
            await interaction.reply(
                '💓 **Proactive mode enabled!**\n\n' +
                'I\'ll now keep a quiet eye on active conversations and occasionally:\n' +
                '- Chime in when I can genuinely help (at most once every 45 minutes)\n' +
                '- React to messages that deserve it\n' +
                '- Follow up on things people said they\'d do\n\n' +
                'I\'m under strict orders to stay silent unless I can add real value. Disable anytime with `/proactive disable`.'
            );
        } else if (subcommand === 'disable') {
            await setProactiveMode(interaction.guildId, PROACTIVE_MODE.DISABLED);
            await interaction.reply('😴 **Proactive mode disabled.** I\'ll only speak when spoken to.');
        } else if (subcommand === 'status') {
            const mode = await getProactiveMode(interaction.guildId);
            const facts = factsService.getStats(interaction.guildId);
            const pending = followupService.getPending(interaction.guildId);

            const lines = [
                `💓 **Proactive mode:** ${mode === PROACTIVE_MODE.ENABLED ? '✅ Enabled' : '❌ Disabled'}`,
                `🧠 **Known facts:** ${facts.userFacts} about users, ${facts.guildFacts} about the server`,
                `⏰ **Pending follow-ups:** ${pending.length}`
            ];
            if (pending.length > 0) {
                lines.push('', ...pending.map(f => `- [${f.dueAt} UTC] ${f.note}`));
            }

            await interaction.reply({ content: lines.join('\n'), ephemeral: true });
        }
    }
};
