/**
 * Read-only inspection of both migration endpoints (documentation/db_migration.md).
 *
 * Nothing here creates a schema, a table or an extension, applies a
 * migration, or writes to the SQLite file:
 *
 *   SQLite    better-sqlite3 `{ readonly: true, fileMustExist: true }`. The
 *             integrity check is `quick_check` (cheaper than the full
 *             `integrity_check` the operation's snapshot step runs once the
 *             installation is quiesced; the preflight may run while the
 *             application is up). A live WAL database may have its `-shm`
 *             timestamps touched by any reader - the main file is never
 *             written.
 *   Postgres  the `pg` module directly, one short-lived client inside a
 *             `READ ONLY` transaction that is always rolled back. The
 *             database facade and its adapter are deliberately not used:
 *             their first query applies the schema and runs CREATE EXTENSION.
 *
 * `classify()` turns the two reports into blocks (the operation refuses),
 * provisioning (what `provision` will create, only with consent) and
 * warnings. Reports carry names, counts and booleans - never a row, a
 * password or a connection URL.
 */

const fs = require('node:fs');
const Database = require('better-sqlite3');
const { describeTarget, publicTarget } = require('./target');
const { expectedSchema, quoteIdent, isCopyable } = require('./schemaModel');

const MIN_SERVER_VERSION = 130000;
const REQUIRED_EXTENSIONS = Object.freeze(['citext', 'vector']);
const CONNECT_TIMEOUT_MS = 8000;
const MAX_LISTED = 20;
const SPACE_BLOCK_FACTOR = 1.5;
const SPACE_WARN_FACTOR = 3;

const sorted = (list) => [...list].sort().slice(0, MAX_LISTED);

/**
 * @param {string} sqlitePath
 * @param {{ integrity?: 'quick'|'full' }} [options]
 */
