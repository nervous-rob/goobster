// TODO: Add proper handling for message content validation
// TODO: Add proper handling for message mention parsing
// TODO: Add proper handling for message mention validation
// TODO: Add proper handling for message content sanitization
// TODO: Add proper handling for message state persistence
// TODO: Add proper handling for message context loss
// TODO: Add proper handling for message thread state
// TODO: Add proper handling for message interaction state
// TODO: Add proper handling for message cleanup
// TODO: Add proper handling for message deletion
// TODO: Add proper handling for message attachment handling
// TODO: Add proper handling for message embed handling
// TODO: Add proper handling for message component handling

const { Events } = require('discord.js');
const { handleChatInteraction } = require('../utils/chatHandler');
const intentDetectionHandler = require('../utils/intentDetectionHandler');
const replyDetection = require('../utils/replyDetection');
const {
    getDynamicResponse,
    getReplyDetection,
    DYNAMIC_RESPONSE,
    REPLY_DETECTION
} = require('../utils/guildSettings');
const { getBotPreferredName } = require('../utils/guildContext');
const activityService = require('../services/activityService');

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        // Every message in a guild channel joins that channel's short tail,
        // Goobster's own included: reply detection keys off whose message came
        // last, so his outgoing chatter has to be recorded too.
        if (message.guild) {
            replyDetection.recordMessage(message);
        }

        // Ignore bot messages
        if (message.author.bot) return;

        // DM messages/channels can arrive as partials - resolve before use
        if (message.partial) {
            try {
                message = await message.fetch();
            } catch (error) {
                console.error('Failed to fetch partial message:', error);
                return;
            }
        }

        // One-on-one DMs: every message is an implicit prompt (no mention needed)
        if (!message.guild) {
            await handleDirectMessage(message);
            return;
        }

        // Counts-only activity tracking (feeds /wrapped); never throws
        activityService.recordMessage({
            guildId: message.guild.id,
            channelId: message.channel.id,
            userId: message.author.id
        });

        // Agent mission-control threads: a reply in one becomes a follow-up
        // to the Cursor agent instead of a chat prompt.
        try {
            const agentTracker = message.client.agentTrackerService;
            if (agentTracker && await agentTracker.handleThreadMessage(message)) return;
        } catch (error) {
            console.error('Agent thread follow-up handling failed:', error);
        }

        // Get the bot's nickname for this guild
        const botNickname = await getBotPreferredName(message.guild.id, message.guild.members.me);

        // Check for different types of mentions
        const isMentioned = 
            message.mentions.users.has(message.client.user.id) || // Direct mention
            message.mentions.roles.some(role => message.guild.members.cache.get(message.client.user.id).roles.cache.has(role.id)) || // Role mention
            message.content.toLowerCase().includes(message.client.user.username.toLowerCase()) || // Username mention
            (botNickname && botNickname !== message.client.user.username && 
                message.content.toLowerCase().includes(botNickname.toLowerCase())); // Nickname mention
            
        // Check if the message content contains a mention that looks like a role mention but is actually for the bot
        // This handles cases where the mention format is <@&botId> instead of <@botId>
        const botIdString = message.client.user.id;
        const roleStyleBotMention = message.content.includes(`<@&${botIdString}>`);

        // Discord replies to Goobster address him just as clearly as a mention
        // does - the reply ping is a per-user toggle, so it can't be relied on.
        const repliedTo = await fetchRepliedToMessage(message);
        const isReplyToBot = repliedTo?.author?.id === message.client.user.id;

        // Reply-to-edit: replying to a bot message that contains an image
        // (e.g. a generated one) with text edits that image.
        if (await maybeHandleImageEditReply(message, repliedTo)) return;

        // If explicitly addressed, handle the message as before
        if (isMentioned || roleStyleBotMention || isReplyToBot) {
            await handleExplicitMention(message, roleStyleBotMention);
            return;
        }

        // Reply detection: this message directly follows one of Goobster's, so
        // it may well be an answer to him even though it never says his name.
        try {
            if (await getReplyDetection(message.guild.id) === REPLY_DETECTION.ENABLED) {
                const verdict = await replyDetection.shouldRespond(message);
                if (verdict.respond) {
                    console.log(`Reply detected (${verdict.reason}): "${message.content}"`);
                    await respondToMessage(message, message.content.trim());
                    return;
                }
            }
        } catch (error) {
            console.error('Error in reply detection handling:', error);
        }

        // If not explicitly mentioned, check if dynamic response detection is enabled for this guild
        try {
            const dynamicResponseSetting = await getDynamicResponse(message.guild.id);
            
            // If dynamic response is not enabled, return early
            if (dynamicResponseSetting !== DYNAMIC_RESPONSE.ENABLED) {
                return;
            }
            
            // Use intent detection to determine if we should respond
            const detectionResult = intentDetectionHandler.shouldRespond(message, message.guild.id);
            
            // For debugging purposes, log high-confidence messages that didn't quite meet the threshold
            if (detectionResult.confidence > 0.4 && !detectionResult.shouldRespond) {
                console.log(`Near-miss intent detection (${detectionResult.confidence.toFixed(2)}): "${message.content}"`);
            }
            
            // If we should respond, handle it
            if (detectionResult.shouldRespond) {
                console.log(`Dynamic response triggered (${detectionResult.confidence.toFixed(2)}, ${detectionResult.thresholdCategory}): "${message.content}"`);
                await respondToMessage(message, message.content);
            } else {
                // Still update context for messages we don't respond to
                intentDetectionHandler.updateContext(message.channel.id, message, false);
            }
        } catch (error) {
            console.error('Error in dynamic response handling:', error);
        }
    },
};

