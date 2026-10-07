/**
 * The macOS implementation of the privileged operations
 * (documentation/macos_install.md). Two halves in one file, because a
 * platform module is one thing to drop in (the shape of ./linux.js):
 *
 *   `createHandler(deps)`  the helper's half: runs inside
 *                          apps/manager/privileged/helper.js and performs the
 *                          three operations this platform implements
 *                          (`service.register`, `service.unregister`,
 *                          `user.create`). A LaunchDaemon and the `_goobster`
 *                          account need root; a LaunchAgent (scope `user`)
 *                          is registered by the person, unelevated.
 *   `elevation(...)`       the manager's half: how to start the helper
 *                          (root already, `sudo -n`, or the `osascript`
 *                          administrator prompt with the request and the reply
 *                          carried in files) and what to tell an operator when
 *                          none of them is possible.
 *
 * Nothing here runs a shell, with one exception: the single fixed
 * `osascript -e 'do shell script "..." with administrator privileges'` command
 * the manager builds (see `osascriptCommand`), whose only variable parts are
 * validated, quoted absolute paths and one integer. Every other command is a
 * fixed program started with an argument vector, from a fixed list of system
 * directories, with a minimal environment. Nothing takes a secret. The helper
 * reads only what the request names plus the installation record that the
 * request must agree with, and writes only the plist, the directory service
 * records of one hidden account, or the owner of the roots the request names.
 * Node built-ins and the sibling modules only (the helper's whole code, see
 * HELPER_FILES and tests/darwinHelper.test.js).
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { HelperError, refuse } = require('./protocol');
const plistText = require('../platform/launchdPlist');
const unitText = require('../platform/systemdUnit');

const PLATFORM = 'darwin';
const SYSTEM_COMMAND_DIRS = Object.freeze(['/bin', '/usr/bin', '/usr/sbin', '/sbin']);
const COMMAND_TIMEOUT_MS = 90_000;
/** `launchctl bootout` waits for the manager's drain; the helper itself is killed at 120 s by the runner. */
const BOOTOUT_TIMEOUT_MS = 100_000;
const UNLOAD_WAIT_SECONDS = 10;
const ACCOUNT_SHELL = '/usr/bin/false';
const ACCOUNT_REAL_NAME = 'Goobster';
/** The range macOS leaves to third-party daemon accounts (below 500 is hidden from the login window). */
const ACCOUNT_ID_RANGE = Object.freeze({ first: 200, last: 400 });
const OSASCRIPT = '/usr/bin/osascript';
const NO_ELEVATION_MARKER = 'GOOBSTER_ELEVATION_REQUIRED';
const MAX_OSASCRIPT_MS = 200_000;

/** Operations this platform implements; the rest answer NOT_IMPLEMENTED. */
const OPERATIONS = Object.freeze(['service.register', 'service.unregister', 'user.create']);

/** The files the elevated helper runs on macOS, payload-relative, for the manifest check in ./elevate.js. */
const HELPER_FILES = Object.freeze([
    'app/apps/manager/privileged/helper.js',
    'app/apps/manager/privileged/protocol.js',
    'app/apps/manager/privileged/darwin.js',
    'app/apps/manager/platform/launchdPlist.js',
    'app/apps/manager/platform/systemdUnit.js'
]);

// ---------------------------------------------------------------------------
// the helper's half
// ---------------------------------------------------------------------------

