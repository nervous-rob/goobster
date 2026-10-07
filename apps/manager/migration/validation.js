/**
 * The `validate` step: start the installation's workers against the target
 * with the maintenance fence still up, wait for each to come healthy within
 * the bound, then stop them (documentation/db_migration.md).
 *
 * The real workers are still running on their own ports and own their ack
 * files, so the validation copies get different ports, no sandbox runner and
 * a private state directory holding a copy of the active maintenance.json:
 * they boot fenced (no write reaches the target), their acknowledgements go
 * to the private directory, and nothing the real workers rely on is touched.
 * The layout's real worker scripts run, so a lite installation starts a
 * second bot process (a second gateway session, fenced).
 */

const nodeFs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { ManagerError } = require('../errors');
const files = require('../store/files');
const layouts = require('../lifecycle/layouts');
const { createChildAdapter } = require('../lifecycle/adapters/child');
const { checkHealth: defaultCheckHealth } = require('../lifecycle/health');
const { readConfigJson } = require('../manager');

const DEFAULT_HEALTH_TIMEOUT_MS = 90_000;
const POLL_MS = 500;

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const sleep = (ms) => new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });

/**
 * @param {Object} params
 * @param {Object} params.settings
 * @param {string} params.url target connection URL (never logged)
 * @param {Object} [params.adapter] child adapter or a test fake: { start(worker, { env }) -> handle }
 * @returns {Promise<{ workers: Array<{ name: string, healthy: boolean }>, layout: string }>}
 */
async function validateOnTarget({
    settings,
    url,
    fs = nodeFs,
    adapter = createChildAdapter(),
    checkHealth = defaultCheckHealth,
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    allocatePort = freePort
}) {
    const config = readConfigJson(settings.configPath, fs).config;
    const env = { ...settings.env, GOOBSTER_DB_URL: url };
    const resolved = layouts.workersFor({ settings, config, env, sandboxActive: false });
    if (resolved.error || resolved.workers.length === 0) {
        throw new ManagerError(409, 'VALIDATION_FAILED', 'The installation layout cannot be resolved, so the application cannot be started for validation.', { cause: resolved.error || 'NO_WORKERS' });
    }
    const stateDir = path.join(settings.storeDir, `migration-validate-${crypto.randomBytes(4).toString('hex')}`);
    files.ensureDir(stateDir, fs);
    const running = [];
    try {
        const active = path.join(settings.storeDir, 'maintenance.json');
        if (fs.existsSync(active)) files.writeAtomic(path.join(stateDir, 'maintenance.json'), fs.readFileSync(active, 'utf8'), fs);
        const results = [];
        for (const worker of resolved.workers) {
            const port = await allocatePort();
            const extra = { GOOBSTER_MANAGER_STATE_DIR: stateDir, GOOBSTER_MANAGER_URL: '', GOOBSTER_DB_URL: url };
            if (worker.name === 'bot') {
                extra.PORT = String(port);
                extra.GOOBSTER_PANEL_PORT = String(await allocatePort());
            } else if (worker.name === 'api') {
                extra.GOOBSTER_API_PORT = String(port);
            }
            const workerEnv = { ...env, ...worker.env, ...extra };
            delete workerEnv.GOOBSTER_PG_TEST_ISOLATE;
            delete workerEnv.GOOBSTER_MANAGER_ACK_TOKEN;
            let handle;
            try {
                handle = adapter.start(worker, { env: workerEnv });
            } catch {
                throw new ManagerError(409, 'VALIDATION_FAILED', 'A worker could not be started for validation.', { worker: worker.name, cause: 'SPAWN_FAILED' });
            }
            running.push({ worker, handle });
            results.push({ worker, handle, healthUrl: `http://127.0.0.1:${port}/health` });
        }
        const deadline = Date.now() + healthTimeoutMs;
        const outcome = [];
        for (const item of results) {
            let healthy = false;
            for (;;) {
                if (item.handle.running && !item.handle.running()) break;
                if (await checkHealth(item.healthUrl)) { healthy = true; break; }
                if (Date.now() >= deadline) break;
                await sleep(POLL_MS);
            }
            outcome.push({ name: item.worker.name, healthy });
        }
        const unhealthy = outcome.filter(item => !item.healthy);
        if (unhealthy.length > 0) {
            throw new ManagerError(409, 'VALIDATION_FAILED', 'The application did not come up healthy on the target; the source configuration was not changed.',
                { workers: unhealthy.map(item => item.name) });
        }
        return { workers: outcome, layout: resolved.layout };
    } finally {
        for (const { worker, handle } of running) {
            try { await handle.stop({ timeoutMs: worker.stopTimeoutMs }); } catch { }
        }
        try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { }
    }
}

module.exports = { validateOnTarget, freePort };
