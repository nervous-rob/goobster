const { SlashCommandBuilder, ChannelType, MessageFlags, PermissionFlagsBits } = require('discord.js');
const gbaRunService = require('../../services/gbaRunService');

/**
 * Pairing and status for the GBA run harness ("Goobster Plays Pokémon",
 * documentation/goobster_plays_pokemon.md): a driver running next to mGBA
 * on another machine streams run screenshots to Goobster, who posts them
 * into the channel bound here. Manage Server gated — linking decides
 * where a machine gets to post.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('gbarun')
        .setDescription('Broadcast a GBA game run (Goobster Plays Pokémon) into a channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('link')
                .setDescription('Get a one-time code to pair the run harness on your gaming machine')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Channel the run posts into (default: this channel)')
                        .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub =>
            sub.setName('unlink')
                .setDescription('Remove the pairing and disconnect the run harness'))
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Check whether the run harness is paired and connected')),

    async execute(interaction) {
        // Pairing codes are secrets - always ephemeral.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!gbaRunService.isEnabled()) {
            await interaction.editReply(
                'GBA run broadcasting is not enabled on this Goobster instance. ' +
                'The bot owner can turn it on with `"gbaRun": { "enabled": true }` in config.json ' +
                '(see documentation/goobster_plays_pokemon.md).'
            );
            return;
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        try {
            if (sub === 'link') {
                const channel = interaction.options.getChannel('channel') || interaction.channel;
                if (!channel || channel.type !== ChannelType.GuildText) {
                    await interaction.editReply('Pick a regular text channel for the run posts.');
                    return;
                }
                const me = interaction.guild.members.me;
                if (me && !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) {
                    await interaction.editReply(`I can't post in ${channel} - I need View Channel, Send Messages, and Attach Files there.`);
                    return;
                }
                const { code, expiresAt } = gbaRunService.createPairingCode(guildId, channel.id);
                const minutes = Math.round((expiresAt - Date.now()) / 60000);
                await interaction.editReply(
                    `🎮 **Pairing code:** \`${code}\` (valid for ${minutes} minutes, single use)\n\n` +
                    `Run posts will go to ${channel}. On the machine running mGBA:\n` +
                    '```\nnode clients/gba-mcp/run-driver.js --server https://<goobster-public-url> ' +
                    `--code ${code} --playbook <playbook.json>\n\`\`\`\n` +
                    '-# The harness needs mGBA running with `goobster-gba.lua` loaded. ' +
                    'See `clients/gba-mcp/README.md`. Use `/gbarun unlink` anytime to revoke access.'
                );
            } else if (sub === 'unlink') {
                const existed = gbaRunService.unlink(guildId);
                await interaction.editReply(existed
                    ? '🔌 Unlinked. The run harness has been disconnected and its token revoked.'
                    : 'No run harness is paired for this server.');
            } else if (sub === 'status') {
                const status = gbaRunService.getStatus(guildId);
                if (!status.linked) {
                    await interaction.editReply('No run harness paired. Use `/gbarun link` to get started.');
                    return;
                }
                const lines = [
                    `**Paired:** yes${status.label ? ` (\`${status.label}\`)` : ''} - since ${status.createdAt} UTC`,
                    `**Broadcast channel:** <#${status.channelId}>`,
                    `**Connected right now:** ${status.connected ? '🟢 yes' : '🔴 no'}`,
                    status.game?.title ? `**Game:** ${status.game.title}${status.game.code ? ` (${status.game.code})` : ''}` : null,
                    status.lastConnectedAt ? `**Last connected:** ${status.lastConnectedAt} UTC` : null
                ].filter(Boolean);
                await interaction.editReply(lines.join('\n'));
            }
        } catch (error) {
            console.error('[GbaRun] Command error:', error);
            await interaction.editReply(`❌ ${error.message}`);
        }
    }
};
