/**
 * Operation kinds that create or open the installation:
 *
 * - `claim`            first-time setup with the bootstrap credential (internal; POST /claim)
 * - `adopt`            explicit adoption of an existing installation into a
 *                      missing or unusable store (recovery session only)
 * - `recovery.unlock`  exchange a recovery credential for a short local
 *                      recovery session (internal; POST /recovery/unlock)
 *
 * The owner label is kept out of the journal: plans say that one was given.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { ManagerError } = require('../../errors');
const files = require('../../store/files');

const LABEL_SHAPE = /^[\p{L}\p{N} ._'@()-]{1,80}$/u;

function parseLabel(input, keys) {
    if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
    for (const key of Object.keys(input)) {
        if (!keys.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field this operation does not accept.');
    }
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!LABEL_SHAPE.test(label)) {
        throw new ManagerError(400, 'INVALID_INPUT', '"label" must be 1 to 80 letters, digits, spaces or ._\'@()- characters.');
    }
    return label;
}

const bridgeKeyStep = {
    name: 'create-bridge-key',
    run(_record, ctx) {
        const { created } = ctx.bridge.ensureKey(ctx.scratch.installationId);
        return { created };
    }
};

function createClaimKind() {
    const keys = new Set(['label']);
    return {
        kind: 'claim',
        public: false,
        allowed: (state, via) => state.state === 'unclaimed' && via === 'bootstrap',
        plan(input) {
            const label = parseLabel(input, keys);
            return { plan: { action: 'create-installation', ownerLabel: 'provided' }, revision: null, privateInput: { label } };
        },
        steps: [
            {
                name: 'create-installation',
                run(_record, ctx) {
                    if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
                    const doc = ctx.store.createInstallation({ origin: 'claim', ownerLabel: ctx.input.label });
                    ctx.scratch.installationId = doc.installationId;
                    return { installationId: doc.installationId };
                }
            },
            bridgeKeyStep,
            {
                name: 'issue-setup-session',
                run(_record, ctx) {
                    ctx.scratch.session = ctx.sessions.issue({ kind: 'setup' });
                    return { expiresAt: ctx.scratch.session.expiresAt };
                }
            }
        ],
        result: (scratch) => ({ installationId: scratch.installationId, session: scratch.session })
    };
}

const SESSION_VIA = ['local', 'bridge', 'setup', 'recovery'];
const MANAGED_KEYS = new Set(['label', 'replaceUnreadable', 'candidateId', 'roots', 'layout', 'keepUpdater', 'database', 'update']);

/**
 * `adopt` has two forms. With only a label it is the #323 recovery adoption:
 * a version 1 record, nothing else. With `candidateId` (a discovery id) or
 * `roots.code` it adopts one discovered instance: the record gains the
 * layout, roots and owned parts of the install model (version 2), and the
 * updater that would also update the instance is reconciled so two updaters
 * cannot mutate it. Adoption never moves a file and never opens or changes
 * the database. documentation/manager_install.md.
 */
