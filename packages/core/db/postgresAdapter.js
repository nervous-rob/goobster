/**
 * Postgres adapter (pg, pgvector) behind the async db facade.
 *
 * Selected by GOOBSTER_DB_URL (postgres://...). SQL stays written in the
 * codebase's SQLite dialect; every distinct statement is translated once
 * (./dialect.js) and cached. The schema is the same db/schema.sql, DDL-
 * translated at bootstrap - one source of truth, no drift.
 *
 * Transactions check a dedicated client out of the pool and run the
 * callback inside an AsyncLocalStorage context, so db.* calls reached from
 * inside the callback join the transaction while outside calls run on the
 * pool (MVCC handles the isolation SQLite needed a queue for). Nested
 * transaction() calls become savepoints.
 *
 * Test isolation: GOOBSTER_PG_TEST_ISOLATE=1 gives each process a private
 * schema (test_<pid>_<random>) with search_path=<schema>,public - the
 * per-suite equivalent of a throwaway GOOBSTER_DB_PATH file.
 *
 * Schema bootstrap strips column REFERENCES, creates every table, then
 * ADD CONSTRAINT. SQLite allows forward and circular FKs at CREATE time;
 * retrying 42P01 (relation does not exist) was the old exception-driven
 * path and flooded CI logs.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const {
    translateQuery,
    translateDdl,
    splitStatements,
    extractCreateTableForeignKeys,
    foreignKeyAlterSql
} = require('./dialect');
const { COLUMN_MIGRATIONS } = require('./migrations');
const { repairMissionUniques } = require('./repairMissionUniques');
const { repairObservatoryJobs } = require('./repairObservatoryJobs');

let pg = null;
function requirePg() {
    if (!pg) {
        pg = require('pg');
        // SQLite returns JS numbers; match it. int8 (20) carries counts and
        // ids (safe below 2^53 - snowflakes are TEXT), numeric (1700) comes
        // from SUM()/AVG() over bigint.
        pg.types.setTypeParser(20, value => Number(value));
        pg.types.setTypeParser(1700, value => Number(value));
    }
    return pg;
}

let pool = null;
let ready = null;
let schemaName = null;
let vectorAvailable = false;

const txContext = new AsyncLocalStorage();
const queryCache = new Map(); // original sql -> { text, paramNames }

function translate(sql) {
    let entry = queryCache.get(sql);
    if (!entry) {
        entry = translateQuery(sql);
        queryCache.set(sql, entry);
    }
    return entry;
}

function getPool() {
    if (pool) return pool;
    const url = process.env.GOOBSTER_DB_URL;
    if (!url) throw new Error('Postgres adapter selected without GOOBSTER_DB_URL');
    if (process.env.GOOBSTER_PG_TEST_ISOLATE === '1') {
        schemaName = `test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    }
    const { Pool } = requirePg();
    pool = new Pool({
        connectionString: url,
        // Test isolation runs one suite per worker; keep pools tiny so the
        // matrix stays far from max_connections even if a suite leaks.
        max: Number(process.env.GOOBSTER_PG_POOL_SIZE) || (schemaName ? 3 : 10),
        options: schemaName ? `-c search_path="${schemaName}",public` : undefined
    });
    pool.on('error', error => console.error('[DB] Postgres pool error:', error.message));
    return pool;
}

/**
 * Constraint changes on tables that already exist. Postgres swaps a
 * constraint in place, so unlike the SQLite adapter nothing is rebuilt or
 * copied: the definitions `matches` selects are dropped and `add` replaces
 * them. Columns come from COLUMN_MIGRATIONS, which runs first.
 */
