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

    // User knowledge graph: scopeKey + per-user labels (documentation/user_knowledge_graph.md)
    const kgNodesRow = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kg_nodes'")
        .get();
    if (kgNodesRow && !kgNodesRow.sql.includes('UNIQUE (guildId, scopeKey, label)')) {
        database.exec(`
            ALTER TABLE kg_nodes RENAME TO kg_nodes_legacy;
            CREATE TABLE kg_nodes (
                id INTEGER PRIMARY KEY,
                guildId TEXT NOT NULL,
                scopeKey TEXT NOT NULL DEFAULT '',
                type TEXT NOT NULL DEFAULT 'concept'
                    CHECK (type IN ('concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing')),
                label TEXT NOT NULL COLLATE NOCASE,
                content TEXT,
                salience REAL NOT NULL DEFAULT 0.5,
                confidence REAL NOT NULL DEFAULT 0.5,
                source TEXT NOT NULL DEFAULT 'monologue'
                    CHECK (source IN ('monologue', 'consolidation', 'tool', 'migration', 'user')),
                subjectType TEXT CHECK (subjectType IS NULL OR subjectType IN ('USER', 'GUILD')),
                subjectId TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (guildId, scopeKey, label)
            );
            INSERT INTO kg_nodes (
                id, guildId, scopeKey, type, label, content, salience, confidence, source,
                subjectType, subjectId, createdAt, updatedAt
            )
            SELECT
                id, guildId, '', type, label, content, salience, 0.5, 'monologue',
                NULL, NULL, createdAt, updatedAt
            FROM kg_nodes_legacy;
            DROP TABLE kg_nodes_legacy;
            CREATE INDEX IF NOT EXISTS idx_kg_nodes_guild_salience ON kg_nodes(guildId, scopeKey, salience);
            CREATE INDEX IF NOT EXISTS idx_kg_nodes_scope ON kg_nodes(guildId, scopeKey);

            ALTER TABLE kg_edges RENAME TO kg_edges_legacy;
            CREATE TABLE kg_edges (
                id INTEGER PRIMARY KEY,
                guildId TEXT NOT NULL,
                scopeKey TEXT NOT NULL DEFAULT '',
                sourceId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
                targetId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
                relation TEXT NOT NULL COLLATE NOCASE,
                relationKind TEXT CHECK (relationKind IS NULL OR relationKind IN ('causal', 'logical', 'associative', 'temporal', 'social')),
                weight REAL NOT NULL DEFAULT 0.5,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (guildId, sourceId, targetId, relation)
            );
            INSERT INTO kg_edges (
                id, guildId, scopeKey, sourceId, targetId, relation, relationKind, weight, createdAt, updatedAt
            )
            SELECT id, guildId, '', sourceId, targetId, relation, NULL, weight, createdAt, updatedAt
            FROM kg_edges_legacy;
            DROP TABLE kg_edges_legacy;
            CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(sourceId);
            CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(targetId);
            CREATE INDEX IF NOT EXISTS idx_kg_edges_scope ON kg_edges(guildId, scopeKey);
        `);
        console.log('[DB] Migrated: rebuilt kg_nodes/kg_edges with scopeKey');
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
