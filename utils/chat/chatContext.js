/**
 * Conversation context assembly: fetches the recent message window from a
 * thread/channel, resolves reply references, and maintains rolling
 * conversation summaries once a conversation grows past the trigger size.
 */
const db = require('../../db');
const aiService = require('../../services/aiService');
const { chunkMessage } = require('../index');

const CONTEXT_WINDOW_SIZE = 20; // Number of messages to keep in active context
const SUMMARY_TRIGGER = 30; // Number of messages that triggers a summary

async function summarizeContext(messages, guildConvId) {
    try {
        const messageText = messages
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');

        const summaryPrompt = `Please provide a brief, bullet-point summary of the key points from this conversation. Focus on the most important information that would be relevant for future context:\n\n${messageText}`;

        const summary = await aiService.chatText([
            { role: 'user', content: summaryPrompt }
        ], {
            temperature: 0.7,
            max_tokens: 500
        });
        
        // Chunk the summary if needed
        const chunks = chunkMessage(summary);

        // Store the summary
        try {
            db.run(
                `INSERT INTO conversation_summaries (guildConversationId, summary, messageCount)
                 VALUES (@guildConvId, @summary, @messageCount)`,
                { guildConvId, summary: chunks[0], messageCount: messages.length }
            );
        } catch (dbError) {
            console.error('Database Error:', dbError);
            throw new Error('Failed to store conversation summary in database.', { cause: dbError });
        }

        return chunks[0]; // Use first chunk as summary
    } catch (error) {
        console.error('Error summarizing context:', error);
        throw error;
    }
}

async function getContextWithSummary(thread, guildConvId, userId = null, interaction = null) {
    // Get recent messages
    let messages;
    let botUserId;

    if (thread) {
        // If we have a thread, fetch messages from it
        messages = await thread.messages.fetch({ limit: CONTEXT_WINDOW_SIZE });
        botUserId = thread.client.user.id;
    } else if (interaction && interaction.channel) {
        // If we don't have a thread but have a channel, fetch messages from the channel
        messages = await interaction.channel.messages.fetch({ limit: CONTEXT_WINDOW_SIZE });
        botUserId = interaction.client.user.id;
    } else {
        // If we have neither thread nor channel, return an empty array
        // The system prompt will be added by the calling function
        return [];
    }
    
    const conversationHistory = messages
        .reverse()
        .map(m => {
            const isBot = m.author.id === botUserId;
            const speakerName = isBot ? 'Goobster' : (m.member?.displayName || m.author.username || 'Unknown');

            // Pre-pend the speaker name for clarity when not the bot
            const contentPrefix = isBot ? '' : `${speakerName}: `;

            return {
                role: isBot ? 'assistant' : 'user',
                content: `${contentPrefix}${m.content}`.trim(),
                messageId: m.id,
                authorId: m.author.id
            };
        })
        .filter(m => m.content && !m.content.startsWith('/'));

    // If user-specific context is requested, prioritize their messages
    if (userId) {
        conversationHistory.sort((a, b) => {
            if (a.authorId === userId && b.authorId !== userId) return -1;
            if (a.authorId !== userId && b.authorId === userId) return 1;
            return 0;
        });
    }

    // Handle message references and quotes
    for (let i = 0; i < conversationHistory.length; i++) {
        const msg = messages.find(m => m.id === conversationHistory[i].messageId);
        if (msg?.reference?.messageId) {
            const referencedMsg = messages.find(m => m.id === msg.reference.messageId);
            if (referencedMsg) {
                conversationHistory[i].content = `[Replying to: "${referencedMsg.content.substring(0, 50)}${referencedMsg.content.length > 50 ? '...' : ''}"]\n${conversationHistory[i].content}`;
            }
        }
    }

    // Don't add system prompt here - will be handled by the main chat handler
    // to ensure personality directive is applied correctly

    // Check if we need to generate a summary
    if (messages.size >= SUMMARY_TRIGGER) {
        const summaryRow = db.get(
            `SELECT summary FROM conversation_summaries
             WHERE guildConversationId = @guildConvId
             ORDER BY createdAt DESC LIMIT 1`,
            { guildConvId }
        );

        if (summaryRow) {
            // Add summary as a system message at the beginning
            conversationHistory.unshift({
                role: 'system',
                content: `Previous conversation summary:\n${summaryRow.summary}`
            });
        } else {
            const summary = await summarizeContext(conversationHistory, guildConvId);
            if (summary) {
                // Add generated summary as a system message
                conversationHistory.unshift({
                    role: 'system',
                    content: `Previous conversation summary:\n${summary}`
                });
            }
        }
    }

    return conversationHistory;
}

module.exports = {
    CONTEXT_WINDOW_SIZE,
    SUMMARY_TRIGGER,
    summarizeContext,
    getContextWithSummary
};