const CONSTRAINT_MIGRATIONS = [
    {
        table: 'option_trades',
        reason: 'write-side actions',
        type: 'c',
        matches: def => def.includes('BUY_TO_OPEN'),
        isCurrent: def => def.includes('SELL_TO_OPEN'),
        add: `CHECK (action IN ('BUY_TO_OPEN', 'SELL_TO_CLOSE', 'SELL_TO_OPEN', 'BUY_TO_CLOSE', 'EXPIRE', 'EXERCISE', 'ASSIGN'))`
    },
    {
        // User knowledge graph: labels became unique per scope rather than
        // per guild, and saved attachments added the 'artifact' node type
        // (documentation/user_knowledge_graph.md).
        table: 'kg_nodes',
        reason: 'scoped label uniqueness',
        type: 'u',
        matches: def => def.includes('label'),
        isCurrent: def => def.includes('scopeKey'),
        add: 'UNIQUE ("guildId", "scopeKey", label)'
    },
    {
        table: 'kg_nodes',
        reason: 'the artifact node type',
        type: 'c',
        matches: def => def.includes("'concept'"),
        isCurrent: def => def.includes("'artifact'"),
        add: `CHECK (type IN ('concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing', 'artifact'))`
    },
    {
        // Spitball Expeditions (documentation/spitball_expeditions.md):
        // research-generated notes carry the 'research' source.
        table: 'kg_nodes',
        reason: 'the research node source',
        type: 'c',
        matches: def => def.includes("'migration'"),
        isCurrent: def => def.includes("'research'") && def.includes("'conversation'"),
        add: `CHECK (source IN ('monologue', 'consolidation', 'tool', 'migration', 'user', 'research', 'conversation'))`
    },
    {
        table: 'kg_provenance',
        reason: 'the artifact and research sourceKinds',
        type: 'c',
        matches: def => def.includes("'memory'"),
        isCurrent: def => def.includes("'artifact'") && def.includes("'research_claim'")
            && def.includes("'parlor_conversation'"),
        add: `CHECK ("sourceKind" IN ('memory', 'fact', 'consolidation', 'monologue', 'tool', 'user', 'artifact', 'research_claim', 'research_source', 'expedition', 'parlor_conversation'))`
    },
    {
        table: 'project_mission_steps',
        reason: 'the STARTING step status',
        type: 'c',
        matches: def => def.includes("'PENDING'") && def.includes("'READY'"),
        isCurrent: def => def.includes("'STARTING'"),
        add: `CHECK (status IN ('PENDING', 'READY', 'STARTING', 'RUNNING', 'BLOCKED', 'DONE', 'SKIPPED', 'FAILED'))`
    },
    {
        table: 'pending_integration_actions',
        reason: 'the EXECUTING approval status',
        type: 'c',
        matches: def => def.includes("'PENDING'") && def.includes("'CONFIRMED'"),
        isCurrent: def => def.includes("'EXECUTING'"),
        add: `CHECK (status IN ('PENDING', 'EXECUTING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'))`
    },
    {
        table: 'sandbox_requests',
        reason: 'the EXECUTING approval status',
        type: 'c',
        matches: def => def.includes("'PENDING'") && def.includes("'COMPLETED'"),
        isCurrent: def => def.includes("'EXECUTING'"),
        add: `CHECK (status IN ('PENDING', 'EXECUTING', 'DENIED', 'EXPIRED', 'COMPLETED', 'FAILED'))`
    }
];

