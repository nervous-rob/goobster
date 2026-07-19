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
const { createPanelService } = require('../services/panelService');
const { createPanelApi } = require('./panelApi');
const { createActivityContext, createActivityApp, attachActivityWebSocket } = require('./activityApi');
const { TableManager } = require('../services/tableGames/tableManager');
const { BotPlayer } = require('../services/tableGames/botPlayer');

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
function startWebServers({ client, voiceService, config = {}, logger = console }) {
    const healthPort = Number(process.env.PORT) || 3000;
    const healthApp = createHealthApp({ logger });

    // Discord Activity (table games): opt-in because it makes the public
    // server serve more than /health - it must be reachable by Discord's
    // proxy (e.g. via a cloudflared tunnel). See documentation/activity_setup.md.
    let tableManager = null;
    let botPlayer = null;
    if (config.activity?.enabled === true) {
        tableManager = new TableManager();
        tableManager.recoverFromJournal();
        botPlayer = new BotPlayer({ tableManager, client, config, logger });
        const activityContext = createActivityContext({ client, config, tableManager, botPlayer, logger });
        healthApp.use(createActivityApp(activityContext));
        healthApp.locals.activityContext = activityContext;
        logger.info?.(`Activity server enabled at /activity${activityContext.devMode ? ' (DEV MODE - auth bypass on)' : ''}`);
    }

    const healthServer = healthApp.listen(healthPort, () => {
        logger.info?.(`Express server is running on port ${healthPort}`);
    });

    if (tableManager) {
        attachActivityWebSocket(healthServer, healthApp.locals.activityContext);
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
