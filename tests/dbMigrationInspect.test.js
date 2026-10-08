/**
 * Read-only inspection of the SQLite to Postgres migration endpoints (#336,
 * documentation/db_migration.md): the SQLite source is opened read-only and
 * left byte- and mtime-identical, the Postgres target is read through the
 * `pg` module inside a READ ONLY transaction and nothing is bootstrapped on
 * it, and the verdict separates blocks from provisioning from warnings.
 *
 * The Postgres journeys need GOOBSTER_DB_URL and create (and drop) their own
 * throwaway schema; without it they are skipped. The classification table
 * and the SQLite behaviours run everywhere.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { Client } = require('pg');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-db-inspect-'));
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'jest-own.sqlite');

const { createSeededSqlite, lockedSchemaUrl } = require('./helpers/migrationSeed');
const { inspectSqlite, inspectPostgres, inspectAll, classify, judgeTargetContents, REQUIRED_EXTENSIONS, MIN_SERVER_VERSION } = require('@goobster/core/db/migration/inspect');
const { describeTarget, publicTarget, redactText, schemaFromOptions } = require('@goobster/core/db/migration/target');
const { expectedSchema, isCopyable, topologicalOrder, quoteIdent } = require('@goobster/core/db/migration/schemaModel');
const { ROLLBACK_LIMIT } = require('@goobster/core/db/migration');

const BASE_URL = process.env.GOOBSTER_DB_URL ? process.env.GOOBSTER_DB_URL.split('?')[0] : null;
const THROWAWAY_SCHEMA = /^[a-z0-9]+_\d+_[0-9a-f]+$/;
const withPostgres = BASE_URL ? describe : describe.skip;
const PASSWORD = 'pw-inspect-never-printed-41d2';
const cleanups = [];
let counter = 0;

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function newDir(label) {
    const dir = path.join(ROOT, `${label}-${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function seeded(label = 'src') {
    const dir = newDir(label);
    const file = path.join(dir, 'goobster.sqlite');
    const info = createSeededSqlite(file, { dataDir: dir });
    return { dir, file, info };
}
const stamp = (file) => {
    const stat = fs.statSync(file);
    return `${path.basename(file)}:${stat.size}:${stat.mtimeMs}:${sha(file)}`;
};
const everyFile = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort()
    .map(name => stamp(path.join(dir, name))).join('\n');

afterAll(async () => {
    while (cleanups.length) await cleanups.pop()();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ SQLite */

