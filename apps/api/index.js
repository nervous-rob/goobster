/**
 * Goobster api service entry point (the split deployment's web backend).
 *
 * Boots the web portal against Postgres and a RemoteGateway to the bot.
 * Required environment:
 *   GOOBSTER_DB_URL         postgres://... (two processes, one database -
 *                           the reason Phase 2 exists; SQLite is refused)
 *   GOOBSTER_INTERNAL_TOKEN the shared secret for the bot's internal API
 *   GOOBSTER_GATEWAY_URL    the bot's internal address (default http://localhost:3000)
 *   GOOBSTER_API_PORT       listen port (default 3100)
 *
 * config.json provides the webapp block (enabled/devMode/publicUrl) and
 * clientId, exactly as it does for the bot - the compose `full` profile
 * mounts the same file into both containers.
 */

const fs = require('node:fs');
const logger = require('@goobster/core/utils/logger');
const { getConnection, closeConnection } = require('@goobster/core/db');
const db = require('@goobster/core/db');
const eventBusService = require('@goobster/core/services/eventBusService');
const { createApiApp, attachApiWebSockets, DEFAULT_API_PORT } = require('./server');

const configPath = require('@goobster/core/runtimePaths').configJsonPath;
if (!fs.existsSync(configPath)) {
    logger.error('config.json not found! The api service reads the webapp block and clientId from it.');
    process.exit(1);
}
const config = require(configPath);
require('@goobster/core/config/reportIntegrations').reportIntegrations({ logger });

if (config.webapp?.enabled !== true) {
    logger.error('config.webapp.enabled is not true - the api service has nothing to serve. '
        + 'Enable the web app in config.json (see documentation/webapp_setup.md).');
    process.exit(1);
}

// Two processes, one database, requires a real database server. Sharing a
// SQLite file between the bot and the api is deliberately unsupported
// (reactive port spec §7.4): vec-index sync, column migrations, and the
// backup story all get subtle, and Postgres is one compose profile away.
if (db.engine !== 'postgres') {
    logger.error('The api service requires Postgres (set GOOBSTER_DB_URL). '
        + 'Two processes must not share one SQLite file - run the lite profile instead, '
        + 'or bring up the compose `full` profile (see documentation/postgres_setup.md).');
    process.exit(1);
}

if (!process.env.GOOBSTER_INTERNAL_TOKEN) {
    logger.error('GOOBSTER_INTERNAL_TOKEN is required (the shared secret for the bot\'s internal gateway API).');
    process.exit(1);
}

async function main() {
    logger.info('Starting Goobster api service...');
    await getConnection(); // applies schema + migrations before serving

    try {
        const projectMissionService = require('@goobster/core/services/projectMissionService');
        const starting = await projectMissionService.reconcileStartingSteps({ olderThanMs: 0 });
        const running = await projectMissionService.reconcileRunningSteps();
        if (starting > 0 || running > 0) {
            logger.info(`Missions: reconciled ${starting} STARTING and ${running} RUNNING step(s) left by a previous process`);
        }
    } catch (error) {
        logger.error('Failed to reconcile Mission STARTING steps:', error);
    }

    try {
        const workshopPinMigration = require('@goobster/core/services/workshopPinMigration');
        const migrated = await workshopPinMigration.runOnStartup();
        if (migrated.acquired && (migrated.migrated > 0 || migrated.linked > 0)) {
            logger.info(`Workshop: migrated ${migrated.migrated} pin(s) `
                + `(${migrated.linked} already-linked) across ${migrated.users} user(s)`);
        }
    } catch (error) {
        logger.error('Failed to migrate Workshop pins:', error);
        logger.info('Pins stay in the Workshop; migration retries on the next start');
    }

    const { app, webAppContext } = createApiApp({ config, logger });
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
            await eventBusService.close();
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
