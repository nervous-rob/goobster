/**
 * Database initialization script (SQLite edition).
 *
 * The schema in db/schema.sql is applied automatically whenever the database
 * is opened, so a plain `npm run db-init` simply creates the database file and
 * all tables. Pass --reset to drop and recreate everything (destructive!).
 */

const { getDb, closeConnection } = require('./db');

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
        const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
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
}

if (require.main === module) {
    initDb()
        .then(() => closeConnection())
        .then(() => console.log('Database initialization completed successfully!'))
        .catch((error) => {
            console.error('Database initialization failed:', error);
            process.exit(1);
        });
}

module.exports = { initDb };
