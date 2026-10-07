/**
 * The portal's server-side client for the installation manager (installer
 * P2.4, #326). Used only by routes/host.js, only after requireAuth +
 * requireOperator, and only over HTTP: core never imports the manager.
 *
 * Every authenticated call mints a fresh single-use assertion bound to that
 * exact request (documentation/manager.md, "The portal bridge"), so the
 * browser never holds a manager credential and a captured header cannot be
 * replayed against another route. "The manager is not running" is a status
 * the Host page can render, not an exception: `reach()` reports it, and
 * `call()` raises a `HostManagerError` the route layer turns into a
 * `503 MANAGER_UNAVAILABLE` body with the same shape as every other
 * portal error.
 *
 * Nothing here logs a request or response body (they carry setting values
 * and, once, a secret on its way to the manager).
 */

const managerConfig = require('../config/managerConfig');
const { createManagerBridge, ManagerBridgeError } = require('./managerBridge');

const STATUS_TIMEOUT_MS = 3000;
const CALL_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 40_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

class HostManagerError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'HostManagerError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

/**
 * The manager's base URL, refused unless it is plain http on loopback or
 * https anywhere; a URL with credentials, a query or a fragment is never
 * accepted. Returns an origin without a trailing slash.
 */
function validateBaseUrl(text) {
    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        throw new HostManagerError(503, 'MANAGER_URL_REFUSED', 'The configured manager address is not a valid URL.');
    }
    const loopback = LOOPBACK.test(parsed.hostname);
    const ok = (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
        && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
        && (parsed.pathname === '/' || parsed.pathname === '');
    if (!ok) {
        throw new HostManagerError(503, 'MANAGER_URL_REFUSED',
            'The configured manager address must be http on this machine or https, with no credentials or path.');
    }
    return parsed.origin;
}

async function readCapped(response) {
    const text = await response.text();
    return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * @param {Object} [options]
 * @param {() => string} [options.baseUrl] defaults to the configured address, read per call
 * @param {Function} [options.fetch]
 * @param {Object} [options.bridge] a managerBridge handle
 */
function createHostManagerClient(options = {}) {
    const fetchImpl = options.fetch || ((...args) => fetch(...args));
    const resolveBase = options.baseUrl || (() => managerConfig.resolveUrl());
    const bridge = options.bridge || createManagerBridge();

    async function send({ method, path, headers = {}, body, timeoutMs }) {
        const base = validateBaseUrl(resolveBase());
        let response;
        try {
            response = await fetchImpl(`${base}${path}`, {
                method,
                headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
            throw new HostManagerError(503, 'MANAGER_UNAVAILABLE',
                timedOut ? 'The manager did not answer in time.' : 'The manager is not reachable.',
                { reason: timedOut ? 'TIMEOUT' : 'UNREACHABLE' });
        }
        if (response.status >= 300 && response.status < 400) {
            throw new HostManagerError(503, 'MANAGER_UNAVAILABLE', 'The manager address redirected; it was not followed.', { reason: 'REDIRECTED' });
        }
        const text = await readCapped(response);
        return { status: response.status, body: parseJson(text), ok: response.status >= 200 && response.status < 300 };
    }

    return {
        bridge,

        validateBaseUrl: () => validateBaseUrl(resolveBase()),

        /** GET /status: unauthenticated, answers in every manager state. */
        async status() {
            const result = await send({ method: 'GET', path: '/manager/api/status', timeoutMs: STATUS_TIMEOUT_MS });
            if (!result.ok || !result.body || typeof result.body !== 'object') {
                throw new HostManagerError(503, 'MANAGER_UNAVAILABLE', 'The manager answered, but not with a status the portal understands.', { reason: 'BAD_STATUS' });
            }
            return result.body;
        },

        /**
         * One authenticated manager call on behalf of the signed-in operator.
         * Resolves with `{ status, body, ok }` for any manager answer (so a 409
         * is data the route passes through); rejects only when no answer
         * exists (unreachable, key missing, URL refused).
         */
        async call({ actor, method, path, body, timeoutMs = CALL_TIMEOUT_MS }) {
            let headers;
            try {
                headers = bridge.headers({ actor, method, path });
            } catch (error) {
                if (error instanceof ManagerBridgeError) {
                    throw new HostManagerError(error.status === 403 ? 403 : 503,
                        error.status === 403 ? 'FORBIDDEN' : 'MANAGER_BRIDGE_UNAVAILABLE',
                        error.status === 403 ? 'Only the host can do that.' : 'The portal has no key for the manager yet.',
                        error.status === 403 ? null : { reason: 'NO_BRIDGE_KEY' });
                }
                throw error;
            }
            return send({ method, path, headers, body, timeoutMs });
        }
    };
}

module.exports = {
    HostManagerError,
    createHostManagerClient,
    validateBaseUrl,
    PROBE_TIMEOUT_MS
};
