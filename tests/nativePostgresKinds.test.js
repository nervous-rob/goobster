/**
 * The operations on the native PostgreSQL cluster the manager owns (#340,
 * documentation/native_postgres.md): `database.native.provision|start|stop|
 * repair|relocate`, the `{ owned: 'native' }` connection, the readiness gate
 * and the uninstall scopes.
 *
 * Nothing real is touched. The privileged helper runs for real, as an ordinary
 * user, inside a throwaway "machine" (tests/helpers/fakeNative.js): fake apt-get,
 * dnf, pg_createcluster, pg_ctlcluster, pg_lsclusters, psql and systemctl sit on
 * a private PATH and in the helper's command directory, and record every argv
 * and every stdin. The #338 library's schema child process and the probe are
 * scripted through `settings.databaseDeps`, exactly as in
 * tests/dockerPostgresKinds.test.js.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-native-kinds-'));
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'jest-own.sqlite');

const { newHarness, drive, codeOf, tempDir } = require('./helpers/installFixture');
const fakeNative = require('./helpers/fakeNative');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');
const { discover } = require('@goobster/manager/install/discover');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const { tune } = require('@goobster/manager/maintenance/barrier');
const { createMaintenanceStore } = require('@goobster/manager/maintenance/store');
const environment = require('@goobster/manager/environment');
const nativeState = require('@goobster/manager/native/state');
const { createReadiness } = require('@goobster/manager/native/readiness');
const { createNativeService } = require('@goobster/manager/native/service');
const privileged = require('@goobster/manager/privileged');
const { MANAGER_AUDIT_ACTIONS } = require('@goobster/manager/audit');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const { expectedSchema } = require('@goobster/core/db/migration/schemaModel');

const BRIDGE = { principal: 'owner-1', via: 'bridge' };
const TUNING = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 };
const KINDS = ['database.native.provision', 'database.native.start', 'database.native.stop', 'database.native.repair', 'database.native.relocate'];
const cleanups = [];
const scratch = label => tempDir(cleanups.roots || (cleanups.roots = []), label);

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
}, 60000);

afterAll(() => {
    for (const dir of cleanups.roots || []) fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- scripted */

const goobsterTables = () => Object.entries(expectedSchema().tables).map(([name, model]) => ({ name, columns: model.columns.map(col => col.name) }));

function inspected(over = {}) {
    return {
        reachable: true,
        user: 'goobster',
        isSuperuser: false,
        serverVersion: 170004,
        serverVersionText: '17.4',
        schema: 'public',
        schemaExists: true,
        canConnect: true,
        canCreateInDatabase: false,
        canCreateInSchema: true,
        canCreateDatabase: false,
        canCreateRole: false,
        tables: goobsterTables(),
        otherRelations: [],
        relationCount: 0,
        extensions: { citext: { available: true, installed: true, trusted: true }, vector: { available: true, installed: true, trusted: false } },
        tls: { encrypted: false, protocol: null },
        freeBytes: null,
        ...over
    };
}

/** The schema child process and the probe, scripted: they record what they were asked and with which URL. */
function scriptedServer() {
    const server = { applied: [], urls: [], backups: [] };
    server.deps = {
        probeDeps: {
            createClient: () => ({}),
            inspect: async (url) => {
                server.urls.push(url);
                return inspected();
            }
        },
        runProvisioning: async () => { throw new Error('the native option never provisions through the #338 library'); },
        initDatabase: async ({ url, database }) => {
            server.applied.push({ url, database });
            return { engine: 'postgres', tables: 3 };
        },
        runChild: async () => ({ counts: {} }),
        validate: async () => ({ workers: [{ name: 'api', healthy: true }], layout: 'standalone' })
    };
    return server;
}

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
 * fence, a fake machine whose real privileged helper runs as an ordinary user
 * inside it, and a scripted Postgres side.
 */
