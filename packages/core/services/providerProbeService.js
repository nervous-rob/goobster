/**
 * Provider connection probes: one bounded, explicit authentication check per
 * target, never a generation.
 *
 *   probe(target, { credentials, timeoutMs, fetch }) ->
 *     { target, ok, code, latencyMs, detail, whatItDoes }
 *
 * `code` is one of OK, AUTH_FAILED, UNREACHABLE, TIMEOUT, RATE_LIMITED,
 * UNKNOWN. `detail` is a fixed sentence per outcome: it never echoes a key,
 * a URL, a path or anything the provider said, and `whatItDoes` is the one
 * sentence the operator reads before choosing to run it.
 *
 * Where a credential goes: only to the provider's canonical base URL listed
 * in TARGETS below. The two operator-selected destinations - the Ollama host
 * and the SMTP host - receive no credential at all (Ollama has none; the SMTP
 * probe stops after EHLO). Requests use `redirect: 'manual'`, so a 3xx is
 * reported as UNREACHABLE ("redirected") and is never followed with the key.
 * The three cloud chat providers share one request shape and one outcome
 * table (cloud-provider parity): a capability added to one is added to all.
 *
 * Nothing here runs on its own. The manager exposes a probe only as an
 * explicit operator request (POST /manager/api/config/probe); status and page
 * loads never call it. The default `fetch` is the platform's; tests inject a
 * fake and no spec reaches the network.
 */

const nodeNet = require('node:net');
const nodeTls = require('node:tls');

const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;
const CREDENTIAL_SHAPE = /^[\x21-\x7e]{8,4096}$/;
const ANTHROPIC_VERSION = '2023-06-01';

class ProbeInputError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ProbeInputError';
        this.code = code;
    }
}

const bearer = (credential) => ({ Authorization: `Bearer ${credential}` });

/**
 * Per-target request. `host` is the label shown to the operator ("sends the
 * credential to ...") and always equals the host of `url`.
 */
const TARGETS = {
    openai: {
        needsCredential: true,
        host: 'api.openai.com',
        whatItDoes: 'Lists the models your OpenAI key can see (GET /v1/models). Nothing is generated and nothing is billed.',
        request: (credential) => ({ url: 'https://api.openai.com/v1/models', headers: bearer(credential) })
    },
    anthropic: {
        needsCredential: true,
        host: 'api.anthropic.com',
        whatItDoes: 'Lists the models your Anthropic key can see (GET /v1/models). Nothing is generated and nothing is billed.',
        request: (credential) => ({
            url: 'https://api.anthropic.com/v1/models?limit=1',
            headers: { 'x-api-key': credential, 'anthropic-version': ANTHROPIC_VERSION }
        })
    },
    gemini: {
        needsCredential: true,
        host: 'generativelanguage.googleapis.com',
        whatItDoes: 'Lists the models your Gemini key can see (GET /v1beta/models). Nothing is generated and nothing is billed.',
        request: (credential) => ({
            url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
            headers: { 'x-goog-api-key': credential }
        })
    },
    perplexity: {
        needsCredential: true,
        host: 'api.perplexity.ai',
        whatItDoes: 'Lists your own queued asynchronous requests (GET /async/chat/completions): Perplexity has no model-list endpoint, and this authenticated read starts no search and is not billed.',
        request: (credential) => ({ url: 'https://api.perplexity.ai/async/chat/completions', headers: bearer(credential) })
    },
    elevenlabs: {
        needsCredential: true,
        host: 'api.elevenlabs.io',
        whatItDoes: 'Reads your ElevenLabs account (GET /v1/user). No audio is generated and no characters are used.',
        request: (credential) => ({ url: 'https://api.elevenlabs.io/v1/user', headers: { 'xi-api-key': credential } })
    },
    github: {
        needsCredential: true,
        host: 'api.github.com',
        whatItDoes: 'Reads the account the GitHub token belongs to (GET /user). Nothing is created or changed.',
        request: (credential) => ({
            url: 'https://api.github.com/user',
            headers: { ...bearer(credential), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'GoobsterBot/1.0' }
        })
    },
    cursor: {
        needsCredential: true,
        host: 'api.cursor.com',
        whatItDoes: 'Lists the models your Cursor key can launch agents with (GET /v1/models), the same call the launcher makes. No agent is started.',
        request: (credential) => ({ url: 'https://api.cursor.com/v1/models', headers: bearer(credential) })
    },
    ollama: {
        needsCredential: false,
        host: 'the configured Ollama host',
        whatItDoes: 'Asks your Ollama server which models it has installed (GET /api/tags). No credential is sent and nothing is generated.',
        request: (_credential, { host }) => ({ url: `${host.replace(/\/+$/, '')}/api/tags`, headers: {} })
    },
    mail: {
        needsCredential: false,
        host: 'the configured SMTP host, or api.resend.com',
        whatItDoes: 'SMTP: opens a connection to your mail server and sends EHLO, then quits; no login, no message. Resend: lists your sending domains (GET /domains) with the key; no message is sent.'
    }
};

