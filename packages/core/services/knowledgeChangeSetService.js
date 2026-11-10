/**
 * Knowledge change sets (DA-11b, ADR 0027; documentation/delegated_knowledge.md).
 *
 * One row of `kg_change_sets` is one change to a person's notes that a
 * delegated run proposed, or made under a grant that names direct editing,
 * or a review of a source that was withdrawn. The lifecycle is the one the
 * architecture names (section 6):
 *
 *   PROPOSED -> APPLIED | REJECTED | STALE      APPLIED -> REVERTED
 *
 * Who does what:
 *  - A run FILES a proposal (`propose`) or RECORDS a direct edit it was
 *    granted (`recordDirect`). It never applies a proposal: `apply` and
 *    `reject` are reached only through the gate registry, from a signed-in
 *    person's own click, and are not offered as a tool.
 *  - A proposal is checked against the note again when it is applied. If
 *    the note moved since the run read it (a person edited it, another
 *    change was applied) nothing is written: the set becomes STALE and the
 *    run's next pass can propose again from what is there now.
 *  - Applying and reverting write through `knowledgeGraphService.applyNoteChange`,
 *    which compares revisions. A revert is a compensating change: it restores
 *    the exact earlier state only while the note is still at the revision
 *    the change produced; otherwise it is refused, never forced.
 *
 * A change set holds the person's own note text (before and after), so it
 * is covered by erasure, export and the retention pass like the notes.
 */

const db = require('../db');
const logger = require('../utils/logger');
const kg = require('./knowledgeGraphService');
const { CHANGE_SETS } = require('../config/knowledgeGraphConfig');
const { diffText } = require('../utils/textDiff');

const GATE_KINDS = { saved_note_edit: 'note_proposal', source_retraction: 'source_retraction' };

class ChangeSetError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ChangeSetError';
        this.status = status;
        this.code = code;
    }
}

