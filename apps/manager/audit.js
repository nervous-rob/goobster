/**
 * Audit while the application database is down, and reconciliation once it
 * is back.
 *
 * Every applied, failed or interrupted operation appends
 * `{ action: 'manager.<kind>', actor, operationId, outcome }` to
 * `<store>/operations/audit.jsonl` (store/journal.js). `reconcileAudit()`
 * copies the pending entries into `operator_audit` through
 * `operatorAuditService.record()`, exactly once per operation: the row's
 * `target` is the operation id, an existing row for the same action and
 * target is never inserted twice, and each copied entry is stamped
 * `reconciledAt`. It runs only when the probe says the database is there
 * and reachable, so it never creates a database; a failure leaves the
 * entries pending for the next attempt.
 */

const MANAGER_AUDIT_ACTIONS = Object.freeze([
    'manager.claim',
    'manager.adopt',
    'manager.features.set',
    'manager.recovery.unlock',
    'manager.lifecycle.apply', 'manager.lifecycle.restart', 'manager.lifecycle.cancel',
    'manager.maintenance.enter', 'manager.maintenance.release'
]);

/**
 * @param {Object} params
 * @param {ReturnType<import('./store/journal').createJournal>} params.journal
 * @param {() => Promise<{ reachable: boolean|null, reason: string|null }>} params.probe
 * @param {() => Object} [params.loadDb] the async facade; default `@goobster/core/db`, required lazily
 * @param {() => Object} [params.loadAudit] default `@goobster/core/services/operatorAuditService`
 * @param {boolean} [params.closeAfter] close the facade's connection after the pass (the manager does not hold one)
 * @returns {Promise<{ pending: number, inserted: number, existing: number, deferred: boolean, reason: string|null }>}
 */
async function reconcileAudit({
    journal,
    probe,
    loadDb = () => require('@goobster/core/db'),
    loadAudit = () => require('@goobster/core/services/operatorAuditService'),
    closeAfter = false
}) {
    const { entries } = journal.readAudit();
    const pending = [];
    const seen = new Set();
    for (const entry of entries) {
        if (entry.reconciledAt || seen.has(entry.operationId)) continue;
        seen.add(entry.operationId);
        pending.push(entry);
    }
    const result = { pending: pending.length, inserted: 0, existing: 0, deferred: false, reason: null };
    if (pending.length === 0) return result;

    const reachability = await probe();
    if (reachability.reachable !== true || reachability.reason === 'SQLITE_EMPTY') {
        return { ...result, deferred: true, reason: reachability.reason || 'APP_DB_UNREACHABLE' };
    }

    const db = loadDb();
    try {
        return await ingest({ db, audit: loadAudit(), journal, pending, result });
    } finally {
        if (closeAfter && typeof db.closeConnection === 'function') {
            try { await db.closeConnection(); } catch { }
        }
    }
}

async function ingest({ db, audit, journal, pending, result }) {
    try {
        await db.get('SELECT 1 AS ok');
    } catch {
        return { ...result, deferred: true, reason: 'APP_DB_OPEN_FAILED' };
    }
    const done = [];
    for (const entry of pending) {
        if (!MANAGER_AUDIT_ACTIONS.includes(entry.action)) continue;
        let existing;
        try {
            existing = await db.get(
                'SELECT id FROM operator_audit WHERE action = @action AND target = @target LIMIT 1',
                { action: entry.action, target: entry.operationId }
            );
        } catch {
            result.deferred = true;
            result.reason = 'APP_DB_QUERY_FAILED';
            break;
        }
        if (existing) {
            result.existing++;
            done.push(entry.operationId);
            continue;
        }
        const id = await audit.record({
            action: entry.action,
            actor: entry.actor,
            target: entry.operationId,
            detail: { source: 'manager', outcome: entry.outcome, via: entry.via || null, at: entry.at, ...(entry.forced === true ? { forced: true } : {}) }
        });
        if (id == null) {
            result.deferred = true;
            result.reason = 'APP_DB_WRITE_FAILED';
            break;
        }
        result.inserted++;
        done.push(entry.operationId);
    }
    if (done.length > 0) await journal.markReconciled(done);
    return result;
}

function pendingAuditCount(journal) {
    const ids = new Set();
    for (const entry of journal.readAudit().entries) {
        if (!entry.reconciledAt) ids.add(entry.operationId);
    }
    return ids.size;
}

module.exports = { reconcileAudit, pendingAuditCount, MANAGER_AUDIT_ACTIONS };
