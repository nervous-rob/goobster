const { SlashCommandBuilder } = require('discord.js');
const {
    getUserInstructions,
    setUserInstructions,
    MAX_INSTRUCTIONS_LENGTH
} = require('@goobster/core/utils/userInstructions');

/**
 * Per-user custom instructions from Discord - the same setting the web
 * portal's settings dialog edits (UserPreferences.custom_instructions).
 * They follow the user everywhere: web chat, DMs, and servers (guild
 * directives still override on conflict). Personal setting, so no
 * ManageGuild gate; every reply is ephemeral.
 */
module.exports = {
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('instructions')
        .setDescription('Your custom instructions - how Goobster should respond to you, everywhere.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('Show your current custom instructions'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Set your custom instructions (replaces the previous text)')
                .addStringOption(option =>
                    option.setName('text')
                        .setDescription('How should Goobster respond? Anything he should know about you?')
                        .setRequired(true)
                        .setMaxLength(MAX_INSTRUCTIONS_LENGTH)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('clear')
                .setDescription('Remove your custom instructions')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const userId = interaction.user.id;

        try {
            if (subcommand === 'view') {
                const instructions = getUserInstructions(userId);
                await interaction.reply({
                    content: instructions
                        ? `📝 **Your custom instructions:**\n>>> ${instructions}`
                        : 'You have no custom instructions set. Use `/instructions set` (or the web portal\'s settings dialog) to add some.',
                    ephemeral: true
                });
            } else if (subcommand === 'set') {
                const text = interaction.options.getString('text');
                setUserInstructions(userId, text);
                await interaction.reply({
                    content: `✅ **Custom instructions saved.** They apply to every chat with you - web, DMs, and servers.\n>>> ${text}`,
                    ephemeral: true
                });
            } else if (subcommand === 'clear') {
                setUserInstructions(userId, null);
                await interaction.reply({
                    content: '✅ Your custom instructions were removed.',
                    ephemeral: true
                });
            }
        } catch (error) {
            await interaction.reply({
                content: `❌ ${error.message}`,
                ephemeral: true
            });
        }
    }
};
