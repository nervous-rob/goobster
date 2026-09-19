/**
 * Database initialization script (SQLite edition).
 *
 * The schema in db/schema.sql is applied automatically whenever the database
 * is opened, so a plain `npm run db-init` simply creates the database file and
 * all tables. Pass --reset to drop and recreate everything (destructive!).
 */

const { getDb, closeConnection } = require('@goobster/core/db');

const RESET = process.argv.includes('--reset');

// Drop order respects foreign key dependencies (children before parents).
const DROP_ORDER = [
    'messages',
    'conversation_summaries',
    'conversations',
    'guild_conversations',
    'prompts',
    'system_logs',
    'automations',
    'user_nicknames',
    'UserPreferences',
    'guild_settings',
    'users',
];

async function initDb() {
    const db = getDb();

    if (RESET) {
        console.log('Resetting database (dropping all tables)...');
        db.pragma('foreign_keys = OFF');
        for (const table of DROP_ORDER) {
            db.exec(`DROP TABLE IF EXISTS ${table};`);
            console.log(`Dropped table (if existed): ${table}`);
        }
        db.pragma('foreign_keys = ON');

        // Re-apply schema after the drop.
        const fs = require('node:fs');
        const path = require('node:path');
        const schema = fs.readFileSync(path.join(__dirname, '..', 'packages', 'core', 'db', 'schema.sql'), 'utf8');
        db.exec(schema);
    }

    const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => row.name);

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
    initDb()
        .then(async () => await closeConnection())
        .then(() => console.log('Database initialization completed successfully!'))
        .catch((error) => {
            console.error('Database initialization failed:', error);
            process.exit(1);
        });
}

module.exports = { initDb };
