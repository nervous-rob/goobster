const aiService = require('../services/aiService');

const MAX_MESSAGES = 300;
const MIN_MESSAGES = 5;

/**
 * Fetch a channel's messages within a time window (paginated, newest first
 * from Discord, returned oldest first).
 */
async function fetchWindow(channel, hours) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const collected = [];
    let before;

    while (collected.length < MAX_MESSAGES) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (batch.size === 0) break;

        let reachedCutoff = false;
        for (const message of batch.values()) {
            if (message.createdTimestamp < cutoff) {
                reachedCutoff = true;
                break;
            }
            collected.push(message);
        }
        if (reachedCutoff || batch.size < 100) break;
        before = batch.last().id;
    }

    return collected.reverse();
}

/**
 * Generate an AI digest of a channel's recent activity.
 * @param {Object} channel - Discord text channel
 * @param {number} hours - Window size in hours
 * @param {Object} options - { usageContext }
 * @returns {Promise<string|null>} digest text, or null when too quiet
 */
async function generateDigest(channel, hours, options = {}) {
    const messages = await fetchWindow(channel, hours);
    const meaningful = messages.filter(m => m.content && !m.content.startsWith('/'));
    if (meaningful.length < MIN_MESSAGES) {
        return null;
    }

    const transcript = meaningful.map(m => {
        const time = new Date(m.createdTimestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const name = m.member?.displayName || m.author.username;
        return `[${time}] ${name}${m.author.bot ? ' (bot)' : ''}: ${m.content.slice(0, 400)}`;
    }).join('\n');

    return await aiService.chatText([
        {
            role: 'system',
            content: `You are Goobster, a Discord bot writing a channel digest. Summarize the conversation below into a scannable recap. Structure:
- **Highlights** - the main topics/threads of discussion (2-5 bullets)
- **Decisions & plans** - anything agreed on or scheduled (omit section if none)
- **Open questions** - unanswered questions or unresolved topics (omit section if none)

Keep it under 250 words, mention people by name, and keep your usual light personality without burying the content.`
        },
        {
            role: 'user',
            content: `Digest of #${channel.name} for the last ${hours} hours (${meaningful.length} messages):\n\n${transcript}`
        }
    ], {
        preset: 'chat',
        max_tokens: 600,
        usageContext: options.usageContext
    });
}

module.exports = { generateDigest };
