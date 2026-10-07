/**
 * Assemble and start supervision for a running manager (`--supervise`):
 * the child adapter (or the external one with GOOBSTER_MANAGER_WORKERS=external),
 * the supervisor, and its registration for the lifecycle kinds and routes.
 * Required only when supervising, so the plain manager boot path loads none
 * of it.
 */

const crypto = require('node:crypto');
const coreLifecycle = require('@goobster/core/runtime/lifecycle');
const { createChildAdapter } = require('./adapters/child');
const { createExternalAdapter } = require('./adapters/external');
const { createSupervisor } = require('./supervisor');
const registry = require('./registry');

/**
 * @param {Object} params
 * @param {ReturnType<import('../manager').createManager>} params.manager
 * @param {Object} [params.logger]
 * @param {Object} [params.adapter] override the child adapter (tests)
 * @param {Object} [params.policy]
 * @returns {Promise<{ supervisor: Object, stop: () => Promise<Object> }>}
 */
async function startSupervision({ manager, logger = console, adapter = null, policy = {}, ...rest }) {
    const settings = manager.settings;
    const controlEnv = { GOOBSTER_MANAGER_STATE_DIR: settings.storeDir };
    const child = adapter || createChildAdapter({
        cwd: settings.root,
        logger,
        writeControl: (worker, request) => {
            const current = coreLifecycle.readControl(worker, { env: controlEnv });
            coreLifecycle.writeControl(worker, {
                boot: current ? current.boot : null,
                request: { ...request, id: request.id || crypto.randomUUID(), at: new Date().toISOString() }
            }, { env: controlEnv });
        }
    });
    const external = createExternalAdapter({ storeDir: settings.storeDir });
    const supervisor = createSupervisor({ manager, adapter: child, external, logger, policy, ...rest });
    const unregister = registry.register(settings.storeDir, supervisor);
    try {
        await supervisor.start();
    } catch (error) {
        unregister();
        throw error;
    }
    return {
        supervisor,
        async stop() {
            const result = await supervisor.stop();
            unregister();
            return result;
        }
    };
}

module.exports = { startSupervision };
