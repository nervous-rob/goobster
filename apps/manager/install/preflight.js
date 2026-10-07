/**
 * Preflight for install, adopt, reconfigure and repair
 * (documentation/manager_install.md § Preflight, issue #329).
 *
 * Reads only: the path rules, ownership and permissions of every root, free
 * disk space, whether the ports are taken (a throwaway listen, closed at
 * once), the release's target and Node ABI, the selected feature set, and
 * the system tools the selected features use (reported, never installed).
 * The result is `{ ok, findings }`; any `block` finding fails validate.
 * Finding details name roles and settings, not paths or values.
 */

const nodeFs = require('node:fs');
const nodeNet = require('node:net');
const os = require('node:os');
const path = require('node:path');
const paths = require('./paths');
const release = require('./release');
const { DEFAULT_BOT_PORT, DEFAULT_API_PORT, DEFAULT_SANDBOX_PORT } = require('../lifecycle/layouts');

const DISK_MARGIN = 1.2;
const DISK_FLOOR_BYTES = 64 * 1024 * 1024;
const POSIX = process.platform !== 'win32';

const block = (code, detail) => ({ code, severity: 'block', detail });
const warn = (code, detail) => ({ code, severity: 'warn', detail });

const PROBE_CONNECT_TIMEOUT_MS = 2000;

/**
 * Whether something listens on the loopback port. A bind that fails with
 * EADDRINUSE is not enough on its own: on macOS a process that is not root
 * cannot bind a port on which another account still has connections in
 * TIME_WAIT (the ones a service that has just stopped leaves behind for about
 * thirty seconds), so a refused bind is confirmed by connecting. A connection
 * that is accepted means busy; one that is refused means nothing listens.
 * @returns {Promise<'free'|'busy'|'unknown'>}
 */
function defaultProbePort(port, net = nodeNet) {
    const confirm = () => new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        socket.unref();
        socket.setTimeout(PROBE_CONNECT_TIMEOUT_MS);
        const done = (state) => { socket.destroy(); resolve(state); };
        socket.once('connect', () => done('busy'));
        socket.once('timeout', () => done('busy'));
        socket.once('error', error => done(error && error.code === 'ECONNREFUSED' ? 'free' : 'busy'));
    });
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once('error', error => {
            if (error && error.code === 'EADDRINUSE') confirm().then(resolve);
            else resolve('unknown');
        });
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve('free')));
    });
}

function ancestorExists(target, fs) {
    let current = target;
    for (;;) {
        try {
            fs.statSync(current);
            return current;
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return null;
            current = parent;
        }
    }
}

function writable(target, fs) {
    try {
        fs.accessSync(target, nodeFs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

function freeBytes(target, fs) {
    try {
        const stat = (fs.statfsSync || nodeFs.statfsSync)(target);
        return Number(stat.bavail) * Number(stat.bsize);
    } catch {
        return null;
    }
}

function directorySize(dir, fs, limit = 5000) {
    let total = 0;
    let seen = 0;
    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (seen++ > limit) return;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                try { total += fs.statSync(full).size; } catch { }
            }
        }
    };
    walk(dir);
    return total;
}

function onPath(name, { env, fs, home }) {
    const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
    dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.local', 'goobster-venv', 'bin'), '/opt/venv/bin');
    const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            try {
                fs.accessSync(path.join(dir, `${name}${ext}`), nodeFs.constants.X_OK);
                return true;
            } catch { }
        }
    }
    return false;
}

function portsFor({ layout, features, env, settings }) {
    const list = [];
    const add = (name, port) => { if (Number.isInteger(port) && port > 0) list.push({ name, port }); };
    if (layout === 'lite' || layout === 'paired') add('bot', Number(env.PORT) || DEFAULT_BOT_PORT);
    if (layout === 'standalone' || layout === 'paired') add('api', Number(env.GOOBSTER_API_PORT) || DEFAULT_API_PORT);
    if (features.includes('sandbox') && layout === 'paired') add('sandbox', Number(env.GOOBSTER_SANDBOX_PORT) || DEFAULT_SANDBOX_PORT);
    return { list, managerPort: settings.port };
}

/**
 * @param {Object} params
 * @param {'install.new'|'adopt'|'install.reconfigure'|'install.repair'} params.kind
 * @param {Object} params.roots
 * @param {'lite'|'standalone'|'paired'} params.layout
 * @param {Object} params.settings         the manager's resolved settings
 * @param {Object|null} [params.manifest]  release manifest (install, reconfigure, repair)
 * @param {string[]} [params.features]     requested features
 * @param {{ engine: string, external: boolean }} [params.database]
 * @param {boolean} [params.accountCreatable] the service kind creates POSIX accounts (`user.create`); false for a service manager that assigns the identity itself
 * @param {boolean} [params.managerListening] the manager's own port is in use by the caller
 * @param {string} [params.via] how the caller authenticated; every root of anyone but `local` (the command line) must sit under an allowed base
 */
