/**
 * Child process of the `init-db` step: open the application database once so
 * the schema applies, count the tables, close, print one JSON line.
 * Environment in, no argument, no secret out: GOOBSTER_DB_PATH or
 * GOOBSTER_DB_URL select the database, exactly as for the application. It
 * runs in its own process so the manager never binds its own database
 * facade to the installation it is creating.
 */

const db = require('@goobster/core/db');

(async () => {
    try {
        await db.get('SELECT 1 AS ok');
        const tables = await db.listTables();
        const engine = db.engine;
        await db.closeConnection();
        process.stdout.write(`${JSON.stringify({ ok: true, engine, tables: tables.length })}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({ ok: false, code: String((error && error.code) || (error && error.name) || 'ERROR').slice(0, 60) })}\n`);
        process.exitCode = 1;
    }
})();
