#!/usr/bin/env node
/**
 * One-shot SQLite -> Postgres migrator (reactive port, Phase 2).
 *
 * Copies every table from the SQLite database into an EMPTY Postgres
 * database, inside one transaction, then re-seats identity sequences and
 * verifies row counts per table. Idempotent onto an empty database;
 * refuses a non-empty one. Vector index tables (memory_vec_*) are derived
 * data and deliberately not copied - memoryService.syncVecIndex() rebuilds
 * them from memory_embeddings on first use.
 *
 * Usage:
 *   GOOBSTER_DB_PATH=data/goobster.sqlite \
 *   GOOBSTER_DB_URL=postgres://user:pass@host:5432/goobster \
 *   npm run migrate-to-postgres
 */

const path = require('node:path');
const Database = require('better-sqlite3');

const BATCH_SIZE = 500;

async function main() {
    const url = process.env.GOOBSTER_DB_URL;
    if (!url) {
        console.error('Set GOOBSTER_DB_URL to the target Postgres database.');
        process.exit(64);
    }
    const sqlitePath = process.env.GOOBSTER_DB_PATH
        || path.join(require('@goobster/core/runtimePaths').dataDir, 'goobster.sqlite');

    console.log(`Source: ${sqlitePath}`);
    console.log(`Target: ${url.replace(/:[^:@/]+@/, ':***@')}`);

    const source = new Database(sqlitePath, { readonly: true, fileMustExist: true });

    // Bootstrap the target schema through the normal adapter (same DDL
    // translation the bot itself uses - one source of truth).
    const db = require('@goobster/core/db');
    if (db.engine !== 'postgres') {
        console.error('GOOBSTER_DB_URL did not select the Postgres adapter.');
        process.exit(64);
    }
    await db.get('SELECT 1 AS ok'); // forces schema bootstrap

    const tables = source.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_vec_%'`
    ).all().map(r => r.name);

    // The target must be empty (beyond the schema the adapter just applied).
    for (const table of tables) {
        const { count } = await db.get(`SELECT COUNT(*) AS count FROM ${table}`);
        if (count > 0) {
            console.error(`Target table ${table} already has ${count} row(s) - refusing to migrate into a non-empty database.`);
            process.exit(1);
        }
    }

    const report = [];
    await db.transaction(async () => {
        for (const table of tables) {
            const columns = source.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
            const quotedCols = columns.map(c => (c === c.toLowerCase() ? c : `"${c}"`)).join(', ');
            const params = columns.map(c => `@${c}`).join(', ');
            const insertSql = `INSERT INTO ${table} (${quotedCols}) VALUES (${params})`;

            let copied = 0;
            let batch = [];
            const flush = async () => {
                for (const row of batch) await db.run(insertSql, row);
                copied += batch.length;
                batch = [];
            };
            for (const row of source.prepare(`SELECT * FROM ${table}`).iterate()) {
                batch.push(row);
                if (batch.length >= BATCH_SIZE) await flush();
            }
            await flush();
            report.push({ table, copied });
            if (copied > 0) console.log(`  ${table}: ${copied} row(s)`);
        }

        // Identity columns were inserted with explicit ids; re-seat each
        // sequence so the next insert doesn't collide.
        const identities = await db.all(
            `SELECT table_name, column_name FROM information_schema.columns
             WHERE table_schema = current_schema() AND is_identity = 'YES'`
        );
        for (const { table_name, column_name } of identities) {
            await db.rawQuery(
                `SELECT setval(pg_get_serial_sequence($1, $2), (SELECT COALESCE(MAX("${column_name}") + 0, 0) + 1 FROM ${table_name}), false)`,
                [table_name, column_name]
            );
        }
    });

    // Verify per-table row counts.
    let mismatches = 0;
    for (const { table, copied } of report) {
        const sourceCount = source.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
        const { count: targetCount } = await db.get(`SELECT COUNT(*) AS count FROM ${table}`);
        if (sourceCount !== copied || Number(targetCount) !== sourceCount) {
            console.error(`  MISMATCH ${table}: source=${sourceCount} copied=${copied} target=${targetCount}`);
            mismatches++;
        }
    }

    source.close();
    await db.closeConnection();

    if (mismatches > 0) {
        console.error(`\n✖ ${mismatches} table(s) mismatched.`);
        process.exit(1);
    }
    const total = report.reduce((sum, r) => sum + r.copied, 0);
    console.log(`\n✔ Migrated ${total} row(s) across ${report.length} table(s), all counts verified.`);
    console.log('The vector index rebuilds itself from memory_embeddings on first recall.');
}

main().catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
});
