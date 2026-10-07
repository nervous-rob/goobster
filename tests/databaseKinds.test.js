/**
 * The operations that connect an installation to an existing PostgreSQL
 * server (#338, documentation/database_connection.md): `database.provision`,
 * `database.schema.apply` and `database.connect`, and the Postgres answer of
 * `install.new`.
 *
 * Most of the specs drive the real engine, barrier, journal, audit and
 * environment overlay with a scripted server (the connection library's
 * inspector and the child processes are replaced through
 * `settings.databaseDeps`), so they run on SQLite and Postgres alike and need
 * no server. The last block runs the whole journey - provision, apply the
 * schema, probe - against a real server and needs GOOBSTER_DB_URL plus an
 * administrative role (see tests/dbConnectionProbe.test.js); it skips with
 * its reason otherwise.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { Client } = require('pg');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-db-kinds-'));
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'jest-own.sqlite');

const { newHarness, drive, codeOf, tempDir, makeRelease } = require('./helpers/installFixture');
const { createSeededSqlite } = require('./helpers/migrationSeed');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');
const { ManagerError } = require('@goobster/manager/errors');
const { discover } = require('@goobster/manager/install/discover');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const { tune } = require('@goobster/manager/maintenance/barrier');
const { createMaintenanceStore } = require('@goobster/manager/maintenance/store');
const environment = require('@goobster/manager/environment');
const { MANAGER_AUDIT_ACTIONS } = require('@goobster/manager/audit');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const { expectedSchema } = require('@goobster/core/db/migration/schemaModel');

const BASE_URL = process.env.GOOBSTER_DB_URL ? process.env.GOOBSTER_DB_URL.split('?')[0] : null;
const BRIDGE = { principal: 'owner-1', via: 'bridge' };
const TUNING = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 };
const APP_PASSWORD = 'app-pw/never?printed#41c9';
const ELEVATED_PASSWORD = 'elevated-pw-never-printed-7be2';
const cleanups = [];
const scratch = label => tempDir(cleanups.roots || (cleanups.roots = []), label);

function detectAdminUrl() {
    if (process.env.GOOBSTER_PG_TEST_ADMIN_URL) return process.env.GOOBSTER_PG_TEST_ADMIN_URL.split('?')[0];
    if (!BASE_URL) return null;
    const script = `const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.argv[1]});await c.connect();const r=await c.query('select rolsuper from pg_roles where rolname=current_user');await c.end();process.stdout.write(r.rows[0].rolsuper?'yes':'no')})().catch(()=>process.stdout.write('no'))`;
    const out = childProcess.spawnSync(process.execPath, ['-e', script, BASE_URL], { encoding: 'utf8', cwd: __dirname }).stdout;
    return out === 'yes' ? BASE_URL : null;
}
const ADMIN_URL = detectAdminUrl();
const withAdmin = ADMIN_URL ? describe : describe.skip;

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
}, 60000);

afterAll(() => {
    for (const dir of cleanups.roots || []) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------ a scripted server */

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

const goobsterTables = (mutate = () => {}) => {
    const tables = Object.entries(expectedSchema().tables).map(([name, model]) => ({ name, columns: model.columns.map(col => col.name) }));
    mutate(tables);
    return tables;
};

/** What the scripted server holds in the application's schema, changeable between steps. */
function scriptedServer(schema = 'current') {
    const server = {
        schema,
        urls: [],
        applied: [],
        counts: { users: 0, memory_embeddings: 0 },
        countCalls: 0
    };
    server.tables = () => {
        switch (server.schema) {
        case 'empty': return { tables: [], otherRelations: [] };
        case 'foreign': return { tables: [{ name: 'invoices', columns: ['id'] }], otherRelations: [] };
        case 'older': return { tables: goobsterTables(list => list.pop()), otherRelations: [] };
        case 'newer': return { tables: goobsterTables(list => list[0].columns.push('from_the_future')), otherRelations: [] };
        default: return { tables: goobsterTables(), otherRelations: [] };
        }
    };
    server.probeDeps = {
        createClient: () => ({}),
        inspect: async (url) => {
            server.urls.push(url);
            return inspected(server.schema === 'missing' ? { schemaExists: false } : server.tables());
        }
    };
    server.deps = {
        probeDeps: server.probeDeps,
        initDatabase: async ({ url, database }) => {
            server.applied.push({ url, database });
            server.schema = 'current';
            return { engine: 'postgres', tables: 3 };
        },
        runChild: async (operation) => {
            if (operation !== 'targetCounts') throw new Error(`unexpected child operation ${operation}`);
            server.countCalls += 1;
            return { counts: { ...server.counts } };
        },
        validate: async () => ({ workers: [{ name: 'api', healthy: true }], layout: 'standalone' })
    };
    return server;
}

const app = (extra = {}) => ({ host: 'db.example.com', port: 5432, database: 'goobster', schema: 'public', user: 'goobster_app', password: APP_PASSWORD, tls: { mode: 'require' }, ...extra });

/* ------------------------------------------------------------------ installations */

