/**
 * The daily proposal cap (DA-8, ADR 0026).
 *
 * Each adapter that notices things by itself may propose at most
 * `DEFAULT_MAX_PER_DAY` opportunities per responsibility per UTC day. A
 * change past the cap is not queued: it is counted and folded into the
 * adapter's cursor, so the next day starts from the newest state and a
 * flood cannot become a backlog. The count is what the Assistant page shows
 * as "not proposed today".
 *
 * `take()` is one conditional UPDATE, so two processes (or a pass that is
 * repeated after a restart) cannot both take the last slot. Call it inside
 * the transaction that inserts the proposal: when the insert rolls back,
 * the slot goes with it.
 */

const db = require('../../db');

/** Proposed default (ARCH 13.2). */
const DEFAULT_MAX_PER_DAY = 3;
const RETENTION_DAYS = 14;

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

const dayOf = (now) => now.toISOString().slice(0, 10);

/**
 * Take one slot for a proposal.
 * @returns {Promise<{ ok: boolean, proposed: number, cap: number }>}
 *   `ok: false` means the cap is spent: the change is counted as coalesced.
 */
async function take({ responsibility, sourceKind, cap = DEFAULT_MAX_PER_DAY, now = new Date() }) {
    const params = {
        rid: Number(responsibility.id), owner: String(responsibility.ownerUserId), kind: sourceKind,
        day: dayOf(now), cap: Math.max(0, Number(cap) || 0), now: utcText(now)
    };
    await db.run(
        `INSERT INTO assistant_proposal_counters (responsibilityId, ownerUserId, sourceKind, day)
         VALUES (@rid, @owner, @kind, @day)
         ON CONFLICT (responsibilityId, sourceKind, day) DO NOTHING`,
        params
    );
    const taken = await db.run(
        `UPDATE assistant_proposal_counters SET proposed = proposed + 1, updatedAt = @now
         WHERE responsibilityId = @rid AND sourceKind = @kind AND day = @day AND proposed < @cap`,
        params
    );
    if (taken.changes === 1) {
        const row = await db.get(
            'SELECT proposed FROM assistant_proposal_counters WHERE responsibilityId = @rid AND sourceKind = @kind AND day = @day', params
        );
        return { ok: true, proposed: Number(row?.proposed || 0), cap: params.cap };
    }
    await db.run(
        `UPDATE assistant_proposal_counters SET coalesced = coalesced + 1, updatedAt = @now
         WHERE responsibilityId = @rid AND sourceKind = @kind AND day = @day`,
        params
    );
    const row = await db.get(
        'SELECT proposed FROM assistant_proposal_counters WHERE responsibilityId = @rid AND sourceKind = @kind AND day = @day', params
    );
    return { ok: false, proposed: Number(row?.proposed || 0), cap: params.cap };
}

/**
 * Today's counts for one responsibility, for its owner's page.
 * @returns {Promise<Array<{ sourceKind: string, proposed: number, coalesced: number, cap: number }>>}
 */
async function today({ responsibilityId, now = new Date() }) {
    const rows = await db.all(
        `SELECT sourceKind, proposed, coalesced FROM assistant_proposal_counters
         WHERE responsibilityId = @rid AND day = @day ORDER BY sourceKind`,
        { rid: Number(responsibilityId), day: dayOf(now) }
    );
    return rows.map(row => ({
        sourceKind: row.sourceKind, proposed: Number(row.proposed), coalesced: Number(row.coalesced), cap: DEFAULT_MAX_PER_DAY
    }));
}

/** Retention: counters older than `days`. */
async function prune({ days = RETENTION_DAYS, now = new Date() } = {}) {
    const cutoff = dayOf(new Date(now.getTime() - days * 86400000));
    return (await db.run('DELETE FROM assistant_proposal_counters WHERE day < @cutoff', { cutoff })).changes || 0;
}

module.exports = { DEFAULT_MAX_PER_DAY, RETENTION_DAYS, take, today, prune };
