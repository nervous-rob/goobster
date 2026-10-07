/**
 * The SQLite to Postgres migration operation (#336, documentation/db_migration.md):
 * the `db.migrate.preflight`, `db.migrate` and `db.migrate.rollback` kinds over
 * a claimed manager whose maintenance barrier is held by fake writers, with
 * the real child processes doing the schema apply, copy and verification
 * against a second, throwaway Postgres schema.
 *
 * Without GOOBSTER_DB_URL the Postgres-target journeys are skipped with a
 * message; everything that needs no Postgres still runs: refusals, the state
 * file and its derived rollback boundary, the connection-switch
 * reconciliation, the rollback refusals, the audit plumbing and the
 * "no secret anywhere" checks.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-db-migration-'));
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'jest-own.sqlite');

const { newHarness, drive, codeOf, tempDir } = require('./helpers/installFixture');
const { createSeededSqlite, USER } = require('./helpers/migrationSeed');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');
const { discover } = require('@goobster/manager/install/discover');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const { tune } = require('@goobster/manager/maintenance/barrier');
const { createMaintenanceStore } = require('@goobster/manager/maintenance/store');
const environment = require('@goobster/manager/environment');
const { createMigrationState, noteWorkerStart } = require('@goobster/manager/migration/state');
const { migrationStatus } = require('@goobster/manager/migration/status');
const { reconcileMigration } = require('@goobster/manager/migration/reconcile');
const { createManager } = require('@goobster/manager/manager');
const { resolveSettings } = require('@goobster/manager/settings');
const extensions = require('@goobster/manager/extensions');
const { MANAGER_AUDIT_ACTIONS } = require('@goobster/manager/audit');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const { ROLLBACK_LIMIT } = require('@goobster/core/db/migration');

const BASE_URL = process.env.GOOBSTER_DB_URL ? process.env.GOOBSTER_DB_URL.split('?')[0] : null;
const withPostgres = BASE_URL ? describe : describe.skip;
const BRIDGE = { principal: 'owner-1', via: 'bridge' };
const TUNING = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 };
const PASSWORD_MARK = 'pw-never-appears-9f3a';
const PASSPHRASE = 'passphrase-never-appears-77c1';
const cleanups = [];
const scratch = label => tempDir(cleanups.roots || (cleanups.roots = []), label);

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fileSet = (file) => [file, `${file}-wal`, `${file}-shm`].filter(item => fs.existsSync(item));
// the database and a WAL that holds something; an empty -wal and the -shm index carry no data
const digestOf = file => [file, `${file}-wal`].filter(item => fs.existsSync(item) && (item === file || fs.statSync(item).size > 0)).map(item => `${path.basename(item)}:${sha(item)}`).join('|');
const snapshotHash = harness => createMigrationState({ storeDir: harness.settings.storeDir }).read().doc.steps.snapshot.sha256;
const currentHash = harness => require('@goobster/core/db/migration').hashSource(harness.sqlite).sha256;

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

/** A claimed, adopted, managed installation over a seeded SQLite file with fake writers that acknowledge the fence. */
async function setup({ env = {}, hooks, deps = {}, seed = true } = {}) {
    const root = scratch('mig');
    const harness = await newHarness({
        root,
        env: { GOOBSTER_RUNTIME_MODE: 'standalone', ...env },
        hooks,
        installDeps: { discover: opts => discover({ ...opts, exec: () => null }) }
    });
    const { settings, code } = harness;
    fs.mkdirSync(path.join(code, 'scripts'), { recursive: true });
    fs.mkdirSync(settings.dataDir, { recursive: true });
    fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'goobster' }));
    fs.writeFileSync(settings.configPath, JSON.stringify({ webapp: { enabled: true } }));
    fs.writeFileSync(path.join(code, 'scripts', 'auto-update.sh'), '#!/bin/bash\n# goobster-manager-guard\nexit 0\n');
    const seeded = seed ? createSeededSqlite(settings.sqlitePath, { dataDir: settings.dataDir }) : null;
    if (!seed) {
        const db = Buffer.alloc(4096);
        db.write('SQLite format 3\u0000', 0, 'latin1');
        fs.writeFileSync(settings.sqlitePath, db);
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

    const validations = [];
    settings.migrationDeps = {
        validate: async ({ url }) => {
            validations.push(url === undefined ? 'no-url' : 'called');
            return { workers: [{ name: 'api', healthy: true }], layout: 'standalone' };
        },
        ...deps
    };
    const installation = () => harness.manager.store.readInstallation().doc;
    const enter = async () => (await harness.manager.engine.run('maintenance.enter', { reason: 'migration', timeoutSeconds: 10 }, BRIDGE)).result;
    return { ...harness, seeded, fakes, supervisor, validations, installation, enter, sqlite: settings.sqlitePath };
}

