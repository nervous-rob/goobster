/**
 * The operations on the Docker PostgreSQL instance the manager owns (#339,
 * documentation/docker_postgres.md): `database.docker.provision|start|stop|
 * repair|reconfigure`, the Docker answer of `install.new`, the uninstall
 * scopes, the readiness gate and discovery.
 *
 * No Docker daemon is needed or used: a fake `docker` executable sits first
 * on PATH (tests/helpers/fakeDocker.js) and records every argv together with
 * the secret environment values it carried. The #338 library's role
 * provisioning, the schema child process and the probe are scripted through
 * `settings.databaseDeps`, exactly as in tests/databaseKinds.test.js. The last
 * block runs the same journey against a real daemon and a real container; it
 * needs GOOBSTER_DOCKER_TESTS=1 and skips with its reason otherwise.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-docker-kinds-'));
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'jest-own.sqlite');

const { newHarness, drive, codeOf, tempDir, makeRelease } = require('./helpers/installFixture');
const fakeDocker = require('./helpers/fakeDocker');
const { createFakeWorkers, waitFor, FAST_POLICY } = require('./helpers/fakeWorkers');
const { discover } = require('@goobster/manager/install/discover');
const { createSupervisor } = require('@goobster/manager/lifecycle/supervisor');
const registry = require('@goobster/manager/lifecycle/registry');
const { tune } = require('@goobster/manager/maintenance/barrier');
const { createMaintenanceStore } = require('@goobster/manager/maintenance/store');
const environment = require('@goobster/manager/environment');
const dockerState = require('@goobster/manager/docker/state');
const { createReadiness } = require('@goobster/manager/docker/readiness');
const { createDockerService } = require('@goobster/manager/docker/service');
const { MANAGER_AUDIT_ACTIONS } = require('@goobster/manager/audit');
const operatorAudit = require('@goobster/core/services/operatorAuditService');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const coreMaintenance = require('@goobster/core/runtime/maintenance');
const { expectedSchema } = require('@goobster/core/db/migration/schemaModel');

const BRIDGE = { principal: 'owner-1', via: 'bridge' };
const TUNING = { timeoutScale: 0.05, pollMs: 10, downGraceMs: 150, resumeWaitMs: 300 };
const PG17 = async () => ({ present: true, text: 'pg_dump (PostgreSQL) 17.4' });
const KINDS = ['database.docker.provision', 'database.docker.start', 'database.docker.stop', 'database.docker.repair', 'database.docker.reconfigure'];
const cleanups = [];
const scratch = label => tempDir(cleanups.roots || (cleanups.roots = []), label);

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
}, 60000);

afterAll(() => {
    // A root that still holds a file another account made (a container's cluster directory) is left behind rather than failing the suite.
    for (const dir of [...(cleanups.roots || []), ROOT]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* not ours to delete */ }
    }
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

