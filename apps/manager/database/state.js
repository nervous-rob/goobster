/**
 * What the database operations need to know about the installation without
 * opening its database in the manager's process: whether the SQLite file
 * holds anything beyond bookkeeping (`sqliteState`), where the connection in
 * effect comes from, and the status view the routes and the CLI show.
 *
 * "Empty" means: no row in any table except the ones the application and the
 * manager fill by themselves (`BOOKKEEPING`: the seeded self-knowledge corpus
 * and the operator audit log). Everything else - a user, a memory, a message,
 * a setting - makes the file nonempty, and the only way from a nonempty SQLite
 * file to Postgres is the migration (documentation/db_migration.md).
 */

const path = require('node:path');
const nodeFs = require('node:fs');
const childProcess = require('node:child_process');
const environment = require('../environment');
const { lazy } = require('../lazy');
const { createMigrationState } = require('../migration/state');

const connectionLib = lazy('@goobster/core/db/connection');

const CHILD = path.join(__dirname, 'sqliteChild.js');
const TIMEOUT_MS = 30_000;
const BOOKKEEPING = Object.freeze(['self_docs', 'operator_audit']);

/** @returns {Promise<{ present: boolean, readable: boolean, tables: Array<{ name: string, rows: number }>, code?: string }>} */
function readSqlite({ sqlitePath, execFile = childProcess.execFile }) {
    const env = { ...process.env, GOOBSTER_DB_PATH: sqlitePath };
    delete env.GOOBSTER_DB_URL;
    delete env.GOOBSTER_PG_TEST_ISOLATE;
    return new Promise((resolve) => {
        execFile(process.execPath, [CHILD], { env, timeout: TIMEOUT_MS, maxBuffer: 1 << 18 }, (error, stdout) => {
            try {
                const parsed = JSON.parse(String(stdout).trim().split('\n').pop());
                if (parsed && typeof parsed === 'object') {
                    resolve(parsed);
                    return;
                }
            } catch { }
            resolve({ present: true, readable: false, tables: [], code: 'SOURCE_UNREADABLE' });
        });
    });
}

/** Names and counts: whether the file is empty and what makes it not. */
function classifySqlite(report) {
    if (!report.present) return { present: false, readable: true, empty: true, tables: 0, rows: 0, bookkeepingRows: 0, populated: [] };
    if (!report.readable) return { present: true, readable: false, empty: false, tables: 0, rows: 0, bookkeepingRows: 0, populated: [], code: report.code || 'SOURCE_UNREADABLE' };
    const tables = report.tables || [];
    const populated = tables.filter(item => item.rows > 0 && !BOOKKEEPING.includes(item.name));
    return {
        present: true,
        readable: true,
        empty: populated.length === 0,
        tables: tables.length,
        rows: tables.reduce((sum, item) => sum + item.rows, 0),
        bookkeepingRows: tables.filter(item => BOOKKEEPING.includes(item.name)).reduce((sum, item) => sum + item.rows, 0),
        populated: populated.slice(0, 10).map(item => item.name)
    };
}

async function sqliteState({ settings, deps = {} }) {
    const read = deps.readSqlite || readSqlite;
    return classifySqlite(await read({ sqlitePath: settings.sqlitePath }));
}

/** The connection the workers use: the process environment, the manager overlay, or none (SQLite). Names, never the URL. */
function connectionInEffect({ settings, fs = nodeFs }) {
    const overlay = environment.read(settings.storeDir, fs);
    const url = settings.dbUrl || null;
    let source = null;
    if (url) source = settings.environment && settings.environment.overridden && settings.environment.overridden.includes('GOOBSTER_DB_URL') ? 'environment' : (overlay.values.GOOBSTER_DB_URL === url ? 'overlay' : 'environment');
    let target = null;
    if (url) {
        try {
            target = connectionLib.describeUrl(url);
        } catch {
            target = null;
        }
    }
    return { url, source, target, overlayPresent: Boolean(overlay.values.GOOBSTER_DB_URL), overlayProblem: overlay.problem };
}

/**
 * The status view: no secret, no URL, no path. `mismatch` is true when the
 * installation record and the connection in effect disagree (a connect that
 * wrote the overlay and was interrupted before it updated the record, or an
 * environment variable that overrides the overlay).
 */
async function databaseStatus({ settings, fs = nodeFs, doc = null, deps = {}, barrier = null }) {
    const effective = connectionInEffect({ settings, fs });
    const engine = effective.url ? 'postgres' : 'sqlite';
    const recorded = doc && doc.database ? doc.database.engine : null;
    const layout = doc ? doc.layout : null;
    const sqlite = engine === 'sqlite' ? await sqliteState({ settings, deps }) : null;
    const migration = createMigrationState({ storeDir: settings.storeDir, fs }).read();
    return {
        engine,
        record: doc ? { engine: recorded, external: doc.database ? doc.database.external : null } : null,
        mismatch: Boolean(recorded && recorded !== engine),
        layout,
        pairedRefusesSqlite: layout === 'paired' && engine === 'sqlite',
        connection: effective.target ? { ...effective.target, source: effective.source } : null,
        overlay: { present: effective.overlayPresent, problem: effective.overlayProblem },
        overridden: Boolean(settings.environment && settings.environment.overridden && settings.environment.overridden.includes('GOOBSTER_DB_URL')),
        sqlite,
        migration: { state: migration.doc ? migration.doc.status : (migration.problem ? 'unreadable' : 'none') },
        maintenance: barrier ? { active: Boolean(barrier.active), phase: barrier.phase || null, stale: Boolean(barrier.stale) } : null,
        managed: Boolean(doc),
        storage: { owner: engine === 'postgres' ? 'external' : 'installation', external: engine === 'postgres' }
    };
}

module.exports = { BOOKKEEPING, readSqlite, classifySqlite, sqliteState, connectionInEffect, databaseStatus };
