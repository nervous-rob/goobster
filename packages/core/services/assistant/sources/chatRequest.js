/**
 * Source adapter `chat_request` (DA-8, ADR 0026): requests and commitments a
 * person makes in their own portal chats.
 *
 * `conversation_request` (ADR 0021) takes what is said to Goobster by name in
 * a project's conversations and in Parlor. This adapter reads the one place
 * a person talks to Goobster alone, where the name is not needed and a model
 * may help: `scopes.sources` includes `personal_chat`.
 *
 * What is read, and only this:
 *  - messages the acting person wrote (not Goobster's replies), in their own
 *    portal conversations, said there and not copied in from a branch;
 *  - nothing from an incognito exchange - those are never stored;
 *  - nothing while the person has turned off "learn from my chats"
 *    (`learnMemories`), and nothing from a conversation they excluded from
 *    memory (`memory_channel_exclusions`) - the same switches that stop
 *    Goobster learning from the chat.
 * The first look records where the log ends and proposes nothing: what was
 * said before the person delegated is history, not an order.
 *
 * How a message is judged, cheapest first:
 *  1. the fixed rules (../conversationRequests.js): a request addressed to
 *     Goobster by name is explicit - uncapped, like a request in Parlor;
 *  2. the same rules without the name ("can you look into that for me") are
 *     implied; a model label ("request" or "commitment", see
 *     ../messageClassification.js) is implied too. A passing mention, a
 *     question about the past and every answer the model cannot give
 *     propose nothing. Implied requests share the adapter's daily cap.
 * At most `CLASSIFY_PER_PASS` model calls happen in one pass; the cursor
 * stops before the first message it could not afford to judge, so nothing is
 * skipped and nothing is judged twice.
 *
 * The event carries references, never the message text.
 */

const db = require('../../../db');
const { fingerprint } = require('./fingerprint');
const access = require('./access');
const rules = require('../conversationRequests');
const classification = require('../messageClassification');
const { dmScopeId } = require('../../../utils/dmScope');

const KIND = 'chat_request';
const SCOPE = 'personal_chat';
const CAPABILITY = 'sources';
const STREAM_ID = 'messages';
const MAX_PER_DAY = 3;
const OPEN_LIMIT = 10;
const SCAN_LIMIT = 200;
const CLASSIFY_PER_PASS = 5;
/** See conversationRequest.js: the cursor never passes a message this young. */
const SETTLE_MS = 2000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONTEXT_MESSAGES = 2;

