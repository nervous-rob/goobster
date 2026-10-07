/**
 * The Linux implementation of the privileged operations
 * (documentation/linux_install.md). Two halves in one file, because a
 * platform module is one thing to drop in:
 *
 *   `createHandler(deps)`  the helper's half: runs as root, inside
 *                          apps/manager/privileged/helper.js, and performs
 *                          exactly the closed operations (the five of the
 *                          installation, and the PostgreSQL ones of
 *                          documentation/native_postgres.md).
 *   `elevation(...)`       the manager's half: how to start the helper
 *                          (`sudo -n`, `pkexec`, or nothing when already
 *                          root) and what to tell an operator when neither
 *                          is possible.
 *
 * Nothing here runs a shell: every command is a fixed program started with
 * an argument vector, from a fixed list of system directories, with a
 * minimal environment. Nothing takes a secret. The helper reads only what
 * the request names plus the installation record that the request must
 * agree with, and writes only the unit file, the cron file or the owner of
 * the roots the request names. Node built-ins and the two sibling modules
 * only (the helper's whole code, see tests/privilegedHelper.test.js).
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const os = require('node:os');
const protocol = require('./protocol');
const { HelperError, refuse } = protocol;
const unitText = require('../platform/systemdUnit');

const PLATFORM = 'linux';
const SYSTEM_COMMAND_DIRS = Object.freeze(['/usr/sbin', '/usr/bin', '/sbin', '/bin']);
const SYSTEMD_RUN_DIR = '/run/systemd/system';
const CRON_DIR = '/etc/cron.d';
const UPDATE_CONF = '/etc/goobster-update.conf';
const DISABLED_PREFIX = '#goobster-manager-disabled: ';
const COMMAND_TIMEOUT_MS = 90_000;
const SHELLS = Object.freeze(['/usr/sbin/nologin', '/sbin/nologin', '/usr/bin/false', '/bin/false']);
const LIVE_STATES = Object.freeze(['active', 'activating', 'reloading']);

/** Operations this platform implements; the rest answer NOT_IMPLEMENTED. */
const OPERATIONS = Object.freeze(['service.register', 'service.unregister', 'user.create', 'updater.disable', 'package.install', 'postgres.cluster.create', 'postgres.cluster.control', 'postgres.cluster.remove', 'postgres.cluster.relocate']);

// ---------------------------------------------------------------------------
// the helper's half
// ---------------------------------------------------------------------------

