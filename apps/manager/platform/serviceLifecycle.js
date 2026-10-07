/**
 * Registering and unregistering the operating-system service as steps of the
 * install operations (documentation/linux_install.md, "The service").
 *
 * Everything specific to one service manager (the definition text, where it
 * is installed, the account rules, the by-hand commands) comes from the kind
 * definition in `serviceKinds.js`; this module is the same for systemd,
 * launchd and the Windows service manager.
 *
 * Registration, in order: the roots file the launcher reads, the ownership
 * record (installation.json `owned.services` and `<store>/services.json`),
 * the runtime account when one was asked for and the kind creates accounts
 * (`user.create`, which hands the mutable roots to it), then
 * `service.register`. The record is written first because handing the
 * manager store to another account ends the installer's ability to write
 * it. When the machine cannot take the service (the service manager absent
 * or offline, no way to elevate, the operator declined) the install is
 * still complete: the step is `skipped` with MANUAL_FALLBACK, the record is
 * taken back, the definition text is left at `<store>/<fallbackFileName>`,
 * and the result names the exact command that runs the supervisor by hand.
 *
 * Unregistration acts only on services the installer recorded, and the helper
 * independently refuses a service that does not carry this installation's marker.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const files = require('../store/files');
const rootsEnv = require('./rootsEnv');
const serviceRecord = require('./serviceRecord');
const serviceKinds = require('./serviceKinds');
const { ROLE_KEYS } = require('../install/engine');

/** The kind this process registers; kept for callers that expect the systemd names. */
const SERVICE_NAME = 'goobster';
const FALLBACK_UNIT = 'goobster.service';

function currentUser() {
    try {
        return os.userInfo().username;
    } catch {
        return null;
    }
}

/** `payload` when `<code>/current` holds an activated payload, else a source checkout. */
function modeOf(codeRoot, fs = nodeFs) {
    return fs.existsSync(path.join(codeRoot, 'current', 'payload-manifest.json')) ? 'payload' : 'checkout';
}

function rootsOf(roots) {
    const out = {};
    for (const role of ROLE_KEYS) out[role] = roots[role];
    return out;
}

/**
 * What an operator types to run the supervisor in the foreground, and to start
 * it at boot by hand, for the kind this platform registers (systemd when the
 * platform has no definition yet, so the wording is never empty).
 */
function manualInstructions({ codeRoot, mode, nodePath, unitFile, kind = null }) {
    const definition = (kind ? serviceKinds.forKind(kind) : serviceKinds.forPlatform()) || serviceKinds.forKind('systemd');
    return definition.manualInstructions({ codeRoot, mode, nodePath, unitFile });
}

const MAY_HAVE_WRITTEN = new Set(['COMMAND_FAILED', 'HELPER_FAILED', 'HELPER_PROTOCOL']);

/**
 * @param {Object} params
 * @param {Object} params.core       the install engine (privileged hooks, the host's service kind)
 * @param {Object} params.settings
 * @param {Object} [params.fs]
 * @param {Function} [params.now]
 * @param {Object} [params.kinds]    the kind registry (tests inject one with a fake kind)
 */
