/**
 * Passphrase-based authenticated encryption for small secrets at rest -
 * the encrypted config.json inside a backup archive
 * (documentation/backup_and_restore.md).
 *
 * Construction: scrypt(passphrase, salt) -> 32-byte key, AES-256-GCM with a
 * random 12-byte nonce. The envelope is plain JSON so an operator can see
 * the parameters, and the GCM tag means a wrong passphrase fails before a
 * single byte of plaintext exists - a bad key can never produce a corrupt
 * config.json. Nothing about the passphrase is stored.
 *
 * scrypt N=2^15, r=8, p=1 costs about 32 MB and well under a second on a
 * Raspberry Pi 4; the parameters ride in the envelope so they can be raised
 * later without breaking older archives.
 */

const crypto = require('node:crypto');

const FORMAT = 'goobster-passphrase-v1';
const KDF = { N: 2 ** 15, r: 8, p: 1, keyLength: 32 };
const CIPHER = 'aes-256-gcm';

class PassphraseError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'PassphraseError';
        this.code = code;
    }
}

function deriveKey(passphrase, salt, params) {
    return crypto.scryptSync(
        Buffer.from(String(passphrase), 'utf8'),
        salt,
        params.keyLength,
        { N: params.N, r: params.r, p: params.p, maxmem: 128 * 1024 * 1024 }
    );
}

/**
 * Encrypt bytes under a passphrase.
 * @param {Buffer|string} plaintext
 * @param {string} passphrase - non-empty
 * @returns {Object} envelope (JSON-serializable)
 */
function encryptWithPassphrase(plaintext, passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
        throw new PassphraseError('EMPTY_PASSPHRASE', 'A passphrase is required.');
    }
    const salt = crypto.randomBytes(16);
    const nonce = crypto.randomBytes(12);
    const key = deriveKey(passphrase, salt, KDF);
    const cipher = crypto.createCipheriv(CIPHER, key, nonce);
    const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    const tag = cipher.getAuthTag();
    key.fill(0);
    return {
        format: FORMAT,
        kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, keyLength: KDF.keyLength, salt: salt.toString('base64') },
        cipher: CIPHER,
        nonce: nonce.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64')
    };
}

/**
 * Decrypt an envelope. Throws PassphraseError('BAD_PASSPHRASE') when the
 * passphrase is wrong or the envelope was altered; nothing is returned
 * partially.
 * @param {Object} envelope
 * @param {string} passphrase
 * @returns {Buffer}
 */
function decryptWithPassphrase(envelope, passphrase) {
    if (!envelope || envelope.format !== FORMAT || envelope.cipher !== CIPHER || envelope.kdf?.name !== 'scrypt') {
        throw new PassphraseError('BAD_ENVELOPE', 'Not a recognised encrypted file.');
    }
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
        throw new PassphraseError('EMPTY_PASSPHRASE', 'A passphrase is required.');
    }
    const params = {
        N: Number(envelope.kdf.N), r: Number(envelope.kdf.r), p: Number(envelope.kdf.p),
        keyLength: Number(envelope.kdf.keyLength)
    };
    if (![params.N, params.r, params.p, params.keyLength].every(n => Number.isInteger(n) && n > 0)) {
        throw new PassphraseError('BAD_ENVELOPE', 'The encrypted file has unusable key-derivation parameters.');
    }
    const key = deriveKey(passphrase, Buffer.from(envelope.kdf.salt, 'base64'), params);
    try {
        const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(envelope.nonce, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
            decipher.final()
        ]);
    } catch (error) {
        throw new PassphraseError('BAD_PASSPHRASE', 'Wrong passphrase (or the file was altered).', { cause: error });
    } finally {
        key.fill(0);
    }
}

module.exports = { encryptWithPassphrase, decryptWithPassphrase, PassphraseError, FORMAT };
