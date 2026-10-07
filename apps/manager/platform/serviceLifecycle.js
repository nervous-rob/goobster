/**
 * Registering and unregistering the operating-system service as steps of the
 * install operations (documentation/linux_install.md, "The service").
 *
 * Registration, in order: the roots file the launcher reads, the ownership
 * record (installation.json `owned.services` and `<store>/services.json`),
 * the runtime account when one was asked for (`user.create`, which hands the
 * mutable roots to it), then `service.register`. The record is written first
 * because handing the manager store to another account ends the installer's
 * ability to write it. When the machine cannot take the service (systemd
 * absent or offline, no way to elevate, the operator declined) the install is
 * still complete: the step is `skipped` with MANUAL_FALLBACK, the record is
 * taken back, the unit text is left at `<store>/goobster.service`, and the
 * result names the exact command that runs the supervisor by hand.
 *
 * Unregistration acts only on services the installer recorded, and the helper
 * independently refuses a unit that does not carry this installation's marker.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const files = require('../store/files');
const unitText = require('./systemdUnit');
const rootsEnv = require('./rootsEnv');
const serviceRecord = require('./serviceRecord');
const { ROLE_KEYS } = require('../install/engine');

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

/** What an operator types to run the supervisor in the foreground, and to start it at boot by hand. */
function manualInstructions({ codeRoot, mode, nodePath, unitFile }) {
    const foreground = mode === 'payload'
        ? `${codeRoot}/current/bin/goobster-manager --supervise`
        : `${nodePath} ${codeRoot}/apps/manager/index.js --supervise`;
    return {
        foreground,
        boot: [
            `sudo install -m 0644 ${shellQuote(unitFile)} /etc/systemd/system/${FALLBACK_UNIT}`,
            'sudo systemctl daemon-reload',
            `sudo systemctl enable --now ${FALLBACK_UNIT}`
        ],
        unitFile
    };
}

function shellQuote(value) {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
}

