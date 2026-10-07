/**
 * Goobster manager entry point: the durable control process that can set
 * up and repair an installation when the application database, Discord,
 * provider keys or optional features cannot start. Spec:
 * documentation/manager.md.
 *
 *   node apps/manager/index.js                  serve (127.0.0.1:3400 by default)
 *   node apps/manager/index.js --mint-bootstrap mint a new first-time setup credential (unclaimed only)
 *   node apps/manager/index.js --mint-recovery  mint a recovery credential (existing installations)
 *   node apps/manager/index.js --status         print the status document and exit
 *   node apps/manager/index.js --supervise      serve, and run the workers of the layout
 *                                               (documentation/manager_lifecycle.md)
 *
 * Loading this module starts nothing; `main()` runs only when it is the
 * entry script. Nothing here requires the application database, the web
 * app, Discord or a provider at load time.
 */

const https = require('node:https');
const http = require('node:http');
const { resolveSettings, validateTransport, StartupError } = require('./settings');
const { createManager } = require('./manager');
const { createManagerApp } = require('./server');
const extensions = require('./extensions');

const RECONCILE_INTERVAL_MS = 60_000;
const CLAIM_POLL_MS = 1000;

const HELP = `Goobster manager

Usage: node apps/manager/index.js [--supervise | --mint-bootstrap | --mint-recovery | --status | --help]

  (no flag)         serve the manager API on GOOBSTER_MANAGER_HOST:GOOBSTER_MANAGER_PORT (127.0.0.1:3400)
  --supervise       serve, then start and supervise the workers of the layout (lite: bot, standalone: api,
                    paired: bot + api); same as GOOBSTER_MANAGER_SUPERVISE=1
  --mint-bootstrap  replace the first-time setup credential (only while the installation is unclaimed)
  --mint-recovery   mint a one-time recovery credential for POST /manager/api/recovery/unlock
  --status          print the status document as JSON and exit

Headless hosts: keep the loopback bind and tunnel, e.g. ssh -L 3400:127.0.0.1:3400 <host>.
See documentation/manager.md and documentation/manager_lifecycle.md.`;

function printCredential(out, label, minted, { reveal }) {
    if (reveal) {
        out.write(`${label}: ${minted.credential}\n`);
    } else {
        out.write(`${label} written to ${minted.file} (owner-only); read it on this machine.\n`);
    }
    out.write(`It is valid until ${minted.expiresAt} and works once.\n`);
}

/**
 * @param {string[]} [argv]
 * @param {Object} [options]
 * @param {Object} [options.env]
 * @param {NodeJS.WriteStream} [options.stdout]
 * @param {Object} [options.logger]
 * @param {Object} [options.supervisorOptions] adapter/policy overrides for --supervise (tests)
 * @returns {Promise<{ code: number, server?: import('node:http').Server, manager?: Object, stop?: () => Promise<void> }>}
 */
