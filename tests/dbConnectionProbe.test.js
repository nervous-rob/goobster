/**
 * The connection probe, the schema comparison and the provisioning rules for
 * an existing Postgres server (#338, documentation/database_connection.md).
 *
 * Everything that needs no server runs everywhere: the settings and the URL
 * each TLS mode produces (and that the pg driver reads it the same way), the
 * SQLSTATE mapping, the version gate and the verdict through a fake inspector
 * or client, the schema classification, the provisioning boundaries. The
 * journeys against a real server need GOOBSTER_DB_URL and skip without it;
 * those that create roles or databases also need an administrative role (a
 * superuser suite role as in CI, or GOOBSTER_PG_TEST_ADMIN_URL) and skip
 * without one. The probe and the check never write: the catalog is compared
 * before and after.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { Client } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-db-connection-'));
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'jest-own.sqlite');

const { lockedSchemaUrl } = require('./helpers/migrationSeed');
const lib = require('@goobster/core/db/connection');
const { expectedSchema } = require('@goobster/core/db/migration/schemaModel');

const BASE_URL = process.env.GOOBSTER_DB_URL ? process.env.GOOBSTER_DB_URL.split('?')[0] : null;
const withPostgres = BASE_URL ? describe : describe.skip;
const PASSWORD = 'pw/with:odd?chars#7f3a-never-printed';
const cleanups = [];

/** An administrative URL for tests that create roles and databases: the explicit one, or the suite's own when that role is a superuser. */
function detectAdminUrl() {
    if (process.env.GOOBSTER_PG_TEST_ADMIN_URL) return process.env.GOOBSTER_PG_TEST_ADMIN_URL.split('?')[0];
    if (!BASE_URL) return null;
    const script = `const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.argv[1]});await c.connect();const r=await c.query('select rolsuper from pg_roles where rolname=current_user');await c.end();process.stdout.write(r.rows[0].rolsuper?'yes':'no')})().catch(()=>process.stdout.write('no'))`;
    const out = childProcess.spawnSync(process.execPath, ['-e', script, BASE_URL], { encoding: 'utf8', cwd: __dirname }).stdout;
    return out === 'yes' ? BASE_URL : null;
}
const ADMIN_URL = detectAdminUrl();
const withAdmin = ADMIN_URL ? describe : describe.skip;

