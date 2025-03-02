const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getPersonalityDirective, setPersonalityDirective } = require('../../utils/guildSettings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('personalitydirective')
        .setDescription('Configure Goobster\'s personality for this server')
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Set a custom personality directive for Goobster')
                .addStringOption(option =>
                    option.setName('directive')
                        .setDescription('The personality directive that will modify Goobster\'s behavior')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('clear')
                .setDescription('Remove the custom personality directive and restore default behavior'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('view')
                .setDescription('View the current personality directive for this server')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (subcommand === 'set') {
            try {
                const directive = interaction.options.getString('directive');
                await setPersonalityDirective(guildId, directive);

                await interaction.reply({
                    content: `✅ Personality directive has been set! Goobster will now behave according to the new directive in this server.`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error setting personality directive:', error);
                await interaction.reply({
                    content: '❌ Failed to set personality directive. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'clear') {
            try {
                await setPersonalityDirective(guildId, null);
                
                await interaction.reply({
                    content: `✅ Personality directive has been cleared. Goobster will now use default behavior in this server.`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error clearing personality directive:', error);
                await interaction.reply({
                    content: '❌ Failed to clear personality directive. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'view') {
            try {
                const directive = await getPersonalityDirective(guildId);
                
                if (directive) {
                    await interaction.reply({
                        content: `**Current Personality Directive:**\n\n${directive}`,
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: `No custom personality directive is set for this server. Goobster is using default behavior.`,
                        ephemeral: true
                    });
                }
            } catch (error) {
                console.error('Error getting personality directive:', error);
                await interaction.reply({
                    content: '❌ Failed to retrieve personality directive. Please try again later.',
                    ephemeral: true
                });
            }
        }
    },
}; 