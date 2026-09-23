/**
 * resource_events: the non-token cost of work (roadmap #256).
 *
 * Tokens live in usage_log (reports) and usage_reservations (#248, limits
 * and the cost-per-result join). Everything else a piece of work spends
 * lands here, one row per event: a search call, the seconds a sandbox run
 * took, a retry. Rows are keyed by the same (workKind, workId) as
 * work_failures and usage_reservations, so cost per accepted result is one
 * join (costReportService). Never a query string, a code snippet or a body.
 *
 * Writers call `record()`; the kind and the quantity are explicit, the
 * work and the actor default to the current work context
 * (utils/workContext.js) so a search adapter does not have to know which
 * expedition it is serving. Recording is best-effort: it never throws.
 *
 * Erasure nulls actor and payer and keeps the row (instance totals stay
 * whole); retention is RETENTION_DAYS, matching the proposed window for
 * settled reservations so the join stays complete over a reporting period.
 */

const db = require('../db');
const logger = require('../utils/logger');
const workContext = require('../utils/workContext');

const RETENTION_DAYS = 90;

/** Event kinds and the unit each quantity is counted in. */
const KINDS = Object.freeze({
    search_call: 'calls',
    sandbox_seconds: 'seconds',
    retry: 'retries',
    image_generation: 'images',
    speech_seconds: 'seconds',
    embedding_call: 'calls'
});

function sinceText(days, now = new Date()) {
    const cutoff = new Date(now.getTime() - Math.max(1, Number(days) || 1) * 86_400_000);
    return cutoff.toISOString().slice(0, 19).replace('T', ' ');
}

class ResourceEventService {
    constructor() {
        this.KINDS = KINDS;
        this.RETENTION_DAYS = RETENTION_DAYS;
    }

    /**
     * Record one event. Never throws.
     * @param {Object} params
     * @param {string} params.kind - one of KINDS
     * @param {number} [params.quantity=1]
     * @param {string|null} [params.provider] - 'perplexity', 'wikipedia', 'bwrap', ...
     * @param {{ kind: string, id: string|number|null }|null} [params.work] - defaults to the current work context
     * @param {string|null} [params.actor] - defaults to the context actor
     * @param {string|null} [params.payer] - defaults to the context payer, then the actor
     * @returns {Promise<number|null>} the row id, or null when nothing was written
     */
    async record({ kind, quantity = 1, provider = null, work = undefined, actor = undefined, payer = undefined }) {
        try {
            if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) {
                throw new Error(`unknown resource event kind '${kind}'`);
            }
            const amount = Number(quantity);
            if (!Number.isFinite(amount) || amount < 0) throw new Error('quantity must be a non-negative number');
            const context = workContext.current();
            const ref = work === undefined ? context : workContext.normalize(work);
            const resolvedActor = actor === undefined ? (context?.actor ?? null) : actor;
            const resolvedPayer = payer === undefined ? (context?.payer ?? resolvedActor ?? null) : payer;
            return await db.insert(
                `INSERT INTO resource_events (kind, quantity, provider, workKind, workId, actor, payer)
                 VALUES (@kind, @quantity, @provider, @workKind, @workId, @actor, @payer)`,
                {
                    kind,
                    quantity: amount,
                    provider: provider == null ? null : String(provider).slice(0, 64),
                    workKind: ref?.kind ?? null,
                    workId: ref?.id ?? null,
                    actor: resolvedActor == null ? null : String(resolvedActor),
                    payer: resolvedPayer == null ? null : String(resolvedPayer)
                }
            );
        } catch (error) {
            logger.warn?.(`[resource_events] Could not record ${kind}: ${error.message}`);
            return null;
        }
    }

    /**
     * Totals by kind within a window, for one actor or the installation.
     * @param {{ userId?: string|null, days?: number }} [options]
     * @returns {Promise<Array<{ kind: string, unit: string, events: number, quantity: number }>>}
     */
    async totals({ userId = null, days = 30 } = {}) {
        const params = { since: sinceText(days) };
        let where = 'createdAt >= @since';
        if (userId != null) {
            params.userId = String(userId);
            where += ' AND actor = @userId';
        }
        const rows = await db.all(
            `SELECT kind, COUNT(*) AS events, SUM(quantity) AS quantity FROM resource_events
             WHERE ${where} GROUP BY kind ORDER BY kind ASC`,
            params
        );
        return rows.map(row => ({
            kind: row.kind,
            unit: KINDS[row.kind] || 'units',
            events: Number(row.events),
            quantity: Number(row.quantity || 0)
        }));
    }

    /** Events for one piece of work, oldest first. */
    async listForWork(kind, workId) {
        return db.all(
            `SELECT id, kind, quantity, provider, actor, payer, createdAt FROM resource_events
             WHERE workKind = @kind AND workId = @workId ORDER BY id ASC`,
            { kind, workId: String(workId) }
        );
    }

    /** A person's own events, newest first (the transparency report). */
    async listForUser(userId, { limit = 100 } = {}) {
        return db.all(
            `SELECT id, kind, quantity, provider, workKind, workId, createdAt FROM resource_events
             WHERE actor = @userId ORDER BY createdAt DESC, id DESC LIMIT @limit`,
            { userId: String(userId), limit: Math.max(1, Math.min(1000, Number(limit) || 100)) }
        );
    }

    /**
     * Retention sweep.
     * @returns {Promise<number>} rows removed
     */
    async prune({ days = RETENTION_DAYS, now = new Date() } = {}) {
        const cutoff = new Date(now.getTime() - Math.max(1, days) * 86_400_000);
        return (await db.run('DELETE FROM resource_events WHERE createdAt < @cutoff', { cutoff })).changes;
    }

    /** Erasure: anonymize actor and payer, keep the row. */
    async forgetUser(userId) {
        const id = String(userId);
        const actors = (await db.run('UPDATE resource_events SET actor = NULL WHERE actor = @id', { id })).changes;
        const payers = (await db.run('UPDATE resource_events SET payer = NULL WHERE payer = @id', { id })).changes;
        return actors + payers;
    }

    /** Post-erasure audit count. */
    async countForUser(userId) {
        const row = await db.get(
            'SELECT COUNT(*) AS c FROM resource_events WHERE actor = @id OR payer = @id',
            { id: String(userId) }
        );
        return Number(row?.c || 0);
    }
}

module.exports = new ResourceEventService();
module.exports.ResourceEventService = ResourceEventService;
module.exports.KINDS = KINDS;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
