/**
 * A change of direction said to Goobster in a conversation (ADR 0021).
 *
 * "Goobster, scratch that" or "Goobster, compare Koa instead" must do more
 * than add a conflicting note next to work that is already queued. When
 * the conversation-request adapter reads such a message, apply():
 *
 *  1. supersedes every attempt that the same person's earlier requests in
 *     that conversation produced and that has not finished: proposed,
 *     queued and waiting attempts end at once; an attempt that is being
 *     worked on loses its lease, so its run stops before its next tool
 *     call and writes no result (the same fencing a cancel uses);
 *  2. records one update for the person saying what was stopped and what
 *     rested on it: changes a stopped run had already made (read from its
 *     journal, and left as they are), research it had started (cancelled
 *     by the steward), and results finished under the earlier direction
 *     that are worth another look.
 *
 * Nothing is undone and nothing is deleted. A superseded attempt keeps its
 * reference to the message that replaced it (`supersededBy`) and can be
 * tried again by its owner. Work that did not come from that conversation
 * is not touched: a plan changes through the plan (its revision moving
 * withdraws the steps proposed under it, sources/projectPlanStep.js).
 *
 * The update names the conversation and counts; it never quotes a message.
 */

const db = require('../../db');

const KIND = 'conversation_request';
const STOP_CODE = 'STEERED';
/** How far back a finished result still counts as resting on the earlier direction. */
const EARLIER_RESULT_DAYS = 7;
const EARLIER_RESULT_MAX = 5;

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

const messageIdOf = (sourceId) => Number(String(sourceId || '').split(':')[2]) || 0;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Supersede what a change of direction replaces. Runs inside the caller's
 * transaction; the update's Inbox envelope is filed after the commit.
 * @param {{ responsibility: Object, event: { sourceId: string, conversationId: number, messageId: number } }} params
 * @returns {Promise<null | { ref: string, superseded: number[] }>} null when there was nothing to stop
 */
async function apply({ responsibility, event }) {
    const owner = responsibility.ownerUserId;
    const open = await db.all(
        `SELECT id, sourceId FROM assistant_initiatives
         WHERE ownerUserId = @owner AND sourceKind = @kind AND sourceId LIKE @conversation
           AND status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING')
         ORDER BY id ASC`,
        { owner, kind: KIND, conversation: `parlor:${Number(event.conversationId)}:%` }
    );
    // Only what was asked before this message: its own replacement request is new work.
    const targets = open.filter(row => messageIdOf(row.sourceId) < Number(event.messageId));
    const superseded = [];
    const now = utcText();
    for (const row of targets) {
        const result = await db.run(
            `UPDATE assistant_initiatives
             SET status = 'SUPERSEDED', stopCode = @code, supersededBy = @ref, waitReason = NULL,
                 leaseToken = NULL, leaseExpiresAt = NULL, recheckAfter = NULL,
                 revision = revision + 1, endedAt = @now, updatedAt = @now
             WHERE id = @id AND status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING')`,
            { id: row.id, code: STOP_CODE, ref: event.sourceId, now }
        );
        if (result.changes > 0) superseded.push(Number(row.id));
    }
    if (!superseded.length) return null;
    await publish({ ownerUserId: owner, ref: event.sourceId, deliverNow: false });
    return { ref: event.sourceId, superseded };
}

/**
 * Record, or bring up to date, the update for one change of direction,
 * from what the database says now. Idempotent: an unchanged description
 * publishes nothing new.
 * @returns {Promise<Object|null>} the update, or null when the reference stopped nothing
 */
