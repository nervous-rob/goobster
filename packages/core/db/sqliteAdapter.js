/**
 * SQLite adapter (better-sqlite3, WAL mode) behind the async db facade.
 *
 * The default engine: zero external dependencies, ideal for the single
 * process "lite" install. Everything is synchronous underneath - a call
 * with no transaction in flight executes before its promise is returned,
 * so ordering is exactly what it was when the facade was sync.
 */

const path = require('node:path');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const Database = require('better-sqlite3');
const { COLUMN_MIGRATIONS, POST_MIGRATION_STATEMENTS } = require('./migrations');

const DEFAULT_DB_PATH = path.join(require('../runtimePaths').dataDir, 'goobster.sqlite');

let db = null;
let vecLoaded = false;

const txContext = new AsyncLocalStorage();

/** Resolves when the currently-active transaction finishes; null when idle. */
let activeTx = null;

/**
 * Open (or return the already-open) database.
 * Creates the data directory, applies the schema, and enables WAL + FKs.
 * @returns {Database}
 */
function getDb() {
    if (db) return db;

    const dbPath = process.env.GOOBSTER_DB_PATH || DEFAULT_DB_PATH;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 10000');

    // sqlite-vec (vector similarity extension) is optional: prebuilts cover
    // linux/darwin/windows x64 + arm64. When unavailable, memory recall
    // falls back to the brute-force scan in services/memoryService.js.
    try {
        require('sqlite-vec').load(db);
        vecLoaded = true;
    } catch (error) {
        vecLoaded = false;
        console.warn('[DB] sqlite-vec extension unavailable - memory recall will use brute-force scan:', error.message);
    }

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    db.exec(schema);
    applyColumnMigrations(db);

    return db;
}

/**
 * Whether the sqlite-vec extension is loaded on the current connection.
 * @returns {boolean}
 */
function vecAvailable() {
    getDb();
    return vecLoaded;
}

/** Minimal migration support (shared list in ./migrations.js). */
function applyColumnMigrations(database) {
    for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
        const columns = database.pragma(`table_info(${table})`);
        if (!columns.some(c => c.name === column)) {
            database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
            console.log(`[DB] Migrated: added ${table}.${column}`);
        }
    }

    // option_trades gained write-side actions (SELL_TO_OPEN/BUY_TO_CLOSE/ASSIGN).
    // The action CHECK is baked into the table DDL, so pre-existing databases
    // need a one-time rebuild (SQLite cannot alter a CHECK in place).
    const optionTradesDdl = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'option_trades'")
        .get();
    if (optionTradesDdl && !optionTradesDdl.sql.includes('SELL_TO_OPEN')) {
        database.exec(`
            ALTER TABLE option_trades RENAME TO option_trades_legacy;
            CREATE TABLE option_trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guildId TEXT NOT NULL,
                userId TEXT NOT NULL,
                positionId INTEGER,
                underlying TEXT NOT NULL,
                optionType TEXT NOT NULL CHECK (optionType IN ('CALL', 'PUT')),
                strike REAL NOT NULL CHECK (strike > 0),
                expiry TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('BUY_TO_OPEN', 'SELL_TO_CLOSE', 'SELL_TO_OPEN', 'BUY_TO_CLOSE', 'EXPIRE', 'EXERCISE', 'ASSIGN')),
                contracts INTEGER NOT NULL CHECK (contracts > 0),
                premium REAL NOT NULL CHECK (premium >= 0),
                underlyingPrice REAL,
                iv REAL,
                points INTEGER NOT NULL DEFAULT 0,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO option_trades SELECT * FROM option_trades_legacy;
            DROP TABLE option_trades_legacy;
            CREATE INDEX IF NOT EXISTS idx_option_trades_user_time ON option_trades(guildId, userId, createdAt);
        `);
        console.log('[DB] Migrated: rebuilt option_trades with write-side actions');
    }

    for (const statement of POST_MIGRATION_STATEMENTS) {
        database.exec(statement);
    }
}

/**
 * Plain calls must not interleave into someone else's open transaction
 * (same connection - they would silently join it). Calls made from inside
 * the transaction's own async context skip the wait and join deliberately.
 * Returns null on the fast path so callers execute fully synchronously.
 * @returns {Promise<void>|null}
 */
function waitForTurn() {
    if (!activeTx || txContext.getStore()) return null;
    return (async () => { while (activeTx) await activeTx; })();
}

async function run(sql, params, normalizeParams) {
    const wait = waitForTurn();
    if (wait) await wait;
    return getDb().prepare(sql).run(normalizeParams(params));
}

async function get(sql, params, normalizeParams) {
    const wait = waitForTurn();
    if (wait) await wait;
    return getDb().prepare(sql).get(normalizeParams(params));
}

async function all(sql, params, normalizeParams) {
    const wait = waitForTurn();
    if (wait) await wait;
    return getDb().prepare(sql).all(normalizeParams(params));
}

async function insert(sql, params, normalizeParams) {
    const result = await run(sql, params, normalizeParams);
    return Number(result.lastInsertRowid);
}

/**
 * IMMEDIATE transaction with an AsyncLocalStorage context: db.* calls made
 * anywhere inside the callback's async context join the transaction; calls
 * from outside wait for the commit. Nested calls become savepoints.
 * @param {Function} fn - (tx) => result, sync or async
 * @param {Object} txApi - the facade's tx handle
 */
async function transaction(fn, txApi) {
    const database = getDb();
    const outer = txContext.getStore();

    if (outer) {
        const name = `goobster_sp_${outer.depth++}`;
        database.exec(`SAVEPOINT ${name}`);
        try {
            const result = await fn(txApi);
            database.exec(`RELEASE ${name}`);
            return result;
        } catch (error) {
            database.exec(`ROLLBACK TO ${name}`);
            database.exec(`RELEASE ${name}`);
            throw error;
        }
    }

    // Serialize whole transactions against each other. Single-threaded JS
    // makes the check-then-claim atomic (no await between them).
    while (activeTx) await activeTx;
    let finish;
    activeTx = new Promise(resolve => { finish = resolve; });

    try {
        database.exec('BEGIN IMMEDIATE');
        try {
            const result = await txContext.run({ depth: 0 }, () => fn(txApi));
            database.exec('COMMIT');
            return result;
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch { /* already rolled back */ }
            throw error;
        }
    } finally {
        activeTx = null;
        finish();
    }
}

async function closeConnection() {
    if (db) {
        db.close();
        db = null;
        vecLoaded = false;
    }
}

/**
 * SQLite is one process, so the lock cannot be contended. Always run fn.
 * @param {string} _name
 * @param {() => Promise<*>|*} fn
 * @returns {Promise<{acquired: boolean, result?: *}>}
 */
async function withAdvisoryLock(_name, fn) {
    return { acquired: true, result: await fn() };
}

module.exports = {
    engine: 'sqlite',
    getDb,
    vecAvailable,
    run,
    get,
    all,
    insert,
    transaction,
    closeConnection,
    withAdvisoryLock,
};