function inspectSqlite(sqlitePath, { integrity = 'quick' } = {}) {
    let stat;
    try {
        stat = fs.statSync(sqlitePath);
    } catch {
        return { present: false, readable: false, code: 'SOURCE_MISSING' };
    }
    const sidecars = ['-wal', '-shm'].map(suffix => ({ file: `${sqlitePath}${suffix}`, existed: fs.existsSync(`${sqlitePath}${suffix}`) }));
    let database;
    try {
        database = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    } catch {
        return { present: true, readable: false, code: 'SOURCE_UNREADABLE', sizeBytes: stat.size };
    }
    try {
        const expected = expectedSchema();
        const names = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
            .map(row => row.name).filter(isCopyable).sort();
        const tables = [];
        const ahead = [];
        const behind = [];
        const uncopied = [];
        let rows = 0;
        for (const name of names) {
            const count = database.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`).get().c;
            tables.push({ name, rows: count });
            rows += count;
            const model = expected.tables[name];
            const actual = database.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all();
            if (!model) {
                uncopied.push(name);
                continue;
            }
            const known = new Set(model.columns.map(col => col.name));
            const present = new Set(actual.map(col => col.name));
            for (const col of actual) if (!known.has(col.name)) ahead.push(`${name}.${col.name}`);
            for (const col of model.columns) if (!present.has(col.name)) behind.push({ column: `${name}.${col.name}`, required: col.notNull && !col.hasDefault });
        }
        const missingTables = Object.keys(expected.tables).filter(name => !names.includes(name));
        const pragma = integrity === 'full' ? 'integrity_check' : 'quick_check';
        const check = database.prepare(`PRAGMA ${pragma}`).all().map(row => Object.values(row)[0]);
        return {
            present: true,
            readable: true,
            sizeBytes: stat.size,
            walPresent: fs.existsSync(`${sqlitePath}-wal`),
            userVersion: database.pragma('user_version', { simple: true }),
            tables,
            tableCount: tables.length,
            rows,
            integrity: { mode: pragma, ok: check.length === 1 && check[0] === 'ok' },
            schema: {
                ahead: sorted(ahead),
                behind: sorted(behind.map(item => item.column)),
                behindRequired: sorted(behind.filter(item => item.required).map(item => item.column)),
                missingTables: sorted(missingTables),
                uncopied: sorted(uncopied)
            }
        };
    } catch {
        return { present: true, readable: false, code: 'SOURCE_UNREADABLE', sizeBytes: stat.size };
    } finally {
        database.close();
        removeCreatedSidecars(sidecars);
    }
}

/**
 * A read-only connection to a WAL-mode database with no WAL on disk makes
 * empty `-wal` and `-shm` files it cannot remove again. When nothing had
 * them open (they did not exist before this call) and the WAL is still
 * empty, put the directory back as it was.
 */
function removeCreatedSidecars(sidecars) {
    const [wal, shm] = sidecars;
    try {
        if (!wal.existed && fs.existsSync(wal.file) && fs.statSync(wal.file).size === 0) {
            fs.unlinkSync(wal.file);
            if (!shm.existed && fs.existsSync(shm.file)) fs.unlinkSync(shm.file);
        }
    } catch { }
}

function defaultConnect(url) {
    const { Client } = require('pg');
    return new Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, statement_timeout: 15000 });
}

/**
 * @param {string} url
 * @param {{ connect?: (url: string) => { connect: Function, query: Function, end: Function } }} [deps] test seam
 */
async function inspectPostgres(url, { connect = defaultConnect } = {}) {
    const description = describeTarget(url);
    const base = publicTarget(description);
    const client = connect(url);
    client.on?.('error', () => { });
    try {
        await client.connect();
    } catch (error) {
        return { ...base, reachable: false, code: causeOf(error) };
    }
    try {
        await client.query('BEGIN READ ONLY');
        const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
        const me = (await client.query(
            `SELECT current_user AS "user", current_database() AS database, current_schema() AS schema,
                    COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS super`
        )).rows[0];
        const wanted = description.schema || me.schema;
        const schemaRow = wanted
            ? (await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [wanted])).rowCount > 0
            : false;
        const privileges = (await client.query(
            `SELECT has_database_privilege(current_database(), 'CREATE') AS database_create,
                    CASE WHEN $1::text IS NULL THEN false ELSE COALESCE(has_schema_privilege($1::text, 'CREATE'), false) END AS schema_create`,
            [schemaRow ? wanted : null]
        )).rows[0];
        const relations = schemaRow
            ? Number((await client.query(
                `SELECT COUNT(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`, [wanted]
            )).rows[0].n)
            : 0;
        const extensions = {};
        const available = (await client.query(
            `SELECT a.name, a.installed_version, COALESCE(v.trusted, false) AS trusted
             FROM pg_available_extensions a
             LEFT JOIN pg_available_extension_versions v ON v.name = a.name AND v.version = a.default_version
             WHERE a.name = ANY($1::text[])`, [REQUIRED_EXTENSIONS]
        )).rows;
        for (const name of REQUIRED_EXTENSIONS) {
            const row = available.find(item => item.name === name);
            extensions[name] = { available: Boolean(row), installed: Boolean(row && row.installed_version), trusted: Boolean(row && row.trusted) };
        }
        const space = await freeSpace(client, description.local);
        await client.query('ROLLBACK');
        return {
            ...base,
            reachable: true,
            serverVersion: version,
            user: me.user,
            database: me.database,
            currentSchema: me.schema,
            schema: schemaRow ? wanted : (description.schema || null),
            schemaExists: schemaRow,
            isSuperuser: Boolean(me.super),
            canCreateInDatabase: Boolean(privileges.database_create),
            canCreateInSchema: Boolean(privileges.schema_create),
            relationCount: relations,
            extensions,
            freeBytes: space
        };
    } catch (error) {
        return { ...base, reachable: false, code: causeOf(error) };
    } finally {
        try { await client.query('ROLLBACK'); } catch { }
        try { await client.end(); } catch { }
    }
}

/** Free bytes under the server's data directory, only when the server is local; otherwise null (unknown). */
async function freeSpace(client, local) {
    if (!local) return null;
    try {
        const dir = (await client.query('SHOW data_directory')).rows[0].data_directory;
        const stats = fs.statfsSync(dir);
        return Number(stats.bavail) * Number(stats.bsize);
    } catch {
        return null;
    }
}

function causeOf(error) {
    const code = error && (error.code || (Array.isArray(error.errors) && error.errors[0] && error.errors[0].code));
    return String(code || 'CONNECT_FAILED').slice(0, 40);
}

/**
 * Blocks, provisioning and warnings from the two reports. Pure.
 * @returns {{ blocks: Object[], provisioning: Object[], warnings: Object[] }}
 */
function classify({ source, target, options = {} }) {
    const blocks = [];
    const provisioning = [];
    const warnings = [];
    const block = (code, detail = {}) => blocks.push({ code, detail });
    const warn = (code, detail = {}) => warnings.push({ code, detail });

    if (!source.present) block('SOURCE_MISSING');
    else if (!source.readable) block('SOURCE_UNREADABLE');
    else {
        if (!source.integrity.ok) block('SOURCE_INTEGRITY', { mode: source.integrity.mode });
        if (source.schema.ahead.length) block('SOURCE_SCHEMA_AHEAD', { columns: source.schema.ahead });
        if (source.schema.behindRequired.length) block('SOURCE_SCHEMA_BEHIND', { columns: source.schema.behindRequired });
        if (source.schema.behind.length || source.schema.missingTables.length) {
            warn('SOURCE_SCHEMA_BEHIND', { columns: source.schema.behind, tables: source.schema.missingTables });
        }
        if (source.schema.uncopied.length) warn('UNCOPIED_TABLE', { tables: source.schema.uncopied });
        if (source.tableCount === 0) warn('SOURCE_EMPTY');
    }

    if (!target.reachable) {
        block('TARGET_UNREACHABLE', { cause: target.code || 'CONNECT_FAILED' });
    } else {
        if (target.serverVersion < MIN_SERVER_VERSION) block('SERVER_TOO_OLD', { version: target.serverVersion, minimum: MIN_SERVER_VERSION });
        if (!target.schema || !target.schemaExists) {
            block('TARGET_SCHEMA_MISSING');
        } else {
            if (target.relationCount > 0) block('TARGET_NOT_EMPTY', { relations: target.relationCount });
            if (!target.canCreateInSchema) block('TARGET_NO_CREATE_PRIVILEGE', { scope: 'schema' });
        }
        for (const name of REQUIRED_EXTENSIONS) {
            const ext = target.extensions[name];
            if (!ext.available) {
                block('EXTENSION_UNAVAILABLE', { extension: name });
            } else if (!ext.installed) {
                if (!target.canCreateInDatabase || !(target.isSuperuser || ext.trusted)) {
                    block('EXTENSION_PRIVILEGE', { extension: name });
                } else {
                    provisioning.push({ code: 'EXTENSION_NOT_INSTALLED', extension: name, action: `CREATE EXTENSION ${name}` });
                }
            }
        }
        if (source.present && source.readable && target.freeBytes != null) {
            if (target.freeBytes < source.sizeBytes * SPACE_BLOCK_FACTOR) block('INSUFFICIENT_SPACE', { freeBytes: target.freeBytes, sourceBytes: source.sizeBytes });
            else if (target.freeBytes < source.sizeBytes * SPACE_WARN_FACTOR) warn('LOW_SPACE', { freeBytes: target.freeBytes, sourceBytes: source.sizeBytes });
        }
    }
    if (options.alreadyPostgres) block('ALREADY_POSTGRES');
    return { blocks, provisioning, warnings };
}

/** Both endpoints and the verdict. Read-only. */
async function inspectAll({ sqlitePath, url, integrity = 'quick', connect, alreadyPostgres = false }) {
    const source = inspectSqlite(sqlitePath, { integrity });
    const target = await inspectPostgres(url, { connect });
    const verdict = classify({ source, target, options: { alreadyPostgres } });
    return {
        source: source.readable ? { ...source, tables: undefined } : source,
        sourceTables: source.readable ? source.tables : [],
        target,
        ...verdict,
        estimate: {
            tables: source.readable ? source.tableCount : 0,
            rows: source.readable ? source.rows : 0,
            sourceBytes: source.sizeBytes || 0
        }
    };
}

module.exports = { inspectSqlite, inspectPostgres, classify, inspectAll, REQUIRED_EXTENSIONS, MIN_SERVER_VERSION };