/**
 * Handle a one-on-one direct message. Unlike guild channels, no mention is
 * needed: every human message is treated as a prompt for the bot.
 * @param {Object} message - The Discord DM message
 */
async function handleDirectMessage(message) {
    try {
        // Reply-to-edit works in DMs too
        if (await maybeHandleImageEditReply(message, await fetchRepliedToMessage(message))) return;

        await message.channel.sendTyping();

        // Strip any explicit bot mention; the rest of the text is the prompt
        const content = message.content
            .replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '')
            .trim();

        if (!content) {
            await message.reply(
                "Hi! Just send me a message and I'll reply - no mention or command needed in DMs."
            );
            return;
        }

        const pseudoInteraction = createPseudoInteraction(message, content);
        await handleChatInteraction(pseudoInteraction);
    } catch (error) {
        console.error('Error handling direct message:', error);
        await message.reply(
            'Sorry, I encountered an error while processing your message. Please try again.'
        ).catch(() => {});
    }
}

/**
 * Resolve the message a reply points at, or null when this isn't a reply.
 * @param {Object} message - The Discord message
 * @returns {Promise<Object|null>} the replied-to message
 */
async function fetchRepliedToMessage(message) {
    if (!message.reference?.messageId) return null;

    try {
        return await message.channel.messages.fetch(message.reference.messageId);
    } catch (error) {
        console.error('Failed to fetch the replied-to message:', error);
        return null;
    }
}

/**
 * If the message replies to a bot message containing an image, treat the
 * reply text as an edit instruction and handle it.
 * @param {Object} message - The Discord message
 * @param {Object|null} repliedTo - The message being replied to, if any
 * @returns {Promise<boolean>} whether the message was handled
 */
async function maybeHandleImageEditReply(message, repliedTo) {
    if (!repliedTo || repliedTo.author?.id !== message.client.user.id) return false;
    if (!message.content.trim()) return false;

    try {
        const referencedImage = repliedTo.attachments?.find?.(a => a.contentType?.startsWith('image/'));
        if (referencedImage) {
            await handleImageEditReply(message, referencedImage);
            return true;
        }
    } catch (error) {
        console.error('Error in reply-to-edit handling:', error);
        // Fall through to normal message handling
    }
    return false;
}

/**
 * Run a message through the chat pipeline as if it were a /chat prompt.
 * @param {Object} message - The Discord message
 * @param {string} content - The prompt text (mentions already stripped)
 * @param {boolean} [isRoleStyleBotMention] - Whether this is a role-style bot mention
 */