/** The Postgres side the #338 library would talk to: records what it was asked and with which credentials. */
function scriptedServer() {
    const server = { provisioned: [], applied: [], urls: [] };
    server.deps = {
        probeDeps: {
            createClient: () => ({}),
            inspect: async (url) => {
                server.urls.push(url);
                return inspected();
            }
        },
        runProvisioning: async (args) => {
            server.provisioned.push(args);
            return { results: args.actions.map(action => ({ action, status: 'done' })) };
        },
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
 * fence, a fake docker on PATH and a scripted Postgres side.
 */
async function setup({ docker = {}, dockerDeps = {}, server = scriptedServer(), env = {}, workers = true, real = false } = {}) {
    const fake = real ? null : fakeDocker.create(docker).install();
    if (fake) cleanups.push(() => fake.restore());
    const root = scratch('dpk');
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

    settings.databaseDeps = real ? {} : { ...server.deps };
    // `tcpProbe` is the readiness gate's own port check: scripted runs must never depend on what listens on this host.
    settings.dockerDeps = real ? { waitMs: 180000, pollMs: 1000, ...dockerDeps } : { sleep: async () => {}, probeListen: async () => true, tcpProbe: async () => true, pgDump: PG17, waitMs: 2000, pollMs: 5, platform: 'linux', hostArch: 'x64', ...dockerDeps };
    const installation = () => harness.manager.store.readInstallation().doc;
    const overlay = () => environment.read(settings.storeDir);
    const names = () => createDockerService({ settings }).resourceNames(installation().installationId);
    return { ...harness, fake, server, fakes, supervisor, installation, overlay, names, barrier: () => createMaintenanceStore({ storeDir: settings.storeDir }).read().doc };
}

/** Provision with the pull approved (the fake image is present anyway) and return the drive result. */
const provision = (env, input = {}, options = {}) => drive(env, 'database.docker.provision', { pull: true, ...input }, { auth: BRIDGE, ...options });

const stepNames = operation => [...new Set(operation.steps.map(step => step.name))].filter(name => name !== 'validate');

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

const runCalls = fake => fake.calls().filter(call => call.args[0] === 'run');

/* ================================================================ registration */

describe('registration', () => {
    test('the five audit actions exist on both sides and the kinds are registered and public', async () => {
        for (const kind of KINDS) {
            expect(MANAGER_AUDIT_ACTIONS).toContain(`manager.${kind}`);
            expect(operatorAudit.ACTIONS.has(`manager.${kind}`)).toBe(true);
        }
        const env = await setup({ workers: false });
        const kinds = require('@goobster/manager/engine/kinds/dockerPostgres').createKinds({ settings: env.settings });
        expect(kinds.map(item => [item.kind, item.public])).toEqual(KINDS.map(kind => [kind, true]));
        for (const kind of KINDS) expect(env.manager.engine.kinds).toContain(kind);
    }, 60000);

    test('an installation nobody has claimed has nothing to attach a database to', async () => {
        const fake = fakeDocker.create().install();
        cleanups.push(() => fake.restore());
        const bare = await newHarness({ root: scratch('unclaimed') });
        expect(await codeOf(bare.manager.engine.plan('database.docker.provision', {}, BRIDGE, { internal: true }))).toBe('STATE_NOT_ALLOWED');
    }, 60000);
});

/* ================================================================== provision */

describe('database.docker.provision', () => {
    test('plans the names, labels, port and image, creates exactly three resources, and never connects the installation', async () => {
        const env = await setup();
        const { planned, applied } = await provision(env);
        const names = env.names();
        expect(names).toMatchObject({ container: expect.stringMatching(/^goobster-pg-[0-9a-f]{8}$/), volume: expect.stringMatching(/^goobster-pgdata-[0-9a-f]{8}$/), network: expect.stringMatching(/^goobster-[0-9a-f]{8}$/) });
        expect(planned.plan).toMatchObject({ effect: 'provision-docker-database', mode: 'fresh', names, ok: true });
        expect(planned.plan.request).toMatchObject({ port: 5432, bind: '127.0.0.1', storage: { kind: 'volume' } });
        expect(planned.plan.image).toMatchObject({ reference: 'pgvector/pgvector:pg17', postgresMajor: 17, pulled: true });
        expect(planned.plan.image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(planned.plan.steps.map(step => step.name)).toEqual(['preflight', 'create', 'wait-healthy', 'provision', 'verify']);
        expect(applied.operation.status).toBe('applied');
        expect(stepNames(applied.operation)).toEqual(['preflight', 'create', 'wait-healthy', 'provision', 'verify']);

        const state = env.fake.state();
        expect(Object.keys(state.containers)).toEqual([names.container]);
        expect(Object.keys(state.volumes)).toEqual([names.volume]);
        expect(Object.keys(state.networks)).toEqual([names.network]);
        const id = env.installation().installationId;
        for (const resource of [state.containers[names.container], state.volumes[names.volume], state.networks[names.network]]) {
            expect(resource.labels).toMatchObject({ 'io.goobster.installation': id, 'io.goobster.manager': '1' });
        }
        expect(state.containers[names.container]).toMatchObject({ bind: '127.0.0.1', port: 5432, restart: 'unless-stopped' });

        expect(dockerState.read(env.settings.storeDir).doc).toMatchObject({ installationId: id, step: 'verified' });
        expect(env.installation().database.engine).toBe('sqlite');
        expect(env.overlay().values.GOOBSTER_DB_URL).toBeUndefined();
        expect(env.overlay().values.GOOBSTER_DOCKER_DB_URL).toMatch(/^postgres(ql)?:\/\/goobster:/);
        expect(env.settings.dbUrl || '').toBe('');
        expect(applied.result).toMatchObject({ next: expect.any(String) });
    }, 120000);

    test('drives the #338 library with the generated superuser, then the schema and the probe with the application role', async () => {
        const env = await setup();
        await provision(env, { port: 5544, database: 'goobster_x', role: 'goobster_x' });
        expect(env.server.provisioned).toHaveLength(1);
        const [call] = env.server.provisioned;
        expect(call.actions).toEqual(['create-role', 'create-database', 'create-extension.citext', 'create-extension.vector', 'create-schema', 'grant']);
        expect(call).toMatchObject({ tlsMode: 'disable', elevated: { user: 'postgres', database: 'postgres' }, application: { host: '127.0.0.1', port: 5544, database: 'goobster_x', user: 'goobster_x' } });
        expect(call.elevated.password.length).toBeGreaterThanOrEqual(24);
        expect(call.application.password).not.toBe(call.elevated.password);
        expect(env.server.applied).toHaveLength(1);
        expect(decodeURIComponent(env.server.applied[0].url)).toContain(call.application.password);
        expect(env.server.urls.length).toBeGreaterThan(0);
    }, 120000);

    test('the superuser password reaches docker through the child environment only; no argv, record, journal, audit row or file holds a password', async () => {
        const env = await setup();
        const { planned, applied } = await provision(env);
        const [superuser] = [env.server.provisioned[0].elevated.password];
        const application = env.server.provisioned[0].application.password;

        const runs = runCalls(env.fake);
        expect(runs).toHaveLength(1);
        expect(runs[0].env).toEqual({ POSTGRES_PASSWORD: superuser });
        expect(runs[0].args).toContain('POSTGRES_PASSWORD');
        for (const secret of [superuser, application, encodeURIComponent(application)]) {
            expect(env.fake.argvText()).not.toContain(secret);
            const published = journalText(env) + JSON.stringify(planned) + JSON.stringify(applied) + JSON.stringify(dockerState.read(env.settings.storeDir));
            expect(published).not.toContain(secret);
        }
        expect(env.fake.argvText()).not.toMatch(/POSTGRES_PASSWORD=/);

        const overlayFile = environment.fileFor(env.settings.storeDir);
        expect(fs.statSync(overlayFile).mode & 0o777).toBe(0o600);
        expect(decodeURIComponent(env.overlay().values.GOOBSTER_DOCKER_DB_URL)).toContain(application);
        const everywhere = everythingUnder(env.root, { skip: file => file === overlayFile });
        expect(everywhere).not.toContain(application);
        expect(everywhere).not.toContain(superuser);
        expect(fs.readFileSync(`${env.fake.statePath}.calls`, 'utf8')).not.toContain(application);
    }, 120000);

    test('every docker call that changes something names an exact resource; there is no prune, no --all, no filter', async () => {
        const env = await setup();
        await provision(env);
        const id = env.installation().installationId;
        const text = env.fake.argvText();
        expect(text).not.toMatch(/prune/);
        for (const call of env.fake.mutations()) {
            expect(call.args).not.toContain('--all');
            expect(call.args).not.toContain('-a');
            expect(call.args).not.toContain('--filter');
        }
        const [run] = runCalls(env.fake);
        expect(run.args.join(' ')).toContain(`io.goobster.installation=${id}`);
        expect(run.args).toEqual(expect.arrayContaining(['-p', '127.0.0.1:5432:5432']));
        expect(run.args).toContain(env.names().container);
        expect(run.args[run.args.length - 1]).toMatch(/^pgvector\/pgvector@sha256:[0-9a-f]{64}$/);
    }, 120000);

    test('the audit row carries names only: no host, port, user, URL or password', async () => {
        const env = await setup();
        const { applied } = await provision(env);
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.database.docker.provision');
        expect(entry).toMatchObject({ outcome: 'applied' });
        expect(entry.detail).toMatchObject({ container: env.names().container, volume: env.names().volume, network: env.names().network });
        const text = JSON.stringify(entry);
        for (const word of ['password', '127.0.0.1', 'postgres://', '5432', 'secret']) expect(text).not.toContain(word);
        expect(JSON.stringify(applied.result)).not.toMatch(/postgres:\/\//);
    }, 120000);

    test('database.connect with the owned reference is the only cutover: the overlay URL appears there and the staged copy is removed on request', async () => {
        const env = await setup();
        await provision(env);
        expect(env.overlay().values.GOOBSTER_DB_URL).toBeUndefined();
        const before = env.fake.calls().length;
        const { applied } = await drive(env, 'database.connect', { connection: { owned: 'docker' }, release: true }, { auth: BRIDGE });
        expect(applied.operation.status).toBe('applied');
        expect(env.installation().database).toMatchObject({ engine: 'postgres' });
        const values = env.overlay().values;
        expect(values.GOOBSTER_DB_URL).toMatch(/^postgres/);
        expect(values.GOOBSTER_DOCKER_DB_URL).toBeUndefined();
        expect(env.fake.calls().filter(call => ['run', 'rm', 'stop'].includes(call.args[0])).length).toBe(env.fake.calls().slice(0, before).filter(call => ['run', 'rm', 'stop'].includes(call.args[0])).length);
        expect(journalText(env)).not.toContain(values.GOOBSTER_DB_URL);
    }, 120000);

    test('a connection answer naming the owned instance without a provisioned one is refused', async () => {
        const env = await setup({ workers: false });
        expect(await codeOf(drive(env, 'database.connect', { connection: { owned: 'docker' } }, { auth: BRIDGE, apply: false }))).toBe('NO_DOCKER_DATABASE');
    }, 60000);

    test('a second provision over a verified instance is refused as already provisioned', async () => {
        const env = await setup();
        await provision(env);
        const again = await provision(env).catch(error => error);
        expect(again.code).toBe('PREFLIGHT_FAILED');
        expect(again.details.findings.map(item => item.code)).toContain('ALREADY_PROVISIONED');
        expect(runCalls(env.fake)).toHaveLength(1);
    }, 120000);
});

describe('database.docker.provision: what blocks it before anything is created', () => {
    test('a port in use is a block that offers the next free port; picking it succeeds', async () => {
        const busy = new Set([5432, 5433]);
        const env = await setup({ dockerDeps: { probeListen: async port => !busy.has(port) }, workers: false });
        const dry = await provision(env, {}, { apply: false });
        expect(dry.planned.plan.ok).toBe(false);
        expect(dry.planned.plan.port).toMatchObject({ requested: 5432, free: false, suggestion: 5434 });
        const finding = dry.planned.plan.findings.find(item => item.code === 'PORT_IN_USE');
        expect(finding.remedy).toContain('5434');
        const failure = await provision(env).catch(error => error);
        expect(failure.code).toBe('PREFLIGHT_FAILED');
        expect(env.fake.mutations()).toEqual([]);

        env.settings.dockerDeps.probeListen = async port => !busy.has(port);
        const { applied } = await provision(env, { port: 5434 });
        expect(applied.operation.status).toBe('applied');
        expect(env.fake.state().containers[env.names().container].port).toBe(5434);
    }, 120000);

    test('a port that another container publishes is named as such, and that container is untouched', async () => {
        const env = await setup({ workers: false });
        env.fake.seedForeign({ container: 'unrelated-pg', volume: 'unrelated-data', port: 5432 });
        const dry = await provision(env, {}, { apply: false });
        expect(dry.planned.plan.findings.find(item => item.code === 'PORT_IN_USE')).toBeDefined();
        expect(env.fake.state().containers['unrelated-pg']).toBeDefined();
        expect(env.fake.mutations()).toEqual([]);
    }, 60000);

    test('a request outside the shape is INVALID_INPUT: port range, loopback-only binds, relative or traversing paths', async () => {
        const env = await setup({ workers: false });
        for (const input of [{ port: 70000 }, { port: 'x' }, { bind: 'localhost' }, { storage: { kind: 'path', path: 'relative/dir' } }, { storage: { kind: 'path', path: '/srv/../etc' } }, { storage: { kind: 'tmpfs' } }, { role: 'postgres' }, { memoryMb: 8 }, { extra: 1 }]) {
            expect(await codeOf(env.manager.engine.plan('database.docker.provision', input, BRIDGE, { internal: true }))).toBe('INVALID_INPUT');
        }
        expect(env.fake.mutations()).toEqual([]);
    }, 60000);

    test('a bind beyond loopback needs an explicit acknowledgement', async () => {
        const env = await setup({ workers: false });
        expect(await codeOf(provision(env, { bind: '0.0.0.0' }, { apply: false }))).toBe('LAN_BIND_NOT_ACKNOWLEDGED');
        const { planned } = await provision(env, { bind: '0.0.0.0', acknowledgeLanBind: true }, { apply: false });
        expect(planned.plan.findings.map(item => item.code)).toContain('LAN_BIND');
        expect(planned.plan.ok).toBe(true);
    }, 60000);

    test('storage: an existing file, a directory that already holds pgdata and an uncreatable path are blocks; an empty directory is accepted', async () => {
        const env = await setup({ workers: false });
        const base = scratch('storage');
        const file = path.join(base, 'a-file');
        fs.writeFileSync(file, 'x');
        const holding = path.join(base, 'holding');
        fs.mkdirSync(path.join(holding, 'pgdata'), { recursive: true });
        const empty = path.join(base, 'empty');
        fs.mkdirSync(empty);
        const codes = async (dir) => (await provision(env, { storage: { kind: 'path', path: dir } }, { apply: false })).planned.plan.findings.map(item => item.code);
        expect(await codes(file)).toContain('STORAGE_NOT_DIRECTORY');
        expect(await codes(holding)).toContain('STORAGE_HAS_DATA');
        const closed = path.join(base, 'closed');
        fs.mkdirSync(closed, { mode: 0o700 });
        expect(await codes(closed)).toContain('STORAGE_NOT_ENTERABLE');
        fs.chmodSync(closed, 0o711);
        expect(await codes(closed)).not.toContain('STORAGE_NOT_ENTERABLE');
        const plan = (await provision(env, { storage: { kind: 'path', path: empty } }, { apply: false })).planned.plan;
        expect(plan.ok).toBe(true);
        expect(plan.storage).toMatchObject({ kind: 'path' });
        expect(env.fake.mutations()).toEqual([]);
    }, 60000);

    test('a host directory is created enterable by the container account, mounted into the container, and survives an uninstall that removes the Docker data', async () => {
        const env = await setup({ workers: false });
        const dir = path.join(scratch('storage-path'), 'pgdata-root');
        await provision(env, { storage: { kind: 'path', path: dir } });
        expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
        const [run] = runCalls(env.fake);
        expect(run.args.join(' ')).toContain(`${dir}:`);
        expect(env.fake.state().volumes).toEqual({});
        const removal = await createDockerService({ settings: env.settings }).retire({ installationId: env.installation().installationId, remove: true });
        expect(removal.removed).toContain('container');
        expect(removal.keptHostPath).toBe(dir);
        expect(fs.existsSync(dir)).toBe(true);
    }, 120000);

    test('the backup tools: a mismatched or missing pg_dump blocks until acknowledged', async () => {
        const old = async () => ({ present: true, text: 'pg_dump (PostgreSQL) 15.8' });
        const env = await setup({ dockerDeps: { pgDump: old }, workers: false });
        const dry = await provision(env, {}, { apply: false });
        expect(dry.planned.plan.backupTools).toMatchObject({ ok: false, code: 'BACKUP_TOOLS_MISMATCH' });
        expect(dry.planned.plan.ok).toBe(false);
        expect(await codeOf(provision(env))).toBe('PREFLIGHT_FAILED');
        const acknowledged = await provision(env, { acknowledgeBackupTools: true }, { apply: false });
        expect(acknowledged.planned.plan.ok).toBe(true);
        expect(acknowledged.planned.plan.backupTools.code).toBe('BACKUP_TOOLS_MISMATCH');

        env.settings.dockerDeps.pgDump = async () => ({ present: false, text: '' });
        const missing = await provision(env, {}, { apply: false });
        expect(missing.planned.plan.backupTools.code).toBe('BACKUP_TOOLS_MISSING');
    }, 60000);

    test('an image that is not on this machine is pulled only when approved', async () => {
        const env = await setup({ docker: { imagePulled: false }, workers: false });
        const dry = await drive(env, 'database.docker.provision', {}, { auth: BRIDGE, apply: false });
        expect(dry.planned.plan.ok).toBe(false);
        expect(dry.planned.plan.findings.map(item => item.code)).toContain('IMAGE_PULL_NOT_APPROVED');
        expect(dry.planned.plan.image).toMatchObject({ pulled: false });
        expect(await codeOf(drive(env, 'database.docker.provision', {}, { auth: BRIDGE }))).toBe('PREFLIGHT_FAILED');
        expect(env.fake.calls().some(call => call.args[0] === 'pull')).toBe(false);
        await provision(env);
        const pulls = env.fake.calls().filter(call => call.args[0] === 'pull');
        expect(pulls).toHaveLength(1);
        expect(pulls[0].args[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
    }, 120000);

    test.each([
        ['unreachable', 'DOCKER_DAEMON_UNREACHABLE'],
        ['permission', 'DOCKER_PERMISSION_DENIED'],
        ['windows', 'CONTAINER_OS_UNSUPPORTED'],
        ['old', 'DOCKER_ENGINE_TOO_OLD']
    ])('a %s daemon blocks with a remedy and creates nothing', async (mode, code) => {
        const env = await setup({ docker: { mode }, workers: false });
        const dry = await provision(env, {}, { apply: false });
        expect(dry.planned.plan.ok).toBe(false);
        const block = dry.planned.plan.blocks.find(item => item.code === code);
        expect(block).toBeDefined();
        expect(block.remedy).toBeTruthy();
        expect(await codeOf(provision(env))).toBe('PREFLIGHT_FAILED');
        expect(env.fake.mutations()).toEqual([]);
        expect(dockerState.read(env.settings.storeDir).present).toBe(false);
    }, 60000);
});

describe('database.docker.provision: foreign resources are never touched', () => {
    test('a container, volume or network that has our names but not our labels is RESOURCE_FOREIGN, in the plan and at every later step', async () => {
        const env = await setup({ workers: false });
        const names = env.names();
        env.fake.seedForeign({ container: names.container, volume: names.volume, network: names.network, port: 6000 });
        const dry = await provision(env, {}, { apply: false });
        expect(dry.planned.plan.findings.map(item => item.code)).toContain('RESOURCE_FOREIGN');
        expect(dry.planned.plan.ok).toBe(false);
        expect(await codeOf(provision(env))).toBe('PREFLIGHT_FAILED');
        expect(env.fake.mutations()).toEqual([]);
        expect(env.fake.state().containers[names.container].labels).toEqual({ 'com.example.owner': 'someone-else' });
    }, 60000);

    test('an unrelated postgres:16 container and its volume survive provision, stop, start, repair, reconfigure and both uninstall scopes', async () => {
        const env = await setup();
        env.fake.seedForeign({ container: 'their-pg16', volume: 'their-pg16-data', network: 'their-net', port: 5999 });
        const before = JSON.stringify({ c: env.fake.state().containers['their-pg16'], v: env.fake.state().volumes['their-pg16-data'], n: env.fake.state().networks['their-net'] });
        await provision(env);
        await drive(env, 'database.docker.stop', {}, { auth: BRIDGE });
        await drive(env, 'database.docker.start', {}, { auth: BRIDGE });
        const names = env.names();
        const next = env.fake.state();
        delete next.containers[names.container];
        env.fake.set({ containers: next.containers });
        await drive(env, 'database.docker.repair', {}, { auth: BRIDGE });
        const state = env.fake.state();
        expect(JSON.stringify({ c: state.containers['their-pg16'], v: state.volumes['their-pg16-data'], n: state.networks['their-net'] })).toBe(before);
        for (const call of env.fake.mutations()) {
            expect(call.args.join(' ')).not.toMatch(/their-pg16|their-net/);
        }
        expect(env.fake.argvText()).not.toMatch(/their-pg16-data/);
    }, 180000);
});

/* ================================================== interrupted creation, resume */

describe('an interrupted creation', () => {
    test('is recorded, reported as a resume and cleaned from our own labelled resources before the container is created again', async () => {
        const env = await setup({ docker: { interruptAfterRun: true }, workers: false });
        const failure = await provision(env).catch(error => error);
        expect(failure.code).toBe('CONTAINER_CREATE_FAILED');
        const recorded = dockerState.read(env.settings.storeDir).doc;
        expect(recorded).toBeTruthy();
        expect(dockerState.rank(recorded.step)).toBeGreaterThanOrEqual(dockerState.rank('volume'));
        expect(dockerState.rank(recorded.step)).toBeLessThan(dockerState.rank('verified'));

        env.fake.set({ interruptAfterRun: false, failRun: false });
        const dry = await provision(env, {}, { apply: false });
        expect(dry.planned.plan.mode).toBe('recreate');
        expect(dry.planned.plan.findings.map(item => item.code)).toContain('RESUME_RECREATE');
        const { applied } = await provision(env);
        expect(applied.operation.status).toBe('applied');
        expect(dockerState.read(env.settings.storeDir).doc.step).toBe('verified');
        expect(Object.keys(env.fake.state().containers)).toEqual([env.names().container]);
        expect(env.fake.argvText()).not.toMatch(/prune|--all/);
    }, 180000);

    test('a container that never becomes healthy fails the wait, leaves the record at its step and does not provision a role', async () => {
        const env = await setup({ docker: { neverHealthy: true }, dockerDeps: { waitMs: 60, pollMs: 5 }, workers: false });
        const failure = await provision(env).catch(error => error);
        expect(failure.code).toMatch(/DATABASE_NOT_READY|CONTAINER_UNHEALTHY|HEALTH_TIMEOUT|DOCKER_/);
        expect(env.server.provisioned).toEqual([]);
        expect(env.overlay().values.GOOBSTER_DOCKER_DB_URL).toBeUndefined();
        expect(dockerState.rank(dockerState.read(env.settings.storeDir).doc.step)).toBeLessThan(dockerState.rank('healthy'));
    }, 60000);

    test('a container that exits at start is reported and nothing is connected', async () => {
        const env = await setup({ docker: { exitOnStart: true }, dockerDeps: { waitMs: 60, pollMs: 5 }, workers: false });
        const failure = await provision(env).catch(error => error);
        expect(failure.code).toBeTruthy();
        expect(env.installation().database.engine).toBe('sqlite');
        expect(env.server.provisioned).toEqual([]);
    }, 60000);

    test('a host directory that the interrupted setup initialised is refused rather than adopted, since its superuser password was never saved', async () => {
        const env = await setup({ docker: { interruptAfterRun: true }, workers: false });
        const dir = path.join(scratch('half'), 'data');
        await provision(env, { storage: { kind: 'path', path: dir } }).catch(() => null);
        expect(Object.keys(env.fake.state().containers)).toEqual([env.names().container]);
        fs.mkdirSync(path.join(dir, 'pgdata'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'pgdata', 'PG_VERSION'), '17\n');
        env.fake.set({ interruptAfterRun: false });
        const dry = await provision(env, { storage: { kind: 'path', path: dir } }, { apply: false });
        expect(dry.planned.plan.ok).toBe(false);
        expect(dry.planned.plan.findings.map(item => item.code)).toEqual(expect.arrayContaining(['STORAGE_INITIALISED', 'STORAGE_HAS_DATA']));
        env.fake.clearCalls();
        expect(await codeOf(provision(env, { storage: { kind: 'path', path: dir } }))).toBe('PREFLIGHT_FAILED');
        expect(env.fake.mutations()).toEqual([]);
        expect(fs.existsSync(path.join(dir, 'pgdata', 'PG_VERSION'))).toBe(true);
    }, 120000);

    test('a host directory with no database in it resumes: only our own half-created container is replaced', async () => {
        const env = await setup({ docker: { interruptAfterRun: true }, workers: false });
        const dir = path.join(scratch('half-empty'), 'data');
        await provision(env, { storage: { kind: 'path', path: dir } }).catch(() => null);
        env.fake.set({ interruptAfterRun: false });
        const dry = await provision(env, { storage: { kind: 'path', path: dir } }, { apply: false });
        expect(dry.planned.plan.mode).toBe('recreate');
        expect(dry.planned.plan.ok).toBe(true);
        const { applied } = await provision(env, { storage: { kind: 'path', path: dir } });
        expect(applied.operation.status).toBe('applied');
        expect(dockerState.read(env.settings.storeDir).doc.step).toBe('verified');
        expect(fs.existsSync(dir)).toBe(true);
    }, 120000);
});

/* ============================================================ start, stop, repair */

describe('start, stop and repair', () => {
    test('stop and start act on the one container; a stop while the installation uses it needs acknowledgeInUse', async () => {
        const env = await setup();
        await provision(env);
        const names = env.names();
        const stopped = await drive(env, 'database.docker.stop', {}, { auth: BRIDGE });
        expect(stopped.applied.result).toMatchObject({ stopped: true });
        expect(env.fake.state().containers[names.container].running).toBe(false);
        const started = await drive(env, 'database.docker.start', {}, { auth: BRIDGE });
        expect(started.applied.result).toMatchObject({ running: true });
        expect(env.fake.state().containers[names.container].running).toBe(true);

        await drive(env, 'database.connect', { connection: { owned: 'docker' }, release: true }, { auth: BRIDGE });
        const refused = await drive(env, 'database.docker.stop', {}, { auth: BRIDGE }).catch(error => error);
        expect(refused.code).toBe('PREFLIGHT_FAILED');
        expect(refused.details.findings.map(item => item.code)).toContain('DATABASE_IN_USE');
        expect(env.fake.state().containers[names.container].running).toBe(true);
        const acknowledged = await drive(env, 'database.docker.stop', { acknowledgeInUse: true }, { auth: BRIDGE });
        expect(acknowledged.applied.operation.status).toBe('applied');
        for (const call of env.fake.mutations().filter(item => ['stop', 'start'].includes(item.args[0]))) expect(call.args[call.args.length - 1]).toBe(names.container);
    }, 180000);

    test('start, stop and repair without a record say there is nothing to manage', async () => {
        const env = await setup({ workers: false });
        for (const kind of ['database.docker.start', 'database.docker.stop', 'database.docker.repair']) {
            const failure = await drive(env, kind, {}, { auth: BRIDGE }).catch(error => error);
            expect(failure.code).toMatch(/NO_DOCKER_DATABASE|PREFLIGHT_FAILED/);
        }
        expect(env.fake.mutations()).toEqual([]);
    }, 60000);

    test('repair recreates a missing container over the SAME volume, with the same pinned image, and never recreates the data', async () => {
        const env = await setup();
        await provision(env);
        const names = env.names();
        const world = env.fake.state();
        const volumeBefore = JSON.stringify(world.volumes[names.volume]);
        delete world.containers[names.container];
        env.fake.set({ containers: world.containers });
        env.fake.clearCalls();

        const dry = await drive(env, 'database.docker.repair', {}, { auth: BRIDGE, apply: false });
        expect(dry.planned.plan).toMatchObject({ action: 'recreate', storageKept: true, ok: true });
        expect(dry.planned.plan.reasons).toContain('MISSING');
        const { applied } = await drive(env, 'database.docker.repair', {}, { auth: BRIDGE });
        expect(applied.operation.status).toBe('applied');
        const after = env.fake.state();
        expect(JSON.stringify(after.volumes[names.volume])).toBe(volumeBefore);
        expect(after.containers[names.container].mount.Name).toBe(names.volume);
        expect(env.fake.calls().filter(call => call.args[0] === 'volume' && call.args[1] === 'create')).toEqual([]);
        expect(env.fake.calls().filter(call => call.args[0] === 'volume' && call.args[1] === 'rm')).toEqual([]);
        const runs = runCalls(env.fake);
        expect(runs).toHaveLength(1);
        expect(runs[0].args[runs[0].args.length - 1]).toMatch(/^pgvector\/pgvector@sha256:[0-9a-f]{64}$/);
        expect(JSON.stringify(applied)).not.toContain(runs[0].env.POSTGRES_PASSWORD);
    }, 180000);

    test('repair refuses to start an empty database when the data volume is gone (DATA_MISSING), and a recorded major that no longer matches the pin is MAJOR_UPGRADE_IS_MANUAL', async () => {
        const env = await setup();
        await provision(env);
        const names = env.names();
        const world = env.fake.state();
        delete world.containers[names.container];
        delete world.volumes[names.volume];
        env.fake.set({ containers: world.containers, volumes: world.volumes });
        env.fake.clearCalls();
        const gone = await drive(env, 'database.docker.repair', {}, { auth: BRIDGE, apply: false });
        expect(gone.planned.plan.ok).toBe(false);
        expect(gone.planned.plan.blocks.map(item => item.code)).toContain('DATA_MISSING');
        expect(await codeOf(drive(env, 'database.docker.repair', {}, { auth: BRIDGE }))).toBe('PREFLIGHT_FAILED');
        expect(env.fake.mutations()).toEqual([]);

        dockerState.update(env.settings.storeDir, { image: { reference: 'pgvector/pgvector:pg16', major: 16, minor: 8 } });
        const major = await drive(env, 'database.docker.repair', {}, { auth: BRIDGE, apply: false });
        expect(major.planned.plan.blocks.map(item => item.code)).toContain('MAJOR_UPGRADE_IS_MANUAL');
    }, 180000);

    test('repair of a healthy running container does nothing', async () => {
        const env = await setup();
        await provision(env);
        env.fake.clearCalls();
        const { planned, applied } = await drive(env, 'database.docker.repair', {}, { auth: BRIDGE });
        expect(planned.plan.action).toBe('none');
        expect(applied.operation.status).toBe('applied');
        expect(env.fake.mutations()).toEqual([]);
    }, 180000);

    test('repair starts a stopped container instead of recreating it', async () => {
        const env = await setup();
        await provision(env);
        await drive(env, 'database.docker.stop', {}, { auth: BRIDGE });
        const { planned } = await drive(env, 'database.docker.repair', {}, { auth: BRIDGE });
        expect(planned.plan.action).toBe('start');
        expect(env.fake.state().containers[env.names().container].running).toBe(true);
    }, 180000);
});

/* =================================================================== reconfigure */

describe('database.docker.reconfigure', () => {
    const backupDouble = (calls = []) => ({
        createBackup: async (args) => { calls.push(args); return { dir: path.join(args.destDir, 'archive') }; },
        verifyBackup: () => ({ tables: 3, files: 2 }),
        tableCounts: async () => ({ users: 0 })
    });

    async function provisioned(extra = {}) {
        const calls = [];
        const env = await setup({ dockerDeps: { backupService: () => backupDouble(calls), ...extra } });
        await provision(env);
        await drive(env, 'database.connect', { connection: { owned: 'docker' }, release: true }, { auth: BRIDGE });
        return { env, calls };
    }

    test('the guards: a held maintenance barrier and a backup are required, and storage or major changes are refused', async () => {
        const { env } = await provisioned();
        const dest = scratch('backup');
        const input = { port: 5600, backup: { dir: dest, skipConfig: true } };
        expect(await codeOf(drive(env, 'database.docker.reconfigure', input, { auth: BRIDGE, apply: false }))).toBe('MAINTENANCE_REQUIRED');
        const held = (await env.manager.engine.run('maintenance.enter', { reason: 'docker database change', timeoutSeconds: 10 }, BRIDGE)).result;
        const maintenance = { operationId: held.operationId, fence: held.fence };
        expect(await codeOf(drive(env, 'database.docker.reconfigure', { port: 5600, maintenance }, { auth: BRIDGE, apply: false }))).toBe('BACKUP_REQUIRED');
        for (const [refused, code] of [[{ storage: { kind: 'volume' } }, 'STORAGE_MOVE_UNSUPPORTED'], [{ major: 18 }, 'MAJOR_UPGRADE_IS_MANUAL']]) {
            expect(await codeOf(drive(env, 'database.docker.reconfigure', { ...input, ...refused, maintenance }, { auth: BRIDGE, apply: false }))).toBe(code);
        }
        expect(await codeOf(drive(env, 'database.docker.reconfigure', { ...input, maintenance: { operationId: held.operationId, fence: held.fence + 9 } }, { auth: BRIDGE }))).toBe('MAINTENANCE_NOT_HELD');
    }, 180000);

    test('backs up first, recreates over the same storage, rewrites the loopback URL to the new port and leaves the barrier held', async () => {
        const order = [];
        const { env, calls } = await provisioned({ probeListen: async () => true });
        const names = env.names();
        const volumeBefore = JSON.stringify(env.fake.state().volumes[names.volume]);
        const held = (await env.manager.engine.run('maintenance.enter', { reason: 'docker database change', timeoutSeconds: 10 }, BRIDGE)).result;
        const maintenance = { operationId: held.operationId, fence: held.fence };
        env.fake.clearCalls();
        const dest = scratch('backup');
        const { planned, applied } = await drive(env, 'database.docker.reconfigure', { port: 5600, memoryMb: 1024, backup: { dir: dest, skipConfig: true }, maintenance }, { auth: BRIDGE });
        order.push(...stepNames(applied.operation));
        expect(order).toEqual(['preflight', 'backup', 'recreate', 'wait-healthy', 'update-url', 'verify']);
        expect(planned.plan).toMatchObject({ effect: 'reconfigure-docker-database', storageKept: true, from: { port: 5432 }, to: { port: 5600, memoryMb: 1024 } });
        expect(calls).toHaveLength(1);
        expect(calls[0].destDir).toBe(dest);
        const mutating = env.fake.calls().findIndex(call => ['run', 'rm'].includes(call.args[0]));
        expect(mutating).toBeGreaterThanOrEqual(0);
        expect(env.fake.state().containers[names.container]).toMatchObject({ port: 5600, memory: 1024 * 1024 * 1024 });
        expect(JSON.stringify(env.fake.state().volumes[names.volume])).toBe(volumeBefore);
        expect(new URL(env.overlay().values.GOOBSTER_DB_URL).port).toBe('5600');
        expect(applied.result).toMatchObject({ reconfigured: true, barrier: 'held' });
        expect(env.barrier()).toMatchObject({ active: true, operationId: held.operationId });
        const entry = env.manager.journal.readAudit().entries.find(item => item.action === 'manager.database.docker.reconfigure');
        expect(entry.detail).toMatchObject({ container: names.container, changed: 'port-memoryMb', backupVerified: true });
        expect(JSON.stringify(entry)).not.toMatch(/5600|postgres:\/\//);
    }, 180000);

    test('a backup that cannot be verified stops the change before the container is touched', async () => {
        const failing = { createBackup: async () => { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); }, verifyBackup: () => ({}), tableCounts: async () => ({}) };
        const { env } = await provisioned({ backupService: () => failing });
        const held = (await env.manager.engine.run('maintenance.enter', { reason: 'docker database change', timeoutSeconds: 10 }, BRIDGE)).result;
        env.fake.clearCalls();
        const failure = await drive(env, 'database.docker.reconfigure', { port: 5601, backup: { dir: scratch('backup'), skipConfig: true }, maintenance: { operationId: held.operationId, fence: held.fence } }, { auth: BRIDGE }).catch(error => error);
        expect(failure.code).toBe('BACKUP_FAILED');
        expect(env.fake.mutations()).toEqual([]);
        expect(env.fake.state().containers[env.names().container].port).toBe(5432);
    }, 180000);
});

/* ============================================================== install and uninstall */

describe('install.new with a Docker database answer', () => {
    async function fresh({ docker = {}, dockerDeps = {} } = {}) {
        const fake = fakeDocker.create(docker).install();
        cleanups.push(() => fake.restore());
        const server = scriptedServer();
        const calls = [];
        const root = scratch('dpi');
        const release = makeRelease(scratch('dpi-src'));
        const harness = await newHarness({
            root,
            installDeps: {
                initDatabase: async (args) => { calls.push({ ...args, overlay: environment.read(harness.settings.storeDir).values }); return { engine: args.database.engine, tables: 3 }; }
            }
        });
        harness.settings.databaseDeps = { ...server.deps };
        harness.settings.dockerDeps = { sleep: async () => {}, probeListen: async () => true, pgDump: PG17, waitMs: 2000, pollMs: 5, platform: 'linux', hostArch: 'x64', ...dockerDeps };
        return { harness, release, calls, fake, server };
    }
    const answer = release => ({ source: release.dir, release: { allowUnsigned: true }, database: { engine: 'postgres', docker: { pull: true } } });

    test('creates the owned instance, applies the schema to it, writes the connection at the cutover and stages nothing afterwards', async () => {
        const { harness, release, calls, fake, server } = await fresh();
        const { planned, applied } = await drive(harness, 'install.new', answer(release));
        expect(planned.plan.dockerDatabase).toMatchObject({ mode: 'fresh', names: { container: expect.stringMatching(/^goobster-pg-/) } });
        expect(planned.plan.databaseTarget).toBeUndefined();
        expect(applied.operation.status).toBe('applied');
        expect(applied.operation.steps.map(step => step.name)).toEqual(expect.arrayContaining(['docker-postgres', 'init-db']));
        expect(Object.keys(fake.state().containers)).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(calls[0].overlay.GOOBSTER_DB_URL).toBeUndefined();
        const overlay = environment.read(harness.settings.storeDir).values;
        expect(overlay.GOOBSTER_DB_URL).toMatch(/^postgres/);
        expect(overlay.GOOBSTER_DOCKER_DB_URL).toBeUndefined();
        expect(harness.manager.store.readInstallation().doc.database).toEqual({ engine: 'postgres', external: true });
        expect(dockerState.read(harness.settings.storeDir).doc.step).toBe('verified');
        const secret = server.provisioned[0].elevated.password;
        const application = server.provisioned[0].application.password;
        const published = journalText(harness) + JSON.stringify(planned) + JSON.stringify(applied) + fake.argvText();
        expect(published).not.toContain(secret);
        expect(published).not.toContain(application);
        expect(fake.calls().filter(call => call.args[0] === 'run')[0].env).toEqual({ POSTGRES_PASSWORD: secret });
    }, 180000);

    test('a daemon that cannot be reached blocks the preflight with the Docker finding, and nothing is written', async () => {
        const { harness, release, calls, fake } = await fresh({ docker: { mode: 'unreachable' } });
        const failure = await drive(harness, 'install.new', answer(release)).catch(error => error);
        expect(failure.code).toBe('PREFLIGHT_FAILED');
        expect(failure.details.findings.map(item => item.code)).toEqual(expect.arrayContaining([expect.stringMatching(/^DOCKER_/)]));
        expect(calls).toEqual([]);
        expect(fake.mutations()).toEqual([]);
        expect(environment.read(harness.settings.storeDir).present).toBe(false);
    }, 120000);

    test('a connection and a docker answer together are refused', async () => {
        const { harness, release } = await fresh();
        const input = { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'postgres', docker: {}, connection: { host: 'db.example.com', port: 5432, database: 'x', user: 'u', password: 'p', tls: { mode: 'require' } } } };
        expect(await codeOf(drive(harness, 'install.new', input, { apply: false }))).toBe('INVALID_INPUT');
    }, 60000);
});

describe('uninstall', () => {
    async function installed() {
        const fake = fakeDocker.create().install();
        cleanups.push(() => fake.restore());
        const server = scriptedServer();
        const root = scratch('dpu');
        const release = makeRelease(scratch('dpu-src'));
        const harness = await newHarness({ root, installDeps: { initDatabase: async (args) => ({ engine: args.database.engine, tables: 3 }) } });
        harness.settings.databaseDeps = { ...server.deps };
        harness.settings.dockerDeps = { sleep: async () => {}, probeListen: async () => true, pgDump: PG17, waitMs: 2000, pollMs: 5, platform: 'linux', hostArch: 'x64' };
        await drive(harness, 'install.new', { source: release.dir, release: { allowUnsigned: true }, database: { engine: 'postgres', docker: { pull: true } } });
        const doc = harness.manager.store.readInstallation().doc;
        fake.seedForeign({ container: 'their-pg16', volume: 'their-pg16-data', network: 'their-net', port: 5999 });
        return { harness, fake, doc, names: createDockerService({ settings: harness.settings }).resourceNames(doc.installationId) };
    }

    test('by default the container, volume and network are kept and nothing is removed from Docker', async () => {
        const { harness, fake, names } = await installed();
        fake.clearCalls();
        const { planned, applied } = await drive(harness, 'install.uninstall', {});
        expect(planned.plan.removeDockerData).toBe(false);
        expect(planned.plan.dockerDatabase).toMatchObject({ action: 'kept' });
        expect(applied.operation.status).toBe('applied');
        expect(fake.mutations()).toEqual([]);

        const state = fake.state();
        expect(Object.keys(state.containers)).toEqual(expect.arrayContaining([names.container, 'their-pg16']));
        expect(Object.keys(state.volumes)).toEqual(expect.arrayContaining([names.volume, 'their-pg16-data']));
        expect(Object.keys(state.networks)).toEqual(expect.arrayContaining([names.network, 'their-net']));
    }, 180000);

    test('a delete-data uninstall without removeDockerData warns that the volume and container stay', async () => {
        const { harness, doc, names } = await installed();
        const dry = await drive(harness, 'install.uninstall', { keepData: false, confirm: doc.installationId }, { apply: false });
        const warning = dry.planned.plan.preflight.findings.find(item => item.code === 'DOCKER_DATA_RETAINED');
        expect(warning).toMatchObject({ severity: 'warn' });
        expect(warning.detail).toContain(names.volume);
        expect(dry.planned.plan.preflight.ok).toBe(true);
        const kept = await drive(harness, 'install.uninstall', { keepData: true }, { apply: false });
        expect(kept.planned.plan.preflight.findings.some(item => item.code === 'DOCKER_DATA_RETAINED')).toBe(false);
    }, 180000);

    test('removeDockerData needs the installation id as confirmation and removes exactly our three resources', async () => {
        const { harness, fake, doc, names } = await installed();
        fake.clearCalls();
        expect(await codeOf(drive(harness, 'install.uninstall', { removeDockerData: true }))).toBe('CONFIRMATION_REQUIRED');
        expect(await codeOf(drive(harness, 'install.uninstall', { removeDockerData: true, confirm: 'nope' }))).toBe('CONFIRMATION_REQUIRED');
        expect(fake.mutations()).toEqual([]);
        const dry = await drive(harness, 'install.uninstall', { removeDockerData: true, confirm: doc.installationId }, { apply: false });
        expect(dry.planned.plan.dockerDatabase).toMatchObject({ action: 'remove', resources: [{ kind: 'container', name: names.container }, { kind: 'volume', name: names.volume }, { kind: 'network', name: names.network }] });
        const { applied } = await drive(harness, 'install.uninstall', { removeDockerData: true, confirm: doc.installationId });
        expect(applied.operation.status).toBe('applied');
        const state = fake.state();
        expect(Object.keys(state.containers)).toEqual(['their-pg16']);
        expect(Object.keys(state.volumes)).toEqual(['their-pg16-data']);
        expect(Object.keys(state.networks)).toEqual(['their-net']);
        for (const call of fake.mutations().filter(item => item.args[0] === 'rm' || item.args[1] === 'rm')) {
            expect([names.container, names.volume, names.network]).toContain(call.args[call.args.length - 1]);
        }
        expect(fake.argvText()).not.toMatch(/prune|--all|\s-a\s|--filter\s/);
        expect(dockerState.read(harness.settings.storeDir).present).toBe(false);
    }, 180000);

    test('a foreign resource under one of our names blocks removeDockerData instead of being removed', async () => {
        const { harness, fake, doc, names } = await installed();
        const world = fake.state();
        world.volumes[names.volume] = { labels: {} };
        fake.set({ volumes: world.volumes });
        fake.clearCalls();
        const failure = await drive(harness, 'install.uninstall', { removeDockerData: true, confirm: doc.installationId }).catch(error => error);
        expect(failure.code).toBe('PREFLIGHT_FAILED');
        expect(fake.state().volumes[names.volume]).toEqual({ labels: {} });
        expect(fake.mutations()).toEqual([]);
    }, 180000);
});

/* =============================================================== readiness gate */

describe('the readiness gate', () => {
    test('is inert without a record, and when the installation is not connected to the owned port', async () => {
        const env = await setup({ workers: false });
        const readiness = createReadiness({ settings: env.settings });
        expect(await readiness.check()).toMatchObject({ owned: false });
        env.fake.clearCalls();
        await readiness.check();
        expect(env.fake.calls()).toEqual([]);
        await provision(env);
        env.fake.clearCalls();
        expect((await createReadiness({ settings: env.settings }).check()).owned).toBe(false);
        expect(env.fake.calls()).toEqual([]);
    }, 120000);

    test('answers DATABASE_NOT_READY with the reason while the owned container is stopped, starting or missing, and ready when healthy', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        await drive(env, 'database.connect', { connection: { owned: 'docker' }, release: true }, { auth: BRIDGE });
        const names = env.names();
        const readiness = () => createReadiness({ settings: env.settings, now: () => new Date() });
        expect(await readiness().check()).toMatchObject({ owned: true, ready: true });

        const world = env.fake.state();
        world.containers[names.container].health = 'starting';
        delete world.containers[names.container].countdown;
        env.fake.set({ containers: world.containers, healthAfter: 9999 });
        expect(await readiness().check()).toMatchObject({ owned: true, ready: false, code: 'DATABASE_NOT_READY', reason: 'STARTING' });

        world.containers[names.container].running = false;
        world.containers[names.container].status = 'exited';
        env.fake.set({ containers: world.containers });
        expect(await readiness().check()).toMatchObject({ ready: false, code: 'DATABASE_NOT_READY', reason: 'CONTAINER_STOPPED' });

        delete world.containers[names.container];
        env.fake.set({ containers: world.containers });
        expect(await readiness().check()).toMatchObject({ ready: false, reason: 'CONTAINER_MISSING' });
    }, 180000);

    test('the supervisor holds a worker back with DATABASE_NOT_READY while the container is starting, then launches it', async () => {
        const env = await setup({ workers: false });
        await provision(env);
        await drive(env, 'database.connect', { connection: { owned: 'docker' }, release: true }, { auth: BRIDGE });
        const names = env.names();
        const world = env.fake.state();
        world.containers[names.container].health = 'starting';
        delete world.containers[names.container].countdown;
        env.fake.set({ containers: world.containers, healthAfter: 9999 });

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
        expect(gate).toContain('STARTING');
        const status = await supervisor.status();
        expect(JSON.stringify(status)).toContain('DATABASE_NOT_READY');
        expect(fakes.alive()).toHaveLength(0);
    }, 120000);
});

/* ==================================================================== discovery */

describe('discovery', () => {
    test('recognises the owned container by its labels, stopped or running, and ignores everything else', async () => {
        const env = await setup({ workers: false });
        env.fake.seedForeign({ container: 'their-pg16', volume: 'their-pg16-data', port: 5999 });
        await provision(env);
        const read = (name) => {
            if (name !== 'docker-owned-databases') return null;
            return childProcess.spawnSync(env.fake.bin, ['ps', '--all', '--filter', 'label=io.goobster.manager=1', '--filter', 'label=io.goobster.role=postgres', '--format', '{{json .}}'], { encoding: 'utf8', env: { ...process.env, ...env.fake.env() } }).stdout;
        };
        const found = discover({ fs, home: env.root, env: env.settings.env, exec: read });
        expect(found.dockerDatabases).toEqual([{ container: env.names().container, installationId: env.installation().installationId, state: 'running' }]);
        await drive(env, 'database.docker.stop', {}, { auth: BRIDGE });
        expect(discover({ fs, home: env.root, env: env.settings.env, exec: read }).dockerDatabases[0].state).toBe('exited');
        expect(JSON.stringify(found)).not.toMatch(/password|postgres:\/\//);
        expect(discover({ fs, home: env.root, env: env.settings.env, exec: () => null }).dockerDatabases).toEqual([]);
    }, 120000);
});

/* ========================================================== real Docker (gated) */

const realDocker = process.env.GOOBSTER_DOCKER_TESTS === '1' ? describe : describe.skip;

realDocker('a real Docker daemon and a real pgvector container (GOOBSTER_DOCKER_TESTS=1)', () => {
    const { execFileSync } = childProcess;
    const { Client } = require('pg');
    const { freePort } = require('./helpers/installFixture');
    const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' });
    const unrelated = `unrelated-pg16-${process.pid}`;
    const unrelatedVolume = `${unrelated}-data`;
    const blocker = `port-blocker-${process.pid}`;

    beforeAll(() => {
        docker('volume', 'create', unrelatedVolume);
        docker('run', '-d', '--name', unrelated, '-e', 'POSTGRES_PASSWORD=unrelated-pw', '-v', `${unrelatedVolume}:/var/lib/postgresql/data`, 'postgres:16');
    }, 300000);

    afterAll(() => {
        for (const args of [['rm', '-f', unrelated], ['rm', '-f', blocker], ['volume', 'rm', unrelatedVolume]]) {
            try { docker(...args); } catch { /* already gone */ }
        }
    }, 120000);

    /** Whatever the body leaves behind on the daemon goes, even when an expectation fails half way. */
    const retireAfter = env => cleanups.push(async () => {
        try { await createDockerService({ settings: env.settings }).retire({ installationId: env.installation().installationId, remove: true }); } catch { /* already gone */ }
    });

    const query = async (env, text) => {
        const client = new Client({ connectionString: env.overlay().values.GOOBSTER_DOCKER_DB_URL || env.overlay().values.GOOBSTER_DB_URL });
        await client.connect();
        try { return (await client.query(text)).rows; } finally { await client.end(); }
    };

    test('provision, restart persistence, a custom host path, a port conflict, an unavailable daemon, an interrupted setup and repair; the unrelated postgres:16 container and its volume survive everything', async () => {
        const port = await freePort();
        const env = await setup({ real: true, workers: false });
        retireAfter(env);
        const { applied } = await provision(env, { port });
        expect(applied.operation.status).toBe('applied');
        const names = env.names();

        await query(env, 'CREATE TABLE persisted (id int primary key); INSERT INTO persisted VALUES (7)');
        await drive(env, 'database.docker.stop', {}, { auth: BRIDGE });
        await drive(env, 'database.docker.start', {}, { auth: BRIDGE });
        expect(await query(env, 'SELECT id FROM persisted')).toEqual([{ id: 7 }]);

        docker('rm', '-f', names.container);
        const repaired = await drive(env, 'database.docker.repair', {}, { auth: BRIDGE });
        expect(repaired.planned.plan.action).toBe('recreate');
        expect(await query(env, 'SELECT id FROM persisted')).toEqual([{ id: 7 }]);

        const busy = await freePort();
        docker('run', '-d', '--name', blocker, '-p', `127.0.0.1:${busy}:5432`, '-e', 'POSTGRES_PASSWORD=x', 'postgres:16');
        const conflict = await drive(env, 'database.docker.provision', { port: busy, pull: true }, { auth: BRIDGE, apply: false }).catch(error => error);
        expect(JSON.stringify(conflict)).toMatch(/PORT_IN_USE|ALREADY_PROVISIONED/);
        docker('rm', '-f', blocker);

        const status = await createDockerService({ settings: env.settings }).check({});
        expect(status.daemon.reachable).toBe(true);
        const saved = process.env.DOCKER_HOST;
        process.env.DOCKER_HOST = 'unix:///nonexistent/docker.sock';
        try {
            const down = await createDockerService({ settings: env.settings }).check({});
            expect(down.verdict.blocks.length).toBeGreaterThan(0);
        } finally {
            if (saved === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = saved;
        }

        expect(docker('inspect', '--format', '{{.State.Running}}', unrelated).trim()).toBe('true');
        expect(docker('volume', 'inspect', '--format', '{{.Name}}', unrelatedVolume).trim()).toBe(unrelatedVolume);

        const { applied: removed } = await drive(env, 'install.uninstall', { removeDockerData: true, confirm: env.installation().installationId }, { auth: BRIDGE }).catch(error => ({ applied: error }));
        expect(removed).toBeDefined();
        expect(docker('inspect', '--format', '{{.State.Running}}', unrelated).trim()).toBe('true');
    }, 900000);

    test('a custom host directory holds the data', async () => {
        const port = await freePort();
        const env = await setup({ real: true, workers: false });
        retireAfter(env);
        const dir = path.join(scratch('real-path'), 'pg');
        // The cluster directory belongs to the container's postgres account (0700): this process, when it
        // is not root, can stat it but not enter or delete it. The contents are read through the container
        // and the directory is scrubbed through a throwaway one afterwards.
        cleanups.push(async () => {
            try { docker('run', '--rm', '-v', `${dir}:/scrub`, 'postgres:16', 'rm', '-rf', '/scrub/pgdata'); } catch { /* nothing was created */ }
        });
        const pgdata = () => { try { return fs.statSync(path.join(dir, 'pgdata')); } catch { return null; } };
        const { applied } = await provision(env, { port, storage: { kind: 'path', path: dir } });
        expect(applied.operation.status).toBe('applied');
        expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
        expect(pgdata()).not.toBeNull();
        expect(pgdata().isDirectory()).toBe(true);
        expect(docker('exec', env.names().container, 'cat', '/var/lib/postgresql/data/pgdata/PG_VERSION').trim()).toBe('17');
        expect(await query(env, 'SELECT 1 AS one')).toEqual([{ one: 1 }]);
        expect(docker('inspect', '--format', '{{.State.Running}}', unrelated).trim()).toBe('true');
        const before = pgdata();
        await createDockerService({ settings: env.settings }).retire({ installationId: env.installation().installationId, remove: true });
        const after = pgdata();
        expect(after).not.toBeNull();
        expect(after.ino).toBe(before.ino);
        expect(after.uid).toBe(before.uid);
    }, 900000);

    test('an interrupted setup over a volume is resumed: the half-made container and volume are ours and are replaced', async () => {
        const port = await freePort();
        const env = await setup({ real: true, workers: false });
        retireAfter(env);
        const svc = createDockerService({ settings: env.settings });
        const request = require('@goobster/manager/docker/service').parseRequest({ port, pull: true });
        const id = env.installation().installationId;
        svc.startRecord(id, request, 'interrupted');
        await svc.createResources({ installationId: id, request, superuserPassword: 'interrupted-setup-password-0001', operationId: 'interrupted' });
        const { applied } = await provision(env, { port });
        expect(applied.operation.status).toBe('applied');
        expect(await query(env, 'SELECT 1 AS one')).toEqual([{ one: 1 }]);
        expect(docker('inspect', '--format', '{{.State.Running}}', unrelated).trim()).toBe('true');
        await svc.retire({ installationId: id, remove: true });
    }, 900000);
});
