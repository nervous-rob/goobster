/**
 * Child process of the migration (documentation/db_migration.md). The
 * manager never opens the application database, so every step that touches
 * one - reading the SQLite source, applying the schema, copying, verifying,
 * the backup - runs here, one operation per process (`runChild.js` starts it
 * the way install/dbInit.js starts its child).
 *
 *   stdin    one JSON request: { op, ...parameters }. The backup passphrase
 *            travels here, never on an argument list and never in the
 *            environment. The database selection comes from the environment
 *            (GOOBSTER_DB_URL for Postgres, GOOBSTER_DB_PATH for SQLite), the
 *            same way it does for the application.
 *   stdout   lines prefixed with MARK carrying JSON: { event: 'progress', ... },
 *            then one { event: 'result', ... } or { event: 'error', code }.
 *            Anything else on stdout (the adapters log) is ignored.
 *   stderr   not read; nothing secret is ever written to it deliberately.
 *
 * Results carry names, counts and booleans. An error carries a short code
 * only: never a message (a driver message can quote a row or a URL).
 */

const path = require('node:path');
const fs = require('node:fs');

const MARK = '@@goobster-migrate@@ ';
const CODE = /^[A-Za-z0-9_]{1,60}$/;

function emit(payload) {
    process.stdout.write(`${MARK}${JSON.stringify(payload)}\n`);
}

function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', chunk => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}

function writeProgress(file, doc) {
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
        fs.writeSync(fd, `${JSON.stringify(doc)}\n`);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

function readProgress(file) {
    try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        return doc && typeof doc === 'object' && Array.isArray(doc.order) ? doc : null;
    } catch {
        return null;
    }
}

