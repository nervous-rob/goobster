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

const { newHarness, drive, codeOf, tempDir, makeRelease } = require('./helpers/installFixture');
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

/* =============================================================== registration */

describe('registration', () => {
    test('the audit actions exist on both sides and the kinds are registered and public', async () => {
        for (const kind of KINDS) {
            expect(MANAGER_AUDIT_ACTIONS).toContain(`manager.${kind}`);
            expect(operatorAudit.ACTIONS.has(`manager.${kind}`)).toBe(true);
        }
        for (const operation of ['create', 'control', 'remove', 'relocate']) {
            expect(MANAGER_AUDIT_ACTIONS).toContain(`manager.privileged.postgres.cluster.${operation}`);
            expect(operatorAudit.ACTIONS.has(`manager.privileged.postgres.cluster.${operation}`)).toBe(true);
        }
        const env = await setup({ workers: false });
        const kinds = require('@goobster/manager/engine/kinds/nativePostgres').createKinds({ settings: env.settings });
        expect(kinds.map(item => [item.kind, item.public])).toEqual(KINDS.map(kind => [kind, true]));
        for (const kind of KINDS) expect(env.manager.engine.kinds).toContain(kind);
    }, 60000);

    test('an installation nobody has claimed has nothing to attach a database to', async () => {
        const fake = fakeNative.create();
        fake.install();
        cleanups.push(() => fake.restore());
        const bare = await newHarness({ root: scratch('unclaimed') });
        expect(await codeOf(bare.manager.engine.plan('database.native.provision', {}, BRIDGE, { internal: true }))).toBe('STATE_NOT_ALLOWED');
    }, 60000);
});

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
        const env = await setup({ workers: false, machine: { installed: ['postgresql-17', 'postgresql-common', 'postgresql-client-17', 'postgresql-17-pgvector', 'postgresql-contrib'] } });
        env.fake.set({ pgDumpVersion: '16.4' });
        const dry = await provision(env, { installPackages: false }, { apply: false });
        const finding = dry.planned.plan.findings.find(item => item.code === 'BACKUP_TOOLS_MISMATCH');
        expect(finding).toMatchObject({ severity: 'block' });
        expect(dry.planned.plan.ok).toBe(false);
        const ack = await provision(env, { installPackages: false, acknowledgeBackupTools: true }, { apply: false });
        expect(ack.planned.plan.findings.find(item => item.code === 'BACKUP_TOOLS_MISMATCH')).toMatchObject({ severity: 'warn' });
        expect(ack.planned.plan.ok).toBe(true);

        env.fake.flag('noPgDump');
        const missing = await provision(env, { installPackages: false }, { apply: false });
        expect(missing.planned.plan.findings.map(item => item.code)).toContain('BACKUP_TOOLS_MISSING');
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


/* ============================================================ resume and failure */