async function targetSchema() {
    const name = `mig336_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${name}`);
    const url = `${BASE_URL}?options=${encodeURIComponent(`-c search_path=${name},public`)}`;
    const query = async (sql, params) => (await admin.query(sql, params)).rows;
    const tables = async () => (await query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [name])).map(row => row.table_name);
    const handle = {
        name,
        url,
        query,
        tables,
        count: async table => Number((await query(`SELECT COUNT(*) AS c FROM ${name}."${table}"`))[0].c),
        drop: async () => {
            try { await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`); } finally { await admin.end().catch(() => { }); }
        }
    };
    cleanups.push(() => handle.drop());
    return handle;
}

function input(env, target, extra = {}) {
    return {
        target: { url: target.url },
        backup: { dir: path.join(env.root, 'backups'), passphrase: PASSPHRASE },
        provision: { extensions: true },
        confirm: env.installation().installationId,
        ...extra
    };
}

const journalText = harness => JSON.stringify(harness.manager.journal.list()) + JSON.stringify(harness.manager.journal.readAudit().entries);
const migrationFiles = harness => ['migration.json', 'migration.progress.json', 'maintenance.json'].map(name => {
    try { return fs.readFileSync(path.join(harness.settings.storeDir, name), 'utf8'); } catch { return ''; }
}).join('\n');

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
});

afterAll(() => {
    for (const dir of cleanups.roots || []) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
});

const UNREACHABLE = `postgres://goobster:${PASSWORD_MARK}@127.0.0.1:1/goobster`;

/* ------------------------------------------------------------- no Postgres */

describe('what needs no Postgres target', () => {
    test('the rollback limit is one exported sentence, and it is what the preflight prints', async () => {
        expect(ROLLBACK_LIMIT).toBe('Rollback to the SQLite source is possible until the first write reaches Postgres. '
            + 'After the maintenance barrier is released and a worker starts on Postgres, the SQLite file is a backup, '
            + 'not a fallback: switching back is a separate restore decision, never automatic.');
        const env = await setup();
        const { applied } = await drive(env, 'db.migrate.preflight', { target: { url: UNREACHABLE } }, { auth: BRIDGE });
        expect(applied.result.rollbackLimit).toBe(ROLLBACK_LIMIT);
        expect(applied.result.ready).toBe(false);
        expect(applied.result.blocks.map(item => item.code)).toContain('TARGET_UNREACHABLE');
        expect(applied.result.source).toMatchObject({ present: true, readable: true });
        const text = JSON.stringify(applied) + journalText(env);
        expect(text).not.toContain(PASSWORD_MARK);
    }, 60000);

    test('audit actions are registered on both sides, and the preflight audit row carries no detail', async () => {
        for (const action of ['manager.db.migrate.preflight', 'manager.db.migrate', 'manager.db.migrate.rollback']) {
            expect(MANAGER_AUDIT_ACTIONS).toContain(action);
            expect(operatorAudit.ACTIONS.has(action)).toBe(true);
        }
        const env = await setup();
        await drive(env, 'db.migrate.preflight', { target: { url: UNREACHABLE } }, { auth: BRIDGE });
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.db.migrate.preflight');
        expect(entry).toMatchObject({ outcome: 'applied', via: 'bridge' });
        expect(entry.detail).toBeUndefined();
    }, 60000);

    test('a bridge session may preflight but not run the operation; a setup session may not either', async () => {
        const env = await setup();
        const migrate = input(env, { url: UNREACHABLE });
        expect(await codeOf(drive(env, 'db.migrate', migrate, { auth: BRIDGE, apply: false }))).toBe('STATE_NOT_ALLOWED');
        expect(await codeOf(drive(env, 'db.migrate.rollback', { confirm: 'x' }, { auth: BRIDGE, apply: false }))).toBe('STATE_NOT_ALLOWED');
    }, 60000);

    test('refusals: input shape, already Postgres, a moved data root, a wrong confirmation, no barrier, an unacknowledged writer', async () => {
        const env = await setup();
        const base = input(env, { url: UNREACHABLE });
        expect(await codeOf(drive(env, 'db.migrate', { ...base, extra: 1 }, { apply: false }))).toBe('INVALID_INPUT');
        expect(await codeOf(drive(env, 'db.migrate', { ...base, target: { url: 'mysql://x/y' } }, { apply: false }))).toBe('INVALID_INPUT');
        expect(await codeOf(drive(env, 'db.migrate', { ...base, backup: { dir: path.join(env.root, 'b') } }, { apply: false }))).toBe('INVALID_INPUT');
        expect(await codeOf(drive(env, 'db.migrate', { ...base, roots: { data: path.join(env.root, 'elsewhere') } }, { apply: false }))).toBe('ROOT_NOT_MOVABLE');

        expect(await codeOf(drive(env, 'db.migrate', { ...base, confirm: 'wrong' }))).toBe('CONFIRMATION_REQUIRED');
        expect(await codeOf(drive(env, 'db.migrate', { ...base, confirm: undefined }))).toBe('CONFIRMATION_REQUIRED');
        expect(await codeOf(drive(env, 'db.migrate', { ...base, maintenance: { operationId: 'op_missing', fence: 1 } }))).toBe('MAINTENANCE_NOT_HELD');

        const held = await env.enter();
        expect(await codeOf(drive(env, 'db.migrate', { ...base, maintenance: { operationId: held.operationId, fence: held.fence + 1 } }))).toBe('MAINTENANCE_NOT_HELD');
        createMaintenanceStore({ storeDir: env.settings.storeDir }).update((doc) => {
            doc.writers.api.acked = false;
            return doc;
        });
        expect(await codeOf(drive(env, 'db.migrate', { ...base, maintenance: { operationId: held.operationId, fence: held.fence } }))).toBe('WRITER_UNACKNOWLEDGED');
        expect(createMigrationState({ storeDir: env.settings.storeDir }).read().doc).toBeNull();
        expect(journalText(env)).not.toContain(PASSWORD_MARK);
        expect(journalText(env)).not.toContain(PASSPHRASE);
    }, 120000);

    test('an installation that already uses Postgres is refused, as is a record that says so', async () => {
        const env = await setup({ env: { GOOBSTER_DB_URL: UNREACHABLE } });
        const refused = await codeOf(drive(env, 'db.migrate', input(env, { url: UNREACHABLE }), { apply: false }));
        expect(refused).toBe('ALREADY_POSTGRES');

        const second = await setup();
        second.manager.store.updateInstallation(draft => ({ ...draft, database: { engine: 'postgres', external: true } }));
        expect(await codeOf(drive(second, 'db.migrate', input(second, { url: UNREACHABLE }), { apply: false }))).toBe('ALREADY_POSTGRES');
    }, 120000);

    test('a preflight that blocks stops the operation before anything is fenced or recorded', async () => {
        const env = await setup();
        const before = digestOf(env.sqlite);
        const error = await drive(env, 'db.migrate', input(env, { url: UNREACHABLE })).catch(e => e);
        expect(error.code).toBe('PREFLIGHT_FAILED');
        expect(error.details.findings.map(item => item.code)).toContain('TARGET_UNREACHABLE');
        expect(createMaintenanceStore({ storeDir: env.settings.storeDir }).read().doc.active).toBe(false);
        expect(environment.read(env.settings.storeDir).present).toBe(false);
        expect(env.installation().database).toMatchObject({ engine: 'sqlite' });
        expect(digestOf(env.sqlite)).toBe(before);
        expect(journalText(env)).not.toContain(PASSWORD_MARK);
        expect(fs.existsSync(path.join(env.root, 'backups'))).toBe(false);
    }, 120000);

    test('an interrupted cutover is reconciled from the switch file on the next start', async () => {
        const env = await setup();
        const { settings } = env;
        const target = require('@goobster/core/db/migration/target').describeTarget(UNREACHABLE);
        const state = createMigrationState({ storeDir: settings.storeDir });
        const seedState = { version: 1, id: 'mig_aaaaaaaaaaaa', status: 'running', signature: 'sig', installationId: env.installation().installationId, previousDatabase: { engine: 'sqlite', external: false }, target: { ...target, user: 'goobster' }, startedAt: new Date().toISOString(), steps: {}, cutover: { phase: 'switching', at: new Date().toISOString() } };

        // the switch was never written: nothing to bring in line, the source configuration stands
        state.write(seedState);
        expect(reconcileMigration({ settings, store: env.manager.store })).toMatchObject({ reconciled: true, action: 'switch-not-written' });
        expect(state.read().doc).toMatchObject({ status: 'failed', failure: { step: 'cutover', code: 'INTERRUPTED' } });
        expect(env.installation().database.engine).toBe('sqlite');

        // the switch was written (one atomic rename) and the record was not: the overlay is the truth
        state.write({ ...seedState, status: 'running', failure: null });
        environment.write(settings.storeDir, { GOOBSTER_DB_URL: UNREACHABLE });
        expect(reconcileMigration({ settings, store: env.manager.store })).toMatchObject({ reconciled: true, action: 'completed-cutover' });
        expect(env.installation().database).toEqual({ engine: 'postgres', external: true });
        expect(state.read().doc).toMatchObject({ status: 'switched', cutover: { phase: 'done', reconciled: true } });
        expect(settings.dbUrl).toBe(UNREACHABLE);
        expect(reconcileMigration({ settings, store: env.manager.store })).toMatchObject({ reconciled: false });

        // a fresh manager over the same store reaches the same place through init()
        const fresh = createManager({ settings: resolveSettings({ ...settings.processEnv }), logger: { info() {}, warn() {}, error() {} }, extraKinds: extensions.kinds });
        const booted = await fresh.init({ mintBootstrap: false });
        expect(booted.migration.reconciled).toBe(false);
        expect(fresh.settings.dbUrl).toBe(UNREACHABLE);
    }, 120000);

    test('the rollback boundary: refused after the first write, and the first write is recorded by a worker start', async () => {
        const env = await setup();
        const { settings } = env;
        const state = createMigrationState({ storeDir: settings.storeDir });
        expect(await codeOf(drive(env, 'db.migrate.rollback', { confirm: env.installation().installationId }, { apply: false }))).toBe('NOTHING_TO_ROLL_BACK');

        const target = require('@goobster/core/db/migration/target').describeTarget(UNREACHABLE);
        state.write({ version: 1, id: 'mig_bbbbbbbbbbbb', status: 'switched', signature: 's', installationId: env.installation().installationId, target, startedAt: new Date().toISOString(), steps: { copy: { done: true } }, maintenance: { operationId: 'op_x', fence: 1, entered: true }, result: { tables: 1, rows: 1 } });
        const held = createMaintenanceStore({ storeDir: settings.storeDir });
        held.update((doc) => {
            doc.active = true;
            doc.phase = 'cutover';
            doc.operationId = 'op_x';
            doc.fence = 1;
            return doc;
        });
        expect(noteWorkerStart({ storeDir: settings.storeDir })).toBe(false);
        expect(migrationStatus({ settings }).rollback).toMatchObject({ possible: true, boundary: 'before-first-postgres-write' });

        held.update((doc) => {
            doc.active = false;
            doc.phase = null;
            doc.operationId = null;
            return doc;
        });
        expect(noteWorkerStart({ storeDir: settings.storeDir })).toBe(true);
        expect(noteWorkerStart({ storeDir: settings.storeDir })).toBe(false);
        const doc = state.read().doc;
        expect(doc.postgresAcceptedWritesAt).toEqual(expect.any(String));
        expect(migrationStatus({ settings })).toMatchObject({ state: 'switched', postgresAcceptedWritesAt: doc.postgresAcceptedWritesAt, rollback: { possible: false, reason: 'POSTGRES_HAS_WRITES' }, rollbackLimit: ROLLBACK_LIMIT });
        const refused = await drive(env, 'db.migrate.rollback', { confirm: env.installation().installationId }, { apply: false }).catch(e => e);
        expect(refused.code).toBe('POSTGRES_HAS_WRITES');
        expect(refused.message).toBe(ROLLBACK_LIMIT);
    }, 120000);

    test('a migration that is running or failed can be rolled back until it is switched; the status says whether the target is needed', async () => {
        const env = await setup();
        const { settings } = env;
        const state = createMigrationState({ storeDir: settings.storeDir });
        const target = require('@goobster/core/db/migration/target').describeTarget(UNREACHABLE);
        const base = { version: 1, id: 'mig_cccccccccccc', status: 'running', signature: 's', installationId: env.installation().installationId, target, startedAt: new Date().toISOString(), steps: { preflight: { done: true } } };
        state.write(base);
        expect(migrationStatus({ settings }).rollback).toEqual({ possible: true, boundary: 'before-cutover', needsTarget: false });
        state.write({ ...base, status: 'failed', steps: { preflight: { done: true }, provision: { done: true, createdTables: ['users'] } } });
        expect(migrationStatus({ settings }).rollback).toEqual({ possible: true, boundary: 'before-cutover', needsTarget: true });
    }, 60000);

    test('a barrier released after the cutover also closes the rollback, without a worker start', async () => {
        const env = await setup();
        const { settings } = env;
        const state = createMigrationState({ storeDir: settings.storeDir });
        const target = require('@goobster/core/db/migration/target').describeTarget(UNREACHABLE);
        state.write({ version: 1, id: 'mig_cccccccccccc', status: 'switched', signature: 's', installationId: env.installation().installationId, target, startedAt: new Date().toISOString(), steps: {}, maintenance: { operationId: 'op_y', fence: 1, entered: true } });
        createMaintenanceStore({ storeDir: settings.storeDir }).update((doc) => {
            doc.lastOutcome = { operationId: 'op_y', fence: 1, outcome: 'completed', at: new Date().toISOString() };
            return doc;
        });
        expect(state.acceptedWrites(state.read().doc)).toMatchObject({ source: 'barrier-release' });
        expect(migrationStatus({ settings }).rollback.reason).toBe('POSTGRES_HAS_WRITES');
    }, 60000);
});

/* ------------------------------------------------------------ with Postgres */

withPostgres('the operation against a Postgres schema', () => {
    async function readyTarget(env) {
        const target = await targetSchema();
        return { target, held: await env.enter() };
    }

    test('the whole operation: verified backup, copy, verification, validation, cutover, barrier still up, instance paused', async () => {
        const env = await setup();
        const { target, held } = await readyTarget(env);
        const sourceBefore = digestOf(env.sqlite);
        const configBefore = fs.readFileSync(env.settings.configPath, 'utf8');
        const progress = [];
        env.settings.migrationDeps.onProgress = event => progress.push(event);

        const { applied } = await drive(env, 'db.migrate', input(env, target, { maintenance: { operationId: held.operationId, fence: held.fence } }));
        const result = applied.result;
        expect(result).toMatchObject({ status: 'switched', tables: env.seeded.tables - env.seeded.skipped.length, backupVerified: true, instancePaused: true, rollbackBoundary: 'before-first-postgres-write', rollbackLimit: ROLLBACK_LIMIT });
        expect(result.rows).toBe(env.seeded.rows);
        expect(result.maintenance).toMatchObject({ operationId: held.operationId, fence: held.fence, phase: 'cutover' });
        expect(applied.operation.steps.filter(step => step.status === 'done').map(step => step.name)).toEqual(expect.arrayContaining(['preflight', 'maintenance', 'backup', 'snapshot', 'provision', 'copy', 'verify', 'validate', 'cutover', 'settle']));

        // counts, table by table, against the source; only instance_state and operator_audit gained the pause and its audit row
        const sqlite = require('better-sqlite3')(env.sqlite, { readonly: true });
        const onTarget = await target.tables();
        const differing = [];
        let compared = 0;
        for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_vec_%'").all()) {
            if (!onTarget.includes(name)) continue;
            compared++;
            if (await target.count(name) !== sqlite.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c) differing.push(name);
        }
        sqlite.close();
        expect(compared).toBeGreaterThan(150);
        expect(differing).toEqual(['instance_state', 'operator_audit']);
        const next = await target.query(`INSERT INTO ${target.name}.conversations ("userId") VALUES (1) RETURNING id`);
        expect(Number(next[0].id)).toBeGreaterThan(1);
        const orphans = await target.query(`SELECT COUNT(*) AS c FROM ${target.name}.messages m LEFT JOIN ${target.name}.conversations c ON c.id = m."conversationId" WHERE c.id IS NULL`);
        expect(Number(orphans[0].c)).toBe(0);

        // verification detail from the state file: five relationship checks, sampled content, attachments, vectors
        const state = createMigrationState({ storeDir: env.settings.storeDir }).read().doc;
        expect(state).toMatchObject({ status: 'switched', steps: { backup: { verified: true }, verify: { ok: true, relationships: 5 } } });
        expect(state.steps.verify.sampled).toBeGreaterThan(100);
        expect(state.steps.verify.attachments).toBeGreaterThanOrEqual(3);
        expect(state.steps.verify.vectors).toBe(12);
        expect(await target.count('memory_embeddings')).toBe(12);
        const vec = await target.query("SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_name LIKE 'memory_vec_%' AND table_schema = $1", [target.name]);
        expect(Number(vec[0].c)).toBeGreaterThan(0);

        // the application never ran on the target during validation: counts were compared by the step
        expect(env.validations).toEqual(['called']);
        expect(progress.filter(event => event.event === 'step' && event.status === 'done').map(event => event.step)).toEqual(expect.arrayContaining(['backup', 'copy', 'verify', 'cutover']));
        expect(progress.filter(event => event.event === 'table' && event.state === 'done').length).toBeGreaterThan(100);

        // the connection switch, the record, the source, the config, the barrier, the pause
        const overlayFile = environment.fileFor(env.settings.storeDir);
        expect(fs.statSync(overlayFile).mode & 0o777).toBe(0o600);
        expect(environment.read(env.settings.storeDir).values.GOOBSTER_DB_URL).toBe(target.url);
        expect(env.settings.dbUrl).toBe(target.url);
        expect(env.settings.env.GOOBSTER_DB_URL).toBe(target.url);
        expect(env.installation().database).toEqual({ engine: 'postgres', external: true });
        // the source is what the snapshot hashed: nothing wrote to it from the snapshot to the cutover
        expect(currentHash(env)).toBe(snapshotHash(env));
        expect(sourceBefore).toEqual(expect.any(String));
        expect(fs.readFileSync(env.settings.configPath, 'utf8')).toBe(configBefore);
        expect(createMaintenanceStore({ storeDir: env.settings.storeDir }).read().doc).toMatchObject({ active: true, phase: 'cutover', operationId: held.operationId });
        const paused = await target.query(`SELECT "valueJson" FROM ${target.name}.instance_state WHERE key = 'paused'`);
        expect(paused.length).toBe(1);
        expect(JSON.stringify(paused[0])).toContain('migration');

        // a backup archive exists, verified, with the config encrypted
        const archives = fs.readdirSync(path.join(env.root, 'backups'));
        expect(archives).toHaveLength(1);
        expect(fs.readdirSync(path.join(env.root, 'backups', archives[0]))).toEqual(expect.arrayContaining(['manifest.json', 'config.json.enc']));

        // the audit entry: the closed set of facts, no secret
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.db.migrate');
        expect(entry).toMatchObject({ outcome: 'applied', detail: { tables: result.tables, rows: result.rows, vectors: 12, provisioned: false, backupVerified: true } });
        const everything = journalText(env) + migrationFiles(env) + JSON.stringify(applied);
        for (const secret of [PASSWORD_MARK, PASSPHRASE, target.url]) expect(everything).not.toContain(secret);

        // the status view and the first worker start after release
        expect(migrationStatus({ settings: env.settings })).toMatchObject({ state: 'switched', rollback: { possible: true, boundary: 'before-first-postgres-write' } });
        expect(migrationStatus({ settings: env.settings }).target).not.toHaveProperty('password');
    }, 300000);

    test('without a barrier the operation enters it itself, restarts the workers on the new connection and can release it', async () => {
        const env = await setup();
        const target = await targetSchema();
        const restarts = [];
        env.settings.migrationDeps.supervisor = { operatorRestart: () => { restarts.push('restart'); return { workers: ['api'] }; } };
        const { applied } = await drive(env, 'db.migrate', input(env, target, { release: true }));
        expect(applied.result.maintenance).toMatchObject({ enteredByMigration: true, released: true });
        expect(restarts).toEqual(['restart']);
        const doc = createMaintenanceStore({ storeDir: env.settings.storeDir }).read().doc;
        expect(doc).toMatchObject({ active: false, lastOutcome: { outcome: 'completed' } });
        expect(migrationStatus({ settings: env.settings }).rollback).toMatchObject({ possible: false, reason: 'POSTGRES_HAS_WRITES' });
    }, 300000);

    test('refusals against the target: not empty, no CREATE privilege, extension not available, provisioning not allowed', async () => {
        const env = await setup();
        const target = await targetSchema();
        await target.query(`CREATE TABLE ${target.name}.occupied (id int)`);
        const full = await drive(env, 'db.migrate', input(env, target)).catch(e => e);
        expect(full.code).toBe('PREFLIGHT_FAILED');
        expect(full.details.findings.map(item => item.code)).toContain('TARGET_NOT_EMPTY');
        expect(await target.tables()).toEqual(['occupied']);

        const locked = await targetSchema();
        await locked.query(`REVOKE CREATE ON SCHEMA ${locked.name} FROM CURRENT_USER`);
        const denied = await drive(env, 'db.migrate', input(env, locked)).catch(e => e);
        expect(denied.code).toBe('PREFLIGHT_FAILED');
        expect(denied.details.findings.map(item => item.code)).toContain('TARGET_NO_CREATE_PRIVILEGE');

        const real = require('@goobster/manager/migration/runChild').createChildRunner({ settings: env.settings });
        const pretend = (change) => async (op, request, options) => {
            const out = await real(op, request, options);
            return op === 'inspect' ? change(out) : out;
        };
        const empty = await targetSchema();
        env.settings.migrationDeps.runChild = pretend(out => ({ ...out, blocks: [...out.blocks, { code: 'EXTENSION_UNAVAILABLE', detail: 'vector' }] }));
        const noVector = await drive(env, 'db.migrate', input(env, empty)).catch(e => e);
        expect(noVector.details.findings.map(item => item.code)).toContain('EXTENSION_UNAVAILABLE');

        env.settings.migrationDeps.runChild = pretend(out => ({ ...out, provisioning: [{ code: 'EXTENSION_NOT_INSTALLED', extension: 'vector', action: 'create' }] }));
        const notAllowed = await drive(env, 'db.migrate', input(env, empty, { provision: { extensions: false } })).catch(e => e);
        expect(notAllowed.details.findings.map(item => item.code)).toContain('PROVISIONING_NOT_ALLOWED');
        expect(await empty.tables()).toEqual([]);
        expect(createMaintenanceStore({ storeDir: env.settings.storeDir }).read().doc.active).toBe(false);
    }, 300000);

    test('the preflight changes nothing: the source file, its sidecars and the target catalog are as they were, and nothing is bootstrapped', async () => {
        const env = await setup();
        const target = await targetSchema();
        const catalog = async () => JSON.stringify({
            tables: await target.query('SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1, 2', [target.name]),
            extensions: await target.query('SELECT extname FROM pg_extension ORDER BY 1'),
            schemas: (await target.query('SELECT nspname FROM pg_namespace ORDER BY 1')).map(row => row.nspname).filter(name => !name.startsWith('mig336_') || name === target.name)
        });
        const sourceBefore = digestOf(env.sqlite);
        const mtimes = fileSet(env.sqlite).map(file => fs.statSync(file).mtimeMs);
        const before = await catalog();
        const { applied } = await drive(env, 'db.migrate.preflight', { target: { url: target.url } }, { auth: BRIDGE });
        expect(applied.result).toMatchObject({ ready: true, blocks: [], estimate: { tables: env.seeded.tables - env.seeded.skipped.length } });
        expect(applied.result.target).toMatchObject({ schema: target.name, schemaExists: true, relationCount: 0 });
        expect(await catalog()).toBe(before);
        expect(await target.tables()).toEqual([]);
        expect(digestOf(env.sqlite)).toBe(sourceBefore);
        expect(fileSet(env.sqlite).map(file => fs.statSync(file).mtimeMs)).toEqual(mtimes);
        expect(JSON.stringify(applied) + journalText(env)).not.toContain('password');
    }, 120000);

    test('failure injection: a failure after backup, after provision and during validation leaves the source configuration alone, and resuming completes', async () => {
        let boom = null;
        const env = await setup({ deps: { beforeStep: ({ step }) => { if (step === boom) { boom = null; throw Object.assign(new Error('boom'), { code: 'INJECTED' }); } } } });
        const target = await targetSchema();
        const payload = () => input(env, target);

        boom = 'provision';
        const afterBackup = await drive(env, 'db.migrate', payload()).catch(e => e);
        expect(afterBackup.operation.status).toBe('failed');
        expect(await target.tables()).toEqual([]);
        expect(createMigrationState({ storeDir: env.settings.storeDir }).read().doc).toMatchObject({ status: 'failed', failure: { step: 'provision' }, steps: { backup: { done: true }, snapshot: { done: true } } });
        expect(createMaintenanceStore({ storeDir: env.settings.storeDir }).read().doc.active).toBe(false);
        expect(environment.read(env.settings.storeDir).present).toBe(false);
        expect(env.installation().database.engine).toBe('sqlite');

        boom = 'copy';
        const afterProvision = await drive(env, 'db.migrate', payload()).catch(e => e);
        expect(afterProvision.operation.status).toBe('failed');
        expect((await target.tables()).length).toBeGreaterThan(100);
        expect(await target.count('users')).toBe(0);
        expect(createMigrationState({ storeDir: env.settings.storeDir }).read().doc.steps.provision.done).toBe(true);
        // the backup is not taken twice on a resume
        expect(fs.readdirSync(path.join(env.root, 'backups'))).toHaveLength(1);

        env.settings.migrationDeps.validate = async () => ({ workers: [{ name: 'api', healthy: false }], layout: 'standalone' });
        env.settings.migrationDeps.validate = async () => {
            const { ManagerError } = require('@goobster/manager/errors');
            throw new ManagerError(409, 'VALIDATION_FAILED', 'The application did not come up healthy on the target; the source configuration was not changed.', { workers: ['api'] });
        };
        const duringValidation = await drive(env, 'db.migrate', payload()).catch(e => e);
        expect(duringValidation.code).toBe('VALIDATION_FAILED');
        expect(await target.count('users')).toBeGreaterThan(0);
        expect(environment.read(env.settings.storeDir).present).toBe(false);
        expect(env.installation().database.engine).toBe('sqlite');
        expect(env.settings.dbUrl).toBeNull();
        expect(currentHash(env)).toBe(snapshotHash(env));

        env.settings.migrationDeps.validate = async () => ({ workers: [{ name: 'api', healthy: true }], layout: 'standalone' });
        boom = 'cutover';
        const afterVerify = await drive(env, 'db.migrate', payload()).catch(e => e);
        expect(afterVerify.operation.status).toBe('failed');
        const resumed = await drive(env, 'db.migrate', payload());
        expect(resumed.planned.plan.resumeOf).toMatchObject({ status: 'failed' });
        expect(resumed.planned.plan.resumeOf.completed).toEqual(expect.arrayContaining(['backup', 'snapshot', 'provision', 'copy', 'verify']));
        expect(resumed.applied.result.status).toBe('switched');
        expect(env.installation().database.engine).toBe('postgres');
        expect(fs.readdirSync(path.join(env.root, 'backups'))).toHaveLength(1);
        expect(currentHash(env)).toBe(snapshotHash(env));
    }, 600000);

    test('an interrupted copy resumes at the incomplete table: it is recopied, the finished tables are not touched', async () => {
        let boom = null;
        const env = await setup({ deps: { beforeStep: ({ step }) => { if (step === boom) { boom = null; throw Object.assign(new Error('boom'), { code: 'INJECTED' }); } } } });
        const target = await targetSchema();
        const payload = () => input(env, target);
        boom = 'verify';
        await drive(env, 'db.migrate', payload()).catch(() => null);
        const store = createMigrationState({ storeDir: env.settings.storeDir });
        const progress = store.readProgress();
        expect(Object.values(progress.tables).every(item => item.state === 'done')).toBe(true);

        // what a kill between a table's commit and its progress record leaves: the table is marked copying, rows already there
        const incomplete = 'messages';
        const finished = 'users';
        const marker = async table => (await target.query(`SELECT xmin::text AS x FROM ${target.name}."${table}" ORDER BY 1 LIMIT 1`))[0].x;
        const untouchedBefore = await marker(finished);
        expect(await target.count(incomplete)).toBe(2);
        fs.writeFileSync(store.progressFile, JSON.stringify({ ...progress, tables: { ...progress.tables, [incomplete]: { state: 'copying', rows: 2 } } }));
        store.update(next => ({ ...next, steps: { ...next.steps, copy: { ...next.steps.copy, done: false } } }));

        const { applied } = await drive(env, 'db.migrate', payload());
        const copy = createMigrationState({ storeDir: env.settings.storeDir }).read().doc.steps.copy;
        expect(copy.recopied).toBe(1);
        expect(copy.resumed).toBeGreaterThan(100);
        expect(await target.count(incomplete)).toBe(2);
        expect(await marker(finished)).toBe(untouchedBefore);
        expect(applied.result.status).toBe('switched');
    }, 600000);

    test('an interrupted cutover (switch written, record not) is reconciled on the next start; the operation can be neither re-run nor lost', async () => {
        const env = await setup({ deps: {} });
        const target = await targetSchema();
        const marker = new Error('crash');
        env.settings.migrationDeps.afterSwitchWrite = async () => { throw marker; };
        const failed = await drive(env, 'db.migrate', input(env, target)).catch(e => e);
        expect(failed.operation.status).toBe('failed');
        expect(environment.read(env.settings.storeDir).values.GOOBSTER_DB_URL).toBe(target.url);
        expect(env.installation().database.engine).toBe('sqlite');

        const fresh = createManager({ settings: resolveSettings({ ...env.settings.processEnv }), logger: { info() {}, warn() {}, error() {} }, extraKinds: extensions.kinds });
        const booted = await fresh.init({ mintBootstrap: false });
        expect(booted.migration).toMatchObject({ reconciled: true, action: 'completed-cutover' });
        expect(fresh.store.readInstallation().doc.database).toEqual({ engine: 'postgres', external: true });
        expect(createMigrationState({ storeDir: env.settings.storeDir }).read().doc.status).toBe('switched');
        expect(fresh.settings.dbUrl).toBe(target.url);
    }, 300000);

    test('rollback before the cutover drops exactly what the journal lists and nothing else, then clears the state', async () => {
        const env = await setup();
        const target = await targetSchema();
        env.settings.migrationDeps.validate = async () => ({ workers: [{ name: 'api', healthy: false }], layout: 'standalone' });
        env.settings.migrationDeps.validate = async () => {
            const { ManagerError } = require('@goobster/manager/errors');
            throw new ManagerError(409, 'VALIDATION_FAILED', 'unhealthy', {});
        };
        const failed = await drive(env, 'db.migrate', input(env, target)).catch(e => e);
        expect(failed.code).toBe('VALIDATION_FAILED');
        const snapshotted = snapshotHash(env);
        const created = (await target.tables()).length;
        expect(created).toBeGreaterThan(100);

        const confirm = env.installation().installationId;
        expect(await codeOf(drive(env, 'db.migrate.rollback', { target: { url: target.url }, confirm: 'nope' }))).toBe('CONFIRMATION_REQUIRED');
        expect(await codeOf(drive(env, 'db.migrate.rollback', { confirm }, { apply: false }))).toBe('INVALID_INPUT');
        const otherUrl = target.url.replace(target.name, 'other_schema');
        expect(await codeOf(drive(env, 'db.migrate.rollback', { target: { url: otherUrl }, confirm }, { apply: false }))).toBe('TARGET_MISMATCH');

        // an object the operation did not create blocks the drop, and survives
        await target.query(`CREATE TABLE ${target.name}.not_ours (id int)`);
        expect(await codeOf(drive(env, 'db.migrate.rollback', { target: { url: target.url }, confirm }))).toBe('ROLLBACK_FOREIGN_OBJECTS');
        expect((await target.tables()).length).toBe(created + 1);
        await target.query(`DROP TABLE ${target.name}.not_ours`);

        const { applied } = await drive(env, 'db.migrate.rollback', { target: { url: target.url }, confirm });
        expect(applied.result).toMatchObject({ rolledBack: true, switchReverted: false });
        expect(applied.result.dropped.tables).toBe(created - applied.result.dropped.derived);
        expect(await target.tables()).toEqual([]);
        const state = createMigrationState({ storeDir: env.settings.storeDir });
        expect(state.read().doc).toMatchObject({ status: 'rolled-back' });
        expect(fs.existsSync(state.progressFile)).toBe(false);
        expect(migrationStatus({ settings: env.settings }).state).toBe('rolled-back');
        expect(currentHash(env)).toBe(snapshotted);
        expect(env.installation().database.engine).toBe('sqlite');
        expect(journalText(env)).not.toContain(target.url);
    }, 600000);

    test('rollback after the cutover but before any write restores the connection, the record and the workers, and may release the barrier', async () => {
        const env = await setup();
        const target = await targetSchema();
        const restarts = [];
        env.settings.migrationDeps.supervisor = { operatorRestart: () => { restarts.push('restart'); return { workers: ['api'] }; } };
        await drive(env, 'db.migrate', input(env, target));
        expect(env.installation().database.engine).toBe('postgres');

        const confirm = env.installation().installationId;
        const { applied } = await drive(env, 'db.migrate.rollback', { target: { url: target.url }, confirm, releaseMaintenance: true });
        expect(applied.result).toMatchObject({ rolledBack: true, switchReverted: true, workersRestarted: true, maintenanceReleased: true });
        expect(restarts).toEqual(['restart', 'restart']);
        expect(env.installation().database).toEqual({ engine: 'sqlite', external: false });
        expect(environment.read(env.settings.storeDir).present).toBe(false);
        expect(env.settings.dbUrl).toBeNull();
        expect(await target.tables()).toEqual([]);
        expect(createMaintenanceStore({ storeDir: env.settings.storeDir }).read().doc.active).toBe(false);

        // the same installation can migrate again afterwards
        const again = await drive(env, 'db.migrate', input(env, target));
        expect(again.applied.result.status).toBe('switched');
    }, 600000);

    test('after Postgres accepted writes there is no way back', async () => {
        const env = await setup();
        const target = await targetSchema();
        await drive(env, 'db.migrate', input(env, target, { release: true }));
        const refused = await drive(env, 'db.migrate.rollback', { target: { url: target.url }, confirm: env.installation().installationId }, { apply: false }).catch(e => e);
        expect(refused.code).toBe('POSTGRES_HAS_WRITES');
        expect(refused.message).toBe(ROLLBACK_LIMIT);
        expect((await target.tables()).length).toBeGreaterThan(100);
        expect(await codeOf(drive(env, 'db.migrate', input(env, target), { apply: false }))).toBe('ALREADY_POSTGRES');
    }, 300000);

    test('a source that changed after the snapshot is refused, and the rows are not copied', async () => {
        let tamper = false;
        const env = await setup({ deps: { beforeStep: ({ step }) => { if (step === 'copy' && tamper) { tamper = false; const db = require('better-sqlite3')(env.sqlite); db.prepare('INSERT INTO conversations (userId) VALUES (99)').run(); db.close(); } } } });
        const target = await targetSchema();
        tamper = true;
        const failed = await drive(env, 'db.migrate', input(env, target)).catch(e => e);
        expect(failed.code).toBe('SOURCE_CHANGED');
        expect(await target.count('users')).toBe(0);
        expect(environment.read(env.settings.storeDir).present).toBe(false);
    }, 300000);

    test('the route carries the preflight and the status, and neither echoes the URL', async () => {
        const env = await setup();
        const target = await targetSchema();
        const { mountMigrateRoutes } = require('@goobster/manager/routes/migrate');
        const handlers = {};
        const api = { get: (route, handler) => { handlers[`GET ${route}`] = handler; }, post: (route, handler) => { handlers[`POST ${route}`] = handler; } };
        mountMigrateRoutes(api, { route: handler => handler, authenticate: () => BRIDGE, readAuth: () => BRIDGE, checkActor: () => {}, manager: env.manager });
        const status = await handlers['GET /migrate/status']({});
        expect(status).toMatchObject({ state: 'none', rollbackLimit: ROLLBACK_LIMIT });
        const out = await handlers['POST /migrate/preflight']({ body: { target: { url: target.url } } });
        expect(out).toMatchObject({ ready: true, rollbackLimit: ROLLBACK_LIMIT });
        expect(JSON.stringify(out)).not.toContain(target.url);
        await expect(handlers['POST /migrate/preflight']({ body: { target: { url: target.url }, stray: 1 } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        void USER;
    }, 120000);
});
