/**
 * Child-process probe for the "loaded but not executed when off" table (#322).
 *
 * Jest hides its module registry, so the spec spawns this script in a plain
 * Node process (throwaway database, no network) and reads the JSON it prints.
 * With `--off` every manageable feature is forced off through its
 * GOOBSTER_FEATURE_<ID>=0 override; without it the installation is the
 * legacy no-file one.
 *
 * It exercises the entry points a feature's modules could be pulled in by,
 * one after another, and records which feature-owned module files are in
 * `require.cache` after each:
 *   toolsRegistry   require + getDefinitions + a refused execute
 *   commands        collectCommandPayloads with the feature filter (requires only active files)
 *   portal          createWebAppContext + createWebAppApp
 *   runtime         startCoreRuntime in the paired shape (no client, no schedulers), then stop
 *
 * Usage: node tests/helpers/loadProbe.js <data-dir> [--off]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const dataDir = process.argv[2];
const off = process.argv.includes('--off');

process.env.GOOBSTER_DATA_DIR = dataDir;
process.env.GOOBSTER_UPLOADS_DIR = path.join(dataDir, 'uploads');
process.env.GOOBSTER_DB_PATH = path.join(dataDir, 'probe.sqlite');

const inventory = require('@goobster/core/features/inventory');
const manageable = inventory.FEATURE_IDS.filter(id => id !== 'core');
if (off) {
    for (const id of manageable) {
        process.env[`GOOBSTER_FEATURE_${id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`] = '0';
    }
}

const FEATURE_MODULES = JSON.parse(fs.readFileSync(path.join(__dirname, 'loadProbeModules.json'), 'utf8'));
const watched = Object.entries(FEATURE_MODULES).flatMap(([feature, modules]) => modules.map(module => ({
    feature,
    module,
    file: fs.realpathSync(path.join(root, module))
})));

const loaded = new Set();
function snapshot(label) {
    const present = new Set(Object.keys(require.cache));
    const hits = watched.filter(entry => present.has(entry.file)).map(entry => entry.module);
    const fresh = hits.filter(module => !loaded.has(module));
    for (const module of hits) loaded.add(module);
    return { label, newlyLoaded: fresh };
}

async function main() {
    const steps = [];
    const quiet = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
    const logger = require('@goobster/core/utils/logger');
    for (const key of ['info', 'warn', 'error', 'debug', 'log']) logger[key] = quiet[key];
    console.log = () => {};

    steps.push(snapshot('baseline'));

    const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
    await toolsRegistry.getDefinitions(undefined, { isWeb: true });
    await toolsRegistry.execute('checkPoints', { interactionContext: { user: { id: '1' }, guildId: '1' } }).catch(() => {});
    steps.push(snapshot('toolsRegistry'));

    const { collectCommandPayloads, featureCommandFilter } = require('@goobster/core/utils/commandDeployment');
    collectCommandPayloads(path.join(root, 'apps', 'bot', 'commands'), { filter: featureCommandFilter });
    steps.push(snapshot('commands'));

    const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
    const ctx = createWebAppContext({
        gateway: { sendDm: async () => ({}), sendToChannel: async () => ({}) },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: quiet
    });
    createWebAppApp(ctx);
    steps.push(snapshot('portal'));

    const { startCoreRuntime } = require('@goobster/core/runtime/coreRuntime');
    const { DisabledGateway } = require('@goobster/core/gateway');
    const runtime = await startCoreRuntime({ gateway: new DisabledGateway(), schedulers: false, logger: quiet });
    steps.push(snapshot('runtime'));
    await runtime.stop();

    process.stdout.write(`\n@@PROBE@@${JSON.stringify({ off, steps, loaded: [...loaded] })}\n`);
    try { await require('@goobster/core/db').closeConnection(); } catch { /* never opened */ }
    try { await require('@goobster/core/services/eventBusService').close(); } catch { /* never started */ }
    process.exit(0);
}

main().catch((error) => {
    process.stdout.write(`\n@@PROBE@@${JSON.stringify({ error: String(error && error.stack || error) })}\n`);
    process.exit(1);
});
