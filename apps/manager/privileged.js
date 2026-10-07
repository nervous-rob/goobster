/**
 * The closed list of privileged operations: the only things that will ever
 * need more than the manager's own unprivileged account (registering the
 * OS service, installing a package). They are declared here and nowhere
 * else, kept out of the ordinary operation kinds (the engine refuses to
 * register a kind with one of these names), and not implemented in this
 * phase: a request validates the name and answers 501. The bootstrapper
 * work (installer Phase 3) implements them behind a separate, narrowly
 * scoped helper; the manager never runs a shell command for them.
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
 * The input each operation will take when #331-#333 implement it. Declared
 * here so the install engine can say which of its steps need privilege and
 * the bootstrappers know what to build; nothing validates or runs it yet.
 * Values are names of settings, never a credential.
 */
const INPUT_SHAPES = Object.freeze({
    'service.register': { kind: "'systemd'|'windows-service'|'launchd'", name: 'string', layout: "'lite'|'standalone'|'paired'", codeRoot: 'absolute path', runtimeUser: 'string' },
    'service.unregister': { kind: "'systemd'|'windows-service'|'launchd'", name: 'string', registeredBy: "'installer'" },
    'package.install': { names: 'string[] (system dependency names from the release manifest)' },
    'updater.disable': { mechanism: "'systemd-timer'|'cron-system'", unit: 'string', codeRoot: 'absolute path' },
    'user.create': { name: 'string', home: 'absolute path', system: 'boolean' }
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

function describe() {
    return { operations: [...PRIVILEGED_OPERATIONS], implemented: false };
}

module.exports = { PRIVILEGED_OPERATIONS, INPUT_SHAPES, isPrivileged, request, describe };
