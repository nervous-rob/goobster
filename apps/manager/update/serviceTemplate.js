/**
 * The operating-system service definition after an update (documentation/manager_update.md,
 * "The service registration"). The service text comes from the running manager's own templates, so
 * a new manager release may render a different one. The registration is left alone unless the
 * template changed: `<store>/services.json` records a hash of what the kind renders for a fixed,
 * made-up installation, and a changed hash re-registers through the same `service.register` the
 * installer uses. A failure never undoes the update (the verified release keeps running under the
 * service that was already registered); it is reported and retried at the next update.
 *
 * A registration made before the hash was recorded has no baseline: it is recorded now and left alone,
 * because "changed" cannot be told from "unknown".
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const serviceRecord = require('../platform/serviceRecord');
const { modeOf } = require('../platform/serviceLifecycle');
const { ROLE_KEYS } = require('../install/engine');

const CANONICAL_ROOTS = Object.freeze({
    code: '/canonical/code',
    data: '/canonical/data',
    config: '/canonical/config',
    cache: '/canonical/cache',
    logs: '/canonical/logs',
    uploads: '/canonical/uploads',
    managerStore: '/canonical/manager'
});

const WINDOWS_ROOTS = Object.freeze(Object.fromEntries(Object.keys(CANONICAL_ROOTS).map(role => [role, `C:\\canonical\\${role}`])));

/** The hash of what a kind renders for a fixed installation: it changes only when the template does. */
function hashOf(definition) {
    const windows = definition.kind === 'windows-service';
    const roots = { ...(windows ? WINDOWS_ROOTS : CANONICAL_ROOTS) };
    const text = definition.render({
        name: definition.serviceName,
        installationId: '00000000-0000-4000-8000-000000000000',
        runtimeUser: definition.account.defaultFor({ invoking: 'goobster' }),
        codeRoot: roots.code,
        roots,
        layout: 'lite',
        mode: 'payload',
        nodePath: windows ? 'C:\\canonical\\node.exe' : '/canonical/node'
    });
    return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function currentUser() {
    try {
        return os.userInfo().username;
    } catch {
        return null;
    }
}

function createServiceRefresh({ core, settings, store, journal, fs = nodeFs, now = () => new Date() }) {
    /**
     * @returns {Promise<{ template: 'none'|'unregistered'|'baseline'|'unchanged'|'refreshed'|'manual'|'deferred'|'failed', code?: string }>}
     */
    async function refresh({ operationId = null, actor = null, via = null } = {}) {
        try {
            const definition = core.serviceDefinitionForHost();
            if (!definition) return { template: 'none' };
            const read = store.readInstallation();
            if (read.status !== 'ok') return { template: 'none' };
            const doc = read.doc;
            const entry = serviceRecord.readRecord(settings.storeDir, fs).services
                .find(item => item.kind === definition.kind && item.name === definition.serviceName);
            if (!entry) return { template: 'unregistered' };
            const current = hashOf(definition);
            if (!entry.templateHash) {
                serviceRecord.recordTemplate(settings.storeDir, { kind: entry.kind, name: entry.name, templateHash: current }, { fs });
                return { template: 'baseline' };
            }
            if (entry.templateHash === current) return { template: 'unchanged' };

            if (!core.privilegedAvailable('service.register')) return { template: 'deferred', code: 'NOT_IMPLEMENTED' };
            const invoking = currentUser();
            const runtimeUser = doc.runtimeUser || definition.account.defaultFor({ invoking });
            if (!definition.account.accepts(runtimeUser)) return { template: 'manual', code: 'RUNTIME_USER_REQUIRED' };
            const roots = {};
            for (const role of ROLE_KEYS) roots[role] = doc.roots[role];
            const input = definition.registerInput({
                name: definition.serviceName,
                layout: doc.layout,
                codeRoot: doc.roots.code,
                runtimeUser,
                installationId: doc.installationId,
                roots,
                mode: modeOf(doc.roots.code, fs),
                nodePath: process.execPath,
                invoking,
                elevated: typeof process.geteuid === 'function' ? process.geteuid() === 0 : null
            });
            const record = { id: operationId, actor, via };
            const ctx = { store, journal, scratch: {} };
            const result = await core.runPrivileged('service.register', input, { record, ctx, requestDir: path.join(settings.storeDir, 'requests') });
            if (result.status === 'done') {
                serviceRecord.recordTemplate(settings.storeDir, { kind: entry.kind, name: entry.name, templateHash: current }, { fs });
                return { template: 'refreshed' };
            }
            if (result.status === 'deferred') return { template: 'deferred', code: 'NOT_IMPLEMENTED' };
            if (result.status === 'fallback') return { template: 'manual', code: result.reason || 'ELEVATION_UNAVAILABLE' };
            return { template: 'failed', code: result.code || 'HELPER_FAILED' };
        } catch (error) {
            return { template: 'failed', code: error && error.code ? String(error.code) : 'SERVICE_REFRESH_FAILED' };
        }
    }

    return { refresh, hashOf };
}

module.exports = { hashOf, createServiceRefresh };
