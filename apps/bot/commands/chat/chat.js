const { SlashCommandBuilder } = require('@discordjs/builders');
const { handleChatInteraction } = require('@goobster/core/utils/chatHandler');
const { assistantName } = require('@goobster/core/config/identityConfig');

module.exports = {
    // Registered globally with DM contexts (see deploy-commands.js)
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('chat')
        .setDescription(`Start or continue a chat with ${assistantName}`)
        .addStringOption(option =>
            option.setName('message')
                .setDescription(`What would you like to say to ${assistantName}?`)
                .setRequired(true)
        )
        .addAttachmentOption(option =>
            option.setName('image')
                .setDescription(`An image for ${assistantName} to look at`)
                .setRequired(false)
        ),
    async execute(interaction) {
        await handleChatInteraction(interaction);
    }
}; 