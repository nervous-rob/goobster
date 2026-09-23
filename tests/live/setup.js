/**
 * Isolate live provider checks from the operator's real SQLite file.
 * Usage logging is best-effort; a locked production DB must not fail a ping.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Even when invoked from a Postgres deployment, live probes never touch its DB.
// Keep an empty value (not delete): dotenv must not reload a production URL.
process.env.GOOBSTER_DB_URL = '';
process.env.GOOBSTER_DB_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-live-')),
    'probe.sqlite'
);