async function tableExists(client, table) {
    const found = await client.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = $1`,
        [table]
    );
    return found.rowCount > 0;
}

/**
 * Bring an existing database up to the current shape, before schema.sql runs.
 *
 * schema.sql assumes the tables it finds already match it: CREATE TABLE IF
 * NOT EXISTS skips a table whose constraints have since changed, but the
 * CREATE INDEX statements that follow name columns (kg_nodes."scopeKey" and
 * friends) that older databases only gain here - and those fail hard. So
 * migrations go first and schema.sql fills in whatever is still missing,
 * which also means a fresh database and an upgraded one end up identical.
 */
async function migrateExistingTables(client) {
    await applyColumnMigrations(client);

    for (const spec of CONSTRAINT_MIGRATIONS) {
        if (!await tableExists(client, spec.table)) continue;
        // current_schema() keeps parallel test schemas from matching each
        // other's identically named tables.
        const constraints = await client.query(
            `SELECT c.conname AS name, pg_get_constraintdef(c.oid) AS def
             FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE t.relname = $1 AND c.contype = $2 AND n.nspname = current_schema()`,
            [spec.table, spec.type]
        );
        const stale = constraints.rows.filter(row => spec.matches(String(row.def)));
        if (stale.length === 0 || stale.some(row => spec.isCurrent(String(row.def)))) continue;

        const drops = stale.map(row => `DROP CONSTRAINT "${row.name}"`).join(', ');
        await client.query(`ALTER TABLE ${spec.table} ${drops}, ADD ${spec.add}`);
        console.log(`[DB] Migrated: ${spec.table} gained ${spec.reason} (Postgres)`);
    }

    await repairMissionUniques(client, {
        tableExists,
        exec: sql => client.query(translateDdl(sql))
    });
    await repairObservatoryJobs(client, {
        tableExists,
        exec: sql => client.query(translateDdl(sql))
    });
}

/** Minimal migration support (shared list in ./migrations.js). */
async function applyColumnMigrations(client) {
    for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
        // Table not created yet: schema.sql is about to, column included.
        if (!await tableExists(client, table)) continue;
        // The DDL translator quotes mixed-case identifiers, so
        // information_schema stores names exactly as written here.
        const exists = await client.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
            [table, column]
        );
        if (exists.rowCount === 0) {
            await client.query(translateDdl(`ALTER TABLE ${table} ADD COLUMN ${ddl}`));
            console.log(`[DB] Migrated: added ${table}.${column}`);
        }
    }
}

/**
 * Attach one extracted FK if this schema does not already have a foreign
 * key on that column (fresh isolate schemas never do; upgraded databases
 * already received the inline REFERENCES name).
 */
async function addForeignKeyIfMissing(client, fk) {
    const existing = await client.query(
        `SELECT 1
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
         WHERE n.nspname = current_schema()
           AND t.relname = $1
           AND c.contype = 'f'
           AND a.attname = $2`,
        [fk.table, fk.column]
    );
    if (existing.rowCount > 0) return;
    await client.query(translateDdl(foreignKeyAlterSql(fk)));
}

/** Apply schema + column migrations once per process (lazy, awaited by every call). */
function ensureReady() {
    if (ready) return ready;
    ready = (async () => {
        const p = getPool();
        const client = await p.connect();
        try {
            if (schemaName) {
                await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
                await client.query(`SET search_path TO "${schemaName}", public`);
            }
            // Extensions are database-level; creating them needs ownership or
            // superuser. The compose image's default user has it; a hardened
            // setup pre-creates them. Failure only disables what needs them.
            // WITH SCHEMA public: extensions otherwise install into the first
            // search_path schema, which under test isolation is a throwaway.
            for (const ext of ['citext', 'vector']) {
                try {
                    await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext} WITH SCHEMA public`);
                } catch (error) {
                    console.warn(`[DB] Could not ensure extension ${ext}: ${error.message}`);
                }
            }
            vectorAvailable = (await client.query(
                "SELECT 1 FROM pg_extension WHERE extname = 'vector'"
            )).rowCount > 0;
            if (!vectorAvailable) {
                console.warn('[DB] pgvector extension unavailable - memory recall will use brute-force scan');
            }

            await migrateExistingTables(client);

            const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
            // SQLite allows forward and circular FKs at CREATE time;
            // Postgres does not. Strip column REFERENCES, create every
            // table/index, then ADD CONSTRAINT — no 42P01 retry loop.
            const foreignKeys = [];
            const statements = splitStatements(schemaSql)
                .filter(statement => !/^\s*PRAGMA\b/i.test(statement))
                .map((statement) => {
                    if (/^\s*CREATE\s+TABLE\b/i.test(statement)) {
                        const { sql, fks } = extractCreateTableForeignKeys(statement);
                        foreignKeys.push(...fks);
                        return translateDdl(sql);
                    }
                    return translateDdl(statement);
                });
            for (const statement of statements) {
                await client.query(statement);
            }
            for (const fk of foreignKeys) {
                await addForeignKeyIfMissing(client, fk);
            }

            // Second pass for the tables schema.sql just created: a column
            // added to an existing table lives only in COLUMN_MIGRATIONS, so
            // schema.sql's CREATE TABLE text can lag behind it, and the
            // first pass skipped tables that did not exist yet.
            await applyColumnMigrations(client);
        } finally {
            client.release();
        }
    })();
    return ready;
}

