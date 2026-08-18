/**
 * Jest global teardown: remove the placeholder config.json created by
 * globalSetup (a developer's real config.json is never touched).
 */
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

module.exports = async () => {
    if (globalThis.__GOOBSTER_JEST_CREATED_CONFIG__) {
        try {
            fs.unlinkSync(CONFIG_PATH);
        } catch { /* already gone */ }
    }

    // Postgres matrix runs: drop the per-suite isolation schemas the pg
    // adapter created (test_<pid>_<random>, the throwaway-GOOBSTER_DB_PATH
    // equivalent). Workers are already gone, so nothing holds them open.
    if (process.env.GOOBSTER_DB_URL && process.env.GOOBSTER_PG_TEST_ISOLATE === '1') {
        const { Client } = require('pg');
        const client = new Client({ connectionString: process.env.GOOBSTER_DB_URL });
        try {
            await client.connect();
            const { rows } = await client.query(
                "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test\\_%'"
            );
            // One DROP per statement: a single transaction over a hundred
            // schemas exceeds max_locks_per_transaction.
            for (const { nspname } of rows) {
                try {
                    await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
                } catch (error) {
                    console.warn(`[jest teardown] Could not drop ${nspname}:`, error.message);
                }
            }
        } catch (error) {
            console.warn('[jest teardown] Could not drop test schemas:', error.message);
        } finally {
            try { await client.end(); } catch { /* never connected */ }
        }
    }
};
