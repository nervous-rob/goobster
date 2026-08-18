/**
 * Local SQLite database layer (Raspberry Pi edition).
 *
 * Backed by an embedded better-sqlite3 database (WAL mode). The facade is
 * async (reactive port, Phase 1) so a Postgres adapter can sit behind the
 * same contract; under SQLite the work is still synchronous underneath.
 *
 * API (all data methods return promises):
 *   getDb()                 -> the raw better-sqlite3 Database (lazy singleton)
 *   run(sql, params)        -> { changes, lastInsertRowid }
 *   get(sql, params)        -> first row or undefined
 *   all(sql, params)        -> array of rows
 *   insert(sql, params)     -> the new row id (engine-agnostic)
 *   transaction(fn)         -> runs (possibly async) fn inside an IMMEDIATE
 *                              transaction; nested calls become savepoints
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

const { dataDir } = require('../runtimePaths');

const DEFAULT_DB_PATH = path.join(dataDir, 'goobster.sqlite');

let db = null;
let vecLoaded = false;

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
    ensureColumn('guild_settings', 'monologue_mode',
        `monologue_mode TEXT NOT NULL DEFAULT 'DISABLED' CHECK (monologue_mode IN ('ENABLED', 'DISABLED'))`);
    ensureColumn('guild_settings', 'reply_detection',
        `reply_detection TEXT NOT NULL DEFAULT 'ENABLED' CHECK (reply_detection IN ('ENABLED', 'DISABLED'))`);
    ensureColumn('guild_settings', 'ai_provider', 'ai_provider TEXT');
    ensureColumn('guild_settings', 'ai_model', 'ai_model TEXT');
    ensureColumn('guild_settings', 'ai_reasoning_effort', 'ai_reasoning_effort TEXT');
    ensureColumn('guild_settings', 'memory_retention_days', 'memory_retention_days INTEGER');
    // Per-user custom instructions (web portal settings dialog)
    ensureColumn('UserPreferences', 'custom_instructions', 'custom_instructions TEXT');
    // Web chat branching: a forked conversation points at its source
    ensureColumn('web_conversations', 'parentConversationId', 'parentConversationId INTEGER');
    ensureColumn('web_conversations', 'branchedFromMessageId', 'branchedFromMessageId INTEGER');
    ensureColumn('agent_runs', 'threadId', 'threadId TEXT');
    ensureColumn('gba_run_clients', 'statusMessageId', 'statusMessageId TEXT');
    // Parlor persona replies gained tool-generated attachments
    ensureColumn('parlor_messages', 'attachments', 'attachments TEXT');
    // Parlor Live: per-persona ElevenLabs voice (id resolved on save, name
    // snapshotted for display)
    ensureColumn('parlor_personas', 'voiceId', 'voiceId TEXT');
    ensureColumn('parlor_personas', 'voiceName', 'voiceName TEXT');
    // Multi-user parlors: 'user' rows carry which human member spoke
    ensureColumn('parlor_messages', 'userId', 'userId TEXT');
    ensureColumn('parlor_messages', 'userName', 'userName TEXT');
    // Invitations snapshot who they were sent to, so the host's roster
    // shows a person instead of a raw snowflake
    ensureColumn('parlor_invites', 'inviteeName', 'inviteeName TEXT');
    // Exchange: annualized realized volatility cached per symbol, the input
    // that prices every simulated option chain.
    ensureColumn('stock_symbols', 'impliedVol', 'impliedVol REAL');
    ensureColumn('stock_symbols', 'ivUpdatedAt', 'ivUpdatedAt TEXT');
    // Exchange: corporate-action sweep bookkeeping (dividends/splits)
    ensureColumn('stock_symbols', 'corporateCheckedAt', 'corporateCheckedAt TEXT');
    // Exchange: written (short) options share the option_positions table
    ensureColumn('option_positions', 'side',
        `side TEXT NOT NULL DEFAULT 'LONG' CHECK (side IN ('LONG', 'SHORT'))`);
    // Exchange: group-event opt-in override and the perp/corporate settings
    ensureColumn('exchange_settings', 'optInOverride',
        'optInOverride INTEGER NOT NULL DEFAULT 1 CHECK (optInOverride IN (0, 1))');
    ensureColumn('exchange_settings', 'futuresEnabled',
        'futuresEnabled INTEGER NOT NULL DEFAULT 0 CHECK (futuresEnabled IN (0, 1))');
    ensureColumn('exchange_settings', 'maxPerpLeverage',
        'maxPerpLeverage REAL NOT NULL DEFAULT 10 CHECK (maxPerpLeverage >= 1)');
    ensureColumn('exchange_settings', 'fundingRateDaily',
        'fundingRateDaily REAL NOT NULL DEFAULT 0.0003 CHECK (fundingRateDaily >= 0)');
    ensureColumn('exchange_settings', 'corporateActionsEnabled',
        'corporateActionsEnabled INTEGER NOT NULL DEFAULT 1 CHECK (corporateActionsEnabled IN (0, 1))');
    // Recurring follow-ups: interval + human label, delivery bookkeeping
    ensureColumn('followups', 'recurMinutes',
        'recurMinutes INTEGER CHECK (recurMinutes IS NULL OR recurMinutes > 0)');
    ensureColumn('followups', 'recurrence', 'recurrence TEXT');
    ensureColumn('followups', 'deliveryCount', 'deliveryCount INTEGER NOT NULL DEFAULT 0');
    ensureColumn('followups', 'lastDeliveredAt', 'lastDeliveredAt TEXT');
    // MTGA deck library: content-hash dedupe key for Player.log re-imports
    ensureColumn('mtga_decks', 'contentHash', 'contentHash TEXT');

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
    // Created here (not schema.sql) so it runs after the column migration on
    // databases whose agent_runs predates threadId.
    database.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_thread ON agent_runs(threadId)');
}

/**
 * ---------------------------------------------------------------------------
 * The async facade (reactive port, Phase 1).
 *
 * Every method is async so a network-backed adapter (Postgres, Phase 2) can
 * slot in behind the same contract. Under better-sqlite3 the work itself is
 * still synchronous: a call with no transaction in flight executes before
 * its promise is returned, so ordering is exactly what it was when these
 * were sync functions.
 *
 * Transactions serialize on a process-wide queue (SQLite has one writer
 * anyway) and run their callback inside an AsyncLocalStorage context. Any
 * db.get/all/run/insert reached from inside the callback - directly or
 * through any awaited call chain - automatically joins the transaction,
 * while calls from outside the context wait for the commit. Callbacks may
 * await freely; nesting uses savepoints, matching better-sqlite3's own
 * nested-transaction behavior.
 * ---------------------------------------------------------------------------
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const txContext = new AsyncLocalStorage();

/** Resolves when the currently-active transaction finishes; null when idle. */
let activeTx = null;

