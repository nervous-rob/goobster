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

const PRIVILEGED_OPERATIONS = Object.freeze(['service.register', 'service.unregister', 'package.install']);

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

module.exports = { PRIVILEGED_OPERATIONS, isPrivileged, request, describe };
