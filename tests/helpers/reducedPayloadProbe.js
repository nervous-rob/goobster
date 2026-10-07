/**
 * Dormant-data probe for a reduced payload (#328). Runs as a child process
 * inside a tree built by tests/helpers/reducedTree.js, under the
 * loadRecorder preload, against the database the environment names (a
 * throwaway SQLite file, or an isolated Postgres schema). It seeds two
 * accounts across every feature table, then runs the real report, audit,
 * account export and erasure for account A while the feature modules that
 * own most of those rows are not on disk.
 *
 * Writes a summary (counts, table names and booleans; never row contents)
 * to GOOBSTER_PROBE_OUT.
 *
 * Usage: node --require tests/helpers/loadRecorder.js tests/helpers/reducedPayloadProbe.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const out = process.env.GOOBSTER_PROBE_OUT;

async function main() {
    const db = require('@goobster/core/db');
    const privacyService = require('@goobster/core/services/privacyService');
    const memoryService = require('@goobster/core/services/memoryService');
    const { AccountExportService } = require('@goobster/core/services/accountExportService');
    const { INVENTORY } = require('@goobster/core/services/accountExportData');
    const { A, B, GUILD, TABLES, SECRETS, CONTENT, expectedRows, createDormantSeed, unpackTarGz } = require('./dormantSeed');
    const seed = createDormantSeed(db);

    await db.getConnection();
    await seed.seedAccount(A, 'A');
    await seed.seedAccount(B, 'B');
    await memoryService.syncVecIndex();

    const seeded = [];
    for (const entry of TABLES) {
        if (await seed.countOf(entry.table, entry.column, A) === expectedRows(entry, A)
            && await seed.countOf(entry.table, entry.column, B) === expectedRows(entry, B)) seeded.push(entry.table);
    }
    const beforeB = await seed.captureFor(B);

    const report = await privacyService.buildUserReport({ guildId: GUILD, userId: A });
    const reportText = JSON.stringify(report);

    const auditMissing = {};
    for (const userId of [A, B]) {
        const audit = await privacyService.auditUser({ userId });
        auditMissing[userId === A ? 'A' : 'B'] = TABLES
            .filter(entry => expectedRows(entry, userId) > 0 && !(audit.byTable[entry.audit || entry.table] > 0))
            .map(entry => entry.table);
    }

    const exporter = new AccountExportService({
        autoKick: false,
        root: path.join(process.env.GOOBSTER_DATA_DIR, 'exports'),
        settings: async () => ({ schemaVersion: 1, settings: {} })
    });
    const job = await exporter.request(A);
    await exporter.sweep();
    const ready = (await exporter.list(A)).exports.find(entry => entry.id === job.id);
    let exportSummary = { status: ready?.status || null };
    if (ready?.status === 'READY') {
        const download = await exporter.download(A, job.id);
        await download.handle.close();
        const files = await unpackTarGz(path.join(exporter.directory({ ...job, userId: A }), 'account.tar.gz'));
        const text = [...files.values()].map(buffer => buffer.toString()).join('\n');
        const exportable = new Set(INVENTORY.map(([table]) => table));
        exportSummary = {
            status: ready.status,
            missingTables: TABLES
                .filter(({ table }) => exportable.has(table))
                .filter(({ table }) => !(files.get(`data/${table}.json`)?.toString() || '').includes(A))
                .map(({ table }) => table),
            carriesOtherAccount: text.includes('person-b') || text.includes(B),
            carriesOwnContent: CONTENT.every(item => text.includes(item)),
            secrets: SECRETS.filter(secret => text.includes(secret))
        };
    }
    await exporter.stop();

    const totals = {};
    for (const { table } of TABLES) totals[table] = await seed.totalOf(table);
    const vecBefore = await seed.vecOrphans();
    const forgot = Boolean(await privacyService.forgetUser({ userId: A }));
    const remainingA = [];
    const wrongTotals = [];
    for (const entry of TABLES) {
        if (await seed.countOf(entry.table, entry.column, A) !== 0) remainingA.push(entry.table);
        const lost = entry.kept ? 0 : expectedRows(entry, A);
        if (await seed.totalOf(entry.table) !== totals[entry.table] - lost) wrongTotals.push(entry.table);
    }
    const afterB = await seed.captureFor(B);
    const changedB = TABLES.map(({ table }) => table)
        .filter(table => JSON.stringify(beforeB[table]) !== JSON.stringify(afterB[table]));
    const vecAfter = await seed.vecOrphans();

    await db.closeConnection();
    return {
        engine: db.engine,
        seeded: seeded.length,
        tables: TABLES.length,
        report: {
            observatory: report.observatory || null,
            spitball: report.spitball ? { expeditions: report.spitball.expeditions, briefs: report.spitball.briefs?.total ?? null } : null,
            developerIntegrations: report.developerIntegrations || null,
            secrets: [...SECRETS, ...CONTENT].filter(secret => reportText.includes(secret))
        },
        auditMissing,
        export: exportSummary,
        forget: { ok: forgot, remainingA, wrongTotals, changedB, vecBefore, vecAfter }
    };
}

main().then((summary) => {
    fs.writeFileSync(out, JSON.stringify(summary));
    process.exit(0);
}, (error) => {
    fs.writeFileSync(out, JSON.stringify({ error: { code: error?.code || null, message: String(error?.message || error).slice(0, 500) } }));
    process.exit(1);
});