const utcText = (date = new Date()) => date.toISOString().slice(0, 19).replace('T', ' ');
const clip = (value, max) => {
    const text = value == null ? '' : String(value).trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
function parse(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
}

class KnowledgeChangeSetService {
    constructor() {
        this.ChangeSetError = ChangeSetError;
        this.GATE_KINDS = GATE_KINDS;
    }

    identityKey(id) {
        return `kg_change_set:${id}`;
    }

    async get(id) {
        const n = Number(id);
        if (!Number.isSafeInteger(n) || n <= 0) return null;
        return db.get('SELECT * FROM kg_change_sets WHERE id = @id', { id: n });
    }

    /** The row if it is this person's, else null (indistinguishable from absent). */
    async forPerson(id, userId) {
        const row = await this.get(id);
        return row && row.userId === String(userId) ? row : null;
    }

    // --- Filing --------------------------------------------------------------

    /**
     * File a proposal to change a note the person saved. The run supplies the
     * revision it read; the note is not touched.
     * @returns {Promise<{ ok: true, id: number, existing?: boolean } | { ok: false, code: string, revision?: number }>}
     */
    async propose({ guildId, userId, run, nodeId, expectedRevision, content, disputeReason, rationale }) {
        const cleanContent = content === undefined || content === null ? null : String(content).trim();
        const cleanReason = disputeReason ? clip(disputeReason, CHANGE_SETS.maxReasonLength) : null;
        if ((!cleanContent && !cleanReason) || !Number.isSafeInteger(Number(expectedRevision))) return { ok: false, code: 'BAD_REQUEST' };
        return db.transaction(async () => {
            const node = await kg.getPersonalNote({ guildId, userId, nodeId });
            if (!node) return { ok: false, code: 'NOT_FOUND' };
            if (node.archivedAt) return { ok: false, code: 'ARCHIVED' };
            if (node.curation !== 'saved') return { ok: false, code: 'NOT_SAVED' };
            if (Number(node.revision) !== Number(expectedRevision)) return { ok: false, code: 'REVISION_CONFLICT', revision: Number(node.revision) };
            const changesText = cleanContent && cleanContent !== String(node.content || '').trim();
            const changesClaim = Boolean(cleanReason) && (node.claimStatus || 'current') !== 'disputed';
            if (!changesText && !changesClaim) return { ok: false, code: 'NO_CHANGE' };

            const operations = [];
            if (changesText) operations.push({ op: 'amend', nodeId: Number(node.id), content: cleanContent.slice(0, 1000) });
            if (changesClaim) operations.push({ op: 'dispute', nodeId: Number(node.id), reason: cleanReason });
            const operationsJson = JSON.stringify(operations);

            // The same proposal again is the same request: no second card, no second notice.
            const open = await db.all(
                `SELECT * FROM kg_change_sets WHERE userId = @userId AND nodeId = @nodeId AND status = 'PROPOSED'
                   AND kind = 'saved_note_edit' AND responsibilityId = @responsibilityId`,
                { userId: String(userId), nodeId: node.id, responsibilityId: run.responsibilityId }
            );
            const same = open.find(row => row.expectedRevision === Number(node.revision) && row.operationsJson === operationsJson);
            if (same) return { ok: true, id: Number(same.id), existing: true };

            const counts = await db.get(
                `SELECT
                    (SELECT COUNT(*) FROM kg_change_sets WHERE responsibilityId = @responsibilityId AND status = 'PROPOSED') AS open,
                    (SELECT COUNT(*) FROM kg_change_sets WHERE runId = @runId) AS perRun`,
                { responsibilityId: run.responsibilityId, runId: run.id }
            );
            if (Number(counts?.perRun || 0) >= CHANGE_SETS.maxPerRun) return { ok: false, code: 'RUN_LIMIT' };
            // An older proposal for this same note from this grant is replaced by the new one.
            const superseded = open.filter(row => row !== same);
            if (Number(counts?.open || 0) - superseded.length >= CHANGE_SETS.maxOpenPerResponsibility) return { ok: false, code: 'TOO_MANY_OPEN' };
            for (const row of superseded) await this._close(row, 'STALE', 'SUPERSEDED');

            const before = {
                label: node.label, content: node.content || null, revision: Number(node.revision),
                source: node.source, curation: node.curation, claimStatus: node.claimStatus || 'current'
            };
            const after = {
                content: changesText ? cleanContent.slice(0, 1000) : (node.content || null),
                claimStatus: changesClaim ? 'disputed' : before.claimStatus
            };
            const id = Number(await db.insert(
                `INSERT INTO kg_change_sets
                    (userId, guildId, scopeKey, kind, status, runId, responsibilityId, responsibilityRevision, nodeId,
                     expectedRevision, operationsJson, beforeJson, afterJson, rationale, evidenceJson, policyCode)
                 VALUES (@userId, @guildId, @scopeKey, 'saved_note_edit', 'PROPOSED', @runId, @responsibilityId,
                     @responsibilityRevision, @nodeId, @expectedRevision, @operationsJson, @beforeJson, @afterJson,
                     @rationale, @evidenceJson, 'PROPOSAL')`,
                {
                    userId: String(userId), guildId, scopeKey: node.scopeKey, runId: run.id,
                    responsibilityId: run.responsibilityId, responsibilityRevision: run.responsibilityRevision,
                    nodeId: node.id, expectedRevision: Number(node.revision), operationsJson,
                    beforeJson: JSON.stringify(before), afterJson: JSON.stringify(after),
                    rationale: clip(rationale, CHANGE_SETS.maxRationaleLength) || null,
                    evidenceJson: JSON.stringify([{ kind: 'run', id: Number(run.id) }])
                }
            ));
            await this.publishGate(await this.get(id), { run });
            return { ok: true, id };
        });
    }

    /**
     * Change a saved note directly, under a grant that names direct editing,
     * and keep the before and after so the person can revert it. The note
     * stays the person's: its source and curation are unchanged.
     */
    async recordDirect({ guildId, userId, run, nodeId, expectedRevision, content, rationale }) {
        const cleanContent = content ? String(content).trim() : '';
        if (!cleanContent || !Number.isSafeInteger(Number(expectedRevision))) return { ok: false, code: 'BAD_REQUEST' };
        return db.transaction(async () => {
            const node = await kg.getPersonalNote({ guildId, userId, nodeId });
            if (!node) return { ok: false, code: 'NOT_FOUND' };
            if (node.archivedAt) return { ok: false, code: 'ARCHIVED' };
            if (node.curation !== 'saved') return { ok: false, code: 'NOT_SAVED' };
            if (cleanContent === String(node.content || '').trim()) return { ok: false, code: 'NO_CHANGE' };
            const used = await db.get('SELECT COUNT(*) AS n FROM kg_change_sets WHERE runId = @runId', { runId: run.id });
            if (Number(used?.n || 0) >= CHANGE_SETS.maxPerRun) return { ok: false, code: 'RUN_LIMIT' };
            const applied = await kg.applyNoteChange({ guildId, userId, nodeId, expectedRevision, content: cleanContent });
            if (!applied.ok) return applied;
            const id = Number(await db.insert(
                `INSERT INTO kg_change_sets
                    (userId, guildId, scopeKey, kind, status, runId, responsibilityId, responsibilityRevision, nodeId,
                     expectedRevision, operationsJson, beforeJson, afterJson, rationale, evidenceJson, policyCode,
                     decisionCode, appliedRevision, decidedAt)
                 VALUES (@userId, @guildId, @scopeKey, 'direct_change', 'APPLIED', @runId, @responsibilityId,
                     @responsibilityRevision, @nodeId, @expectedRevision, @operationsJson, @beforeJson, @afterJson,
                     @rationale, @evidenceJson, 'DIRECT_GRANT', 'APPLIED', @appliedRevision, @now)`,
                {
                    userId: String(userId), guildId, scopeKey: node.scopeKey, runId: run.id,
                    responsibilityId: run.responsibilityId, responsibilityRevision: run.responsibilityRevision,
                    nodeId: node.id, expectedRevision: Number(expectedRevision),
                    operationsJson: JSON.stringify([{ op: 'amend', nodeId: Number(node.id), content: cleanContent.slice(0, 1000) }]),
                    beforeJson: JSON.stringify({ label: node.label, ...applied.before, revision: Number(expectedRevision) }),
                    afterJson: JSON.stringify({ content: cleanContent.slice(0, 1000) }),
                    rationale: clip(rationale, CHANGE_SETS.maxRationaleLength) || null,
                    evidenceJson: JSON.stringify([{ kind: 'run', id: Number(run.id) }]),
                    appliedRevision: applied.revision, now: utcText()
                }
            ));
            return { ok: true, id, revision: applied.revision };
        });
    }

    // --- The gate -------------------------------------------------------------

    /**
     * Put a proposal in front of the person as a request on Home and in the
     * Inbox. Inside the caller's transaction the Inbox envelope stays pending
     * (the steward files it); the gate itself exists at once.
     */
    async publishGate(row, { run = null } = {}) {
        const updates = require('./assistantUpdateService');
        const kind = row.kind === 'source_retraction' ? 'source_retraction' : 'note_proposal';
        const impact = parse(row.impactJson, null);
        const before = parse(row.beforeJson, {});
        const title = kind === 'source_retraction'
            ? `A source was withdrawn: ${clip(impact?.source?.label || 'a source', 120)}`
            : `Suggested change to "${clip(before.label || 'a note', 120)}"`;
        const summary = kind === 'source_retraction'
            ? clip(`${(impact?.notes || []).length + Number(impact?.moreNotes || 0)} of your notes cite it. Nothing was deleted or changed; open this to review.`, 600)
            : clip(`${row.rationale ? `${row.rationale} ` : ''}Nothing changes until you apply it.`, 600);
        const responsibilityId = row.responsibilityId || run?.responsibilityId || null;
        await updates.publish({
            audience: { userId: row.userId },
            identityKey: this.identityKey(row.id),
            kind: 'question',
            title,
            summary,
            components: ['knowledge'],
            source: { kind: 'kg_change_set', id: String(row.id), revision: '1' },
            actions: responsibilityId ? [{ kind: 'open_responsibility', id: String(responsibilityId) }] : [],
            gate: { kind, id: String(row.id), occurrence: 1 },
            responsibilityId,
            initiativeId: run?.initiativeId || null,
            producerUserId: row.userId,
            deliver: true,
            deliverNow: false
        });
        const published = await db.get(
            `SELECT id FROM assistant_updates WHERE audienceKey = @key AND identityKey = @identityKey`,
            { key: String(row.userId), identityKey: this.identityKey(row.id) }
        );
        if (published) await db.run('UPDATE kg_change_sets SET updateId = @updateId WHERE id = @id', { id: row.id, updateId: published.id });
    }

    async _resolveGate(row) {
        try {
            await require('./assistantUpdateService').resolveGate({
                audience: { userId: row.userId }, identityKey: this.identityKey(row.id)
            });
        } catch (error) {
            logger.warn?.(`[knowledge changes] could not close the request for change set ${row.id}: ${error.message}`);
        }
    }

    /** End a PROPOSED set without writing the note (stale, expired, superseded). */
    async _close(row, status, decisionCode) {
        await db.run(
            `UPDATE kg_change_sets SET status = @status, decisionCode = @decisionCode, decidedAt = @now, updatedAt = @now
             WHERE id = @id AND status = 'PROPOSED'`,
            { id: row.id, status, decisionCode, now: utcText() }
        );
        await this._resolveGate(row);
    }

    // --- Deciding (a person's own action; never a tool) -------------------------

    /**
     * Apply a proposal as the person. The note is read again: if it is no
     * longer at the revision the run read, nothing is written, the set is
     * STALE, and the caller gets REVISION_CONFLICT.
     */
    async apply({ id, userId }) {
        let stale = null;
        let message = 'Applied.';
        const row = await db.transaction(async () => {
            const current = await this.forPerson(id, userId);
            if (!current) throw new ChangeSetError(404, 'NOT_FOUND', 'No such request.');
            if (current.status !== 'PROPOSED') throw new ChangeSetError(409, 'NOT_OPEN', 'This request was already settled.');
            if (current.kind === 'source_retraction') return this._applyRetraction(current, (m) => { message = m; }, (c) => { stale = c; });
            const operations = parse(current.operationsJson, []);
            const content = operations.find(op => op.op === 'amend')?.content;
            const disputed = operations.some(op => op.op === 'dispute');
            const applied = await kg.applyNoteChange({
                guildId: current.guildId, userId: current.userId, nodeId: current.nodeId,
                expectedRevision: current.expectedRevision,
                content: content === undefined ? undefined : content,
                claimStatus: disputed ? 'disputed' : undefined,
                asPerson: true
            });
            if (!applied.ok) {
                stale = applied.code === 'NOT_FOUND' ? 'NOTE_GONE' : applied.code === 'ARCHIVED' ? 'NOTE_ARCHIVED' : 'REVISION_CONFLICT';
                await db.run(
                    `UPDATE kg_change_sets SET status = 'STALE', decisionCode = @code, decidedAt = @now, updatedAt = @now WHERE id = @id`,
                    { id: current.id, code: stale, now: utcText() }
                );
                return current;
            }
            await db.run(
                `UPDATE kg_change_sets SET status = 'APPLIED', decisionCode = 'APPLIED', appliedRevision = @revision,
                     beforeJson = @before, decidedAt = @now, updatedAt = @now WHERE id = @id`,
                { id: current.id, revision: applied.revision, before: JSON.stringify({ ...parse(current.beforeJson, {}), ...applied.before }), now: utcText() }
            );
            return current;
        });
        await this._resolveGate(row);
        if (stale) {
            throw new ChangeSetError(409, 'REVISION_CONFLICT', 'The note changed after this was proposed, so nothing was changed.');
        }
        return { message };
    }

    async reject({ id, userId }) {
        const row = await db.transaction(async () => {
            const current = await this.forPerson(id, userId);
            if (!current) throw new ChangeSetError(404, 'NOT_FOUND', 'No such request.');
            if (current.status !== 'PROPOSED') throw new ChangeSetError(409, 'NOT_OPEN', 'This request was already settled.');
            await db.run(
                `UPDATE kg_change_sets SET status = 'REJECTED', decisionCode = 'REJECTED', decidedAt = @now, updatedAt = @now WHERE id = @id`,
                { id: current.id, now: utcText() }
            );
            return current;
        });
        await this._resolveGate(row);
        return { message: row.kind === 'source_retraction' ? 'Left your notes as they are.' : 'Dismissed. The note was not changed.' };
    }

    /** A source review's apply: mark each note it names disputed, at the revision the review read. */
    async _applyRetraction(current, setMessage, setStale) {
        const impact = parse(current.impactJson, { notes: [] });
        const applied = [];
        const skipped = [];
        for (const note of impact.notes || []) {
            const result = await kg.applyNoteChange({
                guildId: current.guildId, userId: current.userId, nodeId: note.id,
                expectedRevision: note.revision, claimStatus: 'disputed'
            });
            if (result.ok) applied.push({ id: note.id, label: note.label, appliedRevision: result.revision, before: result.before });
            else skipped.push({ id: note.id, label: note.label, code: result.code });
        }
        if (!applied.length && skipped.length) {
            setStale('REVISION_CONFLICT');
            await db.run(
                `UPDATE kg_change_sets SET status = 'STALE', decisionCode = 'REVISION_CONFLICT', decidedAt = @now, updatedAt = @now WHERE id = @id`,
                { id: current.id, now: utcText() }
            );
            return current;
        }
        await db.run(
            `UPDATE kg_change_sets SET status = 'APPLIED', decisionCode = 'APPLIED', afterJson = @after, decidedAt = @now, updatedAt = @now WHERE id = @id`,
            { id: current.id, after: JSON.stringify({ applied, skipped }), now: utcText() }
        );
        setMessage(`Marked ${applied.length} note${applied.length === 1 ? '' : 's'} as disputed${skipped.length ? `; ${skipped.length} changed since and were left alone` : ''}.`);
        return current;
    }

    /**
     * Undo an applied change by putting back exactly what it replaced. Only
     * while the note is still at the revision the change produced: a later
     * edit is never overwritten (REVISION_CONFLICT).
     */
    async revert({ id, userId }) {
        return db.transaction(async () => {
            const current = await this.forPerson(id, userId);
            if (!current) throw new ChangeSetError(404, 'NOT_FOUND', 'No such change.');
            if (current.status !== 'APPLIED') throw new ChangeSetError(409, 'NOT_APPLIED', 'Only an applied change can be reverted.');
            const targets = current.kind === 'source_retraction'
                ? (parse(current.afterJson, {}).applied || []).map(entry => ({ nodeId: entry.id, revision: entry.appliedRevision, snapshot: entry.before }))
                : [{ nodeId: current.nodeId, revision: current.appliedRevision, snapshot: parse(current.beforeJson, {}) }];
            // All or nothing: check every note first, then write.
            for (const target of targets) {
                const node = await kg.getPersonalNote({ guildId: current.guildId, userId: current.userId, nodeId: target.nodeId });
                if (!node) throw new ChangeSetError(409, 'NOTE_GONE', 'The note is gone, so there is nothing to put back.');
                if (node.archivedAt) throw new ChangeSetError(409, 'NOTE_ARCHIVED', 'Restore the note from the archive before reverting this change.');
                if (Number(node.revision) !== Number(target.revision)) {
                    throw new ChangeSetError(409, 'REVISION_CONFLICT', 'The note changed after this was applied. Reverting would overwrite that, so it was not done.');
                }
            }
            for (const target of targets) {
                const result = await kg.applyNoteChange({
                    guildId: current.guildId, userId: current.userId, nodeId: target.nodeId,
                    expectedRevision: target.revision, snapshot: target.snapshot
                });
                if (!result.ok) throw new ChangeSetError(409, 'REVISION_CONFLICT', 'The note changed after this was applied, so it was not reverted.');
            }
            await db.run(
                `UPDATE kg_change_sets SET status = 'REVERTED', revertedAt = @now, updatedAt = @now WHERE id = @id`,
                { id: current.id, now: utcText() }
            );
            return { message: `Put back ${targets.length === 1 ? 'the earlier text' : `${targets.length} notes`}.` };
        });
    }

    // --- Reading -------------------------------------------------------------

    /** A row as a client sees it (never the model's raw operation JSON beyond what the diff shows). */
    present(row) {
        const before = parse(row.beforeJson, {});
        const after = parse(row.afterJson, {});
        const operations = parse(row.operationsJson, []);
        const impact = parse(row.impactJson, null);
        const diff = row.kind !== 'source_retraction'
            ? diffText(before.content, after.content ?? before.content)
            : [];
        return {
            id: Number(row.id),
            kind: row.kind,
            status: row.status,
            nodeId: row.nodeId == null ? null : Number(row.nodeId),
            label: before.label || null,
            operations: operations.map(op => (op.op === 'dispute' ? { op: 'dispute', reason: op.reason || null } : { op: op.op })),
            diff,
            claimStatus: row.kind !== 'source_retraction' && after.claimStatus && after.claimStatus !== before.claimStatus
                ? { from: before.claimStatus || 'current', to: after.claimStatus }
                : null,
            rationale: row.rationale || null,
            policy: row.policyCode || null,
            decision: row.decisionCode || null,
            runId: row.runId == null ? null : Number(row.runId),
            responsibilityId: row.responsibilityId == null ? null : Number(row.responsibilityId),
            impact: impact ? {
                source: impact.source || null,
                reason: impact.reason || null,
                notes: impact.notes || [],
                moreNotes: Number(impact.moreNotes || 0),
                assumptions: impact.assumptions || [],
                unverifiable: true
            } : null,
            revertible: row.status === 'APPLIED',
            createdAt: row.createdAt,
            decidedAt: row.decidedAt || null,
            revertedAt: row.revertedAt || null
        };
    }

    /** What is waiting for the person, what was done, and what is archived. */
    async overview({ guildId, userId, limit = 40 }) {
        const bound = Math.max(1, Math.min(100, Number(limit) || 40));
        const rows = await db.all(
            `SELECT * FROM kg_change_sets WHERE userId = @userId ORDER BY id DESC LIMIT @limit`,
            { userId: String(userId), limit: bound }
        );
        const presented = rows.map(row => this.present(row));
        return {
            proposals: presented.filter(entry => entry.status === 'PROPOSED'),
            changes: presented.filter(entry => entry.status !== 'PROPOSED'),
            archived: await kg.listArchivedNotes({ guildId, userId, limit: bound }),
            retractedLinks: (await kg.listRetractedEdges({ guildId, userId, limit: bound })).map(edge => ({
                id: Number(edge.id), relation: edge.relation, from: edge.sourceLabel, to: edge.targetLabel, retractedAt: edge.retractedAt
            }))
        };
    }

    // --- Housekeeping ----------------------------------------------------------

    /** Proposals nobody decided in a month are no longer a current request. */
    async expireOpen({ now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - CHANGE_SETS.openDays * 86400000));
        const rows = await db.all(
            `SELECT * FROM kg_change_sets WHERE status = 'PROPOSED' AND createdAt < @cutoff LIMIT 200`, { cutoff }
        );
        for (const row of rows) await this._close(row, 'STALE', 'EXPIRED');
        return rows.length;
    }

    /** Retention: decided change sets (and the note text they hold) are removed after a while. */
    async prune({ days = CHANGE_SETS.retentionDays, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        return (await db.run(
            `DELETE FROM kg_change_sets WHERE status <> 'PROPOSED' AND updatedAt < @cutoff`, { cutoff }
        )).changes || 0;
    }

    /** Erasure: every change set that is this person's. */
    async forgetUser(userId) {
        return (await db.run('DELETE FROM kg_change_sets WHERE userId = @userId', { userId: String(userId) })).changes || 0;
    }
}

module.exports = new KnowledgeChangeSetService();
module.exports.KnowledgeChangeSetService = KnowledgeChangeSetService;
module.exports.ChangeSetError = ChangeSetError;
