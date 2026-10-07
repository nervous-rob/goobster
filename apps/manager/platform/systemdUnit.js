/**
 * The systemd unit the installer registers (documentation/linux_install.md).
 *
 * Pure text in, text out: no file is read or written here and nothing
 * touches the manager's own modules, because the privileged helper
 * (../privileged/linux.js) runs this code as root and must not load anything
 * the unprivileged manager tree could have changed beyond its own two
 * directories. Node built-ins only.
 *
 * Two shapes of installation get a unit:
 *
 *   payload   `<code>/current` is an activated release payload (bundled Node
 *             under runtime/, code under app/): the installer's own install.
 *   checkout  a source working copy run by the system's Node, as
 *             scripts/install-rpi.sh lays it out. deploy/goobster.service is
 *             `renderReferenceUnit()` of the documented Raspberry Pi paths;
 *             tests/linuxService.test.js keeps the two byte for byte equal.
 *
 * The unit is the installation's service, not a copy of the operator's
 * unrelated services: it carries an `X-Goobster-Installation=` marker in
 * `[Unit]` that the helper checks before it overwrites or removes anything.
 */

const path = require('node:path');

const UNIT_DIR = '/etc/systemd/system';
const MARKER_KEY = 'X-Goobster-Installation';
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUNTIME_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
/** Characters that would end a quoted unit value or start an expansion; spaces and non-ASCII letters are fine. */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f"'\\$%`]/;

function assertSafePath(value, what) {
    if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value.length > 1024 || UNSAFE_PATH_CHARS.test(value)) {
        throw new Error(`${what} is not a path a unit can carry`);
    }
    if (path.posix.normalize(value) !== value || (value.length > 1 && value.endsWith('/'))) throw new Error(`${what} is not normalised`);
    return value;
}

/** A double-quoted systemd word. The path rules above leave nothing to escape. */
function quote(value) {
    if (typeof value !== 'string' || UNSAFE_PATH_CHARS.test(value)) throw new Error('a unit value holds a character systemd would interpret');
    return `"${value}"`;
}

function unitFileName(name) {
    if (!SERVICE_NAME.test(name)) throw new Error('the service name is not an identifier');
    return `${name}.service`;
}

