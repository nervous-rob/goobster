/**
 * Goobster web app backend: Discord OAuth login, cookie sessions, the SSE
 * chat API, and the memory dashboard API. Mounted on the public health
 * server ONLY when config.webapp.enabled is true (same opt-in rule as the
 * Activity - it must be reachable through the public tunnel).
 *
 * Auth model:
 *  - Real flow: the standard OAuth2 authorization-code redirect
 *    (GET /api/app/auth/login -> discord.com -> GET /api/app/auth/callback).
 *    Scope is `identify` only; the access token is used once to resolve the
 *    user and is never stored. Sessions are SQLite-backed hashed tokens
 *    (services/webSessionService.js) delivered as an httpOnly cookie.
 *  - Dev flow (config.webapp.devMode): POST /api/app/auth/dev-session mints
 *    a session for an arbitrary identity so the app can be developed in a
 *    plain browser without Discord. Never enable on an exposed server.
 *
 * Route implementations live under web/routes/ by product domain. This
 * file is the facade: context, helpers, mount order, and the public
 * exports callers already require.
 */

const express = require('express');
const { createWebAppContext } = require('./appContext');
const { createAppHelpers, originGuard, parseCookies, sendError, SESSION_COOKIE } = require('./appHelpers');
const featureGate = require('./featureGate');
const { maintenanceGate } = require('./maintenanceGate');
const { attachWebAppWebSocket } = require('./appWebsocket');
const { mountAuth } = require('./routes/auth');
const { mountAccount } = require('./routes/account');
const { mountAdmin } = require('./routes/admin');
const { mountChat } = require('./routes/chat');
const { mountVoiceTasks } = require('./routes/voiceTasks');
const { mountWorkspace } = require('./routes/workspace');
const { mountParlor } = require('./routes/parlor');
const { mountEventsStatic } = require('./routes/eventsStatic');
const { mountSettings } = require('./routes/settings');
const { mountInbox } = require('./routes/inbox');
const { mountPeople } = require('./routes/people');
const { mountFollowedSources } = require('./routes/followedSources');
const { mountTutorials } = require('./routes/tutorials');
const { mountMcp } = require('./routes/mcp');
const { mountFeatures } = require('./routes/features');
const requireOptional = require('../utils/optionalModule').forModule(module);

const PORTAL_PATH = /^\/(?:api\/app|app)(?:\/|$)/i;

/**
 * Route modules that belong to an optional feature. A payload without the
 * feature does not carry the file; its URLs then fall through to the 404
 * the feature gate gives a disabled feature.
 */
const OPTIONAL_ROUTES = {
    projects: () => requireOptional('./routes/projects', { feature: 'projects' })?.mountProjects,
    spitball: () => requireOptional('./routes/spitball', { feature: 'knowledge' })?.mountSpitball,
    noteAttachments: () => requireOptional('./routes/noteAttachments', { feature: 'knowledge' })?.mountNoteAttachments,
    studio: () => requireOptional('./routes/studio', { feature: 'music' })?.mountStudio,
    push: () => requireOptional('./routes/push', { feature: 'push' })?.mountPush
};

function mountOptional(name, app, ctx, helpers) {
    const mount = OPTIONAL_ROUTES[name]();
    if (mount) mount(app, ctx, helpers);
}

/**
 * The portal's one feature gate, driven by the inventory's ordered
 * `routeRules` and installed before every router (and before the body
 * parser, so a refused request is never read). A signed-in caller is told
 * which feature is unavailable; everyone else gets exactly the answer a
 * missing route gives, so availability is not observable without a session.
 * Core routes (operator, privacy, Inbox, export, settings) have core owners
 * and never reach the refusal.
 */
function featureGateMiddleware(ctx) {
    return featureGate.routeGate({
        state: ctx.features,
        only: PORTAL_PATH,
        respond: async (req, res, blocking) => {
            let session = null;
            const token = parseCookies(req)[SESSION_COOKIE];
            if (token) {
                try { session = await ctx.sessions.get(token, { touch: false }); } catch { session = null; }
            }
            res.set('Cache-Control', 'no-store');
            if (session) {
                res.status(404).json({
                    error: { code: featureGate.FEATURE_UNAVAILABLE, message: featureGate.UNAVAILABLE_MESSAGE },
                    feature: blocking
                });
                return;
            }
            sendError(res, 404, 'NOT_FOUND', 'No such API route.');
        }
    });
}

/**
 * Express router serving the web app client + API. Mounted at the root of
 * the public server; routes are namespaced under /app and /api/app.
 */
function createWebAppApp(ctx) {
    const app = express.Router();
    const helpers = createAppHelpers(ctx);
    app.use(featureGateMiddleware(ctx));
    // Maintenance barrier (documentation/maintenance_barrier.md): every
    // mutating portal request is a 503 while the process is fenced.
    app.use(maintenanceGate({ only: PORTAL_PATH }));
    // Scoped parser (activityApi pattern): a router-wide parser would eat
    // request bodies destined for the raw-body webhook receivers. The limit
    // covers vision attachments (up to 4 base64 data URLs per message) and
    // a large Player.log deck-list excerpt (parser cap is 80MB).
    app.use('/api/app', express.json({ limit: '82mb' }));

    // CSRF guard for state-changing routes: cookies are SameSite=Lax, and
    // any Origin present on a non-GET request must match the request host.
    app.use('/api/app', originGuard(ctx));

    mountFeatures(app, ctx, helpers);
    mountAuth(app, ctx, helpers);
    mountAccount(app, ctx, helpers);
    mountAdmin(app, ctx, helpers);
    mountChat(app, ctx, helpers);
    mountVoiceTasks(app, ctx, helpers);
    mountOptional('projects', app, ctx, helpers);
    mountOptional('spitball', app, ctx, helpers);
    mountOptional('noteAttachments', app, ctx, helpers);
    mountWorkspace(app, ctx, helpers);
    mountParlor(app, ctx, helpers);
    mountSettings(app, ctx, helpers);
    mountInbox(app, ctx, helpers);
    mountPeople(app, ctx, helpers);
    mountFollowedSources(app, ctx, helpers);
    mountTutorials(app, ctx, helpers);
    mountOptional('studio', app, ctx, helpers);
    mountOptional('push', app, ctx, helpers);
    mountMcp(app, ctx, helpers);
    // Last: the static client + API 404 fallback
    mountEventsStatic(app, ctx, helpers);
    return app;
}

module.exports = { createWebAppContext, createWebAppApp, attachWebAppWebSocket };
