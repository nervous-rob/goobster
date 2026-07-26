const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const screenVisionService = require('../../services/screenVisionService');

/**
 * Pairing and status for the screen-vision companion app: a small program
 * users run on their own PC that lets Goobster capture their screen (with
 * consent, on demand) for visual context in chat and voice conversations.
 */
module.exports = {
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('screenvision')
        .setDescription('Let Goobster see your screen via the companion app (opt-in)')
        .addSubcommand(sub =>
            sub.setName('link')
                .setDescription('Get a one-time code to pair the companion app on your PC'))
        .addSubcommand(sub =>
            sub.setName('unlink')
                .setDescription('Remove your pairing and disconnect the companion app'))
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Check whether your companion app is paired and connected'))
        .addSubcommand(sub =>
            sub.setName('test')
                .setDescription('Take a test screenshot through your companion app')),

    async execute(interaction) {
        // Pairing codes and screenshots are personal - always ephemeral.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!screenVisionService.isEnabled()) {
            await interaction.editReply(
                'Screen vision is not enabled on this Goobster instance. ' +
                'The bot owner can turn it on with `"screenVision": { "enabled": true }` in config.json ' +
                '(see documentation/screen_vision_setup.md).'
            );
            return;
        }

        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;

        try {
            if (sub === 'link') {
                const { code, expiresAt } = screenVisionService.createPairingCode(userId);
                const minutes = Math.round((expiresAt - Date.now()) / 60000);
                await interaction.editReply(
                    `🖥️ **Pairing code:** \`${code}\` (valid for ${minutes} minutes, single use)\n\n` +
                    'On the PC whose screen Goobster should see, run the companion app with this code:\n' +
                    '```\nnpm start -- --server <goobster-public-url> --code ' + code + '\n```\n' +
                    'Setup instructions: `clients/screen-companion/README.md` in the Goobster repo.\n' +
                    '-# While the companion is connected, Goobster captures your screen **only** when you talk to him, ' +
                    'and frames are discarded right after answering. Use `/screenvision unlink` anytime.'
                );
            } else if (sub === 'unlink') {
                const existed = screenVisionService.unlink(userId);
                await interaction.editReply(existed
                    ? '🔌 Unlinked. Your companion app has been disconnected and its token revoked.'
                    : 'You don\'t have a companion app paired.');
            } else if (sub === 'status') {
                const status = screenVisionService.getStatus(userId);
                if (!status.linked) {
                    await interaction.editReply('No companion app paired. Use `/screenvision link` to get started.');
                    return;
                }
                const lines = [
                    `**Paired:** yes${status.label ? ` (\`${status.label}\`)` : ''} - since ${status.createdAt} UTC`,
                    `**Connected right now:** ${status.connected ? '🟢 yes' : '🔴 no'}`,
                    status.lastConnectedAt ? `**Last connected:** ${status.lastConnectedAt} UTC` : null
                ].filter(Boolean);
                await interaction.editReply(lines.join('\n'));
            } else if (sub === 'test') {
                if (!screenVisionService.isConnected(userId)) {
                    await interaction.editReply(
                        '🔴 Your companion app is not connected. Start it on your PC, then try again ' +
                        '(`/screenvision status` shows the connection state).'
                    );
                    return;
                }
                const frame = await screenVisionService.captureFrame(userId);
                if (!frame) {
                    await interaction.editReply('❌ Capture failed - the companion app did not return a frame. Check its console output.');
                    return;
                }
                const [, base64] = frame.dataUrl.split(',', 2);
                const extension = frame.dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
                const attachment = new AttachmentBuilder(Buffer.from(base64, 'base64'), { name: `screen-test.${extension}` });
                const metaBits = [
                    frame.meta.appName ? `app: **${frame.meta.appName}**` : null,
                    frame.meta.windowTitle ? `window: "${frame.meta.windowTitle}"` : null
                ].filter(Boolean).join(', ');
                await interaction.editReply({
                    content: `✅ Here's what I can see right now${metaBits ? ` (${metaBits})` : ''}. This is exactly the context I get when you talk to me.`,
                    files: [attachment]
                });
            }
        } catch (error) {
            console.error('[ScreenVision] Command error:', error);
            await interaction.editReply(`❌ ${error.message}`);
        }
    }
};