afterAll(async () => {
    while (cleanups.length) await cleanups.pop()();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

const base = (extra = {}) => ({ host: 'db.example.com', port: 5432, database: 'goobster', user: 'goobster_app', password: PASSWORD, ...extra });

/* -------------------------------------------------------------- settings */

describe('the connection settings', () => {
    test('defaults: port 5432, schema public, TLS prefer for this host and require for any other', () => {
        expect(lib.parseConnection({ host: 'DB.Example.COM', database: 'g', user: 'u' })).toEqual({
            host: 'db.example.com', port: 5432, database: 'g', schema: 'public', user: 'u', password: '', tls: { mode: 'require', caFile: null }
        });
        expect(lib.parseConnection({ host: '127.0.0.1', database: 'g', user: 'u' }).tls.mode).toBe('prefer');
        expect(lib.parseConnection({ host: 'localhost', database: 'g', user: 'u' }).tls.mode).toBe('prefer');
    });

    test.each([
        [{ host: 'postgres://x', database: 'g', user: 'u' }, 'INVALID_HOST'],
        [{ host: 'db.example.com:5432', database: 'g', user: 'u' }, 'INVALID_HOST'],
        [{ host: 'db', port: 70000, database: 'g', user: 'u' }, 'INVALID_PORT'],
        [{ host: 'db', database: 'a b', user: 'u' }, 'INVALID_DATABASE'],
        [{ host: 'db', database: 'g', schema: 'pg_catalog', user: 'u' }, 'INVALID_SCHEMA'],
        [{ host: 'db', database: 'g', schema: 'a;b', user: 'u' }, 'INVALID_SCHEMA'],
        [{ host: 'db', database: 'g', user: '' }, 'INVALID_USER'],
        [{ host: 'db', database: 'g', user: 'u', password: 'x'.repeat(513) }, 'INVALID_PASSWORD'],
        [{ host: 'db', database: 'g', user: 'u', tls: { mode: 'sometimes' } }, 'INVALID_TLS_MODE'],
        [{ host: 'db', database: 'g', user: 'u', tls: { mode: 'verify-full' } }, 'TLS_CA_REQUIRED'],
        [{ host: 'db', database: 'g', user: 'u', tls: { mode: 'require', caFile: 'relative/ca.pem' } }, 'INVALID_TLS_CA'],
        [{ host: 'db', database: 'g', user: 'u', tls: { mode: 'disable', caFile: '/etc/ssl/ca.pem' } }, 'INVALID_TLS'],
        [{ host: 'db', database: 'g', user: 'u', extra: 1 }, 'INVALID_CONNECTION']
    ])('%j is refused with %s', (input, code) => {
        expect(() => lib.parseConnection(input)).toThrow(expect.objectContaining({ name: 'ConnectionError', code }));
    });

    test('the public view carries no password', () => {
        const view = lib.publicConnection(lib.parseConnection(base()));
        expect(JSON.stringify(view)).not.toContain(PASSWORD);
        expect(view).not.toHaveProperty('password');
    });
});

describe('TLS modes and the URL they produce', () => {
    const ca = path.join(ROOT, 'ca.pem');
    beforeAll(() => fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n'));

    test('every mode writes a URL the pg driver reads the way the probe connects, and the password survives encoding', () => {
        const connection = lib.parseConnection(base({ tls: { mode: 'verify-full', caFile: ca } }));
        const disabled = parseConnectionString(lib.connectionUrl(connection, { tlsMode: 'disable' }));
        expect(disabled.ssl).toBe(false);
        expect(disabled.password).toBe(PASSWORD);
        expect(disabled.options).toBe('-c search_path=public');

        const verify = parseConnectionString(lib.connectionUrl(connection, { tlsMode: 'verify-full' }));
        expect(verify.ssl.ca).toContain('BEGIN CERTIFICATE');
        expect(verify.ssl.rejectUnauthorized).not.toBe(false);
        expect(lib.sslOptions(connection, 'verify-full')).toMatchObject({ rejectUnauthorized: true });
        expect(lib.sslOptions(connection, 'verify-full').ca).toContain('BEGIN CERTIFICATE');

        const required = lib.parseConnection(base());
        const parsedRequire = parseConnectionString(lib.connectionUrl(required, { tlsMode: 'require' }));
        expect(parsedRequire.ssl).toMatchObject({ rejectUnauthorized: false });
        expect(lib.sslOptions(required, 'require')).toEqual({ rejectUnauthorized: false });
        expect(lib.sslOptions(required, 'disable')).toBe(false);
    });

    test('require with a CA file verifies the chain but not the host name, as libpq does; both sides agree', () => {
        const connection = lib.parseConnection(base({ tls: { mode: 'require', caFile: ca } }));
        const mine = lib.sslOptions(connection, 'require');
        const theirs = parseConnectionString(lib.connectionUrl(connection, { tlsMode: 'require' })).ssl;
        expect(mine.rejectUnauthorized).toBe(true);
        expect(theirs.rejectUnauthorized).not.toBe(false);
        expect(typeof mine.checkServerIdentity).toBe('function');
        expect(typeof theirs.checkServerIdentity).toBe('function');
        expect(mine.ca).toBe(theirs.ca);
    });

    test('prefer cannot be written as a URL: the probe resolves it first', () => {
        const connection = lib.parseConnection(base({ tls: { mode: 'prefer' } }));
        expect(() => lib.connectionUrl(connection)).toThrow(expect.objectContaining({ code: 'TLS_UNRESOLVED' }));
        expect(() => lib.sslOptions(connection, 'prefer')).toThrow(expect.objectContaining({ code: 'TLS_UNRESOLVED' }));
    });

    test('a CA file that is missing, empty or not a file is refused without naming its content', () => {
        const empty = path.join(ROOT, 'empty.pem');
        fs.writeFileSync(empty, '');
        for (const bad of [path.join(ROOT, 'nope.pem'), empty, ROOT]) {
            const connection = lib.parseConnection(base({ tls: { mode: 'verify-full', caFile: bad } }));
            expect(() => lib.sslOptions(connection, 'verify-full')).toThrow(expect.objectContaining({ code: 'TLS_CA_UNREADABLE' }));
        }
    });

    test('a saved URL reports its TLS settings and pre-fills a form without the password', () => {
        const connection = lib.parseConnection(base({ schema: 'goob', tls: { mode: 'verify-full', caFile: ca } }));
        const url = lib.connectionUrl(connection, { tlsMode: 'verify-full' });
        expect(lib.tlsOfUrl(url)).toEqual({ mode: 'verify-full', ca: true });
        expect(lib.connectionOfUrl(url)).toEqual({ host: 'db.example.com', port: 5432, database: 'goobster', schema: 'goob', user: 'goobster_app', tls: { mode: 'verify-full', caFile: ca } });
        expect(JSON.stringify(lib.describeUrl(url))).not.toContain(PASSWORD);
    });
});

/* ---------------------------------------------------- the probe, no server */

/** What `inspectPostgres` returns for a reachable server, with the parts a test changes. */
function inspected(over = {}) {
    return {
        reachable: true,
        user: 'goobster_app',
        isSuperuser: false,
        serverVersion: 170011,
        serverVersionText: '17.11',
        schema: 'public',
        schemaExists: true,
        canConnect: true,
        canCreateInDatabase: false,
        canCreateInSchema: true,
        canCreateDatabase: false,
        canCreateRole: false,
        tables: [],
        otherRelations: [],
        relationCount: 0,
        extensions: { citext: { available: true, installed: true, trusted: true }, vector: { available: true, installed: true, trusted: false } },
        tls: { encrypted: true, protocol: 'TLSv1.3' },
        freeBytes: null,
        ...over
    };
}
const fakeInspect = (...answers) => {
    const calls = [];
    const fn = async (url, options) => {
        calls.push({ url, options });
        const next = answers.length > 1 ? answers.shift() : answers[0];
        return typeof next === 'function' ? next(url, calls.length) : next;
    };
    fn.calls = calls;
    return fn;
};
const failed = (code) => ({ reachable: false, code });
const probe = (input, inspect, extra = {}) => lib.probeConnection(input, { inspect, createClient: () => ({}), ...extra });

describe('the probe: failures, told apart by SQLSTATE and network code', () => {
    test.each([
        ['28P01', 'AUTH_FAILED', 'wrong-credentials'],
        ['28000', 'AUTH_FAILED', 'wrong-credentials'],
        ['3D000', 'DATABASE_MISSING', 'database-missing'],
        ['42501', 'PERMISSION_DENIED', 'permission-denied'],
        ['08006', 'CONNECTION_ERROR', 'unreachable'],
        ['08001', 'CONNECTION_ERROR', 'unreachable'],
        ['ECONNREFUSED', 'CONNECTION_REFUSED', 'unreachable'],
        ['ENOTFOUND', 'HOST_NOT_FOUND', 'unreachable'],
        ['ETIMEDOUT', 'CONNECTION_TIMEOUT', 'unreachable'],
        ['SSL_NOT_SUPPORTED', 'TLS_UNSUPPORTED', 'tls-failed'],
        ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_CERTIFICATE', 'tls-failed'],
        ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'TLS_CERTIFICATE', 'tls-failed'],
        ['SOMETHING_ELSE', 'TARGET_UNREACHABLE', 'unreachable']
    ])('%s is reported as %s (auth: %s), with the SQLSTATE kept and a remediation sentence', async (code, finding, auth) => {
        const report = await probe(base({ tls: { mode: 'require' } }), fakeInspect(failed(code)));
        expect(report.reachable).toBe(false);
        expect(report.auth).toBe(auth);
        expect(report.code).toBe(code);
        expect(report.verdict.ok).toBe(false);
        const block = report.verdict.blocks.find(item => item.code === finding);
        expect(block).toBeTruthy();
        expect(block.remediation.length).toBeGreaterThan(20);
        if (/^[0-9A-Z]{5}$/.test(code)) expect(block.sqlstate).toBe(code);
    });

    test('a missing database also looks at the maintenance database, so the provisioning plan can say what to create', async () => {
        const inspect = fakeInspect((url) => (/\/goobster\?/.test(url) ? failed('3D000') : inspected({ user: 'goobster_app', isSuperuser: true, schemaExists: true })));
        const report = await probe(base({ tls: { mode: 'require' } }), inspect);
        expect(report.verdict.blocks.map(item => item.code)).toContain('DATABASE_MISSING');
        expect(report.verdict.next).toBe('provision');
        const actions = report.verdict.provisioning.required.map(item => item.action);
        expect(actions).toEqual(expect.arrayContaining(['create-role', 'create-database', 'grant', 'create-extension.citext', 'create-extension.vector']));
        expect(report.verdict.provisioning.dba.join('\n')).toContain('CREATE DATABASE "goobster"');
        expect(report.role).toMatchObject({ superuser: true });
    });

    test('wrong credentials offer to create the role; the placeholder, never the password, appears in the statements', async () => {
        const report = await probe(base({ tls: { mode: 'require' } }), fakeInspect(failed('28P01')));
        const text = JSON.stringify(report);
        expect(report.verdict.provisioning.required.map(item => item.action)).toContain('create-role');
        expect(text).toContain('<APPLICATION_PASSWORD>');
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(encodeURIComponent(PASSWORD));
    });
});

describe('the probe: a reachable server', () => {
    test('a server older than 13 blocks, and the sentence says upgrading is a separate job', async () => {
        const report = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected({ serverVersion: 120019, serverVersionText: '12.19' })));
        expect(report.server).toMatchObject({ supported: false, minimum: 130000, text: '12.19' });
        const block = report.verdict.blocks.find(item => item.code === 'SERVER_TOO_OLD');
        expect(block.remediation).toContain('separate job');
        expect(report.verdict.ok).toBe(false);
    });

    test('server and client versions, the role and the three privileges are reported', async () => {
        const report = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected({ canCreateInDatabase: true })));
        expect(report.server).toMatchObject({ supported: true, text: '17.11' });
        expect(report.client.pg).toMatch(/^\d+\.\d+/);
        expect(report.privileges).toEqual({ connect: true, createInDatabase: true, createInSchema: true });
        expect(report.role).toMatchObject({ user: 'goobster_app', superuser: false });
        expect(report.auth).toBe('ok');
    });

    test('an extension is three facts: the library on the server, created in this database, trusted - and the report says which', async () => {
        const report = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected({
            canCreateInDatabase: true,
            extensions: { citext: { available: true, installed: false, trusted: true }, vector: { available: true, installed: true, trusted: false } }
        })));
        expect(report.extensions.citext).toMatchObject({ available: true, installed: false, trusted: true, state: 'library-only', canCreate: true });
        expect(report.extensions.citext.summary).toMatch(/not created in this database/);
        expect(report.extensions.vector).toMatchObject({ available: true, installed: true, state: 'created' });
        expect(report.verdict.warnings.map(item => item.code)).toContain('EXTENSION_NOT_CREATED');
        expect(report.verdict.ok).toBe(true);
    });

    test('an extension the role cannot create blocks and asks for provisioning; one the server lacks blocks with no SQL remedy', async () => {
        const report = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected({
            extensions: { citext: { available: true, installed: false, trusted: false }, vector: { available: false, installed: false, trusted: false } }
        })));
        const codes = report.verdict.blocks.map(item => item.code);
        expect(codes).toEqual(expect.arrayContaining(['EXTENSION_PRIVILEGE', 'EXTENSION_LIBRARY_MISSING']));
        expect(report.extensions.vector.state).toBe('library-missing');
        expect(report.verdict.blocks.find(item => item.code === 'EXTENSION_LIBRARY_MISSING').remediation).toMatch(/package|hosting/);
        expect(report.verdict.provisioning.required).toEqual([]);
    });

    test('schema compatibility: empty, this release, older, newer and foreign', async () => {
        const model = expectedSchema();
        const tables = Object.entries(model.tables).map(([name, table]) => ({ name, columns: table.columns.map(col => col.name) }));
        const state = async (found) => (await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected(found)))).schema;

        expect(await state({ tables: [] })).toMatchObject({ state: 'empty', exists: true });
        const current = await state({ tables });
        expect(current).toMatchObject({ state: 'goobster-current', fingerprint: expect.stringMatching(/^[0-9a-f]+$/) });
        expect(current.fingerprint).toBe(current.expectedFingerprint);

        const older = await state({ tables: tables.slice(1).map((table, index) => (index === 0 ? { ...table, columns: table.columns.slice(1) } : table)) });
        expect(older.state).toBe('goobster-older');
        expect(older.missingTables.length).toBe(1);
        expect(older.missingColumns.length).toBeGreaterThan(0);

        const newer = await state({ tables: tables.map((table, index) => (index === 0 ? { ...table, columns: [...table.columns, 'from_the_future'] } : table)) });
        expect(newer.state).toBe('goobster-newer');

        const foreign = await state({ tables: [{ name: 'invoices', columns: ['id', 'total'] }] });
        expect(foreign).toMatchObject({ state: 'foreign', foreign: ['invoices'] });
    });

    test('a foreign schema blocks with a sentence that says Goobster never writes into it; an older one is a warning, not a block', async () => {
        const foreign = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected({ tables: [{ name: 'invoices', columns: ['id'] }] })));
        expect(foreign.verdict.ok).toBe(false);
        expect(foreign.verdict.blocks.find(item => item.code === 'SCHEMA_FOREIGN').remediation).toMatch(/never writes/);
        expect(foreign.verdict.provisioning.required).toEqual([]);

        const model = expectedSchema();
        const tables = Object.entries(model.tables).slice(1).map(([name, table]) => ({ name, columns: table.columns.map(col => col.name) }));
        const older = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected({ tables })));
        expect(older.verdict.ok).toBe(true);
        expect(older.verdict.warnings.map(item => item.code)).toContain('SCHEMA_OLDER');
        expect(older.verdict.next).toBe('connect');
    });

    test('the missing schema and a role that may not create in it are blocks the provisioning plan can fix', async () => {
        const missing = await probe(base({ schema: 'goob', tls: { mode: 'require' } }), fakeInspect(inspected({ schema: 'goob', schemaExists: false, canCreateInSchema: false })));
        expect(missing.verdict.blocks.map(item => item.code)).toContain('SCHEMA_MISSING');
        expect(missing.verdict.provisioning.required.map(item => item.action)).toEqual(expect.arrayContaining(['create-schema', 'grant']));

        const locked = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected({ canCreateInSchema: false })));
        expect(locked.privileges.createInSchema).toBe(false);
        expect(locked.verdict.blocks.map(item => item.code)).toContain('NO_CREATE_PRIVILEGE');
        expect(locked.verdict.provisioning.required.map(item => item.action)).toEqual(['grant']);
    });

    test('TLS outcome: the effective mode, whether it is encrypted, whether the certificate was checked, and the warnings for a remote server', async () => {
        const plain = await probe(base({ tls: { mode: 'disable' } }), fakeInspect(inspected({ tls: { encrypted: false, protocol: null } })));
        expect(plain.tls).toMatchObject({ requested: 'disable', effective: 'disable', encrypted: false, verified: false });
        expect(plain.verdict.warnings.map(item => item.code)).toContain('TLS_NOT_ENCRYPTED');

        const unverified = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected()));
        expect(unverified.tls).toMatchObject({ effective: 'require', encrypted: true, verified: false });
        expect(unverified.verdict.warnings.map(item => item.code)).toContain('TLS_NOT_VERIFIED');

        const ca = path.join(ROOT, 'probe-ca.pem');
        fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n');
        const verified = await probe(base({ tls: { mode: 'verify-full', caFile: ca } }), fakeInspect(inspected()));
        expect(verified.tls).toMatchObject({ effective: 'verify-full', encrypted: true, verified: true });
        expect(verified.verdict.warnings.map(item => item.code)).not.toContain('TLS_NOT_VERIFIED');

        const local = await probe({ host: '127.0.0.1', database: 'g', user: 'u', password: 'x' }, fakeInspect(inspected({ tls: { encrypted: false, protocol: null } })));
        expect(local.verdict.warnings.map(item => item.code)).not.toContain('TLS_NOT_ENCRYPTED');
    });

    test('prefer tries TLS and, only when the server has none, plain; the effective mode is what a saved URL carries', async () => {
        const inspect = fakeInspect((url, n) => (n === 1 ? failed('SSL_NOT_SUPPORTED') : inspected({ tls: { encrypted: false, protocol: null } })));
        const report = await probe({ host: '127.0.0.1', database: 'g', user: 'u', password: 'x', tls: { mode: 'prefer' } }, inspect);
        expect(inspect.calls).toHaveLength(2);
        expect(inspect.calls[0].url).toContain('sslmode=require');
        expect(inspect.calls[1].url).toContain('sslmode=disable');
        expect(report.tls).toMatchObject({ requested: 'prefer', effective: 'disable', encrypted: false });

        const other = fakeInspect(failed('28P01'));
        const refused = await probe({ host: '127.0.0.1', database: 'g', user: 'u', password: 'x', tls: { mode: 'prefer' } }, other);
        expect(other.calls).toHaveLength(1);
        expect(refused.auth).toBe('wrong-credentials');
    });

    test('the probe builds the pg client from explicit options for the mode and never puts the password in the report', async () => {
        const seen = [];
        const inspect = async (url, { connect }) => {
            const client = connect();
            seen.push(client);
            return inspected();
        };
        const report = await lib.probeConnection(base({ tls: { mode: 'require' } }), { inspect, createClient: (config) => config });
        expect(seen[0]).toMatchObject({ host: 'db.example.com', port: 5432, database: 'goobster', user: 'goobster_app', password: PASSWORD, ssl: { rejectUnauthorized: false } });
        expect(seen[0].options).toBe('-c search_path=public');
        const text = JSON.stringify(report);
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(encodeURIComponent(PASSWORD));
        expect(text).not.toContain('postgres://');
    });

    test('the active connection is recognised by fingerprint', async () => {
        const first = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected()));
        expect(first.active).toBe(false);
        const again = await probe(base({ tls: { mode: 'require' } }), fakeInspect(inspected()), { activeFingerprint: first.target.fingerprint });
        expect(again.active).toBe(true);
    });
});

