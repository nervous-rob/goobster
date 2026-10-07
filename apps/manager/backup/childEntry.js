/**
 * Helper process of backup and restore (documentation/backup_and_restore.md).
 * One operation per process, the way ../migration/childEntry.js works:
 *
 *   stdin    one JSON request { op, ...parameters }. A passphrase travels
 *            here, never on an argument list and never in the environment.
 *            The database selection comes from the environment
 *            (GOOBSTER_DB_URL or GOOBSTER_DB_PATH), as it does for the
 *            application.
 *   stdout   lines prefixed with MARK carrying JSON: one { event: 'result',
 *            result } or { event: 'error', code }. Anything else on stdout
 *            (the database adapters log) is ignored.
 *   stderr   not read.
 *
 * An error carries a short code only: a driver message can quote a row, a
 * URL or a path.
 */

const MARK = '@@goobster-backup@@ ';
const CODE = /^[A-Za-z0-9_]{1,60}$/;

function emit(payload) {
    process.stdout.write(`${MARK}${JSON.stringify(payload)}\n`);
}

function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', chunk => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}

(async () => {
    try {
        const { OPS } = require('./ops');
        const request = JSON.parse(await readStdin());
        const handler = Object.prototype.hasOwnProperty.call(OPS, request.op) ? OPS[request.op] : null;
        if (!handler) throw Object.assign(new Error('op'), { code: 'UNKNOWN_OP' });
        emit({ event: 'result', ok: true, result: await handler(request) });
    } catch (error) {
        const code = error && typeof error.code === 'string' && CODE.test(error.code) ? error.code : 'CHILD_FAILED';
        emit({ event: 'error', ok: false, code });
        process.exitCode = 1;
    }
})();
