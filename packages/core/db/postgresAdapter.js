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
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { translateQuery, translateDdl, splitStatements, PG_NOW_TEXT } = require('./dialect');
const { COLUMN_MIGRATIONS, POST_MIGRATION_STATEMENTS } = require('./migrations');

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

            const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
            // SQLite tolerates forward foreign-key references at CREATE time;
            // Postgres does not, and schema.sql is ordered for SQLite. Run
            // statements individually and retry "relation does not exist"
            // failures until the set converges (every statement is IF NOT
            // EXISTS, so re-running is safe).
            let pending = splitStatements(schemaSql)
                .filter(statement => !/^\s*PRAGMA\b/i.test(statement))
                .map(statement => translateDdl(statement));
            for (let round = 0; pending.length > 0; round++) {
                const failures = [];
                let lastError = null;
                for (const statement of pending) {
                    try {
                        await client.query(statement);
                    } catch (error) {
                        if (error.code === '42P01') { // undefined_table: forward FK
                            failures.push(statement);
                            lastError = error;
                        } else {
                            throw error;
                        }
                    }
                }
                if (failures.length === pending.length) {
                    throw new Error(`Schema bootstrap cannot converge: ${lastError?.message}`, { cause: lastError });
                }
                pending = failures;
            }

            for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
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
            for (const statement of POST_MIGRATION_STATEMENTS) {
                await client.query(translateDdl(statement));
            }

            // User knowledge graph: scopeKey + per-user labels (both engines)
            const kgNodesTable = await client.query(
                `SELECT 1 FROM information_schema.tables
                 WHERE table_schema = current_schema() AND table_name = 'kg_nodes'`
            );
            if (kgNodesTable.rowCount > 0) {
                const uniqueDefs = await client.query(
                    `SELECT pg_get_constraintdef(c.oid) AS def
                     FROM pg_constraint c
                     JOIN pg_class t ON t.oid = c.conrelid
                     WHERE t.relname = 'kg_nodes' AND c.contype = 'u'`
                );
                const hasScopedUnique = uniqueDefs.rows.some(r => String(r.def).includes('scopeKey'));
                if (!hasScopedUnique) {
                    await client.query(`
                        ALTER TABLE kg_nodes RENAME TO kg_nodes_legacy;
                        CREATE TABLE kg_nodes (
                            id BIGSERIAL PRIMARY KEY,
                            "guildId" TEXT NOT NULL,
                            "scopeKey" TEXT NOT NULL DEFAULT '',
                            type TEXT NOT NULL DEFAULT 'concept'
                                CHECK (type IN ('concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing')),
                            label CITEXT NOT NULL,
                            content TEXT,
                            salience DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                            confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                            source TEXT NOT NULL DEFAULT 'monologue'
                                CHECK (source IN ('monologue', 'consolidation', 'tool', 'migration', 'user')),
                            "subjectType" TEXT CHECK ("subjectType" IS NULL OR "subjectType" IN ('USER', 'GUILD')),
                            "subjectId" TEXT,
                            "createdAt" TEXT NOT NULL DEFAULT ${PG_NOW_TEXT},
                            "updatedAt" TEXT NOT NULL DEFAULT ${PG_NOW_TEXT},
                            UNIQUE ("guildId", "scopeKey", label)
                        );
                        INSERT INTO kg_nodes (
                            id, "guildId", "scopeKey", type, label, content, salience, confidence, source,
                            "subjectType", "subjectId", "createdAt", "updatedAt"
                        )
                        SELECT
                            id, "guildId", '', type, label, content, salience, 0.5, 'monologue',
                            NULL, NULL, "createdAt", "updatedAt"
                        FROM kg_nodes_legacy;
                        SELECT setval(pg_get_serial_sequence('kg_nodes', 'id'), COALESCE((SELECT MAX(id) FROM kg_nodes), 1));
                        DROP TABLE kg_nodes_legacy;
                        CREATE INDEX IF NOT EXISTS idx_kg_nodes_guild_salience ON kg_nodes("guildId", "scopeKey", salience);
                        CREATE INDEX IF NOT EXISTS idx_kg_nodes_scope ON kg_nodes("guildId", "scopeKey");

                        ALTER TABLE kg_edges RENAME TO kg_edges_legacy;
                        CREATE TABLE kg_edges (
                            id BIGSERIAL PRIMARY KEY,
                            "guildId" TEXT NOT NULL,
                            "scopeKey" TEXT NOT NULL DEFAULT '',
                            "sourceId" BIGINT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
                            "targetId" BIGINT NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
                            relation CITEXT NOT NULL,
                            "relationKind" TEXT CHECK ("relationKind" IS NULL OR "relationKind" IN ('causal', 'logical', 'associative', 'temporal', 'social')),
                            weight DOUBLE PRECISION NOT NULL DEFAULT 0.5,
                            "createdAt" TEXT NOT NULL DEFAULT ${PG_NOW_TEXT},
                            "updatedAt" TEXT NOT NULL DEFAULT ${PG_NOW_TEXT},
                            UNIQUE ("guildId", "sourceId", "targetId", relation)
                        );
                        INSERT INTO kg_edges (
                            id, "guildId", "scopeKey", "sourceId", "targetId", relation, "relationKind", weight, "createdAt", "updatedAt"
                        )
                        SELECT id, "guildId", '', "sourceId", "targetId", relation, NULL, weight, "createdAt", "updatedAt"
                        FROM kg_edges_legacy;
                        SELECT setval(pg_get_serial_sequence('kg_edges', 'id'), COALESCE((SELECT MAX(id) FROM kg_edges), 1));
                        DROP TABLE kg_edges_legacy;
                        CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges("sourceId");
                        CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges("targetId");
                        CREATE INDEX IF NOT EXISTS idx_kg_edges_scope ON kg_edges("guildId", "scopeKey");
                    `);
                    console.log('[DB] Migrated: rebuilt kg_nodes/kg_edges with scopeKey (Postgres)');
                }
            }
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
    return async () => {
        stopped = true;
        const dead = client;
        client = null;
        if (dead) await dead.end().catch(() => {});
    };
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
