/**
 * The database facade (reactive port, Phases 1-2).
 *
 * Two adapters behind one async contract:
 *  - SQLite (better-sqlite3, WAL) - the default; zero external dependencies.
 *  - Postgres (pg + pgvector)    - selected by GOOBSTER_DB_URL, for split
 *    deployments and anyone who outgrows one process.
 *
 * API (all data methods return promises):
 *   engine                  -> 'sqlite' | 'postgres'
 *   run(sql, params)        -> { changes, lastInsertRowid¹ }
 *   get(sql, params)        -> first row or undefined
 *   all(sql, params)        -> array of rows
 *   insert(sql, params)     -> the new row id (engine-agnostic - use this,
 *                              not lastInsertRowid, for new code)
 *   transaction(fn)         -> runs (possibly async) fn(tx); db.* calls in
 *                              the callback's async context join the
 *                              transaction; nesting becomes savepoints
 *   getDb()                 -> raw better-sqlite3 handle (SQLite only -
 *                              guard with db.engine)
 *   rawQuery(text, values)  -> raw parameterized query (Postgres only)
 *   vecAvailable()          -> vector search available (sqlite-vec/pgvector)
 *   closeConnection()       -> close (for shutdown)
 *
 * ¹ lastInsertRowid is SQLite-only and undefined on Postgres.
 *
 * SQL is written natively for SQLite ('@name' params, datetime('now'),
 * ON CONFLICT, RETURNING); the Postgres adapter translates statements at
 * prepare time (db/dialect.js). Values are normalized automatically:
 * booleans -> 0/1, Date -> UTC text, plain objects/arrays -> JSON text.
 */

const usePostgres = () => Boolean(process.env.GOOBSTER_DB_URL);

let adapter = null;
function getAdapter() {
    if (!adapter) {
        adapter = usePostgres() ? require('./postgresAdapter') : require('./sqliteAdapter');
    }
    return adapter;
}

/**
 * Normalize a JS value into something the engine can bind.
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

async function run(sql, params = {}) {
    return getAdapter().run(sql, params, normalizeParams);
}

async function get(sql, params = {}) {
    return getAdapter().get(sql, params, normalizeParams);
}

async function all(sql, params = {}) {
    return getAdapter().all(sql, params, normalizeParams);
}

async function insert(sql, params = {}) {
    return getAdapter().insert(sql, params, normalizeParams);
}

async function transaction(fn) {
    return getAdapter().transaction(fn, txApi);
}

/** The handle passed to transaction callbacks (same functions - the async
 *  context routes them into the open transaction). */
const txApi = { get, all, run, insert };

/** Raw better-sqlite3 handle (SQLite only - guard with db.engine). */
function getDb() {
    return getAdapter().getDb();
}

/** Raw parameterized query (Postgres only - guard with db.engine). */
async function rawQuery(text, values = []) {
    const a = getAdapter();
    if (!a.rawQuery) throw new Error('rawQuery() is Postgres-only; check db.engine.');
    return a.rawQuery(text, values);
}

/**
 * LISTEN on a Postgres notification channel (Postgres only - guard with
 * db.engine). Returns a stop() function.
 */
function listenNotifications(channel, onPayload, options = {}) {
    const a = getAdapter();
    if (!a.listenNotifications) {
        throw new Error('listenNotifications() is Postgres-only; check db.engine.');
    }
    return a.listenNotifications(channel, onPayload, options);
}

function vecAvailable() {
    return getAdapter().vecAvailable();
}

/**
 * Async-compatible connection getter kept so existing call sites that do
 * `await getConnection()` keep working during and after the migration.
 */
async function getConnection() {
    return getAdapter().engine === 'sqlite' ? getDb() : getAdapter();
}

/** Close the database (used on shutdown). */
async function closeConnection() {
    if (adapter) {
        const a = adapter;
        adapter = null;
        await a.closeConnection();
    }
}

module.exports = {
    get engine() { return getAdapter().engine; },
    getDb,
    rawQuery,
    listenNotifications,
    run,
    get,
    all,
    insert,
    transaction,
    getConnection,
    closeConnection,
    normalizeValue,
    vecAvailable,
};