function startResponder({ fakes, settings }) {
    const env = { GOOBSTER_MANAGER_STATE_DIR: settings.storeDir };
    const seen = new Map();
    const timer = setInterval(() => {
        for (const name of ['api', 'bot', 'sandbox']) {
            const proc = fakes.last(name);
            if (!proc || proc.exit) continue;
            const control = coreLifecycle.readControl(name, { env });
            const request = control && control.request;
            if (!request || seen.get(name) === request.id) continue;
            seen.set(name, request.id);
            const state = request.type === 'resume' ? 'resumed' : (request.type === 'maintenance' ? 'fenced' : null);
            if (state) coreMaintenance.writeFenceAck({ worker: name, fence: request.fence, state, pid: proc.pid, env });
        }
    }, 5);
    timer.unref();
    cleanups.push(() => clearInterval(timer));
}

/**
 * A claimed, adopted installation with fake writers that acknowledge the
 * fence. `sqlite`: 'seeded' (the file holds data), 'empty' (a valid file with
 * no rows). `server` scripts the Postgres side.
 */
async function setup({ sqlite = 'empty', server = scriptedServer(), env = {}, deps = {} } = {}) {
    const root = scratch('dbk');
    const harness = await newHarness({
        root,
        env: { GOOBSTER_RUNTIME_MODE: 'standalone', ...env },
        installDeps: { discover: opts => discover({ ...opts, exec: () => null }) }
    });
    const { settings, code } = harness;
    fs.mkdirSync(path.join(code, 'scripts'), { recursive: true });
    fs.mkdirSync(settings.dataDir, { recursive: true });
    fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'goobster' }));
    fs.writeFileSync(settings.configPath, JSON.stringify({ webapp: { enabled: true } }));
    fs.writeFileSync(path.join(code, 'scripts', 'auto-update.sh'), '#!/bin/bash\n# goobster-manager-guard\nexit 0\n');
    if (sqlite === 'seeded') createSeededSqlite(settings.sqlitePath, { dataDir: settings.dataDir });
    else if (sqlite === 'empty') {
        const Database = require('better-sqlite3');
        const db = new Database(settings.sqlitePath);
        db.exec('CREATE TABLE self_docs (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO self_docs (body) VALUES (\'docs\'); CREATE TABLE users (id INTEGER PRIMARY KEY);');
        db.close();
    }
    const found = discover({ fs, home: root, env: settings.env, exec: () => null });
    await drive(harness, 'adopt', { label: 'Rob', candidateId: found.candidates[0].id });

    tune(settings.storeDir, TUNING);
    const fakes = createFakeWorkers();
    const supervisor = createSupervisor({ manager: harness.manager, adapter: fakes.adapter, checkHealth: fakes.checkHealth, sandboxActive: () => false, logger: { info() {}, warn() {}, error() {} }, policy: { ...FAST_POLICY } });
    const unregister = registry.register(settings.storeDir, supervisor);
    await supervisor.start();
    await waitFor(async () => (await supervisor.status()).workers.every(worker => worker.ackedRevision === 0), { what: 'worker acks' });
    startResponder({ fakes, settings });
    cleanups.push(async () => {
        tune(settings.storeDir, null);
        await supervisor.stop();
        unregister();
        for (const proc of fakes.alive()) proc.die(0);
    });

    settings.databaseDeps = { ...server.deps, ...deps };
    const installation = () => harness.manager.store.readInstallation().doc;
    const barrier = () => createMaintenanceStore({ storeDir: settings.storeDir }).read().doc;
    const overlay = () => environment.read(settings.storeDir);
    return { ...harness, server, fakes, supervisor, installation, barrier, overlay };
}

const journalText = harness => JSON.stringify(harness.manager.journal.list()) + JSON.stringify(harness.manager.journal.readAudit().entries);

function everythingUnder(dir, { skip = () => false } = {}) {
    let text = '';
    const walk = (current) => {
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && !skip(full) && fs.statSync(full).size < 4 * 1024 * 1024) text += `\n${fs.readFileSync(full, 'latin1')}`;
        }
    };
    walk(dir);
    return text;
}

const connectInput = (over = {}) => ({ connection: app(), ...over });

/* ============================================================== registration */

describe('registration', () => {
    test('the three audit actions are registered on both sides, and the kinds are public', async () => {
        for (const action of ['manager.database.provision', 'manager.database.schema.apply', 'manager.database.connect']) {
            expect(MANAGER_AUDIT_ACTIONS).toContain(action);
            expect(operatorAudit.ACTIONS.has(action)).toBe(true);
        }
        const env = await setup();
        const kinds = require('@goobster/manager/engine/kinds/database').createKinds({ settings: env.settings });
        for (const name of kinds.map(item => item.kind)) expect(env.manager.engine.kinds).toContain(name);
        expect(kinds.map(item => [item.kind, item.public])).toEqual([
            ['database.provision', true], ['database.schema.apply', true], ['database.connect', true]
        ]);
    }, 60000);
});

/* ================================================================== connect */

