/**
 * The rollback boundary in one sentence, for the CLI, the preflight output and
 * the documentation. Its own module so that printing it loads no database code.
 */

/** Printed verbatim by the CLI, the preflight output and the documentation. */
const ROLLBACK_LIMIT = 'Rollback to the SQLite source is possible until the first write reaches Postgres. '
    + 'After the maintenance barrier is released and a worker starts on Postgres, the SQLite file is a backup, '
    + 'not a fallback: switching back is a separate restore decision, never automatic.';

module.exports = { ROLLBACK_LIMIT };
