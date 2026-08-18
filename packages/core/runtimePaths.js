/**
 * Runtime filesystem roots for the monorepo.
 *
 * Core code must never derive repo-root paths from its own __dirname (the
 * package moved in the monorepo split, and apps may run from anywhere).
 * Everything durable lives under the workspace root by default - data/,
 * cache/, logs/, campaigns/, config.json - overridable per path via env for
 * tests and containers.
 */

const path = require('node:path');

const WORKSPACE_ROOT = process.env.GOOBSTER_WORKSPACE_ROOT
    || path.join(__dirname, '..', '..');

module.exports = {
    workspaceRoot: WORKSPACE_ROOT,
    dataDir: process.env.GOOBSTER_DATA_DIR || path.join(WORKSPACE_ROOT, 'data'),
    cacheDir: process.env.GOOBSTER_CACHE_DIR || path.join(WORKSPACE_ROOT, 'cache'),
    logsDir: process.env.GOOBSTER_LOG_DIR || path.join(WORKSPACE_ROOT, 'logs'),
    campaignsDir: path.join(WORKSPACE_ROOT, 'campaigns'),
    clientsDir: path.join(WORKSPACE_ROOT, 'clients'),
    changelogPath: path.join(WORKSPACE_ROOT, 'changelog.md'),
    configJsonPath: process.env.GOOBSTER_CONFIG_PATH || path.join(WORKSPACE_ROOT, 'config.json')
};