async function setup({ machine = {}, nativeDeps = {}, server = scriptedServer(), env = {}, workers = true, elevation = null } = {}) {
    const fake = fakeNative.create({ distro: 'debian', ...machine });
    fake.install();
    cleanups.push(() => fake.restore());
    const root = scratch('npk');
    const harness = await newHarness({
        root,
        env: { GOOBSTER_RUNTIME_MODE: 'standalone', ...env },
        installDeps: { discover: opts => discover({ ...opts, exec: () => null }), privileged, privilegedOptions: fake.privilegedOptions(elevation ? { elevation } : {}) }
    });
    const { settings, code } = harness;
    fs.mkdirSync(path.join(code, 'scripts'), { recursive: true });
    fs.mkdirSync(settings.dataDir, { recursive: true });
    fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ name: 'goobster' }));
    fs.writeFileSync(settings.configPath, JSON.stringify({ webapp: { enabled: true } }));
    fs.writeFileSync(path.join(code, 'scripts', 'auto-update.sh'), '#!/bin/bash\n# goobster-manager-guard\nexit 0\n');
    const Database = require('better-sqlite3');
    const db = new Database(settings.sqlitePath);
    db.exec('CREATE TABLE self_docs (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO self_docs (body) VALUES (\'docs\'); CREATE TABLE users (id INTEGER PRIMARY KEY);');
    db.close();
    const found = discover({ fs, home: root, env: settings.env, exec: () => null });
    await drive(harness, 'adopt', { label: 'Rob', candidateId: found.candidates[0].id });

    tune(settings.storeDir, TUNING);
    const fakes = createFakeWorkers();
    let supervisor = null;
    if (workers) {
        supervisor = createSupervisor({ manager: harness.manager, adapter: fakes.adapter, checkHealth: fakes.checkHealth, sandboxActive: () => false, logger: { info() {}, warn() {}, error() {} }, policy: { ...FAST_POLICY } });
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
    }

    settings.databaseDeps = { ...server.deps };
    settings.nativeDeps = fake.nativeDeps(nativeDeps);
    const installation = () => harness.manager.store.readInstallation().doc;
    const overlay = () => environment.read(settings.storeDir);
    const dataDirectory = path.join(fake.dir, 'srv', 'pgdata');
    return { ...harness, fake, server, fakes, supervisor, installation, overlay, dataDirectory, record: () => nativeState.read(settings.storeDir).doc, barrier: () => createMaintenanceStore({ storeDir: settings.storeDir }).read().doc };
}

const APPROVED = { installPackages: true };
const provision = (env, input = {}, options = {}) => drive(env, 'database.native.provision', { ...APPROVED, dataDirectory: env.dataDirectory, ...input }, { auth: BRIDGE, ...options });
const stepNames = operation => [...new Set(operation.steps.map(step => step.name))].filter(name => name !== 'validate');
const journalText = harness => JSON.stringify(harness.manager.journal.list()) + JSON.stringify(harness.manager.journal.readAudit().entries);

describe('database.native.provision', () => {
    test('installs the packages, creates the cluster and the role, applies the schema and stages the URL', async () => {
        const env = await setup();
        const { planned, applied } = await provision(env);
        expect(planned.plan.ok).toBe(true);
        expect(planned.plan.names.cluster).toBe('goobster');
        expect(applied.operation.status).toBe('applied');
        expect(stepNames(applied.operation)).toEqual(['preflight', 'packages', 'cluster', 'schema', 'verify-database']);
        const machine = env.fake.state();
        expect(machine.installed).toEqual(expect.arrayContaining(['postgresql-17', 'postgresql-17-pgvector']));
        expect(machine.clusters.map(item => item.name)).toContain('goobster');
        expect(env.record().step).toBe('verified');
        expect(env.overlay().values.GOOBSTER_NATIVE_DB_URL).toMatch(/^postgres:\/\/goobster:/);
        expect(env.overlay().values.GOOBSTER_DB_URL).toBeUndefined();
    }, 60000);
});
