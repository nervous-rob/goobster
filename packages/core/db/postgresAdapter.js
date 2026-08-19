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
const { translateQuery, translateDdl, splitStatements } = require('./dialect');
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
    _testSchemaName: () => schemaName,
};
