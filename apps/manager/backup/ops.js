/**
 * The operations of backup and restore that open the application database
 * or write its files (documentation/backup_and_restore.md). The manager
 * never opens the application database, so each one runs in a helper
 * process (./childEntry.js), one operation per process; the same table is
 * what tests call in process.
 *
 * Every operation is a thin call into `backupService`, the one
 * implementation of backup and restore (`scripts/backup.js` and
 * `scripts/restore.js` use the same functions). Results carry names,
 * counts, booleans and the operator's own paths - never a passphrase, a
 * decrypted config.json or a row. An error carries a short code only.
 */

const path = require('node:path');
const fs = require('node:fs');

const QUIET = Object.freeze({ info() { }, warn() { }, error() { } });

function service() {
    return require('@goobster/core/services/backupService');
}

function facade() {
    return require('@goobster/core/db');
}

function archive() {
    return require('@goobster/core/services/backupArchive');
}

let inProcessRuns = 0;

/**
 * A helper process drops its connection before it exits. Run in process (a
 * test), a Postgres pool is the caller's own and stays: closing it would
 * make an isolated test schema vanish.
 */
async function releaseConnection() {
    const db = facade();
    if (inProcessRuns > 0 && db.engine === 'postgres') return;
    await db.closeConnection();
}

/** Row counts of a SQLite file opened read-only: no schema is applied, nothing is created. */
function probeSqlite(sqlitePath) {
    if (!fs.existsSync(sqlitePath) || fs.statSync(sqlitePath).size === 0) {
        return { engine: 'sqlite', exists: false, tables: 0, rows: 0, hasData: false };
    }
    const Database = require('better-sqlite3');
    const handle = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
        const exempt = archive().COUNT_EXEMPT;
        const names = handle.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_vec_%' ORDER BY name`).all().map(row => row.name);
        let rows = 0;
        for (const name of names) {
            if (exempt.has(name)) continue;
            try {
                rows += Number(handle.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get().c) || 0;
            } catch {
                // A virtual table the plain driver cannot read is derived, not data.
            }
        }
        return { engine: 'sqlite', exists: true, tables: names.length, rows, hasData: rows > 0 };
    } finally {
        handle.close();
    }
}

const OPS = {
    /** Whether the target holds anything worth a safety backup. */
    async probeTarget({ engine, sqlitePath }) {
        if (engine === 'sqlite') return probeSqlite(sqlitePath);
        const backupService = service();
        const counts = await backupService.tableCounts();
        const exempt = backupService.COUNT_EXEMPT;
        const rows = Object.entries(counts).filter(([name]) => !exempt.has(name)).reduce((sum, [, n]) => sum + n, 0);
        await releaseConnection();
        return { engine: 'postgres', exists: true, tables: Object.keys(counts).length, rows, hasData: rows > 0 };
    },

    /** Write an archive and verify it against the live counts. */
    async backup({ destDir, passphrase = null, includeConfig = true, quiesced = null, compareLive = true }) {
        const backupService = service();
        const runtimePaths = require('@goobster/core/runtimePaths');
        const { dir, manifest } = await backupService.createBackup({
            destDir,
            passphrase,
            includeConfig,
            quiesced,
            dataDir: runtimePaths.dataDir,
            configPath: runtimePaths.configJsonPath,
            logger: QUIET
        });
        const counts = await backupService.tableCounts();
        let problems = [];
        try {
            backupService.verifyBackup(dir, compareLive ? { expectCounts: counts } : {});
        } catch (error) {
            if (!error || error.code !== 'UNVERIFIED') throw error;
            problems = Array.isArray(error.problems) ? error.problems : ['UNVERIFIED'];
        }
        await releaseConnection();
        const exempt = backupService.COUNT_EXEMPT;
        const counted = Object.entries(counts).filter(([name]) => !exempt.has(name));
        return {
            dir,
            archive: path.basename(dir),
            engine: manifest.engine,
            verified: problems.length === 0,
            comparedWithLiveCounts: compareLive,
            fingerprintMatches: !problems.includes('FINGERPRINT_MISMATCH'),
            mismatchedTables: problems.filter(code => code.startsWith('COUNT_MISMATCH:')).slice(0, 20).map(code => code.slice('COUNT_MISMATCH:'.length)),
            problems: problems.filter(code => !code.startsWith('COUNT_MISMATCH:')).slice(0, 20),
            tables: counted.length,
            rows: counted.reduce((sum, [, n]) => sum + n, 0),
            fileSets: (manifest.files || []).map(set => ({ id: set.id, label: set.label, files: set.files, bytes: set.bytes })),
            files: (manifest.files || []).reduce((sum, set) => sum + (set.files || 0), 0),
            configIncluded: Boolean(manifest.config && manifest.config.included),
            envSecretsOmitted: (manifest.envSecrets && manifest.envSecrets.present) || [],
            createdAt: manifest.createdAt
        };
    },

    async restoreDatabase({ dir, schemaChanged = false, hadData = false, tag }) {
        const backupService = service();
        const manifest = backupService.inspectBackup(dir);
        const out = await backupService.restoreDatabase({ dir, manifest, schemaChanged, hadData, tag, logger: QUIET });
        await releaseConnection();
        return { setAside: out.setAside, engine: manifest.engine };
    },

    async restoreFiles({ dir, only = null, tag }) {
        const backupService = service();
        const runtimePaths = require('@goobster/core/runtimePaths');
        const manifest = backupService.inspectBackup(dir);
        const out = backupService.restoreFileSets({ dir, manifest, dataDir: runtimePaths.dataDir, env: process.env, tag, only, logger: QUIET });
        return {
            files: out.files.map(set => ({ id: set.id, label: set.label, files: set.files })),
            setAside: out.setAside,
            skipped: out.skipped
        };
    },

    async restoreConfig({ dir, passphrase = null, withConfig = true, tag }) {
        const backupService = service();
        const runtimePaths = require('@goobster/core/runtimePaths');
        const manifest = backupService.inspectBackup(dir);
        const out = backupService.restoreConfig({ dir, manifest, passphrase, withConfig, configPath: runtimePaths.configJsonPath, tag, logger: QUIET });
        return { restored: out.restored, skipped: out.skipped, setAside: out.setAside };
    },

    /** Open the restored database, fail in-flight work, pause, record, compare counts. */
    async finish({ dir, schemaChanged = false, configRestored = false, by = 'manager backup.restore' }) {
        const backupService = service();
        const manifest = backupService.inspectBackup(dir);
        const out = await backupService.finishRestore({ dir, manifest, schemaChanged, configRestored, by });
        await releaseConnection();
        return {
            interrupted: out.interrupted,
            tables: Object.keys(out.counts.actual).length,
            mismatches: out.counts.mismatches.slice(0, 20).map(item => item.table),
            mismatchCount: out.counts.mismatches.length
        };
    }
};

/**
 * Run an operation in this process, the way the helper would: an error
 * becomes its code. Tests use it as the manager's `runChild` seam (a helper
 * process does not inherit the isolated Postgres schema a test runs in).
 */
function createInProcessRunner() {
    return async function run(op, request = {}) {
        const handler = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
        if (!handler) throw Object.assign(new Error('op'), { code: 'UNKNOWN_OP' });
        inProcessRuns += 1;
        try {
            return await handler(request);
        } catch (error) {
            const { ManagerError } = require('../errors');
            const code = error && typeof error.code === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(error.code) ? error.code : 'CHILD_FAILED';
            throw new ManagerError(409, code, `The ${op} helper failed.`, { helper: op });
        } finally {
            inProcessRuns -= 1;
        }
    };
}

module.exports = { OPS, createInProcessRunner };
