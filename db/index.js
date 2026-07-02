/**
 * Local SQLite database layer (Raspberry Pi edition).
 *
 * Replaces the previous Azure SQL (mssql) connection pool with an embedded
 * better-sqlite3 database. better-sqlite3 is synchronous and extremely fast
 * for a single-process bot; WAL mode allows concurrent reads while writing.
 *
 * API:
 *   getDb()                 -> the raw better-sqlite3 Database (lazy singleton)
 *   run(sql, params)        -> { changes, lastInsertRowid }
 *   get(sql, params)        -> first row or undefined
 *   all(sql, params)        -> array of rows
 *   transaction(fn)         -> runs fn inside an IMMEDIATE transaction
 *   closeConnection()       -> closes the database (for shutdown)
 *
 * Named parameters use the better-sqlite3 '@name' style:
 *   run('INSERT INTO users (username) VALUES (@username)', { username: 'x' })
 *
 * Values are normalized automatically: booleans -> 0/1, Date -> UTC ISO text,
 * plain objects/arrays -> JSON text.
 */

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'goobster.sqlite');

let db = null;

/**
 * Normalize a JS value into something SQLite can bind.
 * @param {*} value
 * @returns {string|number|bigint|Buffer|null}
 */
function normalizeValue(value) {
    if (value === undefined) return null;
    if (value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    if (typeof value === 'object' && !Buffer.isBuffer(value)) return JSON.stringify(value);
    return value;
}

/**
 * Normalize a params object for binding.
 * @param {Object} params
 * @returns {Object}
 */
function normalizeParams(params = {}) {
    const out = {};
    for (const [key, value] of Object.entries(params)) {
        out[key] = normalizeValue(value);
    }
    return out;
}

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

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    db.exec(schema);
    applyColumnMigrations(db);

    return db;
}

/**
 * Minimal migration support: schema.sql only creates missing tables
 * (CREATE TABLE IF NOT EXISTS), so columns added to existing tables must be
 * back-filled here for databases created before the column existed.
 */
function applyColumnMigrations(database) {
    const ensureColumn = (table, column, ddl) => {
        const columns = database.pragma(`table_info(${table})`);
        if (!columns.some(c => c.name === column)) {
            database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
            console.log(`[DB] Migrated: added ${table}.${column}`);
        }
    };

    ensureColumn('guild_settings', 'proactive_mode',
        `proactive_mode TEXT NOT NULL DEFAULT 'DISABLED' CHECK (proactive_mode IN ('ENABLED', 'DISABLED'))`);
    ensureColumn('guild_settings', 'ai_provider', 'ai_provider TEXT');
    ensureColumn('guild_settings', 'ai_model', 'ai_model TEXT');
    ensureColumn('guild_settings', 'ai_reasoning_effort', 'ai_reasoning_effort TEXT');
}

/**
 * Execute a statement that doesn't return rows.
 * @param {string} sql
 * @param {Object} [params]
 * @returns {{changes: number, lastInsertRowid: number|bigint}}
 */
function run(sql, params = {}) {
    return getDb().prepare(sql).run(normalizeParams(params));
}

/**
 * Fetch the first row of a query.
 * @param {string} sql
 * @param {Object} [params]
 * @returns {Object|undefined}
 */
function get(sql, params = {}) {
    return getDb().prepare(sql).get(normalizeParams(params));
}

/**
 * Fetch all rows of a query.
 * @param {string} sql
 * @param {Object} [params]
 * @returns {Array<Object>}
 */
function all(sql, params = {}) {
    return getDb().prepare(sql).all(normalizeParams(params));
}

/**
 * Run a function inside an IMMEDIATE transaction. The function may call
 * run/get/all freely; everything commits together or rolls back on throw.
 * @param {Function} fn
 * @returns {*} whatever fn returns
 */
function transaction(fn) {
    return getDb().transaction(fn).immediate();
}

/**
 * Async-compatible connection getter kept so existing call sites that do
 * `await getConnection()` keep working during and after the migration.
 * @returns {Promise<Database>}
 */
async function getConnection() {
    return getDb();
}

/**
 * Close the database (used on shutdown).
 */
async function closeConnection() {
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = {
    getDb,
    run,
    get,
    all,
    transaction,
    getConnection,
    closeConnection,
    normalizeValue,
};