describe('database.connect: the rules before anything is written', () => {
    test('a SQLite database that holds data is refused and routed to the migration, naming P4.3 and the migrate command', async () => {
        const env = await setup({ sqlite: 'seeded' });
        const error = await drive(env, 'database.connect', connectInput(), { auth: BRIDGE, apply: false }).catch(e => e);
        expect(error.code).toBe('MIGRATION_REQUIRED');
        expect(error.message).toContain('migrate');
        expect(error.message).toContain('P4.3');
        expect(error.details).toMatchObject({ migration: 'P4.3', command: 'migrate' });
        expect(error.details.populated.length).toBeGreaterThan(0);
        expect(env.overlay().present).toBe(false);
        expect(env.barrier().active).toBe(false);
        expect(env.installation().database).toMatchObject({ engine: 'sqlite' });
        expect(env.server.urls).toEqual([]);
    }, 120000);

    test('a SQLite file that cannot be read is refused, not assumed empty', async () => {
        const env = await setup({ deps: { readSqlite: async () => ({ present: true, readable: false, tables: [], code: 'SOURCE_UNREADABLE' }) } });
        expect(await codeOf(drive(env, 'database.connect', connectInput(), { auth: BRIDGE, apply: false }))).toBe('SQLITE_UNREADABLE');
    }, 60000);

    test('only bookkeeping rows (the self-knowledge corpus, the audit log) leave a SQLite file empty', async () => {
        const env = await setup({ sqlite: 'empty' });
        const { planned } = await drive(env, 'database.connect', connectInput(), { auth: BRIDGE, apply: false });
        expect(planned.plan).toMatchObject({ effect: 'connect-database', from: { engine: 'sqlite' }, to: { engine: 'postgres', host: 'db.example.com', database: 'goobster' }, leaves: { sqliteFile: 'kept in place, not deleted' } });
        expect(planned.plan.leaves.bookkeepingRows).toBeGreaterThan(0);
        expect(JSON.stringify(planned)).not.toContain(APP_PASSWORD);
    }, 60000);

    test.each([
        ['empty', 'SCHEMA_NOT_APPLIED'],
        ['foreign', 'SCHEMA_FOREIGN'],
        ['newer', 'SCHEMA_NEWER'],
        ['missing', 'SCHEMA_MISSING']
    ])('a %s schema is refused with %s and nothing is changed', async (schema, code) => {
        const env = await setup({ server: scriptedServer(schema) });
        expect(await codeOf(drive(env, 'database.connect', connectInput(), { auth: BRIDGE }))).toBe(code);
        expect(env.overlay().present).toBe(false);
        expect(env.barrier().active).toBe(false);
        expect(env.installation().database).toMatchObject({ engine: 'sqlite' });
        expect(env.server.applied).toEqual([]);
    }, 60000);

    test('an unreachable server is a probe block, with no overlay and no barrier', async () => {
        const server = scriptedServer();
        server.probeDeps.inspect = async () => ({ reachable: false, code: 'ECONNREFUSED' });
        const env = await setup({ server });
        const error = await drive(env, 'database.connect', connectInput(), { auth: BRIDGE, apply: false }).catch(e => e);
        expect(error.code).toBeUndefined();
        const failure = await drive(env, 'database.connect', connectInput(), { auth: BRIDGE }).catch(e => e);
        expect(failure.code).toBe('PROBE_BLOCKED');
        expect(env.overlay().present).toBe(false);
        expect(env.barrier().active).toBe(false);
    }, 60000);

    test('an environment variable that names another database wins over the overlay, so the connection is refused', async () => {
        const env = await setup({ env: { GOOBSTER_DB_URL: 'postgres://elsewhere:pw@other.example.com:5432/other' } });
        expect(await codeOf(drive(env, 'database.connect', connectInput(), { auth: BRIDGE }))).toBe('ENV_OVERRIDES_OVERLAY');
        expect(env.overlay().present).toBe(false);
    }, 60000);

    test('a migration that left a partial state blocks the change', async () => {
        const env = await setup();
        fs.writeFileSync(path.join(env.settings.storeDir, 'migration.json'), JSON.stringify({ version: 1, status: 'failed', steps: {}, cutover: {} }));
        const code = await codeOf(drive(env, 'database.connect', connectInput(), { auth: BRIDGE, apply: false }));
        expect(['MIGRATION_IN_PROGRESS', 'MIGRATION_STATE_UNREADABLE']).toContain(code);
    }, 60000);

    test('an installation nobody has claimed has nothing to connect, and the input shape is checked', async () => {
        const root = scratch('unclaimed');
        const bare = await newHarness({ root });
        expect(await codeOf(bare.manager.engine.plan('database.connect', connectInput(), LOCAL_AUTH, { internal: true }))).toBe('STATE_NOT_ALLOWED');
        const env = await setup();
        expect(await codeOf(env.manager.engine.plan('database.connect', connectInput({ extra: 1 }), BRIDGE, { internal: true }))).toBe('INVALID_INPUT');
    }, 60000);
});

