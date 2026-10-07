/**
 * Portal routes: the operator's view of the installation manager (installer
 * P2.4, #326). Mounted by packages/core/web/appApi.js - do not require this
 * file from apps.
 *
 * The Host room's Features, Connections and Instance Defaults pages render
 * from the feature catalog and the manager's field catalog, preview the exact
 * change, and apply it THROUGH THE MANAGER: this file is a proxy, not a second
 * write path. Every route runs behind requireAuth + requireOperator (a member
 * learns nothing beyond the 403), mints a per-request bridge assertion
 * (managerBridge.js) and calls the manager at `manager.baseUrl` /
 * GOOBSTER_MANAGER_URL over HTTP. The browser never holds a manager
 * credential, and a secret travels once: in the request body to the preview
 * call, straight on to the manager's in-memory private input. Nothing here
 * logs, stores or audits a body.
 *
 * Every mutating route writes ONE operator_audit row after the manager
 * answered success (`host.*`); the manager's own `manager.*` row is
 * reconciled separately, so an applied change yields both, with the manager
 * operation id as `target`. Rows name features and fields, never a value.
 *
 * Spec: documentation/host_operations.md.
 */

const db = require('../../db');
const operatorAudit = require('../../services/operatorAuditService');
const featureCatalog = require('../../features/catalog');
const fieldCatalog = require('../../config/fieldCatalog');
const { createHostManagerClient, HostManagerError, PROBE_TIMEOUT_MS, INSTALL_TIMEOUT_MS } = require('../hostManagerClient');

/** Under /api/app/admin so the inventory's existing core claim covers it (features/inventory.js). */
const BASE = '/api/app/admin/host';
const INSTALL_KINDS = Object.freeze(['install.new', 'install.reconfigure', 'install.repair', 'install.uninstall']);
const MAINTENANCE_KINDS = Object.freeze(['backup.create', 'backup.restore', 'data.reset']);
const KINDS = Object.freeze(['features.set', 'config.set', 'defaults.set', 'lifecycle.apply', ...INSTALL_KINDS, ...MAINTENANCE_KINDS]);
const AUDIT_ACTION_FOR_KIND = Object.freeze({
    'features.set': 'host.features.apply',
    'config.set': 'host.config.apply',
    'defaults.set': 'host.defaults.apply',
    'lifecycle.apply': 'host.lifecycle.apply',
    'install.new': 'host.install.apply',
    'install.reconfigure': 'host.install.apply',
    'install.repair': 'host.install.apply',
    'install.uninstall': 'host.install.apply',
    'backup.create': 'host.backup.apply',
    'backup.restore': 'host.backup.apply',
    'data.reset': 'host.reset.apply'
});
const LIFECYCLE_ACTIONS = Object.freeze({
    'restart-now': 'host.lifecycle.restart_now',
    cancel: 'host.lifecycle.cancel',
    restart: 'host.lifecycle.restart'
});
const FEATURES_INPUT_KEYS = new Set(['changes', 'expectedRevision', 'attestation']);
const OPERATION_ID = /^[A-Za-z0-9_-]{6,80}$/;
const ATTESTATION_TTL_MS = 15 * 60 * 1000;
const MAX_REMEMBERED = 200;

/** The checkbox text; stored nowhere but shown with the plan (#261). */
const GAMBLING_ATTESTATION_TEXT = 'I confirm this instance is private, or that gambling is permitted for its members.';

/**
 * #261's host switches: what each covers on a shared, decided table. New
 * installs follow the catalog's `freshDefault`; the text here is only what a
 * switch governs and how an existing install seeds.
 */
