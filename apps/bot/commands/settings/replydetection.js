const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getReplyDetection, setReplyDetection, REPLY_DETECTION } = require('@goobster/core/utils/guildSettings');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('replydetection')
        .setDescription('Configure whether Goobster answers replies to his own messages without a mention')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Answer messages that follow one of Goobster\'s and read as a reply to it'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Require a mention, a nickname, or a Discord reply every time'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Check the current reply detection setting')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (subcommand === 'enable') {
            try {
                await setReplyDetection(guildId, REPLY_DETECTION.ENABLED);

                await interaction.reply({
                    content: '✅ Reply detection **enabled**.\n\nWhen the last message in a channel is mine and the next one reads like an answer to it, I\'ll respond even without an @mention. Messages aimed at other people are still left alone.',
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error enabling reply detection:', error);
                await interaction.reply({
                    content: '❌ Failed to enable reply detection. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'disable') {
            try {
                await setReplyDetection(guildId, REPLY_DETECTION.DISABLED);

                await interaction.reply({
                    content: '✅ Reply detection **disabled**.\n\nI\'ll only answer when I\'m mentioned, called by name, replied to with Discord\'s reply button, or used through a slash command.',
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error disabling reply detection:', error);
                await interaction.reply({
                    content: '❌ Failed to disable reply detection. Please try again later.',
                    ephemeral: true
                });
            }
        } else if (subcommand === 'status') {
            try {
                const status = await getReplyDetection(guildId);

                const statusMessage = status === REPLY_DETECTION.ENABLED
                    ? '✅ Reply detection is **enabled**.\n\nIf my message is the last one in a channel and yours reads like an answer to it, I\'ll reply without needing a mention.'
                    : '❌ Reply detection is **disabled**.\n\nI only answer when mentioned, called by name, replied to with Discord\'s reply button, or used through a slash command.';

                await interaction.reply({
                    content: statusMessage,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Error getting reply detection status:', error);
                await interaction.reply({
                    content: '❌ Failed to get the reply detection status. Please try again later.',
                    ephemeral: true
                });
            }
        }
    },
};
