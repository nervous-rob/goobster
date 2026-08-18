/**
 * HTTP layer for Goobster.
 *
 * Two listeners:
 *  - Health server (all interfaces, PORT/3000): only GET /health, unchanged
 *    behavior for Docker healthchecks and LAN uptime monitors.
 *  - Panel server (127.0.0.1 only): the touch-screen management console -
 *    static UI plus the /api control routes. Local-only by construction;
 *    a Host/Origin guard rejects DNS-rebinding style requests.
 */

const path = require('node:path');
const express = require('express');
const { createPanelService } = require('@goobster/core/services/panelService');
const { createPanelApi } = require('./panelApi');
const { createActivityContext, createActivityApp, attachActivityWebSocket } = require('./activityApi');
const { createWebAppContext, createWebAppApp, attachWebAppWebSocket } = require('./appApi');
const { createScreenVisionApp, attachScreenVisionWebSocket } = require('./screenVisionApi');
const { createGbaRunApp, attachGbaRunWebSocket } = require('./gbaRunApi');
const { createIntegrationsApp, integrationsWebhooksEnabled } = require('./integrationsApi');
const screenVisionService = require('@goobster/core/services/screenVisionService');
const gbaRunService = require('@goobster/core/services/gbaRunService');
const { TableManager } = require('@goobster/core/services/tableGames/tableManager');
const { BotPlayer } = require('@goobster/core/services/tableGames/botPlayer');

const DEFAULT_PANEL_PORT = 3400;

/**
 * Local-only guard: the Host header must be a loopback name, and any Origin
 * on state-changing requests must also be loopback (blocks cross-site
 * requests from pages loaded off other hosts in a LAN browser).
 */
function localOnlyGuard(req, res, next) {
    const hostname = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (!localHosts.has(hostname)) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'The panel is only available on this device.' } });
        return;
    }
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
        let originHost;
        try {
            originHost = new URL(origin).hostname;
        } catch {
            originHost = null;
        }
        if (!originHost || !localHosts.has(originHost)) {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cross-origin panel requests are not allowed.' } });
            return;
        }
    }
    next();
}

/** Build the health app (extracted from index.js, behavior unchanged). */
function createHealthApp({ logger = console } = {}) {
    const app = express();
    app.get('/health', (req, res) => {
        logger.debug?.('Health check requested');
        res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
    });
    return app;
}

/**
 * Build the panel app (static UI + /api). Exported separately so tests can
 * exercise it without binding real ports for the health server.
 */
function createPanelApp({ client, voiceService, logger = console, deps = {} }) {
    const panelService = deps.panelService
        || createPanelService({ client, voiceService, logger, deps });

    const app = express();
    app.disable('x-powered-by');
    app.use(localOnlyGuard);
    app.use(express.json({ limit: '64kb' }));
    app.use('/api', createPanelApi({ panelService, logger }));
    app.use(express.static(path.join(__dirname, 'public')));
    return app;
}

/**
 * Start both HTTP servers. Returns handles with a close() for shutdown.
 *
 * @param {Object} params
 * @param {import('discord.js').Client} params.client
 * @param {Object} params.voiceService
 * @param {Object} params.config - parsed config.json
 * @param {Object} [params.logger]
 */
