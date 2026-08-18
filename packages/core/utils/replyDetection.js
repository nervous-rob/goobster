/**
 * Reply detection: works out whether a message that never names Goobster is
 * still an answer to something he said.
 *
 * People don't re-address someone they are already talking to, so a casual
 * back-and-forth used to die the moment a user forgot the @mention. The gate
 * here is positional rather than a stopwatch: when the message directly before
 * a user's was Goobster's own, that user's message is a candidate reply no
 * matter how long ago he spoke, and its intent decides the rest. A cheap
 * deterministic model call reads the exchange and answers "reply" or
 * "unrelated"; anything unrelated is left alone.
 *
 * Cost is bounded by the positional rule: at most one classification per
 * message Goobster sends, because the next message in the channel no longer
 * follows one of his.
 *
 * The channel history is transient (an in-memory tail per channel, rebuilt
 * from Discord on the first message after a restart), so it belongs in memory
 * rather than SQLite.
 */

const aiService = require('../services/aiService');

// Recent messages kept per channel: enough to hand the classifier the shape of
// the conversation without turning into a second message store.
const HISTORY_LIMIT = 6;

// Channels tracked at once, least-recently-used first out.
const MAX_TRACKED_CHANNELS = 500;

// Stored characters per message - the classifier only needs the gist.
const CONTENT_LIMIT = 400;

// When the classifier can't be reached (no AI provider, provider outage), a
// message this soon after Goobster spoke is treated as a reply anyway.
const FALLBACK_WINDOW_MS = 90 * 1000;

// Leading punctuation another bot's command would use (".play", "!skip").
// A word character must follow, so conversational text ("...right?", "- yeah",
// "> quoted") isn't mistaken for a command.
const OTHER_BOT_COMMAND = /^[!$%^&*+~=|\\<>.-]{1,2}\w/;

/** @type {Map<string, Array<Object>>} channelId -> oldest-to-newest tail */
const channelHistories = new Map();

/**
 * Condense a Discord message into the tail entry the classifier reads.
 * @param {Object} message - The Discord message
 * @param {string} [botId] - Goobster's user id
 * @returns {Object|null}
 */
function toRecord(message, botId) {
    if (!message?.id) return null;

    const attachmentNote = (message.attachments?.size ?? 0) > 0 ? '[attachment]' : '';
    const embed = message.embeds?.[0];
    const embedNote = embed ? `[embed] ${embed.title || ''} ${embed.description || ''}`.trim() : '';
    const text = (message.content || '').trim() || embedNote || attachmentNote;

    return {
        id: message.id,
        authorId: message.author?.id ?? null,
        authorName: message.member?.displayName || message.author?.username || 'someone',
        isBot: Boolean(message.author?.bot),
        isGoobster: Boolean(botId) && message.author?.id === botId,
        content: text.length > CONTENT_LIMIT ? `${text.slice(0, CONTENT_LIMIT)}…` : text,
        createdAt: message.createdTimestamp ?? Date.now()
    };
}

/**
 * Drop the least recently used channels once the map outgrows its cap.
 */
function sweep() {
    // Map iteration is insertion-ordered and every write re-inserts, so the
    // front of the map is the least recently touched channel.
    while (channelHistories.size > MAX_TRACKED_CHANNELS) {
        channelHistories.delete(channelHistories.keys().next().value);
    }
}

/**
 * Remember a message as the channel's newest. Call this for every message the
 * bot sees in a guild channel, its own included - Goobster's messages are the
 * ones that arm the detector.
 * @param {Object} message - The Discord message
 */
function recordMessage(message) {
    const channelId = message?.channel?.id || message?.channelId;
    if (!channelId) return;

    const record = toRecord(message, message.client?.user?.id);
    if (!record) return;

    const history = channelHistories.get(channelId) ?? [];
    if (history.some(entry => entry.id === record.id)) return;

    history.push(record);
    while (history.length > HISTORY_LIMIT) history.shift();

    channelHistories.delete(channelId);
    channelHistories.set(channelId, history);
    sweep();
}

/**
 * Forget a channel's tail.
 * @param {string} channelId
 */
function forgetChannel(channelId) {
    channelHistories.delete(channelId);
}

/**
 * Forget every channel (used by tests and on shutdown).
 */
function clearAll() {
    channelHistories.clear();
}

/**
 * The channel's remembered tail, oldest first, excluding one message id.
 * @param {string} channelId
 * @param {string} [excludeId]
 * @returns {Array<Object>}
 */
function getHistory(channelId, excludeId) {
    const history = channelHistories.get(channelId) ?? [];
    return excludeId ? history.filter(entry => entry.id !== excludeId) : [...history];
}

/**
 * The message immediately before this one. Served from the in-memory tail;
 * on a cold channel (fresh process) it is fetched once from Discord and
 * remembered.
 * @param {Object} message - The Discord message
 * @returns {Promise<Object|null>}
 */
async function getPreviousMessage(message) {
    const channelId = message.channel?.id || message.channelId;
    const history = getHistory(channelId, message.id);
    if (history.length > 0) return history[history.length - 1];

    try {
        const fetched = await message.channel.messages.fetch({ limit: 1, before: message.id });
        const previous = typeof fetched?.first === 'function' ? fetched.first() : null;
        const record = toRecord(previous, message.client?.user?.id);
        if (record) {
            channelHistories.set(channelId, [record]);
            sweep();
        }
        return record;
    } catch (error) {
        console.error('Failed to fetch the previous channel message:', error.message);
        return null;
    }
}

