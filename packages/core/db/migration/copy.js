/**
 * The copy: SQLite source -> an empty Postgres target through the database
 * facade (extracted from scripts/migrate-to-postgres.js).
 *
 * One transaction per table. A table is `copying` in the progress record
 * before its transaction starts and `done` (with its row count) after it
 * commits, so a crash leaves a table either absent of rows or complete, and
 * the record says which. Resuming skips the `done` tables after checking
 * their target row counts, and for a table that is not `done` deletes the
 * rows the operation itself may have written (`DELETE FROM`, never
 * TRUNCATE ... CASCADE, and only for tables this progress record marks
 * incomplete) before copying it again. Identity sequences are re-seated
 * last; vector index tables are derived data and never copied.
 */

const { MigrationError } = require('./errors');
const { expectedSchema, quoteIdent } = require('./schemaModel');

const DEFAULT_BATCH_ROWS = 500;
const MAX_PARAMS = 30000;

/**
 * The tables to copy and the columns of each: expected-schema order, only
 * tables the source has, only columns both sides have.
 * @returns {{ tables: Array<{ name: string, columns: string[], rows: number }>, skipped: string[] }}
 */
function planCopy(source) {
    const model = expectedSchema();
    const present = new Set(source.tables());
    const tables = [];
    for (const name of model.order) {
        if (!present.has(name)) continue;
        const known = new Set(model.tables[name].columns.map(col => col.name));
        const columns = source.columns(name).filter(col => known.has(col));
        tables.push({ name, columns, rows: source.count(name) });
    }
    const skipped = [...present].filter(name => !model.tables[name] && !name.startsWith('sqlite_') && !name.startsWith('memory_vec_')).sort();
    return { tables, skipped };
}

function newProgress(plan) {
    return { order: plan.tables.map(table => table.name), tables: {}, reseated: false };
}

/**
 * @param {Object} params
 * @param {Object} params.source an openSource() handle (read transaction pinned by the caller)
 * @param {Object} params.target the async database facade, selected for Postgres
 * @param {{ tables: Array, skipped: string[] }} params.plan planCopy() result
 * @param {Object|null} [params.resume] the progress record of an earlier attempt
 * @param {(event: Object) => (void|Promise<void>)} [params.onProgress] awaited; the caller makes `event.progress` durable
 */
async function copyTables({ source, target, plan, batchSize = DEFAULT_BATCH_ROWS, onProgress = async () => { }, resume = null }) {
    const progress = resume && Array.isArray(resume.order) ? resume : newProgress(plan);
    if (JSON.stringify(progress.order) !== JSON.stringify(plan.tables.map(table => table.name))) {
        throw new MigrationError('PROGRESS_INCONSISTENT', 'The recorded copy progress is for a different table list; roll back and start again.');
    }
    const emit = (event) => onProgress({ ...event, progress, total: plan.tables.length });
    let rows = 0;
    const resumed = [];
    const recopied = [];

    for (const table of plan.tables) {
        const entry = progress.tables[table.name];
        if (entry && entry.state === 'done') {
            const have = await countTarget(target, table.name);
            if (have !== entry.rows || have !== table.rows) {
                throw new MigrationError('PROGRESS_INCONSISTENT', 'A table recorded as copied does not hold the recorded rows.', { table: table.name });
            }
            rows += entry.rows;
            resumed.push(table.name);
            continue;
        }
        progress.tables[table.name] = { state: 'copying', rows: 0 };
        await emit({ table: table.name, state: 'started', rows: table.rows });
        const copied = await copyOne({ source, target, table, batchSize });
        if (copied.deleted > 0) recopied.push(table.name);
        progress.tables[table.name] = { state: 'done', rows: copied.rows };
        rows += copied.rows;
        await emit({ table: table.name, state: 'done', rows: copied.rows });
    }

    const reseated = await reseatIdentities(target, plan.tables.map(table => table.name));
    progress.reseated = true;
    await emit({ table: null, state: 'reseated', rows: reseated.length });
    return { tables: plan.tables.length, rows, resumed, recopied, reseated: reseated.length, skipped: plan.skipped };
}

async function countTarget(target, name) {
    const row = await target.get(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`);
    return Number(row.c);
}

async function copyOne({ source, target, table, batchSize }) {
    const per = Math.max(1, Math.min(batchSize, Math.floor(MAX_PARAMS / Math.max(1, table.columns.length))));
    const columnList = table.columns.map(quoteIdent).join(', ');
    let copied = 0;
    let deleted = 0;
    await target.transaction(async () => {
        deleted = Number((await target.run(`DELETE FROM ${quoteIdent(table.name)}`)).changes || 0);
        let batch = [];
        const flush = async () => {
            if (batch.length === 0) return;
            const params = {};
            const groups = batch.map((row, r) => `(${table.columns.map((col, c) => {
                const key = `v${r}_${c}`;
                params[key] = row[col];
                return `@${key}`;
            }).join(', ')})`);
            await target.run(`INSERT INTO ${quoteIdent(table.name)} (${columnList}) VALUES ${groups.join(', ')}`, params);
            copied += batch.length;
            batch = [];
        };
        for (const row of source.rows(table.name, table.columns)) {
            batch.push(row);
            if (batch.length >= per) await flush();
        }
        await flush();
    });
    return { rows: copied, deleted };
}

/** Identity columns on the target: `[{ table, column }]`. */
async function identityColumns(target) {
    const rows = await target.all(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND is_identity = 'YES'
         ORDER BY table_name, column_name`
    );
    return rows.map(row => ({ table: row.table_name, column: row.column_name }));
}

/** Re-seat every identity sequence to MAX(column) + 1 (idempotent). */
async function reseatIdentities(target, tables) {
    const wanted = new Set(tables);
    const done = [];
    for (const { table, column } of await identityColumns(target)) {
        if (!wanted.has(table)) continue;
        await target.rawQuery(
            `SELECT setval(pg_get_serial_sequence($1, $2), (SELECT COALESCE(MAX(${quoteIdent(column)}), 0) + 1 FROM ${quoteIdent(table)}), false)`,
            [quoteIdent(table), column]
        );
        done.push({ table, column });
    }
    return done;
}

module.exports = { planCopy, copyTables, reseatIdentities, identityColumns, newProgress, DEFAULT_BATCH_ROWS };