describe('database.connect: the cutover', () => {
    test('enters the barrier, probes, validates, then writes the overlay and the record and leaves the barrier up', async () => {
        const order = [];
        const server = scriptedServer();
        const env = await setup({
            server,
            deps: {
                beforeStep: async ({ step }) => {
                    order.push(`${step}:overlay=${environment.read(env.settings.storeDir).present}:record=${env.installation().database.engine}`);
                }
            }
        });
        const { applied } = await drive(env, 'database.connect', connectInput(), { auth: BRIDGE });
        expect(applied.operation.status).toBe('applied');
        expect(order).toEqual([
            'maintenance:overlay=false:record=sqlite',
            'probe:overlay=false:record=sqlite',
            'validate:overlay=false:record=sqlite',
            'cutover:overlay=false:record=sqlite',
            'settle:overlay=true:record=postgres',
            'release:overlay=true:record=postgres'
        ]);

        const overlayFile = environment.fileFor(env.settings.storeDir);
        expect(fs.statSync(overlayFile).mode & 0o777).toBe(0o600);
        const url = environment.read(env.settings.storeDir).values.GOOBSTER_DB_URL;
        expect(url).toContain('db.example.com');
        expect(decodeURIComponent(url)).toContain(APP_PASSWORD);
        expect(url).toContain('sslmode=require');
        expect(env.settings.dbUrl).toBe(url);
        expect(env.installation().database).toEqual({ engine: 'postgres', external: true });

        expect(env.barrier()).toMatchObject({ active: true, phase: 'cutover' });
        expect(applied.result).toMatchObject({ connected: true, engine: 'postgres', schema: 'goobster-current', instancePaused: true, maintenance: { enteredByOperation: true } });
        expect(applied.result.maintenance.released).toBeUndefined();

        expect(fs.existsSync(env.settings.sqlitePath)).toBe(true);
        const published = journalText(env) + JSON.stringify(applied);
        expect(published).not.toContain(APP_PASSWORD);
        expect(published).not.toContain(encodeURIComponent(APP_PASSWORD));
        expect(published).not.toContain(url);
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.database.connect');
        expect(entry).toMatchObject({ outcome: 'applied', detail: { from: 'sqlite', to: 'postgres', schema: 'goobster-current', database: 'goobster', validated: 1 } });
        expect(JSON.stringify(entry)).not.toContain('password');
    }, 120000);

    test('release: true gives the barrier back once the connection is in place', async () => {
        const env = await setup();
        const { applied } = await drive(env, 'database.connect', connectInput({ release: true }), { auth: BRIDGE });
        expect(applied.result.maintenance.released).toBe(true);
        expect(env.barrier().active).toBe(false);
        expect(env.installation().database.engine).toBe('postgres');
    }, 120000);

    test('a held barrier is used as it is, and a writer that did not acknowledge the fence refuses the operation', async () => {
        const env = await setup();
        const held = (await env.manager.engine.run('maintenance.enter', { reason: 'database connection', timeoutSeconds: 10 }, BRIDGE)).result;
        createMaintenanceStore({ storeDir: env.settings.storeDir }).update((doc) => {
            doc.writers.api.acked = false;
            return doc;
        });
        const maintenance = { operationId: held.operationId, fence: held.fence };
        expect(await codeOf(drive(env, 'database.connect', connectInput({ maintenance }), { auth: BRIDGE }))).toBe('WRITER_UNACKNOWLEDGED');
        expect(await codeOf(drive(env, 'database.connect', connectInput({ maintenance: { operationId: held.operationId, fence: held.fence + 1 } }), { auth: BRIDGE }))).toBe('MAINTENANCE_NOT_HELD');
        expect(env.overlay().present).toBe(false);

        createMaintenanceStore({ storeDir: env.settings.storeDir }).update((doc) => {
            doc.writers.api.acked = true;
            return doc;
        });
        const { applied } = await drive(env, 'database.connect', connectInput({ maintenance }), { auth: BRIDGE });
        expect(applied.result.maintenance).toMatchObject({ operationId: held.operationId, enteredByOperation: false });
        expect(env.barrier()).toMatchObject({ active: true, operationId: held.operationId });
    }, 120000);

    test('a validation that fails changes nothing and gives back a barrier this operation entered', async () => {
        const env = await setup({ deps: { validate: async () => { throw new ManagerError(409, 'WORKER_UNHEALTHY', 'worker did not come up'); } } });
        const failure = await drive(env, 'database.connect', connectInput(), { auth: BRIDGE }).catch(e => e);
        expect(failure.code).toBe('WORKER_UNHEALTHY');
        expect(env.overlay().present).toBe(false);
        expect(env.installation().database.engine).toBe('sqlite');
        expect(env.barrier().active).toBe(false);
        expect(journalText(env)).not.toContain(APP_PASSWORD);
    }, 120000);

    test('an application that wrote to the target while it was validated is caught by the row counts', async () => {
        const server = scriptedServer();
        let calls = 0;
        server.deps.runChild = async () => ({ counts: { users: calls++ === 0 ? 0 : 1 } });
        const env = await setup({ server });
        const failure = await drive(env, 'database.connect', connectInput(), { auth: BRIDGE }).catch(e => e);
        expect(failure.code).toBe('VALIDATION_WROTE');
        expect(env.overlay().present).toBe(false);
        expect(env.installation().database.engine).toBe('sqlite');
    }, 120000);

    test('Postgres to Postgres: the previous database is not touched and the overlay moves to the new connection', async () => {
        const server = scriptedServer();
        const env = await setup({ server });
        const first = await drive(env, 'database.connect', connectInput({ release: true }), { auth: BRIDGE });
        const firstUrl = environment.read(env.settings.storeDir).values.GOOBSTER_DB_URL;
        expect(first.applied.result.connected).toBe(true);

        server.urls.length = 0;
        const second = await drive(env, 'database.connect', connectInput({ connection: app({ host: 'replica.example.com', database: 'goobster2' }), release: true }), { auth: BRIDGE });
        expect(second.planned.plan.from.engine).toBe('postgres');
        expect(second.applied.result.connected).toBe(true);
        const secondUrl = environment.read(env.settings.storeDir).values.GOOBSTER_DB_URL;
        expect(secondUrl).toContain('replica.example.com');
        expect(secondUrl).not.toBe(firstUrl);
        expect(server.urls.every(url => !url.includes('db.example.com/goobster?') || true)).toBe(true);
        expect(env.installation().database).toEqual({ engine: 'postgres', external: true });
        expect(journalText(env)).not.toContain(APP_PASSWORD);
    }, 180000);

    test('an overlay written before a crash is reported as a mismatch after the restart, and connecting again completes it', async () => {
        let failNext = true;
        const env = await setup({ deps: { afterOverlayWrite: async () => { if (failNext) { failNext = false; throw new ManagerError(500, 'SIMULATED_CRASH', 'crash'); } } } });
        const failure = await drive(env, 'database.connect', connectInput(), { auth: BRIDGE }).catch(e => e);
        expect(failure.code).toBe('SIMULATED_CRASH');
        expect(env.overlay().present).toBe(true);
        expect(env.installation().database.engine).toBe('sqlite');

        // a restarted manager reads the overlay into its settings
        environment.apply(env.settings, environment.read(env.settings.storeDir).values);
        const state = require('@goobster/manager/database/state');
        expect((await state.databaseStatus({ settings: env.settings, doc: env.installation(), fs })).mismatch).toBe(true);

        const held = env.barrier();
        expect(held.active).toBe(true);
        await env.manager.engine.run('maintenance.release', { operationId: held.operationId, fence: held.fence, force: true, acknowledgeMutation: true }, BRIDGE);
        const again = await drive(env, 'database.connect', connectInput({ release: true }), { auth: BRIDGE });
        expect(again.applied.result.connected).toBe(true);
        expect(env.installation().database).toEqual({ engine: 'postgres', external: true });
        expect((await state.databaseStatus({ settings: env.settings, doc: env.installation(), fs })).mismatch).toBe(false);
    }, 120000);
});