function defaultExec(file, args, { env, input, timeoutMs } = {}) {
    const result = childProcess.spawnSync(file, args, { encoding: 'utf8', env, input, timeout: timeoutMs || COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status === null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error ? result.error.code || 'EXEC' : null };
}

/**
 * @param {Object} [deps]
 * @param {Object} [deps.fs]
 * @param {string} [deps.unitDir]          where unit files live (default /etc/systemd/system)
 * @param {string} [deps.cronDir]
 * @param {string} [deps.updateConf]
 * @param {string} [deps.systemdRunDir]
 * @param {string[]} [deps.commandDirs]    where the fixed programs are looked up
 * @param {number|null} [deps.euid]
 * @param {number|null} [deps.invokerUid]  the account that asked (sudo/pkexec say who)
 * @param {boolean} [deps.sandbox]         tests: a non-root helper acting on a private tree
 * @param {boolean} [deps.checkReachability] tests: judge directory access even in a sandbox
 * @param {Function} [deps.exec]
 */
function createHandler(deps = {}) {
    const fs = deps.fs || nodeFs;
    const unitDir = deps.unitDir || unitText.UNIT_DIR;
    const cronDir = deps.cronDir || CRON_DIR;
    const updateConf = deps.updateConf || UPDATE_CONF;
    const systemdRunDir = deps.systemdRunDir || SYSTEMD_RUN_DIR;
    const commandDirs = deps.commandDirs || SYSTEM_COMMAND_DIRS;
    const euid = deps.euid !== undefined ? deps.euid : (typeof process.geteuid === 'function' ? process.geteuid() : null);
    const invokerUid = deps.invokerUid !== undefined ? deps.invokerUid : invokerFromEnv(process.env);
    const sandbox = deps.sandbox === true;
    const exec = deps.exec || defaultExec;
    const env = { PATH: commandDirs.join(':'), LC_ALL: 'C', LANG: 'C' };

    function command(name, firstDirs = []) {
        for (const dir of [...firstDirs, ...commandDirs]) {
            const candidate = path.join(dir, name);
            try {
                fs.accessSync(candidate, nodeFs.constants.X_OK);
                return candidate;
            } catch { }
        }
        return null;
    }

    function run(log, name, args, { allowFailure = false, input, extraEnv, timeoutMs } = {}) {
        const absolute = name.startsWith('/');
        const file = absolute ? name : command(name);
        if (!file) throw refuse('COMMAND_MISSING', `${name} is not installed on this system.`);
        const label = absolute ? path.basename(name) : name;
        const result = exec(file, args, { env: extraEnv ? { ...env, ...extraEnv } : env, input, timeoutMs });
        log.push(`${label} ${args.filter(arg => /^[a-z-]/.test(arg) && !arg.includes('/')).slice(0, 4).join(' ')} -> ${result.status}`);
        if (result.status !== 0 && !allowFailure) {
            const reason = redactSecrets(String(result.stderr || result.stdout || '')).split('\n').find(line => line.trim()) || `exit ${result.status}`;
            throw refuse('COMMAND_FAILED', `${label} failed: ${reason.slice(0, 160)}`);
        }
        return result;
    }

    function requireElevated() {
        if (sandbox) return;
        if (euid !== 0) throw refuse('NOT_ELEVATED', 'The helper is not running as root.');
    }

    function requireSystemd() {
        if (sandbox) return;
        if (!fs.existsSync(systemdRunDir)) throw refuse('SYSTEMD_UNAVAILABLE', 'systemd is not the init system of this machine, or is not running.');
    }

    function readText(file) {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch (error) {
            if (error && error.code === 'ENOENT') return null;
            throw error;
        }
    }

    /** The installation record at the manager store must agree with the request. */
    function verifyRecord(input) {
        const text = readText(path.join(input.roots.managerStore, 'installation.json'));
        let doc = null;
        try {
            doc = text ? JSON.parse(text) : null;
        } catch { }
        if (!doc || doc.installationId !== input.installationId) {
            throw refuse('INSTALLATION_MISMATCH', 'The installation record does not name this installation id.');
        }
        if (doc.roots) {
            for (const role of Object.keys(input.roots)) {
                if (doc.roots[role] !== input.roots[role]) throw refuse('INSTALLATION_MISMATCH', `The installation record names another ${role} root.`);
            }
        }
    }

    function verifyInstall(input) {
        if (input.mode === 'payload') {
            const current = path.join(input.codeRoot, 'current');
            for (const rel of ['payload-manifest.json', 'runtime/bin/node', 'app/apps/manager/index.js']) {
                if (!fs.existsSync(path.join(current, rel))) throw refuse('PAYLOAD_MISSING', 'The code root holds no activated payload; install it before registering the service.');
            }
        } else {
            if (!fs.existsSync(path.join(input.codeRoot, 'apps', 'manager', 'index.js'))) throw refuse('PAYLOAD_MISSING', 'The code root holds no manager.');
            if (!input.nodePath || !fs.existsSync(input.nodePath)) throw refuse('PAYLOAD_MISSING', 'The node path does not exist.');
        }
    }

    function lookupUser(name) {
        const result = exec(command('getent') || 'getent', ['passwd', name], { env });
        if (result.status !== 0 || !result.stdout.trim()) return null;
        const fields = result.stdout.trim().split('\n')[0].split(':');
        return { name: fields[0], uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] || null, shell: fields[6] || null };
    }

    /** Whether `user` can search (x) every directory above `target`, judged from owner, primary group and mode. */
    function unreachableAncestor(user, target) {
        if (sandbox && deps.checkReachability !== true) return null;
        let dir = path.dirname(target);
        for (;;) {
            let stat;
            try {
                stat = fs.statSync(dir);
            } catch {
                return null;
            }
            const bit = stat.uid === user.uid ? 0o100 : (stat.gid === user.gid ? 0o010 : 0o001);
            if ((stat.mode & bit) === 0) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    }

    function unitPathFor(name) {
        return path.join(unitDir, unitText.unitFileName(name));
    }

    function markerOf(file) {
        const text = readText(file);
        return text === null ? { present: false, installationId: null } : { present: true, installationId: unitText.parseUnit(text).installationId };
    }

    function writeAtomic(file, text, mode) {
        const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
        const fd = fs.openSync(tmp, 'w', mode);
        try {
            fs.writeSync(fd, text);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    }

    function otherUnitsOf(installationId, ownFile) {
        const found = [];
        let entries = [];
        try {
            entries = fs.readdirSync(unitDir);
        } catch { }
        for (const entry of entries) {
            if (!entry.endsWith('.service')) continue;
            const file = path.join(unitDir, entry);
            if (file === ownFile) continue;
            if (markerOf(file).installationId === installationId) found.push(entry);
        }
        return found;
    }

    // ---- service.register -------------------------------------------------
    function serviceRegister(input, log) {
        if (input.kind !== 'systemd') throw refuse('NOT_IMPLEMENTED', 'This platform registers systemd services only.');
        requireElevated();
        requireSystemd();
        verifyRecord(input);
        verifyInstall(input);
        const runtimeAccount = lookupUser(input.runtimeUser);
        if (!runtimeAccount) throw refuse('RUNTIME_USER_MISSING', 'The runtime user does not exist; create it first.');
        for (const target of [input.codeRoot, ...unitText.ownedPaths({ roots: input.roots, mode: input.mode })]) {
            const blocked = unreachableAncestor(runtimeAccount, target);
            if (blocked) {
                throw refuse('ROOT_NOT_REACHABLE', `${input.runtimeUser} cannot enter ${blocked}, which holds ${target}; give it search permission (chmod o+x '${blocked}') and run the install again.`);
            }
        }
        const file = unitPathFor(input.name);
        const duplicates = otherUnitsOf(input.installationId, file);
        if (duplicates.length > 0) throw refuse('SERVICE_DUPLICATE', `Another unit of this installation is registered (${duplicates[0]}); unregister it first.`);
        const existing = markerOf(file);
        if (existing.present && existing.installationId !== input.installationId) {
            throw refuse('SERVICE_FOREIGN', `${path.basename(file)} exists and was not registered by this installation; it was left as it is.`);
        }
        const text = unitText.renderUnit({
            name: input.name,
            installationId: input.installationId,
            runtimeUser: input.runtimeUser,
            codeRoot: input.codeRoot,
            roots: input.roots,
            layout: input.layout,
            mode: input.mode,
            nodePath: input.nodePath
        });
        let written = false;
        if (readText(file) !== text) {
            writeAtomic(file, text, 0o644);
            written = true;
            log.push('unit written');
        } else {
            log.push('unit unchanged');
        }
        if (!sandbox || command('systemctl')) {
            run(log, 'systemctl', ['daemon-reload']);
            run(log, 'systemctl', ['enable', '--now', unitText.unitFileName(input.name)]);
        }
        const state = (command('systemctl') ? run(log, 'systemctl', ['is-active', unitText.unitFileName(input.name)], { allowFailure: true }).stdout.trim() : 'unknown') || 'unknown';
        return { outcome: written ? 'done' : 'noop', detail: { unit: unitText.unitFileName(input.name), written, active: state } };
    }

    // ---- service.unregister -----------------------------------------------
    function serviceUnregister(input, log) {
        if (input.kind !== 'systemd') throw refuse('NOT_IMPLEMENTED', 'This platform registers systemd services only.');
        requireElevated();
        const file = unitPathFor(input.name);
        const existing = markerOf(file);
        if (!existing.present) {
            log.push('unit already absent');
            return { outcome: 'noop', detail: { unit: unitText.unitFileName(input.name), removed: false } };
        }
        if (existing.installationId !== input.installationId) {
            throw refuse('SERVICE_FOREIGN', `${path.basename(file)} was not registered by this installation; it was left as it is.`);
        }
        const online = sandbox ? Boolean(command('systemctl')) : fs.existsSync(systemdRunDir);
        if (online) {
            run(log, 'systemctl', ['disable', '--now', unitText.unitFileName(input.name)], { allowFailure: true });
            const state = run(log, 'systemctl', ['is-active', unitText.unitFileName(input.name)], { allowFailure: true }).stdout.trim();
            if (LIVE_STATES.includes(state)) throw refuse('SERVICE_STILL_ACTIVE', `${path.basename(file)} is still ${state}; it was not removed.`);
        } else {
            log.push('systemd is not running: only the unit file is removed');
        }
        fs.rmSync(file, { force: true });
        if (online) {
            run(log, 'systemctl', ['daemon-reload']);
            run(log, 'systemctl', ['reset-failed', unitText.unitFileName(input.name)], { allowFailure: true });
        }
        return { outcome: 'done', detail: { unit: unitText.unitFileName(input.name), removed: true } };
    }

    // ---- user.create ------------------------------------------------------
    function ensureOwned(target, user, log) {
        let stat;
        try {
            stat = fs.lstatSync(target);
        } catch (error) {
            if (error && error.code === 'ENOENT') return false;
            throw error;
        }
        if (stat.isSymbolicLink()) throw refuse('ROOT_IS_SYMLINK', 'A root to hand over is a symbolic link; nothing was changed there.');
        if (fs.realpathSync(target) !== target) throw refuse('ROOT_IS_SYMLINK', 'A root to hand over lies behind a symbolic link; nothing was changed there.');
        const allowed = [0, user.uid];
        if (invokerUid !== null && invokerUid !== undefined) allowed.push(invokerUid);
        if (!sandbox && !allowed.includes(stat.uid)) throw refuse('ROOT_NOT_OWNED', 'A root to hand over belongs to another account; nothing was changed there.');
        run(log, 'chown', ['-R', '-h', `${user.name}:`, '--', target]);
        return true;
    }

    function userCreate(input, log) {
        requireElevated();
        verifyRecord(input);
        let user = lookupUser(input.name);
        let created = false;
        if (!user) {
            const shell = SHELLS.find(candidate => fs.existsSync(candidate)) || '/usr/sbin/nologin';
            run(log, 'useradd', ['--system', '--no-create-home', '--home-dir', input.home, '--shell', shell, '--user-group', input.name]);
            created = true;
            user = lookupUser(input.name);
            if (!user && !sandbox) throw refuse('COMMAND_FAILED', 'The account was not created.');
        }
        if (!user) user = { name: input.name, uid: -1, gid: -1 };
        if (user.uid === 0) throw refuse('USER_REFUSED', 'The account is the superuser; nothing was changed.');
        // A root that is (or holds) the asking person's home directory would
        // hand their whole home to the service account; the path rules only
        // keep `/home` itself out, so the invoker's own entry is checked here.
        const invoker = invokerUid !== null && invokerUid !== undefined && invokerUid !== user.uid ? lookupUser(String(invokerUid)) : null;
        const owned = unitText.ownedPaths({ roots: input.roots, mode: input.mode });
        if (invoker && invoker.home && invoker.home !== '/' && owned.some(target => target === invoker.home || invoker.home.startsWith(`${target}/`))) {
            throw refuse('ROOT_IS_HOME', 'A root to hand over is, or holds, the home directory of the account that asked; nothing was changed.');
        }
        let handedOver = 0;
        for (const target of owned) {
            if (!fs.existsSync(target) && target !== input.roots.config) {
                fs.mkdirSync(target, { recursive: true, mode: 0o750 });
            }
            if (ensureOwned(target, user, log)) handedOver++;
        }
        return { outcome: created ? 'done' : 'noop', detail: { user: input.name, created, roots: handedOver } };
    }

    // ---- updater.disable --------------------------------------------------
    function property(log, unit, name) {
        const result = run(log, 'systemctl', ['show', unit, `--property=${name}`, '--value'], { allowFailure: true });
        return result.status === 0 ? result.stdout.trim() : '';
    }

    function repoDirFromConf() {
        const text = readText(updateConf);
        const match = text ? /^\s*(?:export\s+)?GOOBSTER_REPO_DIR=(.+)$/m.exec(text) : null;
        return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
    }

    function pointsAt(codeRoot, ...values) {
        return values.some(value => value && (value === codeRoot || value.startsWith(`${codeRoot}/`) || value.includes(`${codeRoot}/`) || value.includes(`path=${codeRoot}`)));
    }

    function updaterDisableTimer(input, log) {
        requireSystemd();
        const service = property(log, input.unit, 'Unit') || input.unit.replace(/\.timer$/, '.service');
        const workingDirectory = property(log, service, 'WorkingDirectory');
        const execStart = property(log, service, 'ExecStart');
        const repo = repoDirFromConf();
        if (!pointsAt(input.codeRoot, workingDirectory, execStart, repo)) {
            throw refuse('UPDATER_NOT_OURS', 'The timer does not update this installation; it was left as it is.');
        }
        const enabled = run(log, 'systemctl', ['is-enabled', input.unit], { allowFailure: true }).stdout.trim();
        const active = run(log, 'systemctl', ['is-active', input.unit], { allowFailure: true }).stdout.trim();
        if (!['enabled', 'static', 'linked', 'enabled-runtime'].includes(enabled) && !LIVE_STATES.includes(active)) {
            return { outcome: 'noop', detail: { unit: input.unit, disabled: false, already: true } };
        }
        run(log, 'systemctl', ['disable', '--now', input.unit]);
        return { outcome: 'done', detail: { unit: input.unit, disabled: true } };
    }

    function updaterDisableCron(input, log) {
        const file = path.join(cronDir, input.unit);
        const text = readText(file);
        if (text === null) return { outcome: 'noop', detail: { unit: input.unit, lines: 0, already: true } };
        let changed = 0;
        const next = text.split('\n').map((line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('auto-update.sh') && trimmed.includes(input.codeRoot)) {
                changed++;
                return `${DISABLED_PREFIX}${line}`;
            }
            return line;
        }).join('\n');
        if (changed === 0) {
            if (text.includes(DISABLED_PREFIX)) return { outcome: 'noop', detail: { unit: input.unit, lines: 0, already: true } };
            throw refuse('UPDATER_NOT_OURS', 'The cron file holds no line that updates this installation; it was left as it is.');
        }
        const mode = fs.statSync(file).mode & 0o777;
        writeAtomic(file, next, mode);
        log.push(`cron file rewritten (${changed} line${changed === 1 ? '' : 's'} commented)`);
        return { outcome: 'done', detail: { unit: input.unit, lines: changed } };
    }

    function updaterDisable(input, log) {
        requireElevated();
        return input.mechanism === 'systemd-timer' ? updaterDisableTimer(input, log) : updaterDisableCron(input, log);
    }

    const sysroot = deps.sysroot !== undefined ? deps.sysroot : (sandbox ? path.resolve(unitDir, '..', '..', '..') : '');
    const native = nativeOperations({
        fs,
        sandbox,
        deps,
        sys: (file) => (sysroot ? path.join(sysroot, file) : file),
        run,
        command,
        requireElevated,
        requireSystemd,
        readText,
        writeAtomic,
        lookupUser,
        unreachableAncestor,
        systemdLive: () => (sandbox ? Boolean(command('systemctl')) : fs.existsSync(systemdRunDir))
    });

    const table = {
        'service.register': serviceRegister,
        'service.unregister': serviceUnregister,
        'user.create': userCreate,
        'updater.disable': updaterDisable,
        ...native
    };

    /**
     * @param {string} operation
     * @param {Object} input the validated input (protocol.validateInput)
     * @returns {{ outcome: 'done'|'noop', detail: Object, log: string[] }}
     * @throws {HelperError}
     */
    function handle(operation, input) {
        const log = [];
        const action = table[operation];
        if (!action) throw refuse('NOT_IMPLEMENTED', `${operation} is not implemented on Linux.`);
        try {
            const result = action(input, log);
            return { ...result, log };
        } catch (error) {
            if (error instanceof HelperError) {
                error.log = log;
                throw error;
            }
            const failure = refuse('HELPER_FAILED', `The operation failed (${error && error.code ? error.code : 'error'}).`);
            failure.log = log;
            throw failure;
        }
    }

    return { handle, lookupUser, unitPathFor };
}

// ---------------------------------------------------------------------------
// native PostgreSQL (documentation/native_postgres.md)
// ---------------------------------------------------------------------------

/**
 * The pinned PGDG repositories. packages/core/db/native/pgdg.js holds the same
 * values for the planner; the helper may load nothing outside its hashed files,
 * so it carries its own copy and tests/nativePostgresAdapters.test.js keeps the
 * two equal.
 */
const NATIVE = Object.freeze({
    major: protocol.PG_MAJOR,
    apt: Object.freeze({
        keyUrl: 'https://www.postgresql.org/media/keys/ACCC4CF8.asc',
        fingerprint: 'B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8',
        repositoryUrl: 'https://apt.postgresql.org/pub/repos/apt',
        component: 'main',
        keyFile: '/etc/apt/keyrings/goobster-pgdg.asc',
        sourcesFile: '/etc/apt/sources.list.d/goobster-pgdg.sources',
        architectures: Object.freeze({ x64: 'amd64', arm64: 'arm64' })
    }),
    rpm: Object.freeze({
        baseUrl: `https://download.postgresql.org/pub/repos/yum/${protocol.PG_MAJOR}/redhat/rhel-9-`,
        keys: Object.freeze({
            x64: Object.freeze({ url: 'https://download.postgresql.org/pub/repos/yum/keys/PGDG-RPM-GPG-KEY-RHEL', fingerprint: 'D4BF08AE67A0B4C7A1DBCCD240BCA2B408B40D20', basearch: 'x86_64' }),
            arm64: Object.freeze({ url: 'https://download.postgresql.org/pub/repos/yum/keys/PGDG-RPM-GPG-KEY-AARCH64-RHEL', fingerprint: 'B031F89FC983E98262906B6E177B343BB9738825', basearch: 'aarch64' })
        }),
        keyFile: '/etc/pki/rpm-gpg/goobster-PGDG-RPM-GPG-KEY',
        repoFile: '/etc/yum.repos.d/goobster-pgdg17.repo',
        repoId: 'goobster-pgdg17'
    }),
    layouts: Object.freeze({
        debian: Object.freeze({ binDir: `/usr/lib/postgresql/${protocol.PG_MAJOR}/bin`, extensionDir: `/usr/share/postgresql/${protocol.PG_MAJOR}/extension`, socketDir: '/var/run/postgresql', mainDataRoot: '/var/lib/postgresql', configRoot: '/etc/postgresql' }),
        rhel: Object.freeze({ binDir: `/usr/pgsql-${protocol.PG_MAJOR}/bin`, extensionDir: `/usr/pgsql-${protocol.PG_MAJOR}/share/extension`, socketDir: '/run/postgresql', mainDataRoot: '/var/lib/pgsql', configRoot: null })
    }),
    /** Closed refusals about a file system (packages/core/db/native/mounts.js holds the same). */
    mounts: Object.freeze({
        transient: Object.freeze(['tmpfs', 'ramfs', 'devtmpfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'squashfs', 'iso9660', 'overlay-ro']),
        unsuitable: Object.freeze(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', '9p', 'vfat', 'exfat', 'msdos', 'ntfs', 'ntfs3', 'fuseblk', 'sshfs', 'fuse.sshfs', 'fuse.gvfsd-fuse', 'vboxsf'])
    }),
    marker: 'goobster-installation',
    relocating: 'goobster-relocating',
    stateFile: 'native-postgres.json',
    minFreeBytes: 1024 * 1024 * 1024,
    installTimeoutMs: 20 * 60_000,
    createTimeoutMs: 10 * 60_000,
    /** Where a database never belongs: cleaned by the system, or not ours to build in. */
    forbiddenTrees: Object.freeze(['/tmp', '/var/tmp', '/dev', '/run', '/proc', '/sys', '/var/run', '/var/cache', '/var/log', '/var/spool', '/var/mail'])
});

const SECRET_TEXT = /SCRAM-SHA-256\$\S+/g;
const redactSecrets = (text) => String(text).replace(SECRET_TEXT, '<verifier>');
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function nativeOperations(kit) {
    const { fs, sandbox, sys, run, command, requireElevated, readText, writeAtomic, lookupUser, unreachableAncestor, systemdLive, deps } = kit;
    const sleep = deps.sleep || sleepSync;
    const isInside = (parent, child) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

    function distro() {
        const text = readText(sys('/etc/os-release'));
        const release = {};
        for (const line of String(text || '').split('\n')) {
            const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
            if (match) release[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
        const id = String(release.ID || '').toLowerCase();
        const versionId = String(release.VERSION_ID || '');
        let family = null;
        let codename = null;
        if (id === 'debian' && versionId.split('.')[0] === '12') {
            family = 'debian';
            codename = 'bookworm';
        } else if (id === 'ubuntu' && /^\d{2}\.\d{2}$/.test(versionId) && Number(versionId.split('.')[0]) * 100 + Number(versionId.split('.')[1]) >= 2204) {
            family = 'debian';
            codename = /^[a-z]{3,20}$/.test(release.VERSION_CODENAME || '') ? release.VERSION_CODENAME : null;
        } else if ((id === 'almalinux' || id === 'rocky') && versionId.split('.')[0] === '9') {
            family = 'rhel';
        }
        if (!family || (family === 'debian' && !codename)) throw refuse('DISTRO_UNSUPPORTED', 'A managed native PostgreSQL is supported on Debian 12, Ubuntu 22.04 or later, and AlmaLinux or Rocky Linux 9.');
        const arch = deps.arch || process.arch;
        if (arch !== 'x64' && arch !== 'arm64') throw refuse('ARCH_UNSUPPORTED', 'PostgreSQL packages are published for x86-64 and 64-bit ARM only.');
        return { family, id, versionId, codename, arch, layout: NATIVE.layouts[family] };
    }

    /** Programs of PostgreSQL itself are looked up in the family's own bin directory first. */
    const pgProgram = (d, name) => command(name, sandbox ? [] : [d.layout.binDir]);

    const forkPg = (log, d, name, args, options = {}) => {
        const file = pgProgram(d, name);
        if (!file) throw refuse('COMMAND_MISSING', `${name} is not installed on this system.`);
        return run(log, file, args, options);
    };

    function runAsPostgres(log, d, name, args, options = {}) {
        const runuser = command('runuser');
        if (!runuser) throw refuse('COMMAND_MISSING', 'runuser is not installed on this system.');
        const program = pgProgram(d, name);
        if (!program) throw refuse('COMMAND_MISSING', `${name} is not installed on this system.`);
        return run(log, 'runuser', ['-u', 'postgres', '--', program, ...args], options);
    }

    // ---- the record and the marker -----------------------------------------------------
    function verifyNativeRecord(input, { expectDataDirectory = null } = {}) {
        const installation = readText(path.join(input.managerStore, 'installation.json'));
        let doc = null;
        try { doc = installation ? JSON.parse(installation) : null; } catch { }
        if (!doc || doc.installationId !== input.installationId) throw refuse('INSTALLATION_MISMATCH', 'The installation record does not name this installation id.');
        const text = readText(path.join(input.managerStore, NATIVE.stateFile));
        let record = null;
        try { record = text ? JSON.parse(text) : null; } catch { }
        if (!record || record.installationId !== input.installationId || !record.cluster || record.cluster.name !== input.clusterName) {
            throw refuse('RECORD_MISMATCH', 'The manager\'s native PostgreSQL record does not name this cluster for this installation.');
        }
        if (expectDataDirectory && record.cluster.dataDirectory !== expectDataDirectory) throw refuse('RECORD_MISMATCH', 'The manager\'s record names another data directory.');
        return record;
    }

    const markerText = (dataDirectory) => {
        const text = readText(path.join(dataDirectory, NATIVE.marker));
        return text === null ? null : text.trim();
    };

    // ---- cluster facts -------------------------------------------------------
    function resourcesOf(d, name) {
        if (d.family === 'debian') {
            return { service: `postgresql@${NATIVE.major}-${name}.service`, configDirectory: `${NATIVE.layouts.debian.configRoot}/${NATIVE.major}/${name}`, dropIn: `/etc/systemd/system/postgresql@${NATIVE.major}-${name}.service.d/goobster.conf` };
        }
        return { service: `postgresql${NATIVE.major}-${name}.service`, unitFile: `/etc/systemd/system/postgresql${NATIVE.major}-${name}.service` };
    }

    function debianClusters(log) {
        if (!command('pg_lsclusters')) return [];
        const listing = run(log, 'pg_lsclusters', ['--no-header'], { allowFailure: true });
        const out = [];
        for (const raw of listing.stdout.split('\n')) {
            const fields = raw.trim().split(/\s+/);
            if (fields.length < 6 || !/^\d{1,2}$/.test(fields[0]) || !/^\d{1,5}$/.test(fields[2])) continue;
            out.push({ version: Number(fields[0]), name: fields[1], port: Number(fields[2]), online: fields[3].startsWith('online'), dataDirectory: fields[5] });
        }
        return out;
    }

    /** What the unit file of an RPM-family cluster of ours names. */
    function unitFacts(file) {
        const text = readText(sys(file));
        if (text === null) return null;
        const data = /^Environment=PGDATA=(\S+)$/m.exec(text);
        const marker = /^# goobster-installation: (\S+)$/m.exec(text);
        return { text, dataDirectory: data ? data[1] : null, installationId: marker ? marker[1] : null };
    }

    function otherClusters(d, log, ownName) {
        if (d.family === 'debian') return debianClusters(log).filter(item => !(item.version === NATIVE.major && item.name === ownName));
        const out = [];
        const root = sys(NATIVE.layouts.rhel.mainDataRoot);
        let majors = [];
        try { majors = fs.readdirSync(root); } catch { }
        for (const major of majors) {
            let dirs;
            try { dirs = fs.readdirSync(path.join(root, major)); } catch { continue; }
            for (const dir of dirs) {
                const full = path.posix.join(NATIVE.layouts.rhel.mainDataRoot, major, dir);
                if (fs.existsSync(path.join(root, major, dir, 'PG_VERSION'))) out.push({ version: Number(major) || 0, name: dir === 'data' ? 'main' : dir, port: null, online: false, dataDirectory: full });
            }
        }
        return out.filter(item => !(item.version === NATIVE.major && item.name === ownName));
    }

    function clusterFacts(d, log, name) {
        if (d.family === 'debian') {
            const found = debianClusters(log).find(item => item.version === NATIVE.major && item.name === name);
            return found ? { exists: true, dataDirectory: found.dataDirectory, port: found.port, online: found.online } : { exists: false, dataDirectory: null, port: null, online: false };
        }
        const resources = resourcesOf(d, name);
        const unit = unitFacts(resources.unitFile);
        if (!unit) return { exists: false, dataDirectory: null, port: null, online: false };
        let online = false;
        if (systemdLive()) online = run(log, 'systemctl', ['is-active', resources.service], { allowFailure: true }).stdout.trim() === 'active';
        return { exists: true, dataDirectory: unit.dataDirectory, port: null, online, unit };
    }

    function ssListening(log) {
        if (!command('ss')) return null;
        const out = run(log, 'ss', ['-H', '-ltn'], { allowFailure: true });
        if (out.status !== 0) return null;
        const ports = new Set();
        for (const line of out.stdout.split('\n')) {
            const match = /:(\d{1,5})\s+\S+\s*$/.exec(line.trim().replace(/\s+/g, ' ').replace(/ users:.*$/, ''));
            if (match) ports.add(Number(match[1]));
        }
        return ports;
    }

    function assertPortFree(d, log, port, ownName) {
        const taken = otherClusters(d, log, ownName).find(item => item.port === port);
        if (taken) throw refuse('PORT_IN_USE', `Port ${port} belongs to another PostgreSQL cluster on this machine.`);
        const listening = ssListening(log);
        if (listening && listening.has(port)) throw refuse('PORT_IN_USE', `Something on this machine already listens on port ${port}.`);
    }

    // ---- the directory rules --------------------------------------------------
    function mountOf(log, nearest) {
        if (!command('findmnt')) return null;
        const found = run(log, 'findmnt', ['-n', '-o', 'TARGET,FSTYPE,OPTIONS', '--target', nearest], { allowFailure: true });
        const line = found.stdout.split('\n').map(item => item.trim()).find(Boolean);
        if (!line) return null;
        const parts = line.split(/\s+/);
        return parts.length >= 2 && parts[0].startsWith('/') ? { target: parts[0], fstype: parts[1].toLowerCase(), options: (parts[2] || '').split(',') } : null;
    }

    function fstabTargets() {
        const text = readText(sys('/etc/fstab'));
        if (text === null) return null;
        const out = new Set();
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const fields = line.split(/\s+/);
            if (fields.length >= 2) out.add(fields[1]);
        }
        return out;
    }

    function nearestExisting(target) {
        let current = target;
        for (let depth = 0; depth < 64; depth++) {
            try {
                fs.statSync(current);
                return current;
            } catch {
                const parent = path.dirname(current);
                if (parent === current) return null;
                current = parent;
            }
        }
        return null;
    }

    /**
     * Refuse a data directory that is not safe to build a database in. `ours` is a
     * directory of this installation that may already hold its own cluster or a
     * partial copy (a resume); everything else must be absent or empty.
     */
    function assertDataDirectory(d, log, target, { acknowledgeMount = false, ours = false, others = [], exceptInside = null } = {}) {
        if (!sandbox) {
            for (const tree of NATIVE.forbiddenTrees) {
                if (isInside(tree, target)) throw refuse('PATH_NOT_ALLOWED', 'A database is not built under /tmp, /run, /dev or another place the system cleans.');
            }
        }
        for (const other of others) {
            if (other.dataDirectory && (isInside(other.dataDirectory, target) || isInside(target, other.dataDirectory))) {
                throw refuse('DATA_DIRECTORY_IN_USE', 'The directory is, or contains, the data directory of another PostgreSQL cluster. It was not touched.');
            }
        }
        if (exceptInside && (isInside(exceptInside, target) || isInside(target, exceptInside))) throw refuse('DATA_DIRECTORY_IN_USE', 'The target and the current data directory overlap.');
        let stat = null;
        try { stat = fs.lstatSync(target); } catch { }
        if (stat) {
            if (stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw refuse('PATH_NOT_ALLOWED', 'The data directory is, or lies behind, a symbolic link.');
            if (!stat.isDirectory()) throw refuse('DATA_DIRECTORY_NOT_DIRECTORY', 'The data directory exists and is not a directory.');
            if (!ours && fs.readdirSync(target).length > 0) throw refuse('DATA_DIRECTORY_NOT_EMPTY', 'The data directory is not empty; it was left as it is.');
        }
        const nearest = nearestExisting(target);
        if (!nearest) throw refuse('PATH_NOT_ALLOWED', 'The data directory has no existing parent.');
        const mount = mountOf(log, nearest);
        if (mount) {
            const type = mount.fstype;
            if (NATIVE.mounts.transient.includes(type)) throw refuse('MOUNT_NOT_PERSISTENT', `The directory is on a ${type} file system, which does not survive a reboot.`);
            if (NATIVE.mounts.unsuitable.includes(type) || type.startsWith('fuse.')) throw refuse('FILESYSTEM_UNSUPPORTED', `A database cannot live on a ${type} file system (no Unix ownership, modes or reliable locking).`);
            if (mount.options.includes('ro')) throw refuse('MOUNT_READ_ONLY', 'The directory is on a read-only mount.');
            if (mount.target !== '/' && !acknowledgeMount) {
                const listed = fstabTargets();
                if (listed && !listed.has(mount.target)) throw refuse('MOUNT_NOT_PERSISTENT', 'The directory is on a mount that is not listed in /etc/fstab, so it may be missing after a reboot; add it there, or acknowledge the risk.');
            }
        }
        const account = lookupUser('postgres');
        if (!account) throw refuse('POSTGRES_ACCOUNT_MISSING', 'The distribution\'s postgres account does not exist; install the server package first.');
        const blocked = unreachableAncestor(account, target);
        if (blocked) throw refuse('ROOT_NOT_REACHABLE', `postgres cannot enter ${blocked}, which holds the data directory; give it search permission or choose another directory.`);
        if (typeof fs.statfsSync === 'function') {
            try {
                const free = Number(fs.statfsSync(nearest).bavail) * Number(fs.statfsSync(nearest).bsize);
                if (Number.isFinite(free) && free < NATIVE.minFreeBytes) throw refuse('STORAGE_FULL', 'There is not enough free space under the data directory (1 GiB is the least).');
            } catch (error) {
                if (error instanceof HelperError) throw error;
            }
        }
        return { account, mount };
    }

    function ensureLeaf(target, account) {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        fs.chmodSync(target, 0o700);
        chownTo(target, account);
    }

    function chownTo(file, account) {
        if (sandbox || !account) return;
        try { fs.chownSync(file, account.uid, account.gid); } catch { }
    }

    function writeOwned(file, text, mode, account) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, text, mode);
        chownTo(file, account);
    }

    // ---- package.install ------------------------------------------------------------
    function installedNames(d, log, names) {
        if (d.family === 'debian') {
            if (!command('dpkg-query')) return new Set();
            const out = run(log, 'dpkg-query', ['-W', '-f=${Package} ${Version} ${db:Status-Abbrev}\\n', ...names], { allowFailure: true });
            return new Set(out.stdout.split('\n').map(line => line.trim().split(/\s+/)).filter(fields => fields.length >= 3 && /^ii/.test(fields[2])).map(fields => fields[0]));
        }
        if (!command('rpm')) return new Set();
        const out = run(log, 'rpm', ['-q', '--qf', '%{NAME}\\n', ...names], { allowFailure: true });
        return new Set(out.stdout.split('\n').map(line => line.trim()).filter(line => names.includes(line)));
    }

    function verifyKeyFingerprint(log, keyUrl, expected) {
        const gpg = command('gpg');
        const curl = command('curl');
        if (!curl) throw refuse('COMMAND_MISSING', 'curl is not installed on this system; install the prerequisites first.');
        if (!gpg) throw refuse('COMMAND_MISSING', 'gpg is not installed on this system; install the prerequisites first.');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-key-'));
        try {
            fs.chmodSync(dir, 0o700);
            const file = path.join(dir, 'key.asc');
            run(log, 'curl', ['-fsSL', '--proto', '=https', '--tlsv1.2', '--max-time', '60', '--max-filesize', '1000000', '-o', file, keyUrl]);
            const listing = run(log, 'gpg', ['--batch', '--no-tty', '--show-keys', '--with-colons', '--fingerprint', file]);
            const lines = listing.stdout.split('\n');
            const primaries = lines.filter(line => line.startsWith('pub:')).length;
            const first = lines.find(line => line.startsWith('fpr:'));
            const fingerprint = first ? String(first.split(':')[9] || '').toUpperCase() : '';
            if (primaries !== 1 || fingerprint !== expected) {
                throw refuse('PGDG_KEY_MISMATCH', 'The signing key downloaded for the PostgreSQL repository is not the pinned one; nothing was added.');
            }
            return fs.readFileSync(file, 'utf8');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    function aptSourceExists() {
        const files = [sys('/etc/apt/sources.list')];
        try { for (const entry of fs.readdirSync(sys('/etc/apt/sources.list.d'))) files.push(sys(`/etc/apt/sources.list.d/${entry}`)); } catch { }
        return files.some(file => file !== sys(NATIVE.apt.sourcesFile) && /apt\.postgresql\.org/.test(readText(file) || ''));
    }

    function rpmRepoExists() {
        const files = [];
        try { for (const entry of fs.readdirSync(sys('/etc/yum.repos.d'))) files.push(sys(`/etc/yum.repos.d/${entry}`)); } catch { }
        return files.some(file => file !== sys(NATIVE.rpm.repoFile) && /download\.postgresql\.org\/pub\/repos\/yum\/(17|common)/.test(readText(file) || ''));
    }

    const OURS_COMMENT = '# Added by the Goobster installer (documentation/native_postgres.md). Safe to remove when no database of its uses it.';

    function ensureRepositoryFile(file, text, log, what) {
        const present = readText(file);
        if (present === text) {
            log.push(`${what} unchanged`);
            return false;
        }
        if (present !== null && !present.startsWith(OURS_COMMENT)) throw refuse('REPOSITORY_FOREIGN', `${path.basename(file)} exists and was not written by the installer; it was left as it is.`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, text, 0o644);
        log.push(`${what} written`);
        return true;
    }

    function addRepository(d, log) {
        if (d.family === 'debian') {
            if (aptSourceExists()) {
                log.push('a PGDG apt source is already configured; it is used as it is');
                return { added: false, existing: true };
            }
            const key = verifyKeyFingerprint(log, NATIVE.apt.keyUrl, NATIVE.apt.fingerprint);
            const keyText = `${key.endsWith('\n') ? key : `${key}\n`}`;
            const keyFile = sys(NATIVE.apt.keyFile);
            fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o755 });
            if (readText(keyFile) !== keyText) writeAtomic(keyFile, keyText, 0o644);
            const sources = [
                OURS_COMMENT,
                'Types: deb',
                `URIs: ${NATIVE.apt.repositoryUrl}`,
                `Suites: ${d.codename}-pgdg`,
                `Components: ${NATIVE.apt.component}`,
                `Architectures: ${NATIVE.apt.architectures[d.arch]}`,
                `Signed-By: ${NATIVE.apt.keyFile}`,
                ''
            ].join('\n');
            return { added: ensureRepositoryFile(sys(NATIVE.apt.sourcesFile), sources, log, 'apt source'), existing: false };
        }
        if (rpmRepoExists()) {
            log.push('a PGDG rpm repository is already configured; it is used as it is');
            return { added: false, existing: true };
        }
        const key = NATIVE.rpm.keys[d.arch];
        const keyText = verifyKeyFingerprint(log, key.url, key.fingerprint);
        const keyFile = sys(NATIVE.rpm.keyFile);
        fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o755 });
        const normalized = keyText.endsWith('\n') ? keyText : `${keyText}\n`;
        if (readText(keyFile) !== normalized) writeAtomic(keyFile, normalized, 0o644);
        const repo = [
            OURS_COMMENT,
            `[${NATIVE.rpm.repoId}]`,
            `name=PostgreSQL ${NATIVE.major} for RHEL 9 - ${key.basearch}`,
            `baseurl=${NATIVE.rpm.baseUrl}${key.basearch}`,
            'enabled=1',
            'gpgcheck=1',
            `gpgkey=file://${NATIVE.rpm.keyFile}`,
            ''
        ].join('\n');
        return { added: ensureRepositoryFile(sys(NATIVE.rpm.repoFile), repo, log, 'rpm repository'), existing: false };
    }

    function packageInstall(input, log) {
        requireElevated();
        const d = distro();
        const table = protocol.PACKAGE_TABLE[d.family];
        const allowed = Object.values(table).flat();
        for (const name of input.names) {
            if (!allowed.includes(name)) throw refuse('PACKAGE_NOT_ALLOWED', `${name} is not a package this installer installs on this distribution.`);
        }
        const present = installedNames(d, log, input.names);
        const missing = input.names.filter(name => !present.has(name));
        if (missing.length === 0) {
            log.push('every package is already installed');
            return { outcome: 'noop', detail: { installed: [], already: input.names.length, repository: null } };
        }
        let repository = null;
        if (input.repository === 'pgdg') repository = addRepository(d, log);
        const timeoutMs = deps.installTimeoutMs || NATIVE.installTimeoutMs;
        if (d.family === 'debian') {
            const aptEnv = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a', APT_LISTCHANGES_FRONTEND: 'none' };
            if (!repository || repository.added || !fs.existsSync(sys('/var/lib/apt/lists'))) run(log, 'apt-get', ['update', '-q'], { extraEnv: aptEnv, timeoutMs });
            run(log, 'apt-get', ['install', '-y', '--no-install-recommends', ...missing], { extraEnv: aptEnv, timeoutMs });
        } else {
            if (repository) run(log, 'dnf', ['-qy', 'module', 'disable', 'postgresql'], { allowFailure: true, timeoutMs });
            run(log, 'dnf', ['install', '-y', ...missing], { timeoutMs });
        }
        const after = installedNames(d, log, missing);
        const stillMissing = missing.filter(name => !after.has(name));
        if (stillMissing.length > 0) throw refuse('PACKAGE_INSTALL_INCOMPLETE', `The package manager finished but ${stillMissing.join(', ')} is not installed.`);
        return { outcome: 'done', detail: { installed: missing, already: input.names.length - missing.length, repository: repository ? { added: repository.added, existing: repository.existing } : null } };
    }

    // ---- configuration -------------------------------------------------------------
    function managedHeader(installationId) {
        return `# Managed by the Goobster installer for installation ${installationId}.\n# Changes are overwritten by "repair"; change the database through the manager.\n`;
    }

    function confText(input, d) {
        return `${managedHeader(input.installationId)}listen_addresses = '${input.bind}'\nport = ${input.port}\nunix_socket_directories = '${d.layout.socketDir}'\npassword_encryption = 'scram-sha-256'\n`;
    }

    function hbaText(input) {
        const lines = [
            managedHeader(input.installationId).trimEnd(),
            '# TYPE  DATABASE  USER  ADDRESS  METHOD',
            'local   all       postgres                 peer',
            `host    ${input.database}  ${input.role}  127.0.0.1/32  scram-sha-256`,
            `host    ${input.database}  ${input.role}  ::1/128       scram-sha-256`
        ];
        if (input.lan) lines.push(`host    ${input.database}  ${input.role}  samenet       scram-sha-256`);
        return `${lines.join('\n')}\n`;
    }

    function unitTextFor(input, d, dataDirectory) {
        const bin = NATIVE.layouts.rhel.binDir;
        return [
            `# goobster-installation: ${input.installationId}`,
            '[Unit]',
            `Description=Goobster PostgreSQL ${NATIVE.major} (${input.clusterName})`,
            'After=network.target',
            `RequiresMountsFor=${dataDirectory}`,
            '',
            '[Service]',
            'Type=notify',
            'User=postgres',
            'Group=postgres',
            `Environment=PGDATA=${dataDirectory}`,
            `ExecStart=${bin}/postgres -D ${dataDirectory}`,
            'ExecReload=/bin/kill -HUP $MAINPID',
            'KillMode=mixed',
            'KillSignal=SIGINT',
            'TimeoutSec=300',
            'OOMScoreAdjust=-900',
            '',
            '[Install]',
            'WantedBy=multi-user.target',
            ''
        ].join('\n');
    }

    function dropInText(input, dataDirectory) {
        return `# goobster-installation: ${input.installationId}\n[Unit]\nRequiresMountsFor=${dataDirectory}\n`;
    }

    function daemonReload(log) {
        if (systemdLive()) run(log, 'systemctl', ['daemon-reload']);
        else log.push('systemd is not running: unit changes apply at the next boot');
    }

    function selinux(d, log, dataDirectory, port) {
        if (d.family !== 'rhel' || !command('getenforce')) return;
        const mode = run(log, 'getenforce', [], { allowFailure: true }).stdout.trim();
        if (mode !== 'Enforcing') return;
        if (!command('semanage') || !command('restorecon')) throw refuse('SELINUX_TOOLS_MISSING', 'SELinux is enforcing and semanage is not installed; install policycoreutils-python-utils and run this again.');
        run(log, 'semanage', ['fcontext', '-a', '-t', 'postgresql_db_t', `${dataDirectory}(/.*)?`], { allowFailure: true });
        if (port !== 5432) run(log, 'semanage', ['port', '-a', '-t', 'postgresql_port_t', '-p', 'tcp', String(port)], { allowFailure: true });
        run(log, 'restorecon', ['-R', dataDirectory]);
    }

    /** Write every file this cluster's configuration consists of. Returns whether any changed. */
    function writeConfiguration(input, d, log, account, resources, dataDirectory) {
        let changed = false;
        const put = (file, text, mode) => {
            if (readText(file) === text) return;
            writeOwned(file, text, mode, account);
            changed = true;
        };
        if (d.family === 'debian') {
            const dir = sys(resources.configDirectory);
            put(path.join(dir, 'conf.d', 'goobster.conf'), confText(input, d), 0o644);
            put(path.join(dir, 'pg_hba.conf'), hbaText(input), 0o640);
            const dropIn = sys(resources.dropIn);
            if (readText(dropIn) !== dropInText(input, dataDirectory)) {
                fs.mkdirSync(path.dirname(dropIn), { recursive: true });
                writeAtomic(dropIn, dropInText(input, dataDirectory), 0o644);
                changed = true;
                daemonReload(log);
            }
        } else {
            const conf = path.join(dataDirectory, 'postgresql.conf');
            const current = readText(conf) || '';
            if (!/^include_dir\s*=\s*'conf\.d'/m.test(current)) {
                writeOwned(conf, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}include_dir = 'conf.d'\n`, 0o600, account);
                changed = true;
            }
            put(path.join(dataDirectory, 'conf.d', 'goobster.conf'), confText(input, d), 0o600);
            put(path.join(dataDirectory, 'pg_hba.conf'), hbaText(input), 0o600);
            const unitFile = sys(resources.unitFile);
            if (readText(unitFile) !== unitTextFor(input, d, dataDirectory)) {
                fs.mkdirSync(path.dirname(unitFile), { recursive: true });
                writeAtomic(unitFile, unitTextFor(input, d, dataDirectory), 0o644);
                changed = true;
                daemonReload(log);
            }
        }
        log.push(changed ? 'configuration written' : 'configuration unchanged');
        return changed;
    }

    // ---- starting and stopping ------------------------------------------------------
    function setBootStart(d, log, name, resources, enabled) {
        if (d.family === 'debian') {
            const file = sys(`${resources.configDirectory}/start.conf`);
            const value = enabled ? 'auto' : 'manual';
            const current = readText(file);
            const comments = String(current || '').split('\n').filter(line => line.trim().startsWith('#'));
            const text = `${comments.join('\n')}${comments.length ? '\n' : ''}${value}\n`;
            if (current !== text) writeAtomic(file, text, 0o644);
            if (enabled && systemdLive()) run(log, 'systemctl', ['enable', 'postgresql.service'], { allowFailure: true });
            return;
        }
        if (!systemdLive()) throw refuse('SYSTEMD_UNAVAILABLE', 'systemd is not the init system of this machine, or is not running.');
        run(log, 'systemctl', [enabled ? 'enable' : 'disable', resources.service]);
    }

    function startCluster(d, log, name, resources) {
        if (d.family === 'debian') {
            run(log, 'pg_ctlcluster', [String(NATIVE.major), name, 'start']);
        } else {
            if (!systemdLive()) throw refuse('SYSTEMD_UNAVAILABLE', 'systemd is not the init system of this machine, or is not running.');
            run(log, 'systemctl', ['start', resources.service]);
        }
    }

    function stopCluster(d, log, name, resources) {
        if (d.family === 'debian') {
            run(log, 'pg_ctlcluster', [String(NATIVE.major), name, 'stop', '-m', 'fast']);
        } else {
            if (!systemdLive()) throw refuse('SYSTEMD_UNAVAILABLE', 'systemd is not the init system of this machine, or is not running.');
            run(log, 'systemctl', ['stop', resources.service]);
        }
    }

    function waitReady(d, log, port, tries = 30) {
        for (let attempt = 0; attempt < tries; attempt++) {
            const result = forkPg(log, d, 'pg_isready', ['-h', d.layout.socketDir, '-p', String(port), '-q'], { allowFailure: true });
            if (result.status === 0) return true;
            sleep(1000);
        }
        throw refuse('CLUSTER_NOT_READY', 'The cluster was started but did not accept connections in time.');
    }

    function assertExtensionFiles(d) {
        if (sandbox && !deps.checkExtensions) return;
        const dir = sys(d.layout.extensionDir);
        for (const name of ['citext', 'vector']) {
            if (!fs.existsSync(path.join(dir, `${name}.control`))) {
                throw refuse('EXTENSION_PACKAGE_MISSING', `The ${name} extension is not installed (${name === 'vector' ? 'pgvector' : 'the contrib'} package is missing); no cluster was created.`);
            }
        }
    }

    // ---- postgres.cluster.create ----------------------------------------------------------
    function roleScript(input) {
        const v = input.passwordVerifier;
        return [
            '\\set ON_ERROR_STOP on',
            '\\set VERBOSITY terse',
            `DO $goobster$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${input.role}') THEN CREATE ROLE "${input.role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $goobster$;`,
            `ALTER ROLE "${input.role}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${v}';`,
            `SELECT 'CREATE DATABASE "${input.database}" OWNER "${input.role}" TEMPLATE template0 ENCODING ''UTF8'' LOCALE ''C.UTF-8''' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${input.database}') \\gexec`,
            `REVOKE ALL ON DATABASE "${input.database}" FROM PUBLIC;`,
            `GRANT CONNECT ON DATABASE "${input.database}" TO "${input.role}";`,
            ''
        ].join('\n');
    }

    function extensionScript() {
        return ['\\set ON_ERROR_STOP on', '\\set VERBOSITY terse', 'CREATE EXTENSION IF NOT EXISTS citext;', 'CREATE EXTENSION IF NOT EXISTS vector;', ''].join('\n');
    }

    function psqlArgs(d, input, database) {
        return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', d.layout.socketDir, '-p', String(input.port), '-d', database, '-f', '-'];
    }

    function clusterCreate(input, log) {
        requireElevated();
        verifyNativeRecord(input, { expectDataDirectory: input.dataDirectory });
        const d = distro();
        if (d.family === 'rhel') kit.requireSystemd();
        const resources = resourcesOf(d, input.clusterName);
        const tool = d.family === 'debian' ? command('pg_createcluster') : pgProgram(d, 'initdb');
        if (!tool) throw refuse('SERVER_PACKAGE_MISSING', 'The PostgreSQL server package is not installed; install it first.');
        assertExtensionFiles(d);
        const account = lookupUser('postgres');
        if (!account) throw refuse('POSTGRES_ACCOUNT_MISSING', 'The distribution\'s postgres account does not exist; install the server package first.');

        const facts = clusterFacts(d, log, input.clusterName);
        const others = otherClusters(d, log, input.clusterName);
        let resumed = false;
        if (facts.exists) {
            const ours = facts.dataDirectory === input.dataDirectory && markerText(facts.dataDirectory) === input.installationId;
            if (!ours) throw refuse('CLUSTER_EXISTS', `A cluster named ${input.clusterName} exists and does not belong to this installation; it was left as it is.`);
            resumed = true;
            log.push('the cluster exists and is this installation\'s; continuing with it');
        } else {
            const ours = fs.existsSync(path.join(input.dataDirectory, NATIVE.marker)) && markerText(input.dataDirectory) === input.installationId && fs.existsSync(path.join(input.dataDirectory, 'PG_VERSION'));
            if (input.mode === 'converge' && !(ours && d.family === 'rhel')) throw refuse('CLUSTER_MISSING', 'There is no cluster of this installation to repair.');
            if (ours && d.family === 'rhel') {
                resumed = true;
            } else {
                assertDataDirectory(d, log, input.dataDirectory, { acknowledgeMount: input.acknowledgeMount, others });
                assertPortFree(d, log, input.port, input.clusterName);
                if (d.family === 'debian') {
                    const taken = fs.existsSync(sys(resources.configDirectory));
                    if (taken) throw refuse('CLUSTER_EXISTS', `A cluster configuration named ${input.clusterName} exists and does not belong to this installation; it was left as it is.`);
                }
            }
        }
        if (resumed && !facts.online) {
            const used = otherClusters(d, log, input.clusterName).find(item => item.port === input.port);
            if (used) throw refuse('PORT_IN_USE', `Port ${input.port} belongs to another PostgreSQL cluster on this machine.`);
        }

        let created = false;
        if (!resumed) {
            ensureLeaf(input.dataDirectory, account);
            if (d.family === 'debian') {
                run(log, 'pg_createcluster', [String(NATIVE.major), input.clusterName, '-d', input.dataDirectory, '-p', String(input.port), '--start-conf', 'auto', '-e', 'UTF8', '--locale', 'C.UTF-8', '--', '--auth-local=peer', '--auth-host=scram-sha-256'], { timeoutMs: deps.createTimeoutMs || NATIVE.createTimeoutMs });
            } else {
                runAsPostgres(log, d, 'initdb', ['-D', input.dataDirectory, '--encoding=UTF8', '--locale=C.UTF-8', '--auth-local=peer', '--auth-host=scram-sha-256'], { timeoutMs: deps.createTimeoutMs || NATIVE.createTimeoutMs });
            }
            writeOwned(path.join(input.dataDirectory, NATIVE.marker), `${input.installationId}\n`, 0o600, account);
            created = true;
            log.push('cluster created');
        }
        selinux(d, log, input.dataDirectory, input.port);
        const changed = writeConfiguration(input, d, log, account, resources, input.dataDirectory);
        setBootStart(d, log, input.clusterName, resources, true);
        const live = clusterFacts(d, log, input.clusterName);
        if (!live.online) startCluster(d, log, input.clusterName, resources);
        else if (changed && !created) {
            if (d.family === 'debian') run(log, 'pg_ctlcluster', [String(NATIVE.major), input.clusterName, 'restart']);
            else run(log, 'systemctl', ['restart', resources.service]);
        }
        waitReady(d, log, input.port);

        let provisioned = false;
        if (input.mode === 'create') {
            runAsPostgres(log, d, 'psql', psqlArgs(d, input, 'postgres'), { input: roleScript(input) });
            runAsPostgres(log, d, 'psql', psqlArgs(d, input, input.database), { input: extensionScript() });
            provisioned = true;
            log.push('role, database and extensions ready');
        }
        return { outcome: created || provisioned || changed ? 'done' : 'noop', detail: { cluster: input.clusterName, service: resources.service, created, resumed, provisioned, configured: changed, port: input.port } };
    }

    // ---- postgres.cluster.control ---------------------------------------------------------
    function ownedCluster(input, log, d, { expectRecordDirectory = true } = {}) {
        const record = verifyNativeRecord(input);
        const facts = clusterFacts(d, log, input.clusterName);
        if (!facts.exists) throw refuse('CLUSTER_MISSING', 'There is no cluster of this installation on this machine.');
        if (!facts.dataDirectory || markerText(facts.dataDirectory) !== input.installationId) {
            throw refuse('CLUSTER_FOREIGN', `The cluster ${input.clusterName} does not carry this installation's marker; it was left as it is.`);
        }
        if (expectRecordDirectory && record.cluster.dataDirectory !== facts.dataDirectory) throw refuse('RECORD_MISMATCH', 'The manager\'s record names another data directory than the cluster uses.');
        return { record, facts };
    }

    function clusterControl(input, log) {
        requireElevated();
        const d = distro();
        const resources = resourcesOf(d, input.clusterName);
        const { facts, record } = ownedCluster(input, log, d);
        if (input.action === 'start') {
            if (facts.online) return { outcome: 'noop', detail: { cluster: input.clusterName, action: 'start', running: true } };
            startCluster(d, log, input.clusterName, resources);
            waitReady(d, log, facts.port || record.cluster.port);
            return { outcome: 'done', detail: { cluster: input.clusterName, action: 'start', running: true } };
        }
        if (input.action === 'stop') {
            if (!facts.online) return { outcome: 'noop', detail: { cluster: input.clusterName, action: 'stop', running: false } };
            stopCluster(d, log, input.clusterName, resources);
            return { outcome: 'done', detail: { cluster: input.clusterName, action: 'stop', running: false } };
        }
        setBootStart(d, log, input.clusterName, resources, input.action === 'enable');
        return { outcome: 'done', detail: { cluster: input.clusterName, action: input.action } };
    }

    // ---- postgres.cluster.remove ----------------------------------------------------------
    function clusterRemove(input, log) {
        requireElevated();
        const d = distro();
        const resources = resourcesOf(d, input.clusterName);
        const text = readText(path.join(input.managerStore, 'installation.json'));
        let installation = null;
        try { installation = text ? JSON.parse(text) : null; } catch { }
        if (!installation || installation.installationId !== input.installationId) throw refuse('INSTALLATION_MISMATCH', 'The installation record does not name this installation id.');
        const facts = clusterFacts(d, log, input.clusterName);
        if (!facts.exists) {
            log.push('no such cluster: nothing to remove');
            return { outcome: 'noop', detail: { cluster: input.clusterName, removed: false, dataKept: true } };
        }
        ownedCluster(input, log, d, { expectRecordDirectory: false });
        if (facts.online) stopCluster(d, log, input.clusterName, resources);
        setBootStart(d, log, input.clusterName, resources, false);
        if (!input.removeData) return { outcome: 'done', detail: { cluster: input.clusterName, removed: false, stopped: true, dataKept: true } };
        const dataDirectory = facts.dataDirectory;
        if (d.family === 'debian') {
            if (!command('pg_dropcluster')) throw refuse('COMMAND_MISSING', 'pg_dropcluster is not installed on this system.');
            run(log, 'pg_dropcluster', [String(NATIVE.major), input.clusterName]);
            fs.rmSync(path.dirname(sys(resources.dropIn)), { recursive: true, force: true });
        } else {
            fs.rmSync(sys(resources.unitFile), { force: true });
        }
        daemonReload(log);
        if (fs.existsSync(dataDirectory) && markerText(dataDirectory) === input.installationId) {
            fs.rmSync(dataDirectory, { recursive: true, force: true });
        }
        return { outcome: 'done', detail: { cluster: input.clusterName, removed: true, dataKept: false } };
    }

    // ---- postgres.cluster.relocate --------------------------------------------------------
    function controlData(d, log, directory) {
        const out = forkPg(log, d, 'pg_controldata', [directory], { allowFailure: false });
        const pick = (label) => {
            const match = new RegExp(`^${label}:\\s*(.*)$`, 'm').exec(out.stdout);
            return match ? match[1].trim() : null;
        };
        return { identifier: pick('Database system identifier'), checkpoint: pick('Latest checkpoint location'), state: pick('Database cluster state') };
    }

    function treeBytes(log, directory) {
        const out = run(log, 'du', ['-sb', '--', directory]);
        const bytes = Number(String(out.stdout).trim().split(/\s+/)[0]);
        if (!Number.isFinite(bytes)) throw refuse('COMMAND_FAILED', 'The size of a data directory could not be read.');
        return bytes;
    }

    function switchDataDirectory(d, log, input, resources, account, from, to) {
        if (d.family === 'debian') {
            const file = sys(`${resources.configDirectory}/postgresql.conf`);
            const text = readText(file);
            if (text === null) throw refuse('CLUSTER_MISSING', 'The cluster configuration is missing.');
            const line = `data_directory = '${to}'\t\t# use data in another directory`;
            const next = /^\s*data_directory\s*=.*$/m.test(text) ? text.replace(/^\s*data_directory\s*=.*$/m, line) : `${text}${text.endsWith('\n') ? '' : '\n'}${line}\n`;
            writeOwned(file, next, 0o644, account);
            const dropIn = sys(resources.dropIn);
            fs.mkdirSync(path.dirname(dropIn), { recursive: true });
            writeAtomic(dropIn, dropInText(input, to), 0o644);
        } else {
            const unitFile = sys(resources.unitFile);
            const text = readText(unitFile);
            if (text === null) throw refuse('CLUSTER_MISSING', 'The cluster\'s service definition is missing.');
            writeAtomic(unitFile, text.split(from).join(to), 0o644);
        }
        daemonReload(log);
    }

    function clusterRelocate(input, log) {
        requireElevated();
        const d = distro();
        const resources = resourcesOf(d, input.clusterName);
        const record = verifyNativeRecord(input);
        const intent = record.relocation;
        if (!intent || intent.to !== input.target) throw refuse('RECORD_MISMATCH', 'The manager\'s record does not name this relocation.');
        const facts = clusterFacts(d, log, input.clusterName);
        if (!facts.exists) throw refuse('CLUSTER_MISSING', 'There is no cluster of this installation on this machine.');
        if (facts.dataDirectory === input.target && markerText(input.target) === input.installationId) {
            log.push('the cluster already uses the target directory');
            return { outcome: 'noop', detail: { cluster: input.clusterName, switched: true, kept: intent.from || null } };
        }
        const source = facts.dataDirectory;
        if (markerText(source) !== input.installationId) throw refuse('CLUSTER_FOREIGN', `The cluster ${input.clusterName} does not carry this installation's marker; it was left as it is.`);
        if (source !== intent.from) throw refuse('RECORD_MISMATCH', 'The manager\'s record names another source directory than the cluster uses.');
        const account = lookupUser('postgres');
        if (!account) throw refuse('POSTGRES_ACCOUNT_MISSING', 'The distribution\'s postgres account does not exist.');
        const others = otherClusters(d, log, input.clusterName);

        const resumeMarker = path.join(input.target, NATIVE.relocating);
        const partial = fs.existsSync(resumeMarker) && (readText(resumeMarker) || '').trim() === input.installationId;
        assertDataDirectory(d, log, input.target, { acknowledgeMount: input.acknowledgeMount, ours: partial, others, exceptInside: source });
        const bytes = treeBytes(log, source);
        const nearest = nearestExisting(input.target);
        if (typeof fs.statfsSync === 'function' && nearest) {
            try {
                const stat = fs.statfsSync(nearest);
                if (Number(stat.bavail) * Number(stat.bsize) < bytes + (64 * 1024 * 1024)) throw refuse('STORAGE_FULL', 'The target does not have room for a copy of the database plus 64 MiB.');
            } catch (error) {
                if (error instanceof HelperError) throw error;
            }
        }

        const wasOnline = facts.online;
        let switched = false;
        try {
            if (wasOnline) stopCluster(d, log, input.clusterName, resources);
            const before = controlData(d, log, source);
            if (before.state && !/shut down/i.test(before.state)) throw refuse('CLUSTER_NOT_STOPPED', 'The cluster did not shut down cleanly; nothing was copied.');
            if (partial) {
                for (const entry of fs.readdirSync(input.target)) fs.rmSync(path.join(input.target, entry), { recursive: true, force: true });
                log.push('an earlier partial copy of this relocation was cleared');
            }
            ensureLeaf(input.target, account);
            writeOwned(resumeMarker, `${input.installationId}\n`, 0o600, account);
            run(log, 'cp', ['-a', '--', `${source}/.`, `${input.target}/`], { timeoutMs: deps.copyTimeoutMs || NATIVE.installTimeoutMs });
            const copied = treeBytes(log, input.target);
            const extra = copied - bytes;
            if (Math.abs(extra) > 64 * 1024) throw refuse('COPY_VERIFY_FAILED', 'The copy is not the size of the original; the original was not changed.');
            const after = controlData(d, log, input.target);
            if (!after.identifier || after.identifier !== before.identifier || after.checkpoint !== before.checkpoint) throw refuse('COPY_VERIFY_FAILED', 'The copy is not the same database cluster as the original; the original was not changed.');
            fs.rmSync(path.join(input.target, NATIVE.relocating), { force: true });
            if (markerText(input.target) !== input.installationId) throw refuse('COPY_VERIFY_FAILED', 'The copy lost the installation marker; the original was not changed.');
            selinux(d, log, input.target, record.cluster.port);
            switchDataDirectory(d, log, input, resources, account, source, input.target);
            switched = true;
            if (wasOnline) {
                startCluster(d, log, input.clusterName, resources);
                waitReady(d, log, record.cluster.port);
            }
        } catch (error) {
            if (switched) {
                try { switchDataDirectory(d, log, input, resources, account, input.target, source); } catch { }
            }
            if (wasOnline) {
                try { startCluster(d, log, input.clusterName, resources); } catch { }
            }
            throw error;
        }
        return { outcome: 'done', detail: { cluster: input.clusterName, switched: true, bytes, kept: true } };
    }

    return {
        'package.install': packageInstall,
        'postgres.cluster.create': clusterCreate,
        'postgres.cluster.control': clusterControl,
        'postgres.cluster.remove': clusterRemove,
        'postgres.cluster.relocate': clusterRelocate
    };
}

function invokerFromEnv(env) {
    const raw = env.SUDO_UID || env.PKEXEC_UID;
    const value = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------------------
// the manager's half
// ---------------------------------------------------------------------------

function onPath(name, env, fs = nodeFs) {
    for (const dir of String(env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        try {
            fs.accessSync(candidate, nodeFs.constants.X_OK);
            return candidate;
        } catch { }
    }
    return null;
}

/**
 * How the manager reaches root for the helper.
 * @param {Object} params
 * @param {Object} [params.env]
 * @param {number|null} [params.euid]
 * @param {Function} [params.probe]  `(file, args) => exit status`, to ask `sudo -n true`
 * @returns {{ kind: 'root'|'sudo'|'pkexec'|'none', prefix: string[], reason?: string }}
 */
function elevation({ env = process.env, euid = typeof process.geteuid === 'function' ? process.geteuid() : null, fs = nodeFs, probe = null } = {}) {
    if (euid === 0) return { kind: 'root', prefix: [] };
    const sudo = onPath('sudo', env, fs);
    const probeFn = probe || ((file, args) => childProcess.spawnSync(file, args, { stdio: 'ignore', timeout: 15_000 }).status);
    if (sudo && probeFn(sudo, ['-n', 'true']) === 0) return { kind: 'sudo', prefix: [sudo, '-n', '--'] };
    const display = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
    const pkexec = display ? onPath('pkexec', env, fs) : null;
    if (pkexec) return { kind: 'pkexec', prefix: [pkexec] };
    return { kind: 'none', prefix: [], reason: sudo ? 'SUDO_NEEDS_PASSWORD' : (display ? 'NO_ELEVATION_TOOL' : 'NO_DISPLAY_AND_NO_SUDO') };
}

/** The line an operator can run by hand when no elevation is available. */
function manualCommand({ nodePath, helperPath, requestFile }) {
    const q = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
    return `sudo ${q(nodePath)} ${q(helperPath)} < ${q(requestFile)}`;
}

/** Is systemd the init system and running? `systemctl is-system-running` answers `offline` when it is not PID 1. */
function systemdFacts({ fs = nodeFs, env = process.env, exec = null } = {}) {
    if (!fs.existsSync(SYSTEMD_RUN_DIR)) return { available: false, state: null, reason: 'SYSTEMD_NOT_INIT' };
    const systemctl = onPath('systemctl', { PATH: `${env.PATH || ''}${path.delimiter}${SYSTEM_COMMAND_DIRS.join(path.delimiter)}` }, fs);
    if (!systemctl) return { available: false, state: null, reason: 'SYSTEMCTL_MISSING' };
    const run = exec || ((file, args) => {
        const result = childProcess.spawnSync(file, args, { encoding: 'utf8', timeout: 10_000, env: { PATH: SYSTEM_COMMAND_DIRS.join(':'), LC_ALL: 'C' } });
        return { status: result.status === null ? 1 : result.status, stdout: result.stdout || '' };
    });
    const state = String(run(systemctl, ['is-system-running']).stdout || '').trim();
    const usable = ['running', 'degraded', 'starting', 'initializing'].includes(state);
    return { available: usable, state: state || null, reason: usable ? null : (state === 'offline' ? 'SYSTEMD_OFFLINE' : 'SYSTEMD_NOT_RUNNING') };
}

module.exports = {
    PLATFORM,
    OPERATIONS,
    DISABLED_PREFIX,
    SYSTEM_COMMAND_DIRS,
    NATIVE,
    createHandler,
    elevation,
    manualCommand,
    systemdFacts,
    invokerFromEnv
};
