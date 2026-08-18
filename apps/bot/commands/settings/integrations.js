const { SlashCommandBuilder } = require('discord.js');
const userIntegrationService = require('@goobster/core/services/userIntegrationService');

/**
 * Personal platform integrations (Notion, GitHub) from Discord: view what
 * you've connected and disconnect. Connecting happens in the web portal's
 * Integrations dialog - pasting an API token into a Discord message is a
 * bad habit to encourage, so this command deliberately has no connect path.
 * Integrations are per-user, so no ManageGuild gate; every reply is
 * ephemeral so nothing about your accounts leaks into the channel.
 */
module.exports = {
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('integrations')
        .setDescription('Your personal platform integrations (Notion, GitHub) - status and disconnect.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show which platforms your account has connected'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disconnect')
                .setDescription('Disconnect one platform (deletes the stored token)')
                .addStringOption(option =>
                    option.setName('platform')
                        .setDescription('The platform to disconnect')
                        .setRequired(true)
                        .addChoices(
                            { name: 'GitHub', value: 'github' },
                            { name: 'Notion', value: 'notion' }
                        ))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const userId = interaction.user.id;

        if (subcommand === 'status') {
            const integrations = userIntegrationService.list(userId);
            const lines = integrations.map(item => item.connected
                ? `✅ **${item.name}** - connected as ${item.account || 'your account'} (since ${item.connectedAt} UTC)`
                : `⬜ **${item.name}** - not connected`);
            await interaction.reply({
                content: `🧩 **Your integrations:**\n${lines.join('\n')}\n\n` +
                    'Connect or manage them in Goobster\'s web portal (Integrations button in the chat header). ' +
                    'Connected platforms work in your DMs and the web portal.',
                ephemeral: true
            });
        } else if (subcommand === 'disconnect') {
            const platform = interaction.options.getString('platform');
            try {
                const { disconnected } = userIntegrationService.disconnect({ userId, provider: platform });
                await interaction.reply({
                    content: disconnected
                        ? `🧩 **${platform === 'github' ? 'GitHub' : 'Notion'} disconnected.** The stored token was deleted.`
                        : `You don't have ${platform === 'github' ? 'GitHub' : 'Notion'} connected.`,
                    ephemeral: true
                });
            } catch (error) {
                await interaction.reply({ content: `❌ ${error.message}`, ephemeral: true });
            }
        }
    }
};
