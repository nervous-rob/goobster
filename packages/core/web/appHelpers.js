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
            sendError(res, 401, 'UNAUTHENTICATED', 'Sign in to use the web app.');
            return;
        }
        // The session names the principal; the actor context adds the
        // installation, the entitlement (when the release gate is on), and
        // the Discord subject to use for guild checks. A disabled account
        // is refused here even while the gate is off.
        let actor;
        try {
            actor = await ctx.identity.resolveActor({
                principalId: session.userId,
                surface: 'web',
                sessionId: session.id != null ? String(session.id) : null
            });
        } catch (error) {
            if (error?.status && error?.code) {
                res.set('X-Goobster-Session-Invalid', '1');
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Web app actor resolution failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
            return;
        }
        // Revocation: a password reset or disable bumps the account's
        // sessionVersion; sessions minted before that are dead on arrival.
        if (session.sessionVersion != null && actor.account
            && Number(actor.account.sessionVersion) !== Number(session.sessionVersion)) {
            await ctx.sessions.destroy(token);
            res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttributes(ctx, 0)}`);
            sendError(res, 401, 'SESSION_REVOKED', 'Your session was signed out because the account was reset. Sign in again.');
            return;
        }
        req.webUser = session;
        req.webSessionToken = token;
        req.actor = actor;
        // A stale tab must not make a write using a different account's cookie.
        if ((req.headers['x-goobster-account'] && req.headers['x-goobster-account'] !== session.userId)
            || (req.headers['x-goobster-session'] && req.headers['x-goobster-session'] !== String(session.id))) {
            res.set('X-Goobster-Session-Invalid', '1');
            sendError(res, 409, 'SESSION_CHANGED', 'The signed-in account changed. Reload before continuing.');
            return;
        }
        res.set('Cache-Control', 'no-store');
        res.locals.webUser = session;
        let connectionLease;
        res.locals.authorizeStream = async () => {
            const auth = require('./liveAuthorization');
            const alive = () => !res.destroyed && !res.writableEnded;
            if (!(await auth.authorizeSession(ctx, token, session, alive))) return false;
            connectionLease ||= auth.reserveConnection(session);
            const lease = await connectionLease;
            if (res.destroyed || res.writableEnded) { await lease.release(); return false; }
            await lease.renew();
            return true;
        };
        res.once('close', () => { connectionLease?.then(lease => lease.release()).catch(() => {}); });
        next();
    }

    /**
     * Sensitive account changes (credentials, connecting or disconnecting
     * Discord) need a recent proof of identity on *this* session.
     * Runs after requireAuth.
     */
    function requireRecentAuth(req, res, next) {
        if (!ctx.sessions.isRecentlyAuthenticated(req.webUser, ctx.identityConfig.recentAuthMinutes)) {
            sendError(res, 403, 'REAUTH_REQUIRED',
                'Confirm your password (or sign in again) before changing how you sign in.');
            return;
        }
        next();
    }

    /** Operator-only routes. Runs after requireAuth; the role comes from the actor, never the client. */
    function requireOperator(req, res, next) {
        if (req.actor?.account?.role !== 'operator' || req.actor.account.status !== 'active') {
            sendError(res, 403, 'FORBIDDEN', 'Only the host can do that.');
            return;
        }
        next();
    }

    return {
        requireAuth,
        requireRecentAuth,
        requireOperator,
        sendError,
        parseCookies,
        cookieAttributes,
        projectOwner,
        authRoute: jsonRoute(ctx, 'Web auth route failed'),
        chatRoute: jsonRoute(ctx, 'Web chat route failed'),
        parlorRoute: jsonRoute(ctx, 'Parlor route failed'),
        inboxRoute: jsonRoute(ctx, 'Inbox route failed'),
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
