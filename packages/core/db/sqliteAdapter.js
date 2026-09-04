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
const { COLUMN_MIGRATIONS } = require('./migrations');

const DEFAULT_DB_PATH = path.join(require('../runtimePaths').dataDir, 'goobster.sqlite');

let db = null;
let vecLoaded = false;

const txContext = new AsyncLocalStorage();

/** Resolves when the currently-active transaction finishes; null when idle. */
let activeTx = null;

/**
 * Open (or return the already-open) database.
 * Creates the data directory, migrates and applies the schema, and enables
 * WAL + FKs.
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

    migrateExistingTables(db);
    db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    // Second pass for the tables schema.sql just created: a column added to
    // an existing table lives only in COLUMN_MIGRATIONS, so schema.sql's
    // CREATE TABLE text can lag behind it, and the first pass skipped
    // tables that did not exist yet.
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
 * Constraint changes SQLite cannot apply in place, keyed to the table they
 * rebuild. `isCurrent` reads the live CREATE TABLE text; when it says no,
 * the table is rebuilt with `ddl` and `columns` are copied across (every
 * column listed here exists by then - new ones arrive via COLUMN_MIGRATIONS,
 * which runs first). Indexes are left to schema.sql, which runs after.
 */
const TABLE_REBUILDS = [
    {
        table: 'option_trades',
        reason: 'write-side actions',
        isCurrent: ddl => ddl.includes('SELL_TO_OPEN'),
        columns: [
            'id', 'guildId', 'userId', 'positionId', 'underlying', 'optionType', 'strike',
            'expiry', 'action', 'contracts', 'premium', 'underlyingPrice', 'iv', 'points', 'createdAt'
        ],
        ddl: name => `
            CREATE TABLE ${name} (
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
            )`
    },
    {
        // User knowledge graph: labels became unique per scope rather than
        // per guild, and saved attachments added the 'artifact' node type
        // (documentation/user_knowledge_graph.md).
        table: 'kg_nodes',
        reason: 'scoped labels, the artifact type, and conversation/research sources',
        isCurrent: ddl => collapse(ddl).includes('UNIQUE (guildId, scopeKey, label)')
            && ddl.includes("'artifact'")
            && ddl.includes("'research'")
            && ddl.includes("'conversation'"),
        columns: [
            'id', 'guildId', 'scopeKey', 'type', 'label', 'content', 'salience', 'confidence',
            'source', 'subjectType', 'subjectId', 'createdAt', 'updatedAt'
        ],
        ddl: name => `
            CREATE TABLE ${name} (
                id INTEGER PRIMARY KEY,
                guildId TEXT NOT NULL,
                scopeKey TEXT NOT NULL DEFAULT '',
                type TEXT NOT NULL DEFAULT 'concept'
                    CHECK (type IN ('concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing', 'artifact')),
                label TEXT NOT NULL COLLATE NOCASE,
                content TEXT,
                salience REAL NOT NULL DEFAULT 0.5,
                confidence REAL NOT NULL DEFAULT 0.5,
                source TEXT NOT NULL DEFAULT 'monologue'
                    CHECK (source IN ('monologue', 'consolidation', 'tool', 'migration', 'user', 'research', 'conversation')),
                subjectType TEXT CHECK (subjectType IS NULL OR subjectType IN ('USER', 'GUILD')),
                subjectId TEXT,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (guildId, scopeKey, label)
            )`
    },
    {
        table: 'kg_provenance',
        reason: 'the artifact, research, and parlor sourceKinds',
        isCurrent: ddl => ddl.includes("'artifact'") && ddl.includes("'research_claim'")
            && ddl.includes("'parlor_conversation'"),
        columns: ['id', 'nodeId', 'sourceKind', 'sourceId', 'createdAt'],
        ddl: name => `
            CREATE TABLE ${name} (
                id INTEGER PRIMARY KEY,
                nodeId INTEGER NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
                sourceKind TEXT NOT NULL CHECK (sourceKind IN ('memory', 'fact', 'consolidation', 'monologue', 'tool', 'user', 'artifact', 'research_claim', 'research_source', 'expedition', 'parlor_conversation')),
                sourceId INTEGER,
                createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (nodeId, sourceKind, sourceId)
            )`
    },
    {
        table: 'project_mission_steps',
        reason: 'the STARTING step status',
        isCurrent: ddl => ddl.includes("'STARTING'"),
        columns: [
            'id', 'missionId', 'userId', 'kind', 'title', 'description', 'status',
            'dependsOnJson', 'requiresApproval', 'expeditionId', 'jobId', 'watchId',
            'actionParamsJson', 'executionAttemptId', 'planRevision', 'sortOrder',
            'createdAt', 'updatedAt', 'startedAt', 'finishedAt'
        ],
        ddl: name => `
            CREATE TABLE ${name} (
                id INTEGER PRIMARY KEY,
                missionId INTEGER NOT NULL REFERENCES project_missions(id) ON DELETE CASCADE,
                userId TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('expedition', 'job', 'watch', 'human')),
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'READY', 'STARTING', 'RUNNING', 'BLOCKED', 'DONE', 'SKIPPED', 'FAILED')),
                dependsOnJson TEXT,
                requiresApproval INTEGER NOT NULL DEFAULT 0 CHECK (requiresApproval IN (0, 1)),
                expeditionId INTEGER,
                jobId INTEGER,
                watchId INTEGER,
                actionParamsJson TEXT,
                executionAttemptId TEXT,
                planRevision INTEGER NOT NULL DEFAULT 0,
                sortOrder INTEGER NOT NULL DEFAULT 0,
                createdAt TEXT NOT NULL DEFAULT (datetime('now')),
                updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
                startedAt TEXT,
                finishedAt TEXT
            )`
    }
];

