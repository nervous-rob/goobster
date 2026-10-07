/**
 * Database initialization script.
 *
 * The schema in db/schema.sql is applied automatically whenever the database
 * is opened, so a plain `npm run db-init` simply creates the database (a
 * SQLite file, or the Postgres schema GOOBSTER_DB_URL names) with all its
 * tables and seeds Goobster's self-documentation. It only initialises.
 *
 * Emptying an installation is a different, guarded operation: the manager's
 * `data.reset` (`goobster-manager reset`, documentation/data_reset.md), which
 * runs behind the maintenance barrier, after a verified backup and a typed
 * confirmation. The old `--reset` flag of this script is gone.
 */

const db = require('@goobster/core/db');

async function initDb() {
    const tables = await db.listTables();

    console.log(`Database initialized with ${tables.length} tables:`);
    for (const table of tables) {
        console.log(`  - ${table}`);
    }

    // Goobster's own documentation (the consultDocs corpus). Idempotent;
    // the bot repeats it on every start, so a failure here is not fatal.
    try {
        const selfDocsService = require('@goobster/core/services/selfDocsService');
        if (selfDocsService.enabled) {
            const seeded = await selfDocsService.seed();
            if (seeded.acquired) {
                console.log(`Seeded self-documentation: ${seeded.docs} document(s), ${seeded.chunks} chunk(s)`);
            }
        }
    } catch (error) {
        console.warn('Self-documentation seeding skipped:', error.message);
    }
}

if (require.main === module) {
    if (process.argv.includes('--reset')) {
        console.error('db-init no longer resets a database. Use the manager: goobster-manager reset --dry-run (documentation/data_reset.md).');
        process.exit(2);
    }
    initDb()
        .then(async () => await db.closeConnection())
        .then(() => console.log('Database initialization completed successfully!'))
        .catch((error) => {
            console.error('Database initialization failed:', error);
            process.exit(1);
        });
}

module.exports = { initDb };
