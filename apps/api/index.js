/**
 * Goobster api service entry point: the web backend.
 *
 * Two modes (shared-instance Increment C, spec §6), resolved by
 * `GOOBSTER_RUNTIME_MODE` or, when unset, by whether the installation has
 * a Discord adapter (`discord.enabled` / a bot token):
 *
 *  paired      The split deployment's web backend next to a running bot.
 *              Required environment:
 *                GOOBSTER_DB_URL         postgres://... (two processes, one
 *                                        database; SQLite is refused)
 *                GOOBSTER_INTERNAL_TOKEN the shared secret for the bot's
 *                                        internal gateway API
 *                GOOBSTER_GATEWAY_URL    the bot's internal address
 *                                        (default http://localhost:3000)
 *              The bot runs the schedulers; set GOOBSTER_RUNTIME_SCHEDULERS=1
 *              to run them here as well (singleton locks keep passes from
 *              doubling up).
 *
 *  standalone  The whole assistant with no Discord at all: portal, chat,
 *              tasks, inbox delivery, attention, projects. The only
 *              process, so SQLite is fine; the core runtime's schedulers
 *              run here. Set GOOBSTER_RUNTIME_SCHEDULERS=0 to disable them.
 *
 * In both modes:
 *   GOOBSTER_API_PORT       listen port (default 3100)
 *
 * config.json provides the webapp block (enabled/devMode/publicUrl), the
 * identity block, and (paired mode) clientId - the compose `full` profile
 * mounts the same file into both containers.
 */

const fs = require('node:fs');
const logger = require('@goobster/core/utils/logger');
const { getConnection, closeConnection } = require('@goobster/core/db');
const db = require('@goobster/core/db');
const discordConfig = require('@goobster/core/config/discordConfig');
const { createApiApp, attachApiWebSockets, resolveRuntimeMode, DEFAULT_API_PORT } = require('./server');

const configPath = require('@goobster/core/runtimePaths').configJsonPath;
if (!fs.existsSync(configPath)) {
    logger.error('config.json not found! The api service reads the webapp block from it.');
    process.exit(1);
}
const config = require(configPath);
require('@goobster/core/config/reportIntegrations').reportIntegrations({ logger });

if (config.webapp?.enabled !== true) {
    logger.error('config.webapp.enabled is not true - the api service has nothing to serve. '
        + 'Enable the web app in config.json (see documentation/webapp_setup.md).');
    process.exit(1);
}

const mode = resolveRuntimeMode();

if (mode === 'paired') {
    // Two processes, one database, requires a real database server. Sharing a
    // SQLite file between the bot and the api is deliberately unsupported
    // (reactive port spec §7.4): vec-index sync, column migrations, and the
    // backup story all get subtle, and Postgres is one compose profile away.
    if (db.engine !== 'postgres') {
        logger.error('Paired mode requires Postgres (set GOOBSTER_DB_URL). '
            + 'Two processes must not share one SQLite file - run the lite profile instead, '
            + 'bring up the compose `full` profile (see documentation/postgres_setup.md), '
            + 'or run without Discord (discord.enabled = false → standalone mode).');
        process.exit(1);
    }
    if (!process.env.GOOBSTER_INTERNAL_TOKEN) {
        logger.error('GOOBSTER_INTERNAL_TOKEN is required in paired mode (the shared secret for the bot\'s internal gateway API).');
        process.exit(1);
    }
} else {
    logger.info(`Standalone mode: ${discordConfig.disabledReason || 'Discord adapter off'} `
        + '- the portal, chat, tasks, and inbox delivery run without Discord.');
}

/** Schedulers: on in standalone, off in paired, env override either way. */
function schedulersEnabled() {
    const raw = process.env.GOOBSTER_RUNTIME_SCHEDULERS;
    if (raw !== undefined && raw !== '') {
        return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
    }
    return mode === 'standalone';
}

async function main() {
    logger.info(`Starting Goobster api service (${mode} mode)...`);
    await getConnection(); // applies schema + migrations before serving

    const { app, webAppContext } = createApiApp({ config, logger, mode });

    // The core runtime owns the event bus, startup reconciliation, and -
    // when this process is the one that runs them - the schedulers.
    const { startCoreRuntime } = require('@goobster/core/runtime/coreRuntime');
    const runtime = await startCoreRuntime({
        client: null,
        gateway: webAppContext.gateway,
        logger,
        schedulers: schedulersEnabled()
    });

    const port = Number(process.env.GOOBSTER_API_PORT) || DEFAULT_API_PORT;
    const server = app.listen(port, () => {
        logger.info(`Goobster api listening on port ${port} `
            + `(portal ${webAppContext.devMode ? 'DEV MODE - auth bypass on' : 'enabled'} at /app)`);
    });
    attachApiWebSockets(server, webAppContext);
    logger.info('Parlor Live enabled: WS /api/app/parlor/live');

    const shutdown = async () => {
        logger.info('api: shutting down...');
        try {
            await new Promise(resolve => server.close(resolve));
            await runtime.stop();
            await closeConnection();
        } catch (error) {
            logger.error('api: shutdown error:', error);
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(error => {
    logger.error('api: failed to start:', error);
    process.exit(1);
});
