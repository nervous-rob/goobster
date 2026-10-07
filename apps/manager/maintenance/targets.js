/**
 * Which writer processes the barrier must fence (documentation/maintenance_barrier.md
 * § Writers). The set is the installation's layout: with a running supervisor
 * its view (child pids, states, HTTP acknowledgements), otherwise the layout
 * resolved from the same environment, every worker then treated as external:
 * reachable through its control file, its pid unknown.
 *
 * A writer the manager cannot reach through the control file is *unfenceable*
 * and blocks entry: today a sandbox runner on a non-loopback URL (another
 * host or container with no access to the manager store).
 */

const layouts = require('../lifecycle/layouts');
const { readConfigJson } = require('../manager');

function isLoopbackUrl(raw) {
    try {
        return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(raw).hostname);
    } catch {
        return false;
    }
}

/**
 * @param {Object} params
 * @param {Object} params.settings
 * @param {Object} params.fs
 * @param {Object|null} params.supervisor the running supervisor for this store, if any
 * @param {() => boolean|null} params.sandboxFeatureActive null when the feature state cannot be read
 * @returns {{ layout: string|null, error: string|null, supervised: boolean, unfenceable: string[], targets: Object[], refresh: () => Object[] }}
 */
function resolveTargets({ settings, fs, supervisor, sandboxFeatureActive }) {
    const env = settings.env || {};
    let view = supervisor && typeof supervisor.fenceTargets === 'function' ? supervisor.fenceTargets() : null;
    if (view && !view.started) view = null;
    let layout;
    let error;
    let targets;
    let refresh;
    if (view) {
        ({ layout, error } = view);
        targets = view.workers;
        refresh = () => supervisor.fenceTargets().workers;
    } else {
        const config = readConfigJson(settings.configPath, fs).config;
        let sandboxActive;
        try {
            sandboxActive = Boolean(sandboxFeatureActive());
        } catch {
            sandboxActive = false;
        }
        const resolved = layouts.workersFor({ settings, config, env, sandboxActive });
        layout = resolved.layout;
        error = resolved.error;
        targets = resolved.workers.map(worker => ({
            name: worker.name,
            healthUrl: worker.healthUrl,
            external: true,
            pid: null,
            running: true,
            state: 'external',
            fenceAck: null
        }));
        refresh = () => targets;
    }
    const unfenceable = [];
    if (env.GOOBSTER_SANDBOX_URL && !isLoopbackUrl(env.GOOBSTER_SANDBOX_URL)) {
        let active;
        try {
            active = sandboxFeatureActive();
        } catch {
            active = null;
        }
        if (active !== false) unfenceable.push('sandbox');
    }
    return { layout, error, supervised: Boolean(view), unfenceable, targets, refresh };
}

module.exports = { resolveTargets, isLoopbackUrl };
