/**
 * Network-edge admission for the maintenance barrier
 * (documentation/maintenance_barrier.md).
 *
 * While the process is fenced (runtime/maintenance.js) every mutating
 * request is answered `503 { error: 'MAINTENANCE', retryAfter }` with a
 * `Retry-After` header, and every WebSocket upgrade is refused with the same
 * status. Reads keep working, so the portal's sign-in state and the status
 * pages stay visible. The 503 is the barrier; a banner is only a symptom.
 *
 * Installed the way the feature gate is: before every router and before the
 * body parser, so a refused request is never read.
 */

const maintenance = require('../runtime/maintenance');

const MAINTENANCE = 'MAINTENANCE';
const MESSAGE = 'Goobster is in maintenance. Try again in a few minutes.';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CLOSE_TRY_AGAIN_LATER = 1013;

/** Mutating requests admitted before the fence closed and not finished yet. */
const inFlight = new Set();
const DRAIN_POLL_MS = 25;

/** Resolves once every request admitted before the fence closed has finished or been dropped. */
function drainRequests() {
    return new Promise((resolve) => {
        const check = () => {
            if (inFlight.size === 0) return resolve();
            setTimeout(check, DRAIN_POLL_MS).unref?.();
            return undefined;
        };
        check();
    });
}

function body() {
    return { error: MAINTENANCE, message: MESSAGE, retryAfter: maintenance.RETRY_AFTER_SECONDS };
}

/**
 * @param {Object} [options]
 * @param {RegExp|null} [options.only]    limit the gate to the paths this server serves
 * @param {RegExp|null} [options.exempt]  mutating paths that stay open (none by default)
 */
function maintenanceGate({ only = null, exempt = null } = {}) {
    return (req, res, next) => {
        if (SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) return next();
        const pathname = (req.baseUrl || '') + req.path;
        if (only && !only.test(pathname)) return next();
        if (exempt && exempt.test(pathname)) return next();
        if (!maintenance.isActive()) {
            if (!inFlight.has(res)) {
                inFlight.add(res);
                const done = () => inFlight.delete(res);
                res.once('close', done);
                res.once('finish', done);
            }
            return next();
        }
        res.set('Retry-After', String(maintenance.RETRY_AFTER_SECONDS));
        res.set('Cache-Control', 'no-store');
        return res.status(503).json(body());
    };
}

/** A plain 503 for an upgrade that must not complete. Safe to call twice for one socket. */
function rejectUpgrade(socket) {
    if (socket.destroyed) return;
    try {
        socket.write(`HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${maintenance.RETRY_AFTER_SECONDS}\r\nConnection: close\r\n\r\n`);
    } catch { /* already gone */ }
    socket.destroy();
}

/**
 * Refuse every WebSocket upgrade on `server` while fenced, whichever handler
 * would have served it (portal, Activity, screen vision, GBA). Installed once
 * per server; the handlers never see the upgrade.
 */
function guardUpgrades(server) {
    if (server.__goobsterMaintenanceGuard) return server;
    server.__goobsterMaintenanceGuard = true;
    const emit = server.emit.bind(server);
    server.emit = (event, request, socket, ...rest) => {
        if (event === 'upgrade' && maintenance.isActive()) {
            rejectUpgrade(socket);
            return true;
        }
        return emit(event, request, socket, ...rest);
    };
    return server;
}

/** Close the sockets of a `ws` server when the process starts draining for maintenance. */
function closeSocketsOnMaintenance(wss) {
    const stop = maintenance.onChange((view) => {
        if (!view.active) return;
        for (const socket of wss.clients) {
            try { socket.close(CLOSE_TRY_AGAIN_LATER, MAINTENANCE); } catch { /* closing */ }
        }
    });
    wss.on('close', stop);
    return stop;
}

module.exports = {
    MAINTENANCE,
    MESSAGE,
    CLOSE_TRY_AGAIN_LATER,
    maintenanceGate,
    rejectUpgrade,
    guardUpgrades,
    drainRequests,
    closeSocketsOnMaintenance,
    body
};