async function respondToMessage(message, content, isRoleStyleBotMention = false) {
    // Start typing indicator immediately
    await message.channel.sendTyping();

    const pseudoInteraction = createPseudoInteraction(message, content, isRoleStyleBotMention);
    await handleChatInteraction(pseudoInteraction);

    intentDetectionHandler.updateContext(message.channel.id, message, true);
}

/**
 * Handle a message with an explicit mention
 * @param {Object} message - The Discord message
 * @param {boolean} isRoleStyleBotMention - Whether this is a role-style bot mention
 */
async function handleExplicitMention(message, isRoleStyleBotMention) {
    try {
        // Get the bot's nickname for this guild
        const botNickname = await getBotPreferredName(message.guild.id, message.guild.members.me);

        // Remove all types of mentions from the message
        let content = message.content
            .replace(new RegExp(`<@!?${message.client.user.id}>`, 'g'), '') // Remove direct mentions
            .replace(new RegExp(`<@&${message.client.user.id}>`, 'g'), '') // Remove role-style bot mentions
            .replace(new RegExp(`@${message.client.user.username}`, 'gi'), ''); // Remove username mentions
        
        // Also remove the bot's nickname if different from username
        if (botNickname && botNickname !== message.client.user.username) {
            content = content.replace(new RegExp(`@?${botNickname}`, 'gi'), '');
        }
        
        content = content.trim();

        // If message is empty after removing mention, provide help
        if (!content) {
            return message.reply(
                "Hi! You can chat with me by mentioning me followed by your message, replying to one of my " +
                "messages, or using the `/chat` command. For example:\n" +
                `- @${botNickname || message.client.user.username} Hello!\n` +
                "- /chat How are you?"
            );
        }

        await respondToMessage(message, content, isRoleStyleBotMention);
    } catch (error) {
        console.error('Error handling mention:', error);
        await message.reply({
            content: 'Sorry, I encountered an error while processing your message. You can try using the `/chat` command instead.',
            allowedMentions: { repliedUser: true }
        });
    }
}

/**
 * Handle a reply to a bot image: treat the reply text as an edit instruction
 * and regenerate the image via the image edits endpoint.
 * @param {Object} message - The Discord reply message
 * @param {Object} referencedImage - The image attachment on the bot's message
 */
async function handleImageEditReply(message, referencedImage) {
    const path = require('node:path');
    const { editImageFromUrl } = require('../utils/imageDetectionHandler');

    await message.channel.sendTyping();

    // Strip any bot mentions so only the edit instruction remains
    const prompt = message.content
        .replace(new RegExp(`<@[!&]?${message.client.user.id}>`, 'g'), '')
        .trim();

    try {
        const filepath = await editImageFromUrl(referencedImage.url, prompt, {
            usageContext: { guildId: message.guild?.id ?? null, userId: message.author.id }
        });
        await message.reply({
            content: `🎨 Here's the edited image ("${prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt}"):`,
            files: [{ attachment: filepath, name: path.basename(filepath) }],
            allowedMentions: { repliedUser: false }
        });
    } catch (error) {
        console.error('Image edit reply failed:', error);
        await message.reply({
            content: `❌ I couldn't edit that image: ${error.message}`,
            allowedMentions: { repliedUser: false }
        });
    }
}

/**
 * Create a pseudo-interaction object for compatibility with chat command
 * @param {Object} message - The Discord message
 * @param {string} content - The processed message content
 * @param {boolean} isRoleStyleBotMention - Whether this is a role-style bot mention
 * @returns {Object} - A pseudo-interaction object
 */
function createPseudoInteraction(message, content, isRoleStyleBotMention = false) {
    // Make sure guild is properly included and accessed
    const guild = message.guild;

    // Image attachments enable vision in the AI providers
    const imageUrls = [...message.attachments.values()]
        .filter(a => a.contentType?.startsWith('image/'))
        .map(a => a.url);

    return {
        user: message.author,
        guild: guild, // Explicitly add guild property
        guildId: guild?.id, // Use optional chaining for safety
        channel: message.channel,
        channelId: message.channel.id,
        client: message.client,
        content: content,
        imageUrls,
        isRoleStyleBotMention: isRoleStyleBotMention,
        member: message.member, // Add member property for nickname resolution
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
        reply: async (response) => {
            return message.reply(response);
        },
        options: {
            getString: () => content
        }
    };
} 