function createServiceLifecycle({ core, settings, fs = nodeFs, now = () => new Date(), kinds = serviceKinds }) {
    const storeDir = () => settings.storeDir;
    const available = (operation) => core.privilegedAvailable(operation);
    const definitionForHost = () => kinds.forKind(core.serviceKindForHost());

    function writeFallbackDefinition(def, { t, doc, runtimeUser, mode }) {
        const target = path.join(storeDir(), def.fallbackFileName);
        try {
            const text = def.render({
                name: def.serviceName,
                installationId: doc.installationId,
                runtimeUser,
                codeRoot: t.roots.code,
                roots: rootsOf(t.roots),
                layout: t.layout,
                mode,
                nodePath: process.execPath
            });
            files.writeAtomic(target, text, fs);
            fs.chmodSync(target, 0o644);
            return target;
        } catch {
            return null;
        }
    }

    function takeBackRecord(def, ctx) {
        try {
            serviceRecord.recordUnregistered(storeDir(), { kind: def.kind, name: def.serviceName }, { fs });
        } catch { }
        try {
            ctx.store.updateInstallation(draft => ({
                ...draft,
                owned: { ...draft.owned, services: draft.owned.services.filter(item => !(item.kind === def.kind && item.name === def.serviceName && item.registeredBy === 'installer')) }
            }));
        } catch { }
    }

    function recordRegistration(def, ctx, doc, t) {
        if (!doc.owned.services.some(item => item.kind === def.kind && item.name === def.serviceName)) {
            ctx.store.updateInstallation(draft => ({
                ...draft,
                owned: { ...draft.owned, services: [...draft.owned.services, { kind: def.kind, name: def.serviceName, registeredBy: 'installer' }] }
            }));
        }
        serviceRecord.recordRegistered(storeDir(), {
            kind: def.kind,
            name: def.serviceName,
            unitPath: def.installedPath(def.serviceName, { roots: rootsOf(t.roots) }),
            installationId: doc.installationId
        }, { now, fs });
    }

    function fallback(def, { t, doc, mode, runtimeUser, reason, helperCommand = null, detail = {} }) {
        const unitFile = writeFallbackDefinition(def, { t, doc, runtimeUser, mode });
        const manual = def.manualInstructions({ codeRoot: t.roots.code, mode, nodePath: process.execPath, unitFile: unitFile || path.join(storeDir(), def.fallbackFileName) });
        return {
            scratch: { registered: false, fallback: true, reason, kind: def.kind, ...(helperCommand ? { helperCommand } : {}), ...manual },
            step: { status: 'skipped', code: 'MANUAL_FALLBACK', detail: { ...detail, reason, unitFile: unitFile !== null } }
        };
    }

    /**
     * The `register-service` step body.
     * @param {Object} options
     * @param {boolean} options.enabled
     */
    async function register(record, ctx, { enabled }) {
        const t = record.plan.target;
        if (!enabled) {
            // No service, but the launcher still has to find this installation's roots.
            if (modeOf(t.roots.code, fs) === 'payload') {
                try {
                    rootsEnv.writeRootsEnv({ roots: rootsOf(t.roots), layout: t.layout, mode: 'payload' }, fs);
                } catch { }
            }
            return { status: 'skipped', code: 'NOT_REQUESTED' };
        }
        const def = definitionForHost();
        // No definition for this platform's kind: there is no request to make, so the step defers without a helper call.
        if (!def) return { status: 'deferred', code: 'NOT_IMPLEMENTED', detail: { privileged: 'service.register', kind: core.serviceKindForHost() } };
        if (!available('service.register')) {
            return core.privilegedStep('service.register', { enabled: true, input: null, record, ctx });
        }
        const read = ctx.store.readInstallation();
        if (read.status !== 'ok') return { status: 'skipped', code: 'NOT_INSTALLED' };
        const doc = read.doc;
        const mode = modeOf(t.roots.code, fs);
        const invoking = currentUser();
        const asked = t.runtimeUser || null;
        const wantUser = Boolean(def.account.creatable && t.createRuntimeUser && asked);
        let runtimeUser = asked || def.account.defaultFor({ invoking });
        const detail = { kind: def.kind, mode, runtimeUser: null, userCreated: false };
        const warnings = [];

        const requestDir = path.join(storeDir(), 'requests');
        if (!def.account.accepts(runtimeUser)) {
            const out = fallback(def, { t, doc, mode, runtimeUser: def.account.fallbackName, reason: 'RUNTIME_USER_REQUIRED' });
            ctx.scratch.service = out.scratch;
            return out.step;
        }

        if (mode === 'payload') {
            try {
                rootsEnv.writeRootsEnv({ roots: rootsOf(t.roots), layout: t.layout, mode }, fs);
            } catch {
                warnings.push('ROOTS_ENV_NOT_WRITTEN');
            }
        }
        recordRegistration(def, ctx, doc, t);

        if (wantUser) {
            const created = await core.runPrivileged('user.create', {
                name: runtimeUser,
                home: path.dirname(t.roots.data),
                system: true,
                installationId: doc.installationId,
                roots: rootsOf(t.roots),
                mode
            }, { record, ctx, requestDir });
            if (created.status === 'failed') {
                takeBackRecord(def, ctx);
                const { ManagerError } = require('../errors');
                throw new ManagerError(409, created.code || 'HELPER_FAILED', created.message || 'The runtime account could not be created.', { privileged: 'user.create', log: created.log || [] });
            }
            if (created.status === 'done') {
                detail.userCreated = created.outcome !== 'noop';
            } else {
                runtimeUser = def.account.defaultFor({ invoking });
                warnings.push('RUNTIME_USER_NOT_CREATED');
            }
        }
        detail.runtimeUser = runtimeUser;
        if (!asked && invoking && runtimeUser === invoking) warnings.push('RUNS_AS_INVOKING_USER');

        let result;
        if (!def.account.accepts(runtimeUser)) {
            result = { status: 'fallback', reason: 'RUNTIME_USER_REQUIRED' };
        } else {
            const input = def.registerInput({
                name: def.serviceName,
                layout: t.layout,
                codeRoot: t.roots.code,
                runtimeUser,
                installationId: doc.installationId,
                roots: rootsOf(t.roots),
                mode,
                nodePath: process.execPath,
                // For a kind that registers per-account services as well as machine ones (launchd).
                invoking,
                elevated: typeof process.geteuid === 'function' ? process.geteuid() === 0 : null
            });
            result = await core.runPrivileged('service.register', input, { record, ctx, requestDir });
        }

        if (result.status === 'done') {
            try {
                serviceRecord.recordTemplate(storeDir(), { kind: def.kind, name: def.serviceName, templateHash: require('../update/serviceTemplate').hashOf(def) }, { fs });
            } catch { }
            ctx.scratch.service = { registered: true, kind: def.kind, name: def.serviceName, unit: def.installedFileName(def.serviceName), runtimeUser, active: result.detail && result.detail.active ? result.detail.active : null, mode };
            return { status: 'done', detail: { ...detail, privileged: 'service.register', outcome: result.outcome, via: result.via || null, active: result.detail ? result.detail.active || null : null, warnings, log: result.log || [] } };
        }
        if (result.status === 'failed') {
            // A refusal wrote nothing: the record must not claim a service that is not ours. A command that died half way may have
            // left our definition behind, so the record stays and a resumed install (or an uninstall) finishes or removes it.
            if (!MAY_HAVE_WRITTEN.has(result.code)) takeBackRecord(def, ctx);
            const { ManagerError } = require('../errors');
            throw new ManagerError(409, result.code || 'HELPER_FAILED', result.message || 'The service could not be registered.', { privileged: 'service.register', log: result.log || [] });
        }
        if (result.status === 'deferred') {
            takeBackRecord(def, ctx);
            return { status: 'deferred', code: 'NOT_IMPLEMENTED', detail: { privileged: 'service.register' } };
        }

        takeBackRecord(def, ctx);
        const fallbackUser = def.account.accepts(runtimeUser) ? runtimeUser : (def.account.accepts(invoking) ? invoking : def.account.fallbackName);
        const out = fallback(def, { t, doc, mode, runtimeUser: fallbackUser, reason: result.reason, helperCommand: result.manual || null, detail: { ...detail, privileged: 'service.register' } });
        out.step.detail.warnings = warnings;
        ctx.scratch.service = out.scratch;
        return out.step;
    }

    /** The `unregister-service` step body: only what the record names, only a service with our marker. */
    async function unregister(record, ctx, { enabled }) {
        if (!enabled) {
            try {
                rootsEnv.removeRootsEnv(record.plan.target.roots.code, fs);
            } catch { }
            return { status: 'skipped', code: 'NOT_REQUESTED' };
        }
        const def = definitionForHost();
        const read = ctx.store.readInstallation();
        const doc = read.status === 'ok' ? read.doc : null;
        if (!def) return { status: 'deferred', code: 'NOT_IMPLEMENTED', detail: { privileged: 'service.unregister', kind: core.serviceKindForHost() } };
        const owned = doc ? doc.owned.services.filter(item => item.registeredBy === 'installer' && item.kind === def.kind) : [];
        if (!doc || owned.length === 0 || !available('service.unregister')) {
            return core.privilegedStep('service.unregister', { enabled: true, input: null, record, ctx });
        }
        const outcomes = [];
        for (const service of owned) {
            const result = await core.runPrivileged('service.unregister', def.unregisterInput({ name: service.name, installationId: doc.installationId }), { record, ctx, requestDir: path.join(storeDir(), 'requests') });
            if (result.status === 'failed') {
                const { ManagerError } = require('../errors');
                throw new ManagerError(409, result.code || 'HELPER_FAILED', result.message || 'The service could not be unregistered.', { privileged: 'service.unregister', log: result.log || [] });
            }
            if (result.status === 'fallback') {
                const { ManagerError } = require('../errors');
                throw new ManagerError(409, 'ELEVATION_REQUIRED', `Removing the registered service needs administrator rights, which are not available; remove it by hand (${def.removeByHand}), then run the uninstall again.`, { reason: result.reason, ...(result.manual ? { manual: result.manual } : {}) });
            }
            if (result.status === 'deferred') return { status: 'deferred', code: 'NOT_IMPLEMENTED', detail: { privileged: 'service.unregister' } };
            serviceRecord.recordUnregistered(storeDir(), { kind: def.kind, name: service.name }, { fs });
            outcomes.push({ name: service.name, outcome: result.outcome });
        }
        try {
            rootsEnv.removeRootsEnv(record.plan.target.roots.code, fs);
        } catch { }
        return { status: 'done', detail: { privileged: 'service.unregister', kind: def.kind, services: outcomes.length, outcomes } };
    }

    return { register, unregister, modeOf, manualInstructions };
}

module.exports = { createServiceLifecycle, manualInstructions, modeOf, SERVICE_NAME, FALLBACK_UNIT };