function utcText(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** The messages of one person's portal chats, as the person sees them. */
const OWN_MESSAGE = `gc.guildId = @scope AND m.isBot = 0 AND m.createdAt >= wc.createdAt`;
const FROM_OWN_CHATS = `FROM messages m
    JOIN guild_conversations gc ON gc.id = m.guildConversationId
    JOIN web_conversations wc ON wc.channelId = gc.channelId AND wc.userId = @actor`;
const NOT_EXCLUDED = `NOT EXISTS (SELECT 1 FROM memory_channel_exclusions x WHERE x.guildId = @scope AND x.channelId = gc.channelId)`;

/** Is personal chat in this responsibility's scopes, and may Goobster learn from this person's chats? */
async function covers(responsibility) {
    if (!access.scoped(responsibility, 'personal_chat')) return false;
    const actor = access.actorOf(responsibility);
    return require('../../personalPolicyService').memoryAllowed(dmScopeId(actor), 'learnMemories');
}

/** Does an older active responsibility of this person already take personal-chat requests? */
async function takenByOlder(responsibility) {
    const older = await db.all(
        `SELECT id, scopesJson FROM assistant_responsibilities
         WHERE ownerUserId = @owner AND status = 'ACTIVE' AND id < @id`,
        { owner: responsibility.ownerUserId, id: responsibility.id }
    );
    return older.some(row => access.scoped(row, 'personal_chat'));
}

function describe(row) {
    const named = String(row.title || '').trim();
    return {
        sourceId: `chat:${Number(row.conversationId)}:${Number(row.id)}`,
        title: `Asked in ${named ? `"${named.slice(0, 120)}"` : 'a chat'}`,
        reason: 'a request in your own chat',
        category: 'conversation',
        origin: {
            kind: 'chat_message',
            conversationId: Number(row.conversationId),
            messageId: Number(row.id),
            speakerUserId: row.speakerUserId
        }
    };
}

/** The lines just before a message in its conversation, for the model only. */
async function contextBefore(row, actor) {
    const rows = await db.all(
        `SELECT m.message, m.isBot ${FROM_OWN_CHATS}
         WHERE wc.id = @conversationId AND m.id < @id AND ${OWN_MESSAGE}
         ORDER BY m.id DESC LIMIT @limit`,
        { actor, scope: dmScopeId(actor), conversationId: Number(row.conversationId), id: Number(row.id), limit: CONTEXT_MESSAGES }
    );
    return rows.reverse().map(entry => `${entry.isBot ? 'assistant' : 'person'}: ${entry.message}`);
}

module.exports = {
    KIND,
    SCOPE,
    capability: CAPABILITY,
    stream: true,
    STREAM_ID,
    OPEN_LIMIT,
    MAX_PER_DAY,
    CLASSIFY_PER_PASS,
    SETTLE_MS,
    OWN_MESSAGE,
    FROM_OWN_CHATS,
    NOT_EXCLUDED,
    covers,

    /** Feedback changes the rate of implied requests only: what was asked for by name is always taken. */
    learns: origin => Boolean(origin?.implied),

    /** Explicit requests (by name) are not capped; implied ones share the day's cap. */
    dailyCap(event) { return event.implied ? MAX_PER_DAY : null; },

    async read(responsibility, { cursor = null, now = new Date(), classify = classification.classify } = {}) {
        if (!(await covers(responsibility))) return null;
        const actor = access.actorOf(responsibility);
        const scope = dmScopeId(actor);
        if (!cursor) {
            const top = await db.get('SELECT MAX(id) AS top FROM messages', {});
            return { sourceId: STREAM_ID, revision: String(Number(top?.top || 0)), events: [] };
        }
        const last = Number(cursor.sourceRevision) || 0;
        const settledAt = utcText(new Date(now.getTime() - SETTLE_MS));
        const settled = await db.get('SELECT MAX(id) AS top FROM messages WHERE createdAt <= @before', { before: settledAt });
        if (await takenByOlder(responsibility)) {
            return { sourceId: STREAM_ID, revision: String(Math.max(last, Number(settled?.top || 0))), events: [] };
        }
        const rows = await db.all(
            `SELECT m.id, m.message AS content, m.createdAt, wc.id AS conversationId, wc.title, wc.userId AS speakerUserId
             ${FROM_OWN_CHATS}
             WHERE m.id > @last AND ${OWN_MESSAGE} AND ${NOT_EXCLUDED}
             ORDER BY m.id ASC LIMIT @limit`,
            { last, actor, scope, limit: SCAN_LIMIT }
        );
        let revision = Math.max(last, Number(settled?.top || 0));
        if (rows.length === SCAN_LIMIT) revision = Math.max(last, Math.min(revision, Number(rows[rows.length - 1].id)));
        const oldest = utcText(new Date(now.getTime() - MAX_AGE_MS));
        const events = [];
        let judged = 0;
        for (const row of rows) {
            if (Number(row.id) > revision) break;
            if (String(row.createdAt) < oldest) continue;
            const parsed = rules.parse(row.content);
            let implied = false;
            let label = null;
            if (parsed.request) {
                label = 'request';
            } else if (rules.asksPolitely(row.content)) {
                label = 'request';
                implied = true;
            } else if (rules.hasCue(row.content)) {
                const result = await classify({
                    responsibility, messageId: row.id, text: row.content, context: await contextBefore(row, actor), now,
                    // Past the per-pass limit only a label already on file is used.
                    cachedOnly: judged >= CLASSIFY_PER_PASS
                });
                if (result.label === null) {
                    // Could not be judged now (no allowance, no provider, the pass limit): wait here.
                    revision = Math.max(last, Number(row.id) - 1);
                    break;
                }
                if (!result.cached) judged += 1;
                if (result.label === 'request' || result.label === 'commitment') { label = result.label; implied = true; }
            }
            if (!label) continue;
            events.push({
                ...describe(row),
                propose: true,
                implied,
                messageId: Number(row.id),
                conversationId: Number(row.conversationId),
                revision: fingerprint([rules.normalize(row.content)]),
                origin: { ...describe(row).origin, label, implied }
            });
        }
        return { sourceId: STREAM_ID, revision: String(revision), events };
    },

    /** The same words, in the same chat, while an attempt from it is open. */
    async alreadyWork(responsibility, event) {
        const same = await db.get(
            `SELECT id FROM assistant_initiatives
             WHERE ownerUserId = @owner AND sourceKind = @kind AND sourceId LIKE @conversation AND sourceRevision = @revision
               AND status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW') LIMIT 1`,
            { owner: responsibility.ownerUserId, kind: KIND, conversation: `chat:${Number(event.conversationId)}:%`, revision: event.revision }
        );
        return Boolean(same);
    },

    /** Open attempts whose message or chat is gone, or no longer covered. */
    async stale(responsibility) {
        const out = [];
        for (const attempt of await access.openAttempts(db, responsibility, KIND)) {
            const found = await module.exports.locate(responsibility, attempt.origin);
            if (!found.ok) out.push({ id: attempt.id, code: found.code });
        }
        return out;
    },

    /**
     * The message an attempt came from, as it is now, for the person the
     * responsibility acts for, with the lines just before it.
     * @returns {Promise<{ ok: true, message: Object, context: string[] } | { ok: false, code: 'SOURCE_GONE'|'SOURCE_NOT_COVERED' }>}
     */
    async locate(responsibility, originValue) {
        const origin = access.originOf(originValue);
        if (!origin || origin.kind !== 'chat_message') return { ok: false, code: 'SOURCE_GONE' };
        const actor = access.actorOf(responsibility);
        const scope = dmScopeId(actor);
        const message = await db.get(
            `SELECT m.id, m.message AS content, m.createdAt, wc.id AS conversationId, wc.title, gc.channelId
             ${FROM_OWN_CHATS}
             WHERE m.id = @id AND wc.id = @conversationId AND ${OWN_MESSAGE}`,
            { id: Number(origin.messageId), conversationId: Number(origin.conversationId), actor, scope }
        );
        if (!message) return { ok: false, code: 'SOURCE_GONE' };
        const excluded = await db.get(
            'SELECT 1 AS x FROM memory_channel_exclusions WHERE guildId = @scope AND channelId = @channelId',
            { scope, channelId: message.channelId }
        );
        if (excluded || !(await covers(responsibility))) return { ok: false, code: 'SOURCE_NOT_COVERED' };
        return { ok: true, message, context: await contextBefore({ id: message.id, conversationId: message.conversationId }, actor) };
    },

    /** What the owner sees before activating: messages in the window the fixed rules alone would have caught, which count as history. */
    async lookback(responsibility, { now = new Date() } = {}) {
        if (!(await covers(responsibility))) return { sources: 0, ignored: 0, examples: [] };
        const actor = access.actorOf(responsibility);
        const rows = await db.all(
            `SELECT m.message AS content, wc.title ${FROM_OWN_CHATS}
             WHERE ${OWN_MESSAGE} AND ${NOT_EXCLUDED} AND m.createdAt >= @since
             ORDER BY m.id DESC LIMIT 500`,
            { actor, scope: dmScopeId(actor), since: utcText(new Date(now.getTime() - MAX_AGE_MS)) }
        );
        const caught = rows.filter(row => rules.parse(row.content).request || rules.asksPolitely(row.content));
        return {
            sources: 1,
            ignored: caught.length,
            examples: caught.slice(0, 3).map(row => `Asked in ${String(row.title || '').trim() ? `"${String(row.title).trim().slice(0, 80)}"` : 'a chat'}`)
        };
    }
};