/* ============================================================= schema.apply */

describe('database.schema.apply', () => {
    test('applies the schema to an empty schema through the child, with the URL in memory only', async () => {
        const server = scriptedServer('empty');
        const env = await setup({ server });
        const { planned, applied } = await drive(env, 'database.schema.apply', { connection: app() });
        expect(planned.plan).toMatchObject({ effect: 'apply-schema', noop: false });
        expect(applied.result).toMatchObject({ before: 'empty', after: { state: 'goobster-current' } });
        expect(server.applied).toHaveLength(1);
        expect(server.applied[0].database).toEqual({ engine: 'postgres', external: true });
        expect(decodeURIComponent(server.applied[0].url)).toContain(APP_PASSWORD);
        expect(env.overlay().present).toBe(false);
        expect(journalText(env) + JSON.stringify(planned) + JSON.stringify(applied)).not.toContain(APP_PASSWORD);
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.database.schema.apply');
        expect(entry).toMatchObject({ outcome: 'applied', detail: { before: 'empty', database: 'goobster', schema: 'public' } });
    }, 60000);

    test('brings an older Goobster schema up to date and leaves a current one alone', async () => {
        const server = scriptedServer('older');
        const env = await setup({ server });
        const older = await drive(env, 'database.schema.apply', { connection: app() });
        expect(older.planned.plan.effect).toBe('update-schema');
        expect(server.applied).toHaveLength(1);

        const current = await drive(env, 'database.schema.apply', { connection: app() });
        expect(current.planned.plan).toMatchObject({ effect: 'none', noop: true });
        expect(server.applied).toHaveLength(1);
        const skipped = current.applied.operation.steps.filter(step => step.name === 'apply').pop();
        expect(skipped.status).toBe('skipped');
        expect(JSON.stringify(skipped)).toContain('ALREADY_CURRENT');
    }, 60000);

    test.each([['foreign', 'SCHEMA_FOREIGN'], ['newer', 'SCHEMA_NEWER'], ['missing', 'SCHEMA_MISSING']])('never on a %s schema (%s)', async (schema, code) => {
        const server = scriptedServer(schema);
        const env = await setup({ server });
        expect(await codeOf(drive(env, 'database.schema.apply', { connection: app() }))).toBe(code);
        expect(server.applied).toEqual([]);
    }, 60000);

    test('the schema changing to foreign between the plan and the apply stops the operation before the child runs', async () => {
        const server = scriptedServer('empty');
        const env = await setup({ server });
        const planned = await env.manager.engine.plan('database.schema.apply', { connection: app() }, LOCAL_AUTH, { internal: true });
        server.schema = 'foreign';
        expect(await codeOf(env.manager.engine.validate(planned.id, LOCAL_AUTH))).toBe('SCHEMA_FOREIGN');
        expect(server.applied).toEqual([]);
    }, 60000);
});

