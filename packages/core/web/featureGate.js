/**
 * Network-edge feature gating (installer P1.5, #320).
 *
 * One place answers "may this request, upgrade or open socket reach the
 * feature that owns it?" for the portal router, the bot's public server and
 * the api app. Ownership comes only from `features/inventory.js` (ordered
 * `routeRules`, `wsPaths`) and the answer from the one `features` predicate.
 *
 * Enforcement follows the state file, not the legacy defaults. With no usable
 * `data/features.json` the installation behaves exactly as it did before the
 * catalog existed: a feature whose legacy switch is off is "inactive" in the
 * resolver, but the existing code (an unmounted router, a service-level
 * refusal, a token route that stays open on purpose) already decides what its
 * routes do, and this module must not change that. A refusal is therefore
 * enforced when the state file is in force, or when the operator forced the
 * feature off with `GOOBSTER_FEATURE_<ID>`, or when a dependency is enforced
 * off. `enforced()` is the single seam for that rule.
 *
 * Refusals never carry `reasons` (they are for the signed-in portal's
 * `/api/app/features`, not for the network edge) and never echo request data.
 */

const inventory = require('../features/inventory');
const { features: defaultFeatures } = require('../features/featureState');

const FEATURE_UNAVAILABLE = 'FEATURE_UNAVAILABLE';
const UNAVAILABLE_MESSAGE = 'That feature is not available on this installation.';
const CLOSE_POLICY = 1008;

/** True when a request for a surface owned by `id` must be refused. */
function enforced(id, state = defaultFeatures, seen = new Set()) {
    if (state.isActive(id)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    const { source } = state.status();
    if (source === 'file') return true;
    return state.availability(id).reasons.some(reason =>
        reason.code === 'ENV_OFF'
        || (reason.code === 'DEPENDENCY_INACTIVE' && reason.dependency && enforced(reason.dependency, state, seen)));
}

/** The first of owner, then alsoRequires, that is enforced off; null when the claim is available. */
function blockingFeature(claim, state = defaultFeatures) {
    if (!claim) return null;
    for (const id of [claim.owner, ...claim.alsoRequires]) {
        if (enforced(id, state)) return id;
    }
    return null;
}

/** Mirror Express routing: HEAD answers as GET, matching is case-insensitive, a trailing slash is ignored. */
function normalizeRoute(pathname, method) {
    let path = String(pathname || '/').toLowerCase();
    if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
    const verb = String(method || 'GET').toUpperCase();
    return { path, method: verb === 'HEAD' ? 'GET' : verb };
}

/** The feature blocking `METHOD path`, or null (unclaimed paths are never gated; the routers answer them). */
function routeBlock(pathname, method, state = defaultFeatures) {
    const route = normalizeRoute(pathname, method);
    return blockingFeature(inventory.ownerOf('route', route.path, route.method), state);
}

function wsBlock(pathname, state = defaultFeatures) {
    return blockingFeature(inventory.ownerOf('wsPath', String(pathname || '').toLowerCase()), state);
}

function unavailableBody(featureId) {
    return { error: FEATURE_UNAVAILABLE, feature: featureId };
}

function unavailableFrame(featureId) {
    return { type: 'error', code: FEATURE_UNAVAILABLE, feature: featureId, message: UNAVAILABLE_MESSAGE };
}

function sendUnavailable(res, featureId) {
    res.status(404).json(unavailableBody(featureId));
}

/**
 * Express middleware that refuses every request whose route owner is
 * enforced off. `only` limits it to the paths a given server really serves
 * (so an unrelated 404 stays the server's own), `exclude` hands paths to a
 * narrower gate, and `respond` replaces the default 404 body.
 */
function routeGate({ state = defaultFeatures, only = null, exclude = null, respond = null } = {}) {
    return async (req, res, next) => {
        const pathname = (req.baseUrl || '') + req.path;
        if (only && !only.test(pathname)) return next();
        if (exclude && exclude.test(pathname)) return next();
        let blocking;
        try {
            blocking = routeBlock(pathname, req.method, state);
        } catch {
            return next();
        }
        if (!blocking) return next();
        if (respond) return respond(req, res, blocking, next);
        return sendUnavailable(res, blocking);
    };
}

/** Middleware for one mount point owned by a single feature (the MCP endpoint at its configured path). */
function ownerGate(featureId, { state = defaultFeatures } = {}) {
    return (req, res, next) => {
        if (enforced(featureId, state)) return sendUnavailable(res, featureId);
        return next();
    };
}

/** Whether a worker or listener owned by `featureId` may be constructed at startup. */
function mountable(featureId, state = defaultFeatures) {
    return !enforced(featureId, state);
}

/**
 * Keep an upgraded socket honest after the feature went away (a deliberate
 * `refresh()` made the owner inactive while the connection was open). The
 * first message after that is answered with one stable error frame and the
 * socket is closed with 1008; the message never reaches the feature.
 */
function guardOpenSocket(socket, pathname, { state = defaultFeatures } = {}) {
    const emit = socket.emit.bind(socket);
    let refused = false;
    socket.emit = (event, ...args) => {
        if (event !== 'message') return emit(event, ...args);
        let blocking = null;
        try { blocking = wsBlock(pathname, state); } catch { /* never block on a lookup failure */ }
        if (!blocking) return emit(event, ...args);
        if (!refused) {
            refused = true;
            try {
                if (socket.readyState === 1) socket.send(JSON.stringify(unavailableFrame(blocking)));
                socket.close(CLOSE_POLICY, FEATURE_UNAVAILABLE);
            } catch { /* already closing */ }
        }
        return true;
    };
}

/** Refuse a WebSocket upgrade with a plain 404 before it completes. */
function rejectUpgrade(socket) {
    try {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    } catch { /* already gone */ }
    socket.destroy();
}

/**
 * The portal's view of `features.status()`: reason and warning codes only.
 * Detail values (key names, config paths, derivations) and error messages
 * stay server-side.
 */
function sanitizeStatus(status) {
    const features = {};
    for (const [id, entry] of Object.entries(status.features || {})) {
        features[id] = {
            installed: entry.installed,
            configured: entry.configured,
            active: entry.active,
            pending: entry.pending,
            requested: entry.requested,
            pendingActive: entry.pendingActive,
            reasons: entry.reasons.map(reason => ({
                code: reason.code,
                ...(reason.dependency ? { dependency: reason.dependency } : {})
            })),
            warnings: entry.warnings.map(warning => ({ code: warning.code }))
        };
    }
    return {
        source: status.source,
        revision: status.revision,
        origin: status.origin,
        error: status.error ? { code: status.error.code } : null,
        features
    };
}

module.exports = {
    FEATURE_UNAVAILABLE,
    UNAVAILABLE_MESSAGE,
    CLOSE_POLICY,
    enforced,
    blockingFeature,
    normalizeRoute,
    routeBlock,
    wsBlock,
    unavailableBody,
    unavailableFrame,
    sendUnavailable,
    routeGate,
    ownerGate,
    mountable,
    guardOpenSocket,
    rejectUpgrade,
    sanitizeStatus
};