/**
 * Plain calls must not interleave into someone else's open transaction
 * (same connection - they would silently join it). Calls made from inside
 * the transaction's own async context skip the wait and join deliberately.
 *
 * Returns null on the fast path (no transaction in flight) so callers can
 * execute fully synchronously inside their async body - an un-awaited
 * db.run() still performs its write immediately, exactly like the old sync
 * facade did.
 * @returns {Promise<void>|null}
 */
function waitForTurn() {
    if (!activeTx || txContext.getStore()) return null;
    return (async () => { while (activeTx) await activeTx; })();
}

/**
 * Execute a statement that doesn't return rows.
 * @param {string} sql
 * @param {Object} [params]
 * @returns {Promise<{changes: number, lastInsertRowid: number|bigint}>}
 */
async function run(sql, params = {}) {
    const wait = waitForTurn();
    if (wait) await wait;
    return getDb().prepare(sql).run(normalizeParams(params));
}

/**
 * Fetch the first row of a query.
 * @param {string} sql
 * @param {Object} [params]
 * @returns {Promise<Object|undefined>}
 */
async function get(sql, params = {}) {
    const wait = waitForTurn();
    if (wait) await wait;
    return getDb().prepare(sql).get(normalizeParams(params));
}

/**
 * Fetch all rows of a query.
 * @param {string} sql
 * @param {Object} [params]
 * @returns {Promise<Array<Object>>}
 */
async function all(sql, params = {}) {
    const wait = waitForTurn();
    if (wait) await wait;
    return getDb().prepare(sql).all(normalizeParams(params));
}

/**
 * Insert a row and return its new id as a plain number. Prefer this over
 * reading `lastInsertRowid` off run(): the Postgres adapter implements it
 * with RETURNING, so call sites stay engine-agnostic.
 * @param {string} sql
 * @param {Object} [params]
 * @returns {Promise<number>}
 */
async function insert(sql, params = {}) {
    const result = await run(sql, params);
    return Number(result.lastInsertRowid);
}

/**
 * Run a function inside an IMMEDIATE transaction. The callback may be async
 * and receives a `tx` handle ({ get, all, run, insert }); plain db.* calls
 * made anywhere inside the callback's async context join the transaction
 * automatically. Everything commits together or rolls back on throw.
 * Nested transaction() calls become savepoints.
 * @param {Function} fn - (tx) => result, sync or async
 * @returns {Promise<*>} whatever fn returns
 */
async function transaction(fn) {
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

/** The handle passed to transaction callbacks (same functions - the async
 *  context routes them into the open transaction). */
const txApi = { get, all, run, insert };

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
        vecLoaded = false;
    }
}

module.exports = {
    getDb,
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
