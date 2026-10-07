/**
 * Which application workers an installation runs, per layout
 * (documentation/manager_lifecycle.md § Layouts):
 *
 *   lite        [bot]          the bot serves the portal in-process
 *   standalone  [api]          no Discord at all
 *   paired      [bot, api]     Postgres; plus [sandbox] when the sandbox
 *                              feature is active and its runner is local
 *
 * The layout comes from `GOOBSTER_RUNTIME_MODE` (lite | standalone | paired)
 * and otherwise from the Discord adapter switch: a Discord adapter means
 * lite, none means standalone. The switch mirrors
 * packages/core/config/discordConfig.js and the api mode handed to the api
 * worker is the one apps/api/server.js `resolveRuntimeMode()` derives from
 * the same environment; tests/lifecycleAdapters.test.js pins both.
 *
 * Worker records carry the script, environment and health URL the adapters
 * need; status reports names only.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');

const LAYOUTS = ['lite', 'standalone', 'paired'];
const OFF_WORDS = ['0', 'false', 'no', 'off'];
const BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);
const DEFAULT_BOT_PORT = 3000;
const DEFAULT_API_PORT = 3100;
const DEFAULT_SANDBOX_PORT = 3200;
const BOT_PANEL_DEFAULT_PORT = 3400;
const DEPLOY_TIMEOUT_MS = 75_000;
const STOP_MARGIN_MS = 15_000;

function tri(raw) {
    if (raw === undefined || raw === null || String(raw) === '') return null;
    return !OFF_WORDS.includes(String(raw).trim().toLowerCase());
}

/** discordConfig.enabled for a given environment and config.json, without loading either module. */
function discordAdapterEnabled({ env = {}, config = {} } = {}) {
    const fromEnv = tri(env.GOOBSTER_DISCORD_ENABLED);
    if (fromEnv !== null) return fromEnv;
    const fileValue = config && config.discord ? config.discord.enabled : undefined;
    if (fileValue !== undefined && fileValue !== null) return Boolean(fileValue);
    return typeof config.token === 'string' && config.token.trim().length > 0;
}

/**
 * @returns {{ layout: 'lite'|'standalone'|'paired', source: 'env'|'discord', error: string|null }}
 */
function resolveLayout({ env = {}, config = {} } = {}) {
    const raw = String(env.GOOBSTER_RUNTIME_MODE || '').trim().toLowerCase();
    const discord = discordAdapterEnabled({ env, config });
    let layout;
    let source = 'env';
    if (LAYOUTS.includes(raw)) {
        layout = raw;
    } else {
        layout = discord ? 'lite' : 'standalone';
        source = 'discord';
    }
    let error = null;
    if (layout === 'paired' && !env.GOOBSTER_DB_URL) error = 'PAIRED_REQUIRES_POSTGRES';
    else if (layout === 'paired' && !env.GOOBSTER_INTERNAL_TOKEN) error = 'PAIRED_REQUIRES_INTERNAL_TOKEN';
    else if (layout !== 'standalone' && !(typeof config.token === 'string' && config.token.trim())) error = 'DISCORD_TOKEN_MISSING';
    else if (layout === 'standalone' && config.webapp?.enabled !== true) error = 'WEBAPP_DISABLED';
    return { layout, source, error };
}

/** The mode the api worker runs in for a layout (always explicit in its environment). */
function apiModeFor(layout) {
    return layout === 'paired' ? 'paired' : 'standalone';
}

function loopbackUrl(raw) {
    try {
        const url = new URL(raw);
        return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname) ? url : null;
    } catch {
        return null;
    }
}

/** A local sandbox runner the manager should run, or null. */
function sandboxPlan({ layout, env, sandboxActive }) {
    if (!sandboxActive || !env.GOOBSTER_INTERNAL_TOKEN) return null;
    const configured = env.GOOBSTER_SANDBOX_URL ? loopbackUrl(env.GOOBSTER_SANDBOX_URL) : null;
    if (env.GOOBSTER_SANDBOX_URL && !configured) return null;
    if (!configured && layout !== 'paired') return null;
    const port = configured ? Number(configured.port || 80) : (Number(env.GOOBSTER_SANDBOX_PORT) || DEFAULT_SANDBOX_PORT);
    return { port, url: configured ? configured.origin : `http://127.0.0.1:${port}` };
}

