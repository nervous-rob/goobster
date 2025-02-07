const { SlashCommandBuilder } = require('discord.js');
const { isMemeModeEnabled, setMemeMode } = require('../../utils/memeMode');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mememode')
        .setDescription('Toggle meme mode for more meme-flavored responses')
        .addSubcommand(subcommand =>
            subcommand
                .setName('toggle')
                .setDescription('Turn meme mode on or off')
                .addBooleanOption(option =>
                    option
                        .setName('enabled')
                        .setDescription('Whether to enable or disable meme mode')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Check if meme mode is currently enabled')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'toggle') {
            const enabled = interaction.options.getBoolean('enabled');
            await setMemeMode(interaction.user.id, enabled);
            
            const response = enabled
                ? "🎭 MEME MODE ACTIVATED! Get ready for some extra spicy responses! 🌶️"
                : "Meme mode deactivated. Back to business mode! 🧐";
            
            await interaction.reply({ content: response, ephemeral: true });
        } else if (subcommand === 'status') {
            const enabled = await isMemeModeEnabled(interaction.user.id);
            
            const response = enabled
                ? "🎭 Meme mode is currently **ENABLED**! Prepare for dankness! 🔥"
                : "Meme mode is currently **DISABLED**. We're keeping it professional! 🧐";
            
            await interaction.reply({ content: response, ephemeral: true });
        }
    },
}; 