/** The executor for the current context: the transaction's client, or the pool. */
function executor() {
    const store = txContext.getStore();
    return store ? store.client : getPool();
}

function bindParams(paramNames, params, normalizeParams) {
    const normalized = normalizeParams(params);
    return paramNames.map(name => (name in normalized ? normalized[name] : null));
}

async function query(sql, params, normalizeParams) {
    await ensureReady();
    const { text, paramNames } = translate(sql);
    try {
        return await executor().query(text, bindParams(paramNames, params, normalizeParams));
    } catch (error) {
        // Keep better-sqlite3's error vocabulary: services detect duplicate
        // rows via `error.message.includes('UNIQUE')` on both engines.
        if (error.code === '23505') {
            error.message = `UNIQUE constraint failed: ${error.constraint || ''} (${error.message})`;
        }
        if (process.env.GOOBSTER_PG_DEBUG === '1') {
            console.error('[DB DEBUG] failed SQL:', text.replace(/\s+/g, ' ').slice(0, 300), '| error:', error.message);
        }
        throw error;
    }
}

async function run(sql, params, normalizeParams) {
    const result = await query(sql, params, normalizeParams);
    return { changes: result.rowCount ?? 0, lastInsertRowid: undefined };
}

async function get(sql, params, normalizeParams) {
    const result = await query(sql, params, normalizeParams);
    return result.rows[0];
}

async function all(sql, params, normalizeParams) {
    const result = await query(sql, params, normalizeParams);
    return result.rows;
}

async function insert(sql, params, normalizeParams) {
    const withReturning = /\breturning\b/i.test(sql) ? sql : `${sql} RETURNING id`;
    const result = await query(withReturning, params, normalizeParams);
    return Number(result.rows[0]?.id);
}

async function transaction(fn, txApi) {
    await ensureReady();
    const outer = txContext.getStore();

    if (outer) {
        const name = `goobster_sp_${outer.depth++}`;
        await outer.client.query(`SAVEPOINT ${name}`);
        try {
            const result = await fn(txApi);
            await outer.client.query(`RELEASE SAVEPOINT ${name}`);
            return result;
        } catch (error) {
            await outer.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
            await outer.client.query(`RELEASE SAVEPOINT ${name}`);
            throw error;
        }
    }

    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        try {
            const result = await txContext.run({ client, depth: 0 }, () => fn(txApi));
            await client.query('COMMIT');
            return result;
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
            throw error;
        }
    } finally {
        client.release();
    }
}

function vecAvailable() {
    // ensureReady() has run before any caller can sensibly ask; if not,
    // answer pessimistically (brute-force recall still works).
    return vectorAvailable;
}

function getDb() {
    throw new Error('getDb() is SQLite-only; check db.engine before using raw handles.');
}

/** Raw parameterized query escape hatch for engine-aware code (pgvector). */
async function rawQuery(text, values = []) {
    await ensureReady();
    return executor().query(text, values);
}

