/**
 * The launchd service kind (documentation/macos_install.md, "The service"):
 * what `serviceLifecycle.js` needs to know about launchd that it must not
 * know about systemd or the Windows service manager. The plist text itself is
 * `launchdPlist.js` (Node built-ins only, because the privileged helper loads
 * it as root); this module is the manager's side and may use the manager's
 * own modules.
 *
 * One kind, two scopes (`service.register`'s `scope`):
 *
 *   machine  a LaunchDaemon, `/Library/LaunchDaemons/io.goobster.<name>.plist`, run as the
 *            `_goobster` account, started at boot with no one logged in. Chosen when the
 *            installer runs elevated (root): the pkg's headless install.
 *   user     a LaunchAgent, `~/Library/LaunchAgents/io.goobster.<name>.plist`, run as the
 *            person while they are logged in. Chosen when the installer runs as that
 *            person; it is NOT the always-on mode and needs no administrator rights.
 *
 * The scope follows the installer's own privilege and nothing else: the setup
 * engine only lets a root installer create or name another account for the
 * service (preflight CREATE_USER_NEEDS_ROOT / RUNTIME_USER_MISMATCH), so a
 * person-run installer can only ever register the person's own agent.
 *
 * See `serviceKinds.js` for the shape every kind implements.
 */

const os = require('node:os');
const path = require('node:path');
const plist = require('./launchdPlist');
const systemd = require('./systemdUnit');

const KIND = 'launchd';
const SERVICE_NAME = 'goobster';
const FALLBACK_FILE_NAME = `${plist.LABEL_PREFIX}${SERVICE_NAME}.plist`;
const RUNTIME_ACCOUNT = '_goobster';

function shellQuote(value) {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** Is this process root? Absent `geteuid` (not POSIX) reads as unknown, which the callers treat as the machine default. */
function isElevated() {
    return typeof process.geteuid === 'function' ? process.geteuid() === 0 : null;
}

/** The scope a request carries: a person-run installer registers that person's agent, anything else the daemon. */
function scopeFor({ elevated }) {
    return elevated === false ? 'user' : 'machine';
}

function homeOf(home) {
    if (home) return home;
    try {
        return os.userInfo().homedir || os.homedir();
    } catch {
        return os.homedir();
    }
}

/**
 * Where the service manager keeps the job (the ownership record's `unitPath`). The machine path is fixed; a user
 * job lives under the home directory of the account the manager runs as, which is the account the helper
 * registers it for (a person-run helper is unelevated and acts as that account).
 */
function installedPath(name, { elevated = isElevated(), home = null } = {}) {
    return scopeFor({ elevated }) === 'machine' ? plist.daemonPath(name) : plist.agentPath(name, homeOf(home));
}

/** What an operator types to run the supervisor in the foreground, and to load it by hand. */
function manualInstructions({ codeRoot, mode, nodePath, unitFile, elevated = isElevated(), home = null }) {
    const foreground = mode === 'payload'
        ? `${shellQuote(`${codeRoot}/current/bin/goobster-manager`)} --supervise`
        : `${shellQuote(nodePath)} ${shellQuote(`${codeRoot}/apps/manager/index.js`)} --supervise`;
    const target = installedPath(SERVICE_NAME, { elevated, home });
    if (scopeFor({ elevated }) === 'machine') {
        return {
            foreground,
            boot: [
                `sudo install -m 0644 -o root -g wheel ${shellQuote(unitFile)} ${shellQuote(target)}`,
                `sudo launchctl bootstrap system ${shellQuote(target)}`
            ],
            unitFile
        };
    }
    return {
        foreground,
        boot: [
            `mkdir -p ${shellQuote(path.posix.dirname(target))}`,
            `install -m 0644 ${shellQuote(unitFile)} ${shellQuote(target)}`,
            `launchctl bootstrap "gui/$(id -u)" ${shellQuote(target)}`
        ],
        unitFile
    };
}

const labelOf = `${plist.LABEL_PREFIX}${SERVICE_NAME}`;

module.exports = Object.freeze({
    kind: KIND,
    platforms: Object.freeze(['darwin']),
    serviceName: SERVICE_NAME,
    fallbackFileName: FALLBACK_FILE_NAME,
    installedFileName: (name) => plist.plistFileName(name),
    installedPath,
    render: ({ name, installationId, runtimeUser, codeRoot, roots, layout, mode, nodePath, scope = scopeFor({ elevated: isElevated() }) }) => plist.renderPlist({ name, installationId, runtimeUser, codeRoot, roots, layout, mode, nodePath, scope }),
    manualInstructions,
    /** Depends on who asks (the machine job or the person's agent), so it is read when it is needed. */
    get statusCommand() {
        return scopeFor({ elevated: isElevated() }) === 'machine' ? `launchctl print system/${labelOf}` : `launchctl print gui/$(id -u)/${labelOf}`;
    },
    get removeByHand() {
        return scopeFor({ elevated: isElevated() }) === 'machine'
            ? `sudo launchctl bootout system/${labelOf}, then delete ${plist.daemonPath(SERVICE_NAME)}`
            : `launchctl bootout gui/$(id -u)/${labelOf}, then delete ${installedPath(SERVICE_NAME)}`;
    },
    account: Object.freeze({
        creatable: true,
        accepts: (name) => Boolean(name) && name !== 'root' && systemd.RUNTIME_USER.test(name),
        defaultFor: ({ invoking }) => invoking || null,
        fallbackName: RUNTIME_ACCOUNT
    }),
    registerInput: ({ name, layout, codeRoot, runtimeUser, installationId, roots, mode, nodePath, elevated }) => ({
        kind: KIND,
        scope: scopeFor({ elevated }),
        name,
        layout,
        codeRoot,
        runtimeUser,
        installationId,
        roots,
        mode,
        ...(mode === 'checkout' ? { nodePath } : {})
    }),
    unregisterInput: ({ name, installationId }) => ({ kind: KIND, name, registeredBy: 'installer', installationId }),
    RUNTIME_ACCOUNT,
    scopeFor
});
