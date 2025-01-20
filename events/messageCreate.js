const { Events } = require('discord.js');
const { handleChatInteraction } = require('../utils/chatHandler');

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        // Ignore bot messages and messages in DMs
        if (message.author.bot || !message.guild) return;

        // Check for different types of mentions
        const isMentioned = 
            message.mentions.users.has(message.client.user.id) || // Direct mention
            message.mentions.roles.some(role => message.guild.members.cache.get(message.client.user.id).roles.cache.has(role.id)) || // Role mention
            message.content.toLowerCase().includes(message.client.user.username.toLowerCase()); // Name mention

        if (!isMentioned) return;

        // Start typing indicator immediately
        await message.channel.sendTyping();

        try {
            // Remove all types of mentions from the message
            let content = message.content
                .replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '') // Remove direct mentions
                .replace(new RegExp(`@${message.client.user.username}`, 'gi'), '') // Remove name mentions
                .trim();

            // If message is empty after removing mention, provide help
            if (!content) {
                return message.reply(
                    "Hi! You can chat with me by mentioning me followed by your message, or use `/chat` command. " +
                    "For example:\n" +
                    `- @${message.client.user.username} Hello!\n` +
                    "- /chat How are you?"
                );
            }

            // Create pseudo-interaction object for compatibility with chat command
            const pseudoInteraction = {
                user: message.author,
                guildId: message.guild.id,
                channel: message.channel,
                client: message.client,
                deferReply: async () => {
                    return message.channel.sendTyping();
                },
                editReply: async (response) => {
                    if (response === '✅') {
                        // Don't send checkmark for message-based interactions
                        return;
                    }
                    if (typeof response === 'string') {
                        return message.reply(response);
                    }
                    return message.reply({ content: response.content, embeds: response.embeds });
                },
                options: {
                    getString: () => content
                }
            };

            await handleChatInteraction(pseudoInteraction);
        } catch (error) {
            console.error('Error handling mention:', error);
            await message.reply({
                content: 'Sorry, I encountered an error while processing your message. You can try using the `/chat` command instead.',
                allowedMentions: { repliedUser: true }
            });
        }
    },
}; 