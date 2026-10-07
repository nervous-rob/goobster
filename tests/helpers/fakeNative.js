/**
 * Fake system programs for the native PostgreSQL option, on a private PATH
 * and as the privileged helper's command directory (tests/helpers/fakeNativeCli.js
 * is what each shim runs). `create()` builds a throwaway "machine": a directory
 * that serves as the helper's sandbox root (`etc/os-release`, `etc/fstab`,
 * `etc/postgresql/...`, `etc/systemd/system`, `bin/<program>`), plus one state
 * file holding installed packages, clusters, units and flags.
 *
 * Nothing here touches this VM's own PostgreSQL: no real apt-get, dnf, psql,
 * pg_ctlcluster or systemctl is ever started, and the real helper runs only as
 * an ordinary user inside the sandbox (GOOBSTER_HELPER_SANDBOX).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const CLI = path.join(__dirname, 'fakeNativeCli.js');
const HELPER = path.join(__dirname, '..', '..', 'apps', 'manager', 'privileged', 'helper.js');

const PROGRAMS = ['apt-get', 'dnf', 'dpkg-query', 'apt-cache', 'rpm', 'pg_lsclusters', 'pg_createcluster', 'pg_ctlcluster', 'pg_dropcluster', 'initdb', 'pg_controldata', 'pg_isready', 'psql', 'runuser', 'systemctl', 'getent', 'getenforce', 'semanage', 'restorecon', 'findmnt', 'df', 'ss', 'curl', 'gpg', 'cp', 'du', 'pg_dump'];

const RELEASES = {
    debian: { ID: 'debian', VERSION_ID: '12', VERSION_CODENAME: 'bookworm', PRETTY_NAME: 'Debian GNU/Linux 12 (bookworm)' },
    ubuntu: { ID: 'ubuntu', VERSION_ID: '24.04', VERSION_CODENAME: 'noble', PRETTY_NAME: 'Ubuntu 24.04 LTS', ID_LIKE: 'debian' },
    rocky: { ID: 'rocky', VERSION_ID: '9.4', PRETTY_NAME: 'Rocky Linux 9.4 (Blue Onyx)', ID_LIKE: 'rhel centos fedora' }
};

const PINNED_KEYS = {
    'https://www.postgresql.org/media/keys/ACCC4CF8.asc': 'B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8',
    'https://download.postgresql.org/pub/repos/yum/keys/PGDG-RPM-GPG-KEY-RHEL': 'D4BF08AE67A0B4C7A1DBCCD240BCA2B408B40D20',
    'https://download.postgresql.org/pub/repos/yum/keys/PGDG-RPM-GPG-KEY-AARCH64-RHEL': 'B031F89FC983E98262906B6E177B343BB9738825'
};

const SERVER = { debian: ['postgresql-17', 'postgresql-common', 'postgresql-client-17', 'postgresql-17-pgvector'], rhel: ['postgresql17-server', 'postgresql17', 'postgresql17-contrib', 'pgvector_17'] };

function release(text) {
    return Object.entries(text).map(([key, value]) => `${key}="${value}"`).join('\n') + '\n';
}

/**
 * @param {Object} [options]
 * @param {'debian'|'ubuntu'|'rocky'} [options.distro]
 * @param {string[]} [options.installed]   package names present
 * @param {Array<Object>} [options.clusters]  `{ version, name, port, online, dataDirectory }`
 * @param {Object} [options.flags]         failure switches (see fakeNativeCli.js)
 */