/**
 * Dedicated LISTEN connection (LISTEN needs a persistent session, so it
 * cannot ride the pool). Reconnects with backoff forever until stopped;
 * a dropped connection is a warning, never an error - the event bus is
 * a convenience layer, and the portal falls back to its normal fetches.
 * @param {string} channel - identifier-shaped channel name
 * @param {(payload: string) => void} onPayload
 * @returns {() => Promise<void>} stop
 */
const listenStops = new Set();

function listenNotifications(channel, onPayload, { logger = console } = {}) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(channel)) {
        throw new Error(`Bad LISTEN channel name: ${channel}`);
    }
    const { Client } = requirePg();
    let client = null;
    let stopped = false;
    let backoffMs = 1000;

    const schedule = () => {
        if (stopped) return;
        const dead = client;
        client = null;
        if (dead) dead.end().catch(() => {});
        const timer = setTimeout(connect, backoffMs);
        timer.unref?.();
        backoffMs = Math.min(backoffMs * 2, 30 * 1000);
    };

    const connect = async () => {
        if (stopped) return;
        try {
            client = new Client({ connectionString: process.env.GOOBSTER_DB_URL });
            client.on('error', (error) => {
                logger.warn?.(`[DB] LISTEN connection lost: ${error.message}`);
                schedule();
            });
            client.on('notification', (message) => {
                if (message.channel === channel && typeof message.payload === 'string') {
                    try { onPayload(message.payload); } catch { /* subscriber's problem */ }
                }
            });
            await client.connect();
            await client.query(`LISTEN ${channel}`);
            backoffMs = 1000;
        } catch (error) {
            logger.warn?.(`[DB] LISTEN ${channel} failed: ${error.message}`);
            schedule();
        }
    };

    connect();
    const stop = async () => {
        stopped = true;
        listenStops.delete(stop);
        const dead = client;
        client = null;
        if (dead) await dead.end().catch(() => {});
    };
    listenStops.add(stop);
    return stop;
}

/**
 * Two signed int4 keys for pg_try_advisory_lock(int, int). Scoped by the
 * test-isolation schema so parallel Jest workers never steal each other's
 * worker locks; production (no schemaName) shares keys across processes
 * on the same database — that is the whole point.
 * @param {string} name
 * @returns {[number, number]}
 */
function advisoryLockKeys(name) {
    const scope = schemaName || 'public';
    const digest = crypto.createHash('sha256')
        .update(`goobster:singleton:${scope}:${name}`)
        .digest();
    return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Session-level try-lock on a dedicated pool connection (not the query
 * executor `fn` uses). Released in finally so a thrown tick cannot leak
 * the lock for the life of the connection.
 * @param {string} name
 * @param {() => Promise<*>|*} fn
 * @returns {Promise<{acquired: boolean, result?: *}>}
 */
async function withAdvisoryLock(name, fn) {
    await ensureReady();
    const client = await getPool().connect();
    const [classid, objid] = advisoryLockKeys(name);
    try {
        const got = await client.query(
            'SELECT pg_try_advisory_lock($1, $2) AS locked',
            [classid, objid]
        );
        if (!got.rows[0]?.locked) return { acquired: false };
        try {
            return { acquired: true, result: await fn() };
        } finally {
            try {
                await client.query(
                    'SELECT pg_advisory_unlock($1, $2)',
                    [classid, objid]
                );
            } catch (error) {
                console.warn(`[DB] advisory unlock failed (${name}):`, error.message);
            }
        }
    } finally {
        client.release();
    }
}

async function closeConnection() {
    const stops = [...listenStops];
    listenStops.clear();
    await Promise.all(stops.map((stop) => stop().catch(() => {})));
    if (pool) {
        const p = pool;
        pool = null;
        ready = null;
        queryCache.clear();
        await p.end();
    }
}

module.exports = {
    engine: 'postgres',
    getDb,
    vecAvailable,
    run,
    get,
    all,
    insert,
    transaction,
    closeConnection,
    rawQuery,
    listenNotifications,
    withAdvisoryLock,
    _testSchemaName: () => schemaName,
};