describe('an interrupted or failing provision', () => {
    test('a cluster that failed to be created leaves the record at an earlier step; the retry resumes with the same cluster and no duplicate packages', async () => {
        const env = await setup({ workers: false });
        env.fake.flag('createFails');
        const failure = await provision(env).catch(error => error);
        expect(failure.code).toBeTruthy();
        expect(env.overlay().values.GOOBSTER_NATIVE_DB_URL).toBeUndefined();
        expect(env.record().step).not.toBe('verified');
        env.fake.flag('createFails', false);
        fs.chmodSync(env.dataDirectory, 0o755); // the real helper hands the directory to the postgres account; the sandbox cannot chown
        env.fake.clearCalls();
        const { planned, applied } = await provision(env);
        expect(applied.operation.status).toBe('applied');
        expect(planned.plan.findings.map(item => item.code)).toContain('RESUME');
        expect(env.fake.calls().filter(call => call.program === 'apt-get' && call.args.includes('install'))).toEqual([]);
        expect(env.fake.state().clusters.filter(item => item.name === 'goobster')).toHaveLength(1);
        expect(env.record().step).toBe('verified');
    }, 120000);

    test('a distribution that creates its own default cluster while installing the packages takes the port first: the create is refused untouched and the retry uses the next port', async () => {
        const env = await setup({ workers: false });
        env.fake.flag('autoMainCluster');
        const failure = await provision(env).catch(error => error);
        expect(failure.code).toBeTruthy();
        expect(JSON.stringify(failure)).toContain('PORT_IN_USE');
        const main = () => env.fake.state().clusters.find(item => item.name === 'main');
        expect(main()).toMatchObject({ port: 5432, online: true });
        expect(env.fake.state().clusters.filter(item => item.name === 'goobster')).toEqual([]);
        expect(env.overlay().values.GOOBSTER_NATIVE_DB_URL).toBeUndefined();
        const dry = await provision(env, {}, { apply: false });
        expect(dry.planned.plan.port).toMatchObject({ free: false, suggestion: 5433 });
        env.fake.clearCalls();
        const { applied } = await provision(env, { port: 5433 });
        expect(applied.operation.status).toBe('applied');
        expect(env.fake.calls().filter(call => call.program === 'apt-get' && call.args.includes('install'))).toEqual([]);
        expect(main()).toMatchObject({ port: 5432, online: true });
        expect(env.record().cluster.port).toBe(5433);
    }, 120000);

    test('a failing package installation changes nothing else and is reported without the program output', async () => {
        const env = await setup({ workers: false });
        env.fake.flag('aptFails');
        const failure = await provision(env).catch(error => error);
        expect(failure.code).toBeTruthy();
        expect(env.fake.state().clusters).toEqual([]);
        expect(env.overlay().values.GOOBSTER_NATIVE_DB_URL).toBeUndefined();
        expect(JSON.stringify(failure)).not.toMatch(/postgres:\/\//);
    }, 90000);
});

/* ============================================================ start, stop, repair */

describe('start, stop and repair', () => {
    const clusterOf = env => env.fake.state().clusters.find(item => item.name === 'goobster');

    test('stop and start act on the one cluster; stopping while the installation uses it needs acknowledgeInUse', async () => {
        const env = await setup();
        await provision(env);
        expect(clusterOf(env).online).toBe(true);
        const stopped = await drive(env, 'database.native.stop', {}, { auth: BRIDGE });
        expect(stopped.applied.result).toMatchObject({ stopped: true });
        expect(clusterOf(env).online).toBe(false);
        const again = await drive(env, 'database.native.stop', {}, { auth: BRIDGE });
        expect(again.applied.result).toMatchObject({ stopped: true, changed: false });
        const started = await drive(env, 'database.native.start', {}, { auth: BRIDGE });
        expect(started.applied.result).toMatchObject({ running: true, ready: true });
        expect(clusterOf(env).online).toBe(true);

        await drive(env, 'database.connect', { connection: { owned: 'native' }, release: true }, { auth: BRIDGE });
        const refused = await drive(env, 'database.native.stop', {}, { auth: BRIDGE }).catch(error => error);
        expect(refused.code).toBe('PREFLIGHT_FAILED');
        expect(refused.details.findings.map(item => item.code)).toContain('DATABASE_IN_USE');
        expect(clusterOf(env).online).toBe(true);
        const acknowledged = await drive(env, 'database.native.stop', { acknowledgeInUse: true }, { auth: BRIDGE });
        expect(acknowledged.applied.operation.status).toBe('applied');
        expect(clusterOf(env).online).toBe(false);
        for (const call of env.fake.mutations().filter(item => item.program === 'pg_ctlcluster' && ['start', 'stop'].includes(item.args[2]))) expect(call.args).toContain('goobster');
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.database.native.stop');
        expect(JSON.stringify(entry)).not.toMatch(/postgres:\/\/|password|5432/);
    }, 180000);

    test('start, stop and repair without a record say there is nothing to manage', async () => {
        const env = await setup({ workers: false });
        for (const kind of ['database.native.start', 'database.native.stop', 'database.native.repair']) {
            const failure = await drive(env, kind, {}, { auth: BRIDGE }).catch(error => error);
            expect(failure.code).toMatch(/NO_NATIVE_DATABASE|PREFLIGHT_FAILED/);
        }
        expect(env.fake.mutations()).toEqual([]);
    }, 60000);

    test('control kinds reject unknown fields', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        expect(await codeOf(drive(env, 'database.native.start', { force: true }, { auth: BRIDGE, apply: false }))).toBe('INVALID_INPUT');
        expect(await codeOf(drive(env, 'database.native.repair', { reinit: true }, { auth: BRIDGE, apply: false }))).toBe('INVALID_INPUT');
    }, 90000);

    test('repair of a healthy running cluster does nothing', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        env.fake.clearCalls();
        const { planned, applied } = await drive(env, 'database.native.repair', {}, { auth: BRIDGE });
        expect(planned.plan.action).toBe('none');
        expect(applied.operation.status).toBe('applied');
        expect(env.fake.mutations()).toEqual([]);
    }, 90000);

    test('repair of a stopped cluster converges and starts it; the data directory is never recreated', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        const dataBefore = env.fake.snapshot(env.dataDirectory);
        await drive(env, 'database.native.stop', {}, { auth: BRIDGE });
        env.fake.clearCalls();
        const dry = await drive(env, 'database.native.repair', {}, { auth: BRIDGE, apply: false });
        expect(dry.planned.plan).toMatchObject({ action: 'converge', storageKept: true, ok: true });
        expect(dry.planned.plan.reasons).toContain('STOPPED');
        const { applied } = await drive(env, 'database.native.repair', {}, { auth: BRIDGE });
        expect(applied.result).toMatchObject({ repaired: true, ready: true });
        expect(clusterOf(env).online).toBe(true);
        expect(env.fake.calls().filter(call => ['pg_createcluster', 'initdb', 'pg_dropcluster'].includes(call.program))).toEqual([]);
        expect(env.fake.snapshot(env.dataDirectory)).toEqual(dataBefore);
    }, 120000);

    test('repair refuses a cluster whose configuration is gone (Debian), and a recorded major that no longer matches the pin is MAJOR_UPGRADE_IS_MANUAL', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        const world = env.fake.state();
        env.fake.set({ clusters: world.clusters.filter(item => item.name !== 'goobster') });
        env.fake.clearCalls();
        const gone = await drive(env, 'database.native.repair', {}, { auth: BRIDGE, apply: false });
        expect(gone.planned.plan.ok).toBe(false);
        expect(gone.planned.plan.blocks.map(item => item.code)).toContain('CLUSTER_MISSING');
        expect(await codeOf(drive(env, 'database.native.repair', {}, { auth: BRIDGE }))).toBe('PREFLIGHT_FAILED');
        expect(env.fake.mutations()).toEqual([]);

        env.fake.set({ clusters: world.clusters });
        nativeState.update(env.settings.storeDir, { major: 16 });
        const major = await drive(env, 'database.native.repair', {}, { auth: BRIDGE, apply: false });
        expect(major.planned.plan.blocks.map(item => item.code)).toContain('MAJOR_UPGRADE_IS_MANUAL');
    }, 120000);

    test('on a Red Hat family host the cluster has its own unit, which start, stop and repair use', async () => {
        const env = await setup({ workers: false, machine: { distro: 'rocky' } });
        await provision(env);
        const record = env.record();
        expect(record.family).toBe('rhel');
        expect(record.cluster.service).toMatch(/^postgresql17-goobster(-[0-9a-f]{8})?\.service$/);
        await drive(env, 'database.native.stop', {}, { auth: BRIDGE });
        expect(env.fake.calls().some(call => call.program === 'systemctl' && call.args.includes('stop') && call.args.includes(record.cluster.service))).toBe(true);
        await drive(env, 'database.native.start', {}, { auth: BRIDGE });
        const { applied } = await drive(env, 'database.native.repair', {}, { auth: BRIDGE });
        expect(applied.operation.status).toBe('applied');
        for (const call of env.fake.mutations().filter(item => item.program === 'systemctl')) expect(call.args.join(' ')).not.toMatch(/\bpostgresql(\.service)?\b(?!-)/);
    }, 180000);
});