const TARGET_IDS = Object.freeze(Object.keys(TARGETS));

function describeTargets() {
    return TARGET_IDS.map(target => ({
        target,
        whatItDoes: TARGETS[target].whatItDoes,
        sendsCredentialTo: TARGETS[target].needsCredential ? TARGETS[target].host : null,
        needsCredential: TARGETS[target].needsCredential
    }));
}

function result(target, ok, code, detail, startedAt, clock) {
    return { target, ok, code, latencyMs: Math.max(0, clock() - startedAt), detail, whatItDoes: TARGETS[target].whatItDoes };
}

function statusCode(target, response) {
    const status = Number(response.status);
    const header = (name) => {
        try {
            return response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null;
        } catch {
            return null;
        }
    };
    if (status >= 200 && status < 300) return { ok: true, code: 'OK', detail: target === 'ollama' ? 'The server answered.' : 'The provider accepted the credential.' };
    if (status >= 300 && status < 400) return { ok: false, code: 'UNREACHABLE', detail: 'The provider answered with a redirect; it was not followed.' };
    if (status === 429 || (target === 'github' && status === 403 && header('x-ratelimit-remaining') === '0')) {
        return { ok: false, code: 'RATE_LIMITED', detail: `The provider is rate limiting this credential (HTTP ${status}); the credential was not rejected.` };
    }
    if (status === 401 || status === 403) {
        return { ok: false, code: 'AUTH_FAILED', detail: `The provider rejected the credential (HTTP ${status}).` };
    }
    if (status === 502 || status === 503 || status === 504) {
        return { ok: false, code: 'UNREACHABLE', detail: `The provider is unavailable (HTTP ${status}).` };
    }
    return { ok: false, code: 'UNKNOWN', detail: `The provider answered with HTTP ${Number.isFinite(status) ? status : 'an unexpected status'}.` };
}

function checkCredential(target, credentials) {
    const credential = credentials && typeof credentials.apiKey === 'string' ? credentials.apiKey : null;
    if (!credential) throw new ProbeInputError('NO_CREDENTIAL', 'No credential was supplied; nothing was sent.');
    if (!CREDENTIAL_SHAPE.test(credential)) throw new ProbeInputError('BAD_CREDENTIAL', 'The credential has an unusable shape; nothing was sent.');
    return credential;
}

function checkHost(raw) {
    let url;
    try {
        url = new URL(String(raw));
    } catch {
        throw new ProbeInputError('BAD_HOST', 'The configured host is not a usable address; nothing was sent.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new ProbeInputError('BAD_HOST', 'The configured host is not a usable address; nothing was sent.');
    }
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

async function httpProbe(target, request, { timeoutMs, fetch, clock }) {
    const started = clock();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        const response = await fetch(request.url, {
            method: 'GET',
            headers: request.headers,
            redirect: 'manual',
            signal: controller.signal
        });
        try {
            if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel();
        } catch { }
        const outcome = statusCode(target, response || {});
        return result(target, outcome.ok, outcome.code, outcome.detail, started, clock);
    } catch {
        if (timedOut) {
            return result(target, false, 'TIMEOUT', `No answer within ${Math.round(timeoutMs / 1000 * 10) / 10} seconds.`, started, clock);
        }
        return result(target, false, 'UNREACHABLE', 'Could not reach the provider.', started, clock);
    } finally {
        clearTimeout(timer);
    }
}

/** Host, port and TLS mode from an smtp(s):// URL without returning the user or password. */
function smtpTargetFromUrl(raw) {
    try {
        const url = new URL(String(raw));
        if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname) return null;
        const secure = url.protocol === 'smtps:';
        return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : (secure ? 465 : 587), secure };
    } catch {
        return null;
    }
}

