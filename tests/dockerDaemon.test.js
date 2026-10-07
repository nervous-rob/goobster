/**
 * The Docker daemon check, the image pin, the resource naming and the container
 * management in core (`packages/core/db/docker`, documentation/docker_postgres.md).
 * Every call goes to a fake `docker` executable on a private PATH
 * (tests/helpers/fakeDocker.js): no daemon exists in the test VM, and nothing
 * here may need one.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fakeDocker = require('./helpers/fakeDocker');
const lib = require('@goobster/core/db/docker');
const { image, names } = lib;

const INSTALLATION = '3f2b9c1e-7a44-4d0e-9a55-0123456789ab';
const OTHER = '9a8b7c6d-1111-4222-8333-444455556666';
const PG17 = async () => ({ present: true, text: 'pg_dump (PostgreSQL) 17.2' });

const cleanups = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()();
});

function world(options = {}) {
    const fake = fakeDocker.create(options);
    cleanups.push(() => fs.rmSync(fake.dir, { recursive: true, force: true }));
    const env = { ...process.env, ...fake.env() };
    const docker = lib.createRunner({ env });
    return { fake, env, docker };
}

const check = (w, options = {}) => lib.checkDaemon({ docker: w.docker, env: w.env, platform: 'linux', pgDump: PG17, hostArch: 'x64', ...options });
const codes = (items) => items.map(item => item.code);

describe('the image pin', () => {
    test('is by digest, with the tag beside it, in the one file that holds it', () => {
        expect(image.DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(image.TAG).toBe('pg17');
        expect(image.REFERENCE).toBe(`pgvector/pgvector@${image.DIGEST}`);
        expect(image.HUMAN_REFERENCE).toBe('pgvector/pgvector:pg17');
        const source = fs.readFileSync(path.join(__dirname, '..', 'packages', 'core', 'db', 'docker', 'image.js'), 'utf8');
        expect(source).toContain(image.DIGEST);
        expect(source).toContain("'pgvector/pgvector'");
        expect(source).toContain("'pg17'");
        const others = fs.readdirSync(path.join(__dirname, '..', 'packages', 'core', 'db', 'docker')).filter(name => name !== 'image.js');
        for (const file of others) expect(fs.readFileSync(path.join(__dirname, '..', 'packages', 'core', 'db', 'docker', file), 'utf8')).not.toContain(image.DIGEST);
    });

    test('carries the extensions Goobster needs and a server above its floor', () => {
        const table = image.compatibilityTable();
        expect(table.serverMeetsGoobster).toBe(true);
        expect(table.serverMajor).toBe(17);
        expect(table.extensions.map(item => [item.name, item.inImage])).toEqual(expect.arrayContaining([['vector', true], ['citext', true]]));
    });

    test('a major change is never an update', () => {
        expect(image.planMajorChange({ currentMajor: 16 })).toMatchObject({ ok: false, code: 'MAJOR_UPGRADE_IS_MANUAL', from: 16, to: 17 });
        expect(image.planMajorChange({ currentMajor: 17 })).toEqual({ ok: true });
        expect(image.planMajorChange({ currentMajor: 16 }).message).toContain('postgres_setup.md');
    });

    test('backup tools: an older client is a named mismatch with the remedy, a missing one is named, a newer one passes', () => {
        expect(image.backupCompatibility(15)).toMatchObject({ code: 'BACKUP_TOOLS_MISMATCH', ok: false });
        expect(image.backupCompatibility(15).remedy).toContain('postgresql-client-17');
        expect(image.backupCompatibility(null)).toMatchObject({ code: 'BACKUP_TOOLS_MISSING', ok: false });
        expect(image.backupCompatibility(17).ok).toBe(true);
        expect(image.backupCompatibility(18).ok).toBe(true);
        expect(image.parseClientMajor('pg_dump (PostgreSQL) 16.4 (Ubuntu 16.4-0ubuntu0.24.04.2)')).toBe(16);
    });

    test('knows its platforms', () => {
        expect(image.platformOf('x86_64')).toMatchObject({ platform: 'linux/amd64' });
        expect(image.platformOf('aarch64')).toMatchObject({ platform: 'linux/arm64' });
        expect(image.platformOf('armv7l')).toBeNull();
        expect(image.platformOf('x86_64', 'windows')).toBeNull();
    });
});

describe('resource naming and ownership', () => {
    test('every name carries the first eight digits of the installation id, and every label the whole id', () => {
        const resources = names.resourcesFor(INSTALLATION);
        expect(resources.container.name).toBe('goobster-pg-3f2b9c1e');
        expect(resources.volume.name).toBe('goobster-pgdata-3f2b9c1e');
        expect(resources.network.name).toBe('goobster-3f2b9c1e');
        for (const kind of ['container', 'volume', 'network']) {
            expect(resources[kind].labels['io.goobster.installation']).toBe(INSTALLATION);
            expect(resources[kind].labels['io.goobster.manager']).toBe('1');
        }
        expect(resources.container.labels['io.goobster.role']).toBe('postgres');
        expect(() => names.resourcesFor('not-a-uuid')).toThrow(/UUID/);
        expect(names.isOwnName('goobster-pg-3f2b9c1e')).toBe(true);
        expect(names.isOwnName('postgres')).toBe(false);
    });

    test('a resource without our labels, or with another installation\'s, is foreign', () => {
        const resources = names.resourcesFor(INSTALLATION);
        expect(names.assertOwned(resources.volume, resources.volume.labels, { installationId: INSTALLATION })).toBe(true);
        expect(() => names.assertOwned(resources.volume, {}, { installationId: INSTALLATION })).toThrow(expect.objectContaining({ code: 'RESOURCE_FOREIGN' }));
        expect(() => names.assertOwned(resources.volume, names.resourcesFor(OTHER).volume.labels, { installationId: INSTALLATION })).toThrow(expect.objectContaining({ code: 'RESOURCE_FOREIGN' }));
        expect(() => names.assertOwned(resources.volume, { ...resources.volume.labels, 'io.goobster.role': 'postgres' }, { installationId: INSTALLATION })).toThrow(expect.objectContaining({ code: 'RESOURCE_FOREIGN' }));
    });
});

describe('the runner refuses what could reach somebody else\'s resources', () => {
    test.each([
        [['system', 'prune', '-f']],
        [['volume', 'prune']],
        [['network', 'prune']],
        [['container', 'prune']],
        [['image', 'prune', '--all']],
        [['rm', '--all']],
        [['rm', '-a']],
        [['stop', '--filter', 'name=x']],
        [['container', 'rm', '--filter=label=a']]
    ])('docker %j is never run', (args) => {
        const { docker, fake } = world();
        expect(() => docker.run(args)).toThrow(expect.objectContaining({ code: 'FORBIDDEN_COMMAND' }));
        expect(fake.calls()).toEqual([]);
    });

    test('listing verbs may filter, and rm -f names its target', async () => {
        const { docker, fake } = world();
        fake.seedForeign({ container: 'goobster-pg-3f2b9c1e' });
        expect((await docker.run(['ps', '--all', '--filter', 'label=a=b'])).code).toBe(0);
        expect((await docker.run(['rm', '-f', 'goobster-pg-3f2b9c1e'])).code).toBe(0);
    });
});

describe('the daemon check', () => {
    test('a healthy Engine: CLI version, daemon, platform, image, backup tools and free space, with no block', async () => {
        const w = world();
        const report = await check(w, { storagePath: os.tmpdir(), requiredBytes: 1024 });
        expect(report.cli).toEqual({ present: true, version: '27.3.1' });
        expect(report.daemon).toMatchObject({ reachable: true, flavor: 'engine', rootless: false, serverVersion: '27.3.1' });
        expect(report.platform).toMatchObject({ supported: true, platform: 'linux/amd64' });
        expect(report.image).toMatchObject({ pulled: true, reference: image.REFERENCE, humanReference: image.HUMAN_REFERENCE, postgresMajor: 17 });
        expect(report.backupTools).toMatchObject({ code: 'BACKUP_TOOLS_OK', ok: true });
        expect(report.storage.freeBytes).toBeGreaterThan(1024);
        expect(report.verdict).toMatchObject({ ok: true, blocks: [], next: 'configure' });
        expect(report.compatibility.serverMeetsGoobster).toBe(true);
    });

    test('never pulls, creates or starts anything: only version, info and an image inspect', async () => {
        const w = world({ imagePulled: false });
        const report = await check(w);
        expect(report.image.pulled).toBe(false);
        expect(report.verdict.ok).toBe(true);
        expect(codes(report.verdict.notes)).toContain('IMAGE_NOT_PULLED');
        expect(w.fake.mutations()).toEqual([]);
        expect(w.fake.calls().map(call => call.args.slice(0, 2).join(' '))).toEqual(['version --format', 'info --format', 'image inspect']);
    });

    test('the CLI is missing: a named block with its remedy and nothing else asked', async () => {
        const w = world();
        const docker = lib.createRunner({ bin: path.join(w.fake.dir, 'no-such-docker'), env: w.env });
        const report = await lib.checkDaemon({ docker, env: w.env, platform: 'linux', pgDump: PG17, hostArch: 'x64' });
        expect(codes(report.verdict.blocks)).toEqual(['DOCKER_CLI_MISSING']);
        expect(report.verdict.blocks[0].remedy).toContain('does not install Docker');
        expect(report.cli.present).toBe(false);
    });

    test('an unreachable daemon: block, remedy, and Docker Desktop is never launched', async () => {
        const w = world({ mode: 'unreachable' });
        const report = await check(w);
        expect(codes(report.verdict.blocks)).toEqual(['DOCKER_DAEMON_UNREACHABLE']);
        expect(report.verdict.blocks[0].remedy).toContain('never starts Docker Desktop');
        expect(report.daemon.reachable).toBe(false);
        expect(w.fake.mutations()).toEqual([]);
    });

    test('permission denied: the remedy names the docker group and rootless Docker, never sudo', async () => {
        const w = world({ mode: 'permission' });
        const report = await check(w);
        expect(codes(report.verdict.blocks)).toEqual(['DOCKER_PERMISSION_DENIED']);
        const remedy = report.verdict.blocks[0].remedy;
        expect(remedy).toContain('"docker" group');
        expect(remedy).toContain('rootless');
        expect(remedy).toMatch(/not run the manager with sudo/i);
    });

    test('a socket path that points nowhere is reported with its path and as unreachable', async () => {
        const w = world({ mode: 'unreachable' });
        const env = { ...w.env, DOCKER_HOST: 'unix:///nonexistent/docker.sock' };
        const report = await lib.checkDaemon({ docker: lib.createRunner({ env }), env, platform: 'linux', pgDump: PG17, hostArch: 'x64' });
        expect(report.daemon.socket).toEqual({ path: '/nonexistent/docker.sock', exists: false, usable: false });
        expect(report.verdict.blocks[0].code).toBe('DOCKER_DAEMON_UNREACHABLE');
    });

    test('a daemon on another machine cannot hold the database', async () => {
        const w = world();
        const env = { ...w.env, DOCKER_HOST: 'tcp://10.0.0.5:2375' };
        const report = await lib.checkDaemon({ docker: lib.createRunner({ env }), env, platform: 'linux', pgDump: PG17, hostArch: 'x64' });
        expect(codes(report.verdict.blocks)).toEqual(['DOCKER_HOST_REMOTE']);
    });

    test('Docker Desktop is detected and its host-path semantics are said', async () => {
        const report = await check(world({ mode: 'desktop' }), { platform: 'darwin' });
        expect(report.daemon.flavor).toBe('desktop');
        expect(report.verdict.ok).toBe(true);
        const note = report.verdict.notes.find(item => item.code === 'DOCKER_DESKTOP');
        expect(note.remedy).toContain('virtual machine');
        expect(note.remedy).toContain('file sharing');
    });

    test('arm64 is supported; an unknown architecture and Windows containers are not', async () => {
        const arm = await check(world({ mode: 'arm' }));
        expect(arm.platform).toMatchObject({ supported: true, platform: 'linux/arm64' });
        expect(arm.verdict.ok).toBe(true);
        const odd = await check(world({ mode: 'unsupported-arch' }));
        expect(codes(odd.verdict.blocks)).toContain('ARCH_UNSUPPORTED');
        expect(odd.platform.supported).toBe(false);
        const windows = await check(world({ mode: 'windows' }));
        expect(codes(windows.verdict.blocks)).toContain('CONTAINER_OS_UNSUPPORTED');
    });

    test('an unknown host OS is unsupported, a rootless daemon is a note, an old Engine is a block', async () => {
        expect(codes((await check(world(), { platform: 'freebsd' })).verdict.blocks)).toContain('OS_UNSUPPORTED');
        const rootless = await check(world({ mode: 'rootless' }));
        expect(rootless.daemon.rootless).toBe(true);
        expect(codes(rootless.verdict.notes)).toContain('DOCKER_ROOTLESS');
        expect(codes((await check(world({ mode: 'old' }))).verdict.blocks)).toContain('DOCKER_ENGINE_TOO_OLD');
    });

    test('host pg_dump: older is BACKUP_TOOLS_MISMATCH (named, with the remedy), missing is BACKUP_TOOLS_MISSING, never a silent pass', async () => {
        const old = await check(world(), { pgDump: async () => ({ present: true, text: 'pg_dump (PostgreSQL) 15.8' }) });
        expect(old.backupTools).toMatchObject({ code: 'BACKUP_TOOLS_MISMATCH', ok: false, clientMajor: 15 });
        expect(codes(old.verdict.warnings)).toEqual(['BACKUP_TOOLS_MISMATCH']);
        expect(old.verdict.warnings[0].remedy).toContain('postgresql-client-17');
        const none = await check(world(), { pgDump: async () => ({ present: false, text: '' }) });
        expect(codes(none.verdict.warnings)).toEqual(['BACKUP_TOOLS_MISSING']);
        const newer = await check(world(), { pgDump: async () => ({ present: true, text: 'pg_dump (PostgreSQL) 18.0' }) });
        expect(newer.verdict.warnings).toEqual([]);
    });

    test('free space is read under the chosen path (or its nearest existing parent) and too little blocks', async () => {
        const w = world();
        const deep = path.join(os.tmpdir(), `goobster-docker-test-${process.pid}`, 'not', 'yet');
        const report = await check(w, { storagePath: deep, requiredBytes: Number.MAX_SAFE_INTEGER });
        expect(report.storage.freeBytes).toBeGreaterThan(0);
        expect(codes(report.verdict.blocks)).toContain('STORAGE_FULL');
        expect(fs.existsSync(deep)).toBe(false);
    });

    test('the report carries no environment value, credential or registry login', async () => {
        const w = world();
        const env = { ...w.env, DOCKER_HOST: 'unix:///var/run/docker.sock', REGISTRY_TOKEN: 'registry-token-never-printed' };
        const report = await lib.checkDaemon({ docker: lib.createRunner({ env }), env, platform: 'linux', pgDump: PG17, hostArch: 'x64' });
        expect(JSON.stringify(report)).not.toContain('registry-token-never-printed');
    });
});

describe('container management', () => {
    function containersOf(w, id = INSTALLATION, deps = {}) {
        return lib.createContainers({ docker: w.docker, installationId: id, deps: { sleep: async () => {}, probeListen: async () => true, ...deps } });
    }

    test('docker run: exact names, our labels, loopback publish, restart policy, health check, the pinned digest; the password only in the child environment', async () => {
        const w = world();
        const c = containersOf(w);
        await c.ensureNetwork();
        await c.ensureVolume();
        await c.createContainer({ port: 5433, bind: '127.0.0.1', storage: { kind: 'volume' }, memoryMb: 512, superuserPassword: 'su-secret-0123456789abcdef' });
        const run = w.fake.calls().find(call => call.args[0] === 'run');
        const text = run.args.join(' ');
        expect(text).toContain('--name goobster-pg-3f2b9c1e');
        expect(text).toContain('--label io.goobster.installation=3f2b9c1e-7a44-4d0e-9a55-0123456789ab');
        expect(text).toContain('--label io.goobster.manager=1');
        expect(text).toContain('--label io.goobster.role=postgres');
        expect(text).toContain('--restart unless-stopped');
        expect(text).toContain('--health-cmd pg_isready');
        expect(text).toContain('-p 127.0.0.1:5433:5432');
        expect(text).toContain('-v goobster-pgdata-3f2b9c1e:/var/lib/postgresql/data');
        expect(text).toContain('--memory 512m');
        expect(run.args[run.args.length - 1]).toBe(image.REFERENCE);
        expect(text).not.toContain('su-secret');
        expect(run.args).toContain('POSTGRES_PASSWORD');
        expect(run.env).toEqual({ POSTGRES_PASSWORD: 'su-secret-0123456789abcdef' });
        expect(w.fake.argvText()).not.toContain('su-secret');
    });

    test('a host path is mounted as given', async () => {
        const w = world();
        await containersOf(w).createContainer({ port: 5432, bind: '127.0.0.1', storage: { kind: 'path', path: '/srv/pgdata' }, superuserPassword: 'su-secret-0123456789abcdef' });
        expect(w.fake.argvText()).toContain('-v /srv/pgdata:/var/lib/postgresql/data');
        expect((await containersOf(w).container()).data).toMatchObject({ kind: 'path', source: '/srv/pgdata' });
    });

    test('a short password and a bad port are refused before docker is called', async () => {
        const w = world();
        await expect(containersOf(w).createContainer({ port: 5432, bind: '127.0.0.1', storage: { kind: 'volume' }, superuserPassword: 'short' })).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
        await expect(containersOf(w).createContainer({ port: 70000, bind: '127.0.0.1', storage: { kind: 'volume' }, superuserPassword: 'su-secret-0123456789abcdef' })).rejects.toMatchObject({ code: 'INVALID_PORT' });
        expect(w.fake.calls()).toEqual([]);
    });

    test('a foreign resource under our name is never touched: every mutation re-checks the labels', async () => {
        const w = world();
        w.fake.seedForeign({ container: 'goobster-pg-3f2b9c1e', volume: 'goobster-pgdata-3f2b9c1e', network: 'goobster-3f2b9c1e' });
        const c = containersOf(w);
        await expect(c.start()).rejects.toMatchObject({ code: 'RESOURCE_FOREIGN' });
        await expect(c.stop()).rejects.toMatchObject({ code: 'RESOURCE_FOREIGN' });
        await expect(c.removeContainer()).rejects.toMatchObject({ code: 'RESOURCE_FOREIGN' });
        await expect(c.removeVolume()).rejects.toMatchObject({ code: 'RESOURCE_FOREIGN' });
        await expect(c.removeNetwork()).rejects.toMatchObject({ code: 'RESOURCE_FOREIGN' });
        await expect(c.ensureVolume()).rejects.toMatchObject({ code: 'RESOURCE_FOREIGN' });
        expect(w.fake.mutations()).toEqual([]);
        expect(Object.keys(w.fake.state().containers)).toEqual(['goobster-pg-3f2b9c1e']);
    });

    test('another installation\'s resources are foreign too', async () => {
        const w = world();
        const mine = containersOf(w, OTHER);
        await mine.ensureNetwork();
        await mine.ensureVolume();
        const theirs = names.resourcesFor(OTHER);
        const asked = lib.createContainers({ docker: w.docker, installationId: INSTALLATION, deps: {} });
        expect(asked.resources.volume.name).not.toBe(theirs.volume.name);
        expect(await asked.container()).toMatchObject({ exists: false });
    });

    test('lifecycle: create, wait until healthy, stop, start, remove (by name, labels checked first)', async () => {
        const w = world({ healthAfter: 3 });
        const c = containersOf(w);
        await c.ensureNetwork();
        await c.ensureVolume();
        await c.createContainer({ port: 5432, bind: '127.0.0.1', storage: { kind: 'volume' }, superuserPassword: 'su-secret-0123456789abcdef' });
        expect(await c.waitHealthy({ pollMs: 1 })).toMatchObject({ health: 'healthy', running: true, port: 5432, imagePinned: true, restartPolicy: 'unless-stopped' });
        expect(await c.stop()).toEqual({ stopped: true, missing: false });
        expect((await c.container()).running).toBe(false);
        await c.start();
        expect((await c.container()).running).toBe(true);
        expect(await c.removeContainer()).toEqual({ removed: true });
        expect(await c.removeContainer()).toEqual({ removed: false });
        expect(await c.removeVolume()).toEqual({ removed: true });
        expect(await c.removeNetwork()).toEqual({ removed: true });
        const inspects = w.fake.calls().filter(call => call.args[1] === 'inspect' || call.args[0] === 'rm');
        expect(inspects.length).toBeGreaterThan(5);
    });

    test('waiting fails fast on an exited container, an unhealthy one and a timeout', async () => {
        const exited = world({ exitOnStart: true });
        let c = containersOf(exited);
        await c.createContainer({ port: 5432, bind: '127.0.0.1', storage: { kind: 'volume' }, superuserPassword: 'su-secret-0123456789abcdef' });
        await expect(c.waitHealthy({ pollMs: 1 })).rejects.toMatchObject({ code: 'CONTAINER_EXITED' });
        const sick = world({ neverHealthy: true, healthAfter: 1 });
        c = containersOf(sick);
        await c.createContainer({ port: 5432, bind: '127.0.0.1', storage: { kind: 'volume' }, superuserPassword: 'su-secret-0123456789abcdef' });
        await expect(c.waitHealthy({ pollMs: 1 })).rejects.toMatchObject({ code: 'CONTAINER_UNHEALTHY' });
        const slow = world({ healthAfter: 10_000 });
        c = containersOf(slow);
        await c.createContainer({ port: 5432, bind: '127.0.0.1', storage: { kind: 'volume' }, superuserPassword: 'su-secret-0123456789abcdef' });
        await expect(c.waitHealthy({ timeoutMs: 30, pollMs: 5 })).rejects.toMatchObject({ code: 'HEALTH_TIMEOUT' });
    });

    test('ports: another container\'s published port and a listening socket both count, and the next free port is offered', async () => {
        const w = world();
        w.fake.seedForeign({ container: 'someone-pg', port: 5432 });
        const busy = new Set([5433]);
        const c = containersOf(w, INSTALLATION, { probeListen: async (port) => !busy.has(port) });
        expect(await c.portStatus(5432, '127.0.0.1')).toMatchObject({ free: false, reason: 'CONTAINER_PUBLISHES', container: 'someone-pg' });
        expect(await c.portStatus(5433, '127.0.0.1')).toMatchObject({ free: false, reason: 'SOCKET_IN_USE' });
        expect(await c.portStatus(5434, '127.0.0.1')).toMatchObject({ free: true });
        expect(await c.nextFreePort(5432, '127.0.0.1')).toBe(5434);
    });

    test('parsePublished reads docker ps', () => {
        expect(lib.parsePublished('0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 127.0.0.1:8080-8081->80-81/tcp')).toEqual(expect.arrayContaining([
            { bind: '0.0.0.0', port: 5432, protocol: 'tcp' },
            { bind: '127.0.0.1', port: 8081, protocol: 'tcp' }
        ]));
        expect(lib.parsePublished('5432/tcp')).toEqual([]);
    });

    test('the pull is only what the plan approved: by digest', async () => {
        const w = world({ imagePulled: false });
        const c = containersOf(w);
        expect(await c.imagePulled()).toBe(false);
        await c.pull();
        expect(await c.imagePulled()).toBe(true);
        const pull = w.fake.calls().find(call => call.args[0] === 'pull');
        expect(pull.args).toEqual(['pull', image.REFERENCE]);
    });
});

const real = process.env.GOOBSTER_DOCKER_TESTS === '1' ? describe : describe.skip;
real('a real daemon (GOOBSTER_DOCKER_TESTS=1)', () => {
    test('the daemon check answers against the machine\'s own Docker', async () => {
        const report = await lib.checkDaemon({});
        expect(report.cli.present).toBe(true);
        expect(report.daemon.reachable).toBe(true);
        expect(report.verdict.ok).toBe(true);
    });
});
