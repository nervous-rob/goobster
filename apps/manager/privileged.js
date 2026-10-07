/**
 * The closed list of privileged operations: the only things that will ever
 * need more than the manager's own unprivileged account (registering the
 * OS service, creating the runtime user, installing a package). They are
 * declared here and nowhere else, kept out of the ordinary operation kinds
 * (the engine refuses to register a kind with one of these names).
 *
 * This file is the dispatcher: `run()` hands an operation to the platform
 * helper (`privileged/<platform>.js`, started elevated by `privileged/elevate.js`
 * with one JSON request on stdin). The HTTP route never reaches it: `request()`
 * still answers 501, so a browser session can never trigger a privileged
 * action. Windows and macOS drop their helper into `PLATFORM_MODULES` and
 * `IMPLEMENTED` without touching anything else.
 */

const { ManagerError } = require('./errors');

const PRIVILEGED_OPERATIONS = Object.freeze([
    'service.register',
    'service.unregister',
    'package.install',
    'updater.disable',
    'user.create'
]);

/**
 * The input each operation takes, strictly validated by `privileged/protocol.js`
 * before anything is spawned. Values are names of settings, never a credential.
 */
const INPUT_SHAPES = Object.freeze({
    'service.register': { kind: "'systemd'|'windows-service'|'launchd' (the platform's kind, apps/manager/platform/serviceKinds.js)", name: 'identifier (^[a-z][a-z0-9-]{0,31}$)', layout: "'lite'|'standalone'|'paired'", codeRoot: 'absolute path', runtimeUser: 'identifier', installationId: 'uuid', roots: 'absolute paths for code, data, config, cache, logs, uploads, managerStore', mode: "'payload'|'checkout' (optional)", nodePath: 'absolute path (checkout mode only)', scope: "'machine'|'user' (optional, default machine; 'user' is a launchd LaunchAgent)" },
    'service.unregister': { kind: "'systemd'|'windows-service'|'launchd'", name: 'identifier', registeredBy: "'installer'", installationId: 'uuid' },
    'package.install': { names: 'string[] (system dependency names from the release manifest)' },
    'updater.disable': { mechanism: "'systemd-timer'|'cron-system'", unit: 'timer unit or cron file name', codeRoot: 'absolute path' },
    'user.create': { name: 'identifier', home: 'absolute path', system: 'true', installationId: 'uuid', roots: 'absolute paths as for service.register', mode: "'payload'|'checkout' (optional)" }
});

/** Operations each platform helper implements; the rest answer 501. */
const IMPLEMENTED = Object.freeze({
    linux: Object.freeze(['service.register', 'service.unregister', 'updater.disable', 'user.create']),
    win32: Object.freeze([]),
    darwin: Object.freeze(['service.register', 'service.unregister', 'user.create'])
});

const PLATFORM_MODULES = Object.freeze({
    linux: () => require('./privileged/linux'),
    darwin: () => require('./privileged/darwin')
});

function isPrivileged(name) {
    return PRIVILEGED_OPERATIONS.includes(name);
}

/** @throws {ManagerError} always: 404 for an unknown name, 501 for a declared one */
function request(name) {
    if (!isPrivileged(name)) {
        throw new ManagerError(404, 'UNKNOWN_OPERATION', 'There is no such privileged operation.');
    }
    throw new ManagerError(501, 'NOT_IMPLEMENTED', `The privileged operation "${name}" is not available in this version.`);
}

function implementationFor(platform) {
    const load = PLATFORM_MODULES[platform];
    return load ? load() : null;
}

function isImplemented(name, platform = process.platform) {
    return (IMPLEMENTED[platform] || []).includes(name);
}

/**
 * Run one privileged operation through the platform helper (a separate,
 * elevated process; the manager itself never runs elevated). Validation errors
 * throw a ManagerError; everything else comes back as the runner's result
 * ({ status: 'done' | 'fallback' | 'failed', ... }). An operation or platform
 * with no helper throws 501 NOT_IMPLEMENTED.
 */
async function run(name, input, options = {}) {
    if (!isPrivileged(name)) {
        throw new ManagerError(404, 'UNKNOWN_OPERATION', 'There is no such privileged operation.');
    }
    const platform = options.platform || process.platform;
    const implementation = options.implementation || implementationFor(platform);
    if (!implementation || !isImplemented(name, platform)) {
        throw new ManagerError(501, 'NOT_IMPLEMENTED', `The privileged operation "${name}" is not available on this platform in this version.`);
    }
    const { runHelper } = require('./privileged/elevate');
    try {
        return await runHelper({ ...options, operation: name, input, implementation });
    } catch (error) {
        if (error && error.name === 'HelperError') {
            throw new ManagerError(400, error.code || 'INVALID_INPUT', error.message);
        }
        throw error;
    }
}

function describe(platform = process.platform) {
    return { operations: [...PRIVILEGED_OPERATIONS], implemented: (IMPLEMENTED[platform] || []).length > 0, implementedOperations: [...(IMPLEMENTED[platform] || [])], platform };
}

module.exports = { PRIVILEGED_OPERATIONS, INPUT_SHAPES, IMPLEMENTED, isPrivileged, isImplemented, request, run, describe };