/* ================================================================== relocate */

describe('database.native.relocate', () => {
    const backupDouble = (calls = []) => ({
        createBackup: async (args) => { calls.push(args); return { dir: path.join(args.destDir, 'archive') }; },
        verifyBackup: () => ({ tables: 3, files: 2 }),
        tableCounts: async () => ({ users: 0 })
    });

    async function provisioned(extra = {}) {
        const calls = [];
        const env = await setup({ nativeDeps: { backupService: () => backupDouble(calls), ...extra } });
        await provision(env);
        await drive(env, 'database.connect', { connection: { owned: 'native' }, release: true }, { auth: BRIDGE });
        return { env, calls };
    }

    const enter = async env => {
        const held = (await env.manager.engine.run('maintenance.enter', { reason: 'native database change', timeoutSeconds: 10 }, BRIDGE)).result;
        return { operationId: held.operationId, fence: held.fence };
    };

    test('the guards: a held maintenance barrier and a backup are required; the old and overlapping directories are refused', async () => {
        const { env } = await provisioned();
        const target = path.join(env.fake.dir, 'srv', 'moved');
        const input = { target, backup: { dir: scratch('backup'), skipConfig: true } };
        expect(await codeOf(drive(env, 'database.native.relocate', input, { auth: BRIDGE, apply: false }))).toBe('MAINTENANCE_REQUIRED');
        const maintenance = await enter(env);
        expect(await codeOf(drive(env, 'database.native.relocate', { target, maintenance }, { auth: BRIDGE, apply: false }))).toBe('BACKUP_REQUIRED');
        expect(await codeOf(drive(env, 'database.native.relocate', { ...input, maintenance: { ...maintenance, fence: maintenance.fence + 9 } }, { auth: BRIDGE }))).toBe('MAINTENANCE_NOT_HELD');
        for (const bad of [env.dataDirectory, path.join(env.dataDirectory, 'inner'), path.dirname(env.dataDirectory), '/var/lib/postgresql/17/main']) {
            const outcome = await drive(env, 'database.native.relocate', { ...input, target: bad, maintenance }, { auth: BRIDGE, apply: false }).catch(error => error);
            if (outcome.code) expect(outcome.code).toMatch(/INVALID|PATH|DATA_DIRECTORY|PREFLIGHT/);
            else expect(outcome.planned.plan.ok).toBe(false);
        }
    }, 180000);

    test('backs up first, moves the data, keeps the original directory, starts the cluster there and leaves the barrier held', async () => {
        const { env, calls } = await provisioned();
        const maintenance = await enter(env);
        const original = env.dataDirectory;
        const originalFiles = env.fake.snapshot(original);
        const target = path.join(env.fake.dir, 'srv', 'moved');
        const dest = scratch('backup');
        env.fake.clearCalls();
        const { planned, applied } = await drive(env, 'database.native.relocate', { target, backup: { dir: dest, skipConfig: true }, maintenance }, { auth: BRIDGE });
        expect(stepNames(applied.operation)).toEqual(['preflight', 'backup', 'relocate', 'verify-database']);
        expect(planned.plan).toMatchObject({ effect: 'relocate-native-database', originalKept: true, from: original, to: target });
        expect(calls).toHaveLength(1);
        expect(calls[0].destDir).toBe(dest);
        const mutating = env.fake.mutations();
        expect(mutating.length).toBeGreaterThan(0);
        expect(env.record().cluster.dataDirectory).toBe(target);
        expect(env.record().relocation || null).toBeNull();
        expect(fs.existsSync(path.join(target, 'PG_VERSION'))).toBe(true);
        expect(env.fake.snapshot(original)).toEqual(originalFiles);
        expect(env.fake.state().clusters.find(item => item.name === 'goobster').online).toBe(true);
        expect(applied.result).toMatchObject({ relocated: true, backupVerified: true, originalKept: true, barrier: 'held' });
        expect(env.barrier()).toMatchObject({ active: true, operationId: maintenance.operationId });
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.database.native.relocate');
        expect(entry.detail).toMatchObject({ cluster: 'goobster', backupVerified: true, moved: true });
        expect(JSON.stringify(entry)).not.toMatch(new RegExp(`${target}|postgres://|5432`));
    }, 180000);

    test('a backup that cannot be verified stops the move before the cluster is touched', async () => {
        const failing = { createBackup: async () => { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); }, verifyBackup: () => ({}), tableCounts: async () => ({}) };
        const { env } = await provisioned({ backupService: () => failing });
        const maintenance = await enter(env);
        env.fake.clearCalls();
        const failure = await drive(env, 'database.native.relocate', { target: path.join(env.fake.dir, 'srv', 'moved'), backup: { dir: scratch('backup'), skipConfig: true }, maintenance }, { auth: BRIDGE }).catch(error => error);
        expect(failure.code).toBe('BACKUP_FAILED');
        expect(env.fake.mutations()).toEqual([]);
        expect(env.record().cluster.dataDirectory).toBe(env.dataDirectory);
        expect(env.record().relocation || null).toBeNull();
    }, 180000);

    test('an interrupted copy leaves the original serving; repeating the move completes it', async () => {
        const { env } = await provisioned();
        const maintenance = await enter(env);
        const target = path.join(env.fake.dir, 'srv', 'moved');
        const input = { target, backup: { dir: scratch('backup'), skipConfig: true }, maintenance };
        env.fake.flag('cpInterrupt');
        const failure = await drive(env, 'database.native.relocate', input, { auth: BRIDGE }).catch(error => error);
        expect(failure.code).toBeTruthy();
        expect(env.record().cluster.dataDirectory).toBe(env.dataDirectory);
        expect(fs.existsSync(path.join(env.dataDirectory, 'PG_VERSION'))).toBe(true);
        env.fake.flag('cpInterrupt', false);
        if (fs.existsSync(target)) fs.chmodSync(target, 0o755); // the real helper hands the directory to the postgres account; the sandbox cannot chown
        const again = await drive(env, 'database.native.relocate', input, { auth: BRIDGE });
        expect(again.applied.operation.status).toBe('applied');
        expect(env.record().cluster.dataDirectory).toBe(target);
    }, 180000);
});

