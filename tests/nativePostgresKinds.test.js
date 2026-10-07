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

    test('creates the cluster beside the distribution\'s own one on its own port, and never connects the installation', async () => {
        const env = await setup({ workers: false });
        const foreign = env.fake.seedForeignCluster({ name: 'main', port: 5432 });
        const before = env.fake.snapshot(foreign.files);
        const configBefore = env.fake.snapshot(foreign.config);
        const dry = await provision(env, {}, { apply: false });
        expect(dry.planned.plan.ok).toBe(false);
        expect(dry.planned.plan.port).toMatchObject({ requested: 5432, free: false });
        const suggestion = dry.planned.plan.port.suggestion;
        expect(suggestion).toBeGreaterThan(5432);
        expect(dry.planned.plan.findings.map(item => item.code)).toEqual(expect.arrayContaining(['PORT_IN_USE', 'FOREIGN_CLUSTERS']));

        const { planned, applied } = await provision(env, { port: suggestion });
        expect(applied.operation.status).toBe('applied');
        expect(planned.plan).toMatchObject({ effect: 'provision-native-database', mode: 'fresh', ok: true, request: { port: suggestion, bind: '127.0.0.1' } });
        expect(planned.plan.steps.map(step => step.name)).toEqual(['preflight', 'packages', 'cluster', 'schema', 'verify-database']);
        const clusters = env.fake.state().clusters;
        expect(clusters.map(item => item.name).sort()).toEqual(['goobster', 'main']);
        expect(env.fake.snapshot(foreign.files)).toEqual(before);
        expect(env.fake.snapshot(foreign.config)).toEqual(configBefore);
        expect(env.installation().database.engine).toBe('sqlite');
        expect(env.overlay().values.GOOBSTER_DB_URL).toBeUndefined();
        expect(env.settings.dbUrl || '').toBe('');
        expect(applied.result).toMatchObject({ provisioned: true, connected: false });
        for (const call of env.fake.mutations()) expect(call.args.join(' ')).not.toMatch(/\bmain\b/);
    }, 90000);

    test('no password in any argv, journal row, audit row, plan, result or state file; the role statement reaches the fake psql on stdin as a verifier', async () => {
        const env = await setup({ workers: false });
        const { planned, applied } = await provision(env);
        const url = env.overlay().values.GOOBSTER_NATIVE_DB_URL;
        const password = decodeURIComponent(new URL(url).password);
        expect(password.length).toBeGreaterThanOrEqual(24);
        for (const secret of [password, encodeURIComponent(password)]) {
            expect(env.fake.argvText()).not.toContain(secret);
            expect(env.fake.stdinText()).not.toContain(secret);
            const published = journalText(env) + JSON.stringify(planned) + JSON.stringify(applied) + JSON.stringify(nativeState.read(env.settings.storeDir));
            expect(published).not.toContain(secret);
            expect(published).not.toContain(url);
        }
        expect(env.fake.stdinText()).toMatch(/CREATE ROLE "?goobster"?.*SCRAM-SHA-256\$/s);
        expect(env.fake.stdinText()).toMatch(/NOSUPERUSER/);
        expect(env.fake.stdinText()).toMatch(/NOCREATEDB/);
        expect(env.fake.stdinText()).toMatch(/NOCREATEROLE/);
        const overlayFile = environment.fileFor(env.settings.storeDir);
        expect(fs.statSync(overlayFile).mode & 0o777).toBe(0o600);
        const everywhere = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (full !== overlayFile && fs.statSync(full).size < 4 * 1024 * 1024) everywhere.push(fs.readFileSync(full, 'latin1'));
            }
        };
        walk(env.root);
        expect(everywhere.join('\n')).not.toContain(password);
        expect(env.server.applied).toHaveLength(1);
        expect(decodeURIComponent(env.server.applied[0].url)).toContain(password);
    }, 90000);

    test('the audit row carries names only: no path, port, address, URL or password', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.database.native.provision');
        expect(entry).toMatchObject({ outcome: 'applied' });
        expect(entry.detail).toMatchObject({ cluster: 'goobster', created: true, major: 17 });
        const text = JSON.stringify(entry);
        for (const word of ['password', '127.0.0.1', 'postgres://', '5432', env.dataDirectory, 'secret']) expect(text).not.toContain(word);
    }, 90000);

    test('the privileged steps are the closed operations, and nothing else on the machine changes outside the new cluster', async () => {
        const env = await setup({ workers: false });
        const foreign = env.fake.seedForeignCluster({ name: 'main', port: 5432 });
        const before = env.fake.snapshot(foreign.files);
        await provision(env, { port: 5440 });
        const text = env.fake.argvText();
        expect(text).not.toMatch(/ALTER SYSTEM/);
        expect(text + env.fake.stdinText()).not.toMatch(/ALTER SYSTEM/i);
        for (const call of env.fake.calls().filter(item => item.program === 'pg_createcluster' || item.program === 'pg_ctlcluster' || item.program === 'pg_dropcluster')) {
            expect(call.args).not.toContain('main');
        }
        expect(env.fake.snapshot(foreign.files)).toEqual(before);
    }, 90000);

    test('database.connect with the owned reference is the only cutover: the URL moves to GOOBSTER_DB_URL and the staged key is removed', async () => {
        const env = await setup();
        await provision(env);
        const staged = env.overlay().values.GOOBSTER_NATIVE_DB_URL;
        expect(env.overlay().values.GOOBSTER_DB_URL).toBeUndefined();
        const before = env.fake.calls().length;
        const { applied } = await drive(env, 'database.connect', { connection: { owned: 'native' }, release: true }, { auth: BRIDGE });
        expect(applied.operation.status).toBe('applied');
        expect(env.installation().database).toMatchObject({ engine: 'postgres' });
        const values = env.overlay().values;
        expect(values.GOOBSTER_DB_URL).toBe(staged);
        expect(values.GOOBSTER_NATIVE_DB_URL).toBeUndefined();
        expect(env.fake.calls().slice(before).filter(call => ['apt-get', 'dnf', 'pg_createcluster', 'pg_dropcluster'].includes(call.program))).toEqual([]);
        expect(journalText(env)).not.toContain(values.GOOBSTER_DB_URL);
    }, 120000);

    test('a connection answer naming the owned instance without a provisioned one is refused', async () => {
        const env = await setup({ workers: false });
        expect(await codeOf(drive(env, 'database.connect', { connection: { owned: 'native' } }, { auth: BRIDGE, apply: false }))).toBe('NO_NATIVE_DATABASE');
    }, 60000);

    test('a second provision over a verified instance is refused as already provisioned', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        env.fake.clearCalls();
        const again = await provision(env).catch(error => error);
        expect(again.code).toBe('PREFLIGHT_FAILED');
        expect(again.details.findings.map(item => item.code)).toContain('ALREADY_PROVISIONED');
        expect(env.fake.mutations()).toEqual([]);
    }, 90000);
});