async function publish({ ownerUserId, ref, deliverNow = true }) {
    const owner = String(ownerUserId);
    const stopped = await db.all(
        `SELECT i.id, i.responsibilityId, r.id AS runId
         FROM assistant_initiatives i
         LEFT JOIN assistant_runs r ON r.initiativeId = i.id
         WHERE i.ownerUserId = @owner AND i.supersededBy = @ref AND i.status = 'SUPERSEDED'
         ORDER BY i.id ASC`,
        { owner, ref }
    );
    if (!stopped.length) return null;
    const [, conversationRef] = String(ref).split(':');
    const conversationId = Number(conversationRef);
    const conversation = await db.get('SELECT title, projectId FROM parlor_conversations WHERE id = @id', { id: conversationId });
    const named = String(conversation?.title || '').trim();
    const where = named ? `"${named.slice(0, 120)}"` : (conversation?.projectId != null ? 'the project conversation' : 'a discussion');

    const runs = require('../assistantRunService');
    const begun = stopped.filter(row => row.runId != null);
    const fresh = stopped.length - begun.length;
    const changes = [];
    const components = new Set(['conversations']);
    if (conversation?.projectId != null) components.add('projects');
    let research = 0;
    for (const row of begun) {
        const applied = await runs._applied(row.runId);
        changes.push(...applied.lines);
        applied.components.forEach(component => components.add(component));
        // Counted whether or not the steward has cancelled it yet, so the
        // description does not change when it does.
        research += (await runs._children(row.runId))
            .filter(child => !['COMPLETED', 'FAILED'].includes(child.status)).length;
    }
    const since = utcText(new Date(Date.now() - EARLIER_RESULT_DAYS * 86400000));
    const earlier = (await db.all(
        `SELECT i.id, i.sourceId, i.status, r.resultTitle FROM assistant_initiatives i
         JOIN assistant_runs r ON r.initiativeId = i.id
         WHERE i.ownerUserId = @owner AND i.sourceKind = @kind AND i.sourceId LIKE @conversation
           AND (i.status = 'REVIEW' OR (i.status = 'COMPLETED' AND i.outcome = 'DONE'))
           AND i.updatedAt >= @since AND r.resultTitle IS NOT NULL
         ORDER BY i.id DESC LIMIT @limit`,
        { owner, kind: KIND, conversation: `parlor:${conversationId}:%`, since, limit: EARLIER_RESULT_MAX * 4 }
    )).filter(row => messageIdOf(row.sourceId) < messageIdOf(ref)).slice(0, EARLIER_RESULT_MAX);

    const lines = [`You changed direction in ${where}.`];
    if (fresh) lines.push(`${plural(fresh, 'request')} had not started and ${fresh === 1 ? 'was' : 'were'} withdrawn.`);
    if (begun.length) {
        lines.push(`${plural(begun.length, 'request')} had started and ${begun.length === 1 ? 'was' : 'were'} stopped. Work in progress stops before its next step and reports no result.`);
    }
    if (changes.length) lines.push(`Already changed, and left as it is: ${changes.join(' ')}`);
    if (research) lines.push(`${plural(research, 'research expedition')} it had started ${research === 1 ? 'is' : 'are'} stopped as well.`);
    if (earlier.length) {
        lines.push(`Finished under the earlier direction, worth another look: ${earlier.map(row => `"${String(row.resultTitle).slice(0, 120)}"${row.status === 'REVIEW' ? ' (waiting for your review)' : ''}`).join('; ')}.`);
    }
    lines.push('Nothing was undone. A stopped request can be started again from Assistant.');

    const updates = require('../assistantUpdateService');
    const published = await updates.publish({
        audience: { userId: owner },
        identityKey: `steer:${ref}`,
        kind: 'progress',
        title: `Changed direction: ${plural(stopped.length, 'request')} stopped`,
        summary: lines.join('\n').slice(0, 2000),
        components: [...components],
        source: { kind: KIND, id: ref },
        actions: [
            { kind: 'open_conversation', id: String(conversationId) },
            { kind: 'open_responsibility', id: String(stopped[0].responsibilityId) }
        ],
        responsibilityId: stopped[0].responsibilityId,
        producerUserId: owner,
        deliver: true,
        deliverNow
    });
    return published.update;
}

/**
 * A run found its lease gone. If a change of direction took it, bring that
 * update up to date now that the run has stopped (it may have finished
 * one more change first). Never throws.
 */
async function afterRunStopped({ initiativeId }) {
    try {
        const row = await db.get(
            'SELECT ownerUserId, status, stopCode, supersededBy FROM assistant_initiatives WHERE id = @id',
            { id: Number(initiativeId) }
        );
        if (!row || row.status !== 'SUPERSEDED' || row.stopCode !== STOP_CODE || !row.supersededBy) return null;
        return await publish({ ownerUserId: row.ownerUserId, ref: row.supersededBy });
    } catch {
        return null;
    }
}

module.exports = { STOP_CODE, apply, publish, afterRunStopped };