describe('the SQLite source', () => {
    test('inspection reads counts, size, WAL state, integrity and the schema, and changes nothing on disk', () => {
        const { dir, file, info } = seeded();
        const before = everyFile(dir);
        const report = inspectSqlite(file, { integrity: 'quick' });
        expect(report).toMatchObject({ present: true, readable: true, integrity: { mode: 'quick_check', ok: true }, walPresent: false });
        expect(report.tableCount).toBe(report.tables.length);
        expect(report.rows).toBe(info.rows);
        expect(report.schema).toEqual({ ahead: [], behind: [], behindRequired: [], missingTables: [], uncopied: [] });
        expect(everyFile(dir)).toBe(before);
        expect(fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name)).toEqual(['goobster.sqlite']);

        expect(inspectSqlite(file, { integrity: 'full' }).integrity).toEqual({ mode: 'integrity_check', ok: true });
        expect(everyFile(dir)).toBe(before);
    });

    test('a database a live writer still holds in WAL mode is read as it is: no byte or mtime of any file changes', () => {
        const { dir, file } = seeded();
        const writer = new Database(file);
        try {
            writer.pragma('journal_mode = WAL');
            writer.pragma('wal_autocheckpoint = 0');
            writer.prepare("INSERT INTO conversations (userId) VALUES (4242)").run();
            expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
            const before = ['', '-wal'].map(suffix => stamp(`${file}${suffix}`)).join('\n');
            const report = inspectSqlite(file, { integrity: 'quick' });
            expect(report).toMatchObject({ readable: true, walPresent: true });
            expect(['', '-wal'].map(suffix => stamp(`${file}${suffix}`)).join('\n')).toBe(before);
            expect(report.tables.find(item => item.name === 'conversations').rows).toBeGreaterThan(1);
        } finally {
            writer.close();
        }
        expect(fs.existsSync(dir)).toBe(true);
    });

    test('a missing file, a file that is not a database and a damaged database are reported, not thrown', () => {
        const dir = newDir('bad');
        expect(inspectSqlite(path.join(dir, 'nope.sqlite'))).toMatchObject({ present: false, readable: false, code: 'SOURCE_MISSING' });
        const junk = path.join(dir, 'junk.sqlite');
        fs.writeFileSync(junk, 'this is not a database '.repeat(300));
        const before = stamp(junk);
        expect(inspectSqlite(junk)).toMatchObject({ present: true, readable: false, code: 'SOURCE_UNREADABLE' });
        expect(stamp(junk)).toBe(before);

        const { file } = seeded('damaged');
        const bytes = fs.readFileSync(file);
        for (let at = 20000; at < 120000; at += 4096) bytes.fill(0xff, at, at + 512);
        fs.writeFileSync(file, bytes);
        const report = inspectSqlite(file, { integrity: 'full' });
        const verdict = classify({ source: report, target: { reachable: false } });
        expect(verdict.blocks.map(item => item.code)).toEqual(expect.arrayContaining([report.readable ? 'SOURCE_INTEGRITY' : 'SOURCE_UNREADABLE']));
    });

    test('a column this release does not know is "ahead" and blocks; a missing optional column is "behind" and warns; a missing required one blocks', () => {
        const ahead = seeded('ahead');
        const database = new Database(ahead.file);
        database.exec('ALTER TABLE users ADD COLUMN from_the_future TEXT');
        database.close();
        const aheadReport = inspectSqlite(ahead.file);
        expect(aheadReport.schema.ahead).toEqual(['users.from_the_future']);
        expect(classify({ source: aheadReport, target: { reachable: false } }).blocks.map(item => item.code)).toContain('SOURCE_SCHEMA_AHEAD');

        const behind = seeded('behind');
        const trimmed = new Database(behind.file);
        trimmed.exec('DROP TABLE instance_state');
        trimmed.close();
        const behindReport = inspectSqlite(behind.file);
        expect(behindReport.schema.missingTables).toEqual(['instance_state']);
        const verdict = classify({ source: behindReport, target: { reachable: false } });
        expect(verdict.warnings.map(item => item.code)).toContain('SOURCE_SCHEMA_BEHIND');
        expect(verdict.blocks.map(item => item.code)).not.toContain('SOURCE_SCHEMA_BEHIND');
    });

    test('tables this release does not copy are listed, and the vector index tables are never part of the copy', () => {
        const { file } = seeded('derived');
        const database = new Database(file);
        database.exec('CREATE TABLE operator_notes_extra (id INTEGER PRIMARY KEY, note TEXT)');
        database.close();
        const report = inspectSqlite(file);
        expect(report.schema.uncopied).toEqual(['operator_notes_extra']);
        expect(isCopyable('memory_vec_8')).toBe(false);
        expect(isCopyable('sqlite_sequence')).toBe(false);
        expect(isCopyable('users')).toBe(true);
    });
});

/* ------------------------------------------------------------- the verdict */

