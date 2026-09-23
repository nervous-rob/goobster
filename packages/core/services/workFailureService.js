/**
 * work_failures: one row per failed piece of work (roadmap #256).
 *
 * The ledger of what went wrong, for the person who owns the work and for
 * the operator's per-account support view. It joins usage_reservations and
 * resource_events on workId. Rows carry a kind, a phase, a machine code and
 * a short reason - never a prompt, a reply or a message body; the reason is
 * clipped hard so a stray stack trace or model output cannot become one.
 *
 * Erasure (privacyService.forgetUser) nulls `actor` and keeps the row, the
 * same treatment usage_log gets. Retention: prune() removes rows older
 * than RETENTION_DAYS.
 */

const db = require('../db');

const MAX_REASON = 300;
const RETENTION_DAYS = 30;

/** The first work to write here; restore (#249) and the #256 wiring extend it. */
const KINDS = new Set([
    'chat', 'expedition', 'job', 'sandbox', 'automation', 'trigger', 'delivery',
    'mission_step', 'watch', 'followup', 'integration_action', 'reflection'
]);

function clip(text, max) {
    if (text == null) return null;
    const flat = String(text).replace(/\s+/g, ' ').trim();
    if (!flat) return null;
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

class WorkFailureService {
    constructor() {
        this.KINDS = KINDS;
        this.RETENTION_DAYS = RETENTION_DAYS;
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
     * A person's own failures, newest first.
     * @param {string} userId
     * @param {{limit?: number}} [options]
     */
    async listForUser(userId, { limit = 50 } = {}) {
        return db.all(
            `SELECT id, kind, workId, phase, code, reason, createdAt
             FROM work_failures WHERE actor = @userId
             ORDER BY createdAt DESC, id DESC LIMIT @limit`,
            { userId: String(userId), limit: Math.max(1, Math.min(500, Number(limit) || 50)) }
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
