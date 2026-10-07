/**
 * The manager side of the authenticated portal bridge.
 *
 * The manager owns the HMAC key (`<store>/bridge-key`, owner-only) and
 * verifies the per-request assertions the core API mints with
 * `packages/core/web/managerBridge.js` after `requireOperator` passed.
 * A verified assertion yields the operator's principal id; every check
 * failure is a 401/403 with a code, never the reason in detail.
 *
 * Stronger authentication (#255) is a separate enrollment. Until it exists
 * `requireStrongAuth()` answers false and nothing here emulates it; when it
 * lands, the assertion gains a claim the portal sets only after the
 * stronger factor, and `verify()` refuses mutations without it when
 * `requireStrongAuth()` is true.
 */

const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const coreBridge = require('@goobster/core/web/managerBridge');
const files = require('../store/files');
const { ManagerError } = require('../errors');
const { createNonceCache } = require('./nonces');

const CLOCK_SKEW_SECONDS = 30;

function requireStrongAuth() {
    return false;
}

/**
 * @param {Object} params
 * @param {{ paths: { bridgeKey: string, root: string } }} params.store
 * @param {Object} [params.fs]
 * @param {() => Date} [params.now]
 */
function createBridgeVerifier({ store, fs = nodeFs, now = () => new Date(), nonces = null }) {
    const seen = nonces || createNonceCache({ now: () => now().getTime() });

    /** Make sure a key exists for `installationId`; a key for another installation is replaced. */
    function ensureKey(installationId) {
        try {
            const current = coreBridge.readBridgeKey(store.paths.bridgeKey, fs);
            if (current.installationId === installationId) return { created: false };
        } catch { }
        files.ensureDir(store.paths.root, fs);
        files.writeJsonAtomic(store.paths.bridgeKey, {
            version: coreBridge.BRIDGE_KEY_VERSION,
            installationId,
            keyId: crypto.randomBytes(6).toString('hex'),
            key: crypto.randomBytes(32).toString('base64url'),
            createdAt: now().toISOString()
        }, fs);
        return { created: true };
    }

    const refuse = (code, message = 'The manager assertion is not valid.') => new ManagerError(401, code, message);

    /**
     * @param {string} token the X-Goobster-Manager-Assertion header
     * @param {{ method: string, path: string, installationId: string }} request
     * @returns {{ principalId: string, role: string, exp: number, nonce: string }}
     */
    function verify(token, { method, path: requestPath, installationId }) {
        if (typeof token !== 'string' || token.length > 4096) throw refuse('ASSERTION_INVALID');
        const parts = token.split('.');
        if (parts.length !== 3 || parts[0] !== coreBridge.ASSERTION_PREFIX) throw refuse('ASSERTION_INVALID');
        let key;
        try {
            key = coreBridge.readBridgeKey(store.paths.bridgeKey, fs);
        } catch {
            throw new ManagerError(503, 'MANAGER_BRIDGE_UNAVAILABLE', 'The manager bridge is not set up on this installation.');
        }
        const expected = crypto.createHmac('sha256', key.key).update(coreBridge.signingInput(parts[1])).digest();
        let presented;
        try {
            presented = Buffer.from(parts[2], 'base64url');
        } catch {
            throw refuse('ASSERTION_INVALID');
        }
        if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
            throw refuse('ASSERTION_INVALID');
        }
        let payload;
        try {
            payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        } catch {
            throw refuse('ASSERTION_INVALID');
        }
        if (!files.isPlainObject(payload) || payload.v !== 1) throw refuse('ASSERTION_INVALID');
        if (payload.purpose !== coreBridge.PURPOSE) throw refuse('ASSERTION_PURPOSE', 'The assertion was not issued for the manager.');
        if (payload.installationId !== installationId || key.installationId !== installationId) {
            throw refuse('ASSERTION_INSTALLATION', 'The assertion was issued for another installation.');
        }
        const t = Math.floor(now().getTime() / 1000);
        if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
            || payload.exp - payload.iat > coreBridge.MAX_TTL_SECONDS || payload.exp <= payload.iat
            || payload.iat > t + CLOCK_SKEW_SECONDS) {
            throw refuse('ASSERTION_INVALID');
        }
        if (payload.exp <= t) throw refuse('ASSERTION_EXPIRED', 'The assertion has expired.');
        if (payload.req !== coreBridge.requestBinding(method, requestPath)) {
            throw refuse('ASSERTION_REQUEST', 'The assertion was issued for another request.');
        }
        if (typeof payload.principalId !== 'string' || !payload.principalId || payload.principalId.length > 200) {
            throw refuse('ASSERTION_INVALID');
        }
        if (payload.role !== 'operator') throw new ManagerError(403, 'FORBIDDEN', 'Only the host can do that.');
        if (typeof payload.nonce !== 'string' || payload.nonce.length < 16 || payload.nonce.length > 64
            || !seen.use(`bridge:${payload.nonce}`, payload.exp * 1000)) {
            throw refuse('ASSERTION_REPLAYED', 'The assertion was already used.');
        }
        return { principalId: payload.principalId, role: payload.role, exp: payload.exp, nonce: payload.nonce };
    }

    return { ensureKey, verify, requireStrongAuth };
}

module.exports = { createBridgeVerifier, requireStrongAuth, CLOCK_SKEW_SECONDS };