/* ----------------------------------------------------- provisioning rules */

/** A scripted pg client: answers the catalog reads provisioning does, records every statement. */
function fakeServer(state = {}) {
    const server = {
        sent: [],
        opened: [],
        capabilities: { super: false, createdb: false, createrole: false, ...(state.capabilities || {}) },
        role: state.role ?? false,
        database: state.database ?? false,
        databaseOwner: state.databaseOwner ?? false,
        schema: state.schema ?? false,
        schemaOwner: state.schemaOwner ?? false,
        relations: state.relations || [],
        extensions: { citext: { available: true, trusted: true, installed: false }, vector: { available: true, trusted: false, installed: false }, ...(state.extensions || {}) },
        canCreateInDatabase: state.canCreateInDatabase ?? false,
        failOn: state.failOn || null
    };
    server.createClient = ({ database }) => {
        server.opened.push(database);
        return {
            on() {},
            async connect() { if (state.refuse) throw Object.assign(new Error('nope'), { code: '28P01' }); },
            async end() {},
            escapeLiteral: (value) => `'${String(value).replace(/'/g, "''")}'`,
            async query(sql, params = []) {
                server.sent.push(String(sql).replace(/\s+/g, ' ').trim());
                if (server.failOn && String(sql).includes(server.failOn)) throw Object.assign(new Error('boom'), { code: '42P07' });
                if (/FROM pg_roles WHERE rolname = current_user/.test(sql)) return { rows: [{ super: server.capabilities.super, createdb: server.capabilities.createdb, createrole: server.capabilities.createrole }] };
                if (/FROM pg_roles WHERE rolname = \$1/.test(sql)) return { rows: server.role ? [{ '?column?': 1 }] : [], rowCount: server.role ? 1 : 0 };
                if (/FROM pg_database WHERE datname/.test(sql)) return { rows: server.database ? [{ owner: server.databaseOwner }] : [] };
                if (/pg_available_extensions/.test(sql)) return { rows: Object.entries(server.extensions).filter(([, info]) => info.available).map(([name, info]) => ({ name, trusted: info.trusted })) };
                if (/has_database_privilege/.test(sql)) return { rows: [{ ok: server.canCreateInDatabase }] };
                if (/FROM pg_namespace WHERE nspname/.test(sql)) return { rows: server.schema ? [{ owner: server.schemaOwner }] : [] };
                if (/FROM pg_class c JOIN pg_namespace/.test(sql)) return { rows: server.relations };
                if (/FROM pg_extension/.test(sql)) return { rows: Object.entries(server.extensions).filter(([, info]) => info.installed).map(([extname]) => ({ extname })) };
                return { rows: [], rowCount: 0 };
            }
        };
    };
    return server;
}

