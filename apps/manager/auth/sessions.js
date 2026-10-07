/**
 * Short-lived local sessions, held in memory only (a restart drops them).
 * Issued after a successful claim (`setup`) or recovery unlock
 * (`recovery`), never persisted, never sent to the portal. Each mutation
 * made with a session carries a fresh `X-Goobster-Nonce`, used once.
 */

const crypto = require('node:crypto');
const { createNonceCache } = require('./nonces');

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const NONCE_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;
const KINDS = new Set(['setup', 'recovery']);

const hash = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

function createSessionRegistry({ now = () => new Date(), ttlMs = DEFAULT_TTL_MS, max = 16 } = {}) {
    const sessions = new Map();
    const nonces = createNonceCache({ now: () => now().getTime() });

    function prune() {
        const t = now().getTime();
        for (const [key, session] of sessions) {
            if (session.expiresAtMs <= t) sessions.delete(key);
        }
    }

    /**
     * @param {{ kind: 'setup'|'recovery', notAfter?: number }} params
     * @returns {{ token: string, expiresAt: string, principal: string }}
     */
    function issue({ kind, notAfter = Infinity }) {
        if (!KINDS.has(kind)) throw new Error(`unknown session kind ${kind}`);
        prune();
        while (sessions.size >= max) sessions.delete(sessions.keys().next().value);
        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAtMs = Math.min(now().getTime() + ttlMs, notAfter);
        const session = { id: crypto.randomUUID(), kind, principal: `local:${kind}`, expiresAtMs };
        sessions.set(hash(token), session);
        return { token, expiresAt: new Date(expiresAtMs).toISOString(), principal: session.principal };
    }

    /** @returns {{ id: string, kind: string, principal: string, expiresAtMs: number }|null} */
    function authenticate(token) {
        if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
        const session = sessions.get(hash(token));
        if (!session) return null;
        if (session.expiresAtMs <= now().getTime()) {
            sessions.delete(hash(token));
            return null;
        }
        return session;
    }

    /** @returns {boolean} false for a malformed or reused nonce */
    function useNonce(session, nonce) {
        if (typeof nonce !== 'string' || !NONCE_SHAPE.test(nonce)) return false;
        return nonces.use(`${session.id}:${nonce}`, session.expiresAtMs);
    }

    function revokeAll() {
        sessions.clear();
    }

    return { issue, authenticate, useNonce, revokeAll, size: () => sessions.size };
}

module.exports = { createSessionRegistry, DEFAULT_TTL_MS };
