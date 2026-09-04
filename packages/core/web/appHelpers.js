/**
 * Shared helpers for the portal router. Route modules receive the object
 * `createAppHelpers(ctx)` returns so auth, cookies, and JSON error
 * translation stay in one place.
 */

const DISCORD_API = 'https://discord.com/api';
const SESSION_COOKIE = 'goobster_web_session';
const STATE_COOKIE = 'goobster_oauth_state';
const SSE_HEARTBEAT_MS = 15000;
/** Custom Observatory commands are prompts, not pastes - keep them tight. */
const OBSERVATORY_COMMAND_MAX_LENGTH = 4000;

function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key) out[key] = decodeURIComponent(value);
    }
    return out;
}

function cookieAttributes(ctx, maxAgeSeconds) {
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${ctx.secureCookies ? '; Secure' : ''}`;
}

function sendError(res, status, code, message, details = null) {
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

function originGuard() {
    return (req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        const origin = req.headers.origin;
        if (!origin) return next();
        let originHost;
        try {
            originHost = new URL(origin).host;
        } catch {
            originHost = null;
        }
        if (!originHost || originHost !== req.headers.host) {
            sendError(res, 403, 'BAD_ORIGIN', 'Cross-origin requests are not allowed.');
            return;
        }
        next();
    };
}

function jsonRoute(ctx, logLabel) {
    return (handler) => async (req, res) => {
        try {
            res.json(await handler(req));
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message, error.details || null);
                return;
            }
            ctx.logger.error?.(`${logLabel}:`, error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    };
}

function projectOwner(req) {
    const raw = req.query?.owner ?? req.body?.owner;
    if (raw == null || String(raw).trim() === '') return undefined;
    return String(raw).trim();
}

function createAppHelpers(ctx) {
    async function requireAuth(req, res, next) {
        const token = parseCookies(req)[SESSION_COOKIE];
        const session = token ? await ctx.sessions.get(token) : null;
        if (!session) {
            sendError(res, 401, 'UNAUTHENTICATED', 'Sign in with Discord to use the web app.');
            return;
        }
        req.webUser = session;
        req.webSessionToken = token;
        next();
    }

    return {
        requireAuth,
        sendError,
        parseCookies,
        cookieAttributes,
        projectOwner,
        chatRoute: jsonRoute(ctx, 'Web chat route failed'),
        parlorRoute: jsonRoute(ctx, 'Parlor route failed'),
        dashboardRoute: jsonRoute(ctx, 'Web dashboard route failed'),
        exchangeRoute: jsonRoute(ctx, 'Web exchange route failed'),
        appletRoute: jsonRoute(ctx, 'Web applet route failed'),
        integrationRoute: jsonRoute(ctx, 'Integration route failed')
    };
}

module.exports = {
    DISCORD_API,
    SESSION_COOKIE,
    STATE_COOKIE,
    SSE_HEARTBEAT_MS,
    OBSERVATORY_COMMAND_MAX_LENGTH,
    parseCookies,
    cookieAttributes,
    sendError,
    originGuard,
    projectOwner,
    createAppHelpers
};