describe('provisioning: what it will and will not do', () => {
    const application = () => lib.parseConnection(base({ tls: { mode: 'require' } }));
    const elevated = { user: 'admin', password: 'elevated-secret-9c1' };
    const everything = ['create-role', 'create-database', 'create-extension.citext', 'create-extension.vector', 'create-schema', 'grant'];

    test('the actions are an explicit closed list; anything else is refused', () => {
        expect(lib.ACTIONS).toEqual(everything);
        expect(() => lib.parseActions([])).toThrow(expect.objectContaining({ code: 'INVALID_ACTIONS' }));
        expect(() => lib.parseActions(['drop-database'])).toThrow(expect.objectContaining({ code: 'INVALID_ACTIONS' }));
        expect(lib.parseActions(['grant', 'create-role', 'grant'])).toEqual(['create-role', 'grant']);
    });

    test('the role it creates is least-privilege and the statements shown carry a placeholder, not a password', () => {
        const shown = lib.displayPlan(['create-role', 'grant'], { ...application(), password: '' });
        const text = JSON.stringify(shown);
        expect(text).toContain('CREATE ROLE \\"goobster_app\\" LOGIN PASSWORD \'<APPLICATION_PASSWORD>\' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
        expect(text).toContain('GRANT USAGE, CREATE ON SCHEMA \\"public\\" TO \\"goobster_app\\"');
        expect(text).not.toContain(PASSWORD);
        expect(lib.dbaScript(['create-database', 'grant'], { ...application(), password: '' }).join('\n')).toMatch(/connected to the database "goobster"/);
    });

    test('a superuser can do everything; an administrator without the privileges gets the DBA statements instead', async () => {
        const full = await lib.checkProvisioning({ application: application(), elevated, actions: everything, tlsMode: 'require', createClient: fakeServer({ capabilities: { super: true } }).createClient });
        expect(full.blocked).toEqual([]);
        expect(Object.values(full.permitted).every(Boolean)).toBe(true);

        const server = fakeServer();
        const limited = await lib.checkProvisioning({ application: application(), elevated, actions: ['create-role', 'create-database', 'create-extension.vector'], tlsMode: 'require', createClient: server.createClient });
        expect(limited.blocked).toEqual(expect.arrayContaining(['create-role', 'create-database', 'create-extension.vector']));
        expect(limited.dba.join('\n')).toContain('CREATE ROLE');
        expect(limited.dba.join('\n')).not.toContain('elevated-secret');
        expect(server.sent.every(sql => /^(SELECT|BEGIN|ROLLBACK)/i.test(sql))).toBe(true);
    });

    test('refuses before touching anything: reserved names, the same role, a role that exists, a foreign schema, a missing library', async () => {
        const run = (app, state, actions = everything, who = elevated) => lib.runProvisioning({ application: app, elevated: who, actions, tlsMode: 'require', createClient: fakeServer({ capabilities: { super: true }, ...state }).createClient });
        await expect(run({ ...application(), database: 'postgres' }, {})).rejects.toMatchObject({ code: 'RESERVED_NAME' });
        await expect(run({ ...application(), user: 'postgres' }, {})).rejects.toMatchObject({ code: 'RESERVED_NAME' });
        await expect(run(application(), {}, everything, { user: 'goobster_app', password: 'x' })).rejects.toMatchObject({ code: 'SAME_ROLE' });
        await expect(run(application(), { role: true })).rejects.toMatchObject({ code: 'ROLE_EXISTS' });
        await expect(run(application(), { database: true, schema: true, role: true, relations: [{ name: 'invoices', kind: 'r', columns: ['id'] }] }, ['create-extension.citext', 'grant'])).rejects.toMatchObject({ code: 'SCHEMA_FOREIGN' });
        await expect(run(application(), { extensions: { vector: { available: false, trusted: false, installed: false } } }, ['create-role', 'create-database', 'create-extension.vector'])).rejects.toMatchObject({ code: 'EXTENSION_LIBRARY_MISSING' });
        await expect(run(application(), {}, ['create-extension.citext'])).rejects.toMatchObject({ code: 'DATABASE_MISSING' });
        await expect(run(application(), { database: true }, ['grant'])).rejects.toMatchObject({ code: 'ROLE_MISSING' });
    });

    test('with everything ticked on an empty server it creates the role, the database, the extensions and the grants, and nothing else', async () => {
        const server = fakeServer({ capabilities: { super: true } });
        const out = await lib.runProvisioning({ application: application(), elevated, actions: everything, tlsMode: 'require', createClient: server.createClient });
        expect(out.results.map(item => item.action)).toEqual(['create-role', 'create-database', 'create-extension.citext', 'create-extension.vector', 'create-schema', 'grant']);

        const writes = server.sent.filter(sql => !/^(SELECT|BEGIN|COMMIT|ROLLBACK)/i.test(sql));
        expect(writes).toEqual([
            expect.stringMatching(/^CREATE ROLE "goobster_app" LOGIN PASSWORD 'SCRAM-SHA-256\$4096:[^']+' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS$/),
            'CREATE DATABASE "goobster"',
            'GRANT CONNECT ON DATABASE "goobster" TO "goobster_app"',
            'CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public',
            'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public',
            'GRANT USAGE, CREATE ON SCHEMA "public" TO "goobster_app"'
        ]);
        for (const sql of writes) {
            expect(sql).not.toContain(PASSWORD);
            expect(sql).not.toMatch(/\b(DROP|ALTER|TRUNCATE|DELETE|INSERT|UPDATE)\b|(?<!NO)SUPERUSER/i);
        }
        expect(server.opened.every(name => ['postgres', 'goobster'].includes(name))).toBe(true);
    });

    test('a statement that fails inside the database rolls back the statements before it in that database', async () => {
        const server = fakeServer({ capabilities: { super: true }, database: true, role: true, failOn: 'CREATE EXTENSION IF NOT EXISTS vector' });
        await expect(lib.runProvisioning({ application: application(), elevated, actions: ['create-extension.citext', 'create-extension.vector'], tlsMode: 'require', createClient: server.createClient }))
            .rejects.toMatchObject({ code: 'PROVISIONING_FAILED', details: { cause: '42P07' } });
        expect(server.sent).toContain('ROLLBACK');
        expect(server.sent).not.toContain('COMMIT');
    });

    test('the SCRAM verifier is what Postgres accepts for a password, and a password with a quote is still escaped', async () => {
        const verifier = lib.scramVerifier('pw', { salt: Buffer.from('0123456789abcdef'), iterations: 4096 });
        expect(verifier).toBe('SCRAM-SHA-256$4096:MDEyMzQ1Njc4OWFiY2RlZg==$' + verifier.split('$')[2]);
        expect(verifier.split('$')[2]).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
        const server = fakeServer({ capabilities: { super: true } });
        await lib.runProvisioning({ application: { ...application(), password: "it's é" }, elevated, actions: ['create-role'], tlsMode: 'require', createClient: server.createClient });
        const create = server.sent.find(sql => sql.startsWith('CREATE ROLE'));
        expect(create).toContain("PASSWORD 'it''s é'");
    });

    test('the elevated credential is used per call: a refused connection says so without echoing it', async () => {
        const server = fakeServer({ refuse: true });
        await expect(lib.checkProvisioning({ application: application(), elevated, actions: ['grant'], tlsMode: 'require', createClient: server.createClient }))
            .rejects.toMatchObject({ code: 'ELEVATED_CONNECT_FAILED' });
        try {
            await lib.checkProvisioning({ application: application(), elevated, actions: ['grant'], tlsMode: 'require', createClient: server.createClient });
        } catch (error) {
            expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain('elevated-secret');
        }
    });

    test('prefer for the elevated connection is resolved the same way as for the probe', async () => {
        const tried = [];
        const createClient = ({ tlsMode }) => ({
            on() {},
            async connect() { tried.push(tlsMode); if (tlsMode === 'require') throw Object.assign(new Error('The server does not support SSL connections'), {}); },
            async end() {}
        });
        expect(await lib.resolveTlsMode({ application: application(), elevated, tlsMode: 'prefer', createClient })).toBe('disable');
        expect(tried).toEqual(['require', 'disable']);
        expect(await lib.resolveTlsMode({ application: application(), elevated, tlsMode: 'verify-full', createClient })).toBe('verify-full');
    });
});

/* -------------------------------------------------------- a real server */

/** The suite's own database, a throwaway schema in it, and a catalog digest to prove a read changed nothing. */
async function schemaTarget(label = 'p338') {
    const name = `${label}_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${name}`);
    cleanups.push(async () => {
        try { await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); } finally { await admin.end().catch(() => { }); }
    });
    const rows = async (sql, params) => (await admin.query(sql, params)).rows;
    const catalog = async () => JSON.stringify({
        relations: await rows('SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 ORDER BY 1, 2', [name]),
        extensions: await rows('SELECT extname, extversion FROM pg_extension ORDER BY 1'),
        roles: (await rows('SELECT rolname FROM pg_roles ORDER BY 1')).map(row => row.rolname).filter(item => !item.includes(name)),
        databases: (await rows('SELECT datname FROM pg_database ORDER BY 1')).map(row => row.datname)
    });
    const url = new URL(BASE_URL);
    const connection = (extra = {}) => ({
        host: url.hostname,
        port: Number(url.port || 5432),
        database: decodeURIComponent(url.pathname.slice(1)),
        schema: name,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        tls: { mode: 'prefer' },
        ...extra
    });
    return { name, admin, rows, catalog, connection };
}