const HOST_SWITCHES = Object.freeze({
    economy: { name: 'Economy and exchange', covers: 'Points, Jimbucks, stocks, margin, options, futures, orders and the exchange (the economy_* and exchange_* tables).', existing: 'On when those tables have rows.' },
    exchange: { name: 'Economy and exchange', covers: 'Points, Jimbucks, stocks, margin, options, futures, orders and the exchange (the economy_* and exchange_* tables).', existing: 'On when those tables have rows.' },
    gambling: { name: 'Gambling', covers: 'The wheel, predictions (prediction_*), table games (table_games) and /gamble.', existing: 'On when those tables have rows. Enabling it on a shared instance needs your attestation.' },
    tavern: { name: 'Tavern', covers: 'The Tavern adventure mode (tavern_*).', existing: 'On.' },
    music: { name: 'Music Lab', covers: 'The portal Music Lab and Conservatory.', existing: 'On.' },
    gba: { name: 'GBA', covers: 'GBA runs (gba_run_*).', existing: 'On.' }
});

/** One sentence per feature id on what turning it off keeps (data stays in place). */
const KEEPS_DATA = 'Turning a feature off keeps its data in place; it comes back unchanged when the feature is turned on again. Removing data is a separate maintenance operation.';

function fail(status, code, message, details = null, extra = null) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.details = details;
    error.extra = extra;
    return error;
}

