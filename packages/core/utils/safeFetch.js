/**
 * SSRF-hardened outbound download helper.
 *
 * Built for the sandbox data-fetch flow (the model proposes a URL, this
 * module decides whether it is even askable, and then downloads it without
 * trusting anything about it), but deliberately generic so other
 * user/model-supplied URL paths can adopt it.
 *
 * The pipeline is three separated stages, each independently testable:
 *
 *   1. assessUrl(raw, allowedHosts)  - shape: https only, no credentials,
 *      no custom port, hostname syntax, allowlist membership.
 *   2. resolvePinned(host)           - DNS once, up front: EVERY address the
 *      name resolves to must be public, then ONE address is pinned. The
 *      later connection goes to that pinned address (the Host header and
 *      TLS SNI still carry the hostname), so a DNS rebind between check and
 *      connect has nothing to move.
 *   3. fetchToFile({...})            - the actual transfer: redirects are
 *      refused (a 302 into 169.254.169.254 is the classic allowlist
 *      bypass), the body is streamed to disk with a hard byte cap enforced
 *      on received bytes (never a trusted Content-Length), and the whole
 *      transfer sits under one wall-clock timeout.
 *
 * fetchToFile takes the pinned address as an argument instead of resolving
 * internally - the caller composes the stages - which is also what makes
 * the transfer logic testable against a loopback server without weakening
 * the address policy for production callers.
 */

const fs = require('node:fs');
const dns = require('node:dns');
const net = require('node:net');
const https = require('node:https');

/** Machine-readable failure (PanelError contract: status + code). */
class SafeFetchError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'SafeFetchError';
        this.status = status;
        this.code = code;
    }
}

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Is this IP address one we refuse to talk to? Everything that is not
 * unambiguously public unicast is refused: loopback, RFC1918, link-local
 * (cloud metadata lives there), CGNAT, benchmarking/documentation ranges,
 * multicast/reserved, unspecified, IPv6 unique-local, and IPv4-mapped or
 * NAT64 forms of any of those.
 * @param {string} address
 * @returns {boolean}
 */
function isForbiddenAddress(address) {
    const ip = String(address || '').trim().toLowerCase();
    const version = net.isIP(ip);
    if (version === 4) return isForbiddenV4(ip);
    if (version === 6) return isForbiddenV6(ip);
    return true; // not an IP at all - never connect
}

function isForbiddenV4(ip) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;              // this-net, RFC1918, loopback
    if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT 100.64/10
    if (a === 169 && b === 254) return true;                        // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;               // RFC1918
    if (a === 192 && b === 168) return true;                        // RFC1918
    if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true; // IETF, TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true;           // benchmarking
    if (a === 198 && b === 51 && octets[2] === 100) return true;    // TEST-NET-2
    if (a === 203 && b === 0 && octets[2] === 113) return true;     // TEST-NET-3
    if (a >= 224) return true;                                      // multicast + reserved + broadcast
    return false;
}

function isForbiddenV6(ip) {
    // Expand enough to classify: strip zone id, normalize the head group.
    const bare = ip.split('%')[0];
    if (bare === '::' || bare === '::1') return true;               // unspecified, loopback
    // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96): judge the
    // embedded IPv4 instead.
    const v4tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
    if (bare.startsWith('::ffff:') || bare.startsWith('64:ff9b:')) {
        return v4tail ? isForbiddenV4(v4tail[1]) : true;
    }
    const head = bare.split(':')[0] || '0';
    const headNum = parseInt(head.padStart(4, '0'), 16);
    if ((headNum & 0xfe00) === 0xfc00) return true;                 // fc00::/7 unique-local
    if ((headNum & 0xffc0) === 0xfe80) return true;                 // fe80::/10 link-local
    if ((headNum & 0xff00) === 0xff00) return true;                 // ff00::/8 multicast
    if (headNum === 0x2001 && bare.split(':')[1] === 'db8') return true; // documentation
    return false;
}

/**
 * Stage 1: is this URL even askable?
 * @param {string} rawUrl
 * @param {string[]} [allowedHosts] - lowercase hostnames with standing
 *   operator consent (exact match). Membership is REPORTED, not enforced -
 *   the caller decides whether off-list means "refuse" or "needs approval".
 * @returns {{ url: URL, host: string, allowlisted: boolean }}
 */
function assessUrl(rawUrl, allowedHosts = []) {
    let url;
    try {
        url = new URL(String(rawUrl ?? '').trim());
    } catch {
        throw new SafeFetchError(400, 'BAD_URL', 'That is not a valid URL.');
    }
    if (url.protocol !== 'https:') {
        throw new SafeFetchError(400, 'HTTPS_ONLY', 'Only https:// URLs can be fetched.');
    }
    if (url.username || url.password) {
        throw new SafeFetchError(400, 'NO_CREDENTIALS', 'URLs with embedded credentials are refused.');
    }
    if (url.port && url.port !== '443') {
        throw new SafeFetchError(400, 'PORT_REFUSED', 'Only the default https port (443) is allowed.');
    }
    const host = url.hostname.toLowerCase();
    // Literal-IP URLs skip DNS, so the address policy applies right here;
    // hostname syntax is checked so a weird name never reaches the resolver.
    const bracketless = host.replace(/^\[|\]$/g, '');
    if (net.isIP(bracketless)) {
        if (isForbiddenAddress(bracketless)) {
            throw new SafeFetchError(403, 'ADDRESS_FORBIDDEN', 'That address is not publicly routable.');
        }
    } else if (!HOSTNAME_PATTERN.test(host)) {
        throw new SafeFetchError(400, 'BAD_HOST', 'That hostname is not valid.');
    }
    const allowlisted = (allowedHosts || []).some(entry => String(entry).toLowerCase() === host);
    return { url, host, allowlisted };
}

