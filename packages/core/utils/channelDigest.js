const aiService = require('../services/aiService');

const MAX_MESSAGES = 300;
const MIN_MESSAGES = 5;

/**
 * Resolve server display names for message authors. Messages fetched via
 * channel.messages.fetch() only carry .member for cached members, so relying
 * on m.member?.displayName silently degrades to raw account usernames.
 * Bulk-fetches uncached members once and returns an authorId -> name map.
 * @param {Object} guild
 * @param {Array} messages
 * @returns {Promise<Map<string, string>>}
 */
async function resolveDisplayNames(guild, messages) {
    const names = new Map();
    const missing = new Set();

    for (const m of messages) {
        if (names.has(m.author.id)) continue;
        const cached = m.member || guild?.members.cache.get(m.author.id);
        if (cached) {
            names.set(m.author.id, cached.displayName);
        } else {
            missing.add(m.author.id);
        }
    }

    if (guild && missing.size > 0) {
        try {
            const fetched = await guild.members.fetch({ user: [...missing] });
            for (const member of fetched.values()) {
                names.set(member.id, member.displayName);
            }
        } catch (error) {
            console.warn('[ChannelDigest] Bulk member fetch failed, using fallback names:', error.message);
        }
    }

    // Anyone still unresolved (left the server, fetch failed): prefer the
    // global display name over the raw account username.
    for (const m of messages) {
        if (!names.has(m.author.id)) {
            names.set(m.author.id, m.author.displayName || m.author.username);
        }
    }

    return names;
}

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

    const names = await resolveDisplayNames(channel.guild, meaningful);
    const transcript = meaningful.map(m => {
        const time = new Date(m.createdTimestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const name = names.get(m.author.id);
        return `[${time}] ${name}${m.author.bot ? ' (bot)' : ''}: ${m.content.slice(0, 400)}`;
    }).join('\n');

    return await aiService.chatText([
        {
            role: 'system',
            content: `You are Goobster, a Discord bot writing a channel digest. Summarize the conversation below into a scannable recap. Structure:
- **Highlights** - the main topics/threads of discussion (2-5 bullets)
- **Decisions & plans** - anything agreed on or scheduled (omit section if none)
- **Open questions** - unanswered questions or unresolved topics (omit section if none)

Keep it under 250 words and keep your usual light personality without burying the content.
When mentioning people, use their names EXACTLY as they appear in the transcript - never alter, shorten, translate, or invent names.`
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

module.exports = { generateDigest, resolveDisplayNames };
