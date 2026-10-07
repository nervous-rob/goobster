#!/usr/bin/env node
/**
 * Developer SQLite -> Postgres migrator.
 *
 * Copies every table from a SQLite file into an EMPTY Postgres database
 * (it refuses a non-empty one), re-seats identity sequences, verifies counts,
 * foreign keys, identities, relationships, sampled content and attachment
 * references, and rebuilds the derived vector index (memory_vec_* tables are
 * never copied). It is built on the same modules the manager's `db.migrate`
 * operation uses (packages/core/db/migration).
 *
 * It is NOT the supported way to migrate an installation. It does not hold
 * the maintenance barrier, does not take or verify a backup, does not hold a
 * consistent read-only source, does not start the application for
 * validation, does not switch any configuration and cannot resume: a failed
 * run leaves the tables it finished. For an installation use
 *
 *     node apps/manager/cli.js migrate preflight --answers <file>
 *     node apps/manager/cli.js migrate run --answers <file> --confirm <id>
 *
 * (documentation/db_migration.md). Stop the application first.
 *
 * Usage:
 *   GOOBSTER_DB_PATH=data/goobster.sqlite \
 *   GOOBSTER_DB_URL=postgres://user:pass@host:5432/goobster \
 *   npm run migrate-to-postgres
 */

const path = require('node:path');

async function main() {
    const url = process.env.GOOBSTER_DB_URL;
    if (!url) {
        console.error('Set GOOBSTER_DB_URL to the target Postgres database.');
        process.exit(64);
    }
    const { dataDir } = require('@goobster/core/runtimePaths');
    const sqlitePath = process.env.GOOBSTER_DB_PATH || path.join(dataDir, 'goobster.sqlite');
    const migration = require('@goobster/core/db/migration');

    console.log('Developer migration: no maintenance barrier, no backup, no configuration switch (see documentation/db_migration.md).');
    const where = migration.describeTarget(url);
    console.log(`Target: ${where.host}:${where.port}/${where.database}${where.schema ? ` (schema ${where.schema})` : ''}`);

    const db = require('@goobster/core/db');
    if (db.engine !== 'postgres') {
        console.error('GOOBSTER_DB_URL did not select the Postgres adapter.');
        process.exit(64);
    }
    // The normal adapter applies the schema (one source of truth for the DDL).
    await db.get('SELECT 1 AS ok');

    const source = migration.openSource(sqlitePath);
    try {
        source.pin();
        const plan = migration.planCopy(source);
        for (const table of plan.tables) {
            const { c } = await db.get(`SELECT COUNT(*) AS c FROM ${migration.schemaModel.quoteIdent(table.name)}`);
            if (Number(c) > 0) {
                console.error(`Target table ${table.name} already has ${c} row(s) - refusing to migrate into a non-empty database.`);
                process.exitCode = 1;
                return;
            }
        }
        const result = await migration.copyTables({
            source,
            target: db,
            plan,
            onProgress: async (event) => {
                if (event.state === 'done' && event.rows > 0) console.log(`  ${event.table}: ${event.rows} row(s)`);
            }
        });
        const report = await migration.verifyMigration({ source, target: db, plan, dataDir });
        if (!report.ok) {
            console.error(`\nVerification failed: ${report.failures.join(', ')}.`);
            process.exitCode = 1;
            return;
        }
        console.log(`\nMigrated ${result.rows} row(s) across ${result.tables} table(s); counts, foreign keys, identities, relationships, sampled content and attachments verified.`);
        if (report.vectors.rebuilt) console.log(`Vector index rebuilt: ${report.vectors.indexed} of ${report.vectors.embeddings} embedding(s).`);
        else console.log('The vector index rebuilds itself from memory_embeddings on first recall.');
    } finally {
        source.close();
        await db.closeConnection();
    }
}

main().catch((error) => {
    const { redactText } = require('@goobster/core/db/migration').target;
    console.error('Migration failed:', redactText(error && (error.code || error.message || error), [process.env.GOOBSTER_DB_URL]));
    process.exit(1);
});
