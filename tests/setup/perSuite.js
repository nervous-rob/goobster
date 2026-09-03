/**
 * Per-suite teardown: close the suite's database handle.
 *
 * Jest resets the module registry per test file but reuses worker
 * processes, so without this every suite leaks its connection pool on the
 * Postgres matrix (116 suites quickly exhaust max_connections and later
 * suites hang on connect). Harmless on SQLite - closing is idempotent and
 * each suite opened its own throwaway file anyway.
 *
 * Isolated PG schemas apply the full schema.sql on the suite's first query.
 * That bootstrap regularly exceeds Jest's 5s default hook timeout on CI
 * (parlor beforeEach, chatDb beforeAll, and similar first-touch hooks).
 */
if (process.env.GOOBSTER_DB_URL) {
    jest.setTimeout(20_000);
}

afterAll(async () => {
    try {
        await require('@goobster/core/db').closeConnection();
    } catch { /* suite never opened a db */ }
});
