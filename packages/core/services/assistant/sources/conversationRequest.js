/**
 * Source adapter `conversation_request` (ADR 0021): requests a person
 * addresses to Goobster in the conversations a responsibility covers.
 *
 * What a responsibility covers is its `scopes.sources`:
 *  - `project_chat`: the conversations of the project it is linked to;
 *  - `parlor`: the person's own Parlor discussions (the ones they own or
 *    joined) that belong to no project.
 * Only messages written by the person the responsibility acts for count,
 * and only while that person can still read the conversation. Someone
 * else's message, a persona's reply, and anything said in a conversation
 * the responsibility does not cover is never read here.
 *
 * It is a stream source. Other adapters fingerprint one record; this one
 * walks the message log forward from a single cursor per responsibility
 * (`sourceId` "messages", revision = the last message id examined). The
 * first look records where the log ends and proposes nothing: what was
 * said before a person delegated is history, not an order. After that
 * every newer message of theirs is classified by the fixed rules in
 * ../conversationRequests.js and becomes at most one event:
 *
 *   { messageId, conversationId, steer, request,
 *     sourceId: 'parlor:<conversationId>:<messageId>', revision, title,
 *     reason, origin }
 *
 * The event carries references, never the message text: the title names
 * the conversation, and the text is read again under the current access
 * check wherever it is shown or used (../conversationRequestRun.js).
 *
 * When two active responsibilities of one person cover the same
 * conversation, the older one takes its requests.
 */

const db = require('../../../db');
const { features } = require('../../../features/featureState');
const { fingerprint } = require('./fingerprint');
const rules = require('../conversationRequests');

const KIND = 'conversation_request';
const STREAM_ID = 'messages';
/** Messages examined in one pass; the rest wait for the next. */
const SCAN_LIMIT = 200;
/**
 * The cursor never passes a message younger than this. Ids are handed out
 * before a message commits, so on Postgres a lower id can appear just
 * after a higher one was read; re-reading the last moments costs nothing
 * (a message is proposed once) and loses nothing.
 */
const SETTLE_MS = 2000;
/** A request older than this when it is first read is not acted on. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Open conversation-derived attempts one responsibility may hold. */
const OPEN_LIMIT = 10;

/** The same rule parlorService applies before it shows a conversation. */
const READABLE = `(c.ownerId = @actor OR EXISTS (
        SELECT 1 FROM parlor_members pm WHERE pm.conversationId = c.id AND pm.userId = @actor))
    AND (c.projectId IS NULL OR EXISTS (
        SELECT 1 FROM observatory_projects p WHERE p.id = c.projectId
          AND (p.userId = @actor OR EXISTS (
            SELECT 1 FROM project_members m WHERE m.projectId = p.id AND m.userId = @actor))))`;

/**
 * Said in this conversation, not copied into it. A chat moved into a
 * project keeps its messages' original times (older than the conversation
 * they now sit in), and a shared answer is recorded as a transfer. Neither
 * is the person asking for something here and now.
 */
const SPOKEN_HERE = `m.createdAt >= c.createdAt AND NOT EXISTS (
        SELECT 1 FROM knowledge_transfers t
        WHERE t.targetKind = 'discussion' AND t.targetId = m.conversationId AND t.copyMessageId = m.id)`;

