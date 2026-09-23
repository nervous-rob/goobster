/**
 * Cost per accepted result (roadmap #256, measured in #265).
 *
 * One join, no new table: usage_reservations.actualTokens (#248) and
 * resource_events (search calls, sandbox seconds, retries) on
 * (workKind, workId), with work_failures alongside so a failed run's cost
 * is visible next to the accepted ones. usage_log is deliberately not part
 * of this - it has no workId and no payer, and erasure nulls its userId.
 *
 * "Accepted" is the consumer's word: a brief marked accepted (#254), a
 * result the person kept. Callers pass the accepted work ids (or a count)
 * and get the totals divided by them.
 */

const db = require('../db');

function sinceText(days, now = new Date()) {
    const cutoff = new Date(now.getTime() - Math.max(1, Number(days) || 1) * 86_400_000);
    return cutoff.toISOString().slice(0, 19).replace('T', ' ');
}

/** WHERE fragment and params shared by the three ledgers. */
function scope({ workKind = null, payer = null, days = null, from = null, to = null }, alias) {
    const where = [];
    const params = {};
    if (workKind) {
        params.workKind = String(workKind);
        where.push(`${alias}.workKind = @workKind`);
    }
    if (payer) {
        params.payer = String(payer);
        where.push(`${alias}.payer = @payer`);
    }
    const since = from || (days ? sinceText(days) : null);
    if (since) {
        params.since = String(since);
        where.push(`${alias}.createdAt >= @since`);
    }
    if (to) {
        params.until = String(to);
        where.push(`${alias}.createdAt < @until`);
    }
    return { where: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

class CostReportService {
    /**
     * Per-work cost rows: settled tokens from usage_reservations, resource
     * quantities by kind, and the failure count, for every piece of work
     * that has at least one reservation or resource event in scope.
     *
     * @param {{ workKind?: string, payer?: string, days?: number, from?: string, to?: string }} [filter]
     * @returns {Promise<Array<{ workKind: string, workId: string, payer: string|null, actualTokens: number, estimatedTokens: number, reservations: number, resources: Record<string, number>, failures: number }>>}
     */
    async workCosts(filter = {}) {
        const reservations = scope(filter, 'r');
        const events = scope({ ...filter, payer: null }, 'e');
        const tokenRows = await db.all(
            `SELECT r.workKind, r.workId, MAX(r.payer) AS payer,
                    COALESCE(SUM(CASE WHEN r.status = 'settled' THEN r.actualTokens ELSE 0 END), 0) AS actualTokens,
                    COALESCE(SUM(CASE WHEN r.status = 'held' THEN r.estimatedTokens ELSE 0 END), 0) AS heldTokens,
                    COUNT(*) AS reservations
             FROM usage_reservations r ${reservations.where}
             GROUP BY r.workKind, r.workId`,
            reservations.params
        );
        const eventRows = await db.all(
            `SELECT e.workKind, e.workId, e.kind, SUM(e.quantity) AS quantity, MAX(e.payer) AS payer
             FROM resource_events e ${events.where} ${events.where ? 'AND' : 'WHERE'} e.workId IS NOT NULL
             GROUP BY e.workKind, e.workId, e.kind`,
            events.params
        );

        const byKey = new Map();
        const ensure = (workKind, workId, payer) => {
            const key = `${workKind}\u0000${workId}`;
            if (!byKey.has(key)) {
                byKey.set(key, {
                    workKind, workId, payer: payer ?? null,
                    actualTokens: 0, estimatedTokens: 0, reservations: 0,
                    resources: {}, failures: 0
                });
            }
            const row = byKey.get(key);
            if (!row.payer && payer) row.payer = payer;
            return row;
        };
        for (const row of tokenRows) {
            const entry = ensure(row.workKind, String(row.workId), row.payer);
            entry.actualTokens += Number(row.actualTokens || 0);
            entry.estimatedTokens += Number(row.heldTokens || 0);
            entry.reservations += Number(row.reservations || 0);
        }
        for (const row of eventRows) {
            // A payer filter applies through the reservation; events for
            // work that has no reservation in scope are still that work's.
            if (filter.payer && row.payer && String(row.payer) !== String(filter.payer)) continue;
            const entry = ensure(row.workKind, String(row.workId), row.payer);
            entry.resources[row.kind] = (entry.resources[row.kind] || 0) + Number(row.quantity || 0);
        }
        if (byKey.size === 0) return [];

        const failureRows = await db.all(
            `SELECT kind, workId, COUNT(*) AS count FROM work_failures
             WHERE workId IS NOT NULL GROUP BY kind, workId`
        );
        for (const row of failureRows) {
            const entry = byKey.get(`${row.kind}\u0000${String(row.workId)}`);
            if (entry) entry.failures += Number(row.count || 0);
        }
        return [...byKey.values()].sort((a, b) =>
            a.workKind.localeCompare(b.workKind) || a.workId.localeCompare(b.workId, undefined, { numeric: true }));
    }

    /**
     * Totals over the scope, divided by the accepted results.
     * @param {Object} params - workCosts filter plus:
     * @param {Array<string|number>|number} [params.accepted] - accepted work ids, or a count
     * @returns {Promise<{ works: number, accepted: number, totals: { actualTokens: number, resources: Record<string, number>, failures: number }, perAccepted: { actualTokens: number, resources: Record<string, number> } | null, rows: Array }>}
     */
    async costPerResult({ accepted = 0, ...filter } = {}) {
        const rows = await this.workCosts(filter);
        const totals = { actualTokens: 0, resources: {}, failures: 0 };
        for (const row of rows) {
            totals.actualTokens += row.actualTokens;
            totals.failures += row.failures;
            for (const [kind, quantity] of Object.entries(row.resources)) {
                totals.resources[kind] = (totals.resources[kind] || 0) + quantity;
            }
        }
        const acceptedCount = Array.isArray(accepted)
            ? new Set(accepted.map(String)).size
            : Math.max(0, Math.trunc(Number(accepted) || 0));
        const perAccepted = acceptedCount > 0
            ? {
                actualTokens: totals.actualTokens / acceptedCount,
                resources: Object.fromEntries(Object.entries(totals.resources).map(([kind, quantity]) => [kind, quantity / acceptedCount]))
            }
            : null;
        return { works: rows.length, accepted: acceptedCount, totals, perAccepted, rows };
    }
}

module.exports = new CostReportService();
module.exports.CostReportService = CostReportService;