withPostgres('a real server', () => {
    test('right credentials: reachable, versions, privileges, extensions, an empty schema and a verdict that says apply it; the probe writes nothing', async () => {
        const target = await schemaTarget();
        const before = await target.catalog();
        const report = await lib.probeConnection(target.connection());
        expect(report).toMatchObject({
            reachable: true,
            auth: 'ok',
            server: { supported: true },
            privileges: { connect: true, createInSchema: true },
            schema: { state: 'empty', exists: true, name: target.name }
        });
        expect(report.server.version).toBeGreaterThanOrEqual(130000);
        expect(report.client.pg).toMatch(/^\d+/);
        expect(report.extensions.citext).toMatchObject({ available: true });
        expect(report.extensions.vector).toMatchObject({ available: true });
        expect(['require', 'disable']).toContain(report.tls.effective);
        expect(report.verdict).toMatchObject({ ok: true, next: 'apply-schema' });
        expect(await target.catalog()).toBe(before);
        expect(await target.rows('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = $1', [target.name])).toEqual([{ n: '0' }]);
    });

    test('every TLS mode that can work against this server does, and verify-full without a trusted CA is a TLS_CERTIFICATE block', async () => {
        const target = await schemaTarget();
        const disabled = await lib.probeConnection(target.connection({ tls: { mode: 'disable' } }));
        if (disabled.reachable) expect(disabled.tls).toMatchObject({ effective: 'disable', encrypted: false });
        const required = await lib.probeConnection(target.connection({ tls: { mode: 'require' } }));
        if (required.reachable) expect(required.tls).toMatchObject({ effective: 'require', encrypted: true, verified: false });

        const system = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'].find(file => fs.existsSync(file));
        if (system && required.reachable && required.tls.encrypted) {
            const verified = await lib.probeConnection(target.connection({ tls: { mode: 'verify-full', caFile: system } }));
            expect(verified.reachable).toBe(false);
            expect(verified.verdict.blocks.map(item => item.code)).toContain('TLS_CERTIFICATE');
        }
    });

    test('wrong password: 28P01 as AUTH_FAILED; a missing database: 3D000 as DATABASE_MISSING; a refused port: CONNECTION_REFUSED', async () => {
        const target = await schemaTarget();
        const wrong = await lib.probeConnection(target.connection({ password: 'definitely-not-the-password' }));
        expect(wrong).toMatchObject({ reachable: false, auth: 'wrong-credentials' });
        expect(wrong.code).toMatch(/^28/);
        expect(wrong.verdict.blocks[0]).toMatchObject({ code: 'AUTH_FAILED', sqlstate: wrong.code });
        expect(JSON.stringify(wrong)).not.toContain('definitely-not-the-password');

        const missing = await lib.probeConnection(target.connection({ database: `no_such_${crypto.randomBytes(3).toString('hex')}`, schema: 'public' }));
        expect(missing).toMatchObject({ reachable: false, auth: 'database-missing', code: '3D000' });
        expect(missing.verdict.blocks.map(item => item.code)).toContain('DATABASE_MISSING');

        const refused = await lib.probeConnection(target.connection({ port: 1 }));
        expect(refused).toMatchObject({ reachable: false, auth: 'unreachable' });
        expect(refused.verdict.blocks.map(item => item.code)).toContain('CONNECTION_REFUSED');
    });

    test('insufficient privileges: a role that cannot create in the schema is reported, not discovered later', async () => {
        const target = await schemaTarget();
        const locked = await lockedSchemaUrl(target.admin, BASE_URL, target.name);
        cleanups.push(locked.cleanup);
        const url = new URL(locked.url);
        const report = await lib.probeConnection(target.connection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }));
        expect(report.reachable).toBe(true);
        expect(report.privileges.createInSchema).toBe(false);
        expect(report.verdict.ok).toBe(false);
        expect(report.verdict.blocks.map(item => item.code)).toContain('NO_CREATE_PRIVILEGE');
        expect(report.verdict.provisioning.required.map(item => item.action)).toContain('grant');
    });

    test('a schema holding someone else\'s table is foreign; one holding Goobster\'s tables is recognised; the probe does not touch either', async () => {
        const target = await schemaTarget();
        await target.admin.query(`CREATE TABLE ${target.name}.invoices (id int)`);
        const before = await target.catalog();
        const foreign = await lib.probeConnection(target.connection());
        expect(foreign.schema).toMatchObject({ state: 'foreign', foreign: ['invoices'] });
        expect(foreign.verdict.blocks.map(item => item.code)).toContain('SCHEMA_FOREIGN');
        expect(await target.catalog()).toBe(before);

        const clean = await schemaTarget();
        const model = expectedSchema();
        const first = Object.keys(model.tables)[0];
        await clean.admin.query(`CREATE TABLE ${clean.name}."${first}" (id int)`);
        const partial = await lib.probeConnection(clean.connection());
        expect(['goobster-older', 'goobster-newer']).toContain(partial.schema.state);
    });

    test('the suite database\'s own Goobster schema is read as this release', async () => {
        const admin = new Client({ connectionString: BASE_URL });
        await admin.connect();
        try {
            const holds = (await admin.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'")).rows[0].n;
            if (Number(holds) === 0) return;
        } finally {
            await admin.end();
        }
        const url = new URL(BASE_URL);
        const report = await lib.probeConnection({
            host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)), schema: 'public',
            user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), tls: { mode: 'prefer' }
        });
        expect(['goobster-current', 'goobster-older']).toContain(report.schema.state);
    });
});

