/**
 * The privileged operations of the native PostgreSQL option (#340,
 * documentation/native_postgres.md): `package.install` for the closed package table and
 * `postgres.cluster.create|control|remove|relocate`.
 *
 * The real helper runs, as an ordinary user, inside a throwaway machine
 * (tests/helpers/fakeNative.js): fake apt-get, dnf, pg_createcluster, pg_ctlcluster,
 * pg_lsclusters, initdb, psql, systemctl and cp sit on a private PATH and record every
 * argv and every stdin. This VM's own PostgreSQL is never read for writing, and no real
 * package manager is ever started.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const protocol = require('@goobster/manager/privileged/protocol');
const privileged = require('@goobster/manager/privileged');
const nativeState = require('@goobster/manager/native/state');
const scram = require('@goobster/core/db/native/scram');
const fakeNative = require('./helpers/fakeNative');

const ID = '7c2a1b9e-0c3d-4f56-8a70-1b2c3d4e5f60';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';
const PASSWORD = 'pw-secret-never-on-argv-7';
const DEBIAN_PACKAGES = ['postgresql-17', 'postgresql-common', 'postgresql-client-17', 'postgresql-17-pgvector'];
const RHEL_PACKAGES = ['postgresql17-server', 'postgresql17', 'postgresql17-contrib', 'pgvector_17'];

const cleanups = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()();
});

function machine(options = {}) {
    const fake = fakeNative.create({ distro: 'debian', installed: DEBIAN_PACKAGES, ...options });
    fake.install();
    cleanups.push(() => fake.restore());
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'native-helper-store-'));
    cleanups.push(() => fs.rmSync(store, { recursive: true, force: true }));
    fs.writeFileSync(path.join(store, 'installation.json'), JSON.stringify({ installationId: ID }));
    const dataDirectory = path.join(fake.dir, 'srv', 'pgdata');
    const family = fake.family;
    const record = (patch = {}) => nativeState.write(store, {
        installationId: ID,
        family,
        distro: { id: options.distro || 'debian', version: '12' },
        major: 17,
        cluster: { name: 'goobster', service: family === 'debian' ? 'postgresql@17-goobster.service' : 'postgresql17-goobster.service', dataDirectory, port: 5433, bind: '127.0.0.1', role: 'goobster', database: 'goobster', ...(patch.cluster || {}) },
        step: patch.step || 'planned',
        created: { cluster: false, packages: [] },
        relocation: patch.relocation || null
    });
    record();
    const opts = fake.privilegedOptions();
    const run = async (operation, input) => {
        try {
            return await privileged.run(operation, input, opts);
        } catch (error) {
            return { thrown: error.code || error.message };
        }
    };
    const base = { installationId: ID, managerStore: store, clusterName: 'goobster' };
    const create = (over = {}) => ({ ...base, dataDirectory, port: 5433, bind: '127.0.0.1', lan: false, role: 'goobster', database: 'goobster', passwordVerifier: scram.verifier(PASSWORD), mode: 'create', ...over });
    return { fake, store, dataDirectory, record, run, base, create };
}

describe('input validation (closed, before anything is spawned)', () => {
    const verifier = scram.verifier(PASSWORD);
    const create = { installationId: ID, managerStore: '/var/lib/goobster/manager', clusterName: 'goobster', dataDirectory: '/srv/goobster-pg', port: 5433, bind: '127.0.0.1', lan: false, role: 'goobster', database: 'goobster', passwordVerifier: verifier };

    test('lists exactly the five new operations next to the existing ones', () => {
        expect(protocol.PRIVILEGED_OPERATIONS).toEqual(expect.arrayContaining(['package.install', 'postgres.cluster.create', 'postgres.cluster.control', 'postgres.cluster.remove', 'postgres.cluster.relocate']));
        expect(privileged.PRIVILEGED_OPERATIONS).toEqual(protocol.PRIVILEGED_OPERATIONS);
        expect(privileged.IMPLEMENTED.linux).toEqual(expect.arrayContaining(['postgres.cluster.create', 'postgres.cluster.control', 'postgres.cluster.remove', 'postgres.cluster.relocate', 'package.install']));
        for (const platform of ['win32', 'darwin']) {
            expect(privileged.IMPLEMENTED[platform]).toEqual(expect.not.arrayContaining(['package.install', 'postgres.cluster.create', 'postgres.cluster.control', 'postgres.cluster.remove', 'postgres.cluster.relocate']));
        }
    });

    test('a package outside the fixed table is refused, whatever else is asked', () => {
        for (const names of [['ffmpeg'], ['postgresql-17', 'curl; rm -rf /'], ['postgresql-16'], [], ['postgresql-17', 'postgresql-17'], 'postgresql-17']) {
            expect(() => protocol.validateInput('package.install', { names })).toThrow();
        }
        expect(() => protocol.validateInput('package.install', { names: ['postgresql-17'], repository: 'evil' })).toThrow();
        expect(() => protocol.validateInput('package.install', { names: ['postgresql-17'], extra: 1 })).toThrow();
        expect(protocol.validateInput('package.install', { names: DEBIAN_PACKAGES, repository: 'pgdg' })).toEqual({ names: DEBIAN_PACKAGES, repository: 'pgdg' });
    });

    test('creating a cluster takes a SCRAM verifier, never a password, and no field the operation does not name', () => {
        expect(protocol.validateInput('postgres.cluster.create', create).passwordVerifier).toBe(verifier);
        expect(() => protocol.validateInput('postgres.cluster.create', { ...create, passwordVerifier: PASSWORD })).toThrow(/verifier/);
        expect(() => protocol.validateInput('postgres.cluster.create', { ...create, password: PASSWORD })).toThrow();
        const { passwordVerifier, ...none } = create;
        void passwordVerifier;
        expect(() => protocol.validateInput('postgres.cluster.create', none)).toThrow(/verifier/);
        expect(() => protocol.validateInput('postgres.cluster.create', { ...create, mode: 'converge' })).toThrow(/takes no password/);
        expect(protocol.validateInput('postgres.cluster.create', { ...none, mode: 'converge' }).mode).toBe('converge');
    });

    test('names, ports, addresses and paths are checked against closed patterns', () => {
        const bad = [
            { clusterName: 'main' },
            { clusterName: 'goobster-XYZ' },
            { clusterName: 'goobster; drop' },
            { port: 80 },
            { port: 70000 },
            { port: '5433' },
            { bind: 'localhost' },
            { bind: '0.0.0.0' },
            { bind: '256.1.1.1', lan: true },
            { lan: true },
            { role: 'postgres' },
            { role: 'Robert; DROP' },
            { database: 'template1' },
            { dataDirectory: 'relative/path' },
            { dataDirectory: '/srv/with space' },
            { dataDirectory: '/srv/../etc' },
            { dataDirectory: '/etc/postgres' },
            { dataDirectory: '/usr/lib/pg' },
            { dataDirectory: '/' },
            { installationId: 'not-a-uuid' },
            { managerStore: 'relative' }
        ];
        for (const patch of bad) expect(() => protocol.validateInput('postgres.cluster.create', { ...create, ...patch })).toThrow();
        expect(protocol.validateInput('postgres.cluster.create', { ...create, bind: '192.168.1.5', lan: true }).bind).toBe('192.168.1.5');
    });

    test('control, remove and relocate accept only their own fields and the cluster name of an installation', () => {
        const base = { installationId: ID, managerStore: '/var/lib/goobster/manager', clusterName: 'goobster-0a1b2c3d' };
        expect(protocol.validateInput('postgres.cluster.control', { ...base, action: 'stop' }).action).toBe('stop');
        expect(() => protocol.validateInput('postgres.cluster.control', { ...base, action: 'restart' })).toThrow();
        expect(() => protocol.validateInput('postgres.cluster.control', { ...base, action: 'stop', clusterName: 'main' })).toThrow();
        expect(protocol.validateInput('postgres.cluster.remove', { ...base })).toEqual(expect.objectContaining({ removeData: false }));
        expect(() => protocol.validateInput('postgres.cluster.remove', { ...base, removeData: 'yes' })).toThrow();
        expect(() => protocol.validateInput('postgres.cluster.remove', { ...base, dataDirectory: '/srv/x' })).toThrow();
        expect(() => protocol.validateInput('postgres.cluster.relocate', { ...base, target: '/etc/pg' })).toThrow();
        expect(() => protocol.validateInput('postgres.cluster.relocate', { ...base, target: 'relative' })).toThrow();
        expect(protocol.validateInput('postgres.cluster.relocate', { ...base, target: '/srv/pg2' }).target).toBe('/srv/pg2');
    });

    test('the manager-side validation surfaces as a 400 with the helper\'s code before a process is started', async () => {
        const m = machine();
        const result = await m.run('postgres.cluster.create', m.create({ passwordVerifier: PASSWORD }));
        expect(result.thrown).toBe('INVALID_INPUT');
        expect(m.fake.calls()).toEqual([]);
    });
});

describe('package.install', () => {
    test('installs the closed set from the project repository with the key pinned by fingerprint, and a second run changes nothing', async () => {
        const m = machine({ installed: [] });
        const first = await m.run('package.install', { names: DEBIAN_PACKAGES, repository: 'pgdg' });
        expect(first.status).toBe('done');
        expect(first.detail.installed).toEqual(DEBIAN_PACKAGES);
        const argv = m.fake.argvText();
        expect(argv).toMatch(/apt-get install -y --no-install-recommends postgresql-17 postgresql-common postgresql-client-17 postgresql-17-pgvector/);
        expect(argv).toMatch(/curl .*https:\/\/www\.postgresql\.org\/media\/keys\/ACCC4CF8\.asc/);
        expect(argv).toMatch(/gpg --batch --no-tty --show-keys --with-colons --fingerprint/);
        expect(m.fake.state().installed).toEqual(expect.arrayContaining(DEBIAN_PACKAGES));

        m.fake.clearCalls();
        const second = await m.run('package.install', { names: DEBIAN_PACKAGES, repository: 'pgdg' });
        expect(second.status).toBe('done');
        expect(second.outcome).toBe('noop');
        expect(m.fake.argvText()).not.toMatch(/apt-get install/);
    });

    test('a key whose fingerprint is not the pinned one is refused and no source is written or package installed', async () => {
        const m = machine({ installed: [], flags: { wrongKey: true } });
        const result = await m.run('package.install', { names: DEBIAN_PACKAGES, repository: 'pgdg' });
        expect(result.status).toBe('failed');
        expect(result.code).toMatch(/KEY|FINGERPRINT/);
        expect(m.fake.argvText()).not.toMatch(/apt-get install/);
        expect(fs.readdirSync(path.join(m.fake.dir, 'etc', 'apt', 'sources.list.d'))).toEqual([]);
    });

    test('a failing package manager is reported with its code, not swallowed', async () => {
        const m = machine({ installed: [], flags: { aptFails: true } });
        const result = await m.run('package.install', { names: DEBIAN_PACKAGES, repository: 'pgdg' });
        expect(result.status).toBe('failed');
        expect(typeof result.code).toBe('string');
    });

    test('an RPM-family machine installs with dnf from the pinned repository key', async () => {
        const m = machine({ distro: 'rocky', installed: [] });
        const result = await m.run('package.install', { names: RHEL_PACKAGES, repository: 'pgdg' });
        expect(result.status).toBe('done');
        expect(m.fake.argvText()).toMatch(/dnf .*install/);
        expect(m.fake.argvText()).not.toMatch(/apt-get/);
    });

    test('a distribution that is not supported is refused before anything is installed', async () => {
        const m = machine({ installed: [] });
        fs.writeFileSync(path.join(m.fake.dir, 'etc', 'os-release'), 'ID=alpine\nVERSION_ID=3.20\n');
        const result = await m.run('package.install', { names: DEBIAN_PACKAGES, repository: 'pgdg' });
        expect(result.status).toBe('failed');
        expect(result.code).toBe('DISTRO_UNSUPPORTED');
        expect(m.fake.mutations()).toEqual([]);
    });
});

describe('postgres.cluster.create', () => {
    test('creates a cluster of its own beside an existing one, on the chosen port, and sends the role statement on stdin only', async () => {
        const m = machine();
        const foreign = m.fake.seedForeignCluster({ name: 'main', port: 5432 });
        const before = m.fake.snapshot(foreign.files);
        const result = await m.run('postgres.cluster.create', m.create());
        expect(result.status).toBe('done');
        expect(result.detail).toEqual(expect.objectContaining({ cluster: 'goobster', created: true, port: 5433 }));
        const cluster = m.fake.state().clusters.find(item => item.name === 'goobster');
        expect(cluster).toEqual(expect.objectContaining({ version: 17, port: 5433, online: true, dataDirectory: m.dataDirectory }));
        expect(fs.readFileSync(path.join(m.dataDirectory, 'goobster-installation'), 'utf8').trim()).toBe(ID);

        // The secret never reaches a command line or any output; the role statement does reach psql on stdin, as NOSUPERUSER.
        expect(m.fake.argvText()).not.toContain(PASSWORD);
        expect(JSON.stringify(result)).not.toContain(PASSWORD);
        expect(JSON.stringify(result)).not.toMatch(/SCRAM-SHA-256\$/);
        expect(m.fake.argvText()).not.toMatch(/SCRAM-SHA-256\$/);
        const stdin = m.fake.stdinText();
        expect(stdin).not.toContain(PASSWORD);
        expect(stdin).toMatch(/CREATE ROLE "?goobster"? .*LOGIN/i);
        expect(stdin).toMatch(/NOSUPERUSER/);
        expect(stdin).toMatch(/NOCREATEDB/);
        expect(stdin).toMatch(/NOCREATEROLE/);
        expect(stdin).toMatch(/SCRAM-SHA-256\$/);
        expect(stdin).toMatch(/CREATE EXTENSION IF NOT EXISTS citext/);
        expect(stdin).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);

        // The cluster that was there is untouched, byte for byte, and still running.
        expect(m.fake.snapshot(foreign.files)).toEqual(before);
        expect(m.fake.state().clusters.find(item => item.name === 'main')).toEqual(expect.objectContaining({ online: true, port: 5432 }));
        const touched = m.fake.calls().filter(call => call.program === 'pg_ctlcluster' || call.program === 'pg_createcluster' || call.program === 'pg_dropcluster');
        for (const call of touched) expect(call.args).not.toContain('main');
    });

    test('a second create resumes the same cluster instead of building another, and a converge run only checks', async () => {
        const m = machine();
        expect((await m.run('postgres.cluster.create', m.create())).detail.created).toBe(true);
        m.fake.clearCalls();
        const again = await m.run('postgres.cluster.create', m.create());
        expect(again.status).toBe('done');
        expect(again.detail).toEqual(expect.objectContaining({ created: false, resumed: true }));
        expect(m.fake.argvText()).not.toMatch(/pg_createcluster/);
        expect(m.fake.state().clusters.filter(item => item.name === 'goobster')).toHaveLength(1);

        m.fake.clearCalls();
        const { passwordVerifier, ...converge } = m.create({ mode: 'converge' });
        void passwordVerifier;
        const checked = await m.run('postgres.cluster.create', converge);
        expect(checked.status).toBe('done');
        expect(checked.outcome).toBe('noop');
        expect(m.fake.mutations().filter(call => call.program !== 'systemctl')).toEqual([]);
    });

    test('refuses an installation or a record that does not match, and creates nothing', async () => {
        const m = machine();
        expect((await m.run('postgres.cluster.create', m.create({ installationId: OTHER_ID }))).code).toBe('INSTALLATION_MISMATCH');
        expect((await m.run('postgres.cluster.create', m.create({ clusterName: 'goobster-aaaaaaaa' }))).code).toBe('RECORD_MISMATCH');
        expect((await m.run('postgres.cluster.create', m.create({ dataDirectory: path.join(m.fake.dir, 'srv', 'other') }))).code).toBe('RECORD_MISMATCH');
        fs.rmSync(path.join(m.store, nativeState.FILE_NAME));
        expect((await m.run('postgres.cluster.create', m.create())).code).toBe('RECORD_MISMATCH');
        expect(m.fake.mutations()).toEqual([]);
        expect(fs.existsSync(m.dataDirectory)).toBe(false);
    });

    test('refuses a port that another cluster uses, and a directory that is not empty or belongs to another cluster', async () => {
        const m = machine();
        const foreign = m.fake.seedForeignCluster({ name: 'main', port: 5432 });
        m.record({ cluster: { port: 5432 } });
        expect((await m.run('postgres.cluster.create', m.create({ port: 5432 }))).code).toBe('PORT_IN_USE');

        m.record({ cluster: { dataDirectory: foreign.dataDirectory } });
        expect((await m.run('postgres.cluster.create', m.create({ dataDirectory: foreign.dataDirectory }))).code).toBe('DATA_DIRECTORY_IN_USE');

        m.record();
        fs.mkdirSync(m.dataDirectory, { recursive: true });
        fs.writeFileSync(path.join(m.dataDirectory, 'precious.txt'), 'mine');
        expect((await m.run('postgres.cluster.create', m.create())).code).toBe('DATA_DIRECTORY_NOT_EMPTY');
        expect(fs.readFileSync(path.join(m.dataDirectory, 'precious.txt'), 'utf8')).toBe('mine');
        expect(m.fake.mutations()).toEqual([]);
    });

    test('refuses a directory whose name is a symbolic link', async () => {
        const m = machine();
        const real = path.join(m.fake.dir, 'srv', 'real');
        fs.mkdirSync(real, { recursive: true });
        fs.symlinkSync(real, m.dataDirectory);
        const result = await m.run('postgres.cluster.create', m.create());
        expect(result.status).toBe('failed');
        expect(result.code).toBe('PATH_NOT_ALLOWED');
        expect(fs.readdirSync(real)).toEqual([]);
    });

    test('a failed cluster creation is reported and the half-built cluster is removed, never anything else', async () => {
        const m = machine({ flags: { createFails: true } });
        const foreign = m.fake.seedForeignCluster({ name: 'main', port: 5432 });
        const before = m.fake.snapshot(foreign.files);
        const result = await m.run('postgres.cluster.create', m.create());
        expect(result.status).toBe('failed');
        expect(m.fake.state().clusters.map(item => item.name)).toEqual(['main']);
        expect(m.fake.snapshot(foreign.files)).toEqual(before);
    });

    test('a bind other than loopback is configured only when the request says so', async () => {
        const m = machine();
        m.record({ cluster: { bind: '192.168.1.5' } });
        const result = await m.run('postgres.cluster.create', m.create({ bind: '192.168.1.5', lan: true }));
        expect(result.status).toBe('done');
        const confd = path.join(m.fake.dir, 'etc', 'postgresql', '17', 'goobster', 'conf.d');
        const text = fs.readdirSync(confd).map(file => fs.readFileSync(path.join(confd, file), 'utf8')).join('\n');
        expect(text).toMatch(/listen_addresses\s*=\s*'192\.168\.1\.5'/);
        expect(text).toMatch(/port\s*=\s*5433/);
    });

    test('an RPM-family machine builds a cluster with its own initdb and unit, beside an existing unit', async () => {
        const m = machine({ distro: 'rocky', installed: RHEL_PACKAGES });
        const result = await m.run('postgres.cluster.create', m.create());
        expect(result.status).toBe('done');
        expect(result.detail.service).toBe('postgresql17-goobster.service');
        const unit = fs.readFileSync(path.join(m.fake.dir, 'etc', 'systemd', 'system', 'postgresql17-goobster.service'), 'utf8');
        expect(unit).toContain(m.dataDirectory);
        expect(unit).toContain(ID);
        expect(m.fake.argvText()).toMatch(/initdb/);
        expect(m.fake.argvText()).not.toContain(PASSWORD);
    });
});

describe('postgres.cluster.control', () => {
    async function running() {
        const m = machine();
        await m.run('postgres.cluster.create', m.create());
        m.record({ step: 'verified' });
        return m;
    }

    test('stops and starts only the cluster of this installation, and repeating either is a no-op', async () => {
        const m = await running();
        const foreign = m.fake.seedForeignCluster({ name: 'main', port: 5432 });
        const stop = await m.run('postgres.cluster.control', { ...m.base, action: 'stop' });
        expect(stop.detail).toEqual(expect.objectContaining({ action: 'stop', running: false }));
        expect(m.fake.state().clusters.find(item => item.name === 'goobster').online).toBe(false);
        expect((await m.run('postgres.cluster.control', { ...m.base, action: 'stop' })).outcome).toBe('noop');
        const start = await m.run('postgres.cluster.control', { ...m.base, action: 'start' });
        expect(start.detail.running).toBe(true);
        expect((await m.run('postgres.cluster.control', { ...m.base, action: 'start' })).outcome).toBe('noop');
        expect(m.fake.state().clusters.find(item => item.name === 'main').online).toBe(true);
        expect(m.fake.snapshot(foreign.files)).toBeDefined();
    });

    test('a cluster name that is not the recorded one is refused at validation or by the record', async () => {
        const m = await running();
        expect((await m.run('postgres.cluster.control', { ...m.base, clusterName: 'main', action: 'stop' })).thrown).toBe('INVALID_INPUT');
        expect((await m.run('postgres.cluster.control', { ...m.base, clusterName: 'goobster-0a1b2c3d', action: 'stop' })).code).toBe('RECORD_MISMATCH');
        expect((await m.run('postgres.cluster.control', { ...m.base, installationId: OTHER_ID, action: 'stop' })).code).toBe('INSTALLATION_MISMATCH');
        expect(m.fake.state().clusters.find(item => item.name === 'goobster').online).toBe(true);
    });

    test('a directory without this installation\'s marker is never controlled', async () => {
        const m = await running();
        fs.writeFileSync(path.join(m.dataDirectory, 'goobster-installation'), `${OTHER_ID}\n`);
        const result = await m.run('postgres.cluster.control', { ...m.base, action: 'stop' });
        expect(result.status).toBe('failed');
        expect(m.fake.state().clusters.find(item => item.name === 'goobster').online).toBe(true);
    });

    test('a start that does not bring the cluster up is an error with a code', async () => {
        const m = await running();
        await m.run('postgres.cluster.control', { ...m.base, action: 'stop' });
        m.fake.flag('startFails');
        const result = await m.run('postgres.cluster.control', { ...m.base, action: 'start' });
        expect(result.status).toBe('failed');
        expect(typeof result.code).toBe('string');
    });
});

describe('postgres.cluster.remove', () => {
    test('without removeData it stops the cluster and keeps the data directory and the packages', async () => {
        const m = machine();
        const foreign = m.fake.seedForeignCluster({ name: 'main', port: 5432 });
        const before = m.fake.snapshot(foreign.files);
        await m.run('postgres.cluster.create', m.create());
        m.record({ step: 'verified' });
        const result = await m.run('postgres.cluster.remove', { ...m.base });
        expect(result.status).toBe('done');
        expect(result.detail).toEqual(expect.objectContaining({ removed: false, dataKept: true }));
        expect(fs.existsSync(path.join(m.dataDirectory, 'PG_VERSION'))).toBe(true);
        expect(m.fake.state().installed).toEqual(expect.arrayContaining(DEBIAN_PACKAGES));
        expect(m.fake.argvText()).not.toMatch(/apt-get (remove|purge)|dnf .*(remove|erase)/);
        expect(m.fake.snapshot(foreign.files)).toEqual(before);
        expect(m.fake.state().clusters.find(item => item.name === 'main').online).toBe(true);
    });

    test('with removeData it drops exactly this cluster and its directory, and nothing else', async () => {
        const m = machine();
        const foreign = m.fake.seedForeignCluster({ name: 'main', port: 5432 });
        const before = m.fake.snapshot(foreign.files);
        await m.run('postgres.cluster.create', m.create());
        m.record({ step: 'verified' });
        const result = await m.run('postgres.cluster.remove', { ...m.base, removeData: true });
        expect(result.detail).toEqual(expect.objectContaining({ removed: true, dataKept: false }));
        expect(m.fake.state().clusters.map(item => item.name)).toEqual(['main']);
        expect(fs.existsSync(m.dataDirectory)).toBe(false);
        expect(m.fake.state().installed).toEqual(expect.arrayContaining(DEBIAN_PACKAGES));
        expect(m.fake.snapshot(foreign.files)).toEqual(before);
    });

    test('data is never removed from a directory that is not marked as this installation\'s', async () => {
        const m = machine();
        await m.run('postgres.cluster.create', m.create());
        m.record({ step: 'verified' });
        fs.writeFileSync(path.join(m.dataDirectory, 'goobster-installation'), `${OTHER_ID}\n`);
        const result = await m.run('postgres.cluster.remove', { ...m.base, removeData: true });
        expect(result.status).toBe('failed');
        expect(fs.existsSync(path.join(m.dataDirectory, 'PG_VERSION'))).toBe(true);
    });
});

describe('postgres.cluster.relocate', () => {
    async function ready() {
        const m = machine();
        await m.run('postgres.cluster.create', m.create());
        const target = path.join(m.fake.dir, 'srv', 'pgdata2');
        m.record({ step: 'verified', relocation: { from: m.dataDirectory, to: target, step: 'backup', backupVerified: true } });
        return { m, target };
    }

    test('copies to the target, switches the cluster over and keeps the original directory', async () => {
        const { m, target } = await ready();
        // The real shutdown rewrites the tree (checkpoint, stats flush, pid file); the copy is
        // measured against the stopped cluster, not the live one.
        m.fake.flag('stopChangesTree');
        const result = await m.run('postgres.cluster.relocate', { ...m.base, target });
        m.fake.flag('stopChangesTree', false);
        expect(result.status).toBe('done');
        expect(result.detail).toEqual(expect.objectContaining({ switched: true, kept: true }));
        expect(m.fake.state().clusters.find(item => item.name === 'goobster')).toEqual(expect.objectContaining({ dataDirectory: target, online: true }));
        expect(fs.existsSync(path.join(m.dataDirectory, 'PG_VERSION'))).toBe(true);
        expect(fs.readFileSync(path.join(target, 'goobster-installation'), 'utf8').trim()).toBe(ID);
        expect(fs.existsSync(path.join(target, 'goobster-relocating'))).toBe(false);
        const again = await m.run('postgres.cluster.relocate', { ...m.base, target });
        expect(again.outcome).toBe('noop');
    });

    test('an interrupted copy leaves the original in place and serving, and the run can be repeated', async () => {
        const { m, target } = await ready();
        m.fake.flag('cpInterrupt');
        const failed = await m.run('postgres.cluster.relocate', { ...m.base, target });
        expect(failed.status).toBe('failed');
        expect(fs.existsSync(path.join(m.dataDirectory, 'PG_VERSION'))).toBe(true);
        expect(m.fake.state().clusters.find(item => item.name === 'goobster').dataDirectory).toBe(m.dataDirectory);
        expect(fs.existsSync(path.join(target, 'goobster-relocating'))).toBe(true);

        m.fake.flag('cpInterrupt', false);
        const finished = await m.run('postgres.cluster.relocate', { ...m.base, target });
        expect(finished.status).toBe('done');
        expect(m.fake.state().clusters.find(item => item.name === 'goobster').dataDirectory).toBe(target);
    });

    test('refuses a target the record does not name, and a target that is not empty', async () => {
        const { m, target } = await ready();
        expect((await m.run('postgres.cluster.relocate', { ...m.base, target: path.join(m.fake.dir, 'srv', 'elsewhere') })).code).toBe('RECORD_MISMATCH');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'precious.txt'), 'mine');
        const refused = await m.run('postgres.cluster.relocate', { ...m.base, target });
        expect(refused.status).toBe('failed');
        expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('mine');
        expect(m.fake.state().clusters.find(item => item.name === 'goobster').dataDirectory).toBe(m.dataDirectory);
    });

    test('refuses a relocation when the manager has no relocation recorded', async () => {
        const m = machine();
        await m.run('postgres.cluster.create', m.create());
        m.record({ step: 'verified' });
        const result = await m.run('postgres.cluster.relocate', { ...m.base, target: path.join(m.fake.dir, 'srv', 'pgdata2') });
        expect(result.code).toBe('RECORD_MISMATCH');
    });
});