async function startWebServers({ client, voiceService, config = {}, logger = console }) {
    const healthPort = Number(process.env.PORT) || 3000;
    const healthApp = createHealthApp({ logger });

    // Webhook receivers (GitHub + Cursor agent status): enabled per-receiver
    // by configuring its shared secret. Like the Activity API, these must be
    // publicly reachable (e.g. via a cloudflared tunnel). Mounted before the
    // Activity app so its body parsers can never touch the raw webhook
    // bodies needed for HMAC signature verification.
    if (integrationsWebhooksEnabled()) {
        healthApp.use(createIntegrationsApp({ client, logger }));
        logger.info?.('Integration webhook receivers enabled at /api/webhooks/*');
    }

    // Discord Activity (table games): opt-in because it makes the public
    // server serve more than /health - it must be reachable by Discord's
    // proxy (e.g. via a cloudflared tunnel). See documentation/activity_setup.md.
    let tableManager = null;
    let botPlayer = null;
    if (config.activity?.enabled === true) {
        tableManager = new TableManager();
        await tableManager.recoverFromJournal();
        botPlayer = new BotPlayer({ tableManager, client, config, logger });
        const activityContext = createActivityContext({ client, config, tableManager, botPlayer, logger });
        healthApp.use(createActivityApp(activityContext));
        healthApp.locals.activityContext = activityContext;
        logger.info?.(`Activity server enabled at /activity${activityContext.devMode ? ' (DEV MODE - auth bypass on)' : ''}`);
    }

    // Web app (browser chat + memory dashboard): opt-in for the same reason
    // as the Activity - it must be reachable through the public tunnel.
    // See documentation/webapp_setup.md.
    if (config.webapp?.enabled === true) {
        const webAppContext = createWebAppContext({ client, config, logger });
        healthApp.use(createWebAppApp(webAppContext));
        healthApp.locals.webAppContext = webAppContext;
        logger.info?.(`Web app enabled at /app${webAppContext.devMode ? ' (DEV MODE - auth bypass on)' : ''}`);
    }

    // Screen vision (companion-app screenshots for AI context): opt-in for
    // the same reason as the Activity - the public server gains a pairing
    // endpoint and a WebSocket that must be reachable from players' PCs.
    // See documentation/screen_vision_setup.md.
    const screenVisionEnabled = config.screenVision?.enabled === true;
    screenVisionService.configure({
        enabled: screenVisionEnabled,
        publicUrl: config.screenVision?.publicUrl,
        releasesUrl: config.screenVision?.releasesUrl,
        logger
    });
    if (screenVisionEnabled) {
        healthApp.use(createScreenVisionApp({ logger }));
    }

    // GBA run harness (Goobster Plays Pokémon): opt-in for the same reason
    // as screen vision - the public server gains a pairing endpoint and a
    // WebSocket that must be reachable from the machine running mGBA.
    const gbaRunEnabled = config.gbaRun?.enabled === true;
    gbaRunService.configure({ enabled: gbaRunEnabled, client, logger });
    if (gbaRunEnabled) {
        healthApp.use(createGbaRunApp({ logger }));
    }

    const healthServer = healthApp.listen(healthPort, () => {
        logger.info?.(`Express server is running on port ${healthPort}`);
    });

    if (tableManager) {
        attachActivityWebSocket(healthServer, healthApp.locals.activityContext);
    }

    // Parlor Live voice sessions share the web app's opt-in (same cookie
    // auth, same tunnel).
    if (healthApp.locals.webAppContext) {
        attachWebAppWebSocket(healthServer, healthApp.locals.webAppContext);
        logger.info?.('Parlor Live enabled: WS /api/app/parlor/live');
    }

    if (screenVisionEnabled) {
        attachScreenVisionWebSocket(healthServer, { logger });
        logger.info?.('Screen vision enabled: /api/screen/pair + /api/screen/ws');
    }

    if (gbaRunEnabled) {
        attachGbaRunWebSocket(healthServer, { logger });
        logger.info?.('GBA run harness enabled: /api/gba-run/pair + /api/gba-run/ws');
    }

    let panelServer = null;
    const panelConfig = config.panel || {};
    const panelEnabled = panelConfig.enabled !== false;
    if (panelEnabled) {
        const panelPort = Number(process.env.GOOBSTER_PANEL_PORT) || Number(panelConfig.port) || DEFAULT_PANEL_PORT;
        const panelApp = createPanelApp({ client, voiceService, logger });
        panelServer = panelApp.listen(panelPort, '127.0.0.1', () => {
            logger.info?.(`Management panel available at http://127.0.0.1:${panelPort}`);
        });
        panelServer.on('error', (error) => {
            logger.error?.(`Management panel server error: ${error.message}`);
        });
    } else {
        logger.info?.('Management panel disabled via config (panel.enabled = false).');
    }

    return {
        healthServer,
        panelServer,
        tableManager,
        botPlayer,
        close() {
            botPlayer?.stop();
            tableManager?.stop();
            return Promise.all([
                new Promise(resolve => healthServer.close(resolve)),
                panelServer ? new Promise(resolve => panelServer.close(resolve)) : Promise.resolve()
            ]);
        }
    };
}

module.exports = { startWebServers, createPanelApp, createHealthApp, localOnlyGuard, DEFAULT_PANEL_PORT };
