/**
 * Child process that reads the installation's SQLite file once, read only,
 * and prints one JSON line with the table names and row counts
 * (`GOOBSTER_DB_PATH` names the file). The manager never opens an
 * application database in its own process; `state.js` starts this the way
 * install/dbInit.js starts its child. Names and counts only: no row, no
 * value, no path.
 */

const { inspectSqlite } = require('@goobster/core/db/migration/inspect');

try {
    const report = inspectSqlite(process.env.GOOBSTER_DB_PATH, { integrity: 'quick' });
    const body = report.readable
        ? { present: true, readable: true, tables: report.tables.map(item => ({ name: item.name, rows: item.rows })) }
        : { present: Boolean(report.present), readable: false, code: report.code || 'SOURCE_UNREADABLE' };
    process.stdout.write(`${JSON.stringify(body)}\n`);
} catch {
    process.stdout.write(`${JSON.stringify({ present: true, readable: false, code: 'SOURCE_UNREADABLE' })}\n`);
    process.exitCode = 1;
}