const OPS = {
    async inspect({ sqlitePath, url, integrity = 'quick', alreadyPostgres = false }) {
        const { inspectAll } = require('@goobster/core/db/migration/inspect');
        return inspectAll({ sqlitePath, url, integrity, alreadyPostgres });
    },

    async backup({ destDir, passphrase = null, includeConfig = true }) {
        const backupService = require('@goobster/core/services/backupService');
        const runtimePaths = require('@goobster/core/runtimePaths');
        const { dir, manifest } = await backupService.createBackup({
            destDir,
            passphrase,
            includeConfig,
            dataDir: runtimePaths.dataDir,
            configPath: runtimePaths.configJsonPath,
            logger: { info() { }, warn() { }, error() { } }
        });
        const counts = await backupService.tableCounts();
        let problems = [];
        try {
            backupService.verifyBackup(dir, { expectCounts: counts });
        } catch (error) {
            if (!error || error.code !== 'UNVERIFIED') throw error;
            problems = Array.isArray(error.problems) ? error.problems : ['UNVERIFIED'];
        }
        const exempt = backupService.COUNT_EXEMPT;
        return {
            archive: path.basename(dir),
            verified: problems.length === 0,
            fingerprintMatches: !problems.includes('FINGERPRINT_MISMATCH'),
            mismatchedTables: problems.filter(code => code.startsWith('COUNT_MISMATCH:')).slice(0, 20).map(code => code.slice('COUNT_MISMATCH:'.length)),
            tables: Object.keys(counts).filter(name => !exempt.has(name)).length,
            rows: Object.entries(counts).filter(([name]) => !exempt.has(name)).reduce((sum, [, n]) => sum + n, 0),
            configIncluded: Boolean(manifest.config && manifest.config.included),
            files: (manifest.files || []).reduce((sum, set) => sum + (set.files || 0), 0)
        };
    },

    async snapshot({ sqlitePath }) {
        const { inspectSqlite } = require('@goobster/core/db/migration/inspect');
        const { hashSource } = require('@goobster/core/db/migration/source');
        const report = inspectSqlite(sqlitePath, { integrity: 'full' });
        if (!report.readable) throw Object.assign(new Error('source'), { code: report.code });
        if (!report.integrity.ok) throw Object.assign(new Error('integrity'), { code: 'SOURCE_INTEGRITY' });
        const hash = hashSource(sqlitePath);
        return { sha256: hash.sha256, bytes: hash.bytes, tables: report.tableCount, rows: report.rows, integrity: report.integrity.mode };
    },

    async extensions({ url, extensions = [], expectEmpty = true }) {
        const { REQUIRED_EXTENSIONS } = require('@goobster/core/db/migration/inspect');
        const { Client } = require('pg');
        const created = [];
        const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
        await client.connect();
        try {
            const schema = (await client.query('SELECT current_schema() AS s')).rows[0].s;
            if (expectEmpty) {
                const found = await client.query(
                    `SELECT COUNT(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`, [schema]
                );
                if (Number(found.rows[0].n) > 0) throw Object.assign(new Error('target'), { code: 'TARGET_NOT_EMPTY' });
            }
            for (const name of extensions) {
                if (!REQUIRED_EXTENSIONS.includes(name)) throw Object.assign(new Error('extension'), { code: 'EXTENSION_NOT_ALLOWED' });
                const installed = await client.query('SELECT 1 FROM pg_extension WHERE extname = $1', [name]);
                if (installed.rowCount > 0) continue;
                await client.query(`CREATE EXTENSION ${name} WITH SCHEMA public`);
                created.push(name);
            }
            return { extensionsCreated: created, schema };
        } finally {
            await client.end().catch(() => { });
        }
    },

    async schema() {
        const db = require('@goobster/core/db');
        if (db.engine !== 'postgres') throw Object.assign(new Error('engine'), { code: 'NOT_POSTGRES' });
        await db.get('SELECT 1 AS ok');
        const schema = (await db.get('SELECT current_schema() AS s')).s;
        const tables = await db.listTables({ includeDerived: true });
        await db.closeConnection();
        return { tables, schema };
    },

    async copy({ sqlitePath, progressFile, sourceSha256 }) {
        const migration = require('@goobster/core/db/migration');
        const db = require('@goobster/core/db');
        if (db.engine !== 'postgres') throw Object.assign(new Error('engine'), { code: 'NOT_POSTGRES' });
        await db.get('SELECT 1 AS ok');
        if (migration.hashSource(sqlitePath).sha256 !== sourceSha256) throw Object.assign(new Error('changed'), { code: 'SOURCE_CHANGED' });
        const source = migration.openSource(sqlitePath);
        try {
            source.pin();
            const plan = migration.planCopy(source);
            const result = await migration.copyTables({
                source,
                target: db,
                plan,
                resume: readProgress(progressFile),
                onProgress: async (event) => {
                    writeProgress(progressFile, event.progress);
                    emit({ event: 'progress', table: event.table, state: event.state, rows: event.rows, done: Object.values(event.progress.tables).filter(item => item.state === 'done').length, total: event.total });
                }
            });
            if (migration.hashSource(sqlitePath).sha256 !== sourceSha256) throw Object.assign(new Error('changed'), { code: 'SOURCE_CHANGED' });
            return result;
        } finally {
            source.close();
            await db.closeConnection();
        }
    },

    async verify({ sqlitePath, dataDir, sourceSha256 }) {
        const migration = require('@goobster/core/db/migration');
        const db = require('@goobster/core/db');
        if (db.engine !== 'postgres') throw Object.assign(new Error('engine'), { code: 'NOT_POSTGRES' });
        await db.get('SELECT 1 AS ok');
        if (migration.hashSource(sqlitePath).sha256 !== sourceSha256) throw Object.assign(new Error('changed'), { code: 'SOURCE_CHANGED' });
        const source = migration.openSource(sqlitePath);
        try {
            source.pin();
            const plan = migration.planCopy(source);
            const report = await migration.verifyMigration({ source, target: db, plan, dataDir });
            const tables = await db.listTables({ includeDerived: true });
            return {
                ...report,
                counts: { ...report.counts, mismatched: report.counts.mismatched.slice(0, 20) },
                foreignKeys: { ...report.foreignKeys, orphans: report.foreignKeys.orphans.slice(0, 20) },
                identities: { ...report.identities, problems: report.identities.problems.slice(0, 20) },
                content: { ...report.content, mismatches: report.content.mismatches.slice(0, 20) },
                derivedTables: tables.filter(name => name.startsWith('memory_vec_')),
                unchangedSource: migration.hashSource(sqlitePath).sha256 === sourceSha256
            };
        } finally {
            source.close();
            await db.closeConnection();
        }
    },

    async targetCounts() {
        const db = require('@goobster/core/db');
        if (db.engine !== 'postgres') throw Object.assign(new Error('engine'), { code: 'NOT_POSTGRES' });
        const counts = {};
        for (const table of await db.listTables()) {
            const { quoteIdent } = require('@goobster/core/db/migration/schemaModel');
            counts[table] = Number((await db.get(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`)).c);
        }
        await db.closeConnection();
        return { counts };
    },

    async finalize({ summary }) {
        const db = require('@goobster/core/db');
        if (db.engine !== 'postgres') throw Object.assign(new Error('engine'), { code: 'NOT_POSTGRES' });
        const instanceState = require('@goobster/core/services/instanceStateService');
        await instanceState.pause({ reason: 'migration', by: 'manager db.migrate', detail: { engine: 'postgres' } });
        await instanceState.set('lastMigration', { at: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''), from: 'sqlite', to: 'postgres', ...summary });
        await db.closeConnection();
        return { paused: true };
    },

    async rollback({ url, tables, extensions, schema, allOurs = false }) {
        const { Client } = require('pg');
        const { expectedSchema } = require('@goobster/core/db/migration/schemaModel');
        const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
        await client.connect();
        const dropped = { tables: 0, derived: 0, extensions: [], retained: [] };
        try {
            const current = (await client.query('SELECT current_schema() AS s')).rows[0].s;
            if (current !== schema) throw Object.assign(new Error('schema'), { code: 'TARGET_SCHEMA_CHANGED' });
            const present = (await client.query(
                `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`, [schema]
            )).rows.map(row => row.name);
            const owned = allOurs ? new Set(present) : new Set(tables);
            const derived = present.filter(name => /^memory_vec_\d+$/.test(name));
            const foreign = present.filter(name => !owned.has(name) && !derived.includes(name));
            if (foreign.length > 0) throw Object.assign(new Error('foreign'), { code: 'ROLLBACK_FOREIGN_OBJECTS' });
            const order = expectedSchema().order;
            const ranked = (name) => { const at = order.indexOf(name); return at < 0 ? -1 : at; };
            const doomed = [...present.filter(name => owned.has(name)).sort((a, b) => ranked(b) - ranked(a)), ...derived];
            const quoted = (name) => `"${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`;
            await client.query('BEGIN');
            try {
                for (const name of doomed) await client.query(`DROP TABLE ${quoted(name)}`);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK').catch(() => { });
                throw error;
            }
            dropped.tables = doomed.length - derived.length;
            dropped.derived = derived.length;
            for (const name of extensions) {
                if (!/^[a-z_]{1,30}$/.test(name)) continue;
                try {
                    await client.query(`DROP EXTENSION IF EXISTS ${name}`);
                    dropped.extensions.push(name);
                } catch {
                    dropped.retained.push(name);
                }
            }
        } finally {
            await client.end().catch(() => { });
        }
        return dropped;
    }
};

(async () => {
    try {
        const request = JSON.parse(await readStdin());
        const handler = Object.prototype.hasOwnProperty.call(OPS, request.op) ? OPS[request.op] : null;
        if (!handler) throw Object.assign(new Error('op'), { code: 'UNKNOWN_OP' });
        emit({ event: 'result', ok: true, result: await handler(request) });
    } catch (error) {
        const code = error && typeof error.code === 'string' && CODE.test(error.code) ? error.code : 'CHILD_FAILED';
        emit({ event: 'error', ok: false, code });
        process.exitCode = 1;
    }
})();
