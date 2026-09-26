/**
 * work_failures: one row per failed piece of work (roadmap #256).
 *
 * The ledger of what went wrong, for the person who owns the work and for
 * the operator's per-account support view. It joins usage_reservations and
 * resource_events on (kind, workId). Rows carry a kind, a phase, a machine
 * code and a short reason - never a prompt, a reply or a message body; the
 * reason is clipped hard so a stray stack trace or model output cannot
 * become one.
 *
 * Writers call `record()` (a row) or `notify()` (a row plus the Inbox item
 * that tells the person, linked to the row through its source). Both are
 * best-effort from the caller's point of view: `note()` swallows its own
 * errors so a failing ledger can never turn a handled failure into a crash.
 *
 * Erasure (privacyService.forgetUser) nulls `actor` and keeps the row, the
 * same treatment usage_log gets. Retention: prune() removes rows older
 * than RETENTION_DAYS. Full reference: documentation/work_ledger.md.
 */

const db = require('../db');
const logger = require('../utils/logger');
const workContext = require('../utils/workContext');

const MAX_REASON = 300;
const RETENTION_DAYS = 30;
/** The Inbox source type that links an item to its work_failures row. */
const INBOX_SOURCE_TYPE = 'work_failure';

/** Every kind of work that can fail into this ledger. */
const KINDS = new Set([
    'chat', 'expedition', 'job', 'sandbox', 'automation', 'trigger', 'delivery',
    'mission_step', 'watch', 'followup', 'integration_action', 'reflection', 'followed_source'
]);