const LOCAL_AUTH = { principal: 'local:cli', via: 'local' };

/* ============================================================== provision */

describe('database.provision (scripted server)', () => {
    const elevated = { user: 'admin', password: ELEVATED_PASSWORD };
    const actions = ['create-role', 'create-database', 'create-extension.citext', 'grant'];
    const checked = (over = {}) => ({
        state: { roleExists: false, databaseExists: false, schemaExists: false, schemaState: null, extensions: { citext: { available: true, installed: false, trusted: true }, vector: { available: true, installed: false, trusted: false } } },
        permitted: { 'create-role': true, 'create-database': true, 'create-extension.citext': true, grant: true },
        blocked: [],
        dba: [],
        capabilities: { superuser: false, createRole: true, createDatabase: true },
        ...over
    });

    test('plans the ticked statements with the password as a placeholder, runs only those actions, and persists no credential', async () => {
        const seen = [];
        const env = await setup({
            deps: {
                checkProvisioning: async (args) => { seen.push(['check', args.actions]); return checked(); },
                runProvisioning: async (args) => {
                    seen.push(['run', args.actions, args.elevated.password, args.application.password]);
                    return { results: args.actions.map(action => ({ action, status: 'done' })) };
                }
            }
        });
        const { planned, applied } = await drive(env, 'database.provision', { connection: app(), elevated, actions }, { auth: LOCAL_AUTH });
        expect(planned.plan).toMatchObject({ effect: 'provision-database', elevated: { user: 'admin', persisted: false } });
        expect(planned.plan.actions.map(item => item.action)).toEqual(actions);
        const statements = planned.plan.actions.flatMap(item => item.statements).join('\n');
        expect(statements).toMatch(/CREATE ROLE/);
        expect(statements).toMatch(/NOSUPERUSER/);
        expect(statements).not.toMatch(/\bDROP\b/i);
        expect(seen.filter(item => item[0] === 'run')).toEqual([['run', actions, ELEVATED_PASSWORD, APP_PASSWORD]]);

        const published = journalText(env) + JSON.stringify(planned) + JSON.stringify(applied);
        for (const secret of [ELEVATED_PASSWORD, APP_PASSWORD]) expect(published).not.toContain(secret);
        expect(everythingUnder(env.root)).not.toContain(ELEVATED_PASSWORD);
        expect(everythingUnder(env.root)).not.toContain(APP_PASSWORD);
        expect(env.overlay().present).toBe(false);
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.database.provision');
        expect(entry).toMatchObject({ outcome: 'applied', detail: { done: actions.length, already: 0, database: 'goobster', schema: 'public' } });
    }, 60000);

    test('an elevated credential without the privileges refuses at validate, changes nothing and hands over the DBA statements', async () => {
        const ran = [];
        const dba = ['-- connected to the database "goobster":', 'CREATE ROLE "goobster_app" LOGIN PASSWORD \'<APPLICATION_PASSWORD>\';'];
        const env = await setup({
            deps: {
                checkProvisioning: async () => checked({ permitted: { 'create-role': false }, blocked: [{ action: 'create-role', reason: 'CREATEROLE' }], dba }),
                runProvisioning: async () => { ran.push(1); return { results: [] }; }
            }
        });
        const error = await drive(env, 'database.provision', { connection: app(), elevated, actions }, { auth: LOCAL_AUTH }).catch(e => e);
        expect(error.code).toBe('PROVISIONING_NOT_PERMITTED');
        expect(error.details.dba.join('\n')).toContain('<APPLICATION_PASSWORD>');
        expect(JSON.stringify(error.details)).not.toContain(APP_PASSWORD);
        expect(ran).toEqual([]);
    }, 60000);

    test('refusals from the library (a foreign schema, a role that exists) surface as conflicts with their code', async () => {
        const env = await setup({
            deps: { checkProvisioning: async () => { throw Object.assign(new Error('The schema holds tables that are not Goobster\'s.'), { name: 'ConnectionError', code: 'SCHEMA_FOREIGN', details: { objects: ['invoices'] } }); } }
        });
        const error = await drive(env, 'database.provision', { connection: app(), elevated, actions }, { auth: LOCAL_AUTH, apply: false }).catch(e => e);
        expect(error).toMatchObject({ code: 'SCHEMA_FOREIGN', status: 409 });
    }, 60000);

    test('input: unknown fields, no actions and an unknown action are refused', async () => {
        const env = await setup();
        for (const bad of [
            { connection: app(), elevated, actions, extra: 1 },
            { connection: app(), elevated, actions: [] },
            { connection: app(), elevated, actions: ['drop-database'] },
            { connection: app(), actions },
            { elevated, actions }
        ]) {
            expect(await codeOf(env.manager.engine.plan('database.provision', bad, LOCAL_AUTH, { internal: true }))).toMatch(/INVALID_INPUT|INVALID_ACTIONS/);
        }
    }, 60000);
});

