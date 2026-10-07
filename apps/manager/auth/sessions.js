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
const COOKIE_NAME = 'goobster-manager-session';
const COOKIE_PATH = '/manager';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

const hash = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * The session token in a `Cookie` header, or null. A header that names the
 * cookie twice is treated as absent: which one the browser meant is not
 * knowable, and a token is never guessed.
 * @returns {string|null}
 */
function readSessionCookie(header) {
    if (typeof header !== 'string' || header.length === 0 || header.length > 8192) return null;
    const found = [];
    for (const part of header.split(';')) {
        const at = part.indexOf('=');
        if (at < 0) continue;
        if (part.slice(0, at).trim() === COOKIE_NAME) found.push(part.slice(at + 1).trim());
    }
    if (found.length !== 1 || !TOKEN_SHAPE.test(found[0])) return null;
    return found[0];
}

/**
 * The `Set-Cookie` value that carries a session in a browser: HttpOnly (script
 * never reads it), SameSite=Strict, scoped to /manager, and Secure when the
 * manager serves TLS (LAN mode).
 */
function sessionCookie(token, { expiresAt, secure = false, now = new Date() } = {}) {
    const seconds = Math.max(1, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000));
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=${COOKIE_PATH}; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}

function clearedSessionCookie({ secure = false } = {}) {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=${COOKIE_PATH}; Max-Age=0${secure ? '; Secure' : ''}`;
}

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

    /** End one session (logout). @returns {boolean} whether it existed */
    function revoke(token) {
        if (typeof token !== 'string' || token.length < 20 || token.length > 128) return false;
        return sessions.delete(hash(token));
    }

    return { issue, authenticate, useNonce, revokeAll, revoke, size: () => sessions.size };
}

module.exports = {
    createSessionRegistry,
    DEFAULT_TTL_MS,
    COOKIE_NAME,
    COOKIE_PATH,
    readSessionCookie,
    sessionCookie,
    clearedSessionCookie
};
