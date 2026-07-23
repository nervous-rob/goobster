const { SlashCommandBuilder } = require('discord.js');
const { getPersonalityDirective, setPersonalityDirective } = require('../../utils/guildSettings');
const { getConversationScopeId } = require('../../utils/dmScope');

module.exports = {
    // In a DM the directive is per-user (the DM user is the "admin" of
    // their own one-on-one conversation) - registered globally with DM
    // contexts, see deploy-commands.js.
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('personalitydirective')
        .setDescription('Configure Goobster\'s personality for this server or DM')
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
                .setDescription('View the current personality directive')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        // Guild id in servers, the user's DM scope in direct messages
        const scopeId = getConversationScopeId(interaction);
        const scopeLabel = interaction.guildId ? 'in this server' : 'in our DMs';

        if (subcommand === 'set') {
            try {
                const directive = interaction.options.getString('directive');
                await setPersonalityDirective(scopeId, directive);

                await interaction.reply({
                    content: `✅ Personality directive has been set! Goobster will now behave according to the new directive ${scopeLabel}.`,
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
                await setPersonalityDirective(scopeId, null);
                
                await interaction.reply({
                    content: `✅ Personality directive has been cleared. Goobster will now use default behavior ${scopeLabel}.`,
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
                const directive = await getPersonalityDirective(scopeId);
                
                if (directive) {
                    await interaction.reply({
                        content: `**Current Personality Directive:**\n\n${directive}`,
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: `No custom personality directive is set ${scopeLabel}. Goobster is using default behavior.`,
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
