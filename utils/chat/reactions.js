/**
 * Message-reaction controls on bot replies: regenerate (🔄), pin (📌),
 * branch (🌱), mark helpful (💡), deep dive (🔍), and summarize (📝).
 */
const { ThreadAutoArchiveDuration } = require('discord.js');
const db = require('../../db');
const aiService = require('../../services/aiService');
const { chunkMessage } = require('../index');
const { DEFAULT_PROMPT } = require('./prompts');

// Add reaction handler for conversation branching
async function handleReactionAdd(reaction, user) {
    console.log('Reaction add triggered:', {
        emoji: reaction.emoji.name,
        user: user.tag,
        messageId: reaction.message.id,
        channelId: reaction.message.channel.id
    });

    if (user.bot) {
        console.log('Ignoring bot reaction');
        return;
    }

    const msg = reaction.message;
    console.log('Processing reaction:', reaction.emoji.name);

    try {
        if (reaction.emoji.name === '🔄') {
            console.log('Handling regenerate reaction');
            await msg.channel.sendTyping();
            
            try {
                // Find the user's message that triggered this response
                const messages = await msg.channel.messages.fetch({ limit: 50, before: msg.id });
                const userMessage = messages.find(m => !m.author.bot && m.content);
                
                if (!userMessage) {
                    await msg.reply("I couldn't find the original message to regenerate a response for.");
                    return;
                }

                // Get the current prompt (falls back to the default prompt)
                const promptRow = db.get(
                    `SELECT p.prompt
                     FROM prompts p
                     JOIN guild_conversations gc ON gc.promptId = p.id
                     WHERE gc.threadId = @threadId`,
                    { threadId: msg.channel.id }
                );

                // Create a new completion with slightly higher temperature for variety
                const newResponse = await aiService.chatText([
                        { role: 'system', content: promptRow?.prompt || DEFAULT_PROMPT },
                        { role: 'user', content: userMessage.content }
                    ], {
                        preset: 'creative',
                        max_tokens: 500
                    });

                // Send the new response
                const response = await msg.reply({
                    content: `🔄 **Regenerated Response:**\n\n${newResponse}`,
                    allowedMentions: { users: [], roles: [] }
                });

                // Add the standard reaction controls
                await response.react('🔄');
                await response.react('📌');
                await response.react('🌳');
                await response.react('💡');
                await response.react('🔍');
                await response.react('📝');

            } catch (error) {
                console.error('Error in response regeneration:', error);
                await msg.reply("I encountered an error while regenerating the response. Please try again.");
            }
        } else if (reaction.emoji.name === '📌') {
            console.log('Handling pin reaction');
            try {
                await msg.pin();
                await msg.react('📍');
            } catch (pinError) {
                console.error('Error pinning message:', pinError);
                throw pinError;
            }
        } else if (reaction.emoji.name === '🌱') {
            // Create descriptive branch name from message content
            const branchTopic = msg.content
                .split(/[.!?]/)[0]  // Get first sentence
                .slice(0, 30)       // Take first 30 chars
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-');  // Convert to URL-friendly format

            const branchName = `branch-${branchTopic}-${msg.id.slice(-4)}`;
            
            // Create conversation branch
            const newThread = await msg.channel.threads.create({
                name: branchName,
                startMessage: msg,
                autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek
            });
            await newThread.send("🌱 New conversation branch created! Previous context will be maintained.");
        } else if (reaction.emoji.name === '💡') {
            // Mark as solution/helpful
            await msg.react('✨');
            await msg.reply("Marked as helpful solution! 💡");
        } else if (reaction.emoji.name === '🔍') {
            // Expand on this topic
            await msg.channel.sendTyping();
            
            // Create deep-dive prompt
            const deepDivePrompt = [
                { role: 'system', content: 'You are helping to expand on a previous response. Provide more detailed information, examples, and explanations about the topic. Be thorough but maintain clarity. Structure your response with clear sections using markdown headers.' },
                { role: 'user', content: `Please provide a detailed explanation and expansion of this topic: "${msg.content}"` }
            ];

            try {
                const expandedResponse = await aiService.chatText(deepDivePrompt, {
                    preset: 'chat',
                    max_tokens: 1000
                });

                // Use the chunked reply utility
                const chunks = chunkMessage(expandedResponse);
                for (const chunk of chunks) {
                    await msg.channel.send(chunk);
                }
            } catch (error) {
                console.error('Error in deep-dive generation:', error);
                await msg.reply("I encountered an error while generating the detailed explanation. Please try again.");
            }
        } else if (reaction.emoji.name === '📝') {
            // Request summary of thread up to this point
            await msg.channel.sendTyping();
            
            try {
                // Fetch messages up to this point
                const messages = await msg.channel.messages.fetch({ 
                    limit: 100,
                    before: msg.id 
                });
                
                // Filter and format messages
                const conversationText = messages
                    .reverse()
                    .map(m => `${m.author.username}: ${m.content}`)
                    .join('\n');

                const summaryPrompt = [
                    { role: 'system', content: 'Create a concise but comprehensive summary of the conversation. Focus on key points, decisions, and important information. Use bullet points for clarity.' },
                    { role: 'user', content: `Please summarize this conversation:\n\n${conversationText}` }
                ];

                const summary = await aiService.chatText(
                    summaryPrompt,
                    {
                        temperature: 0.7,
                        max_tokens: 500
                    }
                );

                const response = await msg.reply({
                    content: `📝 **Conversation Summary:**\n\n${summary}`,
                    allowedMentions: { users: [], roles: [] }
                });

                // Add pin reaction for easy reference
                await response.react('📌');
            } catch (error) {
                console.error('Error generating summary:', error);
                await msg.reply("I encountered an error while generating the summary. Please try again.");
            }
        }
    } catch (error) {
        console.error('Error in handleReactionAdd:', error);
        // Try to notify the user of the error
        try {
            await msg.channel.send(`Error processing reaction: ${error.message}`);
        } catch (notifyError) {
            console.error('Could not notify user of error:', notifyError);
        }
    }
}

async function handleReactionRemove(reaction, user) {
    if (user.bot) return;

    const msg = reaction.message;
    if (reaction.emoji.name === '📌') {
        // Unpin message if no 📌 reactions remain
        const pinReactions = msg.reactions.cache.get('📌');
        if (!pinReactions || pinReactions.count === 0) {
            try {
                await msg.unpin();
                // Remove the pin confirmation reaction if it exists
                const confirmReaction = msg.reactions.cache.get('📍');
                if (confirmReaction) {
                    await confirmReaction.remove();
                }
            } catch (error) {
                console.error('Error unpinning message:', error);
            }
        }
    }
    // Add other reaction removal handlers as needed
}

module.exports = {
    handleReactionAdd,
    handleReactionRemove
};
