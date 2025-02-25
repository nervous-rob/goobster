const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { THREAD_PREFERENCE, getThreadPreference, setThreadPreference } = require('../../utils/guildSettings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('threadpreference')
        .setDescription('Configure how Goobster responds to messages')
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Set the thread preference for this server')
                .addStringOption(option =>
                    option.setName('preference')
                        .setDescription('Choose where Goobster should respond to messages')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Always use threads', value: THREAD_PREFERENCE.ALWAYS_THREAD },
                            { name: 'Always use the current channel', value: THREAD_PREFERENCE.ALWAYS_CHANNEL }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Check the current thread preference for this server')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (subcommand === 'set') {
            try {
                const preference = interaction.options.getString('preference');
                await setThreadPreference(guildId, preference);

                const readablePreference = preference === THREAD_PREFERENCE.ALWAYS_THREAD
                    ? 'Always use threads'
                    : 'Always use the current channel';

                await interaction.reply({
                    content: `✅ Thread preference has been set to: **${readablePreference}**`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error setting thread preference:', error);
                await interaction.reply({
                    content: '❌ Failed to set thread preference. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'status') {
            try {
                const preference = await getThreadPreference(guildId);
                const readablePreference = preference === THREAD_PREFERENCE.ALWAYS_THREAD
                    ? 'Always use threads'
                    : 'Always use the current channel';

                await interaction.reply({
                    content: `Current thread preference: **${readablePreference}**`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error getting thread preference:', error);
                await interaction.reply({
                    content: '❌ Failed to get thread preference. Please try again later.',
                    ephemeral: true
                });
            }
        }
    },
}; 