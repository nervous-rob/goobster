/**
 * The Linux implementation of the privileged operations
 * (documentation/linux_install.md). Two halves in one file, because a
 * platform module is one thing to drop in:
 *
 *   `createHandler(deps)`  the helper's half: runs as root, inside
 *                          apps/manager/privileged/helper.js, and performs
 *                          exactly the five closed operations.
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
const { HelperError, refuse } = require('./protocol');
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
const OPERATIONS = Object.freeze(['service.register', 'service.unregister', 'user.create', 'updater.disable']);

// ---------------------------------------------------------------------------
// the helper's half
// ---------------------------------------------------------------------------

function defaultExec(file, args, { env, input } = {}) {
    const result = childProcess.spawnSync(file, args, { encoding: 'utf8', env, input, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
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

    function command(name) {
        for (const dir of commandDirs) {
            const candidate = path.join(dir, name);
            try {
                fs.accessSync(candidate, nodeFs.constants.X_OK);
                return candidate;
            } catch { }
        }
        return null;
    }

    function run(log, name, args, { allowFailure = false } = {}) {
        const file = command(name);
        if (!file) throw refuse('COMMAND_MISSING', `${name} is not installed on this system.`);
        const result = exec(file, args, { env });
        log.push(`${name} ${args.filter(arg => /^[a-z-]/.test(arg) && !arg.includes('/')).slice(0, 4).join(' ')} -> ${result.status}`);
        if (result.status !== 0 && !allowFailure) {
            const reason = String(result.stderr || result.stdout || '').split('\n').find(line => line.trim()) || `exit ${result.status}`;
            throw refuse('COMMAND_FAILED', `${name} failed: ${reason.slice(0, 160)}`);
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

    const table = {
        'service.register': serviceRegister,
        'service.unregister': serviceUnregister,
        'user.create': userCreate,
        'updater.disable': updaterDisable
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
        if (!action) throw refuse('NOT_IMPLEMENTED', `${operation} is not implemented on Linux: system packages are the operator's to install.`);
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
    createHandler,
    elevation,
    manualCommand,
    systemdFacts,
    invokerFromEnv
};
