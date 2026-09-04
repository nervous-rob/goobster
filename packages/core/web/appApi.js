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
const { createAppHelpers, originGuard } = require('./appHelpers');
const { attachWebAppWebSocket } = require('./appWebsocket');
const { mountAuthChat } = require('./routes/authChat');
const { mountVoiceTasks } = require('./routes/voiceTasks');
const { mountProjects } = require('./routes/projects');
const { mountSpitball } = require('./routes/spitball');
const { mountWorkspace } = require('./routes/workspace');
const { mountParlor } = require('./routes/parlor');
const { mountEventsStatic } = require('./routes/eventsStatic');

/**
 * Express router serving the web app client + API. Mounted at the root of
 * the public server; routes are namespaced under /app and /api/app.
 */
function createWebAppApp(ctx) {
    const app = express.Router();
    const helpers = createAppHelpers(ctx);
    // Scoped parser (activityApi pattern): a router-wide parser would eat
    // request bodies destined for the raw-body webhook receivers. The limit
    // covers vision attachments (up to 4 base64 data URLs per message) and
    // a large Player.log deck-list excerpt (parser cap is 80MB).
    app.use('/api/app', express.json({ limit: '82mb' }));

    // CSRF guard for state-changing routes: cookies are SameSite=Lax, and
    // any Origin present on a non-GET request must match the request host.
    app.use('/api/app', originGuard(ctx));

    mountAuthChat(app, ctx, helpers);
    mountVoiceTasks(app, ctx, helpers);
    mountProjects(app, ctx, helpers);
    mountSpitball(app, ctx, helpers);
    mountWorkspace(app, ctx, helpers);
    mountParlor(app, ctx, helpers);
    mountEventsStatic(app, ctx, helpers);
    return app;
}

module.exports = { createWebAppContext, createWebAppApp, attachWebAppWebSocket };