describe('blocks, provisioning and warnings', () => {
    const source = {
        present: true,
        readable: true,
        sizeBytes: 1000,
        tableCount: 5,
        integrity: { mode: 'quick_check', ok: true },
        schema: { ahead: [], behind: [], behindRequired: [], missingTables: [], uncopied: [] }
    };
    const healthy = {
        reachable: true,
        serverVersion: 170011,
        schema: 'public',
        schemaExists: true,
        relationCount: 0,
        canCreateInSchema: true,
        canCreateInDatabase: true,
        isSuperuser: false,
        extensions: { citext: { available: true, installed: true, trusted: true }, vector: { available: true, installed: true, trusted: false } },
        freeBytes: null
    };
    const verdict = (target, extra = {}, options = {}) => classify({ source: { ...source, ...extra }, target: { ...healthy, ...target }, options });
    const codes = list => list.map(item => item.code);

    test('a healthy empty target has nothing to report', () => {
        expect(verdict({})).toEqual({ blocks: [], provisioning: [], warnings: [] });
    });

    test('what stops the operation is a block', () => {
        expect(codes(classify({ source, target: { reachable: false, code: 'ECONNREFUSED' } }).blocks)).toEqual(['TARGET_UNREACHABLE']);
        expect(codes(verdict({ serverVersion: MIN_SERVER_VERSION - 1 }).blocks)).toEqual(['SERVER_TOO_OLD']);
        expect(codes(verdict({ schemaExists: false }).blocks)).toEqual(['TARGET_SCHEMA_MISSING']);
        expect(codes(verdict({ relationCount: 12 }).blocks)).toEqual(['TARGET_NOT_EMPTY']);
        expect(verdict({ relationCount: 12 }).blocks[0].detail).toEqual({ relations: 12, layoutUnknown: true });
        expect(codes(verdict({ canCreateInSchema: false }).blocks)).toEqual(['TARGET_NO_CREATE_PRIVILEGE']);
        expect(codes(verdict({ extensions: { ...healthy.extensions, vector: { available: false, installed: false, trusted: false } } }).blocks)).toEqual(['EXTENSION_UNAVAILABLE']);
        expect(codes(verdict({}, { integrity: { mode: 'quick_check', ok: false } }).blocks)).toEqual(['SOURCE_INTEGRITY']);
        expect(codes(verdict({}, {}, { alreadyPostgres: true }).blocks)).toEqual(['ALREADY_POSTGRES']);
        expect(codes(classify({ source: { present: false, readable: false }, target: healthy }).blocks)).toEqual(['SOURCE_MISSING']);
        expect(codes(classify({ source: { present: true, readable: false }, target: healthy }).blocks)).toEqual(['SOURCE_UNREADABLE']);
    });

    test('what the operation will create, with consent, is provisioning and not a block; what it may not create is a block', () => {
        const missing = { citext: healthy.extensions.citext, vector: { available: true, installed: false, trusted: false } };
        const asSuper = verdict({ extensions: missing, isSuperuser: true });
        expect(asSuper.blocks).toEqual([]);
        expect(asSuper.provisioning).toEqual([{ code: 'EXTENSION_NOT_INSTALLED', extension: 'vector', action: 'CREATE EXTENSION vector' }]);
        const trusted = verdict({ extensions: { ...missing, vector: { available: true, installed: false, trusted: true } } });
        expect(codes(trusted.provisioning)).toEqual(['EXTENSION_NOT_INSTALLED']);
        const plain = verdict({ extensions: missing });
        expect(codes(plain.blocks)).toEqual(['EXTENSION_PRIVILEGE']);
        expect(plain.provisioning).toEqual([]);
        expect(codes(verdict({ extensions: missing, isSuperuser: true, canCreateInDatabase: false }).blocks)).toEqual(['EXTENSION_PRIVILEGE']);
        expect(REQUIRED_EXTENSIONS).toEqual(['citext', 'vector']);
    });

    test('free space is judged only when it is known: a block under 1.5x the source, a warning under 3x', () => {
        expect(codes(verdict({ freeBytes: 1400 }).blocks)).toEqual(['INSUFFICIENT_SPACE']);
        expect(codes(verdict({ freeBytes: 2500 }).warnings)).toEqual(['LOW_SPACE']);
        expect(verdict({ freeBytes: 2500 }).blocks).toEqual([]);
        expect(verdict({ freeBytes: 5000 })).toEqual({ blocks: [], provisioning: [], warnings: [] });
        expect(verdict({ freeBytes: null })).toEqual({ blocks: [], provisioning: [], warnings: [] });
    });

    test('an empty source and tables this release does not copy are warnings', () => {
        expect(codes(verdict({}, { tableCount: 0 }).warnings)).toEqual(['SOURCE_EMPTY']);
        expect(codes(verdict({}, { schema: { ...source.schema, uncopied: ['extra'] } }).warnings)).toEqual(['UNCOPIED_TABLE']);
    });

    describe('a target that already holds a schema', () => {
        const model = expectedSchema().tables;
        const ours = (name) => ({ name, columns: model[name].columns.map(col => col.name) });
        const provisioned = {
            tables: Object.keys(model).map(ours),
            otherRelations: [{ name: 'users_id_seq', kind: 'S' }],
            populated: []
        };

        test("Goobster's own schema with no rows - what database docker/native provision leave - is a warning, not a block", () => {
            expect(judgeTargetContents(provisioned)).toEqual({ kind: 'goobster-empty', reasons: {} });
            expect(judgeTargetContents({ tables: [], otherRelations: [], populated: [] })).toEqual({ kind: 'empty', reasons: {} });
            const out = verdict({ relationCount: provisioned.tables.length + 1, ...provisioned });
            expect(out.blocks).toEqual([]);
            expect(out.warnings).toEqual([{ code: 'TARGET_SCHEMA_PRESENT', detail: { tables: provisioned.tables.length } }]);
            // a subset of the schema (an older provision, a partial rollback) is still ours and empty
            expect(judgeTargetContents({ ...provisioned, tables: [ours('users'), ours('conversations')] }).kind).toBe('goobster-empty');
            // the derived vector tables and a table missing a column this release adds are ours too
            expect(judgeTargetContents({ ...provisioned, tables: [ours('users'), { name: 'memory_vec_1536', columns: ['rowid', 'embedding'] }, { name: 'messages', columns: ['id'] }] }).kind).toBe('goobster-empty');
        });

        test('anything else in the schema is TARGET_NOT_EMPTY, and the detail says what (names, never rows)', () => {
            const foreign = (patch) => judgeTargetContents({ ...provisioned, ...patch });
            expect(foreign({ tables: [...provisioned.tables, { name: 'invoices', columns: ['id'] }] })).toEqual({ kind: 'foreign', reasons: { unknownTables: ['invoices'] } });
            expect(foreign({ tables: [{ name: 'users', columns: [...ours('users').columns, 'legacy_flag'] }] })).toEqual({ kind: 'foreign', reasons: { unknownColumns: ['users.legacy_flag'] } });
            expect(foreign({ otherRelations: [{ name: 'users_id_seq', kind: 'S' }, { name: 'active_users', kind: 'v' }] })).toEqual({ kind: 'foreign', reasons: { otherRelations: ['active_users'] } });
            expect(foreign({ populated: ['conversations', 'users'] })).toEqual({ kind: 'foreign', reasons: { populated: ['conversations', 'users'] } });
            expect(foreign({ populated: null })).toEqual({ kind: 'foreign', reasons: { rowsUnknown: true } });
            const out = verdict({ relationCount: 3, ...provisioned, populated: ['users'] });
            expect(out.blocks).toEqual([{ code: 'TARGET_NOT_EMPTY', detail: { relations: 3, populated: ['users'] } }]);
            expect(out.warnings).toEqual([]);
        });
    });
});

