/**
 * The api app's HTTP layer (reactive port spec §4, §6, §13 Phase 3): the
 * whole web portal - OAuth login, cookie sessions, every /api/app/* route,
 * SSE chat turns, the portal event stream, and the Parlor Live WebSocket -
 * mounted in a process with NO Discord gateway connection. Everything
 * (chat pipeline, services, database) is the same @goobster/core code the
 * bot runs.
 *
 * Two runtime modes (shared-instance Increment C, spec §6):
 *  - paired: the installation has a Discord adapter running in the bot
 *    process; Discord access goes through a RemoteGateway to the bot's
 *    internal API, and the two processes share a Postgres database.
 *  - standalone: the installation has no Discord adapter at all
 *    (discord.enabled = false, or no bot token). The gateway is the
 *    DisabledGateway, the api process runs the core runtime's schedulers
 *    itself, and SQLite is fine because it is the only process.
 *
 * Exported as a builder so tests can construct the app with an injected
 * gateway and no listening socket (the createWebAppApp pattern).
 */

const express = require('express');
const { createWebAppContext, createWebAppApp, attachWebAppWebSocket } = require('@goobster/core/web/appApi');
const { RemoteGateway, DisabledGateway } = require('@goobster/core/gateway');
const discordConfig = require('@goobster/core/config/discordConfig');

const DEFAULT_API_PORT = 3100;

/**
 * Which mode this process runs in. `GOOBSTER_RUNTIME_MODE` (paired |
 * standalone) wins; otherwise standalone when the Discord adapter is off.
 * @returns {'paired'|'standalone'}
 */
function resolveRuntimeMode(env = process.env) {
    const raw = String(env.GOOBSTER_RUNTIME_MODE || '').trim().toLowerCase();
    if (raw === 'paired' || raw === 'standalone') return raw;
    return discordConfig.enabled ? 'paired' : 'standalone';
}

/** The gateway for the resolved mode (compose injects the paired-mode env). */
function createGatewayFromEnv({ config = {}, logger = console, mode = resolveRuntimeMode() } = {}) {
    if (mode === 'standalone') return new DisabledGateway();
    return new RemoteGateway({
        baseUrl: process.env.GOOBSTER_GATEWAY_URL || 'http://localhost:3000',
        token: process.env.GOOBSTER_INTERNAL_TOKEN,
        // The Discord application client id IS the bot's user id: with the
        // bot down, DM-scoped surfaces (chat, tasks CRUD, library, decks)
        // keep working against this fallback identity (spec §6).
        fallbackBotUserId: config.clientId || null,
        logger
    });
}

/**
 * Build the api Express app.
 * @param {Object} params
 * @param {Object} params.config - parsed config.json (webapp block, clientId)
 * @param {Object} [params.gateway] - a DiscordGateway (tests inject fakes;
 *   the boot path builds one from the environment)
 * @param {'paired'|'standalone'} [params.mode]
 * @param {Object} [params.logger]
 * @param {Object} [params.deps] - service overrides for tests
 * @returns {{ app: import('express').Express, webAppContext: Object, mode: string }}
 */
function createApiApp({ config = {}, gateway = null, mode = undefined, logger = console, deps = {} } = {}) {
    // An injected gateway decides the mode (a DisabledGateway IS standalone);
    // the boot path resolves it from the environment.
    if (!mode) mode = gateway ? (gateway.kind === 'disabled' ? 'standalone' : 'paired') : resolveRuntimeMode();
    const resolvedGateway = gateway || createGatewayFromEnv({ config, logger, mode });

    const app = express();
    app.disable('x-powered-by');

    app.get('/health', async (req, res) => {
        let gatewayAvailable = false;
        try {
            gatewayAvailable = await resolvedGateway.available();
        } catch { /* down */ }
        res.status(200).json({
            status: 'healthy',
            service: 'api',
            mode,
            discord: mode === 'standalone' ? 'disabled' : (gatewayAvailable ? 'connected' : 'unreachable'),
            // Kept for existing probes: 'connected' | 'unreachable' | 'disabled'
            gateway: mode === 'standalone' ? 'disabled' : (gatewayAvailable ? 'connected' : 'unreachable'),
            timestamp: new Date().toISOString()
        });
    });

    const webAppContext = createWebAppContext({
        client: null,
        gateway: resolvedGateway,
        config,
        logger,
        deps
    });
    app.use(createWebAppApp(webAppContext));

    return { app, webAppContext, mode };
}

/**
 * Attach the api app's WebSocket surfaces (Parlor Live) to a listening
 * HTTP server.
 */
function attachApiWebSockets(server, webAppContext) {
    return attachWebAppWebSocket(server, webAppContext);
}

module.exports = { createApiApp, attachApiWebSockets, createGatewayFromEnv, resolveRuntimeMode, DEFAULT_API_PORT };