/* ============================================================= install.new */

describe('install.new with a Postgres connection answer', () => {
    async function freshHarness(server, deps = {}) {
        const root = scratch('inst');
        const release = makeRelease(scratch('inst-src'));
        const calls = [];
        const harness = await newHarness({
            root,
            installDeps: {
                initDatabase: async (args) => { calls.push({ ...args, overlayAtCall: environment.read(harness.settings.storeDir).present }); server.schema = 'current'; return { engine: args.database.engine, tables: 3 }; },
                ...deps
            }
        });
        harness.settings.databaseDeps = { ...server.deps };
        return { harness, release, calls };
    }

    test('plans with the public target only, applies the schema to that server, then writes the overlay and the engine into the record', async () => {
        const server = scriptedServer('empty');
        const { harness, release, calls } = await freshHarness(server);
        const input = { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'postgres', connection: app() } };
        const { planned, applied } = await drive(harness, 'install.new', input);
        expect(planned.plan.databaseTarget).toMatchObject({ host: 'db.example.com', database: 'goobster', user: 'goobster_app' });
        expect(planned.plan.databaseTarget).not.toHaveProperty('password');
        expect(applied.operation.status).toBe('applied');

        expect(calls).toHaveLength(1);
        expect(calls[0].database).toEqual({ engine: 'postgres', external: true });
        expect(decodeURIComponent(calls[0].url)).toContain(APP_PASSWORD);
        expect(calls[0].overlayAtCall).toBe(false);

        const stored = environment.read(harness.settings.storeDir);
        expect(decodeURIComponent(stored.values.GOOBSTER_DB_URL)).toContain(APP_PASSWORD);
        expect(fs.statSync(environment.fileFor(harness.settings.storeDir)).mode & 0o777).toBe(0o600);
        expect(harness.manager.store.readInstallation().doc.database).toEqual({ engine: 'postgres', external: true });
        expect(harness.settings.dbUrl).toBe(stored.values.GOOBSTER_DB_URL);

        const published = journalText(harness) + JSON.stringify(planned) + JSON.stringify(applied);
        expect(published).not.toContain(APP_PASSWORD);
        expect(published).not.toContain(encodeURIComponent(APP_PASSWORD));
        const skipOverlay = file => file === environment.fileFor(harness.settings.storeDir);
        expect(everythingUnder(harness.root, { skip: skipOverlay })).not.toContain(APP_PASSWORD);
    }, 120000);

    test('a server that cannot be used blocks the preflight, and nothing is written', async () => {
        const server = scriptedServer('foreign');
        const { harness, release, calls } = await freshHarness(server);
        const failure = await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'postgres', connection: app() } }).catch(e => e);
        expect(failure.code).toBe('PREFLIGHT_FAILED');
        expect(failure.details.findings.map(item => item.code)).toContain('DATABASE_SCHEMA_FOREIGN');
        expect(calls).toEqual([]);
        expect(environment.read(harness.settings.storeDir).present).toBe(false);
        expect(JSON.stringify(failure.details)).not.toContain(APP_PASSWORD);
    }, 120000);

    test('SQLite remains the default; a connection with the sqlite engine is refused', async () => {
        const server = scriptedServer('empty');
        const { harness, release, calls } = await freshHarness(server);
        expect(await codeOf(drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'sqlite', connection: app() } }, { apply: false }))).toBe('INVALID_INPUT');
        const { planned } = await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true } }, { apply: false });
        expect(planned.plan.target.database).toMatchObject({ engine: 'sqlite' });
        expect(planned.plan.databaseTarget).toBeUndefined();
        expect(calls).toEqual([]);
    }, 120000);

    test('the paired layout cannot proceed with SQLite, but can with a Postgres connection answer', async () => {
        const server = scriptedServer('empty');
        const { harness, release } = await freshHarness(server);
        const sqliteRun = await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true }, layout: 'paired', database: { engine: 'sqlite' } }, { apply: false }).catch(e => e);
        const findings = (sqliteRun.details && sqliteRun.details.findings) || (sqliteRun.planned && sqliteRun.planned.plan.preflight.findings) || [];
        expect(findings.map(item => item.code)).toContain('PAIRED_REQUIRES_POSTGRES');

        const postgresRun = await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true }, layout: 'paired', database: { engine: 'postgres', connection: app() } }, { apply: false }).catch(e => e);
        const pgFindings = (postgresRun.details && postgresRun.details.findings) || (postgresRun.planned && postgresRun.planned.plan.preflight.findings) || [];
        expect(pgFindings.map(item => item.code)).not.toContain('PAIRED_REQUIRES_POSTGRES');
    }, 120000);

    test('an environment GOOBSTER_DB_URL that names another database blocks a connection answer', async () => {
        const server = scriptedServer('empty');
        const root = scratch('inst-env');
        const release = makeRelease(scratch('inst-env-src'));
        const harness = await newHarness({ root, env: { GOOBSTER_DB_URL: 'postgres://u:p@other.example.com:5432/other' }, installDeps: { initDatabase: async () => ({ engine: 'postgres', tables: 0 }) } });
        harness.settings.databaseDeps = { ...server.deps };
        const failure = await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'postgres', connection: app() } }).catch(e => e);
        expect(failure.code).toBe('PREFLIGHT_FAILED');
        expect(failure.details.findings.map(item => item.code)).toContain('ENV_OVERRIDES_OVERLAY');
    }, 120000);
});

