/**
 * The generated application password of a native PostgreSQL instance: the
 * same 32 URL-safe characters as the Docker option (apps/manager/docker/passwords.js),
 * which are also printable ASCII, so a SCRAM verifier can be computed from them.
 * Only the verifier ever leaves the manager (privileged/protocol.js); the
 * password itself stays in the operation's private input and, once the role
 * exists, in the overlay (environment.js).
 */

const dockerPasswords = require('../docker/passwords');

const generate = () => dockerPasswords.generate();

module.exports = { generate };
