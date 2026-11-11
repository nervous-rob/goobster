/** Fresh schema parity and narrowly scoped migration logging on both engines. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { COLUMN_MIGRATIONS } = require('@goobster/core/db/migrations');
const { logMigration } = require('@goobster/core/db/migrationLog');

const schemaSql = fs.readFileSync(path.join(__dirname, '../packages/core/db/schema.sql'), 'utf8');

function withProductionLogging(fn) {
    const env = { NODE_ENV: process.env.NODE_ENV, JEST_WORKER_ID: process.env.JEST_WORKER_ID };
    process.env.NODE_ENV = 'production';
    delete process.env.JEST_WORKER_ID;
    try { return fn(); } finally {
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('schema.sql creates every migration column before the adapters can repair it', () => {
    const database = new Database(':memory:');
    try {
        database.exec(schemaSql);
        const missing = COLUMN_MIGRATIONS.filter(([table, column]) =>
            !database.pragma(`table_info(${table})`).some(c => c.name === column));
        expect(missing.map(([table, column]) => `${table}.${column}`)).toEqual([]);
        expect(database.pragma('table_info(kg_nodes)')).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'revision', notnull: 1, dflt_value: '1' }),
            expect.objectContaining({ name: 'generated', notnull: 1, dflt_value: '0' }),
            expect.objectContaining({ name: 'claimStatus', notnull: 1, dflt_value: "'current'" })
        ]));
        database.prepare("INSERT INTO kg_nodes (guildId, label) VALUES ('g', 'note')").run();
        expect(() => database.prepare("UPDATE kg_nodes SET claimStatus = 'bogus'").run()).toThrow(/CHECK/);
    } finally { database.close(); }
});

test('successful migration messages are quiet in tests and retained in production', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        logMigration('[DB] Migrated: test fixture');
        expect(log).not.toHaveBeenCalled();
        withProductionLogging(() => logMigration('[DB] Migrated: production upgrade'));
        expect(log).toHaveBeenCalledWith('[DB] Migrated: production upgrade');
        log.mockClear();
        withProductionLogging(() => {
            process.env.JEST_WORKER_ID = '1';
            logMigration('[DB] Migrated: worker with overridden NODE_ENV');
        });
        expect(log).not.toHaveBeenCalled();
        withProductionLogging(() => {
            process.env.NODE_ENV = 'test';
            logMigration('[DB] Migrated: test child without a Jest worker id');
        });
        expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
});

test('SQLite creates and reopens a fresh database without successful migration messages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-bootstrap-'));
    const oldPath = process.env.GOOBSTER_DB_PATH;
    process.env.GOOBSTER_DB_PATH = path.join(dir, 'fresh.sqlite');
    let adapter;
    jest.isolateModules(() => { adapter = require('@goobster/core/db/sqliteAdapter'); });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        withProductionLogging(() => adapter.getDb());
        await adapter.closeConnection();
        withProductionLogging(() => adapter.getDb());
        expect(log.mock.calls.filter(([message]) => String(message).startsWith('[DB] Migrated:'))).toEqual([]);
    } finally {
        log.mockRestore();
        await adapter.closeConnection();
        if (oldPath === undefined) delete process.env.GOOBSTER_DB_PATH;
        else process.env.GOOBSTER_DB_PATH = oldPath;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const testPostgres = process.env.GOOBSTER_DB_URL ? test : test.skip;
testPostgres('Postgres fresh bootstrap needs no column migrations and retains every declared column', async () => {
    const oldIsolate = process.env.GOOBSTER_PG_TEST_ISOLATE;
    process.env.GOOBSTER_PG_TEST_ISOLATE = '1';
    let adapter;
    let migrationLog;
    jest.isolateModules(() => {
        migrationLog = jest.spyOn(require('@goobster/core/db/migrationLog'), 'logMigration');
        adapter = require('@goobster/core/db/postgresAdapter');
    });
    try {
        const result = await adapter.rawQuery('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()');
        const columns = new Set(result.rows.map(row => `${row.table_name}.${row.column_name}`));
        expect(COLUMN_MIGRATIONS.map(([table, column]) => `${table}.${column}`).filter(key => !columns.has(key))).toEqual([]);
        expect(migrationLog).not.toHaveBeenCalled();
    } finally {
        migrationLog.mockRestore();
        await adapter.closeConnection();
        if (oldIsolate === undefined) delete process.env.GOOBSTER_PG_TEST_ISOLATE;
        else process.env.GOOBSTER_PG_TEST_ISOLATE = oldIsolate;
    }
});
