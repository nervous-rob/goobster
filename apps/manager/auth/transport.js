/**
 * Transport checks applied before any route: the Host header must name
 * this manager (loopback, or the configured LAN host) on every request,
 * which also defeats DNS rebinding; a mutating request with an Origin (or a
 * browser's cross-site fetch metadata) must come from that same host.
 */

const { isLoopbackAddress } = require('../settings');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip'];

function splitHost(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return { name: '', port: null };
    if (text.startsWith('[')) {
        const end = text.indexOf(']');
        const port = text.slice(end + 1).replace(/^:/, '');
        return { name: text.slice(1, end), port: port || null };
    }
    const parts = text.split(':');
    if (parts.length > 2) return { name: text, port: null };
    return { name: parts[0], port: parts[1] || null };
}

function createTransportGuards(settings) {
    const lanHost = settings.lan && settings.lanHost ? splitHost(settings.lanHost) : null;

    /** @returns {'loopback'|'lan'|null} */
    function classifyHost(hostHeader, localPort) {
        const { name, port } = splitHost(hostHeader);
        if (!name) return null;
        const portMatches = port === null ? false : Number(port) === Number(localPort);
        if (isLoopbackAddress(name) && portMatches) return 'loopback';
        if (lanHost && name === lanHost.name && (lanHost.port === null ? (port === null || portMatches) : port === lanHost.port)) {
            return 'lan';
        }
        return null;
    }

    function hostGuard(req, res, next) {
        req.managerHostKind = classifyHost(req.headers.host, req.socket.localPort);
        if (!req.managerHostKind) {
            res.status(421).json({ error: { code: 'BAD_HOST', message: 'This request was not addressed to the manager.' } });
            return;
        }
        next();
    }

    function originGuard(req, res, next) {
        if (!MUTATING.has(req.method)) return next();
        if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            res.status(403).json({ error: { code: 'BAD_ORIGIN', message: 'Cross-origin requests are not allowed.' } });
            return;
        }
        const origin = req.headers.origin;
        if (origin === undefined) return next();
        let parsed = null;
        try {
            parsed = new URL(origin);
        } catch { }
        const expectedScheme = settings.lan ? 'https:' : 'http:';
        const kind = parsed && parsed.protocol === expectedScheme ? classifyHost(parsed.host, req.socket.localPort) : null;
        if (!kind || kind !== req.managerHostKind) {
            res.status(403).json({ error: { code: 'BAD_ORIGIN', message: 'Cross-origin requests are not allowed.' } });
            return;
        }
        next();
    }

    /** A request from this machine, addressed to a loopback name, not relayed by a proxy. */
    function isLocalRequest(req) {
        if (req.managerHostKind !== 'loopback') return false;
        if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
        return !FORWARDING_HEADERS.some(name => req.headers[name] !== undefined);
    }

    return { hostGuard, originGuard, isLocalRequest, classifyHost };
}

module.exports = { createTransportGuards, splitHost, MUTATING };