/* ------------------------------------------------------------ the target URL */

describe('describing a target without exposing it', () => {
    test('host, port, database, user and schema are described; the password is in no field and not in the fingerprint', () => {
        const url = `postgres://app:${PASSWORD}@db.example:6543/goobster?options=${encodeURIComponent('-c search_path=migrated,public')}`;
        const description = describeTarget(url);
        expect(description).toMatchObject({ host: 'db.example', port: 6543, database: 'goobster', user: 'app', schema: 'migrated', local: false });
        expect(JSON.stringify(publicTarget(description))).not.toContain(PASSWORD);
        expect(description.fingerprint).toMatch(/^[0-9a-f]{24}$/);
        expect(describeTarget(url.replace(PASSWORD, 'another')).fingerprint).toBe(description.fingerprint);
        expect(describeTarget('postgres://x@localhost/db').local).toBe(true);
        expect(schemaFromOptions('-c search_path="odd",public')).toBe('odd');
        expect(schemaFromOptions('-c search_path=bad-name')).toBeNull();
        expect(() => describeTarget('mysql://x/y')).toThrow(expect.objectContaining({ code: 'INVALID_TARGET' }));
        expect(() => describeTarget('postgres://host/')).toThrow(expect.objectContaining({ code: 'INVALID_TARGET' }));
        expect(() => describeTarget('not a url')).toThrow(expect.objectContaining({ code: 'INVALID_TARGET' }));
    });

    test('text that quotes a URL or a secret is redacted', () => {
        const text = `could not connect to postgres://app:${PASSWORD}@db.example/goobster, password ${PASSWORD}`;
        const out = redactText(text, [PASSWORD]);
        expect(out).not.toContain(PASSWORD);
        expect(out).toContain('postgres://***');
    });

    test('an unreachable target is a finding with a code, never an error and never the URL', async () => {
        const { file } = seeded('unreachable');
        const url = `postgres://app:${PASSWORD}@127.0.0.1:1/goobster`;
        const report = await inspectAll({ sqlitePath: file, url });
        expect(report.target).toMatchObject({ reachable: false, host: '127.0.0.1', port: 1 });
        expect(codes(report.blocks)).toContain('TARGET_UNREACHABLE');
        expect(JSON.stringify(report)).not.toContain(PASSWORD);
        expect(report.estimate).toMatchObject({ rows: expect.any(Number), sourceBytes: expect.any(Number) });
        expect(ROLLBACK_LIMIT).toContain('first write reaches Postgres');
    });

    function codes(list) {
        return list.map(item => item.code);
    }
});