/* ============================================================ install and uninstall */

describe('install.new with a native database answer', () => {
    async function fresh({ machine = {}, nativeDeps = {}, elevation = null } = {}) {
        const fake = fakeNative.create({ distro: 'debian', ...machine });
        fake.install();
        cleanups.push(() => fake.restore());
        const server = scriptedServer();
        const calls = [];
        const root = scratch('npi');
        const release = makeRelease(scratch('npi-src'));
        const harness = await newHarness({
            root,
            installDeps: {
                privileged,
                privilegedOptions: fake.privilegedOptions(elevation ? { elevation } : {}),
                initDatabase: async (args) => { calls.push({ ...args, overlay: environment.read(harness.settings.storeDir).values }); return { engine: args.database.engine, tables: 3 }; }
            }
        });
        harness.settings.databaseDeps = { ...server.deps };
        harness.settings.nativeDeps = fake.nativeDeps(nativeDeps);
        return { harness, release, calls, fake, server, dataDirectory: path.join(fake.dir, 'srv', 'pgdata') };
    }
    const answer = (release, dataDirectory, extra = {}) => ({ source: release.dir, release: { allowUnsigned: true }, database: { engine: 'postgres', native: { installPackages: true, dataDirectory, ...extra } } });

    test('creates the cluster, applies the schema to it, writes the connection at the cutover and stages nothing afterwards', async () => {
        const { harness, release, calls, fake, dataDirectory } = await fresh();
        const { planned, applied } = await drive(harness, 'install.new', answer(release, dataDirectory));
        expect(planned.plan.nativeDatabase).toMatchObject({ mode: 'fresh' });
        expect(planned.plan.databaseTarget).toBeUndefined();
        expect(planned.plan.privilegedSteps.filter(item => item.step === 'native-postgres').map(item => item.operation)).toEqual(['package.install', 'postgres.cluster.create']);
        expect(applied.operation.status).toBe('applied');
        expect(applied.operation.steps.map(step => step.name)).toEqual(expect.arrayContaining(['native-postgres', 'init-db']));
        expect(fake.state().clusters.map(item => item.name)).toEqual(['goobster']);
        expect(calls).toHaveLength(1);
        expect(calls[0].overlay.GOOBSTER_DB_URL).toBeUndefined();
        const overlay = environment.read(harness.settings.storeDir).values;
        expect(overlay.GOOBSTER_DB_URL).toMatch(/^postgres:\/\/goobster:/);
        expect(overlay.GOOBSTER_NATIVE_DB_URL).toBeUndefined();
        expect(harness.manager.store.readInstallation().doc.database).toEqual({ engine: 'postgres', external: true });
        expect(nativeState.read(harness.settings.storeDir).doc.step).toBe('verified');
        const password = decodeURIComponent(new URL(overlay.GOOBSTER_DB_URL).password);
        const published = journalText(harness) + JSON.stringify(planned) + JSON.stringify(applied) + fake.argvText() + fake.stdinText();
        expect(published).not.toContain(password);
        expect(published).not.toContain(encodeURIComponent(password));
    }, 180000);

    test('the preflight shows the port and the packages as findings and never a database target', async () => {
        const { harness, release, fake, dataDirectory } = await fresh();
        fake.set({ listening: [5432] });
        const dry = await drive(harness, 'install.new', answer(release, dataDirectory), { apply: false }).catch(error => error);
        const findings = dry.planned ? dry.planned.plan.preflight.findings : (dry.details || {}).findings || [];
        expect(findings.map(item => item.code)).toEqual(expect.arrayContaining(['NATIVE_PORT_IN_USE']));
        expect(JSON.stringify(findings)).not.toMatch(/password|postgres:\/\//);
        expect(fake.mutations()).toEqual([]);
        expect(environment.read(harness.settings.storeDir).present).toBe(false);
    }, 120000);

    test('an unsupported distribution and a missing elevation block the preflight; nothing is written', async () => {
        const { harness, release, calls, fake, dataDirectory } = await fresh({ nativeDeps: { distro: { supported: false, reason: 'DISTRO_UNSUPPORTED', remedy: 'Not here.', family: null, id: 'arch' } } });
        const failure = await drive(harness, 'install.new', answer(release, dataDirectory)).catch(error => error);
        expect(failure.code).toBe('PREFLIGHT_FAILED');
        expect(failure.details.findings.map(item => item.code)).toContain('NATIVE_DISTRO_UNSUPPORTED');
        expect(calls).toEqual([]);
        expect(fake.mutations()).toEqual([]);
        expect(environment.read(harness.settings.storeDir).present).toBe(false);

        const second = await fresh({ elevation: { kind: 'none', reason: 'NO_ELEVATION' } });
        const blocked = await drive(second.harness, 'install.new', answer(second.release, second.dataDirectory)).catch(error => error);
        expect(blocked.code).toBe('PREFLIGHT_FAILED');
        expect(blocked.details.findings.map(item => item.code)).toContain('NATIVE_ELEVATION_UNAVAILABLE');
        expect(second.fake.mutations()).toEqual([]);
    }, 180000);

    test('a connection, a docker answer and a native answer are mutually exclusive', async () => {
        const { harness, release } = await fresh();
        const connection = { host: 'db.example.com', port: 5432, database: 'x', user: 'u', password: 'p', tls: { mode: 'require' } };
        for (const extra of [{ connection }, { docker: {} }]) {
            const input = { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'postgres', native: {}, ...extra } };
            expect(await codeOf(drive(harness, 'install.new', input, { apply: false }))).toBe('INVALID_INPUT');
        }
        const sqlite = { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'sqlite', native: {} } };
        expect(await codeOf(drive(harness, 'install.new', sqlite, { apply: false }))).toBe('INVALID_INPUT');
    }, 120000);
});