/**
 * The worker set for one revision.
 * @param {Object} params
 * @param {Object} params.settings      resolveSettings() output (root, storeDir, port, lan)
 * @param {Object} params.config        parsed config.json
 * @param {Object} params.env           the manager's environment
 * @param {boolean} params.sandboxActive the sandbox feature in the revision being started
 * @param {number} [params.drainSeconds]
 * @returns {{ layout: string, error: string|null, workers: Object[] }}
 */
function workersFor({ settings, config = {}, env = settings.env || {}, sandboxActive = false, drainSeconds = coreLifecycle.DRAIN_BOUND_SECONDS }) {
    const { layout, error } = resolveLayout({ env, config });
    const root = settings.root;
    const stopTimeoutMs = drainSeconds * 1000 + STOP_MARGIN_MS;
    const base = {
        args: [],
        stopSignal: 'SIGTERM',
        stopTimeoutMs,
        restartBackoff: BACKOFF_MS
    };
    const managerUrl = settings.lan ? null : `http://127.0.0.1:${settings.port}`;
    const sharedEnv = (name) => ({
        GOOBSTER_SUPERVISOR: 'manager',
        GOOBSTER_MANAGER_STATE_DIR: settings.storeDir,
        GOOBSTER_LIFECYCLE_DRAIN_SECONDS: String(drainSeconds),
        GOOBSTER_WORKER_NAME: name,
        ...(managerUrl ? { GOOBSTER_MANAGER_URL: managerUrl } : {})
    });
    const workers = [];
    if (layout === 'lite' || layout === 'paired') {
        const port = Number(env.PORT) || DEFAULT_BOT_PORT;
        const extra = {};
        const panelPort = env.GOOBSTER_PANEL_PORT || config.panel?.port;
        if (!panelPort && settings.port === BOT_PANEL_DEFAULT_PORT) extra.GOOBSTER_PANEL_PORT = String(BOT_PANEL_DEFAULT_PORT + 1);
        workers.push({
            ...base,
            name: 'bot',
            script: path.join(root, 'apps', 'bot', 'index.js'),
            env: { ...sharedEnv('bot'), ...extra },
            healthUrl: `http://127.0.0.1:${port}/health`,
            ackFile: 'bot',
            preStart: { name: 'deploy-commands', script: path.join(root, 'apps', 'bot', 'deploy-commands.js'), timeoutMs: DEPLOY_TIMEOUT_MS }
        });
    }
    if (layout === 'standalone' || layout === 'paired') {
        const port = Number(env.GOOBSTER_API_PORT) || DEFAULT_API_PORT;
        workers.push({
            ...base,
            name: 'api',
            script: path.join(root, 'apps', 'api', 'index.js'),
            env: { ...sharedEnv('api'), GOOBSTER_RUNTIME_MODE: apiModeFor(layout) },
            healthUrl: `http://127.0.0.1:${port}/health`,
            ackFile: 'api'
        });
    }
    const sandbox = sandboxPlan({ layout, env, sandboxActive });
    if (sandbox) {
        workers.unshift({
            ...base,
            name: 'sandbox',
            script: path.join(root, 'apps', 'sandbox', 'index.js'),
            env: { ...sharedEnv('sandbox'), GOOBSTER_SANDBOX_URL: '', GOOBSTER_SANDBOX_PORT: String(sandbox.port) },
            healthUrl: `${sandbox.url}/health`,
            ackFile: 'sandbox'
        });
        for (const worker of workers) {
            if (worker.name !== 'sandbox' && !env.GOOBSTER_SANDBOX_URL) worker.env.GOOBSTER_SANDBOX_URL = sandbox.url;
        }
    }
    return { layout, error, workers };
}

/** Per-start environment additions: the revision, the staged flag and a fresh ack token. */
function startEnv({ revision, staged, managerPid = process.pid }) {
    return {
        GOOBSTER_REVISION: String(revision),
        GOOBSTER_FEATURES_STAGED: staged ? '1' : '0',
        GOOBSTER_MANAGER_PID: String(managerPid),
        GOOBSTER_MANAGER_ACK_TOKEN: crypto.randomBytes(18).toString('base64url')
    };
}

module.exports = {
    LAYOUTS,
    BACKOFF_MS,
    DEFAULT_BOT_PORT,
    DEFAULT_API_PORT,
    DEFAULT_SANDBOX_PORT,
    discordAdapterEnabled,
    resolveLayout,
    apiModeFor,
    sandboxPlan,
    workersFor,
    startEnv
};
