/**
 * Password hashing for native accounts.
 *
 * Uses Node's built-in scrypt (RFC 7914) rather than a native addon: no
 * ARM64 prebuild to chase on a Raspberry Pi, no extra dependency to audit,
 * and OWASP lists scrypt as an acceptable memory-hard choice. Every hash
 * carries its own parameters so the cost can rise later without a
 * migration - `needsRehash` tells the caller to re-hash after a successful
 * verify. Verification work is bounded by a small in-process semaphore so a
 * burst of login attempts cannot pin all of a small host's memory.
 *
 * Nothing here is hand-rolled cryptography: salt from randomBytes, the KDF
 * from node:crypto, comparison with timingSafeEqual.
 */

const crypto = require('node:crypto');

const ALGORITHM = 'scrypt';
const KEY_LEN = 32;
const SALT_LEN = 16;
const R = 8;
const P = 1;
const MAX_CONCURRENT = 2;

let inFlight = 0;
const waiters = [];

function acquire() {
    if (inFlight < MAX_CONCURRENT) {
        inFlight += 1;
        return Promise.resolve();
    }
    return new Promise(resolve => waiters.push(resolve)).then(() => { inFlight += 1; });
}

function release() {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
}

function scrypt(password, salt, logN) {
    const N = 2 ** logN;
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 }, (error, key) => {
            if (error) reject(error); else resolve(key);
        });
    });
}

/**
 * @param {string} password
 * @param {{ logN: number }} opts
 * @returns {Promise<{ hash: string, params: { algorithm: string, logN: number, r: number, p: number, keyLen: number } }>}
 */
async function hashPassword(password, { logN }) {
    const salt = crypto.randomBytes(SALT_LEN);
    await acquire();
    try {
        const key = await scrypt(String(password), salt, logN);
        return {
            hash: `${ALGORITHM}$${logN}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`,
            params: { algorithm: ALGORITHM, logN, r: R, p: P, keyLen: KEY_LEN }
        };
    } finally {
        release();
    }
}

/**
 * @param {string} password
 * @param {string} stored - the `scrypt$logN$r$p$salt$key` string
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;
    const logN = Number.parseInt(parts[1], 10);
    if (!Number.isInteger(logN) || logN < 10 || logN > 20) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (salt.length !== SALT_LEN || expected.length !== KEY_LEN) return false;
    await acquire();
    try {
        const key = await scrypt(String(password), salt, logN);
        return crypto.timingSafeEqual(key, expected);
    } finally {
        release();
    }
}

/** True when a stored hash was made with a lower cost than the current setting. */
function needsRehash(stored, { logN }) {
    const parts = String(stored || '').split('$');
    return parts[0] !== ALGORITHM || Number.parseInt(parts[1], 10) < logN;
}

module.exports = { hashPassword, verifyPassword, needsRehash, ALGORITHM };