/** A JSON-safe copy of manager-supplied details: bounded depth, string length and size. */
function clean(value, depth = 0) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}...` : value;
    if (depth >= 5) return null;
    if (Array.isArray(value)) return value.slice(0, 50).map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value).slice(0, 50)) {
            if (item !== undefined) out[key] = clean(item, depth + 1);
        }
        return out;
    }
    return null;
}

/** The manager's `{ error: { code, message, details } }` as a portal error, or null when `result` succeeded. */
function failureOf(result, operationView = null) {
    if (result.ok) return null;
    const body = result.body && typeof result.body === 'object' ? result.body : {};
    const managerError = body.error && typeof body.error === 'object' ? body.error : {};
    const code = typeof managerError.code === 'string' ? managerError.code.slice(0, 64) : 'MANAGER_ERROR';
    const message = typeof managerError.message === 'string' ? managerError.message.slice(0, 500) : 'The manager refused the request.';
    const extra = operationView || (body.operation ? { operation: viewOf(body.operation) } : null);
    if (result.status === 401 || result.status === 403 || result.status === 421) {
        return fail(502, 'MANAGER_BRIDGE_REFUSED',
            'The manager did not accept the portal\'s credentials. The bridge key may have changed (for example after an adoption); restart the portal so it reads the new key.',
            { managerCode: code });
    }
    if (result.status >= 500 || result.status < 400) {
        return fail(502, 'MANAGER_ERROR', 'The manager could not complete that.', { managerCode: code }, extra);
    }
    return fail(result.status, code, message, managerError.details ? clean(managerError.details) : null, extra);
}

/** An operation record as the page sees it: no actor, no channel, nothing the manager did not already scrub. */
function viewOf(operation) {
    if (!operation || typeof operation !== 'object') return null;
    return clean({
        id: operation.id,
        kind: operation.kind,
        status: operation.status,
        plan: operation.plan,
        revision: operation.revision,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
        steps: Array.isArray(operation.steps) ? operation.steps.map(step => ({ name: step.name, status: step.status, at: step.at })) : [],
        ...(operation.error ? { error: { code: operation.error.code, message: operation.error.message } } : {})
    });
}

/** A secret field never leaves with a value, whatever the manager sent. */
function scrubReport(report) {
    if (!report || typeof report !== 'object') return report;
    const sections = Array.isArray(report.sections) ? report.sections.map(section => ({
        ...section,
        fields: (section.fields || []).map((field) => {
            const descriptor = fieldCatalog.get(field.id);
            if (!descriptor || !descriptor.secret) return field;
            const rest = { ...field };
            delete rest.value;
            return rest;
        })
    })) : [];
    return {
        revision: report.revision ?? null,
        file: report.file || null,
        appDatabase: report.appDatabase || null,
        defaults: report.defaults || null,
        sections,
        probes: Array.isArray(report.probes) ? report.probes : []
    };
}

function fieldOf(report, id) {
    for (const section of report.sections || []) {
        for (const field of section.fields || []) if (field.id === id) return field;
    }
    return null;
}

function summarizeStatus(status) {
    return {
        state: status.state || null,
        reason: status.reason || null,
        version: status.version || null,
        installationId: status.installation && status.installation.installationId ? status.installation.installationId : null,
        origin: status.installation && status.installation.origin ? status.installation.origin : null,
        appDatabase: status.appDatabase ? { reachable: status.appDatabase.reachable === true, engine: status.appDatabase.engine || null, reason: status.appDatabase.reason || null } : null,
        lifecycle: status.lifecycle ? clean(status.lifecycle) : null,
        audit: status.audit ? { pending: Number(status.audit.pending) || 0 } : null,
        auth: status.auth ? { bridge: status.auth.bridge === true, strongAuthRequired: status.auth.strongAuthRequired === true } : null,
        maintenance: status.maintenance ? clean(status.maintenance) : null
    };
}

function mountHost(app, ctx, h) {
    const { requireAuth, requireOperator } = h;
    const guard = [requireAuth, requireOperator];
    const client = ctx.hostManager || createHostManagerClient();
    const now = ctx.now || (() => new Date());
    const remembered = new Map();

    function remember(operationId, entry) {
        const t = now().getTime();
        for (const [id, value] of remembered) if (value.expires <= t) remembered.delete(id);
        while (remembered.size >= MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
        remembered.set(operationId, { ...entry, expires: t + ATTESTATION_TTL_MS });
    }

    function recalled(operationId, actorId) {
        const entry = remembered.get(operationId);
        if (!entry || entry.expires <= now().getTime() || entry.actor !== actorId) return null;
        return entry;
    }

    const route = handler => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            res.json(await handler(req));
        } catch (error) {
            if (error instanceof HostManagerError || (error && error.status && error.code)) {
                res.status(error.status).json({
                    error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
                    ...(error.extra || {})
                });
                return;
            }
            ctx.logger?.error?.('Host route failed:', error && error.name);
            res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
        }
    };

    const actorOf = req => req.actor;

    /** An authenticated call that must produce a manager answer; a manager failure becomes a portal error. */
    async function managerJson(req, method, path, body, options = {}) {
        const result = await client.call({ actor: actorOf(req), method, path, body, ...options });
        const failure = failureOf(result);
        if (failure) throw failure;
        return result.body;
    }

    // --- Manager status -----------------------------------------------------

    app.get(`${BASE}/manager`, ...guard, route(async () => {
        const bridgeAvailable = client.bridge.available();
        let status;
        try {
            status = await client.status();
        } catch (error) {
            if (!(error instanceof HostManagerError)) throw error;
            const urlRefused = error.code === 'MANAGER_URL_REFUSED';
            return {
                reachable: false,
                state: null,
                bridge: { available: bridgeAvailable },
                error: { code: urlRefused ? 'MANAGER_URL_REFUSED' : 'MANAGER_UNREACHABLE', message: error.message }
            };
        }
        const summary = summarizeStatus(status);
        let error = null;
        if (summary.state === 'unclaimed') {
            error = { code: 'MANAGER_NOT_CLAIMED', message: 'The manager is running but this installation has not been claimed yet.' };
        } else if (summary.state === 'recovery') {
            error = { code: 'MANAGER_RECOVERY', message: 'The manager is in recovery and accepts local recovery only.' };
        } else if (!bridgeAvailable) {
            error = { code: 'MANAGER_BRIDGE_UNAVAILABLE', message: 'The portal has no key for the manager yet.' };
        }
        return { reachable: true, ...summary, bridge: { available: bridgeAvailable }, error };
    }));

    // --- The shared-instance rule (#261) -------------------------------------

    /**
     * An instance is shared when more than one portal account holds an active
     * session, or when it serves more than one Discord guild (the configured
     * guild list plus the guilds the acting operator shares with the bot).
     */
    async function sharedInstance(actorId) {
        const sessions = await db.get(
            `SELECT COUNT(DISTINCT s.userId) AS c
               FROM web_sessions s
               LEFT JOIN app_accounts a ON a.principalId = s.userId
              WHERE s.expiresAt > datetime('now') AND (a.status IS NULL OR a.status = 'active')`
        );
        const activeAccounts = Number(sessions && sessions.c) || 0;
        const guilds = new Set();
        const configured = ctx.config && Array.isArray(ctx.config.guildIds) ? ctx.config.guildIds : [];
        for (const id of configured) if (id) guilds.add(String(id));
        try {
            const mutual = await ctx.gateway.listMutualGuilds(actorId);
            for (const guild of mutual || []) if (guild && guild.id) guilds.add(String(guild.id));
        } catch {
            // The gateway is optional (no Discord, bot offline): the configured list still counts.
        }
        const reasons = [];
        if (activeAccounts > 1) reasons.push('MULTIPLE_ACTIVE_ACCOUNTS');
        if (guilds.size > 1) reasons.push('MULTIPLE_GUILDS');
        return { shared: reasons.length > 0, reasons, activeAccounts, guilds: guilds.size };
    }

    // --- Features -------------------------------------------------------------

    function describeFeature(id, local, remote) {
        const descriptor = featureCatalog.get(id);
        const localEntry = local.features[id];
        const remoteEntry = remote && remote.features ? remote.features[id] : null;
        const source = remoteEntry || localEntry;
        const state = {
            installed: localEntry.installed,
            configured: localEntry.configured,
            active: localEntry.active,
            pending: remoteEntry ? Boolean(remoteEntry.pending) : localEntry.pending,
            requested: source.requested,
            pendingActive: source.pendingActive === undefined ? null : source.pendingActive,
            reasons: localEntry.reasons.map(reason => ({ code: reason.code, ...(reason.dependency ? { dependency: reason.dependency } : {}) })),
            warnings: localEntry.warnings.map(warning => ({ code: warning.code, ...(warning.detail ? { names: String(warning.detail).split('|').slice(0, 12) } : {}) }))
        };
        if (remoteEntry && remoteEntry.installed !== undefined) state.installed = remoteEntry.installed && localEntry.installed;
        return {
            id,
            kind: descriptor.kind,
            title: descriptor.title,
            summary: descriptor.summary,
            dependsOn: descriptor.dependsOn.filter(dep => dep !== featureCatalog.CORE_ID),
            requiredBy: featureCatalog.dependentsOf(id),
            freshDefault: descriptor.freshDefault,
            apiKeys: descriptor.apiKeys.map(key => ({ name: key.name, configPath: key.configPath, purpose: key.purpose, required: key.required === true })),
            configKeys: [...descriptor.configKeys],
            systemDependencies: [...descriptor.systemDependencies],
            requiredSystemDependencies: [...descriptor.requiredSystemDependencies],
            docs: [...descriptor.docs],
            ...(HOST_SWITCHES[id] ? { hostSwitch: HOST_SWITCHES[id] } : {}),
            state
        };
    }

    app.get(`${BASE}/features`, ...guard, route(async (req) => {
        const local = ctx.features.status();
        let remote = null;
        let managerCode = null;
        try {
            const result = await client.call({ actor: actorOf(req), method: 'GET', path: '/manager/api/features' });
            if (result.ok && result.body && result.body.features) remote = result.body;
            else managerCode = failureOf(result).code;
        } catch (error) {
            if (!(error instanceof HostManagerError)) throw error;
            managerCode = error.code;
        }
        const shared = await sharedInstance(req.webUser.userId);
        const ids = featureCatalog.FEATURE_IDS.filter(id => id !== featureCatalog.CORE_ID);
        return {
            manager: { reachable: remote !== null, ...(managerCode ? { code: managerCode } : {}) },
            source: remote ? remote.source : local.source,
            revision: remote ? remote.revision : local.revision,
            runningRevision: local.revision,
            origin: remote ? remote.origin : local.origin,
            error: (remote ? remote.error : local.error) ? { code: (remote ? remote.error : local.error).code } : null,
            shared,
            keepsData: KEEPS_DATA,
            gamblingAttestation: { text: GAMBLING_ATTESTATION_TEXT },
            features: ids.map(id => describeFeature(id, local, remote))
        };
    }));

    // --- Configuration report ---------------------------------------------------

    app.get(`${BASE}/config`, ...guard, route(async (req) => {
        const report = await managerJson(req, 'GET', '/manager/api/config');
        return scrubReport(report);
    }));

    app.post(`${BASE}/config/probe`, ...guard, route(async (req) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const result = await client.call({ actor: actorOf(req), method: 'POST', path: '/manager/api/config/probe', body, timeoutMs: PROBE_TIMEOUT_MS });
        const failure = failureOf(result);
        if (failure) throw failure;
        const outcome = result.body || {};
        return {
            target: outcome.target, ok: outcome.ok === true, code: outcome.code, latencyMs: outcome.latencyMs,
            detail: outcome.detail, whatItDoes: outcome.whatItDoes, usedSaved: outcome.usedSaved === true
        };
    }));

    // --- Preview ----------------------------------------------------------------

    function featuresInput(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_INPUT', 'The input must be an object.');
        for (const key of Object.keys(input)) {
            if (!FEATURES_INPUT_KEYS.has(key)) throw fail(400, 'INVALID_INPUT', 'The input has a field features.set does not accept.');
        }
        const { attestation, ...forManager } = input;
        if (attestation !== undefined && (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)
            || Object.keys(attestation).some(key => key !== 'confirmed') || typeof attestation.confirmed !== 'boolean')) {
            throw fail(400, 'INVALID_INPUT', '"attestation" must be { confirmed: true }.');
        }
        return { forManager, attested: Boolean(attestation && attestation.confirmed === true) };
    }

    /** Refuse, before the manager, a Mail change that would strand registration (#261, issue requirement 4). */
    async function mailGuard(req, changes) {
        if (changes.mail !== false) return { warnings: [] };
        const report = scrubReport(await managerJson(req, 'GET', '/manager/api/config'));
        const nativeLogin = (fieldOf(report, 'identity.nativeLogin') || {}).value === true;
        const registration = (fieldOf(report, 'identity.registration') || {}).value;
        if (nativeLogin && registration === 'open') {
            throw fail(409, 'MAIL_REQUIRED_FOR_REGISTRATION',
                'Open sign-up verifies email addresses by mail, so Mail cannot be turned off while registration is open. Switch registration to invite-only first, then turn Mail off.',
                { setting: 'identity.registration', change: 'invite' });
        }
        const row = await db.get('SELECT COUNT(*) AS c FROM account_emails WHERE verifiedAt IS NOT NULL');
        const verified = Number(row && row.c) || 0;
        const warnings = [];
        if (verified > 0) {
            warnings.push({
                code: 'VERIFIED_ADDRESSES_EXIST', count: verified,
                message: `${verified} account(s) have a verified email address; without Mail they lose email sign-in and self-service recovery. The operator reset link keeps working.`
            });
        }
        return { warnings };
    }

    function restartNeeded(kind, plan) {
        if (!plan) return false;
        if (kind === 'features.set') return Array.isArray(plan.changes) && plan.changes.length > 0;
        if (kind === 'config.set') return Array.isArray(plan.restartRequired) && plan.restartRequired.length > 0;
        return false;
    }

    app.post(`${BASE}/operations`, ...guard, route(async (req) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const { kind, input, ...rest } = body;
        if (Object.keys(rest).length > 0) throw fail(400, 'INVALID_INPUT', 'The request has a field the operations API does not accept.');
        if (!KINDS.includes(kind)) throw fail(400, 'UNKNOWN_KIND', 'Unknown operation kind.');

        let managerInput = input;
        let attested = false;
        let warnings = [];
        if (kind === 'features.set') {
            const parsed = featuresInput(input);
            managerInput = parsed.forManager;
            attested = parsed.attested;
            const changes = managerInput.changes && typeof managerInput.changes === 'object' ? managerInput.changes : {};
            ({ warnings } = await mailGuard(req, changes));
            if (changes.gambling === true) {
                const shared = await sharedInstance(req.webUser.userId);
                if (shared.shared && !attested) {
                    throw fail(409, 'ATTESTATION_REQUIRED',
                        'This instance is shared. Turning Gambling on needs you to confirm it is private, or that gambling is permitted for its members.',
                        { reasons: shared.reasons, text: GAMBLING_ATTESTATION_TEXT });
                }
            }
        }

        if (kind === 'config.set' && managerInput && typeof managerInput === 'object' && managerInput.force !== undefined) {
            throw fail(400, 'INVALID_INPUT', 'A setting the environment controls cannot be overridden from the portal; change the environment instead.');
        }

        const planned = await managerJson(req, 'POST', '/manager/api/operations', { kind, input: managerInput });
        const operationId = planned.operation && planned.operation.id;
        if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) {
            throw fail(502, 'MANAGER_ERROR', 'The manager could not complete that.', { managerCode: 'BAD_OPERATION' });
        }
        const planView = viewOf(planned.operation);
        const validated = await client.call({ actor: actorOf(req), method: 'POST', path: `/manager/api/operations/${operationId}/validate` });
        const failure = failureOf(validated, { operation: (validated.body && viewOf(validated.body.operation)) || planView });
        if (failure) throw failure;

        const operation = viewOf(validated.body.operation) || planView;
        let attestation = null;
        if (kind === 'features.set' && managerInput.changes.gambling === true && attested) {
            attestation = { by: req.webUser.userId, at: now().toISOString(), text: GAMBLING_ATTESTATION_TEXT };
            operation.plan = { ...operation.plan, attestation };
            remember(operationId, { actor: req.webUser.userId, attestation });
        }
        return { operation, preview: { restartRequired: restartNeeded(kind, operation.plan), warnings }, attestation };
    }));

    // --- Apply --------------------------------------------------------------------

    function auditDetail(operation, result, attested) {
        const plan = operation.plan || {};
        switch (operation.kind) {
        case 'features.set': {
            const features = {};
            for (const change of plan.changes || []) features[change.id] = change.to === true;
            return { features, revision: result && result.revision, pending: (result && result.pending) || [], ...(attested ? { attested: true } : {}) };
        }
        case 'config.set':
            return {
                fields: (plan.changes || []).map(change => ({ id: change.id, action: change.action, ...(change.secret ? { secret: true } : {}) })),
                restartRequired: (result && result.restartRequired) || [],
                ineffective: (result && result.ineffective) || []
            };
        case 'defaults.set':
            return { fields: (plan.changes || []).map(change => ({ id: change.id, action: change.action })) };
        case 'lifecycle.apply':
            return { changeRef: plan.changeRef, graceSeconds: plan.graceSeconds, toRevision: plan.toRevision };
        case 'install.new':
        case 'install.reconfigure':
        case 'install.repair':
        case 'install.uninstall': {
            const target = plan.target || {};
            const changes = plan.changes || {};
            return {
                operation: operation.kind.slice('install.'.length),
                layout: target.layout || null,
                features: Array.isArray(target.features) ? target.features : [],
                ...(operation.kind === 'install.uninstall' ? { keepData: plan.keepData === true } : {}),
                ...(Array.isArray(changes.config) ? { fields: changes.config } : {}),
                ...(operation.kind === 'install.reconfigure' ? { rootsChanged: Boolean(changes.roots && (Array.isArray(changes.roots) ? changes.roots.length : Object.keys(changes.roots).length)), layoutChanged: Boolean(changes.layout) } : {}),
                restartRequired: Boolean(result && result.restartRequired)
            };
        }
        case 'backup.create':
            return {
                operation: 'create',
                tables: result && result.tables,
                rows: result && result.rows,
                files: result && result.files,
                configIncluded: Boolean(result && result.config && result.config.included),
                verified: Boolean(result && result.verified)
            };
        case 'backup.restore': {
            const counts = (result && result.rowCounts) || {};
            return {
                operation: 'restore',
                tables: counts.tables,
                mismatches: counts.mismatches,
                interrupted: result && result.interruptedTotal,
                fileSets: Array.isArray(result && result.files) ? result.files.length : 0,
                configRestored: Boolean(result && result.config && result.config.restored),
                safetyBackup: Boolean(result && result.safetyBackup),
                schemaChanged: Boolean(result && result.schemaChanged),
                workersRestarted: Boolean(result && result.workersRestarted)
            };
        }
        case 'data.reset':
            return {
                scope: plan.scope || null,
                ...(plan.feature ? { feature: plan.feature } : {}),
                backupVerified: Boolean(result && result.backup && result.backup.verified),
                paused: Boolean(result && result.paused)
            };
        default:
            return {};
        }
    }

    app.post(`${BASE}/operations/:id/apply`, ...guard, route(async (req) => {
        const operationId = String(req.params.id);
        if (!OPERATION_ID.test(operationId)) throw fail(400, 'INVALID_INPUT', 'That is not an operation id.');
        if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            throw fail(400, 'INVALID_INPUT', 'Apply takes no body; the plan is what was previewed.');
        }
        const current = (await managerJson(req, 'GET', `/manager/api/operations/${operationId}`)) || {};
        if (!KINDS.includes(current.kind)) throw fail(400, 'UNKNOWN_KIND', 'That operation cannot be applied from here.');

        const memory = recalled(operationId, req.webUser.userId);
        const enablesGambling = current.kind === 'features.set'
            && (current.plan.changes || []).some(change => change.id === 'gambling' && change.to === true);
        if (enablesGambling && !memory) {
            const shared = await sharedInstance(req.webUser.userId);
            if (shared.shared) {
                throw fail(409, 'ATTESTATION_REQUIRED',
                    'This instance is shared. Preview the change again and confirm the attestation before applying it.',
                    { reasons: shared.reasons, text: GAMBLING_ATTESTATION_TEXT });
            }
        }

        const result = await client.call({
            actor: actorOf(req), method: 'POST', path: `/manager/api/operations/${operationId}/apply`,
            body: { revision: current.revision === undefined ? null : current.revision },
            ...(INSTALL_KINDS.includes(current.kind) || MAINTENANCE_KINDS.includes(current.kind) ? { timeoutMs: INSTALL_TIMEOUT_MS } : {})
        });
        const failure = failureOf(result);
        if (failure) throw failure;
        const applied = result.body || {};
        const operation = viewOf(applied.operation) || viewOf(current);
        const outcome = applied.result === undefined ? null : clean(applied.result);
        remembered.delete(operationId);
        await operatorAudit.record({
            action: AUDIT_ACTION_FOR_KIND[current.kind],
            actor: req.webUser.userId,
            target: operationId,
            detail: auditDetail(operation, outcome, Boolean(enablesGambling && memory && memory.attestation))
        });
        return { operation, result: outcome };
    }));

    // --- Installation (the wizard's maintenance journeys, #330) ----------------------

    app.get(`${BASE}/operations/:id`, ...guard, route(async (req) => {
        const operationId = String(req.params.id);
        if (!OPERATION_ID.test(operationId)) throw fail(400, 'INVALID_INPUT', 'That is not an operation id.');
        const current = await managerJson(req, 'GET', `/manager/api/operations/${operationId}`);
        if (!current || !KINDS.includes(current.kind)) throw fail(404, 'NOT_FOUND', 'No such operation.');
        return { operation: viewOf(current) };
    }));

    app.get(`${BASE}/install/suggest`, ...guard, route(async (req) => clean(await managerJson(req, 'GET', '/manager/api/install/suggest'))));

    app.get(`${BASE}/install/record`, ...guard, route(async (req) => clean(await managerJson(req, 'GET', '/manager/api/install/record'))));

    app.get(`${BASE}/install/source`, ...guard, route(async (req) => {
        const dir = req.query.dir;
        if (typeof dir !== 'string' || dir.length === 0 || dir.length > 4096) throw fail(400, 'INVALID_INPUT', '"dir" must be an absolute path to a release directory.');
        return clean(await managerJson(req, 'GET', '/manager/api/install/source', undefined, { query: `?dir=${encodeURIComponent(dir)}` }));
    }));

    // --- Maintenance (backup, restore, reset, migration; #337) -----------------------
    // Reads only: the manager answers, this file adds nothing. The mutating
    // kinds go through POST /operations like every other kind.

    app.get(`${BASE}/backup/inspect`, ...guard, route(async (req) => {
        const dir = req.query.dir;
        if (typeof dir !== 'string' || dir.length === 0 || dir.length > 4096) throw fail(400, 'INVALID_INPUT', '"dir" must be an absolute path to a backup archive directory.');
        return clean(await managerJson(req, 'GET', '/manager/api/backup/inspect', undefined, { query: `?dir=${encodeURIComponent(dir)}` }));
    }));

    app.get(`${BASE}/backup/status`, ...guard, route(async (req) => clean(await managerJson(req, 'GET', '/manager/api/backup/status'))));

    app.get(`${BASE}/maintenance`, ...guard, route(async (req) => clean(await managerJson(req, 'GET', '/manager/api/maintenance'))));

    app.get(`${BASE}/reset/plan`, ...guard, route(async (req) => {
        const { scope, feature, ...rest } = req.query || {};
        if (Object.keys(rest).length > 0 || (scope !== 'instance' && scope !== 'feature') || (feature !== undefined && (typeof feature !== 'string' || !/^[a-z][A-Za-z0-9]{0,31}$/.test(feature)))) {
            throw fail(400, 'INVALID_INPUT', '"scope" must be "instance" or "feature" (with "feature" naming a feature).');
        }
        const query = `?scope=${encodeURIComponent(scope)}${feature !== undefined ? `&feature=${encodeURIComponent(feature)}` : ''}`;
        return clean(await managerJson(req, 'GET', '/manager/api/reset/plan', undefined, { query }));
    }));

    app.get(`${BASE}/migrate/status`, ...guard, route(async (req) => clean(await managerJson(req, 'GET', '/manager/api/migrate/status'))));

    // --- Lifecycle ------------------------------------------------------------------

    app.get(`${BASE}/lifecycle`, ...guard, route(async (req) => clean(await managerJson(req, 'GET', '/manager/api/lifecycle'))));

    for (const [name, action] of Object.entries(LIFECYCLE_ACTIONS)) {
        app.post(`${BASE}/lifecycle/${name}`, ...guard, route(async (req) => {
            const answer = await managerJson(req, 'POST', `/manager/api/lifecycle/${name}`);
            const operation = viewOf(answer.operation);
            await operatorAudit.record({
                action,
                actor: req.webUser.userId,
                target: operation && operation.id,
                detail: { scope: name === 'restart' ? 'workers' : 'pending' }
            });
            return { operation, result: answer.result === undefined ? null : clean(answer.result) };
        }));
    }
}

module.exports = {
    mountHost,
    BASE,
    KINDS,
    INSTALL_KINDS,
    MAINTENANCE_KINDS,
    HOST_SWITCHES,
    GAMBLING_ATTESTATION_TEXT,
    KEEPS_DATA
};
