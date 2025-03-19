const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getDynamicResponse, setDynamicResponse, DYNAMIC_RESPONSE } = require('../../utils/guildSettings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dynamicresponse')
        .setDescription('Configure Goobster\'s ability to respond to messages without being explicitly mentioned')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Enable Goobster to respond dynamically based on message context and content'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable dynamic responses, requiring explicit mentions to trigger Goobster'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Check the current status of the dynamic response feature')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (subcommand === 'enable') {
            try {
                await setDynamicResponse(guildId, DYNAMIC_RESPONSE.ENABLED);

                await interaction.reply({
                    content: `✅ Dynamic response has been **enabled**!\n\nGoobster will now try to detect when to respond to messages even without being explicitly mentioned. This uses a lightweight intent detection system that analyzes message content and context.\n\nNote: Goobster will still be more likely to respond when directly mentioned.`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error enabling dynamic response:', error);
                await interaction.reply({
                    content: '❌ Failed to enable dynamic response. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'disable') {
            try {
                await setDynamicResponse(guildId, DYNAMIC_RESPONSE.DISABLED);
                
                await interaction.reply({
                    content: `✅ Dynamic response has been **disabled**.\n\nGoobster will now only respond when explicitly mentioned or when using slash commands.`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error disabling dynamic response:', error);
                await interaction.reply({
                    content: '❌ Failed to disable dynamic response. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'status') {
            try {
                const status = await getDynamicResponse(guildId);
                
                const isEnabled = status === DYNAMIC_RESPONSE.ENABLED;
                const statusMessage = isEnabled 
                    ? "✅ Dynamic response is currently **enabled**.\n\nGoobster will try to detect when to respond to messages even without being explicitly mentioned."
                    : "❌ Dynamic response is currently **disabled**.\n\nGoobster will only respond when explicitly mentioned or when using slash commands.";
                
                await interaction.reply({
                    content: statusMessage,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error getting dynamic response status:', error);
                await interaction.reply({
                    content: '❌ Failed to get dynamic response status. Please try again later.',
                    ephemeral: true
                });
            }
        }
    },
}; 