/**
 * Whether a message is visibly aimed at someone other than Goobster, which
 * settles the question without spending a model call.
 * @param {Object} message - The Discord message
 * @returns {boolean}
 */
function looksAddressedElsewhere(message) {
    if (message.mentions?.everyone) return true;
    if ((message.mentions?.roles?.size ?? 0) > 0) return true;

    // Mentioning another member makes them the audience. (A mention of
    // Goobster never reaches this gate - it is an explicit address.)
    const botId = message.client?.user?.id;
    if (message.mentions?.users?.some?.((_user, id) => id !== botId)) return true;

    // Replies are resolved before this gate: one aimed at Goobster is treated
    // as an explicit address, so a reply still here targets someone else.
    if (message.reference?.messageId) return true;

    return OTHER_BOT_COMMAND.test((message.content || '').trim());
}

/**
 * Human-readable gap between two timestamps ("12 seconds", "3 hours").
 * @param {number} ms
 * @returns {string}
 */
function describeGap(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Ask a cheap deterministic model whether the new message answers Goobster's.
 * @param {Object} params
 * @param {Object} params.message - The Discord message
 * @param {Object} params.previous - Goobster's preceding message record
 * @param {Array<Object>} params.history - Channel tail, oldest first
 * @returns {Promise<boolean>}
 */
async function classifyIsReply({ message, previous, history }) {
    const gap = describeGap((message.createdTimestamp ?? Date.now()) - previous.createdAt);
    const earlier = history
        .slice(0, -1)
        .map(entry => `${entry.isGoobster ? 'Goobster' : entry.authorName}: ${entry.content}`)
        .join('\n');
    const authorName = message.member?.displayName || message.author?.username || 'someone';

    const prompt = `Goobster is a chatty Discord bot. The most recent message in this channel was his own, and now ${authorName} has posted something without addressing him by name.

Decide whether that new message is aimed at Goobster: an answer, reaction, correction, or follow-up to what he said, including short ones like "lol", "thanks", or "yeah do it", and questions that only make sense as a reply to him.

Answer "unrelated" when it is a new topic, people talking among themselves, or a message that merely happens to come after his. In particular, if it answers a question or continues a thread that another person started, it belongs to them - not to Goobster, even though he spoke in between.

The gap between the two messages is ${gap}. A long gap makes a reply much less likely unless the new message clearly picks up where his left off.

${earlier ? `Earlier in the channel (oldest first):\n${earlier}\n\n` : ''}Goobster's message:
"""${previous.content}"""

New message from ${authorName}:
"""${(message.content || '').trim().slice(0, CONTENT_LIMIT)}"""

Answer with ONLY one word: "reply" or "unrelated".`;

    const verdict = (await aiService.generateText(prompt, {
        preset: 'deterministic',
        temperature: 0,
        max_tokens: 5,
        usageContext: { guildId: message.guild?.id ?? null, userId: message.author?.id ?? null }
    })).trim().toLowerCase();

    return verdict.startsWith('reply');
}

/**
 * Should Goobster answer this un-addressed message?
 *
 * Yes only when it directly follows a message of his and reads as a reply to
 * it. The verdict carries a reason so the caller can log why he spoke up (or
 * stayed quiet).
 * @param {Object} message - The Discord message
 * @returns {Promise<{respond: boolean, reason: string}>}
 */
async function shouldRespond(message) {
    if (!message || message.author?.bot) {
        return { respond: false, reason: 'not a human message' };
    }

    const content = (message.content || '').trim();
    if (!content) {
        return { respond: false, reason: 'no text to interpret' };
    }

    const previous = await getPreviousMessage(message);
    if (!previous?.isGoobster) {
        return { respond: false, reason: 'the previous message was not mine' };
    }
    if (!previous.content) {
        return { respond: false, reason: 'my previous message had no text to reply to' };
    }
    if (looksAddressedElsewhere(message)) {
        return { respond: false, reason: 'aimed at someone else' };
    }

    const history = getHistory(message.channel?.id || message.channelId, message.id);

    try {
        const isReply = await classifyIsReply({ message, previous, history });
        return isReply
            ? { respond: true, reason: 'replies to my last message' }
            : { respond: false, reason: 'unrelated to my last message' };
    } catch (error) {
        console.warn('[ReplyDetection] Classifier unavailable, falling back to recency:', error.message);
        const gap = (message.createdTimestamp ?? Date.now()) - previous.createdAt;
        return gap <= FALLBACK_WINDOW_MS
            ? { respond: true, reason: 'follows my last message closely (classifier unavailable)' }
            : { respond: false, reason: 'classifier unavailable and my last message is stale' };
    }
}

module.exports = {
    HISTORY_LIMIT,
    FALLBACK_WINDOW_MS,
    recordMessage,
    forgetChannel,
    clearAll,
    getHistory,
    getPreviousMessage,
    looksAddressedElsewhere,
    shouldRespond
};