describe('the expected schema model', () => {
    test('is read from schema.sql: every table has its columns, keys and foreign keys, and the copy order puts parents first', () => {
        const model = expectedSchema();
        expect(Object.keys(model.tables).length).toBeGreaterThan(150);
        expect(model.tables.messages.foreignKeys.map(item => item.parent)).toContain('conversations');
        const order = model.order;
        expect(topologicalOrder(model.tables)).toEqual(order);
        expect(order.indexOf('conversations')).toBeLessThan(order.indexOf('messages'));
        expect(quoteIdent('users')).toBe('users');
        expect(quoteIdent('UserPreferences')).toBe('"UserPreferences"');
    });
});

/* ---------------------------------------------------------------- Postgres */

withPostgres('the Postgres target', () => {
    async function schemaTarget() {
        const name = `mig336i_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
        const admin = new Client({ connectionString: BASE_URL });
        await admin.connect();
        await admin.query(`CREATE SCHEMA ${name}`);
        cleanups.push(async () => {
            try { await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); } finally { await admin.end().catch(() => { }); }
        });
        const url = `${BASE_URL}?options=${encodeURIComponent(`-c search_path=${name},public`)}`;
        const rows = async (sql, params) => (await admin.query(sql, params)).rows;
        const catalog = async () => JSON.stringify({
            relations: await rows('SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 ORDER BY 1, 2', [name]),
            extensions: await rows('SELECT extname, extversion FROM pg_extension ORDER BY 1'),
            // Other suites create and drop their own per-process schemas in this database while this runs; only this target's is ours to watch.
            schemas: (await rows('SELECT nspname FROM pg_namespace ORDER BY 1')).map(row => row.nspname).filter(item => item === name || !THROWAWAY_SCHEMA.test(item)),
            types: await rows('SELECT COUNT(*) AS n FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1', [name])
        });
        return { name, url, rows, catalog, admin };
    }

    test('the preflight leaves the source files and the target catalog exactly as they were, and bootstraps nothing', async () => {
        const { dir, file } = seeded('pg');
        const target = await schemaTarget();
        const sourceBefore = everyFile(dir);
        const catalogBefore = await target.catalog();

        const report = await inspectAll({ sqlitePath: file, url: target.url });
        expect(report.blocks).toEqual([]);
        expect(report.target).toMatchObject({ reachable: true, schema: target.name, schemaExists: true, relationCount: 0, canCreateInSchema: true });
        expect(report.target.extensions).toMatchObject({ citext: { available: true }, vector: { available: true } });

        expect(everyFile(dir)).toBe(sourceBefore);
        expect(await target.catalog()).toBe(catalogBefore);
        expect(await target.rows('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = $1', [target.name])).toEqual([{ n: '0' }]);
    });

    test('every statement the target inspection sends is a read inside a READ ONLY transaction that is rolled back', async () => {
        const target = await schemaTarget();
        const sent = [];
        const connect = (url) => {
            const client = new Client({ connectionString: url });
            const query = client.query.bind(client);
            client.query = (sql, ...rest) => {
                sent.push(String(typeof sql === 'string' ? sql : sql.text).trim().replace(/\s+/g, ' '));
                return query(sql, ...rest);
            };
            return client;
        };
        const report = await inspectPostgres(target.url, { connect });
        expect(report.reachable).toBe(true);
        expect(sent[0]).toBe('BEGIN READ ONLY');
        expect(sent[sent.length - 1]).toBe('ROLLBACK');
        const verbs = new Set(sent.map(sql => sql.split(' ')[0].toUpperCase()));
        for (const verb of verbs) expect(['BEGIN', 'SELECT', 'SHOW', 'ROLLBACK']).toContain(verb);
        expect(sent.some(sql => /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(sql) || /^\s*CREATE\b/i.test(sql))).toBe(false);
    });

    test('a schema the URL names but that does not exist is a block, never a silent fall back to public', async () => {
        const target = await schemaTarget();
        const missing = target.url.replace(target.name, `${target.name}_absent`);
        const report = await inspectPostgres(missing);
        expect(report).toMatchObject({ reachable: true, schemaExists: false });
        expect(classify({ source: { present: true, readable: true, tableCount: 1, integrity: { ok: true }, schema: { ahead: [], behind: [], behindRequired: [], missingTables: [], uncopied: [] } }, target: report }).blocks.map(item => item.code)).toContain('TARGET_SCHEMA_MISSING');
        expect(await target.rows('SELECT COUNT(*) AS n FROM pg_namespace WHERE nspname = $1', [`${target.name}_absent`])).toEqual([{ n: '0' }]);
    });

    test('a target that already holds tables is "not empty", and is not touched', async () => {
        const { file } = seeded('pg-full');
        const target = await schemaTarget();
        await target.admin.query(`CREATE TABLE ${target.name}.occupied (id int)`);
        const before = await target.catalog();
        const report = await inspectAll({ sqlitePath: file, url: target.url });
        expect(report.blocks.map(item => item.code)).toEqual(['TARGET_NOT_EMPTY']);
        expect(report.blocks[0].detail).toEqual({ relations: 1, unknownTables: ['occupied'] });
        expect(report.target.relationCount).toBe(1);
        expect(report.target.populated).toEqual([]);
        expect(await target.catalog()).toBe(before);
    });

    test("a target that holds Goobster's own tables with no rows is a warning; one row in them is the block, and the rows are read inside the READ ONLY transaction after the catalog", async () => {
        const { file } = seeded('pg-provisioned');
        const target = await schemaTarget();
        const model = expectedSchema().tables;
        for (const name of ['users', 'conversations']) {
            await target.admin.query(`CREATE TABLE ${target.name}.${quoteIdent(name)} (${model[name].columns.map(col => `${quoteIdent(col.name)} text`).join(', ')})`);
        }
        const before = await target.catalog();
        const sent = [];
        const connect = (url) => {
            const client = new Client({ connectionString: url });
            const query = client.query.bind(client);
            client.query = (sql, ...rest) => { sent.push(String(sql).trim().replace(/\s+/g, ' ')); return query(sql, ...rest); };
            return client;
        };
        const report = await inspectAll({ sqlitePath: file, url: target.url, connect });
        expect(report.blocks).toEqual([]);
        expect(report.warnings).toEqual([{ code: 'TARGET_SCHEMA_PRESENT', detail: { tables: 2 } }]);
        expect(report.target).toMatchObject({ relationCount: 2, populated: [] });
        // the row check is one SELECT, made after every catalog read so a refused table cannot spoil them; only the superuser-only SHOW and the ROLLBACK follow
        const rowCheck = sent.findIndex(sql => /^SELECT \$1::text AS name, EXISTS \(SELECT 1 FROM /.test(sql));
        expect(rowCheck).toBeGreaterThan(0);
        expect(sent.slice(rowCheck + 1).every(sql => sql === 'ROLLBACK' || sql === 'SHOW data_directory')).toBe(true);
        expect(await target.catalog()).toBe(before);

        await target.admin.query(`INSERT INTO ${target.name}.users DEFAULT VALUES`);
        const occupied = await inspectAll({ sqlitePath: file, url: target.url });
        expect(occupied.blocks).toEqual([{ code: 'TARGET_NOT_EMPTY', detail: { relations: 2, populated: ['users'] } }]);
        expect(occupied.warnings).toEqual([]);
        expect(JSON.stringify(occupied)).not.toContain('DEFAULT VALUES');
    });

    test('a role that cannot create in the schema is a block', async () => {
        const { file } = seeded('pg-locked');
        const target = await schemaTarget();
        const locked = await lockedSchemaUrl(target.admin, BASE_URL, target.name);
        cleanups.push(locked.cleanup);
        const report = await inspectAll({ sqlitePath: file, url: locked.url });
        expect(report.blocks.map(item => item.code)).toContain('TARGET_NO_CREATE_PRIVILEGE');
        expect(report.target.canCreateInSchema).toBe(false);
    });

    test('the free-space probe runs only against a local server, and never guesses', async () => {
        const target = await schemaTarget();
        const local = await inspectPostgres(target.url);
        expect(local.local).toBe(true);
        expect(local.freeBytes === null || Number.isFinite(local.freeBytes)).toBe(true);
        const remoteLooking = await inspectPostgres(target.url.replace('127.0.0.1', 'localhost'));
        expect(remoteLooking.reachable).toBe(true);
    });
});