function smtpProbe({ host, port, secure }, { timeoutMs, clock, net = nodeNet, tls = nodeTls }) {
    const started = clock();
    return new Promise((resolve) => {
        let settled = false;
        let buffer = '';
        let stage = 'greeting';
        const socket = secure
            ? tls.connect({ host, port, servername: host })
            : net.connect({ host, port });
        const finish = (ok, code, detail) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                if (ok) socket.write('QUIT\r\n');
                socket.destroy();
            } catch { }
            resolve(result('mail', ok, code, detail, started, clock));
        };
        const timer = setTimeout(() => finish(false, 'TIMEOUT', `No answer within ${Math.round(timeoutMs / 1000 * 10) / 10} seconds.`), timeoutMs);
        socket.setEncoding('utf8');
        socket.on('error', () => finish(false, 'UNREACHABLE', 'Could not reach the mail server.'));
        socket.on('close', () => finish(false, 'UNREACHABLE', 'The mail server closed the connection.'));
        socket.on('data', (chunk) => {
            buffer += chunk;
            if (buffer.length > 16_384) {
                finish(false, 'UNKNOWN', 'The mail server sent an unexpected reply.');
                return;
            }
            const lines = buffer.split('\r\n');
            const last = lines[lines.length - 2];
            if (!buffer.endsWith('\r\n') || !last || !/^\d{3} /.test(last)) return;
            const code = Number(last.slice(0, 3));
            buffer = '';
            if (stage === 'greeting') {
                if (code !== 220) {
                    finish(false, 'UNKNOWN', `The mail server greeted with ${code}.`);
                    return;
                }
                stage = 'ehlo';
                socket.write('EHLO goobster.invalid\r\n');
                return;
            }
            if (code === 250) finish(true, 'OK', 'The mail server answered EHLO. No login was attempted, so the credentials are not tested.');
            else finish(false, 'UNKNOWN', `The mail server answered EHLO with ${code}.`);
        });
    });
}

/**
 * @param {string} target one of TARGET_IDS
 * @param {Object} [options]
 * @param {{ apiKey?: string }} [options.credentials] the secret the probe authenticates with (cloud targets, Resend)
 * @param {{ host?: string }} [options.endpoint] Ollama host
 * @param {{ provider?: 'smtp'|'resend', host?: string, port?: number, secure?: boolean }} [options.mail]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.clock]
 * @param {{ net?: Object, tls?: Object }} [options.sockets] test seam for the SMTP probe
 * @throws {ProbeInputError} UNKNOWN_TARGET, NO_CREDENTIAL, BAD_CREDENTIAL, BAD_HOST - raised before anything is sent
 */
async function probe(target, options = {}) {
    if (typeof target !== 'string' || !Object.prototype.hasOwnProperty.call(TARGETS, target)) {
        throw new ProbeInputError('UNKNOWN_TARGET', 'There is no such probe target.');
    }
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const fetchImpl = options.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    const clock = options.clock || Date.now;
    const spec = TARGETS[target];

    if (target === 'mail') {
        const mail = options.mail || {};
        if (mail.provider === 'resend') {
            const credential = checkCredential(target, options.credentials);
            if (!fetchImpl) throw new ProbeInputError('UNKNOWN_TARGET', 'No fetch implementation is available.');
            return httpProbe('mail', { url: 'https://api.resend.com/domains', headers: bearer(credential) }, { timeoutMs, fetch: fetchImpl, clock });
        }
        const host = typeof mail.host === 'string' ? mail.host.trim() : '';
        const port = Number(mail.port);
        if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new ProbeInputError('BAD_HOST', 'The configured mail host is not usable; nothing was sent.');
        }
        return smtpProbe({ host, port, secure: Boolean(mail.secure) }, { timeoutMs, clock, ...(options.sockets || {}) });
    }

    if (!fetchImpl) throw new ProbeInputError('UNKNOWN_TARGET', 'No fetch implementation is available.');
    const credential = spec.needsCredential ? checkCredential(target, options.credentials) : null;
    const host = target === 'ollama' ? checkHost(options.endpoint && options.endpoint.host) : null;
    return httpProbe(target, spec.request(credential, { host }), { timeoutMs, fetch: fetchImpl, clock });
}

module.exports = { probe, describeTargets, smtpTargetFromUrl, ProbeInputError, TARGET_IDS, DEFAULT_TIMEOUT_MS };
