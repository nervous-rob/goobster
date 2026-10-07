/**
 * The `init-db` step's database open, in a child process
 * (./dbInitChild.js). SQLite: `<data>/goobster.sqlite` is created and the
 * schema applied. Postgres: the schema is applied to the database
 * `GOOBSTER_DB_URL` names - which the engine only ever opens, never creates,
 * drops or deletes. Nothing is printed beyond the engine and a table count.
 */

const path = require('node:path');
const childProcess = require('node:child_process');
const { ManagerError } = require('../errors');

const CHILD = path.join(__dirname, 'dbInitChild.js');
const TIMEOUT_MS = 120_000;

function sqlitePathOf(roots, settings) {
    return roots.data === settings.dataDir ? settings.sqlitePath : path.join(roots.data, 'goobster.sqlite');
}

/**
 * @param {{ roots: Object, settings: Object, database: { engine: string } }} params
 * @returns {Promise<{ engine: string, tables: number }>}
 */
function initDatabase({ roots, settings, database, execFile = childProcess.execFile }) {
    const env = { ...process.env, GOOBSTER_DATA_DIR: roots.data, GOOBSTER_WORKSPACE_ROOT: roots.code };
    if (database.engine === 'sqlite') {
        delete env.GOOBSTER_DB_URL;
        env.GOOBSTER_DB_PATH = sqlitePathOf(roots, settings);
    } else {
        env.GOOBSTER_DB_URL = settings.dbUrl;
        delete env.GOOBSTER_DB_PATH;
    }
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [CHILD], { env, timeout: TIMEOUT_MS, maxBuffer: 1 << 16 }, (error, stdout) => {
            let parsed = null;
            try {
                parsed = JSON.parse(String(stdout).trim().split('\n').pop());
            } catch { }
            if (!error && parsed && parsed.ok) {
                resolve({ engine: parsed.engine, tables: parsed.tables });
                return;
            }
            reject(new ManagerError(500, 'DB_INIT_FAILED', 'The application database could not be opened or its schema applied.', { engine: database.engine, cause: parsed && parsed.code ? parsed.code : null }));
        });
    });
}

module.exports = { initDatabase, sqlitePathOf };
