/**
 * A SCRAM-SHA-256 verifier (RFC 5802 / RFC 7677, PostgreSQL's stored form) for
 * a password, so the privileged helper can create the application role with
 * `PASSWORD '<verifier>'` and never see - or log, or write into a server log
 * line that echoes a failed statement - the password itself. Postgres accepts
 * a verifier wherever it accepts a password and stores it unchanged; the
 * application still connects with the plain password, which the server checks
 * against the verifier.
 *
 *   SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
 *
 * The generated passwords are base64url (ASCII), so SASLprep is the identity.
 */

const crypto = require('node:crypto');

const ITERATIONS = 4096;

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * @param {string} password
 * @param {{ salt?: Buffer, iterations?: number }} [options] (tests pass a fixed salt)
 * @returns {string}
 */
function verifier(password, { salt = crypto.randomBytes(16), iterations = ITERATIONS } = {}) {
    if (typeof password !== 'string' || password.length === 0) throw new Error('a password is required');
    if (!/^[\x21-\x7e]+$/.test(password)) throw new Error('the password must be printable ASCII');
    const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    const clientKey = hmac(salted, 'Client Key');
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();
    const serverKey = hmac(salted, 'Server Key');
    return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const SHAPE = /^SCRAM-SHA-256\$\d{1,6}:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;

const isVerifier = (value) => typeof value === 'string' && value.length < 256 && SHAPE.test(value);

module.exports = { ITERATIONS, verifier, isVerifier, SHAPE };