function isInsideOrSame(parent, child) {
    return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/**
 * The environment a unit (and the roots file beside the code root) carries.
 * The roots are the installation's own; `GOOBSTER_WORKSPACE_ROOT` is where the
 * application code is (the payload's `app/` directory, or a checkout itself),
 * which is not the install's code root. Never a secret, never a token.
 */
function serviceEnvironment({ roots, layout, mode = 'payload' }) {
    const workspace = mode === 'payload' ? `${roots.code}/current/app` : roots.code;
    return [
        ['NODE_ENV', 'production'],
        ['GOOBSTER_SUPERVISOR', 'systemd'],
        ['GOOBSTER_RUNTIME_MODE', layout],
        ['GOOBSTER_WORKSPACE_ROOT', workspace],
        ['GOOBSTER_DATA_DIR', roots.data],
        ['GOOBSTER_CONFIG_PATH', roots.config],
        ['GOOBSTER_CACHE_DIR', roots.cache],
        ['GOOBSTER_LOG_DIR', roots.logs],
        ['GOOBSTER_MANAGER_STATE_DIR', roots.managerStore]
    ];
}

/**
 * Paths the service writes: the mutable roots and nothing else. A root that
 * lies inside another listed one is not repeated. The config file is written
 * by replacing it, so its directory is the path.
 * @param {Object} params
 * @param {Object} params.roots
 * @param {'payload'|'checkout'} [params.mode] a checkout also updates its own tree
 */
function mutablePaths({ roots, mode = 'payload' }) {
    const candidates = [roots.data, path.posix.dirname(roots.config), roots.cache, roots.logs, roots.uploads, roots.managerStore];
    if (mode === 'checkout') candidates.push(roots.code);
    const unique = [...new Set(candidates)].sort((a, b) => a.length - b.length);
    const kept = [];
    for (const candidate of unique) {
        if (!kept.some(parent => isInsideOrSame(parent, candidate))) kept.push(candidate);
    }
    return kept;
}

/**
 * What `chown` has to cover so the runtime user can write the roots, without
 * handing it the code root: the config directory is taken whole only when it
 * is not the code root itself (or above it), otherwise just the file.
 */
function ownedPaths({ roots, mode = 'payload' }) {
    const out = [];
    const configDir = path.posix.dirname(roots.config);
    const configTree = !isInsideOrSame(configDir, roots.code) || mode === 'checkout';
    const candidates = [roots.data, roots.cache, roots.logs, roots.uploads, roots.managerStore];
    if (configTree) candidates.push(configDir);
    if (mode === 'checkout') candidates.push(roots.code);
    const unique = [...new Set(candidates)].sort((a, b) => a.length - b.length);
    for (const candidate of unique) {
        if (!out.some(parent => isInsideOrSame(parent, candidate))) out.push(candidate);
    }
    if (!configTree && !out.some(parent => isInsideOrSame(parent, roots.config))) out.push(roots.config);
    return out;
}

function execStartFor({ codeRoot, mode, nodePath }) {
    if (mode === 'payload') {
        return `${codeRoot}/current/runtime/bin/node`;
    }
    return nodePath;
}

function scriptFor({ codeRoot, mode }) {
    return mode === 'payload' ? `${codeRoot}/current/app/apps/manager/index.js` : `${codeRoot}/apps/manager/index.js`;
}

/**
 * @param {Object} params
 * @param {string} params.name                    unit name without `.service`
 * @param {string|null} [params.installationId]   the marker; null for the hand-copied reference unit
 * @param {string} params.runtimeUser
 * @param {string} params.codeRoot
 * @param {Object} params.roots                   the seven installation roots
 * @param {'lite'|'standalone'|'paired'} params.layout
 * @param {'payload'|'checkout'} [params.mode]
 * @param {string} [params.nodePath]              checkout only: the system Node
 * @param {{ memoryMax?: string, cpuWeight?: number }} [params.limits]
 * @returns {string}
 */
function renderUnit({ name, installationId = null, runtimeUser, codeRoot, roots, layout, mode = 'payload', nodePath = '/usr/bin/node', limits = null, environment = null }) {
    unitFileName(name);
    if (!RUNTIME_USER.test(runtimeUser)) throw new Error('the runtime user is not an account name');
    if (installationId !== null && !UUID.test(installationId)) throw new Error('the installation id is not a UUID');
    assertSafePath(codeRoot, 'the code root');
    for (const [role, value] of Object.entries(roots)) assertSafePath(value, `the ${role} root`);
    if (mode !== 'payload' && mode !== 'checkout') throw new Error('unknown unit mode');
    if (mode === 'checkout') assertSafePath(nodePath, 'the node path');
    const lines = [];
    lines.push('[Unit]');
    lines.push('Description=Goobster (installation manager and its workers)');
    lines.push('After=network-online.target');
    lines.push('Wants=network-online.target');
    if (installationId) lines.push(`${MARKER_KEY}=${installationId}`);
    lines.push('');
    lines.push('[Service]');
    lines.push('Type=simple');
    lines.push(`User=${runtimeUser}`);
    lines.push(`WorkingDirectory=${codeRoot}`);
    lines.push(`ExecStart=${quote(execStartFor({ codeRoot, mode, nodePath }))} ${quote(scriptFor({ codeRoot, mode }))} --supervise`);
    lines.push('Restart=on-failure');
    lines.push('RestartSec=10');
    lines.push('KillMode=mixed');
    lines.push('TimeoutStopSec=120');
    if (limits) {
        lines.push('');
        lines.push('# Resource limits appropriate for a Raspberry Pi 4B (the manager and its');
        lines.push('# workers share this cgroup)');
        if (limits.memoryMax) lines.push(`MemoryMax=${limits.memoryMax}`);
        if (limits.cpuWeight) lines.push(`CPUWeight=${limits.cpuWeight}`);
    }
    lines.push('');
    lines.push('# Hardening: the service writes its own mutable roots and nothing else.');
    lines.push('NoNewPrivileges=true');
    lines.push('PrivateTmp=true');
    lines.push('ProtectSystem=strict');
    for (const writable of mutablePaths({ roots, mode })) lines.push(`ReadWritePaths=${quote(writable)}`);
    lines.push('');
    for (const [key, value] of (environment || serviceEnvironment({ roots, layout, mode }))) lines.push(`Environment=${quote(`${key}=${value}`)}`);
    lines.push('');
    lines.push('[Install]');
    lines.push('WantedBy=multi-user.target');
    lines.push('');
    return lines.join('\n');
}

/** What the installed unit says about its owner. */
function parseUnit(text) {
    const out = { installationId: null, user: null, workingDirectory: null, execStart: null };
    let section = null;
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const head = /^\[([A-Za-z]+)\]$/.exec(line);
        if (head) {
            section = head[1];
            continue;
        }
        const at = line.indexOf('=');
        if (at < 1) continue;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (section === 'Unit' && key === MARKER_KEY) out.installationId = value;
        else if (section === 'Service' && key === 'User') out.user = value;
        else if (section === 'Service' && key === 'WorkingDirectory') out.workingDirectory = value.replace(/^"|"$/g, '');
        else if (section === 'Service' && key === 'ExecStart') out.execStart = value;
    }
    return out;
}

