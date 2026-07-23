const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getBotNickname, setBotNickname, getUserNickname, setUserNickname } = require('../../utils/guildSettings');
const { getConversationScopeId } = require('../../utils/dmScope');

module.exports = {
    // In a DM, nicknames are keyed on the user's DM scope and the DM user
    // acts as the "admin" of their one-on-one conversation - registered
    // globally with DM contexts, see deploy-commands.js.
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('nickname')
        .setDescription('Manage nicknames for Goobster and users')
        .addSubcommandGroup(group =>
            group
                .setName('bot')
                .setDescription('Manage Goobster\'s nickname in this server')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('set')
                        .setDescription('Set a custom nickname for Goobster in this server')
                        .addStringOption(option =>
                            option
                                .setName('nickname')
                                .setDescription('The new nickname for Goobster (max 32 characters)')
                                .setRequired(true)
                                .setMaxLength(32)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('clear')
                        .setDescription('Clear Goobster\'s custom nickname in this server'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('view')
                        .setDescription('View Goobster\'s current nickname in this server')))
        .addSubcommandGroup(group =>
            group
                .setName('user')
                .setDescription('Manage your nickname that Goobster will use to refer to you')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('set')
                        .setDescription('Set your custom nickname')
                        .addStringOption(option =>
                            option
                                .setName('nickname')
                                .setDescription('Your new nickname (max 32 characters)')
                                .setRequired(true)
                                .setMaxLength(32)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('clear')
                        .setDescription('Clear your custom nickname'))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('view')
                        .setDescription('View your current nickname')))
        .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        // Guild id in servers, the user's DM scope in direct messages
        const guildId = getConversationScopeId(interaction);

        if (group === 'bot') {
            // In a server, only members with Manage Server may rename the
            // bot; in a DM the user is the admin of their own conversation.
            if (interaction.guild && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return await interaction.reply({
                    content: '❌ You need the "Manage Server" permission to change the bot\'s nickname.',
                    ephemeral: true
                });
            }

            if (subcommand === 'set') {
                try {
                    const nickname = interaction.options.getString('nickname');
                    await setBotNickname(guildId, nickname);
                    
                    // Also update the bot's server nickname if possible
                    // (DMs have no member object to rename)
                    try {
                        await interaction.guild?.members?.me?.setNickname(nickname);
                    } catch (error) {
                        console.warn('Could not set bot\'s server nickname:', error);
                        // Don't return here, we still want to acknowledge the database update
                    }

                    await interaction.reply({
                        content: `✅ My nickname has been set to **${nickname}**!`,
                        ephemeral: true
                    });
                } catch (error) {
                    console.error('Error setting bot nickname:', error);
                    await interaction.reply({
                        content: '❌ Failed to set nickname. Please try again later.',
                        ephemeral: true
                    });
                }
            } else if (subcommand === 'clear') {
                try {
                    await setBotNickname(guildId, null);
                    
                    // Also clear the bot's server nickname if possible
                    // (DMs have no member object to rename)
                    try {
                        await interaction.guild?.members?.me?.setNickname(null);
                    } catch (error) {
                        console.warn('Could not clear bot\'s server nickname:', error);
                    }

                    await interaction.reply({
                        content: '✅ My nickname has been cleared!',
                        ephemeral: true
                    });
                } catch (error) {
                    console.error('Error clearing bot nickname:', error);
                    await interaction.reply({
                        content: '❌ Failed to clear nickname. Please try again later.',
                        ephemeral: true
                    });
                }
            } else if (subcommand === 'view') {
                try {
                    const nickname = await getBotNickname(guildId);
                    await interaction.reply({
                        content: nickname 
                            ? `My current nickname is **${nickname}**`
                            : 'I don\'t have a custom nickname set in this server.',
                        ephemeral: true
                    });
                } catch (error) {
                    console.error('Error getting bot nickname:', error);
                    await interaction.reply({
                        content: '❌ Failed to get nickname. Please try again later.',
                        ephemeral: true
                    });
                }
            }
        } else if (group === 'user') {
            const userId = interaction.user.id;

            if (subcommand === 'set') {
                try {
                    const nickname = interaction.options.getString('nickname');
                    await setUserNickname(userId, guildId, nickname);
                    await interaction.reply({
                        content: `✅ I'll now refer to you as **${nickname}**!`,
                        ephemeral: true
                    });
                } catch (error) {
                    console.error('Error setting user nickname:', error);
                    await interaction.reply({
                        content: '❌ Failed to set nickname. Please try again later.',
                        ephemeral: true
                    });
                }
            } else if (subcommand === 'clear') {
                try {
                    await setUserNickname(userId, guildId, null);
                    await interaction.reply({
                        content: '✅ Your nickname has been cleared! I\'ll use your regular username now.',
                        ephemeral: true
                    });
                } catch (error) {
                    console.error('Error clearing user nickname:', error);
                    await interaction.reply({
                        content: '❌ Failed to clear nickname. Please try again later.',
                        ephemeral: true
                    });
                }
            } else if (subcommand === 'view') {
                try {
                    const nickname = await getUserNickname(userId, guildId);
                    await interaction.reply({
                        content: nickname 
                            ? `Your current nickname is **${nickname}**`
                            : 'You don\'t have a custom nickname set.',
                        ephemeral: true
                    });
                } catch (error) {
                    console.error('Error getting user nickname:', error);
                    await interaction.reply({
                        content: '❌ Failed to get nickname. Please try again later.',
                        ephemeral: true
                    });
                }
            }
        }
    },
}; 