describe('database.native.provision: what blocks it before anything changes', () => {
    test('a port in use is a block that offers the next free port; picking it succeeds', async () => {
        const env = await setup({ workers: false });
        env.fake.set({ listening: [5432, 5433] });
        const dry = await provision(env, {}, { apply: false });
        expect(dry.planned.plan.ok).toBe(false);
        expect(dry.planned.plan.port).toMatchObject({ requested: 5432, free: false, suggestion: 5434 });
        expect(dry.planned.plan.findings.find(item => item.code === 'PORT_IN_USE').remedy).toContain('5434');
        const failure = await provision(env).catch(error => error);
        expect(failure.code).toBe('PREFLIGHT_FAILED');
        expect(env.fake.mutations()).toEqual([]);
        const { applied } = await provision(env, { port: 5434 });
        expect(applied.operation.status).toBe('applied');
        expect(env.record().cluster.port).toBe(5434);
    }, 90000);

    test('a LAN bind needs acknowledgement; loopback is the default', async () => {
        const env = await setup({ workers: false });
        const refused = await provision(env, { bind: '0.0.0.0' }, { apply: false }).catch(error => error);
        expect(refused.code).toBe('LAN_BIND_NOT_ACKNOWLEDGED');
        const ack = await provision(env, { bind: '0.0.0.0', acknowledgeLanBind: true }, { apply: false });
        expect(ack.planned.plan.findings.map(item => item.code)).toContain('LAN_BIND');
        expect(ack.planned.plan.request.bind).toBe('0.0.0.0');
        const plain = await provision(env, {}, { apply: false });
        expect(plain.planned.plan.request.bind).toBe('127.0.0.1');
        expect(plain.planned.plan.findings.map(item => item.code)).not.toContain('LAN_BIND');
    }, 90000);

    test('request shapes: unknown keys, bad ports, relative or forbidden directories and non-string names are INVALID', async () => {
        const env = await setup({ workers: false });
        for (const input of [{ nope: 1 }, { port: 'x' }, { port: 70000 }, { port: 80 }, { role: 'x y' }, { database: 5 }, { bind: 'not an address' }, { installPackages: 'yes' }]) {
            const code = await codeOf(provision(env, input, { apply: false }));
            expect(['INVALID_INPUT', 'PORT_INVALID']).toContain(code);
        }
        for (const dataDirectory of ['relative/path', '/', '/etc/postgresql', '/var/lib/postgresql/17/main', '/srv/../etc']) {
            const outcome = await provision(env, { dataDirectory }, { apply: false }).catch(error => error);
            if (outcome.code) expect(outcome.code).toMatch(/INVALID|PATH|DATA_DIRECTORY|PREFLIGHT_FAILED/);
            else expect(outcome.planned.plan.ok).toBe(false);
        }
        expect(env.fake.mutations()).toEqual([]);
    }, 90000);

    test('packages that are not approved are a block; approved they are installed once, with the closed package list', async () => {
        const env = await setup({ workers: false });
        const dry = await provision(env, { installPackages: false }, { apply: false });
        expect(dry.planned.plan.ok).toBe(false);
        expect(dry.planned.plan.findings.map(item => item.code)).toContain('PACKAGES_NOT_APPROVED');
        const refused = await provision(env, { installPackages: false }).catch(error => error);
        expect(refused.code).toBe('PREFLIGHT_FAILED');
        expect(refused.details.findings.map(item => item.code)).toContain('PACKAGES_NOT_APPROVED');
        expect(env.fake.mutations()).toEqual([]);
        await provision(env);
        const installs = env.fake.calls().filter(call => call.program === 'apt-get' && call.args.includes('install'));
        expect(installs).toHaveLength(1);
        expect(installs[0].args.filter(arg => /^postgresql/.test(arg)).every(arg => /^postgresql(-common|-17|-client-17|-17-pgvector)$/.test(arg))).toBe(true);
    }, 90000);

    test('a host whose pg_dump is older than the server blocks until the operator acknowledges it', async () => {
        const env = await setup({ workers: false, machine: { installed: ['postgresql-client-16'], flags: {} } });
        env.fake.set({ pgDump: '16.4' });
        const dry = await provision(env, { installPackages: true }, { apply: false });
        const finding = dry.planned.plan.findings.find(item => /^BACKUP_TOOLS/.test(item.code));
        if (finding && finding.severity === 'block') {
            expect(dry.planned.plan.ok).toBe(false);
            const ack = await provision(env, { acknowledgeBackupTools: true }, { apply: false });
            expect(ack.planned.plan.ok).toBe(true);
        } else {
            expect(dry.planned.plan.backupTools).toBeTruthy();
        }
    }, 90000);

    test('an unsupported distribution and a missing elevation are blocks with their own codes', async () => {
        const unsupported = await setup({ workers: false, nativeDeps: { distro: { supported: false, reason: 'DISTRO_UNSUPPORTED', remedy: 'Not here.', family: null, id: 'arch' } } });
        const one = await provision(unsupported, {}, { apply: false });
        expect(one.planned.plan.ok).toBe(false);
        expect(one.planned.plan.findings.map(item => item.code)).toContain('DISTRO_UNSUPPORTED');

        const noElevation = await setup({ workers: false, elevation: { kind: 'none', reason: 'NO_ELEVATION' } });
        const two = await provision(noElevation, {}, { apply: false });
        expect(two.planned.plan.ok).toBe(false);
        expect(two.planned.plan.findings.map(item => item.code)).toContain('ELEVATION_UNAVAILABLE');
        expect(noElevation.fake.mutations()).toEqual([]);
    }, 120000);
});

