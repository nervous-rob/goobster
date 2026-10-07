/**
 * The read-only adapters of the native PostgreSQL option (#340,
 * documentation/native_postgres.md): distribution classification, the closed package
 * and repository tables (and their equality with the copy the privileged helper
 * carries), the SCRAM-SHA-256 verifier, the storage rules, resource names, the
 * inspection parsers and the closed read-only command list. Nothing here starts a
 * process other than the fake programs in tests/helpers/fakeNative.js.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const native = require('@goobster/core/db/native');
const inventory = require('@goobster/core/db/native/inventory');
const protocol = require('@goobster/manager/privileged/protocol');
const linux = require('@goobster/manager/privileged/linux');
const fakeNative = require('./helpers/fakeNative');

const ID = '7c2a1b9e-0c3d-4f56-8a70-1b2c3d4e5f60';

describe('distribution classification', () => {
    const classify = (text, arch = 'x64', extra = {}) => native.distro.classify({ release: native.distro.parseOsRelease(text), arch, ...extra });

    test('parses os-release with quotes and ignores what is not KEY=value', () => {
        expect(native.distro.parseOsRelease('ID="debian"\n# comment\nVERSION_ID=\'12\'\nnonsense\n')).toEqual({ ID: 'debian', VERSION_ID: '12' });
    });

    test.each([
        ['debian 12', 'ID=debian\nVERSION_ID=12\n', 'x64', 'debian', true, 'bookworm'],
        ['debian 12 on arm64 (Raspberry Pi OS Bookworm)', 'ID=debian\nVERSION_ID=12\n', 'arm64', 'debian', true, 'bookworm'],
        ['ubuntu 22.04', 'ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\n', 'x64', 'debian', true, 'jammy'],
        ['ubuntu 24.04', 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n', 'arm64', 'debian', true, 'noble'],
        ['almalinux 9', 'ID=almalinux\nVERSION_ID="9.4"\n', 'x64', 'rhel', true, null],
        ['rocky 9', 'ID=rocky\nVERSION_ID="9.3"\n', 'arm64', 'rhel', true, null]
    ])('supports %s', (_label, text, arch, family, supported, codename) => {
        const facts = classify(text, arch);
        expect(facts.supported).toBe(supported);
        expect(facts.family).toBe(family);
        expect(facts.reason).toBeNull();
        if (codename) expect(facts.codename).toBe(codename);
    });

    test.each([
        ['debian 11', 'ID=debian\nVERSION_ID=11\n', 'x64', 'DISTRO_VERSION_UNSUPPORTED'],
        ['ubuntu 20.04', 'ID=ubuntu\nVERSION_ID="20.04"\n', 'x64', 'DISTRO_VERSION_UNSUPPORTED'],
        ['rocky 8', 'ID=rocky\nVERSION_ID="8.9"\n', 'x64', 'DISTRO_VERSION_UNSUPPORTED'],
        ['alpine', 'ID=alpine\nVERSION_ID=3.20\n', 'x64', 'DISTRO_UNSUPPORTED'],
        ['arch', 'ID=arch\n', 'x64', 'DISTRO_UNSUPPORTED'],
        ['32-bit Raspberry Pi OS', 'ID=raspbian\nVERSION_ID=12\n', 'arm', 'ARCH_UNSUPPORTED'],
        ['debian 12 on a 32-bit ARM kernel', 'ID=debian\nVERSION_ID=12\n', 'arm', 'ARCH_UNSUPPORTED'],
        ['debian 12 on riscv64', 'ID=debian\nVERSION_ID=12\n', 'riscv64', 'ARCH_UNSUPPORTED']
    ])('refuses %s with %s and a way out', (_label, text, arch, reason) => {
        const facts = classify(text, arch);
        expect(facts.supported).toBe(false);
        expect(facts.reason).toBe(reason);
        expect(native.distro.REASONS[reason]).toMatch(/Docker|existing|SQLite|64-bit/);
    });

    test('detect reads os-release from the given file system, flags a Raspberry Pi, and refuses a non-Linux platform', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-distro-'));
        try {
            const files = { '/etc/os-release': 'ID=debian\nVERSION_ID=12\n' };
            const fake = { readFileSync: (file) => { if (files[file]) return files[file]; throw new Error('ENOENT'); }, existsSync: (file) => file === '/etc/rpi-issue' };
            const facts = native.distro.detect({ fs: fake, platform: 'linux', arch: 'arm64' });
            expect(facts).toEqual(expect.objectContaining({ supported: true, family: 'debian', raspberryPi: true, arch: 'arm64' }));
            const windows = native.distro.detect({ fs: fake, platform: 'win32', arch: 'x64' });
            expect(windows).toEqual(expect.objectContaining({ supported: false, reason: 'OS_UNSUPPORTED' }));
            expect(windows.remedy).toMatch(/Linux only/);
            const unreadable = native.distro.detect({ fs: { readFileSync: () => { throw new Error('ENOENT'); }, existsSync: () => false }, platform: 'linux', arch: 'x64' });
            expect(unreadable.supported).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('the helper accepts the same three distribution families the planner classifies as supported', async () => {
        for (const distro of ['debian', 'ubuntu', 'rocky']) {
            const machine = fakeNative.create({ distro, installed: [] });
            machine.install();
            try {
                const family = machine.family;
                const result = await require('@goobster/manager/privileged').run('package.install', { names: native.packages.installNames(family), repository: 'pgdg' }, machine.privilegedOptions());
                expect(result.status).toBe('done');
            } finally {
                machine.restore();
            }
        }
    });
});

describe('the closed tables and the helper\'s copy of them', () => {
    test('the major version is 17 everywhere', () => {
        expect(native.MAJOR).toBe(17);
        expect(native.packages.MAJOR).toBe(17);
        expect(native.pgdg.MAJOR).toBe(17);
        expect(protocol.PG_MAJOR).toBe(17);
        expect(linux.NATIVE.major).toBe(17);
    });

    test('the planner\'s package table equals the helper\'s, role by role', () => {
        for (const family of ['debian', 'rhel']) {
            for (const role of ['prerequisites', 'server', 'client', 'pgvector', 'contrib', 'selinux']) {
                expect([...protocol.PACKAGE_TABLE[family][role]]).toEqual([...native.packages.table(family)[role]]);
            }
        }
        expect([...protocol.PACKAGE_NAMES].sort()).toEqual([...new Set([...native.packages.allNames('debian'), ...native.packages.allNames('rhel')])].sort());
        for (const name of protocol.PACKAGE_NAMES) expect(name).toMatch(/^[a-z0-9][a-z0-9_.+-]{0,63}$/);
    });

    test('nothing outside PostgreSQL and the repository prerequisites can be asked of a package manager', () => {
        const allowed = [...protocol.PACKAGE_NAMES];
        for (const name of ['ffmpeg', 'sudo', 'openssh-server', 'curl; id', 'postgresql-16', 'postgresql']) expect(allowed).not.toContain(name);
        expect(native.packages.installNames('debian')).toEqual(['postgresql-17', 'postgresql-common', 'postgresql-client-17', 'postgresql-17-pgvector']);
        expect(native.packages.installNames('rhel')).toEqual(['postgresql17-server', 'postgresql17', 'pgvector_17', 'postgresql17-contrib']);
        expect(native.packages.installNames('rhel', { selinux: true })).toContain('policycoreutils-python-utils');
    });

    test('the pinned repositories, keys and fingerprints are the same in the planner and in the helper', () => {
        expect(JSON.parse(JSON.stringify(linux.NATIVE.apt))).toEqual(JSON.parse(JSON.stringify(native.pgdg.APT)));
        expect(JSON.parse(JSON.stringify(linux.NATIVE.rpm))).toEqual(JSON.parse(JSON.stringify(native.pgdg.RPM)));
        expect(native.pgdg.APT.fingerprint).toMatch(/^[0-9A-F]{40}$/);
        for (const key of Object.values(native.pgdg.RPM.keys)) expect(key.fingerprint).toMatch(/^[0-9A-F]{40}$/);
        for (const url of [native.pgdg.APT.keyUrl, native.pgdg.APT.repositoryUrl, native.pgdg.RPM.baseUrl, ...Object.values(native.pgdg.RPM.keys).map(key => key.url)]) {
            expect(url).toMatch(/^https:\/\/(www|download|apt)\.postgresql\.org\//);
        }
    });

    test('the file system rules and the directory layouts are the same in the planner and in the helper', () => {
        expect([...linux.NATIVE.mounts.transient]).toEqual([...native.mounts.TRANSIENT]);
        expect([...linux.NATIVE.mounts.unsuitable]).toEqual([...native.mounts.UNSUITABLE]);
        expect([...linux.NATIVE.forbiddenTrees]).toEqual([...native.paths.TRANSIENT_TREES]);
        expect([...protocol.SYSTEM_PATHS]).toEqual([...native.paths.SYSTEM_PATHS]);
        expect([...protocol.SYSTEM_TREES]).toEqual([...native.paths.SYSTEM_TREES]);
        for (const family of ['debian', 'rhel']) {
            const planner = native.packages.layoutFor(family);
            const helper = linux.NATIVE.layouts[family];
            expect(helper.binDir).toBe(planner.binDir);
            expect(helper.extensionDir).toBe(planner.extensionDir);
            expect(helper.socketDir).toBe(planner.socketDir);
            expect(helper.mainDataRoot).toBe(planner.mainDataRoot);
            expect(helper.configRoot).toBe(planner.configRoot);
        }
        expect(linux.NATIVE.marker).toBe(native.names.MARKER_FILE);
        expect(linux.NATIVE.relocating).toBe(native.names.RELOCATING_FILE);
        expect(linux.NATIVE.minFreeBytes).toBe(inventory.MIN_FREE_BYTES);
    });

    test('describe names the repository an operator is shown before it is added', () => {
        expect(native.pgdg.describe('debian', { codename: 'bookworm' })).toEqual(expect.objectContaining({ url: 'https://apt.postgresql.org/pub/repos/apt', suite: 'bookworm-pgdg', fingerprint: native.pgdg.APT.fingerprint }));
        expect(native.pgdg.describe('rhel', { arch: 'arm64' })).toEqual(expect.objectContaining({ url: expect.stringMatching(/aarch64$/), fingerprint: native.pgdg.RPM.keys.arm64.fingerprint }));
        expect(() => native.packages.table('arch')).toThrow();
    });
});

describe('SCRAM-SHA-256 verifier', () => {
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const b64 = (value) => Buffer.from(value, 'base64');

    test('is the stored form PostgreSQL keeps: it verifies the RFC 7677 exchange for the password "pencil"', () => {
        const verifier = native.scram.verifier('pencil', { salt: b64('W22ZaJ0SNY7soEsUEjb6gQ==') });
        const match = /^SCRAM-SHA-256\$4096:(.+)\$(.+):(.+)$/.exec(verifier);
        expect(match).not.toBeNull();
        const storedKey = b64(match[2]);
        const serverKey = b64(match[3]);
        const authMessage = 'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
        const proof = b64('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
        const clientSignature = hmac(storedKey, authMessage);
        const clientKey = Buffer.from(proof.map((byte, index) => byte ^ clientSignature[index]));
        expect(crypto.createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
        expect(hmac(serverKey, authMessage).toString('base64')).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
    });

    test('is salted, matches the shape the helper accepts, and never contains the password', () => {
        const first = native.scram.verifier('correct-horse-battery');
        const second = native.scram.verifier('correct-horse-battery');
        expect(first).not.toBe(second);
        for (const verifier of [first, second]) {
            expect(native.scram.isVerifier(verifier)).toBe(true);
            expect(verifier).toMatch(/^SCRAM-SHA-256\$/);
            expect(verifier).not.toContain('correct-horse');
        }
        expect(native.scram.SHAPE.source).toBe(/^SCRAM-SHA-256\$\d{1,6}:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/.source);
        const created = protocol.validateInput('postgres.cluster.create', { installationId: ID, managerStore: '/var/lib/goobster/manager', clusterName: 'goobster', dataDirectory: '/srv/pg', port: 5433, bind: '127.0.0.1', lan: false, role: 'goobster', database: 'goobster', passwordVerifier: first });
        expect(created.passwordVerifier).toBe(first);
    });

    test('refuses an empty or non-printable password, and a value that is not a verifier is not recognised as one', () => {
        expect(() => native.scram.verifier('')).toThrow();
        expect(() => native.scram.verifier('pass word\n')).toThrow();
        expect(native.scram.isVerifier('hunter2')).toBe(false);
        expect(native.scram.isVerifier(`${native.scram.verifier('x')}; DROP ROLE postgres`)).toBe(false);
        expect(native.scram.isVerifier(null)).toBe(false);
    });
});

describe('names', () => {
    test('the cluster is "goobster", or carries the first eight characters of the installation id when that name is taken', () => {
        expect(native.names.clusterNameFor(ID, [])).toBe('goobster');
        expect(native.names.clusterNameFor(ID, ['main'])).toBe('goobster');
        expect(native.names.clusterNameFor(ID, ['goobster', 'main'])).toBe('goobster-7c2a1b9e');
        expect(() => native.names.shortId('not-a-uuid')).toThrow(/UUID/);
    });

    test('Debian and RPM resources are named from the cluster name, and only names this installer produces are accepted', () => {
        const debian = native.names.resourcesFor({ family: 'debian', installationId: ID, clusterName: 'goobster-7c2a1b9e' });
        expect(debian).toEqual(expect.objectContaining({ service: 'postgresql@17-goobster-7c2a1b9e.service', configDirectory: '/etc/postgresql/17/goobster-7c2a1b9e', dataDirectory: '/var/lib/postgresql/17/goobster-7c2a1b9e', markerFile: '/var/lib/postgresql/17/goobster-7c2a1b9e/goobster-installation' }));
        const rhel = native.names.resourcesFor({ family: 'rhel', installationId: ID, clusterName: 'goobster', dataDirectory: '/srv/pg' });
        expect(rhel).toEqual(expect.objectContaining({ service: 'postgresql17-goobster.service', unitFile: '/etc/systemd/system/postgresql17-goobster.service', dataDirectory: '/srv/pg' }));
        for (const bad of ['main', 'goobster-XYZ', 'goobster-1234567', 'goobster; id', '../goobster', '']) {
            expect(() => native.names.resourcesFor({ family: 'debian', installationId: ID, clusterName: bad })).toThrow();
        }
        expect(native.names.CLUSTER_NAME.source).toBe(/^goobster(-[0-9a-f]{8})?$/.source);
    });
});

describe('data directory rules', () => {
    const check = (value, options) => native.paths.checkDataDirectory(value, options);

    test('accepts an ordinary absolute path', () => {
        expect(check('/srv/goobster-pg')).toEqual({ ok: true, path: '/srv/goobster-pg' });
        expect(check('/var/lib/postgresql/17/goobster')).toEqual({ ok: true, path: '/var/lib/postgresql/17/goobster' });
        expect(check('/mnt/data/pg_17+1.x')).toEqual({ ok: true, path: '/mnt/data/pg_17+1.x' });
    });

    test.each([
        ['', 'INVALID_PATH'],
        ['relative/dir', 'INVALID_PATH'],
        ['/srv/a b', 'INVALID_PATH'],
        ['/srv/../etc/x', 'INVALID_PATH'],
        ['/srv//x', 'INVALID_PATH'],
        ['/srv/x/', 'INVALID_PATH'],
        ['/srv/x\0y', 'INVALID_PATH'],
        [`/srv/${'a'.repeat(200)}`, 'INVALID_PATH'],
        ['/', 'INVALID_PATH'],
        ['/etc', 'PATH_NOT_ALLOWED'],
        ['/etc/postgresql/data', 'PATH_NOT_ALLOWED'],
        ['/usr/local/pg', 'PATH_NOT_ALLOWED'],
        ['/root/pg', 'PATH_NOT_ALLOWED'],
        ['/var', 'PATH_NOT_ALLOWED'],
        ['/srv', 'PATH_NOT_ALLOWED'],
        ['/var/lib/dpkg/pg', 'PATH_NOT_ALLOWED'],
        ['/tmp/pg', 'PATH_NOT_ALLOWED'],
        ['/run/postgresql/data', 'PATH_NOT_ALLOWED'],
        ['/var/tmp/pg', 'PATH_NOT_ALLOWED'],
        ['/var/log/pg', 'PATH_NOT_ALLOWED']
    ])('refuses %j (%s)', (value, code) => {
        const outcome = check(value);
        expect(outcome.ok).toBe(false);
        expect(outcome.code).toBe(code);
        expect(outcome.detail.length).toBeGreaterThan(10);
    });

    test('a transient location is allowed only when a test says so, never an operating-system path', () => {
        expect(check('/tmp/pg-test/data', { allowTransient: true }).ok).toBe(true);
        expect(check('/etc/pg-test', { allowTransient: true }).ok).toBe(false);
    });

    test('recognises the cluster a distribution creates for itself', () => {
        expect(native.paths.isDistributionDirectory('debian', '/var/lib/postgresql/17/main')).toBe(true);
        expect(native.paths.isDistributionDirectory('debian', '/var/lib/postgresql/16/main/base')).toBe(true);
        expect(native.paths.isDistributionDirectory('debian', '/var/lib/postgresql/17/goobster')).toBe(false);
        expect(native.paths.isDistributionDirectory('rhel', '/var/lib/pgsql/17/data')).toBe(true);
        expect(native.paths.isDistributionDirectory('rhel', '/var/lib/pgsql/data')).toBe(true);
        expect(native.paths.isDistributionDirectory('rhel', '/var/lib/pgsql/17/goobster')).toBe(false);
        expect(native.paths.defaultDataDirectory('debian', 'goobster')).toBe('/var/lib/postgresql/17/goobster');
        expect(native.paths.defaultDataDirectory('rhel', 'goobster-7c2a1b9e')).toBe('/var/lib/pgsql/17/goobster-7c2a1b9e');
    });
});

describe('mounts', () => {
    test('parses findmnt and fstab, including an escaped space', () => {
        expect(native.mounts.parseFindmnt('/srv/data ext4 rw,relatime\n')).toEqual({ target: '/srv/data', fstype: 'ext4', options: ['rw', 'relatime'] });
        expect(native.mounts.parseFindmnt('')).toBeNull();
        expect(native.mounts.parseFindmnt('garbage')).toBeNull();
        const listed = native.mounts.fstabTargets('# c\nUUID=1 / ext4 defaults 0 1\nUUID=2 /srv/my\\040disk ext4 defaults 0 2\n');
        expect([...listed].sort()).toEqual(['/', '/srv/my disk']);
    });

    test.each([
        [{ target: '/', fstype: 'ext4', options: ['rw'] }, [], true],
        [{ target: '/srv', fstype: 'tmpfs', options: ['rw'] }, ['MOUNT_NOT_PERSISTENT'], false],
        [{ target: '/srv', fstype: 'nfs4', options: ['rw'] }, ['FILESYSTEM_UNSUPPORTED'], false],
        [{ target: '/srv', fstype: 'fuse.s3fs', options: ['rw'] }, ['FILESYSTEM_UNSUPPORTED'], false],
        [{ target: '/srv', fstype: 'ntfs3', options: ['rw'] }, ['FILESYSTEM_UNSUPPORTED'], false],
        [{ target: '/srv', fstype: 'ext4', options: ['ro'] }, ['MOUNT_READ_ONLY'], false],
        [{ target: '/', fstype: 'overlay', options: ['rw'] }, ['FILESYSTEM_OVERLAY'], true]
    ])('classifies %j', (mount, codes, ok) => {
        const out = native.mounts.classify(mount, { fstabTargets: new Set(['/']) });
        expect(out.issues.map(item => item.code)).toEqual(codes);
        expect(out.ok).toBe(ok);
    });

    test('a mount that is not in fstab blocks unless acknowledged elsewhere, and an unknown mount is only a note', () => {
        const unlisted = native.mounts.classify({ target: '/mnt/pg', fstype: 'ext4', options: ['rw'] }, { fstabTargets: new Set(['/']) });
        expect(unlisted.issues).toEqual([{ code: 'MOUNT_NOT_IN_FSTAB', severity: 'block' }]);
        const listed = native.mounts.classify({ target: '/mnt/pg', fstype: 'ext4', options: ['rw'] }, { fstabTargets: new Set(['/', '/mnt/pg']) });
        expect(listed).toEqual({ ok: true, issues: [] });
        expect(native.mounts.classify(null)).toEqual({ ok: true, issues: [{ code: 'MOUNT_UNKNOWN', severity: 'note' }] });
    });
});

describe('inspection parsers', () => {
    test('pg_lsclusters, dpkg-query, rpm, apt-cache, df and passwd', () => {
        expect(inventory.parseLsClusters('Ver Cluster Port Status Owner Data directory Log file\n17 main 5432 online postgres /var/lib/postgresql/17/main /var/log/postgresql/postgresql-17-main.log\n16 old 5433 down,binaries_missing postgres /var/lib/postgresql/16/old /dev/null\nnoise\n'))
            .toEqual([
                expect.objectContaining({ version: 17, name: 'main', port: 5432, online: true, owner: 'postgres', dataDirectory: '/var/lib/postgresql/17/main' }),
                expect.objectContaining({ version: 16, name: 'old', port: 5433, online: false })
            ]);
        expect(inventory.parseDpkg('postgresql-17 17.4-1 ii \npostgresql-common 262 ii \nhalf 1 rc \n')).toEqual({ 'postgresql-17': '17.4-1', 'postgresql-common': '262' });
        expect(inventory.parseRpm('postgresql17-server 17.4-1PGDG.rhel9\npackage pgvector_17 is not installed\n')).toEqual({ 'postgresql17-server': '17.4-1PGDG.rhel9' });
        expect(inventory.parseAptCandidate('postgresql-17:\n  Installed: (none)\n  Candidate: 17.4-1.pgdg120+2\n')).toBe('17.4-1.pgdg120+2');
        expect(inventory.parseAptCandidate('Candidate: (none)')).toBeNull();
        expect(inventory.parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\n')).toBe(600 * 1024);
        expect(inventory.parseDf('')).toBeNull();
        expect(inventory.passwdEntry('root:x:0:0::/root:/bin/bash\npostgres:x:101:104::/var/lib/postgresql:/bin/bash\n', 'postgres')).toEqual({ name: 'postgres', uid: 101, gid: 104, home: '/var/lib/postgresql', shell: '/bin/bash' });
        expect(inventory.passwdEntry('root:x:0:0::/root:/bin/bash\n', 'postgres')).toBeNull();
    });

    test('package role state distinguishes installed, available and obtainable only from the repository', () => {
        const state = inventory.roleState('debian', { 'postgresql-17': '17.4', 'postgresql-common': '262' }, { 'postgresql-client-17': '17.4' });
        expect(state.server).toEqual(expect.objectContaining({ installed: true, availability: 'installed' }));
        expect(state.client).toEqual(expect.objectContaining({ installed: false, availability: 'available' }));
        expect(state.pgvector).toEqual(expect.objectContaining({ installed: false, availability: 'via-pgdg' }));
        expect(state.contrib).toEqual(expect.objectContaining({ installed: true, availability: 'bundled' }));
    });

    test('the postgres account must be able to search every directory above the data directory', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reach-'));
        try {
            const open = path.join(root, 'open');
            const closed = path.join(root, 'closed', 'inner');
            fs.mkdirSync(open, { recursive: true });
            fs.mkdirSync(closed, { recursive: true });
            fs.chmodSync(root, 0o755);
            fs.chmodSync(path.join(root, 'closed'), 0o700);
            const stranger = { uid: process.getuid() + 12345, gid: process.getgid() + 12345 };
            expect(inventory.reachableBy(stranger, path.join(open, 'pg')).ok).toBe(true);
            const blocked = inventory.reachableBy(stranger, path.join(closed, 'pg'));
            expect(blocked.ok).toBe(false);
            expect(blocked.blockedAt).toBe(path.join(root, 'closed'));
        } finally {
            fs.chmodSync(path.join(root, 'closed'), 0o755);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('the host inspection through fake programs', () => {
    const inspect = async (machine, extra = {}) => inventory.inspectHost({
        env: { PATH: machine.env().PATH, FAKE_NATIVE_STATE: machine.statePath },
        ...machine.nativeDeps(),
        ...extra
    });

    test('reports clusters it does not own as foreign, without their data directory path in the clear for ours only', async () => {
        const machine = fakeNative.create({ distro: 'debian', installed: ['postgresql-17', 'postgresql-common', 'postgresql-client-17'] });
        machine.install();
        try {
            machine.seedForeignCluster({ name: 'main', port: 5432 });
            const report = await inspect(machine);
            expect(report.supported).toBe(true);
            expect(report.clusters).toEqual([expect.objectContaining({ name: 'main', version: 17, port: 5432, owned: false })]);
            expect(report.packages.server.installed).toBe(true);
            expect(report.packages.pgvector.installed).toBe(false);
            expect(machine.mutations()).toEqual([]);
        } finally {
            machine.restore();
        }
    });

    test('a cluster named by the manager\'s record is reported as owned', async () => {
        const machine = fakeNative.create({ distro: 'debian', installed: ['postgresql-17'] });
        machine.install();
        try {
            const foreign = machine.seedForeignCluster({ name: 'goobster', port: 5433 });
            const owned = await inspect(machine, { record: { cluster: { name: 'goobster', dataDirectory: foreign.dataDirectory } } });
            expect(owned.clusters.find(item => item.name === 'goobster').owned).toBe(true);
            const stranger = await inspect(machine);
            expect(stranger.clusters.find(item => item.name === 'goobster').owned).toBe(false);
        } finally {
            machine.restore();
        }
    });

    test('an unsupported distribution is reported and nothing else is asked of the machine', async () => {
        const machine = fakeNative.create({ distro: 'debian' });
        machine.install();
        try {
            const unsupported = native.distro.classify({ release: { ID: 'alpine', VERSION_ID: '3.20' }, arch: 'x64' });
            const report = await inspect(machine, { distro: { ...unsupported, remedy: native.distro.REASONS.DISTRO_UNSUPPORTED } });
            expect(report.supported).toBe(false);
            expect(report.reason).toBe('DISTRO_UNSUPPORTED');
        } finally {
            machine.restore();
        }
    });
});

describe('the read-only command list', () => {
    test.each([
        ['pg_lsclusters', ['--no-header']],
        ['pg_dump', ['--version']],
        ['dpkg-query', ['-W', 'postgresql-17']],
        ['apt-cache', ['policy', 'postgresql-17']],
        ['rpm', ['-q', 'postgresql17']],
        ['dnf', ['-q', '--cacheonly', 'list']],
        ['systemctl', ['is-active', 'postgresql.service']],
        ['/usr/bin/df', ['-Pk', '/']]
    ])('allows %s', (file, args) => {
        expect(() => native.runner.assertAllowed(file, args)).not.toThrow();
    });

    test.each([
        ['apt-get', ['install', 'postgresql-17']],
        ['dnf', ['install', 'postgresql17']],
        ['dnf', ['-q', 'list']],
        ['systemctl', ['start', 'postgresql']],
        ['systemctl', ['enable', 'postgresql']],
        ['pg_dump', ['mydb']],
        ['apt-cache', ['search', 'x']],
        ['rpm', ['-i', 'x.rpm']],
        ['psql', ['-c', 'select 1']],
        ['sh', ['-c', 'id']],
        ['pg_ctlcluster', ['17', 'main', 'stop']],
        ['rm', ['-rf', '/']]
    ])('refuses %s %j', (file, args) => {
        expect(() => native.runner.assertAllowed(file, args)).toThrow(/not a|only ever|not.*command/i);
    });

    test('a refused call never starts a process', async () => {
        const runner = native.runner.createRunner({ execFile: () => { throw new Error('a process was started'); } });
        await expect(Promise.resolve().then(() => runner.run('apt-get', ['install', 'x']))).rejects.toMatchObject({ code: 'FORBIDDEN_COMMAND' });
    });
});
