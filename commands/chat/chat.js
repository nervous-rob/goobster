const { SlashCommandBuilder } = require('@discordjs/builders');
const { handleChatInteraction } = require('../../utils/chatHandler');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Start or continue a chat with Goobster')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('What would you like to say to Goobster?')
                .setRequired(true)
        ),
    async execute(interaction) {
        await handleChatInteraction(interaction);
    }
}; 