/**
 * Stage 2: resolve the hostname once and pin one public address. If ANY
 * resolved address is forbidden the whole name is refused - a half-honest
 * DNS answer must not be routable by luck of ordering.
 * @param {string} host
 * @param {{ lookup?: Function }} [opts] - injectable resolver (tests)
 * @returns {Promise<{ address: string, family: number }>}
 */
async function resolvePinned(host, { lookup = dns.promises.lookup } = {}) {
    const bracketless = String(host).replace(/^\[|\]$/g, '');
    if (net.isIP(bracketless)) {
        if (isForbiddenAddress(bracketless)) {
            throw new SafeFetchError(403, 'ADDRESS_FORBIDDEN', 'That address is not publicly routable.');
        }
        return { address: bracketless, family: net.isIP(bracketless) };
    }
    let records;
    try {
        records = await lookup(host, { all: true, verbatim: true });
    } catch {
        throw new SafeFetchError(502, 'DNS_FAILED', `Could not resolve ${host}.`);
    }
    if (!Array.isArray(records) || records.length === 0) {
        throw new SafeFetchError(502, 'DNS_FAILED', `Could not resolve ${host}.`);
    }
    for (const record of records) {
        if (isForbiddenAddress(record.address)) {
            throw new SafeFetchError(403, 'ADDRESS_FORBIDDEN',
                `${host} resolves to a non-public address - refusing to fetch it.`);
        }
    }
    return { address: records[0].address, family: records[0].family };
}

/**
 * Stage 3: download to a file, trusting nothing.
 * @param {Object} params
 * @param {URL} params.url - from assessUrl
 * @param {string} params.address - the pinned address from resolvePinned
 * @param {string} params.destPath - where the body lands (parent must exist)
 * @param {number} params.maxBytes - hard cap on RECEIVED bytes
 * @param {number} [params.timeoutMs] - whole-transfer wall clock (default 60s)
 * @param {string[]} [params.allowedContentTypes] - prefix allowlist
 *   (e.g. ['text/', 'application/json']); empty = any type
 * @param {object} [params.transport] - injectable http(s) module (tests)
 * @returns {Promise<{ bytes: number, contentType: string|null }>}
 */
function fetchToFile({ url, address, destPath, maxBytes, timeoutMs = 60_000, allowedContentTypes = [], transport = https }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error, request, response) => {
            if (settled) return;
            settled = true;
            try { request?.destroy(); } catch { /* already gone */ }
            try { response?.destroy(); } catch { /* already gone */ }
            fs.rm(destPath, { force: true }, () => reject(error));
        };

        const request = transport.request({
            host: address,
            servername: url.hostname, // TLS SNI + cert validation on the NAME
            port: url.port || (transport === https ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            headers: { Host: url.hostname, 'User-Agent': 'Goobster-DataFetch/1.0', Accept: '*/*' },
            timeout: timeoutMs
        }, (response) => {
            const status = response.statusCode || 0;
            if (status >= 300 && status < 400) {
                return fail(new SafeFetchError(502, 'REDIRECT_REFUSED',
                    `The server answered with a redirect (${status}); redirects are refused - `
                    + 'propose the final URL directly.'), request, response);
            }
            if (status !== 200) {
                return fail(new SafeFetchError(502, 'HTTP_ERROR', `The server answered ${status}.`), request, response);
            }
            const contentType = (response.headers['content-type'] || '').split(';')[0].trim() || null;
            if (allowedContentTypes.length > 0
                && !allowedContentTypes.some(prefix => (contentType || '').startsWith(prefix))) {
                return fail(new SafeFetchError(415, 'TYPE_REFUSED',
                    `Content type ${contentType || '(none)'} is not allowed for this fetch.`), request, response);
            }

            let bytes = 0;
            const sink = fs.createWriteStream(destPath, { mode: 0o600 });
            response.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > maxBytes) {
                    sink.destroy();
                    fail(new SafeFetchError(413, 'TOO_LARGE',
                        `The download exceeded the ${(maxBytes / (1024 * 1024)).toFixed(1)} MB cap and was aborted.`),
                    request, response);
                }
            });
            sink.on('error', (error) => fail(new SafeFetchError(500, 'WRITE_FAILED', error.message), request, response));
            response.pipe(sink);
            sink.on('finish', () => {
                if (settled) return;
                settled = true;
                resolve({ bytes, contentType });
            });
        });

        request.on('timeout', () => fail(new SafeFetchError(504, 'TIMEOUT',
            'The download timed out and was aborted.'), request));
        request.on('error', (error) => fail(new SafeFetchError(502, 'FETCH_FAILED', error.message), request));
        request.end();
    });
}

module.exports = { SafeFetchError, assessUrl, resolvePinned, fetchToFile, isForbiddenAddress };
