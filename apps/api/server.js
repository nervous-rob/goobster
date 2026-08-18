/**
 * The api app's HTTP layer (reactive port spec §4, §6, §13 Phase 3): the
 * whole web portal - OAuth login, cookie sessions, every /api/app/* route,
 * SSE chat turns, the portal event stream, and the Parlor Live WebSocket -
 * mounted in a process with NO Discord gateway connection. Discord access
 * goes through a RemoteGateway to the bot's internal API; everything else
 * (chat pipeline, services, database) is the same @goobster/core code the
 * bot runs, against the same Postgres.
 *
 * Exported as a builder so tests can construct the app with an injected
 * gateway and no listening socket (the createWebAppApp pattern).
 */

const express = require('express');
const { createWebAppContext, createWebAppApp, attachWebAppWebSocket } = require('@goobster/core/web/appApi');
const { RemoteGateway } = require('@goobster/core/gateway');

const DEFAULT_API_PORT = 3100;

/** RemoteGateway wired from the environment (compose injects these). */
function createGatewayFromEnv({ config = {}, logger = console } = {}) {
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
 *   the boot path builds a RemoteGateway from the environment)
 * @param {Object} [params.logger]
 * @param {Object} [params.deps] - service overrides for tests
 * @returns {{ app: import('express').Express, webAppContext: Object }}
 */
function createApiApp({ config = {}, gateway = null, logger = console, deps = {} } = {}) {
    const resolvedGateway = gateway || createGatewayFromEnv({ config, logger });

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
            gateway: gatewayAvailable ? 'connected' : 'unreachable',
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

    return { app, webAppContext };
}

/**
 * Attach the api app's WebSocket surfaces (Parlor Live) to a listening
 * HTTP server.
 */
function attachApiWebSockets(server, webAppContext) {
    return attachWebAppWebSocket(server, webAppContext);
}

module.exports = { createApiApp, attachApiWebSockets, createGatewayFromEnv, DEFAULT_API_PORT };