// -------------------------------------------------------------------------
// deploy/goobster.service: the documented Raspberry Pi paths, with its comments
// -------------------------------------------------------------------------

const PI_EXAMPLE = Object.freeze({
    name: 'goobster',
    runtimeUser: 'pi',
    codeRoot: '/home/pi/goobster',
    layout: 'lite',
    mode: 'checkout',
    nodePath: '/usr/bin/node',
    limits: Object.freeze({ memoryMax: '1G', cpuWeight: 80 }),
    roots: Object.freeze({
        code: '/home/pi/goobster',
        data: '/home/pi/goobster/data',
        config: '/home/pi/goobster/config.json',
        cache: '/home/pi/goobster/cache',
        logs: '/home/pi/goobster/logs',
        uploads: '/home/pi/goobster/data/web-uploads',
        managerStore: '/home/pi/goobster/data/manager'
    })
});

const REFERENCE_HEADER = `# Goobster systemd service (Raspberry Pi / any Linux)
#
# This is the unit the installer renders for a source working copy at the
# documented Raspberry Pi paths (apps/manager/platform/systemdUnit.js; the
# test in tests/linuxService.test.js keeps this file identical to that
# output). The installer-registered unit for a release payload differs only
# in its paths and carries an X-Goobster-Installation marker, which is how
# the installer recognises (and never touches anything but) its own unit.
# A unit copied by hand has no marker: the installer treats it as yours.
#
# Install by hand:
#   sudo cp deploy/goobster.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now goobster
#
# Logs:
#   journalctl -u goobster -f            (or see logs/goobster.log)
#
# Adjust User/WorkingDirectory/ExecStart/ReadWritePaths to match your install.
#
# The unit runs the installation manager, which supervises the workers of
# this installation's layout (lite: the bot; standalone: the api; paired:
# bot + api) as its own children: it deploys slash commands when they
# changed, restarts a worker that exits 75 at once and a crashed one with
# backoff, and performs staged restarts (documentation/manager_lifecycle.md).
# The manager listens on 127.0.0.1:3400; from another machine use
#   ssh -L 3400:127.0.0.1:3400 pi@<host>
#
# Stop: systemd sends SIGTERM to the manager only (KillMode=mixed); the
# manager stops each worker (stop new work, at most 45 s of in-flight work,
# then 15 s to exit, then SIGKILL to its process group). TimeoutStopSec
# covers that with room to spare before systemd kills what is left.
#
# ProtectSystem=strict makes the whole file system read-only except the
# ReadWritePaths below (the working copy). A tool the application starts that
# writes elsewhere (a cache under the home directory, say) needs its path
# added there, or a drop-in: sudo systemctl edit goobster.

`;

const REFERENCE_FOOTER = `
# Legacy: run the bot directly, without the manager (existing installs that
# have not moved over yet). Replace the ExecStart/KillMode/TimeoutStopSec
# lines above with these. Exit code 75 still restarts the bot because of
# Restart=on-failure, but nothing performs a staged restart.
#
#   ExecStartPre=/usr/bin/node /home/pi/goobster/apps/bot/deploy-commands.js
#   ExecStart=/usr/bin/node /home/pi/goobster/apps/bot/index.js
#   TimeoutStopSec=75
`;

/** The checked-in `deploy/goobster.service`. */
function renderReferenceUnit(options = PI_EXAMPLE) {
    const body = renderUnit({ ...options, installationId: null });
    return `${REFERENCE_HEADER}${body.replace(/\n+$/, '\n')}${REFERENCE_FOOTER}`;
}

module.exports = {
    UNIT_DIR,
    MARKER_KEY,
    SERVICE_NAME,
    UUID,
    RUNTIME_USER,
    PI_EXAMPLE,
    assertSafePath,
    unitFileName,
    serviceEnvironment,
    mutablePaths,
    ownedPaths,
    renderUnit,
    renderReferenceUnit,
    parseUnit
};