function create({ distro = 'debian', installed = [], clusters = [], flags = {}, mounts = null, selinux = null, omit = [], available = null, ...extra } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-native-'));
    fs.chmodSync(dir, 0o755);
    const bin = path.join(dir, 'bin');
    const statePath = path.join(dir, 'state.json');
    fs.mkdirSync(bin, { recursive: true });
    for (const sub of ['etc/systemd/system', 'etc/cron.d', 'etc/apt/sources.list.d', 'etc/yum.repos.d', 'var/lib/apt/lists']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, 'etc', 'os-release'), release(RELEASES[distro]));
    fs.writeFileSync(path.join(dir, 'etc', 'fstab'), '# <file system> <mount point> <type> <options> <dump> <pass>\nUUID=1111 / ext4 defaults 0 1\n');
    const family = distro === 'rocky' ? 'rhel' : 'debian';
    const state = {
        sysroot: dir,
        distro,
        family,
        installed,
        available: available || SERVER[family],
        clusters: clusters.map(item => ({ owner: 'postgres', online: true, ...item })),
        accounts: { postgres: { uid: 101, gid: 104, home: '/var/lib/postgresql', shell: '/bin/bash' } },
        keys: PINNED_KEYS,
        flags,
        units: {},
        listening: [],
        mounts: mounts || undefined,
        selinux: selinux || undefined,
        ...extra
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    for (const name of PROGRAMS) {
        if (omit.includes(name) || (name === 'getenforce' && !selinux) || (name === 'semanage' && !selinux) || (name === 'restorecon' && !selinux)) continue;
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "${name}" "${statePath}" "$@"\n`, { mode: 0o755 });
    }
    const saved = { PATH: process.env.PATH };

    const api = {
        dir,
        bin,
        sysroot: dir,
        statePath,
        family,
        env() {
            return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
        },
        install() {
            process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
            return api;
        },
        restore() {
            process.env.PATH = saved.PATH;
            fs.rmSync(dir, { recursive: true, force: true });
        },
        state() {
            return JSON.parse(fs.readFileSync(statePath, 'utf8'));
        },
        set(patch) {
            fs.writeFileSync(statePath, JSON.stringify({ ...api.state(), ...patch }));
            return api;
        },
        flag(name, value = true) {
            const current = api.state();
            fs.writeFileSync(statePath, JSON.stringify({ ...current, flags: { ...current.flags, [name]: value } }));
            return api;
        },
        /** A cluster somebody else owns, with real files so a byte-for-byte comparison means something. */
        seedForeignCluster({ name = 'main', port = 5432, version = 17, online = true, files = {} } = {}) {
            const dataDirectory = `/var/lib/postgresql/${version}/${name}`;
            const data = path.join(dir, 'foreign', `${version}-${name}`);
            fs.mkdirSync(data, { recursive: true });
            const content = { PG_VERSION: `${version}\n`, 'postgresql.conf': `port = ${port}\n`, 'pg_hba.conf': 'local all all peer\n', 'PG_CONTROL': 'foreign-identifier\n', ...files };
            for (const [file, text] of Object.entries(content)) fs.writeFileSync(path.join(data, file), text);
            const config = path.join(dir, 'etc', 'postgresql', String(version), name);
            fs.mkdirSync(config, { recursive: true });
            fs.writeFileSync(path.join(config, 'postgresql.conf'), `port = ${port}\ndata_directory = '${dataDirectory}'\n`);
            fs.writeFileSync(path.join(config, 'pg_hba.conf'), 'local all all peer\n');
            const state = api.state();
            state.clusters.push({ version, name, port, online, dataDirectory, owner: 'postgres', foreignFiles: data });
            fs.writeFileSync(statePath, JSON.stringify(state));
            return { dataDirectory, files: data, config };
        },
        /** A recursive snapshot (relative path -> content) of a directory, for a "left untouched" comparison. */
        snapshot(directory) {
            const out = {};
            const walk = (current) => {
                for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                    const full = path.join(current, entry.name);
                    if (entry.isDirectory()) walk(full);
                    else out[path.relative(directory, full)] = fs.readFileSync(full, 'latin1');
                }
            };
            walk(directory);
            return out;
        },
        calls() {
            try {
                return fs.readFileSync(`${statePath}.calls`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
            } catch {
                return [];
            }
        },
        clearCalls() {
            fs.rmSync(`${statePath}.calls`, { force: true });
        },
        /** Calls that change the machine. */
        mutations() {
            const changing = new Set(['apt-get', 'dnf', 'pg_createcluster', 'pg_ctlcluster', 'pg_dropcluster', 'initdb', 'psql', 'cp', 'semanage', 'restorecon']);
            return api.calls().filter(call => changing.has(call.program) || (call.program === 'systemctl' && ['start', 'stop', 'restart', 'enable', 'disable', 'daemon-reload'].includes(call.args.find(arg => !arg.startsWith('-')))));
        },
        argvText() {
            return api.calls().map(call => `${call.program} ${call.args.join(' ')}`).join('\n');
        },
        /** Everything the programs were handed on stdin. */
        stdinText() {
            return api.calls().map(call => call.stdin || '').join('\n');
        },
        /** `spawn` for elevate.runHelper: the REAL helper process, as an ordinary user, inside this machine. */
        spawn(file, args, options) {
            return childProcess.spawn(file, args, { ...options, env: { ...options.env, GOOBSTER_HELPER_SANDBOX: dir } });
        },
        /** `options` for `privileged.run` that route every operation through that spawn, with no elevation. */
        privilegedOptions(extra = {}) {
            return { platform: 'linux', elevation: { kind: 'root', prefix: [] }, spawn: api.spawn, helperPath: HELPER, ...extra };
        },
        /** What `settings.nativeDeps` needs so the manager reads THIS machine, not the host running the tests. */
        nativeDeps(extra = {}) {
            const distroLib = require('@goobster/core/db/native/distro');
            const parsed = distroLib.parseOsRelease(fs.readFileSync(path.join(dir, 'etc', 'os-release'), 'utf8'));
            const facts = distroLib.classify({ release: parsed, arch: 'x64' });
            const account = state.accounts.postgres;
            return {
                distro: { ...facts, remedy: facts.reason ? distroLib.REASONS[facts.reason] : null },
                passwd: `postgres:x:${account.uid}:${account.gid}::${account.home}:${account.shell}\n`,
                allowTransient: true,
                probePort: async (port) => !api.state().listening.includes(port),
                sleep: async () => {},
                pollMs: 1,
                waitMs: 2000,
                ...extra
            };
        },
        helperDeps(extra = {}) {
            return { sandbox: true, unitDir: path.join(dir, 'etc', 'systemd', 'system'), cronDir: path.join(dir, 'etc', 'cron.d'), updateConf: path.join(dir, 'etc', 'goobster-update.conf'), commandDirs: [bin], sysroot: dir, sleep: () => {}, ...extra };
        }
    };
    return api;
}

module.exports = { create, CLI, HELPER, PROGRAMS, RELEASES, PINNED_KEYS, SERVER };
