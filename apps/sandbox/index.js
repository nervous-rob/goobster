/**
 * Sandbox-runner entry point. Listens on GOOBSTER_SANDBOX_PORT (3200).
 * Requires GOOBSTER_INTERNAL_TOKEN. Do not set GOOBSTER_SANDBOX_URL here
 * or the runner would try to proxy to itself.
 */

const logger = require('@goobster/core/utils/logger');
const { startSandboxRunner } = require('./server');

if (process.env.GOOBSTER_SANDBOX_URL) {
    logger.error('GOOBSTER_SANDBOX_URL must not be set on the sandbox-runner (it would proxy to itself).');
    process.exit(1);
}

if (!process.env.GOOBSTER_INTERNAL_TOKEN) {
    logger.error('GOOBSTER_INTERNAL_TOKEN is required (shared secret with bot/api).');
    process.exit(1);
}

startSandboxRunner({ logger });
