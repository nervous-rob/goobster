#!/usr/bin/env node
/**
 * Seed Goobster's own documentation into the `self_docs` table.
 *
 *   npm run docs:seed            # parse documentation/** + README.md, upsert changed chunks
 *   npm run docs:seed -- --embed # ...and wait for embeddings (needs an embedding backend)
 *   npm run docs:seed -- --check # parse-only corpus validation, no database (used at image build)
 *   npm run docs:seed -- --stats # print what is in the table
 *
 * The bot runs the same seed on every start (selfDocs.seedOnStartup), so
 * this script exists for image builds, `db-init`, and operators who added
 * notes under data/self-docs/ and want them indexed without a restart.
 */

const args = new Set(process.argv.slice(2));
const selfDocsService = require('@goobster/core/services/selfDocsService');

async function main() {
    if (args.has('--check')) {
        const report = selfDocsService.validateCorpus();
        console.log(`Self-docs corpus: ${report.docs} document(s), ${report.chunks} chunk(s)`);
        for (const problem of report.problems) console.error(`  ! ${problem}`);
        if (!report.ok) {
            console.error('Corpus check failed.');
            process.exitCode = 1;
        } else {
            console.log('Corpus check passed.');
        }
        return;
    }

    const db = require('@goobster/core/db');
    try {
        if (!args.has('--stats')) {
            const result = await selfDocsService.seed();
            if (!result.acquired) {
                console.log('Another process holds the seed lock; nothing to do.');
            } else {
                console.log(`Seeded ${result.docs} document(s) / ${result.chunks} chunk(s): `
                    + `${result.inserted} new, ${result.updated} updated, ${result.deleted} removed, ${result.unchanged} unchanged.`);
            }
            if (args.has('--embed')) {
                const done = await selfDocsService.backfillEmbeddings();
                if (done.error) {
                    console.log(`Embeddings skipped (${done.error}); keyword ranking still works.`);
                } else {
                    console.log(`Embedded ${done.embedded} chunk(s) with ${done.model}; ${done.remaining} remaining.`);
                }
            }
        }
        const stats = await selfDocsService.stats();
        console.log(`Table: ${stats.docs} document(s), ${stats.chunks} chunk(s), ${stats.embedded} embedded`
            + `${stats.embeddingModel ? ` (${stats.embeddingModel})` : ''}`);
        for (const [kind, counts] of Object.entries(stats.byKind)) {
            console.log(`  - ${kind}: ${counts.docs} doc(s), ${counts.chunks} chunk(s)`);
        }
    } finally {
        await db.closeConnection();
    }
}

main().catch((error) => {
    console.error('Self-docs seeding failed:', error);
    process.exit(1);
});
