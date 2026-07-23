const { SlashCommandBuilder } = require('@discordjs/builders');
const { handleChatInteraction } = require('../../utils/chatHandler');

module.exports = {
    // Registered globally with DM contexts (see deploy-commands.js)
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Start or continue a chat with Goobster')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('What would you like to say to Goobster?')
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName('image')
                .setDescription('An image for Goobster to look at')
                .setRequired(false)
        ),
    async execute(interaction) {
        await handleChatInteraction(interaction);
    }
}; 