describe('uninstall', () => {
    async function installed({ withForeign = true } = {}) {
        const fake = fakeNative.create({ distro: 'debian' });
        fake.install();
        cleanups.push(() => fake.restore());
        const server = scriptedServer();
        const root = scratch('npu');
        const release = makeRelease(scratch('npu-src'));
        const harness = await newHarness({ root, installDeps: { privileged, privilegedOptions: fake.privilegedOptions(), initDatabase: async (args) => ({ engine: args.database.engine, tables: 3 }) } });
        harness.settings.databaseDeps = { ...server.deps };
        harness.settings.nativeDeps = fake.nativeDeps();
        const foreign = withForeign ? fake.seedForeignCluster({ name: 'main', port: 5432 }) : null;
        const dataDirectory = path.join(fake.dir, 'srv', 'pgdata');
        await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'postgres', native: { installPackages: true, dataDirectory, port: 5441 } } });
        const doc = harness.manager.store.readInstallation().doc;
        return { harness, fake, doc, foreign, dataDirectory };
    }

    test('by default the cluster, its data directory and the packages are kept and nothing on the machine changes', async () => {
        const { harness, fake, dataDirectory } = await installed();
        fake.clearCalls();
        const { planned, applied } = await drive(harness, 'install.uninstall', {});
        expect(planned.plan.removeNativeData).toBe(false);
        expect(planned.plan.nativeDatabase).toMatchObject({ action: 'kept' });
        expect(applied.operation.status).toBe('applied');
        expect(fake.mutations()).toEqual([]);
        expect(fake.state().clusters.map(item => item.name).sort()).toEqual(['goobster', 'main']);
        expect(fs.existsSync(path.join(dataDirectory, 'PG_VERSION'))).toBe(true);
        expect(nativeState.read(harness.settings.storeDir).present).toBe(true);
    }, 180000);

    test('a delete-data uninstall without removeNativeData warns that the cluster and its data stay', async () => {
        const { harness, doc, dataDirectory } = await installed();
        const dry = await drive(harness, 'install.uninstall', { keepData: false, confirm: doc.installationId }, { apply: false });
        const warning = dry.planned.plan.preflight.findings.find(item => item.code === 'NATIVE_DATA_RETAINED');
        expect(warning).toMatchObject({ severity: 'warn' });
        expect(warning.detail).toContain(dataDirectory);
        expect(dry.planned.plan.preflight.ok).toBe(true);
        const kept = await drive(harness, 'install.uninstall', { keepData: true }, { apply: false });
        expect(kept.planned.plan.preflight.findings.some(item => item.code === 'NATIVE_DATA_RETAINED')).toBe(false);
    }, 180000);

    test('removeNativeData needs the installation id as confirmation and removes exactly our cluster and data; the other cluster and the packages stay', async () => {
        const { harness, fake, doc, foreign, dataDirectory } = await installed();
        const foreignBefore = fake.snapshot(foreign.files);
        const packages = fake.state().installed.slice();
        fake.clearCalls();
        expect(await codeOf(drive(harness, 'install.uninstall', { removeNativeData: true }))).toBe('CONFIRMATION_REQUIRED');
        expect(await codeOf(drive(harness, 'install.uninstall', { removeNativeData: true, confirm: 'nope' }))).toBe('CONFIRMATION_REQUIRED');
        expect(fake.mutations()).toEqual([]);
        const dry = await drive(harness, 'install.uninstall', { removeNativeData: true, confirm: doc.installationId }, { apply: false });
        expect(dry.planned.plan.nativeDatabase).toMatchObject({ action: 'remove', packagesKept: true, resources: expect.arrayContaining([{ kind: 'cluster', name: 'goobster' }]) });
        expect(dry.planned.plan.privilegedSteps.filter(item => item.step === 'native-postgres').map(item => item.operation)).toEqual(['postgres.cluster.remove']);

        const { applied } = await drive(harness, 'install.uninstall', { removeNativeData: true, confirm: doc.installationId });
        expect(applied.operation.status).toBe('applied');
        expect(fake.state().clusters.map(item => item.name)).toEqual(['main']);
        expect(fs.existsSync(dataDirectory)).toBe(false);
        expect(fake.state().installed).toEqual(packages);
        expect(fake.snapshot(foreign.files)).toEqual(foreignBefore);
        expect(fake.calls().filter(call => call.program === 'apt-get' && !call.args.includes('install'))).toEqual([]);
        for (const call of fake.mutations().filter(item => item.program === 'pg_dropcluster')) expect(call.args).toContain('goobster');
        expect(nativeState.read(harness.settings.storeDir).present).toBe(false);
        const entry = harness.manager.journal.readAudit().entries.find(item => item.action === 'manager.install.uninstall');
        expect(JSON.stringify(entry)).not.toMatch(/postgres:\/\/|password/);
    }, 180000);
});