async function runPreflight({
    kind,
    roots,
    layout,
    settings,
    manifest = null,
    features = [],
    database = { engine: 'sqlite', external: false },
    env = settings.env || process.env,
    fs = nodeFs,
    probePort = defaultProbePort,
    platform = process.platform,
    arch = process.arch,
    abi = process.versions.modules,
    runtimeUser = null,
    createRuntimeUser = false,
    accountCreatable = true,
    registerService = false,
    unitNames = [],
    euid = typeof process.geteuid === 'function' ? process.geteuid() : null,
    home = os.homedir(),
    managerListening = false,
    includeManagerPort = true,
    requireRoots = true,
    via = 'local'
}) {
    const findings = [];
    const push = (finding) => findings.push(finding);

    // --- paths ---------------------------------------------------------------
    let pathsOk = true;
    for (const [role, value] of Object.entries(roots)) {
        const problem = paths.rawProblem(value);
        if (problem) {
            push(block(problem, `the ${role} root is not a usable absolute path`));
            pathsOk = false;
        }
    }
    if (pathsOk) {
        for (const finding of paths.nestingProblems(roots)) push(block(finding.code, finding.detail));
        for (const role of ['data', 'config', 'cache', 'logs', 'uploads', 'managerStore']) {
            if (!paths.isInside(roots.code, roots[role])) continue;
            try {
                paths.assertContained(roots.code, roots[role], fs);
            } catch {
                push(block('PATH_ESCAPE', `the ${role} root resolves outside the installation root through a symbolic link`));
            }
        }
        if (paths.isSymlink(roots.code, fs)) push(block('PATH_ESCAPE', 'the code root is a symbolic link'));
        for (const role of ['data', 'cache', 'logs']) {
            if (paths.isSymlink(roots[role], fs)) push(block('PATH_ESCAPE', `the ${role} root is a symbolic link`));
        }
        if (via !== 'local') {
            const bases = paths.allowedBases({ home, platform, env });
            for (const [role, value] of Object.entries(roots)) {
                if (!paths.isUnderAllowedBase(value, bases, { platform, fs })) {
                    push(block('ROOT_OUTSIDE_ALLOWED_BASES', `the ${role} root is not inside a folder the setup pages may use; choose one of the suggested folders, or use the command line`));
                }
            }
        }
        if (requireRoots) {
            if (roots.managerStore !== settings.storeDir) push(block('ROOTS_MISMATCH', 'the manager store is not where this manager keeps it; run the manager with the installation roots in its environment'));
            if (roots.data !== settings.dataDir) push(block('ROOTS_MISMATCH', 'the data root is not the manager\'s data directory; run the manager with GOOBSTER_DATA_DIR set to it'));
            if (roots.config !== settings.configPath) push(block('ROOTS_MISMATCH', 'the config root is not the manager\'s config path; run the manager with GOOBSTER_CONFIG_PATH set to it'));
        }
    }

    // --- permissions ----------------------------------------------------------
    if (pathsOk) {
        for (const [role, target] of Object.entries(roots)) {
            const probe = role === 'config' ? path.dirname(target) : target;
            const existing = ancestorExists(probe, fs);
            if (!existing) {
                push(block('ROOT_UNREACHABLE', `no part of the ${role} root exists`));
            } else if (!writable(existing, fs)) {
                push(block('ROOT_NOT_WRITABLE', `the ${role} root is not writable by the runtime user`));
            }
        }
        if (POSIX) {
            try {
                const store = fs.statSync(roots.managerStore);
                if (typeof process.getuid === 'function' && process.getuid() !== 0 && store.uid !== process.getuid()) push(block('STORE_NOT_OWNED', 'the manager store belongs to another user'));
                else if ((store.mode & 0o077) !== 0) push(warn('STORE_NOT_OWNER_ONLY', 'the manager store is readable by others; the manager restricts it when it starts'));
            } catch { }
        }
        const current = (() => { try { return os.userInfo().username; } catch { return null; } })();
        // The account rules of a service manager that creates POSIX accounts; one that assigns the identity itself has none to check here.
        if (accountCreatable && runtimeUser && createRuntimeUser && current && runtimeUser !== current && euid !== 0) {
            push(block('CREATE_USER_NEEDS_ROOT', 'creating the runtime account needs the installer to run as root (for example with sudo); run it that way, or leave the dedicated account out'));
        } else if (accountCreatable && runtimeUser && current && runtimeUser !== current && euid !== 0 && !createRuntimeUser) {
            push(block('RUNTIME_USER_MISMATCH', 'the installer runs as another user than the runtime user; run it as that user, or as root (creating the account is the privileged user.create step)'));
        }
        if (POSIX && typeof process.getuid === 'function' && process.getuid() === 0 && !runtimeUser) {
            push(warn('RUNNING_AS_ROOT', 'the installer is running as root; the application should run as an unprivileged user'));
        }
        if (registerService && kind === 'install.new' && unitNames.length > 0) {
            push(block('SERVICE_DUPLICATE', `a service named ${unitNames.slice(0, 3).join(', ')} already exists on this machine and was not registered by this installation; adopt that installation, remove the service, or install without registering one`));
        }
    }

    // --- release: target, ABI, selection, disk --------------------------------
    let selected = features;
    if (manifest) {
        if (manifest.target.platform !== platform || manifest.target.arch !== arch) {
            push(block('TARGET_MISMATCH', `the release is built for ${manifest.target.id}, this host is ${platform}-${arch}`));
        }
        if (!release.carriesRuntime(manifest) && String(manifest.node.abi) !== String(abi)) {
            push(block('ABI_MISMATCH', `the release needs Node ABI ${manifest.node.abi}; this host runs ${abi} and the payload does not carry its own runtime`));
        }
        let resolved = null;
        try {
            resolved = release.selection(manifest, features);
        } catch (error) {
            push(block(error.code || 'UNKNOWN_FEATURE', 'the selected features are not a valid selection of this release'));
        }
        if (resolved) {
            selected = resolved.resolved.features;
            const asked = new Set(features);
            const added = selected.filter(id => id !== 'core' && !asked.has(id));
            if (added.length) push(warn('FEATURES_ADDED_BY_DEPENDENCY', `${added.join(', ')} ${added.length === 1 ? 'is' : 'are'} required by the selection`));
            const need = Math.ceil(resolved.bytes * DISK_MARGIN) + DISK_FLOOR_BYTES + (kind === 'install.repair' ? directorySize(roots.data, fs) : 0);
            const where = ancestorExists(roots.code, fs);
            const free = where ? freeBytes(where, fs) : null;
            if (free === null) push(warn('DISK_UNKNOWN', 'free disk space could not be read'));
            else if (free < need) push(block('DISK_SPACE', `about ${Math.ceil(need / 1048576)} MB are needed and ${Math.floor(free / 1048576)} MB are free`));
            for (const id of selected) {
                for (const system of (manifest.groups[id] && manifest.groups[id].system) || []) {
                    if (!onPath(system.name, { env, fs, home })) {
                        push(warn('SYSTEM_DEPENDENCY_MISSING', `${system.name} (${system.kind}) is used by ${id} and was not found; it is reported, never installed`));
                    }
                }
            }
        }
    }

    // --- layout and database --------------------------------------------------
    if (layout === 'paired' && !settings.dbUrl) push(block('PAIRED_REQUIRES_POSTGRES', 'the paired layout needs GOOBSTER_DB_URL'));
    if (layout === 'paired' && !env.GOOBSTER_INTERNAL_TOKEN) push(warn('PAIRED_REQUIRES_INTERNAL_TOKEN', 'the paired layout needs GOOBSTER_INTERNAL_TOKEN before it starts'));
    if (database.engine === 'postgres' && !settings.dbUrl) push(block('POSTGRES_URL_MISSING', 'a Postgres database was chosen and GOOBSTER_DB_URL is not set'));

    // --- ports ----------------------------------------------------------------
    const { list, managerPort } = portsFor({ layout, features: selected, env, settings });
    if (includeManagerPort && !managerListening && managerPort) list.push({ name: 'manager', port: managerPort });
    for (const entry of list) {
        if (entry.port === 0) continue;
        const state = await probePort(entry.port);
        if (state === 'busy') {
            const make = kind === 'install.new' ? block : warn;
            push(make('PORT_IN_USE', `the ${entry.name} port ${entry.port} is already in use`));
        }
    }

    if (Number(process.versions.node.split('.')[0]) < 20) push(warn('NODE_OLD', 'the manager needs Node 20 or later'));

    return { ok: !findings.some(item => item.severity === 'block'), findings };
}

module.exports = { runPreflight, defaultProbePort, portsFor };