function createAdoptKind({ settings = null, fs = nodeFs, now = () => new Date(), logger = console } = {}) {
    const keys = new Set(['label', 'replaceUnreadable']);
    const usable = (status) => status === 'missing';
    let cached = null;
    const install = () => {
        if (!cached) {
            const parse = require('../../install/engine');
            cached = { parse, core: parse.createInstallCore({ settings, fs, now, logger }) };
        }
        return cached;
    };

    async function planManaged(input, ctx) {
        const { parse, core } = install();
        const model = require('../../install/model');
        const preflight = require('../../install/preflight');
        const release = require('../../install/release');
        parse.exactKeys(input, MANAGED_KEYS);
        const label = parseLabel(input, MANAGED_KEYS);
        const replace = parse.parseBoolean(input.replaceUnreadable, 'replaceUnreadable', false);
        const keepUpdater = parse.parseBoolean(input.keepUpdater, 'keepUpdater', false);
        const updatePolicy = require('../../update/policy').fromAnswer(input.update);
        const given = parse.parseRootsInput(input.roots);
        if (input.candidateId !== undefined && typeof input.candidateId !== 'string') throw new ManagerError(400, 'INVALID_INPUT', '"candidateId" must be a discovery id.');
        if (input.candidateId === undefined && !given.code) throw new ManagerError(400, 'INVALID_INPUT', 'Name the instance to adopt: "candidateId" from discovery, or "roots.code".');

        const found = core.deps.discover({ fs, home: core.deps.home, env: core.env, searchRoots: given.code ? [given.code] : [] });
        const candidate = input.candidateId !== undefined
            ? found.candidates.find(item => item.id === input.candidateId)
            : found.candidates.find(item => item.roots.code === given.code);
        if (!candidate) {
            throw new ManagerError(404, input.candidateId !== undefined ? 'CANDIDATE_NOT_FOUND' : 'NOT_AN_INSTALLATION', 'No existing installation matches; discovery found nothing to adopt there.');
        }
        const roots = core.resolveRoots({ ...given, code: candidate.roots.code });
        const layout = parse.parseLayout(input.layout, candidate.layout);
        const database = parse.parseDatabase(input.database, settings);

        const current = ctx.store.readInstallation();
        let existing = null;
        if (current.status === 'ok') {
            existing = core.ownedInstall(ctx, { requireManaged: false });
            if (model.isManaged(existing)) throw new ManagerError(409, 'ALREADY_INSTALLED', 'The manager store already holds an installation with roots.');
        } else if (current.status !== 'missing' && !replace) {
            throw new ManagerError(409, 'ADOPT_NEEDS_CONFIRMATION', 'installation.json exists but cannot be used. Adopting sets it aside (renamed, never deleted); send "replaceUnreadable": true to confirm.', { storeFile: current.status });
        }

        const reconcile = parse.updaters.analyse({ updaters: candidate.updaters, codeRoot: candidate.roots.code, fs, keep: keepUpdater });
        const services = candidate.services.filter(item => item.kind !== 'none');
        const payload = candidate.evidence.includes('PAYLOAD_CURRENT') ? core.inspectCurrent(candidate.roots.code, {}, { hash: false }) : null;
        const manifest = payload && payload.present ? (() => { try { return release.loadManifest(path.join(candidate.roots.code, 'current'), fs).manifest; } catch { return null; } })() : null;
        const pre = await preflight.runPreflight({
            kind: 'adopt', roots, layout, settings, manifest, features: payload && payload.features ? payload.features.filter(id => id !== 'core') : [], database,
            env: core.env, fs, probePort: core.deps.probePort, home: core.deps.home, includeManagerPort: false
        });
        for (const mechanism of reconcile.conflicts) {
            pre.findings.push({ code: 'UPDATER_CONFLICT', severity: 'block', detail: `${mechanism} would also update this installation and cannot be disabled by the manager` });
        }
        pre.ok = !pre.findings.some(item => item.severity === 'block');

        const releaseSection = payload && payload.healthy ? { releaseId: payload.releaseId, version: payload.version, target: payload.target, features: payload.features } : null;
        const steps = ['preflight', 'set-aside', 'reconcile-updater', 'create-installation', 'create-bridge-key']
            .map(name => (name === 'reconcile-updater' && reconcile.items.some(item => item.action.startsWith('privileged:')) ? { name, privileged: 'updater.disable' } : { name }));
        const target = {
            candidateId: candidate.id,
            kind: candidate.kind,
            layout,
            roots,
            database,
            services,
            release: releaseSection,
            evidence: candidate.evidence,
            updater: keepUpdater ? candidate.updater : { kind: 'manager' },
            ...(updatePolicy ? { update: updatePolicy } : {})
        };
        const plan = {
            action: 'adopt-instance',
            managed: true,
            storeFile: current.status,
            setAside: current.status !== 'ok' && !usable(current.status),
            attach: Boolean(existing),
            ownerLabel: 'provided',
            target,
            updaterReconcile: reconcile.items,
            keepUpdater,
            downloads: [],
            retainedData: { roots: ['data', 'config', 'managerStore'] },
            privilegedSteps: steps.filter(item => item.privileged).map(item => (core.privilegedAvailable(item.privileged)
                ? { step: item.name, operation: item.privileged, status: 'needs-elevation', reason: 'ELEVATION_REQUIRED' }
                : { step: item.name, operation: item.privileged, status: 'deferred', reason: 'NOT_IMPLEMENTED' })),
            moves: [],
            stateDigest: core.signatureOf({ status: current.status, revision: existing ? existing.revision : null, candidate: candidate.id }),
            steps,
            preflight: pre
        };
        return { plan, pre, revision: existing ? existing.revision : null, privateInput: { label, raw: input, reconcileItems: reconcile.items } };
    }

    function managedPreflight(record, ctx) {
        const { core } = install();
        return core.step('preflight', async () => {
            const again = await planManaged(ctx.input.raw, ctx);
            if (!again.pre.ok) throw adoptRefusal(again.pre);
            return {};
        }).run(record, ctx);
    }

    function managedReconcile(record, ctx) {
        const { parse, core } = install();
        return core.step('reconcile-updater', async () => {
            const items = ctx.input.reconcileItems;
            if (!items.length) return { status: 'skipped', code: 'NO_UPDATER' };
            const runPrivileged = core.privilegedAvailable('updater.disable')
                ? (operation, input) => core.runPrivileged(operation, input, { record, ctx })
                : null;
            const outcomes = await parse.updaters.reconcile({ items, codeRoot: record.plan.target.roots.code, readCrontab: core.deps.readCrontab, writeCrontab: core.deps.writeCrontab, runPrivileged });
            const deferred = outcomes.find(item => item.status === 'deferred');
            return { status: deferred ? 'deferred' : 'done', code: deferred ? deferred.code : undefined, detail: { outcomes: outcomes.map(item => ({ mechanism: item.mechanism, status: item.status })) } };
        }).run(record, ctx);
    }

    function managedCreate(record, ctx) {
        const { core } = install();
        const model = require('../../install/model');
        return core.step('create-installation', () => {
            const t = record.plan.target;
            const fields = {
                layout: t.layout,
                roots: t.roots,
                runtimeUser: null,
                owned: { files: model.ownedFiles({ origin: 'adopt', roots: t.roots }), services: t.services, dependencies: [] },
                updater: t.updater,
                release: t.release,
                database: t.database,
                ...(t.update ? { update: t.update } : {})
            };
            const current = ctx.store.readInstallation();
            let doc;
            if (current.status === 'ok') {
                doc = ctx.store.updateInstallation(draft => ({ ...draft, ...fields }), { expectedRevision: record.revision });
            } else {
                doc = ctx.store.createInstallation({ origin: 'adopt', ownerLabel: ctx.input.label, install: fields });
            }
            ctx.scratch.installationId = doc.installationId;
            tombstoneModule().removeTombstone(settings.storeDir, fs);
            return { detail: { attached: record.plan.attach } };
        }).run(record, ctx);
    }

    function adoptRefusal(pre) {
        const blocks = pre.findings.filter(item => item.severity === 'block');
        const code = blocks.some(item => item.code === 'UPDATER_CONFLICT') ? 'UPDATER_CONFLICT' : 'PREFLIGHT_FAILED';
        return new ManagerError(409, code, `Preflight found problems that stop this adoption: ${[...new Set(blocks.map(item => item.code))].join(', ')}.`,
            { findings: blocks.map(item => ({ code: item.code, detail: item.detail })) });
    }

    const setAside = {
        name: 'set-aside',
        run(record, ctx) {
            if (!record.plan.setAside) return { skipped: true };
            return { keptAs: ctx.store.moveAside(ctx.store.paths.installation) };
        }
    };

    const createStep = {
        name: 'create-installation',
        run(record, ctx) {
            if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
            if (record.plan.managed) return managedCreate(record, ctx);
            const doc = ctx.store.createInstallation({ origin: 'adopt', ownerLabel: ctx.input.label });
            ctx.scratch.installationId = doc.installationId;
            return { installationId: doc.installationId };
        }
    };

    return {
        kind: 'adopt',
        public: true,
        allowed(state, via) {
            if (state.state === 'recovery') return via === 'recovery' || via === 'local';
            if (state.state === 'unclaimed') return via === 'local';
            return SESSION_VIA.includes(via);
        },
        async plan(input, ctx) {
            const managed = files.isPlainObject(input) && (input.candidateId !== undefined || input.roots !== undefined);
            if (managed) {
                if (!settings) throw new ManagerError(409, 'NOT_AVAILABLE', 'Adopting a discovered instance is not available here.');
                const built = await planManaged(input, ctx);
                return { plan: built.plan, revision: built.revision, privateInput: built.privateInput };
            }
            const label = parseLabel(input, keys);
            if (input.replaceUnreadable !== undefined && typeof input.replaceUnreadable !== 'boolean') {
                throw new ManagerError(400, 'INVALID_INPUT', '"replaceUnreadable" must be true or false.');
            }
            const replace = input.replaceUnreadable === true;
            const current = ctx.store.readInstallation();
            if (current.status === 'ok') {
                throw new ManagerError(409, 'ALREADY_INSTALLED', 'The manager store already holds a usable installation.');
            }
            if (!usable(current.status) && !replace) {
                throw new ManagerError(409, 'ADOPT_NEEDS_CONFIRMATION',
                    'installation.json exists but cannot be used. Adopting sets it aside (renamed, never deleted); '
                    + 'send "replaceUnreadable": true to confirm.', { storeFile: current.status });
            }
            if (current.status === 'missing' && ctx.evidence().length === 0 && !(settings && tombstoneStateOf(settings, fs).present)) {
                throw new ManagerError(409, 'NOTHING_TO_ADOPT', 'There is no existing installation to adopt here.');
            }
            return {
                plan: {
                    action: 'adopt-existing-installation',
                    storeFile: current.status,
                    setAside: !usable(current.status),
                    ownerLabel: 'provided',
                    evidence: ctx.evidence()
                },
                revision: null,
                privateInput: { label }
            };
        },
        async validate(record, ctx) {
            if (record.plan.managed) {
                if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
                const again = await planManaged(ctx.input.raw, ctx);
                if (again.plan.stateDigest !== record.plan.stateDigest) throw new ManagerError(409, 'REVISION_CONFLICT', 'The manager store changed since this plan was made; plan again.');
                if (!again.pre.ok) throw adoptRefusal(again.pre);
                return;
            }
            const current = ctx.store.readInstallation();
            if (current.status === 'ok') throw new ManagerError(409, 'ALREADY_INSTALLED', 'The manager store already holds a usable installation.');
            if (current.status !== record.plan.storeFile) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The manager store changed since this plan was made; plan again.');
            }
        },
        steps: [
            { name: 'preflight', run: (record, ctx) => (record.plan.managed ? managedPreflight(record, ctx) : { skipped: true }) },
            setAside,
            { name: 'reconcile-updater', run: (record, ctx) => (record.plan.managed ? managedReconcile(record, ctx) : { skipped: true }) },
            createStep,
            bridgeKeyStep
        ],
        result: (scratch) => ({ installationId: scratch.installationId })
    };
}

function tombstoneModule() {
    return require('../../install/tombstone');
}

function tombstoneStateOf(settings, fs) {
    return tombstoneModule().readTombstone(settings.storeDir, fs);
}

function createRecoveryUnlockKind() {
    return {
        kind: 'recovery.unlock',
        public: false,
        allowed: (state, via) => (state.state === 'claimed' || state.state === 'recovery') && via === 'recovery-credential',
        plan(input) {
            if (input !== undefined && (!files.isPlainObject(input) || Object.keys(input).length > 0)) {
                throw new ManagerError(400, 'INVALID_INPUT', 'recovery.unlock takes no input.');
            }
            return { plan: { action: 'issue-recovery-session' }, revision: null };
        },
        steps: [
            {
                name: 'issue-recovery-session',
                run(_record, ctx) {
                    ctx.scratch.session = ctx.sessions.issue({ kind: 'recovery' });
                    return { expiresAt: ctx.scratch.session.expiresAt };
                }
            }
        ],
        result: (scratch) => ({ session: scratch.session })
    };
}

module.exports = { createClaimKind, createAdoptKind, createRecoveryUnlockKind, LABEL_SHAPE };