function createServiceLifecycle({ core, settings, fs = nodeFs, now = () => new Date() }) {
    const storeDir = () => settings.storeDir;
    const available = (operation) => core.privilegedAvailable(operation);

    function unitInput({ t, doc, runtimeUser, mode }) {
        return {
            kind: core.serviceKindForHost(),
            name: SERVICE_NAME,
            layout: t.layout,
            codeRoot: t.roots.code,
            runtimeUser,
            installationId: doc.installationId,
            roots: rootsOf(t.roots),
            mode,
            ...(mode === 'checkout' ? { nodePath: process.execPath } : {})
        };
    }

    function writeFallbackUnit({ t, doc, runtimeUser, mode }) {
        const target = path.join(storeDir(), FALLBACK_UNIT);
        try {
            const text = unitText.renderUnit({
                name: SERVICE_NAME,
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

    function takeBackRecord(ctx, doc) {
        try {
            serviceRecord.recordUnregistered(storeDir(), { kind: 'systemd', name: SERVICE_NAME }, { fs });
        } catch { }
        try {
            ctx.store.updateInstallation(draft => ({
                ...draft,
                owned: { ...draft.owned, services: draft.owned.services.filter(item => !(item.kind === 'systemd' && item.name === SERVICE_NAME && item.registeredBy === 'installer')) }
            }));
        } catch { }
        void doc;
    }

    function recordRegistration(ctx, doc, t) {
        if (!doc.owned.services.some(item => item.kind === 'systemd' && item.name === SERVICE_NAME)) {
            ctx.store.updateInstallation(draft => ({
                ...draft,
                owned: { ...draft.owned, services: [...draft.owned.services, { kind: 'systemd', name: SERVICE_NAME, registeredBy: 'installer' }] }
            }));
        }
        serviceRecord.recordRegistered(storeDir(), {
            kind: 'systemd',
            name: SERVICE_NAME,
            unitPath: path.join(unitText.UNIT_DIR, unitText.unitFileName(SERVICE_NAME)),
            installationId: doc.installationId
        }, { now, fs });
        void t;
    }

    /**
     * The `register-service` step body.
     * @param {Object} options
     * @param {boolean} options.enabled
     */
    async function register(record, ctx, { enabled }) {
        if (!enabled) return { status: 'skipped', code: 'NOT_REQUESTED' };
        const t = record.plan.target;
        if (core.serviceKindForHost() !== 'systemd' || !available('service.register')) {
            return core.privilegedStep('service.register', { enabled: true, input: null, record, ctx });
        }
        const read = ctx.store.readInstallation();
        if (read.status !== 'ok') return { status: 'skipped', code: 'NOT_INSTALLED' };
        const doc = read.doc;
        const mode = modeOf(t.roots.code, fs);
        const invoking = currentUser();
        const asked = t.runtimeUser || null;
        const wantUser = Boolean(t.createRuntimeUser && asked);
        let runtimeUser = asked || invoking;
        const detail = { mode, runtimeUser: null, userCreated: false };
        const warnings = [];

        const requestDir = path.join(storeDir(), 'requests');
        if (runtimeUser === 'root' || !runtimeUser || !unitText.RUNTIME_USER.test(runtimeUser)) {
            const unitFile = writeFallbackUnit({ t, doc, runtimeUser: 'goobster', mode });
            ctx.scratch.service = { registered: false, fallback: true, reason: 'RUNTIME_USER_REQUIRED', ...manualInstructions({ codeRoot: t.roots.code, mode, nodePath: process.execPath, unitFile: unitFile || path.join(storeDir(), FALLBACK_UNIT) }) };
            return { status: 'skipped', code: 'MANUAL_FALLBACK', detail: { reason: 'RUNTIME_USER_REQUIRED', unitFile: unitFile !== null } };
        }

        if (mode === 'payload') {
            try {
                rootsEnv.writeRootsEnv({ roots: rootsOf(t.roots), layout: t.layout, mode }, fs);
            } catch {
                warnings.push('ROOTS_ENV_NOT_WRITTEN');
            }
        }
        recordRegistration(ctx, doc, t);

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
                takeBackRecord(ctx, doc);
                const { ManagerError } = require('../errors');
                throw new ManagerError(409, created.code || 'HELPER_FAILED', created.message || 'The runtime account could not be created.', { privileged: 'user.create', log: created.log || [] });
            }
            if (created.status === 'done') {
                detail.userCreated = created.outcome !== 'noop';
            } else {
                runtimeUser = invoking;
                warnings.push('RUNTIME_USER_NOT_CREATED');
            }
        }
        detail.runtimeUser = runtimeUser;
        if (!asked && invoking) warnings.push('RUNS_AS_INVOKING_USER');

        let result;
        if (!runtimeUser || runtimeUser === 'root') {
            result = { status: 'fallback', reason: 'RUNTIME_USER_REQUIRED' };
        } else {
            result = await core.runPrivileged('service.register', unitInput({ t, doc, runtimeUser, mode }), { record, ctx, requestDir });
        }

        if (result.status === 'done') {
            ctx.scratch.service = { registered: true, name: SERVICE_NAME, unit: unitText.unitFileName(SERVICE_NAME), runtimeUser, active: result.detail && result.detail.active ? result.detail.active : null, mode };
            return { status: 'done', detail: { ...detail, privileged: 'service.register', outcome: result.outcome, via: result.via || null, active: result.detail ? result.detail.active || null : null, warnings, log: result.log || [] } };
        }
        if (result.status === 'failed') {
            const { ManagerError } = require('../errors');
            throw new ManagerError(409, result.code || 'HELPER_FAILED', result.message || 'The service could not be registered.', { privileged: 'service.register', log: result.log || [] });
        }
        if (result.status === 'deferred') {
            takeBackRecord(ctx, doc);
            return { status: 'deferred', code: 'NOT_IMPLEMENTED', detail: { privileged: 'service.register' } };
        }

        takeBackRecord(ctx, doc);
        const fallbackUser = runtimeUser || invoking || 'goobster';
        const unitFile = writeFallbackUnit({ t, doc, runtimeUser: fallbackUser, mode });
        const manual = manualInstructions({ codeRoot: t.roots.code, mode, nodePath: process.execPath, unitFile: unitFile || path.join(storeDir(), FALLBACK_UNIT) });
        ctx.scratch.service = { registered: false, fallback: true, reason: result.reason, helperCommand: result.manual || null, ...manual };
        return { status: 'skipped', code: 'MANUAL_FALLBACK', detail: { ...detail, privileged: 'service.register', reason: result.reason, unitFile: unitFile !== null, warnings } };
    }

    /** The `unregister-service` step body: only what the record names, only a unit with our marker. */
    async function unregister(record, ctx, { enabled }) {
        if (!enabled) return { status: 'skipped', code: 'NOT_REQUESTED' };
        const read = ctx.store.readInstallation();
        const doc = read.status === 'ok' ? read.doc : null;
        const owned = doc ? doc.owned.services.filter(item => item.registeredBy === 'installer' && item.kind === 'systemd') : [];
        if (!doc || owned.length === 0 || core.serviceKindForHost() !== 'systemd' || !available('service.unregister')) {
            return core.privilegedStep('service.unregister', { enabled: true, input: null, record, ctx });
        }
        const outcomes = [];
        for (const service of owned) {
            const result = await core.runPrivileged('service.unregister', { kind: 'systemd', name: service.name, registeredBy: 'installer', installationId: doc.installationId }, { record, ctx, requestDir: path.join(storeDir(), 'requests') });
            if (result.status === 'failed') {
                const { ManagerError } = require('../errors');
                throw new ManagerError(409, result.code || 'HELPER_FAILED', result.message || 'The service could not be unregistered.', { privileged: 'service.unregister', log: result.log || [] });
            }
            if (result.status === 'fallback') {
                const { ManagerError } = require('../errors');
                throw new ManagerError(409, 'ELEVATION_REQUIRED', 'Removing the registered service needs administrator rights, which are not available; remove it by hand (systemctl disable --now goobster, delete its unit file), then run the uninstall again.', { reason: result.reason, ...(result.manual ? { manual: result.manual } : {}) });
            }
            if (result.status === 'deferred') return { status: 'deferred', code: 'NOT_IMPLEMENTED', detail: { privileged: 'service.unregister' } };
            serviceRecord.recordUnregistered(storeDir(), { kind: 'systemd', name: service.name }, { fs });
            outcomes.push({ name: service.name, outcome: result.outcome });
        }
        try {
            rootsEnv.removeRootsEnv(record.plan.target.roots.code, fs);
        } catch { }
        return { status: 'done', detail: { privileged: 'service.unregister', services: outcomes.length, outcomes } };
    }

    return { register, unregister, modeOf, manualInstructions };
}

module.exports = { createServiceLifecycle, manualInstructions, modeOf, SERVICE_NAME, FALLBACK_UNIT };