/* ======================================================= a real server, all the way */

withAdmin('the whole journey against a real server', () => {
    const adminUrl = () => new URL(ADMIN_URL);
    const suffix = () => `${process.pid}_${crypto.randomBytes(3).toString('hex')}`;

    async function adminClient() {
        const client = new Client({ connectionString: ADMIN_URL });
        await client.connect();
        return client;
    }

    async function names(client) {
        const databases = (await client.query('SELECT datname FROM pg_database')).rows.map(row => row.datname);
        const roles = (await client.query('SELECT rolname FROM pg_roles')).rows.map(row => row.rolname);
        return { databases, roles };
    }

    function target() {
        const id = suffix();
        const url = adminUrl();
        const connection = {
            host: url.hostname,
            port: Number(url.port || 5432),
            database: `k338_${id}`,
            schema: 'goob',
            user: `k338_app_${id}`,
            password: APP_PASSWORD,
            tls: { mode: 'prefer' }
        };
        const elevated = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
        cleanups.push(async () => {
            const admin = await adminClient();
            try {
                await admin.query(`DROP DATABASE IF EXISTS "${connection.database}" WITH (FORCE)`);
                await admin.query(`DROP ROLE IF EXISTS "${connection.user}"`);
            } finally {
                await admin.end();
            }
        });
        return { connection, elevated };
    }

    test('provisions a database, a role and a schema, applies Goobster\'s tables, and touches nothing else', async () => {
        const { connection, elevated } = target();
        const admin = await adminClient();
        const before = await names(admin);
        const env = await setup({ deps: { probeDeps: undefined, initDatabase: undefined, runChild: undefined, validate: undefined } });
        env.settings.databaseDeps = {};

        const actions = ['create-role', 'create-database', 'create-extension.citext', 'create-extension.vector', 'create-schema', 'grant'];
        const { planned, applied } = await drive(env, 'database.provision', { connection, elevated: { ...elevated, database: 'postgres' }, actions }, { auth: LOCAL_AUTH });
        expect(planned.plan.blocked).toEqual([]);
        expect(applied.operation.status).toBe('applied');
        expect(applied.result.verified).toMatchObject({ reachable: true });

        const after = await names(admin);
        expect(after.databases.filter(name => !before.databases.includes(name))).toEqual([connection.database]);
        expect(after.roles.filter(name => !before.roles.includes(name))).toEqual([connection.user]);
        const role = (await admin.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = $1', [connection.user])).rows[0];
        expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true });

        const apply = await drive(env, 'database.schema.apply', { connection });
        expect(apply.planned.plan.effect).toBe('apply-schema');
        expect(apply.applied.result.after).toMatchObject({ state: 'goobster-current' });

        const inside = new Client({ host: connection.host, port: connection.port, database: connection.database, user: elevated.user, password: elevated.password });
        await inside.connect();
        try {
            const tables = (await inside.query("SELECT table_schema, COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') GROUP BY table_schema")).rows;
            expect(tables.map(row => row.table_schema)).toEqual(['goob']);
            expect(tables[0].n).toBeGreaterThan(50);
        } finally {
            await inside.end();
        }

        const again = await drive(env, 'database.schema.apply', { connection });
        expect(again.planned.plan.noop).toBe(true);

        const published = journalText(env) + JSON.stringify(planned) + JSON.stringify(applied) + JSON.stringify(apply);
        for (const secret of [elevated.password, APP_PASSWORD]) expect(published).not.toContain(secret);
        const everything = everythingUnder(env.root);
        expect(everything).not.toContain(APP_PASSWORD);
        if (elevated.password) expect(everything).not.toContain(elevated.password);
        expect(environment.read(env.settings.storeDir).present).toBe(false);
        await admin.end();
    }, 180000);

    test('refuses to apply the schema into a schema that holds someone else\'s table, and leaves it as it was', async () => {
        const { connection, elevated } = target();
        const admin = await adminClient();
        const env = await setup();
        env.settings.databaseDeps = {};
        await drive(env, 'database.provision', { connection, elevated, actions: ['create-role', 'create-database', 'create-schema', 'grant'] }, { auth: LOCAL_AUTH });

        const inside = new Client({ host: connection.host, port: connection.port, database: connection.database, user: elevated.user, password: elevated.password });
        await inside.connect();
        try {
            await inside.query('CREATE TABLE goob.invoices (id int)');
            const before = (await inside.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'goob' ORDER BY 1")).rows;
            expect(await codeOf(drive(env, 'database.schema.apply', { connection }))).toBe('SCHEMA_FOREIGN');
            expect(await codeOf(drive(env, 'database.connect', { connection }, { auth: BRIDGE }))).toBe('SCHEMA_FOREIGN');
            const after = (await inside.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'goob' ORDER BY 1")).rows;
            expect(after).toEqual(before);
        } finally {
            await inside.end();
            await admin.end();
        }
    }, 180000);
});
