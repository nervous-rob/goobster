/**
 * What `GET /manager/api/migrate/status` and `migrate status` show: the
 * migration's durable state (./state.js) turned into a sanitized view, with
 * the copy's per-table progress and the rollback boundary. It reads the
 * manager store only; it never opens a database and never carries a URL, a
 * password, a passphrase, a path or a row.
 */

const nodeFs = require('node:fs');
const { createMigrationState, STEPS } = require('./state');
const { ROLLBACK_LIMIT } = require('@goobster/core/db/migration');

const STEP_FIELDS = Object.freeze(['at', 'done', 'tables', 'rows', 'verified', 'configIncluded', 'files', 'resumed', 'recopied', 'extensionsCreated', 'ok']);

function pick(source, keys) {
    const out = {};
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') out[key] = value;
        else if (Array.isArray(value) && value.every(item => typeof item === 'string')) out[key] = value.slice(0, 16);
    }
    return out;
}

function progressOf(raw) {
    if (!raw || !raw.tables || !Array.isArray(raw.order)) return null;
    const entries = Object.entries(raw.tables);
    const done = entries.filter(([, item]) => item.state === 'done');
    const copying = entries.find(([, item]) => item.state === 'copying');
    return {
        tablesDone: done.length,
        tablesTotal: raw.order.length,
        rowsCopied: done.reduce((sum, [, item]) => sum + (Number(item.rows) || 0), 0),
        current: copying ? copying[0] : null
    };
}

/**
 * @returns {Object} { state, rollback, rollbackLimit, ... }; `state` is 'none' when no migration was ever started
 */
function migrationStatus({ settings, fs = nodeFs, now = () => new Date() }) {
    const store = createMigrationState({ storeDir: settings.storeDir, fs, now });
    const { doc, problem } = store.read();
    const base = { rollbackLimit: ROLLBACK_LIMIT };
    if (problem) return { ...base, state: 'unreadable', problem, rollback: { possible: false, reason: 'STATE_UNREADABLE' } };
    if (!doc) return { ...base, state: 'none', rollback: { possible: false, reason: 'NO_MIGRATION' } };
    const writes = store.acceptedWrites(doc);
    let rollback;
    if (doc.status === 'rolled-back') rollback = { possible: false, reason: 'ALREADY_ROLLED_BACK' };
    else if (writes) rollback = { possible: false, reason: 'POSTGRES_HAS_WRITES', boundary: 'passed', acceptedWritesAt: writes.at };
    else if (doc.status === 'switched') rollback = { possible: true, boundary: 'before-first-postgres-write' };
    else rollback = { possible: Boolean(doc.steps && doc.steps.provision), boundary: 'before-cutover' };
    const steps = {};
    for (const name of STEPS) {
        if (doc.steps && doc.steps[name]) steps[name] = pick(doc.steps[name], STEP_FIELDS);
    }
    return {
        ...base,
        state: doc.status,
        id: doc.id,
        startedAt: doc.startedAt || null,
        updatedAt: doc.updatedAt || null,
        target: doc.target || null,
        steps,
        failure: doc.failure || null,
        progress: progressOf(store.readProgress()),
        maintenance: doc.maintenance ? { operationId: doc.maintenance.operationId, fence: doc.maintenance.fence, enteredByMigration: doc.maintenance.entered === true } : null,
        result: doc.result || null,
        postgresAcceptedWritesAt: writes ? writes.at : null,
        rollback
    };
}

module.exports = { migrationStatus, progressOf };
