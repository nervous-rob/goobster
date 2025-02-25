const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { SEARCH_APPROVAL, getSearchApproval, setSearchApproval } = require('../../utils/guildSettings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('requiresearchapproval')
        .setDescription('Configure whether search requests require admin approval')
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Set the search approval requirement for this server')
                .addStringOption(option =>
                    option.setName('setting')
                        .setDescription('Choose whether search requests require approval')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Require approval for searches', value: SEARCH_APPROVAL.REQUIRED },
                            { name: 'Allow searches without approval', value: SEARCH_APPROVAL.NOT_REQUIRED }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Check the current search approval setting for this server')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (subcommand === 'set') {
            try {
                const setting = interaction.options.getString('setting');
                await setSearchApproval(guildId, setting);

                const readableSetting = setting === SEARCH_APPROVAL.REQUIRED
                    ? 'Require approval for searches'
                    : 'Allow searches without approval';

                await interaction.reply({
                    content: `✅ Search approval setting has been set to: **${readableSetting}**`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error setting search approval setting:', error);
                await interaction.reply({
                    content: '❌ Failed to set search approval setting. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'status') {
            try {
                const setting = await getSearchApproval(guildId);
                const readableSetting = setting === SEARCH_APPROVAL.REQUIRED
                    ? 'Require approval for searches'
                    : 'Allow searches without approval';

                await interaction.reply({
                    content: `Current search approval setting: **${readableSetting}**`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error getting search approval setting:', error);
                await interaction.reply({
                    content: '❌ Failed to get search approval setting. Please try again later.',
                    ephemeral: true
                });
            }
        }
    },
}; 