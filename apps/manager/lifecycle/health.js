/**
 * Bounded health probes against a worker's `/health` route: a 2xx answer
 * within the timeout is healthy, anything else (refused, slow, 5xx) is not.
 * Probes only loopback-or-configured URLs the layout built; the body is
 * discarded.
 */

const http = require('node:http');
const https = require('node:https');

const DEFAULT_TIMEOUT_MS = 1500;

/** @returns {Promise<boolean>} never rejects */
function checkHealth(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        let target;
        try {
            target = new URL(url);
        } catch {
            resolve(false);
            return;
        }
        const transport = target.protocol === 'https:' ? https : http;
        let settled = false;
        const done = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const request = transport.get(target, { timeout: timeoutMs, agent: false }, (response) => {
            response.resume();
            done(response.statusCode >= 200 && response.statusCode < 300);
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', () => done(false));
    });
}

module.exports = { checkHealth, DEFAULT_TIMEOUT_MS };
