/**
 * Generated credentials of a Docker Postgres instance. 24 random bytes as
 * base64url: 32 characters of [A-Za-z0-9_-], so they need no escaping in a
 * connection URL or a SCRAM verifier. They are returned to the caller, which
 * keeps them in an operation's private input and writes only the application
 * password, and only into the overlay (environment.js).
 */

const crypto = require('node:crypto');

const generate = () => crypto.randomBytes(24).toString('base64url');

function generatePair() {
    return { application: generate(), superuser: generate() };
}

module.exports = { generate, generatePair };