function utcText(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Which conversation surfaces this responsibility's scopes name. */
function surfaces(responsibility) {
    let scopes;
    try { scopes = JSON.parse(responsibility.scopesJson || '{}') || {}; } catch { scopes = {}; }
    const sources = Array.isArray(scopes.sources) ? scopes.sources : [];
    return {
        project: sources.includes('project_chat') && responsibility.projectId != null && !features.enforcedOff('projects'),
        parlor: sources.includes('parlor')
    };
}

/** The surfaces this responsibility takes requests from, after older siblings took theirs. */
async function covered(responsibility) {
    const mine = surfaces(responsibility);
    if (!mine.project && !mine.parlor) return mine;
    const older = await db.all(
        `SELECT id, projectId, scopesJson FROM assistant_responsibilities
         WHERE ownerUserId = @owner AND status = 'ACTIVE' AND id < @id`,
        { owner: responsibility.ownerUserId, id: responsibility.id }
    );
    for (const row of older) {
        const theirs = surfaces(row);
        if (theirs.project && Number(row.projectId) === Number(responsibility.projectId)) mine.project = false;
        if (theirs.parlor) mine.parlor = false;
    }
    return mine;
}

/** Does this responsibility (alone, ignoring siblings) cover a conversation of that project? */
function covers(responsibility, conversationProjectId) {
    const mine = surfaces(responsibility);
    if (conversationProjectId == null) return mine.parlor;
    return mine.project && Number(conversationProjectId) === Number(responsibility.projectId);
}

function surfaceFilter(responsibility, mine) {
    if (mine.project && mine.parlor) return { sql: '(c.projectId = @projectId OR c.projectId IS NULL)', params: { projectId: Number(responsibility.projectId) } };
    if (mine.project) return { sql: 'c.projectId = @projectId', params: { projectId: Number(responsibility.projectId) } };
    return { sql: 'c.projectId IS NULL', params: {} };
}

function describe(row) {
    const inProject = row.projectId != null;
    const named = String(row.title || '').trim();
    const where = named ? `"${named.slice(0, 120)}"` : (inProject ? 'the project conversation' : 'a discussion');
    return {
        sourceId: `parlor:${Number(row.conversationId)}:${Number(row.id)}`,
        title: `Asked in ${where}`,
        reason: inProject ? 'a request to Goobster in the project conversation' : 'a request to Goobster in a discussion',
        category: 'conversation',
        origin: {
            kind: 'parlor_message',
            surface: inProject ? 'project' : 'parlor',
            conversationId: Number(row.conversationId),
            messageId: Number(row.id),
            speakerUserId: row.userId,
            // Who can read the conversation it was said in. The result of
            // the work is still private to the person who asked.
            audience: inProject
                ? { kind: 'project', projectId: Number(row.projectId) }
                : { kind: 'conversation', conversationId: Number(row.conversationId) }
        }
    };
}

module.exports = {
    KIND,
    stream: true,
    STREAM_ID,
    OPEN_LIMIT,
    SETTLE_MS,
    MAX_AGE_MS,
    READABLE,
    surfaces,
    covers,

    /**
     * @param {Object} responsibility
     * @param {{ cursor: Object|null, now?: Date }} state
     * @returns {Promise<null | { sourceId: string, revision: string, events: Object[] }>}
     *   null when the responsibility covers no conversation.
     */
    async read(responsibility, { cursor = null, now = new Date() } = {}) {
        const own = surfaces(responsibility);
        if (!own.project && !own.parlor) return null;
        if (!cursor) {
            const top = await db.get('SELECT MAX(id) AS top FROM parlor_messages', {});
            return { sourceId: STREAM_ID, revision: String(Number(top?.top || 0)), events: [] };
        }
        const last = Number(cursor.sourceRevision) || 0;
        const mine = await covered(responsibility);
        if (!mine.project && !mine.parlor) {
            // An older responsibility takes these requests. Keep pace with
            // the log, so taking over later starts from then, not from here.
            const top = await db.get(
                'SELECT MAX(id) AS top FROM parlor_messages WHERE createdAt <= @before',
                { before: utcText(new Date(now.getTime() - SETTLE_MS)) }
            );
            return { sourceId: STREAM_ID, revision: String(Math.max(last, Number(top?.top || 0))), events: [] };
        }
        const actor = responsibility.actingUserId || responsibility.ownerUserId;
        const surface = surfaceFilter(responsibility, mine);
        const rows = await db.all(
            `SELECT m.id, m.conversationId, m.content, m.userId, m.createdAt, c.title, c.projectId
             FROM parlor_messages m
             JOIN parlor_conversations c ON c.id = m.conversationId
             WHERE m.id > @last AND m.role = 'user' AND m.userId = @actor
               AND ${surface.sql} AND ${READABLE} AND ${SPOKEN_HERE}
             ORDER BY m.id ASC LIMIT @limit`,
            { last, actor, limit: SCAN_LIMIT, ...surface.params }
        );
        const settled = await db.get(
            'SELECT MAX(id) AS top FROM parlor_messages WHERE createdAt <= @before',
            { before: utcText(new Date(now.getTime() - SETTLE_MS)) }
        );
        let revision = Math.max(last, Number(settled?.top || 0));
        if (rows.length === SCAN_LIMIT) revision = Math.max(last, Math.min(revision, Number(rows[rows.length - 1].id)));
        const oldest = utcText(new Date(now.getTime() - MAX_AGE_MS));
        const events = [];
        for (const row of rows) {
            if (String(row.createdAt) < oldest) continue;
            const parsed = rules.parse(row.content);
            if (!parsed.steer && !parsed.request) continue;
            events.push({
                ...describe(row),
                messageId: Number(row.id),
                conversationId: Number(row.conversationId),
                steer: parsed.steer,
                request: parsed.request,
                revision: fingerprint([parsed.text])
            });
        }
        return { sourceId: STREAM_ID, revision: String(revision), events };
    },

    /**
     * Proposed or queued attempts whose request can no longer be acted on:
     * the message or its conversation is gone, the person can no longer
     * read it, or the responsibility stopped covering that conversation.
     * @returns {Promise<{ id: number, code: string }[]>}
     */
    async stale(responsibility) {
        const rows = await db.all(
            `SELECT id, originJson FROM assistant_initiatives
             WHERE responsibilityId = @rid AND sourceKind = @kind AND status IN ('CANDIDATE', 'QUEUED', 'WAITING')`,
            { rid: responsibility.id, kind: KIND }
        );
        const out = [];
        for (const row of rows) {
            const found = await module.exports.locate(responsibility, row.originJson);
            if (!found.ok) out.push({ id: Number(row.id), code: found.code });
        }
        return out;
    },

    /**
     * Read the message an attempt came from, as it is now, for the person
     * the responsibility acts for.
     * @returns {Promise<{ ok: true, message: Object } | { ok: false, code: 'SOURCE_GONE'|'SOURCE_NOT_COVERED' }>}
     */
    async locate(responsibility, originJson) {
        let origin;
        try { origin = typeof originJson === 'string' ? JSON.parse(originJson) : originJson; } catch { origin = null; }
        if (!origin || origin.kind !== 'parlor_message') return { ok: false, code: 'SOURCE_GONE' };
        const actor = responsibility.actingUserId || responsibility.ownerUserId;
        const message = await db.get(
            `SELECT m.id, m.conversationId, m.content, m.userId, m.userName, m.createdAt, c.title, c.projectId
             FROM parlor_messages m
             JOIN parlor_conversations c ON c.id = m.conversationId
             WHERE m.id = @id AND m.conversationId = @conversationId AND m.role = 'user' AND m.userId = @actor
               AND ${READABLE}`,
            { id: Number(origin.messageId), conversationId: Number(origin.conversationId), actor }
        );
        // A conversation the person can no longer read is, to them, gone.
        if (!message) return { ok: false, code: 'SOURCE_GONE' };
        if (!covers(responsibility, message.projectId)) return { ok: false, code: 'SOURCE_NOT_COVERED' };
        return { ok: true, message };
    }
};