function clip(text, max) {
    if (text == null) return null;
    const flat = String(text).replace(/\s+/g, ' ').trim();
    if (!flat) return null;
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sinceText(days, now = new Date()) {
    const cutoff = new Date(now.getTime() - Math.max(1, Number(days) || 1) * 86_400_000);
    return cutoff.toISOString().slice(0, 19).replace('T', ' ');
}

class WorkFailureService {
    constructor() {
        this.KINDS = KINDS;
        this.RETENTION_DAYS = RETENTION_DAYS;
        this.INBOX_SOURCE_TYPE = INBOX_SOURCE_TYPE;
    }

    /**
     * Record a failure. Idempotency is the caller's concern (a retry that
     * fails again is a second failure and gets a second row).
     * @param {Object} params
     * @param {string} params.kind - one of KINDS
     * @param {string|number|null} [params.workId] - the turn / run / job id
     * @param {string|null} [params.phase] - where in the work it failed
     * @param {string} params.code - machine code, e.g. INTERRUPTED_BY_RESTORE
     * @param {string|null} [params.reason] - short human phrase, no bodies
     * @param {string|null} [params.actor] - principal who started the work
     * @returns {Promise<number>} the row id
     */
    async record({ kind, workId = null, phase = null, code, reason = null, actor = null }) {
        if (!KINDS.has(kind)) throw new Error(`work_failures: unknown kind '${kind}'`);
        const cleanCode = clip(code, 64);
        if (!cleanCode) throw new Error('work_failures: a code is required');
        return db.insert(
            `INSERT INTO work_failures (kind, workId, phase, code, reason, actor)
             VALUES (@kind, @workId, @phase, @code, @reason, @actor)`,
            {
                kind,
                workId: workId == null ? null : String(workId),
                phase: clip(phase, 64),
                code: cleanCode,
                reason: clip(reason, MAX_REASON),
                actor: actor == null ? null : String(actor)
            }
        );
    }

    /**
     * Best-effort `record()` for the catch blocks of running work: fills
     * kind / workId / actor from the current work context when the caller
     * does not pass them, and never throws - a ledger problem is logged,
     * not propagated into a failure path that is already being handled.
     * @param {Object} params - as record(); kind, workId and actor optional
     * @returns {Promise<number|null>} the row id, or null when nothing was written
     */
    async note(params = {}) {
        try {
            const work = workContext.current();
            const kind = params.kind || work?.kind;
            if (!kind || !KINDS.has(kind)) return null;
            return await this.record({
                ...params,
                kind,
                workId: params.workId ?? work?.id ?? null,
                actor: params.actor ?? work?.actor ?? null
            });
        } catch (error) {
            logger.warn?.(`[work_failures] Could not record a ${params.kind || 'work'} failure: ${error.message}`);
            return null;
        }
    }

    /**
     * Record a failure and tell the person through the Inbox. The item's
     * source is the ledger row, so the Inbox can show what went wrong.
     * Never throws; a delivery problem leaves the row in place.
     * @param {Object} params - record() fields plus:
     * @param {string} params.userId - who to tell (defaults to the actor)
     * @param {string} params.title - Inbox title
     * @param {string|null} [params.body] - Inbox body (Markdown, no prompt or reply text)
     * @param {string|null} [params.link] - portal path
     * @param {string|null} [params.dedupeKey]
     * @param {Object|false} [params.discord] - inboxService.deliver echo option
     * @returns {Promise<{ failureId: number|null, item: Object|null }>}
     */
    async notify({ userId = null, title, body = null, link = null, dedupeKey = null, discord = false, ...failure }) {
        const failureId = await this.note(failure);
        const owner = userId ?? failure.actor ?? workContext.current()?.actor ?? null;
        if (!owner || !title) return { failureId, item: null };
        try {
            const inboxService = require('./inboxService');
            const { item } = await inboxService.deliver({
                userId: owner,
                kind: 'system',
                title,
                body,
                source: failureId != null ? { type: INBOX_SOURCE_TYPE, id: failureId } : null,
                link,
                dedupeKey,
                discord
            });
            return { failureId, item };
        } catch (error) {
            logger.warn?.(`[work_failures] Could not deliver the failure notice: ${error.message}`);
            return { failureId, item: null };
        }
    }

    /** One row, or null. */
    async get(id) {
        const row = await db.get(
            'SELECT id, kind, workId, phase, code, reason, actor, createdAt FROM work_failures WHERE id = @id',
            { id: Number(id) }
        );
        return row || null;
    }

    /** Rows by id, for one owner (the Inbox joins its failure items this way). */
    async getManyForUser(ids, userId) {
        const clean = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
        if (clean.length === 0) return [];
        const rows = await db.all(
            `SELECT id, kind, workId, phase, code, reason, createdAt FROM work_failures
             WHERE actor = @userId AND id IN (${clean.map((_, i) => `@id${i}`).join(', ')})`,
            Object.assign({ userId: String(userId) }, ...clean.map((id, i) => ({ [`id${i}`]: id })))
        );
        return rows;
    }

    /**
     * A person's own failures, newest first.
     * @param {string} userId
     * @param {{limit?: number, days?: number}} [options]
     */
    async listForUser(userId, { limit = 50, days = null } = {}) {
        const params = { userId: String(userId), limit: Math.max(1, Math.min(500, Number(limit) || 50)) };
        let where = 'actor = @userId';
        if (days) {
            params.since = sinceText(days);
            where += ' AND createdAt >= @since';
        }
        return db.all(
            `SELECT id, kind, workId, phase, code, reason, createdAt
             FROM work_failures WHERE ${where}
             ORDER BY createdAt DESC, id DESC LIMIT @limit`,
            params
        );
    }

    /** Failures for one piece of work (any actor). */
    async listForWork(kind, workId) {
        return db.all(
            `SELECT id, kind, workId, phase, code, reason, actor, createdAt
             FROM work_failures WHERE kind = @kind AND workId = @workId
             ORDER BY id ASC`,
            { kind, workId: String(workId) }
        );
    }

    /**
     * Failure counts by kind and code within a window, for one actor or the
     * whole installation. The operator's support view and the person's own
     * Usage room both read this shape.
     * @param {{ userId?: string|null, days?: number }} [options]
     * @returns {Promise<{ total: number, byKind: Array<{kind: string, count: number}>, byCode: Array<{kind: string, code: string, count: number}> }>}
     */
    async summarize({ userId = null, days = 30 } = {}) {
        const params = { since: sinceText(days) };
        let where = 'createdAt >= @since';
        if (userId != null) {
            params.userId = String(userId);
            where += ' AND actor = @userId';
        }
        const byKind = await db.all(
            `SELECT kind, COUNT(*) AS count FROM work_failures WHERE ${where}
             GROUP BY kind ORDER BY count DESC, kind ASC`,
            params
        );
        const byCode = await db.all(
            `SELECT kind, code, COUNT(*) AS count FROM work_failures WHERE ${where}
             GROUP BY kind, code ORDER BY count DESC, kind ASC, code ASC LIMIT 50`,
            params
        );
        return {
            total: byKind.reduce((sum, row) => sum + Number(row.count), 0),
            byKind: byKind.map(row => ({ kind: row.kind, count: Number(row.count) })),
            byCode: byCode.map(row => ({ kind: row.kind, code: row.code, count: Number(row.count) }))
        };
    }

    /**
     * Failure counts per actor within a window - the roster column of the
     * operator's support view. Anonymized rows (actor NULL) are excluded.
     * @returns {Promise<Map<string, number>>}
     */
    async countByActor({ days = 30 } = {}) {
        const rows = await db.all(
            `SELECT actor, COUNT(*) AS count FROM work_failures
             WHERE createdAt >= @since AND actor IS NOT NULL GROUP BY actor`,
            { since: sinceText(days) }
        );
        return new Map(rows.map(row => [String(row.actor), Number(row.count)]));
    }

    /**
     * Retention sweep: drop rows older than the window.
     * @param {{days?: number, now?: Date}} [options]
     * @returns {Promise<number>} rows removed
     */
    async prune({ days = RETENTION_DAYS, now = new Date() } = {}) {
        const cutoff = new Date(now.getTime() - Math.max(1, days) * 86_400_000);
        return (await db.run(
            'DELETE FROM work_failures WHERE createdAt < @cutoff',
            { cutoff }
        )).changes;
    }

    /** Erasure: anonymize, keep the row (the operator's failure counts stay whole). */
    async forgetUser(userId) {
        return (await db.run(
            'UPDATE work_failures SET actor = NULL WHERE actor = @userId',
            { userId: String(userId) }
        )).changes;
    }

    /** Post-erasure audit count. */
    async countForUser(userId) {
        const row = await db.get(
            'SELECT COUNT(*) AS c FROM work_failures WHERE actor = @userId',
            { userId: String(userId) }
        );
        return Number(row?.c || 0);
    }
}

module.exports = new WorkFailureService();
module.exports.WorkFailureService = WorkFailureService;
module.exports.KINDS = KINDS;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
module.exports.INBOX_SOURCE_TYPE = INBOX_SOURCE_TYPE;