async function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, logger = console, supervisorOptions = {} } = {}) {
    const flags = new Set(argv);
    if (flags.has('--help') || flags.has('-h')) {
        stdout.write(`${HELP}\n`);
        return { code: 0 };
    }
    const settings = resolveSettings(env);
    if (settings.dbUrl && !env.GOOBSTER_DB_URL) {
        // The overlay's connection must also select the facade the manager's own audit reconciliation opens.
        env.GOOBSTER_DB_URL = settings.dbUrl;
    }

    if (flags.has('--mint-bootstrap') || flags.has('--mint-recovery') || flags.has('--status')) {
        const manager = createManager({ settings, logger, extraKinds: extensions.kinds });
        const state = manager.currentState();
        if (flags.has('--status')) {
            stdout.write(`${JSON.stringify(await manager.status(), null, 2)}\n`);
            return { code: 0 };
        }
        if (!manager.storeReady) {
            logger.error('[manager] the manager store cannot be written; check the permissions of GOOBSTER_MANAGER_STATE_DIR.');
            return { code: 1 };
        }
        if (flags.has('--mint-bootstrap')) {
            if (state.state !== 'unclaimed') {
                logger.error(`[manager] refusing: the installation is ${state.state}, not unclaimed. Use --mint-recovery.`);
                return { code: 1 };
            }
            printCredential(stdout, 'Setup credential', manager.credentials.bootstrap.mint(), { reveal: true });
            return { code: 0 };
        }
        if (state.state === 'unclaimed') {
            logger.error('[manager] refusing: the installation is unclaimed; use first-time setup (--mint-bootstrap).');
            return { code: 1 };
        }
        printCredential(stdout, 'Recovery credential', manager.credentials.recovery.mint(), { reveal: true });
        return { code: 0 };
    }

    let transport;
    try {
        transport = validateTransport(settings);
    } catch (error) {
        if (error instanceof StartupError) {
            logger.error(`[manager] ${error.message}`);
            return { code: 1 };
        }
        throw error;
    }

    const manager = createManager({ settings, logger, extraKinds: extensions.kinds });
    const booted = await manager.init();
    if (!manager.storeReady) {
        logger.error('[manager] the manager store cannot be written; serving status in recovery.');
    }
    if (booted.recovered.length > 0) {
        logger.warn(`[manager] ${booted.recovered.length} interrupted operation(s) marked failed.`);
    }
    if (booted.maintenance && booted.maintenance.active) {
        logger.warn(`[manager] a maintenance barrier is up (fence ${booted.maintenance.fence ?? 'unknown'}${booted.maintenance.stale ? ', left by an earlier manager' : ''}${booted.maintenance.problem ? `, state ${booted.maintenance.problem}` : ''}); it is kept as it is until an operator releases it.`);
    }
    logger.info(`[manager] state: ${booted.state.state}${booted.state.reason ? ` (${booted.state.reason})` : ''}`);
    if (booted.bootstrap) {
        printCredential(stdout, 'First-time setup credential', booted.bootstrap, { reveal: Boolean(stdout.isTTY) });
    }

    const app = createManagerApp(manager, { logger, mounts: extensions.routes });
    const server = transport.tls
        ? https.createServer({ cert: transport.tls.cert, key: transport.tls.key }, app)
        : http.createServer(app);
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(settings.port, settings.host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address();
    logger.info(`[manager] listening on ${transport.tls ? 'https' : 'http'}://${settings.host}:${address.port}/manager/api/status`);

    let timer = null;
    if (settings.reconcile) {
        manager.reconcile();
        timer = setInterval(() => manager.reconcile(), RECONCILE_INTERVAL_MS);
        timer.unref();
    }

    let supervision = null;
    let supervisionStarting = null;
    let claimWatch = null;
    let stopping = null;
    const baseStatus = manager.status;
    manager.status = async () => ({
        ...(await baseStatus()),
        lifecycle: supervision ? supervision.supervisor.summary() : { supervising: false, layout: null, workers: [] }
    });
    const beginSupervision = async () => {
        const { startSupervision } = require('./lifecycle');
        supervision = await startSupervision({ manager, logger, ...supervisorOptions });
        const view = supervision.supervisor.summary();
        logger.info(`[manager] supervising the ${view.layout || 'unknown'} layout: ${view.workers.map(w => w.name).join(', ') || 'no workers'}`);
    };
    if ((flags.has('--supervise') || settings.supervise) && manager.storeReady) {
        if (manager.currentState().state === 'unclaimed') {
            // A worker would create the application database, and an
            // unclaimed manager that sees one is no longer claimable.
            logger.info('[manager] the installation is unclaimed: the workers start once first-time setup claimed it.');
            claimWatch = setInterval(() => {
                if (stopping || manager.currentState().state === 'unclaimed') return;
                clearInterval(claimWatch);
                claimWatch = null;
                supervisionStarting = beginSupervision().catch((error) => {
                    logger.error(`[manager] supervision could not start: ${error && (error.code || error.name)}`);
                });
            }, CLAIM_POLL_MS);
            claimWatch.unref();
        } else {
            await beginSupervision();
        }
    } else if (flags.has('--supervise') || settings.supervise) {
        logger.error('[manager] not supervising: the manager store cannot be written.');
    }

    const stop = () => {
        if (stopping) return stopping;
        stopping = (async () => {
            if (timer) clearInterval(timer);
            if (claimWatch) clearInterval(claimWatch);
            if (supervisionStarting) await supervisionStarting;
            if (supervision) {
                const result = await supervision.stop();
                const forced = result.workers.filter(w => w.forced).map(w => w.name);
                if (forced.length) logger.warn(`[manager] killed after the stop bound: ${forced.join(', ')}`);
            }
            await new Promise(resolve => server.close(() => resolve()));
        })();
        return stopping;
    };
    return {
        code: 0,
        server,
        manager,
        get supervisor() { return supervision ? supervision.supervisor : null; },
        stop
    };
}

if (require.main === module) {
    main().then((outcome) => {
        if (!outcome.server) {
            process.exitCode = outcome.code;
            return;
        }
        const shutdown = () => {
            outcome.stop().finally(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    }).catch((error) => {
        console.error(`[manager] failed to start: ${error && (error.code || error.message)}`);
        process.exit(1);
    });
}

module.exports = { main, createManager, createManagerApp, resolveSettings, validateTransport };