function defaultExec(file, args, { env, input, timeoutMs } = {}) {
    const result = childProcess.spawnSync(file, args, { encoding: 'utf8', env, input, timeout: timeoutMs || COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return { status: result.status === null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error ? result.error.code || 'EXEC' : null };
}

/** Who asked, as the process that started the helper recorded it: `sudo` says SUDO_UID, the osascript command says GOOBSTER_INVOKER_UID. */
function invokerFromEnv(env) {
    const raw = env.GOOBSTER_INVOKER_UID !== undefined ? env.GOOBSTER_INVOKER_UID : env.SUDO_UID;
    const value = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function accountHome() {
    try {
        return os.userInfo().homedir || os.homedir();
    } catch {
        return os.homedir();
    }
}

/** `Key: value` lines of `dscl -read`; a value that wraps onto the next line (a path with spaces) is joined. */
function parseDsclRead(text) {
    const out = {};
    const lines = String(text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(lines[i]);
        if (!match) continue;
        let value = match[2].trim();
        if (value === '' && lines[i + 1] !== undefined && /^\s/.test(lines[i + 1])) value = lines[++i].trim();
        out[match[1]] = value;
    }
    return out;
}

/** `name   id` rows of `dscl -list <path> <attribute>` as `[name, id]` pairs. */
function parseDsclList(text) {
    const rows = [];
    for (const line of String(text || '').split('\n')) {
        const match = /^(\S+)\s+(-?\d+)\s*$/.exec(line);
        if (match) rows.push([match[1], Number(match[2])]);
    }
    return rows;
}

/**
 * @param {Object} [deps]
 * @param {Object} [deps.fs]
 * @param {string} [deps.daemonDir]        where LaunchDaemons live (default /Library/LaunchDaemons)
 * @param {string} [deps.agentDir]         where the invoking person's LaunchAgents live (default ~/Library/LaunchAgents)
 * @param {string[]} [deps.commandDirs]    where the fixed programs are looked up
 * @param {number|null} [deps.euid]
 * @param {number|null} [deps.invokerUid]  the account that asked (sudo and the osascript command say who)
 * @param {boolean} [deps.sandbox]         tests: a non-root helper acting on a private tree
 * @param {boolean} [deps.checkReachability] tests: judge directory access even in a sandbox
 * @param {boolean} [deps.checkSeal]       tests: judge the code root's ownership even in a sandbox
 * @param {Function} [deps.exec]
 */
function createHandler(deps = {}) {
    const fs = deps.fs || nodeFs;
    const daemonDir = deps.daemonDir || plistText.DAEMON_DIR;
    const commandDirs = deps.commandDirs || SYSTEM_COMMAND_DIRS;
    const euid = deps.euid !== undefined ? deps.euid : (typeof process.geteuid === 'function' ? process.geteuid() : null);
    const invokerUid = deps.invokerUid !== undefined ? deps.invokerUid : invokerFromEnv(process.env);
    const sandbox = deps.sandbox === true;
    const exec = deps.exec || defaultExec;
    const env = { PATH: commandDirs.join(':'), LC_ALL: 'C', LANG: 'C' };
    const agentDir = () => deps.agentDir || plistText.agentDirOf(accountHome());

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

    function run(log, name, args, { allowFailure = false, timeoutMs } = {}) {
        const file = command(name);
        if (!file) throw refuse('COMMAND_MISSING', `${name} is not installed on this system.`);
        const result = exec(file, args, { env, timeoutMs });
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

    /** A LaunchAgent belongs to the person; registering it as root would put it in root's own session. */
    function requireUnelevated() {
        if (sandbox) return;
        if (euid === 0) throw refuse('AGENT_AS_ROOT', 'A per-user service is registered by the person it is for, not by root.');
    }

    function requireLaunchd() {
        if (sandbox && !command('launchctl')) return;
        if (!command('launchctl')) throw refuse('LAUNCHD_UNAVAILABLE', 'launchctl is not available on this machine.');
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

    // ---- the directory service ----------------------------------------------
    function lookupUser(name) {
        const result = exec(command('dscl') || 'dscl', ['.', '-read', `/Users/${name}`, 'UniqueID', 'PrimaryGroupID', 'NFSHomeDirectory', 'UserShell'], { env });
        if (result.status !== 0) return null;
        const fields = parseDsclRead(result.stdout);
        return { name, uid: Number(fields.UniqueID), gid: Number(fields.PrimaryGroupID), home: fields.NFSHomeDirectory || null, shell: fields.UserShell || null };
    }

    function listIds(kind, attribute) {
        const result = exec(command('dscl') || 'dscl', ['.', '-list', `/${kind}`, attribute], { env });
        return result.status === 0 ? parseDsclList(result.stdout) : [];
    }

    function userByUid(uid) {
        const row = listIds('Users', 'UniqueID').find(([, id]) => id === uid);
        return row ? lookupUser(row[0]) : null;
    }

    function lookupGroup(name) {
        const result = exec(command('dscl') || 'dscl', ['.', '-read', `/Groups/${name}`, 'PrimaryGroupID'], { env });
        if (result.status !== 0) return null;
        const gid = Number(parseDsclRead(result.stdout).PrimaryGroupID);
        return Number.isInteger(gid) ? { name, gid } : null;
    }

    /** The first number in 200..400 that is free as a user id and as a group id, so the account and its group share one. */
    function freeAccountId() {
        const taken = new Set([...listIds('Users', 'UniqueID'), ...listIds('Groups', 'PrimaryGroupID')].map(([, id]) => id));
        for (let id = ACCOUNT_ID_RANGE.first; id <= ACCOUNT_ID_RANGE.last; id++) {
            if (!taken.has(id)) return id;
        }
        throw refuse('ACCOUNT_ID_EXHAUSTED', `No free account id between ${ACCOUNT_ID_RANGE.first} and ${ACCOUNT_ID_RANGE.last} is left for a service account.`);
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

    /** The code a daemon runs must not be replaceable by an unprivileged account: root-owned and not group or world writable. */
    function unsealedCodeRoot(input) {
        if (sandbox && deps.checkSeal !== true) return null;
        const candidates = [input.codeRoot];
        if (input.mode === 'payload') {
            try {
                candidates.push(fs.realpathSync(path.join(input.codeRoot, 'current')));
            } catch { }
        }
        for (const candidate of candidates) {
            let stat;
            try {
                stat = fs.statSync(candidate);
            } catch {
                continue;
            }
            if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return candidate;
        }
        return null;
    }

    // ---- plist files ----------------------------------------------------------
    const plistPathFor = (scope, name) => path.join(scope === 'machine' ? daemonDir : agentDir(), plistText.plistFileName(name));

    function markerOf(file) {
        const text = readText(file);
        return text === null ? { present: false, installationId: null } : { present: true, installationId: plistText.parsePlist(text).installationId };
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

    /** Other jobs of this installation (their own marker, a label of ours) in `dir`, so a second copy is never registered. */
    function otherJobsOf(dir, installationId, ownFile) {
        const found = [];
        let entries = [];
        try {
            entries = fs.readdirSync(dir);
        } catch { }
        for (const entry of entries) {
            if (!entry.startsWith(plistText.LABEL_PREFIX) || !entry.endsWith('.plist')) continue;
            const file = path.join(dir, entry);
            if (file === ownFile) continue;
            if (markerOf(file).installationId === installationId) found.push(entry);
        }
        return found;
    }

    // ---- launchctl ---------------------------------------------------------------
    const domainFor = (scope) => (scope === 'machine' ? 'system' : `gui/${euid === null || euid === undefined ? process.getuid() : euid}`);

    function printJob(log, target) {
        return run(log, 'launchctl', ['print', target], { allowFailure: true });
    }

    function isLoaded(log, target) {
        return printJob(log, target).status === 0;
    }

    function stateOf(result) {
        const match = /^\s*state = (.+)$/m.exec(result.stdout || '');
        return match ? match[1].trim() : 'loaded';
    }

    /** Poll until `target` is gone; launchctl bootout returns once the stop was asked for, and the drain takes a while. */
    function waitUnloaded(log, target) {
        for (let waited = 0; waited < UNLOAD_WAIT_SECONDS; waited++) {
            if (!isLoaded(log, target)) return true;
            run(log, 'sleep', ['1'], { allowFailure: true });
        }
        return !isLoaded(log, target);
    }

    // ---- service.register ------------------------------------------------------------
    function serviceRegister(input, log) {
        if (input.kind !== 'launchd') throw refuse('NOT_IMPLEMENTED', 'This platform registers launchd jobs only.');
        const scope = input.scope || 'machine';
        if (scope === 'machine') requireElevated();
        else requireUnelevated();
        requireLaunchd();
        verifyRecord(input);
        verifyInstall(input);
        if (scope === 'machine') {
            const runtimeAccount = lookupUser(input.runtimeUser);
            if (!runtimeAccount) throw refuse('RUNTIME_USER_MISSING', 'The runtime user does not exist; create it first.');
            for (const target of [input.codeRoot, ...unitText.ownedPaths({ roots: input.roots, mode: input.mode })]) {
                const blocked = unreachableAncestor(runtimeAccount, target);
                if (blocked) {
                    throw refuse('ROOT_NOT_REACHABLE', `${input.runtimeUser} cannot enter ${blocked}, which holds ${target}; give it search permission (chmod o+x '${blocked}') and run the install again.`);
                }
            }
            const unsealed = unsealedCodeRoot(input);
            if (unsealed) {
                throw refuse('CODE_ROOT_NOT_SEALED', `${unsealed} is not owned by root or can be written by others; the daemon must not run code an unprivileged account can replace (chown -R root:wheel it and run the install again).`);
            }
        } else if (!sandbox) {
            const person = userByUid(euid);
            if (!person || person.name !== input.runtimeUser) throw refuse('RUNTIME_USER_MISMATCH', 'A per-user service runs as the person who registers it; the request names another account.');
        }

        const file = plistPathFor(scope, input.name);
        const duplicates = [...otherJobsOf(path.dirname(file), input.installationId, file), ...(scope === 'user' ? otherJobsOf(daemonDir, input.installationId, null) : [])];
        if (duplicates.length > 0) throw refuse('SERVICE_DUPLICATE', `Another job of this installation is registered (${duplicates[0]}); unregister it first.`);
        const existing = markerOf(file);
        if (existing.present && existing.installationId !== input.installationId) {
            throw refuse('SERVICE_FOREIGN', `${path.basename(file)} exists and was not registered by this installation; it was left as it is.`);
        }
        const text = plistText.renderPlist({
            name: input.name,
            installationId: input.installationId,
            runtimeUser: input.runtimeUser,
            codeRoot: input.codeRoot,
            roots: input.roots,
            layout: input.layout,
            mode: input.mode,
            nodePath: input.nodePath,
            scope
        });
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
        let written = false;
        if (readText(file) !== text) {
            writeAtomic(file, text, 0o644);
            written = true;
            log.push('plist written');
        } else {
            log.push('plist unchanged');
        }
        // launchd refuses a LaunchDaemon that is not root:wheel and not writable by others. BSD chown has no
        // `--`; the paths are absolute by protocol, so none can read as an option.
        if (scope === 'machine' && !sandbox) run(log, 'chown', ['root:wheel', file]);
        fs.chmodSync(file, 0o644);

        const label = plistText.labelFor(input.name);
        const domain = domainFor(scope);
        const target = `${domain}/${label}`;
        const unit = plistText.plistFileName(input.name);
        if (!command('launchctl')) return { outcome: written ? 'done' : 'noop', detail: { unit, label, scope, written, active: 'unknown' } };
        if (scope === 'user' && printJob(log, domain).status !== 0) {
            log.push('no login session: the agent loads at the next login');
            return { outcome: written ? 'done' : 'noop', detail: { unit, label, scope, written, active: 'loads at next login' } };
        }
        let loadedNow = isLoaded(log, target);
        if (loadedNow && !written) {
            run(log, 'launchctl', ['enable', target], { allowFailure: true });
            return { outcome: 'noop', detail: { unit, label, scope, written: false, active: stateOf(printJob(log, target)) } };
        }
        if (loadedNow) {
            run(log, 'launchctl', ['bootout', target], { allowFailure: true, timeoutMs: BOOTOUT_TIMEOUT_MS });
            loadedNow = !waitUnloaded(log, target);
            if (loadedNow) throw refuse('SERVICE_STILL_ACTIVE', `${unit} is still stopping; it was not reloaded. Run the install again in a minute.`);
        }
        run(log, 'launchctl', ['enable', target], { allowFailure: true });
        run(log, 'launchctl', ['bootstrap', domain, file]);
        return { outcome: 'done', detail: { unit, label, scope, written, active: stateOf(printJob(log, target)) } };
    }

    // ---- service.unregister -----------------------------------------------------------
    function stopAndRemove(log, scope, file, name) {
        if (scope === 'machine') requireElevated();
        else requireUnelevated();
        if (command('launchctl')) {
            const target = `${domainFor(scope)}/${plistText.labelFor(name)}`;
            if (isLoaded(log, target)) {
                run(log, 'launchctl', ['bootout', target], { allowFailure: true, timeoutMs: BOOTOUT_TIMEOUT_MS });
                if (!waitUnloaded(log, target)) throw refuse('SERVICE_STILL_ACTIVE', `${path.basename(file)} is still running; it was not removed.`);
            }
        } else {
            log.push('launchctl is not available: only the plist is removed');
        }
        fs.rmSync(file, { force: true });
    }

    function serviceUnregister(input, log) {
        if (input.kind !== 'launchd') throw refuse('NOT_IMPLEMENTED', 'This platform registers launchd jobs only.');
        const unit = plistText.plistFileName(input.name);
        const candidates = [{ scope: 'machine', file: plistPathFor('machine', input.name) }];
        if (sandbox || euid !== 0) candidates.push({ scope: 'user', file: plistPathFor('user', input.name) });
        const found = candidates.map(candidate => ({ ...candidate, ...markerOf(candidate.file) })).filter(candidate => candidate.present);
        if (found.length === 0) {
            log.push('plist already absent');
            return { outcome: 'noop', detail: { unit, removed: false } };
        }
        const ours = found.filter(candidate => candidate.installationId === input.installationId);
        if (ours.length === 0) throw refuse('SERVICE_FOREIGN', `${unit} was not registered by this installation; it was left as it is.`);
        for (const candidate of ours) stopAndRemove(log, candidate.scope, candidate.file, input.name);
        return { outcome: 'done', detail: { unit, removed: true, scope: ours.map(candidate => candidate.scope).join(',') } };
    }

    // ---- user.create ------------------------------------------------------------------
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
        run(log, 'chown', ['-R', '-h', `${user.name}:${user.gid}`, target]);
        return true;
    }

    function createAccount(input, log) {
        const id = freeAccountId();
        let group = lookupGroup(input.name);
        if (!group) {
            run(log, 'dscl', ['.', '-create', `/Groups/${input.name}`]);
            run(log, 'dscl', ['.', '-create', `/Groups/${input.name}`, 'PrimaryGroupID', String(id)]);
            run(log, 'dscl', ['.', '-create', `/Groups/${input.name}`, 'RealName', ACCOUNT_REAL_NAME]);
            run(log, 'dscl', ['.', '-create', `/Groups/${input.name}`, 'Password', '*']);
            group = { name: input.name, gid: id };
        }
        run(log, 'dscl', ['.', '-create', `/Users/${input.name}`]);
        run(log, 'dscl', ['.', '-create', `/Users/${input.name}`, 'UserShell', ACCOUNT_SHELL]);
        run(log, 'dscl', ['.', '-create', `/Users/${input.name}`, 'RealName', ACCOUNT_REAL_NAME]);
        run(log, 'dscl', ['.', '-create', `/Users/${input.name}`, 'UniqueID', String(id)]);
        run(log, 'dscl', ['.', '-create', `/Users/${input.name}`, 'PrimaryGroupID', String(group.gid)]);
        run(log, 'dscl', ['.', '-create', `/Users/${input.name}`, 'NFSHomeDirectory', input.home]);
        run(log, 'dscl', ['.', '-create', `/Users/${input.name}`, 'IsHidden', '1']);
        run(log, 'dscl', ['.', '-create', `/Users/${input.name}`, 'Password', '*']);
    }

    function userCreate(input, log) {
        requireElevated();
        verifyRecord(input);
        let user = lookupUser(input.name);
        let created = false;
        if (!user) {
            createAccount(input, log);
            created = true;
            user = lookupUser(input.name);
            if (!user) throw refuse('COMMAND_FAILED', 'The account was not created.');
        }
        if (!Number.isInteger(user.uid) || !Number.isInteger(user.gid)) {
            throw refuse('USER_INCOMPLETE', 'The account exists but its directory record is incomplete; nothing was changed.');
        }
        if (user.uid === 0) throw refuse('USER_REFUSED', 'The account is the superuser; nothing was changed.');
        // A root that is (or holds) the asking person's home directory would
        // hand their whole home to the service account; the path rules only
        // keep `/Users` out by being system paths, so the invoker's own entry is checked here.
        const invoker = invokerUid !== null && invokerUid !== undefined && invokerUid !== user.uid ? userByUid(invokerUid) : null;
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

    const table = {
        'service.register': serviceRegister,
        'service.unregister': serviceUnregister,
        'user.create': userCreate
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
        if (!action) throw refuse('NOT_IMPLEMENTED', `${operation} is not implemented on macOS: system dependencies are the operator's to install.`);
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

    return { handle, lookupUser, plistPathFor };
}

// ---------------------------------------------------------------------------
// the manager's half
// ---------------------------------------------------------------------------

function isExecutable(file, fs = nodeFs) {
    try {
        fs.accessSync(file, nodeFs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function onSystemPath(name, fs = nodeFs) {
    for (const dir of SYSTEM_COMMAND_DIRS) {
        const candidate = path.join(dir, name);
        if (isExecutable(candidate, fs)) return candidate;
    }
    return null;
}

function defaultProbe(file, args) {
    return childProcess.spawnSync(file, args, { stdio: 'ignore', timeout: 15_000 }).status;
}

function defaultAqua({ env, fs }) {
    if (env.SECURITYSESSIONID) return true;
    const launchctl = onSystemPath('launchctl', fs);
    if (!launchctl) return false;
    const result = childProcess.spawnSync(launchctl, ['managername'], { encoding: 'utf8', timeout: 10_000, env: { PATH: SYSTEM_COMMAND_DIRS.join(':'), LC_ALL: 'C' } });
    return result.status === 0 && String(result.stdout || '').trim() === 'Aqua';
}

/**
 * How the manager reaches root for the helper.
 * @param {Object} params
 * @param {Object} [params.env]
 * @param {number|null} [params.euid]
 * @param {Function} [params.probe]  `(file, args) => exit status`, to ask `sudo -n true`
 * @param {Function} [params.aqua]   `({ env, fs }) => boolean`, whether a graphical login session can show the administrator prompt
 * @param {string} [params.operation]  the request at hand, as ./elevate.js passes it
 * @param {Object} [params.input]      its validated input
 * @param {'machine'|'user'} [params.scope] `user`: a per-user registration, which needs no rights; derived from the
 *   request when one is given (`needsRoot`), so a person's LaunchAgent is registered without sudo or a prompt
 * @param {string} [params.daemonDir]  tests
 * @returns {{ kind: 'root'|'sudo'|'osascript'|'user'|'none', prefix: string[], reason?: string }}
 */
function elevation({ env = process.env, euid = typeof process.geteuid === 'function' ? process.geteuid() : null, fs = nodeFs, probe = null, aqua = null, operation = null, input = null, scope = null, daemonDir = undefined } = {}) {
    if (euid === 0) return { kind: 'root', prefix: [] };
    const wanted = scope || (operation ? (needsRoot({ operation, input: input || {} }, { fs, daemonDir }) ? 'machine' : 'user') : 'machine');
    if (wanted === 'user') return { kind: 'user', prefix: [] };
    const sudo = onSystemPath('sudo', fs);
    if (sudo && (probe || defaultProbe)(sudo, ['-n', 'true']) === 0) return { kind: 'sudo', prefix: [sudo, '-n', '--'] };
    if ((aqua || defaultAqua)({ env, fs })) return { kind: 'osascript', prefix: [] };
    return { kind: 'none', prefix: [], reason: 'NO_ELEVATION_TOOL' };
}

/** The line an operator can run by hand when no elevation is available. */
function manualCommand({ nodePath, helperPath, requestFile }) {
    const q = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
    return `sudo ${q(nodePath)} ${q(helperPath)} < ${q(requestFile)}`;
}

/**
 * Is launchd there? `launchctl print system` answers for root; anyone can ask `launchctl managername`, which is
 * enough to know the service manager is reachable for a per-user registration.
 */
function launchdFacts({ fs = nodeFs, exec = null } = {}) {
    const launchctl = onSystemPath('launchctl', fs);
    if (!launchctl) return { available: false, state: null, reason: 'LAUNCHD_UNAVAILABLE' };
    const run = exec || ((file, args) => {
        const result = childProcess.spawnSync(file, args, { encoding: 'utf8', timeout: 10_000, env: { PATH: SYSTEM_COMMAND_DIRS.join(':'), LC_ALL: 'C' } });
        return { status: result.status === null ? 1 : result.status, stdout: result.stdout || '' };
    });
    if (run(launchctl, ['print', 'system']).status === 0) return { available: true, state: 'system', reason: null };
    const manager = run(launchctl, ['managername']);
    const name = String(manager.stdout || '').trim();
    if (manager.status === 0 && name) return { available: true, state: name, reason: null };
    return { available: false, state: null, reason: 'LAUNCHD_UNAVAILABLE' };
}

// ---- the file transport (an administrator prompt cannot pass a pipe) ----------

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const SAFE_ARGUMENT = /^\/[^\u0000-\u001f\u007f]*$/;

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The one command string this module builds: `osascript -e 'do shell script "<node> <helper> --request <file>
 * --reply <file>" with administrator privileges'`. The paths are absolute, free of control characters and
 * single-quoted for the shell, the shell line is then escaped as an AppleScript string; the invoking account
 * travels as one integer so the root helper knows whose home it must never hand over.
 * @returns {string[]} the argument vector for /usr/bin/osascript
 */
function osascriptCommand({ nodePath, helperPath, requestFile, replyFile, uid }) {
    for (const value of [nodePath, helperPath, requestFile, replyFile]) {
        if (typeof value !== 'string' || !SAFE_ARGUMENT.test(value) || value.length > 1024) throw new Error('a path cannot be carried in the administrator prompt');
    }
    if (!Number.isInteger(uid) || uid < 0) throw new Error('the invoking account is not a number');
    const line = `GOOBSTER_INVOKER_UID=${uid} ${shellQuote(nodePath)} ${shellQuote(helperPath)} --request ${shellQuote(requestFile)} --reply ${shellQuote(replyFile)}`;
    return ['-e', `do shell script ${appleScriptString(line)} with administrator privileges`];
}

function describeRequest(request) {
    try {
        const doc = JSON.parse(request);
        return { operation: doc.operation, input: doc.input && typeof doc.input === 'object' ? doc.input : {} };
    } catch {
        return { operation: null, input: {} };
    }
}

/**
 * Does this request need root? A LaunchAgent is the person's own: registering one asks for no password, and
 * neither does removing it. `service.unregister` carries no scope, so the files decide: a LaunchDaemon of this name
 * on disk means root, anything else is the person's or already gone.
 */
function needsRoot({ operation, input }, { fs = nodeFs, daemonDir = plistText.DAEMON_DIR } = {}) {
    if (operation === 'service.register') return (input.scope || 'machine') !== 'user';
    if (operation === 'service.unregister') {
        try {
            return fs.existsSync(path.join(daemonDir, plistText.plistFileName(input.name)));
        } catch {
            return true;
        }
    }
    return true;
}

function writePrivateFile(fs, file, text) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
        if (text) fs.writeSync(fd, text);
    } finally {
        fs.closeSync(fd);
    }
}

function removeQuietly(fs, file) {
    try {
        fs.rmSync(file, { force: true });
    } catch { }
}

function isOurRegularFile(fs, file, uid) {
    try {
        const stat = fs.lstatSync(file);
        return stat.isFile() && !stat.isSymbolicLink() && (uid === null || stat.uid === uid);
    } catch {
        return false;
    }
}

/**
 * Carry the request to the helper and bring the reply back, for the elevation tools of `./elevate.js`'s plan:
 * root and sudo pass the request on stdin like the default; an unneeded elevation (a LaunchAgent) runs the helper as
 * the person; osascript's `do shell script` cannot pass a pipe, so the request goes in a 0600 file, the reply
 * comes back in a 0600 file this process creates first (root writes into a file the person can read), both
 * deleted afterwards.
 */
async function transport({ plan, request, nodePath, helperPath, requestDir, spawn, fs = nodeFs, env = process.env, timeoutMs, daemonDir, uid = typeof process.getuid === 'function' ? process.getuid() : null }) {
    const elevate = require('./elevate');
    const described = describeRequest(request);
    const wantsRoot = needsRoot(described, { fs, daemonDir });
    if (plan.kind === 'user' || (!wantsRoot && plan.kind !== 'root')) {
        if (wantsRoot) return { status: 126, signal: null, stdout: '', stderr: NO_ELEVATION_MARKER };
        return elevate.spawnHelper({ argv: [nodePath, helperPath], request, spawn, timeoutMs });
    }
    if (plan.kind !== 'osascript') {
        return elevate.spawnHelper({ argv: [...plan.prefix, nodePath, helperPath], request, spawn, timeoutMs });
    }
    if (!requestDir || uid === null) return { spawnError: 'NO_REQUEST_DIR', status: null, stdout: '', stderr: '' };
    const id = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const requestFile = path.join(requestDir, `${described.operation || 'request'}.${id}.request.json`);
    const replyFile = path.join(requestDir, `${described.operation || 'request'}.${id}.reply.json`);
    let argv;
    try {
        argv = osascriptCommand({ nodePath, helperPath, requestFile, replyFile, uid });
        fs.mkdirSync(requestDir, { recursive: true, mode: 0o700 });
        writePrivateFile(fs, requestFile, `${request}\n`);
        writePrivateFile(fs, replyFile, '');
    } catch (error) {
        removeQuietly(fs, requestFile);
        removeQuietly(fs, replyFile);
        return { spawnError: error && error.code ? error.code : 'UNSAFE_PATH', status: null, stdout: '', stderr: '' };
    }
    try {
        // Root is about to write into the reply file: it must still be the empty regular file this process made.
        if (!isOurRegularFile(fs, requestFile, uid) || !isOurRegularFile(fs, replyFile, uid)) return { spawnError: 'REQUEST_FILE_CHANGED', status: null, stdout: '', stderr: '' };
        const result = await runOsascript({ argv, spawn, env, timeoutMs: Math.max(timeoutMs || 0, MAX_OSASCRIPT_MS) });
        let reply = '';
        if (isOurRegularFile(fs, replyFile, uid)) {
            try {
                reply = fs.readFileSync(replyFile, 'utf8');
            } catch { }
        }
        return { ...result, stdout: reply };
    } finally {
        removeQuietly(fs, requestFile);
        removeQuietly(fs, replyFile);
    }
}

function runOsascript({ argv, spawn = childProcess.spawn, env, timeoutMs }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(OSASCRIPT, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: SYSTEM_COMMAND_DIRS.join(':'), LC_ALL: 'C', ...(env && env.HOME ? { HOME: env.HOME } : {}) } });
        } catch (error) {
            resolve({ spawnError: error && error.code ? error.code : 'EXEC', status: null, stderr: '' });
            return;
        }
        const chunks = [];
        child.stderr.on('data', (chunk) => { if (chunks.length < 64) chunks.push(chunk); });
        child.stdout.on('data', () => {});
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            resolve({ spawnError: error && error.code ? error.code : 'EXEC', status: null, stderr: Buffer.concat(chunks).toString('utf8') });
        });
        child.once('close', (status, signal) => {
            clearTimeout(timer);
            resolve({ status, signal, stderr: Buffer.concat(chunks).toString('utf8') });
        });
    });
}

/** How the platform's elevation tools say "no": a dismissed or failed administrator prompt, a sudo that wants a password, no way at all. */
function refusal({ plan, stderr = '' }) {
    const text = String(stderr);
    if (text.includes(NO_ELEVATION_MARKER)) return { reason: 'ELEVATION_UNAVAILABLE' };
    if (plan && plan.kind === 'osascript') {
        if (/User canceled|\(-128\)/i.test(text)) return { reason: 'ELEVATION_DECLINED' };
        if (/\(-6000[57]\)|not authorized|incorrect/i.test(text)) return { reason: 'ELEVATION_REFUSED' };
    }
    if (plan && plan.kind === 'sudo' && /password is required|not allowed|may not run|no tty present|a terminal is required/i.test(text)) return { reason: 'ELEVATION_REFUSED' };
    return null;
}

/**
 * The sandbox a non-root helper acts in (tests, CI): where the plists go and where the fake programs are,
 * all under `dir`.
 */
function sandboxDeps(dir) {
    return {
        sandbox: true,
        daemonDir: path.join(dir, 'Library', 'LaunchDaemons'),
        agentDir: path.join(dir, 'Library', 'LaunchAgents'),
        commandDirs: [path.join(dir, 'bin')]
    };
}

module.exports = {
    PLATFORM,
    OPERATIONS,
    HELPER_FILES,
    SYSTEM_COMMAND_DIRS,
    ACCOUNT_ID_RANGE,
    NO_ELEVATION_MARKER,
    createHandler,
    sandboxDeps,
    elevation,
    manualCommand,
    launchdFacts,
    /** The platform-neutral name ./elevate.js asks for. */
    serviceFacts: launchdFacts,
    transport,
    refusal,
    osascriptCommand,
    needsRoot,
    parseDsclRead,
    parseDsclList,
    invokerFromEnv
};
