/**
 * Compare-and-set approval executor.
 *
 * The Missions race (two confirms launching the same work twice) is the
 * pattern: claim PENDING → EXECUTING, do the side effect, then write a
 * durable receipt. A second click loses the claim and does not execute.
 *
 * After the side effect, never return the row to PENDING. Persist the
 * receipt first; a crash between receipt and terminal status is recovered
 * by finishing the stored result, not by re-running the action.
 *
 * Only the two approval tables are allowed — table names are interpolated
 * into SQL, so the allowlist is the injection guard.
 */

const crypto = require('node:crypto');
const { toUtcText } = require('./executionLease');

const ALLOWED_TABLES = new Set([
    'pending_integration_actions',
    'sandbox_requests'
]);

const STALE_EXECUTING_MS = 15 * 60 * 1000;

function assertTable(table) {
    if (!ALLOWED_TABLES.has(String(table))) {
        throw new Error(`approvalExecutor: unknown table ${table}`);
    }
}

/**
 * Atomically consume a PENDING row. Returns the claimed row, or null
 * when another worker already took it.
 * @returns {Promise<object|null>}
 */
async function claimPending(db, { table, id, resolvedBy = null }) {
    assertTable(table);
    return db.get(
        `UPDATE ${table}
         SET status = 'EXECUTING', resolvedBy = @resolvedBy,
             attemptId = @attemptId, claimedAt = datetime('now')
         WHERE id = @id AND status = 'PENDING'
         RETURNING *`,
        { id, resolvedBy, attemptId: crypto.randomUUID() }
    );
}

/**
 * Write the side-effect receipt while the row is still EXECUTING.
 * No-op when a receipt already exists (the attempt already happened).
 * @returns {Promise<object|null>}
 */
async function persistReceipt(db, { table, id, resultJson }) {
    assertTable(table);
    return db.get(
        `UPDATE ${table}
         SET resultJson = @resultJson
         WHERE id = @id AND status = 'EXECUTING' AND resultJson IS NULL
         RETURNING *`,
        { id, resultJson }
    );
}

/**
 * Record the durable result of a claimed row. No-op (returns null) if
 * the row is no longer EXECUTING — the claim was lost or already finished.
 * @returns {Promise<object|null>}
 */
async function finishClaim(db, {
    table, id, status, resolvedBy, error = null, resultJson = null
}) {
    assertTable(table);
    if (table === 'sandbox_requests') {
        return db.get(
            `UPDATE sandbox_requests
             SET status = @status, resolvedAt = datetime('now'), resolvedBy = @resolvedBy,
                 error = @error, resultJson = COALESCE(@resultJson, resultJson)
             WHERE id = @id AND status = 'EXECUTING'
             RETURNING *`,
            { id, status, resolvedBy, error, resultJson }
        );
    }
    return db.get(
        `UPDATE pending_integration_actions
         SET status = @status, resolvedAt = datetime('now'), resolvedBy = @resolvedBy,
             resultJson = COALESCE(@resultJson, resultJson)
         WHERE id = @id AND status = 'EXECUTING'
         RETURNING *`,
        { id, status, resolvedBy, resultJson }
    );
}

/**
 * Return a failed claim to PENDING so a fixable error can be retried.
 * Refused once a receipt exists — that means the side effect happened.
 * @returns {Promise<{changes: number}>}
 */
async function releaseClaim(db, { table, id }) {
    assertTable(table);
    return db.run(
        `UPDATE ${table}
         SET status = 'PENDING', resolvedBy = NULL, attemptId = NULL, claimedAt = NULL
         WHERE id = @id AND status = 'EXECUTING' AND resultJson IS NULL`,
        { id }
    );
}

/**
 * Finish an EXECUTING row that already has a receipt (crash after the
 * side effect, before the terminal write). Does not re-execute.
 * @returns {Promise<object|null>}
 */
async function finishStoredReceipt(db, { table, id, status, resolvedBy = null }) {
    assertTable(table);
    const row = await db.get(
        `SELECT * FROM ${table} WHERE id = @id AND status = 'EXECUTING' AND resultJson IS NOT NULL`,
        { id }
    );
    if (!row) return null;
    return finishClaim(db, {
        table, id, status, resolvedBy: resolvedBy || row.resolvedBy,
        resultJson: row.resultJson
    });
}

/**
 * Recover EXECUTING rows: finish those with a receipt; expire/fail
 * receipt-less claims older than `staleMs`. Never returns them to PENDING.
 * @returns {Promise<{finished: number, expired: number}>}
 */
async function recoverStuckApprovals(db, { staleMs = STALE_EXECUTING_MS } = {}) {
    const cutoff = toUtcText(Date.now() - staleMs);
    let finished = 0;
    let expired = 0;

    const withReceipt = await db.all(
        `SELECT id, 'pending_integration_actions' AS tbl FROM pending_integration_actions
         WHERE status = 'EXECUTING' AND resultJson IS NOT NULL
         UNION ALL
         SELECT id, 'sandbox_requests' AS tbl FROM sandbox_requests
         WHERE status = 'EXECUTING' AND resultJson IS NOT NULL`
    );
    for (const row of withReceipt) {
        const status = row.tbl === 'sandbox_requests' ? 'COMPLETED' : 'CONFIRMED';
        const out = await finishStoredReceipt(db, { table: row.tbl, id: row.id, status });
        if (out) finished += 1;
    }

    const staleIntegrations = await db.run(
        `UPDATE pending_integration_actions
         SET status = 'EXPIRED', resolvedAt = datetime('now')
         WHERE status = 'EXECUTING' AND resultJson IS NULL
           AND claimedAt IS NOT NULL AND claimedAt < @cutoff`,
        { cutoff }
    );
    expired += staleIntegrations.changes || 0;

    const staleSandbox = await db.run(
        `UPDATE sandbox_requests
         SET status = 'FAILED', resolvedAt = datetime('now'),
             error = 'Claim interrupted before a receipt was written.'
         WHERE status = 'EXECUTING' AND resultJson IS NULL
           AND claimedAt IS NOT NULL AND claimedAt < @cutoff`,
        { cutoff }
    );
    expired += staleSandbox.changes || 0;

    return { finished, expired };
}

/**
 * Direct PENDING → terminal (deny / expire / cancel) without executing.
 * @returns {Promise<object|null>}
 */
async function resolveFromPending(db, {
    table, id, status, resolvedBy = null, error = null
}) {
    assertTable(table);
    if (table === 'sandbox_requests') {
        return db.get(
            `UPDATE sandbox_requests
             SET status = @status, resolvedAt = datetime('now'),
                 resolvedBy = @resolvedBy, error = @error
             WHERE id = @id AND status = 'PENDING'
             RETURNING *`,
            { id, status, resolvedBy, error }
        );
    }
    return db.get(
        `UPDATE pending_integration_actions
         SET status = @status, resolvedAt = datetime('now'), resolvedBy = @resolvedBy
         WHERE id = @id AND status = 'PENDING'
         RETURNING *`,
        { id, status, resolvedBy }
    );
}

module.exports = {
    ALLOWED_TABLES,
    STALE_EXECUTING_MS,
    claimPending,
    persistReceipt,
    finishClaim,
    releaseClaim,
    finishStoredReceipt,
    recoverStuckApprovals,
    resolveFromPending
};