/** Whitespace-insensitive view of a DDL string, for constraint matching. */
function collapse(sql) {
    return sql.replace(/\s+/g, ' ');
}

/** The stored CREATE TABLE text, or null when the table does not exist. */
function tableDdl(database, table) {
    const row = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
    return row ? row.sql : null;
}

/**
 * Bring an existing database up to the current shape, before schema.sql runs.
 *
 * schema.sql assumes the tables it finds already match it: CREATE TABLE IF
 * NOT EXISTS skips a table whose constraints have since changed, but the
 * CREATE INDEX statements that follow name columns (kg_nodes.scopeKey and
 * friends) that older databases only gain here - and those fail hard. So
 * migrations go first and schema.sql fills in whatever is still missing,
 * which also means a fresh database and an upgraded one end up identical.
 */
function migrateExistingTables(database) {
    applyColumnMigrations(database);
    applyTableRebuilds(database);
}

/** Minimal migration support (shared list in ./migrations.js). */
function applyColumnMigrations(database) {
    for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
        const columns = database.pragma(`table_info(${table})`);
        // Table not created yet: schema.sql is about to, column included.
        if (columns.length === 0) continue;
        if (!columns.some(c => c.name === column)) {
            database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
            console.log(`[DB] Migrated: added ${table}.${column}`);
        }
    }
}

/**
 * Rebuild every table whose constraints have drifted from TABLE_REBUILDS.
 *
 * Runs the procedure from https://sqlite.org/lang_altertable.html: foreign
 * keys off so dropping the old table cannot cascade into its children, and
 * legacy_alter_table on so the closing rename does not rewrite REFERENCES
 * clauses elsewhere in the schema. Both pragmas are no-ops inside a
 * transaction, hence set around it.
 */
function applyTableRebuilds(database) {
    const foreignKeys = database.pragma('foreign_keys', { simple: true });
    database.pragma('foreign_keys = OFF');
    database.pragma('legacy_alter_table = ON');
    try {
        database.exec('BEGIN');
        try {
            repairDroppedLegacyReferences(database);
            for (const spec of TABLE_REBUILDS) {
                const ddl = tableDdl(database, spec.table);
                if (!ddl || spec.isCurrent(ddl)) continue;
                rebuildTable(database, spec.table, spec.ddl, spec.columns);
                console.log(`[DB] Migrated: rebuilt ${spec.table} with ${spec.reason}`);
            }
            const violations = database.pragma('foreign_key_check');
            if (violations.length > 0) {
                console.warn('[DB] Foreign key violations after migration:', JSON.stringify(violations.slice(0, 5)));
            }
            database.exec('COMMIT');
        } catch (error) {
            database.exec('ROLLBACK');
            throw error;
        }
    } finally {
        database.pragma('legacy_alter_table = OFF');
        database.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }
}

/**
 * Replace `table` with the shape `ddl` describes, carrying `columns` over.
 * Only safe under the pragmas applyTableRebuilds sets.
 */
function rebuildTable(database, table, ddl, columns) {
    const staging = `${table}_migrating`;
    const list = columns.join(', ');
    database.exec(ddl(staging));
    database.exec(`INSERT INTO ${staging} (${list}) SELECT ${list} FROM ${table}`);
    database.exec(`DROP TABLE ${table}`);
    database.exec(`ALTER TABLE ${staging} RENAME TO ${table}`);
}

/**
 * Point children back at a table an older rebuild dropped out from under them.
 *
 * That rebuild renamed the table to <table>_legacy first, which - foreign
 * keys being on - rewrote every REFERENCES clause aimed at it, kg_node_tags
 * and kg_artifacts included, and then dropped it. Those children are left
 * referencing a table that no longer exists, so every insert into them fails
 * with "no such table: main.kg_nodes_legacy" until the clause is restored.
 */
function repairDroppedLegacyReferences(database) {
    const candidates = database
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%legacy%'")
        .all();

    for (const { name, sql } of candidates) {
        const dangling = new Set(
            [...sql.matchAll(/REFERENCES\s+"?(\w+)_legacy"?/g)]
                .map(([, base]) => base)
                .filter(base => !tableDdl(database, `${base}_legacy`))
        );
        if (dangling.size === 0) continue;

        const repaired = sql.replace(
            /REFERENCES\s+"?(\w+)_legacy"?/g,
            (reference, base) => (dangling.has(base) ? `REFERENCES ${base}` : reference)
        );
        const columns = database.pragma(`table_info(${name})`).map(c => c.name);
        rebuildTable(
            database,
            name,
            staging => repaired.replace(/^CREATE TABLE\s+"?\w+"?/i, `CREATE TABLE ${staging}`),
            columns
        );
        console.log(`[DB] Migrated: repaired ${name} references to a dropped table`);
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
