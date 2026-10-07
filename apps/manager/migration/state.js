/**
 * The migration's durable state in the manager store
 * (documentation/db_migration.md):
 *
 *   <store>/migration.json            the operation's record: status, the
 *                                     step that last finished, the sanitised
 *                                     target, what the operation created on
 *                                     the target, the rollback boundary.
 *                                     Written by the manager.
 *   <store>/migration.progress.json   the copy's per-table progress. Written
 *                                     by the copy child itself, before and
 *                                     after every table.
 *
 * Neither holds a URL, a password, a passphrase, a path to user content or a
 * row: host/port/database/user/schema, fingerprints, counts, table and
 * extension names and codes.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const files = require('../store/files');
const { createMaintenanceStore } = require('../maintenance/store');

const STATE_FILE = 'migration.json';
const PROGRESS_FILE = 'migration.progress.json';
const STATE_VERSION = 1;
const STATUSES = Object.freeze(['running', 'failed', 'switched', 'rolled-back']);
const STEPS = Object.freeze(['backup', 'snapshot', 'provision', 'copy', 'verify', 'validate', 'cutover']);

function createMigrationState({ storeDir, fs = nodeFs, now = () => new Date() }) {
    const file = path.join(storeDir, STATE_FILE);
    const progressFile = path.join(storeDir, PROGRESS_FILE);

    /** @returns {{ doc: Object|null, problem: string|null }} */
    function read() {
        const result = files.readJson(file, fs);
        if (!result.exists) return { doc: null, problem: null };
        if (result.problem) return { doc: null, problem: result.problem };
        const doc = result.value;
        if (!files.isPlainObject(doc) || doc.version !== STATE_VERSION || !STATUSES.includes(doc.status) || typeof doc.id !== 'string') {
            return { doc: null, problem: 'INVALID' };
        }
        return { doc, problem: null };
    }

    function write(doc) {
        files.ensureDir(storeDir, fs);
        const next = { ...doc, version: STATE_VERSION, updatedAt: now().toISOString() };
        files.writeJsonAtomic(file, next, fs);
        return next;
    }

    function update(change) {
        const { doc } = read();
        if (!doc) return null;
        const next = change(JSON.parse(JSON.stringify(doc)));
        return next ? write(next) : doc;
    }

    function readProgress() {
        const result = files.readJson(progressFile, fs);
        return result.exists && !result.problem && files.isPlainObject(result.value) ? result.value : null;
    }

    function clear() {
        files.removeIfPresent(file, fs);
        files.removeIfPresent(progressFile, fs);
    }

    /**
     * When Postgres could first have accepted a write: recorded by a worker
     * start (the supervisor hook) or, failing that, derived from the barrier
     * having been released after the cutover - the workers resume on
     * Postgres at that moment.
     * @returns {{ at: string, source: 'worker-start'|'barrier-release' }|null}
     */
    function acceptedWrites(doc) {
        if (!doc || doc.status !== 'switched') return null;
        if (doc.postgresAcceptedWritesAt) return { at: doc.postgresAcceptedWritesAt, source: doc.postgresWritesSource || 'worker-start' };
        const maintenance = createMaintenanceStore({ storeDir, fs, now }).read();
        if (maintenance.problem || !maintenance.doc) return null;
        const last = maintenance.doc.lastOutcome;
        if (!maintenance.doc.active && last && last.operationId === doc.maintenance?.operationId && ['completed', 'abandoned'].includes(last.outcome)) {
            return { at: last.at, source: 'barrier-release' };
        }
        return null;
    }

    return { file, progressFile, read, write, update, readProgress, clear, acceptedWrites };
}

/**
 * The supervisor's hook: a worker is being started. When the installation
 * was switched to Postgres and the barrier is not up, this is the first
 * moment Postgres can accept a write; record it once. Never throws.
 */
function noteWorkerStart({ storeDir, fs = nodeFs, now = () => new Date() }) {
    try {
        const state = createMigrationState({ storeDir, fs, now });
        const { doc } = state.read();
        if (!doc || doc.status !== 'switched' || doc.postgresAcceptedWritesAt) return false;
        const maintenance = createMaintenanceStore({ storeDir, fs, now }).read();
        if (maintenance.problem || maintenance.doc.active) return false;
        state.update(next => ({ ...next, postgresAcceptedWritesAt: now().toISOString(), postgresWritesSource: 'worker-start' }));
        return true;
    } catch {
        return false;
    }
}

module.exports = { createMigrationState, noteWorkerStart, STATE_FILE, PROGRESS_FILE, STATUSES, STEPS };