/* ============================================================== readiness gate */

describe('the readiness gate', () => {
    test('is inert without a record, and when the installation is not connected to the owned port', async () => {
        const env = await setup({ workers: false });
        const readiness = () => createReadiness({ settings: env.settings });
        expect(await readiness().check()).toMatchObject({ owned: false, ready: true });
        env.fake.clearCalls();
        await readiness().check();
        expect(env.fake.calls()).toEqual([]);
        await provision(env);
        env.fake.clearCalls();
        expect(await readiness().check()).toMatchObject({ owned: false, ready: true });
        expect(env.fake.calls()).toEqual([]);
    }, 90000);

    test('answers DATABASE_NOT_READY with the reason while the owned cluster is stopped, and ready when it runs', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        await drive(env, 'database.connect', { connection: { owned: 'native' }, release: true }, { auth: BRIDGE });
        const readiness = () => createReadiness({ settings: env.settings });
        expect(await readiness().check()).toMatchObject({ owned: true, ready: true });
        await drive(env, 'database.native.stop', { acknowledgeInUse: true }, { auth: BRIDGE });
        expect(await readiness().check()).toMatchObject({ owned: true, ready: false, code: 'DATABASE_NOT_READY', reason: 'NOT_LISTENING' });
        await drive(env, 'database.native.start', {}, { auth: BRIDGE });
        expect(await readiness().check()).toMatchObject({ owned: true, ready: true });
    }, 180000);

    test('the supervisor holds a worker back with DATABASE_NOT_READY while the cluster is down', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        await drive(env, 'database.connect', { connection: { owned: 'native' }, release: true }, { auth: BRIDGE });
        await drive(env, 'database.native.stop', { acknowledgeInUse: true }, { auth: BRIDGE });

        const fakes = createFakeWorkers();
        const gate = [];
        const supervisor = createSupervisor({
            manager: env.manager,
            adapter: fakes.adapter,
            checkHealth: fakes.checkHealth,
            sandboxActive: () => false,
            logger: { info() {}, warn() {}, error() {} },
            policy: { ...FAST_POLICY, databaseWaitMs: 40, databasePollMs: 5, databaseGate: async () => { const out = await createReadiness({ settings: env.settings }).check(); gate.push(out.reason || 'ready'); return out; } }
        });
        const unregister = registry.register(env.settings.storeDir, supervisor);
        cleanups.push(async () => { await supervisor.stop(); unregister(); for (const proc of fakes.alive()) proc.die(0); });
        await supervisor.start().catch(() => null);
        await waitFor(async () => gate.length > 0, { what: 'the gate was consulted' });
        expect(gate).toContain('NOT_LISTENING');
        expect(JSON.stringify(await supervisor.status())).toContain('DATABASE_NOT_READY');
        expect(fakes.alive()).toHaveLength(0);
    }, 120000);
});

