/**
 * Compare-and-set approval executor.
 *
 * The Missions race (two confirms launching the same work twice) is the
 * pattern: claim PENDING → EXECUTING, do the side effect, then write a
 * durable receipt. A second click loses the claim and does not execute.
 *
 * Only the two approval tables are allowed — table names are interpolated
 * into SQL, so the allowlist is the injection guard.
 */

const ALLOWED_TABLES = new Set([
    'pending_integration_actions',
    'sandbox_requests'
]);

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
         SET status = 'EXECUTING', resolvedBy = @resolvedBy
         WHERE id = @id AND status = 'PENDING'
         RETURNING *`,
        { id, resolvedBy }
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
                 error = @error, resultJson = @resultJson
             WHERE id = @id AND status = 'EXECUTING'
             RETURNING *`,
            { id, status, resolvedBy, error, resultJson }
        );
    }
    return db.get(
        `UPDATE pending_integration_actions
         SET status = @status, resolvedAt = datetime('now'), resolvedBy = @resolvedBy,
             resultJson = @resultJson
         WHERE id = @id AND status = 'EXECUTING'
         RETURNING *`,
        { id, status, resolvedBy, resultJson }
    );
}

/**
 * Return a failed claim to PENDING so a fixable error can be retried.
 * @returns {Promise<{changes: number}>}
 */
async function releaseClaim(db, { table, id }) {
    assertTable(table);
    return db.run(
        `UPDATE ${table}
         SET status = 'PENDING', resolvedBy = NULL
         WHERE id = @id AND status = 'EXECUTING'`,
        { id }
    );
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
    claimPending,
    finishClaim,
    releaseClaim,
    resolveFromPending
};