withAdmin('provisioning against a real server', () => {
    const adminConnection = () => {
        const url = new URL(ADMIN_URL);
        return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: Number(url.port || 5432) };
    };

    async function fresh() {
        const suffix = `${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
        const names = { database: `g338_db_${suffix}`, role: `g338_role_${suffix}`, other: `g338_other_${suffix}` };
        const admin = new Client({ connectionString: ADMIN_URL });
        await admin.connect();
        cleanups.push(async () => {
            try {
                await admin.query(`DROP DATABASE IF EXISTS "${names.database}" WITH (FORCE)`);
                await admin.query(`DROP DATABASE IF EXISTS "${names.other}" WITH (FORCE)`);
                await admin.query(`DROP ROLE IF EXISTS "${names.role}"`);
            } finally {
                await admin.end().catch(() => { });
            }
        });
        const { host, port, user, password } = adminConnection();
        return {
            names,
            admin,
            application: lib.parseConnection({ host, port, database: names.database, schema: 'public', user: names.role, password: 'app-secret-4d2a', tls: { mode: 'prefer' } }),
            elevated: { user, password },
            digest: async () => JSON.stringify({
                databases: (await admin.query('SELECT datname FROM pg_database ORDER BY 1')).rows.map(row => row.datname).filter(item => !item.startsWith('g338_') || item === names.database || item === names.other),
                roles: (await admin.query('SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles ORDER BY 1')).rows.filter(row => !row.rolname.startsWith('g338_') || row.rolname === names.role)
            })
        };
    }

    test('creates the least-privilege role, the database, the extensions and the grants; then the application role can use exactly that and no more', async () => {
        const world = await fresh();
        const other = `${world.names.other}`;
        await world.admin.query(`CREATE DATABASE "${other}"`);
        const otherBefore = await world.admin.query('SELECT datname, datacl::text AS acl FROM pg_database WHERE datname = $1', [other]);

        const checked = await lib.checkProvisioning({ application: world.application, elevated: world.elevated, actions: lib.ACTIONS, tlsMode: 'prefer' });
        expect(checked.blocked).toEqual([]);
        const checkedDigest = await world.digest();
        expect(checkedDigest).not.toContain(world.names.role);
        expect(checkedDigest).not.toContain(world.names.database);

        const out = await lib.runProvisioning({ application: world.application, elevated: world.elevated, actions: lib.ACTIONS, tlsMode: 'prefer' });
        expect(out.results.map(item => item.status)).toEqual(expect.arrayContaining(['done']));

        const role = (await world.admin.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1', [world.names.role])).rows[0];
        expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true, rolreplication: false, rolbypassrls: false });
        expect((await world.admin.query('SELECT rolpassword LIKE $1 AS scram FROM pg_authid WHERE rolname = $2', ['SCRAM-SHA-256$%', world.names.role])).rows[0]).toEqual({ scram: true });

        const otherAfter = await world.admin.query('SELECT datname, datacl::text AS acl FROM pg_database WHERE datname = $1', [other]);
        expect(otherAfter.rows).toEqual(otherBefore.rows);

        const report = await lib.probeConnection({ ...world.application, tls: { mode: 'prefer', caFile: null } });
        expect(report).toMatchObject({ reachable: true, auth: 'ok', schema: { state: 'empty' }, privileges: { connect: true, createInSchema: true } });
        expect(report.extensions.citext.installed).toBe(true);
        expect(report.extensions.vector.installed).toBe(true);
        expect(report.verdict).toMatchObject({ ok: true, next: 'apply-schema' });
        expect(report.role).toMatchObject({ superuser: false, createDatabase: false, createRole: false });

        const app = new Client({ host: world.application.host, port: world.application.port, database: world.names.database, user: world.names.role, password: 'app-secret-4d2a' });
        await app.connect();
        try {
            await expect(app.query('CREATE ROLE sneaky')).rejects.toThrow();
            await expect(app.query('CREATE DATABASE sneaky')).rejects.toThrow();
            await app.query('CREATE TABLE ok_to_create (id int)');
        } finally {
            await app.end();
        }
        // The credential used for this is not stored anywhere by the library.
        expect(JSON.stringify(out)).not.toContain(world.elevated.password || '\u0000');
    });

    test('it refuses a schema that already holds foreign tables, a role that exists, and does nothing before refusing', async () => {
        const world = await fresh();
        await lib.runProvisioning({ application: world.application, elevated: world.elevated, actions: ['create-role', 'create-database', 'grant', 'create-extension.citext'], tlsMode: 'prefer' });
        const target = new Client({ host: world.application.host, port: world.application.port, database: world.names.database, user: world.elevated.user, password: world.elevated.password });
        await target.connect();
        await target.query('CREATE TABLE public.invoices (id int)');
        await target.end();
        const before = await world.digest();
        await expect(lib.runProvisioning({ application: world.application, elevated: world.elevated, actions: ['create-extension.vector', 'grant'], tlsMode: 'prefer' })).rejects.toMatchObject({ code: 'SCHEMA_FOREIGN' });
        expect(await world.digest()).toBe(before);
    });

    test('it refuses to create a role that already exists, before changing anything', async () => {
        const world = await fresh();
        await lib.runProvisioning({ application: world.application, elevated: world.elevated, actions: ['create-role'], tlsMode: 'prefer' });
        const before = await world.digest();
        await expect(lib.runProvisioning({ application: world.application, elevated: world.elevated, actions: ['create-role', 'create-database'], tlsMode: 'prefer' })).rejects.toMatchObject({ code: 'ROLE_EXISTS' });
        expect(await world.digest()).toBe(before);
    });

    test('an elevated role without CREATEROLE/CREATEDB is told what the administrator must run, and nothing changes', async () => {
        const world = await fresh();
        const limited = { user: `${world.names.role}_lim`, password: 'limited-pw-1' };
        await world.admin.query(`CREATE ROLE "${limited.user}" LOGIN PASSWORD '${limited.password}'`);
        cleanups.push(async () => { await world.admin.query(`DROP ROLE IF EXISTS "${limited.user}"`); });
        const before = await world.digest();
        await expect(lib.runProvisioning({ application: world.application, elevated: limited, actions: ['create-role', 'create-database', 'grant'], tlsMode: 'prefer' }))
            .rejects.toMatchObject({ code: 'PROVISIONING_NOT_PERMITTED', details: { blocked: expect.arrayContaining(['create-role', 'create-database']) } });
        const check = await lib.checkProvisioning({ application: world.application, elevated: limited, actions: ['create-role', 'create-database'], tlsMode: 'prefer' });
        expect(check.dba.join('\n')).toContain(`CREATE DATABASE "${world.names.database}"`);
        expect(check.dba.join('\n')).toContain('<APPLICATION_PASSWORD>');
        expect(await world.digest()).toBe(before);
    });

    test('the probe distinguishes an extension installed on the server from one created in this database', async () => {
        const world = await fresh();
        await lib.runProvisioning({ application: world.application, elevated: world.elevated, actions: ['create-role', 'create-database', 'grant'], tlsMode: 'prefer' });
        const report = await lib.probeConnection({ ...world.application, tls: { mode: 'prefer', caFile: null } });
        expect(report.extensions.citext).toMatchObject({ available: true, installed: false, state: 'library-only' });
        expect(report.extensions.citext.summary).toMatch(/not created in this database/);
        expect(report.verdict.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['EXTENSION_PRIVILEGE']));
        expect(report.verdict.provisioning.required.map(item => item.action)).toEqual(expect.arrayContaining(['create-extension.citext']));
    });
});