/* ================================================== a cluster that is not ours */

describe('a cluster that is not ours', () => {
    test('provision, start, stop, repair, relocate and uninstall never touch it, byte for byte', async () => {
        const calls = [];
        const env = await setup({ nativeDeps: { backupService: () => ({ createBackup: async (args) => { calls.push(args); return { dir: path.join(args.destDir, 'a') }; }, verifyBackup: () => ({ tables: 1, files: 1 }), tableCounts: async () => ({}) }) } });
        const foreign = env.fake.seedForeignCluster({ name: 'main', port: 5432 });
        const files = env.fake.snapshot(foreign.files);
        const config = env.fake.snapshot(foreign.config);
        const check = () => {
            expect(env.fake.snapshot(foreign.files)).toEqual(files);
            expect(env.fake.snapshot(foreign.config)).toEqual(config);
            const main = env.fake.state().clusters.find(item => item.name === 'main');
            expect(main).toMatchObject({ port: 5432, online: true });
        };
        await provision(env, { port: 5450 });
        check();
        await drive(env, 'database.connect', { connection: { owned: 'native' }, release: true }, { auth: BRIDGE });
        await drive(env, 'database.native.stop', { acknowledgeInUse: true }, { auth: BRIDGE });
        await drive(env, 'database.native.start', {}, { auth: BRIDGE });
        await drive(env, 'database.native.repair', {}, { auth: BRIDGE });
        check();
        const held = (await env.manager.engine.run('maintenance.enter', { reason: 'native database change', timeoutSeconds: 10 }, BRIDGE)).result;
        await drive(env, 'database.native.relocate', { target: path.join(env.fake.dir, 'srv', 'moved'), backup: { dir: scratch('backup'), skipConfig: true }, maintenance: { operationId: held.operationId, fence: held.fence } }, { auth: BRIDGE });
        check();
        for (const call of env.fake.mutations()) {
            const text = `${call.program} ${call.args.join(' ')}`;
            expect(text).not.toMatch(/\b17 main\b|\b17\/main\b|\bmain\b/);
        }
        expect(env.fake.stdinText()).not.toMatch(/ALTER SYSTEM|pg_hba/i);
    }, 240000);
});

/* ==================================================================== discovery */

describe('discovery', () => {
    test('lists the clusters this installer created by their fixed names, and never the distribution\'s own', async () => {
        const env = await setup({ workers: false });
        env.fake.seedForeignCluster({ name: 'main', port: 5432 });
        await provision(env, { port: 5460 });
        const read = (name) => {
            const table = { 'native-clusters': ['pg_lsclusters', ['--no-header']] };
            if (!table[name]) return null;
            return require('node:child_process').spawnSync(path.join(env.fake.bin, table[name][0]), table[name][1], { encoding: 'utf8', env: { ...process.env, ...env.fake.env() } }).stdout;
        };
        const found = discover({ fs, home: env.root, env: env.settings.env, exec: read });
        expect(found.nativeDatabases.map(item => item.cluster)).toEqual(['goobster']);
        expect(found.nativeDatabases[0]).toMatchObject({ version: 17, port: 5460, state: 'online' });
        expect(JSON.stringify(found)).not.toMatch(/password|postgres:\/\//);
        expect(discover({ fs, home: env.root, env: env.settings.env, exec: () => null }).nativeDatabases).toEqual([]);
    }, 90000);
});
