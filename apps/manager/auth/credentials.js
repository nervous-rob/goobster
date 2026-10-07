/**
 * One-time local credentials: the first-time setup (bootstrap) credential
 * and the recovery credential. 32 random bytes, base64url; only a SHA-256
 * hash and the expiry are kept in `<kind>.json`. The plaintext is written
 * once to an owner-only file `<kind>-credential` for the local operator and
 * removed when the credential is used. Using a credential consumes it, so a
 * replay is refused.
 */

const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const files = require('../store/files');
const { ManagerError } = require('../errors');

const CREDENTIAL_VERSION = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const KINDS = {
    bootstrap: { record: 'bootstrap', plaintext: 'bootstrapCredential', code: 'BOOTSTRAP' },
    recovery: { record: 'recovery', plaintext: 'recoveryCredential', code: 'RECOVERY' }
};
const SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();

/**
 * @param {Object} params
 * @param {{ paths: Object }} params.store
 * @param {'bootstrap'|'recovery'} params.kind
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 * @param {number} [params.ttlMs]
 */
function createOneTimeCredential({ store, kind, fs = nodeFs, now = () => new Date(), ttlMs = DEFAULT_TTL_MS }) {
    const spec = KINDS[kind];
    if (!spec) throw new Error(`unknown credential kind ${kind}`);
    const recordFile = store.paths[spec.record];
    const plaintextFile = store.paths[spec.plaintext];

    function readRecord() {
        const read = files.readJson(recordFile, fs);
        const value = read.value;
        if (!read.exists || read.problem || !files.isPlainObject(value) || value.version !== CREDENTIAL_VERSION
            || typeof value.hash !== 'string' || typeof value.expiresAt !== 'string') {
            return null;
        }
        return value;
    }

    /**
     * Mint a new credential, replacing any previous one of this kind.
     * @returns {{ credential: string, expiresAt: string, file: string }} the only time the plaintext leaves this module
     */
    function mint() {
        files.ensureDir(store.paths.root, fs);
        const credential = crypto.randomBytes(32).toString('base64url');
        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + ttlMs).toISOString();
        files.writeAtomic(plaintextFile, `${credential}\n`, fs);
        files.writeJsonAtomic(recordFile, {
            version: CREDENTIAL_VERSION,
            kind,
            hash: digest(credential).toString('hex'),
            createdAt: createdAt.toISOString(),
            expiresAt
        }, fs);
        return { credential, expiresAt, file: plaintextFile };
    }

    /**
     * Check `presented` and consume it. Throws 401 `<KIND>_INVALID` for a
     * wrong, missing or already used credential, `<KIND>_EXPIRED` for the
     * right one past its expiry.
     */
    function consume(presented) {
        const invalid = new ManagerError(401, `${spec.code}_INVALID`, `The ${kind} credential is not valid.`);
        if (typeof presented !== 'string' || !SHAPE.test(presented)) throw invalid;
        const record = readRecord();
        if (!record) throw invalid;
        const expected = Buffer.from(record.hash, 'hex');
        const actual = digest(presented);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw invalid;
        if (Date.parse(record.expiresAt) <= now().getTime()) {
            throw new ManagerError(401, `${spec.code}_EXPIRED`, `The ${kind} credential has expired; mint a new one locally.`);
        }
        const claimed = `${recordFile}.consumed-${crypto.randomBytes(4).toString('hex')}`;
        try {
            fs.renameSync(recordFile, claimed);
        } catch {
            throw invalid;
        }
        files.removeIfPresent(claimed, fs);
        files.removeIfPresent(plaintextFile, fs);
        files.fsyncDir(store.paths.root, fs);
        return { expiresAt: record.expiresAt };
    }

    /** Drop any pending credential of this kind (after the state it serves no longer applies). */
    function revoke() {
        files.removeIfPresent(recordFile, fs);
        files.removeIfPresent(plaintextFile, fs);
    }

    /** Status view: whether one is pending and until when. Never the hash. */
    function describe() {
        const record = readRecord();
        if (!record) return { pending: false, expiresAt: null, expired: false };
        const expired = Date.parse(record.expiresAt) <= now().getTime();
        return { pending: !expired, expiresAt: record.expiresAt, expired };
    }

    return { kind, mint, consume, revoke, describe, plaintextFile };
}

module.exports = { createOneTimeCredential, CREDENTIAL_VERSION, DEFAULT_TTL_MS };
