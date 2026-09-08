/**
 * Isolate live provider checks from the operator's real SQLite file.
 * Usage logging is best-effort; a locked production DB must not fail a ping.
 */
const os = require('node:os');
const path = require('node:path');

process.env.GOOBSTER_DB_PATH = path.join(
    os.tmpdir(),
    `goobster-live-${process.pid}.sqlite`
);
