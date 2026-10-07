/**
 * The setup engine's operation kinds (documentation/manager_install.md):
 *
 *   install.new          a fresh install from a verified local payload
 *   install.reconfigure  change the layout, the code/cache/logs/uploads roots
 *                        or settings of an owned installation
 *   install.repair       put the recorded release back at the recorded roots
 *   install.uninstall    remove the owned code (and, only when asked and
 *                        confirmed, the owned data roots)
 *
 * They are public: the setup pages and the portal's Host room plan them over
 * HTTP (documentation/manager_install.md "Over HTTP"). They take paths, so a
 * caller that is not `local` (the command line) is held to the allowed bases
 * (install/paths.js `allowedBases`, finding ROOT_OUTSIDE_ALLOWED_BASES), and
 * an anonymous caller never reaches them: `allowed` admits only a local
 * command, a portal assertion, or a setup/recovery session.
 *
 * Every step verifies what it finds before it acts, records one of
 * `done|skipped|failed|deferred` in the operation record's `progress`
 * ledger, and can run again after an interruption. Planning the same input
 * again after a failure resumes: finished steps skip, the rest run. The
 * privileged steps (service registration, unregistration) go through the
 * closed list in ../../privileged.js, answer 501 today, and are recorded as
 * `deferred`.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { ManagerError } = require('../../errors');
const files = require('../../store/files');
const model = require('../../install/model');
const paths = require('../../install/paths');
const release = require('../../install/release');
const tombstone = require('../../install/tombstone');
const environment = require('../../environment');
const databaseInstall = require('../../database/installAnswer');
const databaseInput = require('../../database/input');
const registry = require('../../lifecycle/registry');
const { runPreflight, portsFor } = require('../../install/preflight');
const parse = require('../../install/engine');
const dockerService = require('../../docker/service');
const dockerPasswords = require('../../docker/passwords');
const dockerState = require('../../docker/state');
const { createServiceLifecycle } = require('../../platform/serviceLifecycle');

const { createInstallCore, exactKeys, textField, absolutePath, parseLabel, parseFeatures, parseRootsInput, parseLayout, parseRelease, parseRuntimeUser, parseBoolean, parseConfigChanges, parseDatabase } = parse;

const SESSION_VIA = ['local', 'bridge', 'setup', 'recovery'];
const NEW_STEPS = ['preflight', 'stage', 'verify', 'ownership', 'docker-postgres', 'init-db', 'write-config', 'write-features', 'activate', 'finalize', 'register-service'];
const RECONFIGURE_STEPS = ['preflight', 'stage', 'verify', 'write-config', 'activate', 'record', 'retire-old', 'register-service'];
const REPAIR_STEPS = ['preflight', 'stage', 'verify', 'init-db', 'write-features', 'activate', 'register-service'];
const UNINSTALL_STEPS = ['preflight', 'unregister-service', 'tombstone', 'docker-postgres', 'remove-code', 'remove-data', 'remove-ownership'];
const PRIVILEGED_BY_STEP = Object.freeze({ 'register-service': 'service.register', 'unregister-service': 'service.unregister' });

const sameList = (a, b) => JSON.stringify([...(a || [])]) === JSON.stringify([...(b || [])]);

/** What the preflight shows of the Docker database: facts and findings, never an environment value or a secret. */
function dockerPlanView(view) {
    return { names: view.names, mode: view.mode, request: view.request, port: view.port, storage: view.storage, image: view.image, backupTools: view.backupTools ? { ok: view.backupTools.ok, code: view.backupTools.code, version: view.backupTools.version } : null, findings: view.findings };
}

function dockerFindings(view) {
    return view.findings
        .filter(item => item.severity === 'block' || item.severity === 'warn')
        .map(item => ({ code: item.code.startsWith('DOCKER_') ? item.code : `DOCKER_${item.code}`, severity: item.severity, detail: item.remedy ? `${item.detail} ${item.remedy}` : item.detail }));
}

function stepList(names) {
    return names.map(name => (PRIVILEGED_BY_STEP[name] ? { name, privileged: PRIVILEGED_BY_STEP[name] } : { name }));
}

function createInstallKinds({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const core = createInstallCore({ settings, fs, now, logger });
    const { deps } = core;
    const serviceSteps = createServiceLifecycle({ core, settings, fs, now, kinds: core.serviceKinds });
    const isRoot = () => typeof process.geteuid === 'function' && process.geteuid() === 0;
    const stageLib = () => core.stage();

    // ------------------------------------------------------------- helpers
    const needInput = (ctx) => {
        if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
        return ctx.input;
    };

    const tombstoneState = () => tombstone.readTombstone(settings.storeDir, fs);

    function failedPreflight(pre) {
        const blocks = pre.findings.filter(item => item.severity === 'block');
        return new ManagerError(409, 'PREFLIGHT_FAILED', `Preflight found ${blocks.length} problem${blocks.length === 1 ? '' : 's'} that stop this operation: ${[...new Set(blocks.map(item => item.code))].join(', ')}.`,
            { findings: blocks.map(item => ({ code: item.code, detail: item.detail })) });
    }

    /** Read a source's manifest and, with `releaseInput`, check its signature and structure (sizes only; staging hashes). */
    function sourceInfo(sourceDir, releaseInput = null) {
        const loaded = release.loadManifest(sourceDir, fs);
        if (releaseInput) {
            try {
                stageLib().verifyPayload(loaded.dir, { ...release.verifyOptions(releaseInput, fs), hash: false });
            } catch (error) {
                throw release.mapPayloadError(error) || error;
            }
        }
        try {
            return { ...loaded, selection: stageLib().readSelection(loaded.dir) };
        } catch (error) {
            throw release.mapPayloadError(error) || error;
        }
    }

    function currentManifest(codeRoot) {
        try {
            return release.loadManifest(path.join(codeRoot, 'current'), fs).manifest;
        } catch {
            return null;
        }
    }

    function dependenciesFor(manifest, selected) {
        return [...core.systemDependencies(manifest, selected), ...core.exclusiveDependencies(manifest, selected)].slice(0, 96);
    }

    /** What the plan says will need elevation: honest about a platform with no helper yet. */
    function privilegedPlan(steps, { createUser = false } = {}) {
        const out = [];
        for (const item of steps.filter(entry => entry.privileged)) {
            if (item.name === 'register-service' && createUser) out.push(planned('register-service', 'user.create'));
            out.push(planned(item.name, item.privileged));
        }
        return out;
    }

    function planned(step, operation) {
        return core.privilegedAvailable(operation)
            ? { step, operation, status: 'needs-elevation', reason: 'ELEVATION_REQUIRED' }
            : { step, operation, status: 'deferred', reason: 'NOT_IMPLEMENTED' };
    }

    function describeServices(doc, { unregister }) {
        const out = [];
        const unknown = [];
        for (const service of doc.owned.services) {
            if (service.registeredBy === 'installer') out.push({ kind: service.kind, name: service.name, action: unregister ? 'unregister' : 'register', privileged: unregister ? 'service.unregister' : 'service.register' });
            else if (service.registeredBy === 'unknown') unknown.push({ kind: service.kind, name: service.name });
            else out.push({ kind: service.kind, name: service.name, action: 'leave', reason: `registered by ${service.registeredBy}, not by the installer` });
        }
        return { services: out, unknown };
    }

    function ledgerMatch(plan, kind, ctx, signature) {
        const interrupted = core.findInterrupted(ctx, kind, signature);
        if (interrupted) plan.resumeOf = { operationId: interrupted.id, resumeFrom: interrupted.resumeFrom, error: interrupted.error };
    }

    /** One revalidation for every kind: plan again from the held input and compare. */
    function revalidator(build) {
        return async function validate(record, ctx) {
            const input = needInput(ctx);
            const again = await build(input.raw, ctx, { forValidate: true });
            if (again.plan.stateDigest !== record.plan.stateDigest) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since this plan was made; plan again.');
            }
            if (!again.pre.ok) throw failedPreflight(again.pre);
            if (again.plan.confirmation && again.plan.confirmation.required && !again.plan.confirmation.satisfied) {
                throw new ManagerError(400, 'CONFIRMATION_REQUIRED', 'Deleting data needs "confirm" to be the installation id; nothing was removed.');
            }
            if (again.unknownServices && again.unknownServices.length) {
                throw new ManagerError(409, 'UNKNOWN_SERVICE_OWNER', 'A service in the record was not registered by the installer; the manager never touches it. Pass acknowledgeUnknownServices to leave it in place.', { services: again.unknownServices });
            }
        };
    }

    function finish(plan, pre, extras = {}) {
        return { plan: { ...plan, preflight: pre }, pre, ...extras };
    }

    function ownedRecord(ctx) {
        const doc = core.ownedInstall(ctx);
        core.assertRecordPaths(doc);
        return doc;
    }

    // ------------------------------------------------------ install.new
    function parseNew(input) {
        exactKeys(input, new Set(['ownerLabel', 'source', 'features', 'layout', 'roots', 'database', 'release', 'runtimeUser', 'createRuntimeUser', 'config', 'registerService']));
        const config = parseConfigChanges(input.config);
        const databaseAnswer = databaseInstall.parseNewDatabase(input.database, settings, parseDatabase);
        return {
            label: input.ownerLabel === undefined ? 'Goobster' : parseLabel(input.ownerLabel),
            source: absolutePath(input.source, 'source'),
            features: input.features === undefined ? null : parseFeatures(input.features),
            layout: parseLayout(input.layout, 'lite'),
            roots: parseRootsInput(input.roots),
            database: databaseAnswer.database,
            connection: databaseAnswer.connection,
            docker: databaseAnswer.docker,
            release: parseRelease(input.release),
            runtimeUser: parseRuntimeUser(input.runtimeUser),
            createRuntimeUser: parseBoolean(input.createRuntimeUser, 'createRuntimeUser', false),
            changes: config.changes,
            secrets: config.secrets,
            registerService: parseBoolean(input.registerService, 'registerService', true)
        };
    }

    async function buildNew(input, ctx) {
        const parsed = parseNew(input);
        const roots = core.resolveRoots(parsed.roots);
        const tomb = tombstoneState();
        const read = ctx.store.readInstallation();
        let existing = null;
        if (read.status === 'ok') {
            existing = core.ownedInstall(ctx, { requireManaged: false });
        } else if (read.status !== 'missing') {
            throw new ManagerError(409, 'STORE_UNUSABLE', 'installation.json exists but cannot be used; recover it with adopt before installing.');
        } else if (!tomb.present && ctx.evidence().some(item => item !== 'postgres-url')) {
            throw new ManagerError(409, 'EXISTING_INSTALLATION', 'An application installation already exists here; adopt it instead of installing over it.');
        }
        if (existing && model.isManaged(existing)) {
            const same = ['code', 'data', 'config', 'cache', 'logs', 'uploads', 'managerStore'].every(role => existing.roots[role] === roots[role]);
            if (!same || existing.layout !== parsed.layout) {
                throw new ManagerError(409, 'ALREADY_INSTALLED', 'This installation already exists with other roots or another layout; use install.reconfigure.');
            }
            if (existing.origin !== 'install') throw new ManagerError(409, 'ALREADY_INSTALLED', 'This installation was adopted, not installed by the manager; use install.repair or install.reconfigure.');
        }

        const info = sourceInfo(parsed.source, parsed.release);
        const asked = parsed.features || (info.selection ? info.selection.features : Object.keys(info.manifest.groups));
        const picked = release.selection(info.manifest, asked);
        const selected = picked.resolved.features;
        const releaseId = info.releaseId;

        const resumedRecord = Boolean(existing && model.isManaged(existing));
        const current = core.inspectCurrent(roots.code, parsed.release, { hash: false });
        const matches = Boolean(resumedRecord && existing.release && existing.release.releaseId === releaseId && sameList(existing.release.features, selected));
        const noop = Boolean(matches && current.healthy && current.releaseId === releaseId);

        const extraFindings = [];
        if (parsed.database.engine === 'sqlite' && settings.dbUrl) extraFindings.push({ code: 'DATABASE_MISMATCH', severity: 'block', detail: 'sqlite was chosen while GOOBSTER_DB_URL names a Postgres database' });
        const connection = parsed.connection ? await databaseInstall.probeForInstall({ settings, connection: parsed.connection }) : null;
        const dockerView = parsed.docker ? await dockerService.createDockerService({ settings, fs, now, logger }).assess({ installationId: existing ? existing.installationId : null, request: parsed.docker }) : null;
        const pre = await runPreflight({
            kind: resumedRecord ? 'install.repair' : 'install.new',
            roots,
            layout: parsed.layout,
            settings: connection || dockerView ? { ...settings, dbUrl: 'postgres://configured-in-the-answers' } : settings,
            manifest: info.manifest,
            features: asked,
            database: parsed.database,
            env: core.env,
            fs,
            probePort: deps.probePort,
            runtimeUser: parsed.runtimeUser,
            createRuntimeUser: parsed.createRuntimeUser,
            accountCreatable: core.serviceAccountCreatable(),
            registerService: parsed.registerService,
            unitNames: parsed.registerService && !resumedRecord ? core.unitNames() : [],
            home: deps.home,
            includeManagerPort: false,
            via: ctx.auth ? ctx.auth.via : 'local'
        });
        pre.findings.push(...extraFindings, ...(connection ? connection.findings : []), ...(dockerView ? dockerFindings(dockerView) : []));
        pre.ok = !pre.findings.some(item => item.severity === 'block');

        const dependencies = dependenciesFor(info.manifest, selected);
        const steps = stepList(NEW_STEPS);
        const target = {
            layout: parsed.layout,
            roots,
            database: parsed.database,
            features: selected,
            release: core.releaseSection(info.manifest, selected),
            dependencies,
            runtimeUser: parsed.runtimeUser,
            createRuntimeUser: parsed.createRuntimeUser
        };
        const signature = core.signatureOf({ kind: 'install.new', roots, layout: parsed.layout, releaseId, features: selected, database: parsed.database, databaseTarget: parsed.connection ? databaseInput.publicView(parsed.connection) : null, dockerDatabase: parsed.docker ? dockerService.publicRequest(parsed.docker) : null, configIds: parsed.changes.map(item => item.id), register: parsed.registerService, runtimeUser: parsed.runtimeUser, createUser: parsed.createRuntimeUser });
        const plan = {
            action: 'install-new',
            signature,
            stateDigest: core.signatureOf({ revision: existing ? existing.revision : null, current: current.releaseId || null, healthy: current.healthy || false, tombstone: tomb.present }),
            noop,
            target,
            source: { kind: 'local-directory', bytes: picked.bytes, files: picked.files },
            downloads: [],
            downloadHook: release.DOWNLOAD_HOOK,
            config: { settings: parsed.changes.map(item => item.id), secretCount: Object.keys(parsed.secrets).length },
            ...(parsed.connection ? { databaseTarget: databaseInput.publicView(parsed.connection) } : {}),
            ...(dockerView ? { dockerDatabase: dockerPlanView(dockerView) } : {}),
            services: parsed.registerService ? [{ kind: core.serviceKindForHost(), name: 'goobster', action: 'register', privileged: 'service.register' }] : [],
            registerService: parsed.registerService,
            updater: { kind: 'manager' },
            retainedData: { existing: Boolean(tomb.present && !tomb.doc?.dataRemoved), roots: [] },
            reusesTombstone: tomb.present,
            privilegedSteps: privilegedPlan(parsed.registerService ? steps : steps.filter(item => item.name !== 'register-service'), { createUser: parsed.createRuntimeUser && Boolean(parsed.runtimeUser) }),
            steps
        };
        ledgerMatch(plan, 'install.new', ctx, signature);
        return finish(plan, pre, { privateInput: { raw: input, parsed } });
    }

    function newKind() {
        return {
            kind: 'install.new',
            public: true,
            allowed(state, via) {
                if (state.state === 'unclaimed') return via === 'local';
                if (state.state === 'recovery') return via === 'local' || via === 'recovery';
                return SESSION_VIA.includes(via);
            },
            async plan(input, ctx) {
                const built = await buildNew(input, ctx);
                return { plan: built.plan, revision: null, privateInput: built.privateInput };
            },
            validate: revalidator(buildNew),
            steps: [
                core.step('preflight', async (record, ctx) => {
                    const again = await buildNew(needInput(ctx).raw, ctx);
                    if (!again.pre.ok) throw failedPreflight(again.pre);
                    return { detail: { warnings: again.pre.findings.filter(item => item.severity === 'warn').length } };
                }),
                stageStep('stage'),
                verifyStep('verify'),
                core.step('ownership', (record, ctx) => {
                    const t = record.plan.target;
                    const input = needInput(ctx).parsed;
                    const read = ctx.store.readInstallation();
                    let doc;
                    let created = false;
                    if (read.status === 'ok') {
                        doc = core.ownedInstall(ctx, { requireManaged: false });
                        if (model.isManaged(doc)) {
                            if (!['code', 'data', 'config', 'cache', 'logs', 'uploads', 'managerStore'].every(role => doc.roots[role] === t.roots[role])) {
                                throw new ManagerError(409, 'ALREADY_INSTALLED', 'The installation record names other roots.');
                            }
                        } else {
                            doc = ctx.store.updateInstallation(draft => ({ ...draft, ...installFields(t, 'install') }), { expectedRevision: doc.revision });
                            created = true;
                        }
                    } else {
                        doc = ctx.store.createInstallation({ ownerLabel: input.label, origin: 'install', install: installFields(t, 'install') });
                        created = true;
                    }
                    ctx.scratch.installationId = doc.installationId;
                    ctx.bridge.ensureKey(doc.installationId);
                    const cleared = tombstone.removeTombstone(settings.storeDir, fs);
                    if (!created && !cleared) return { status: 'skipped', code: 'ALREADY_DONE' };
                    return { detail: { created, tombstoneCleared: cleared } };
                }),
                core.step('docker-postgres', async (record, ctx) => {
                    const answered = needInput(ctx).parsed;
                    if (!answered.docker) return { status: 'skipped', code: 'NOT_REQUESTED' };
                    const svc = dockerService.createDockerService({ settings, fs, now, logger });
                    const secret = dockerPasswords.generatePair();
                    const view = await svc.assess({ installationId: ctx.scratch.installationId, request: answered.docker });
                    svc.assertAssessed(view);
                    const created = await svc.createResources({ installationId: ctx.scratch.installationId, request: answered.docker, superuserPassword: secret.superuser, operationId: record.id, view });
                    await svc.waitHealthy({ installationId: ctx.scratch.installationId });
                    const out = await svc.provisionRole({ request: answered.docker, passwords: secret });
                    ctx.scratch.dockerConnection = out.application;
                    return { detail: { container: view.names.container, volume: view.names.volume, network: view.names.network, cleaned: created.cleaned.length, done: out.results.filter(item => item.status === 'done').length } };
                }),
                core.step('init-db', async (record, ctx) => {
                    const t = record.plan.target;
                    const answered = needInput(ctx).parsed.connection || ctx.scratch.dockerConnection;
                    if (!answered) {
                        const out = await deps.initDatabase({ roots: t.roots, settings, database: t.database });
                        return { detail: { engine: out.engine, tables: out.tables } };
                    }
                    const probed = await databaseInstall.probeForInstall({ settings, connection: answered });
                    const blocked = probed.findings.filter(item => item.severity === 'block');
                    if (blocked.length > 0) throw new ManagerError(409, 'PREFLIGHT_FAILED', `The database cannot be used: ${blocked.map(item => item.code).join(', ')}.`, { findings: blocked.map(item => ({ code: item.code, detail: item.detail })) });
                    const out = await deps.initDatabase({ roots: t.roots, settings, database: t.database, url: probed.url });
                    databaseInstall.persistOverlay({ settings, fs, now, url: probed.url });
                    if (ctx.scratch.dockerConnection) {
                        const svc = dockerService.createDockerService({ settings, fs, now, logger });
                        svc.advance('schema');
                        await svc.verify({ application: ctx.scratch.dockerConnection });
                        svc.removeStaged();
                    }
                    return { detail: { engine: out.engine, tables: out.tables, overlay: true } };
                }),
                core.step('write-config', (record, ctx) => {
                    const t = record.plan.target;
                    const input = needInput(ctx).parsed;
                    return core.writeConfigStep({ configPath: t.roots.config, changes: input.changes, secrets: input.secrets, layout: t.layout });
                }),
                core.step('write-features', (record) => core.writeFeaturesStep({ dataDir: record.plan.target.roots.data, selected: record.plan.target.features })),
                activateStep('activate'),
                core.step('finalize', (record, ctx) => {
                    const t = record.plan.target;
                    const doc = ctx.store.readInstallation().doc;
                    const done = doc.release && doc.release.releaseId === t.release.releaseId && sameList(doc.release.features, t.features) && doc.updater && doc.updater.kind === 'manager';
                    if (done) return { status: 'skipped', code: 'ALREADY_DONE' };
                    ctx.store.updateInstallation(draft => ({ ...draft, release: t.release, updater: { kind: 'manager' }, owned: { ...draft.owned, dependencies: t.dependencies } }));
                    return { detail: { releaseId: t.release.releaseId } };
                }),
                core.step('register-service', (record, ctx) => serviceSteps.register(record, ctx, { enabled: record.plan.registerService }))
            ],
            result: (scratch) => ({ installationId: scratch.installationId, restartRequired: false, ...(scratch.service ? { service: scratch.service } : {}) })
        };
    }

    function installFields(target, origin) {
        return {
            layout: target.layout,
            roots: target.roots,
            runtimeUser: target.runtimeUser || null,
            owned: { files: model.ownedFiles({ origin, roots: target.roots }), services: [], dependencies: target.dependencies || [] },
            updater: { kind: 'manager' },
            release: null,
            database: target.database
        };
    }

    // The three payload steps are shared by install.new, reconfigure and repair.
    function stageStep(name) {
        return core.step(name, (record, ctx) => {
            const t = record.plan.target;
            const input = needInput(ctx).parsed;
            const codeRoot = (record.plan.stageRoot) || t.roots.code;
            if (!t.release) return { status: 'skipped', code: 'NOT_APPLICABLE' };
            stageLib().recoverInstall(codeRoot);
            const cur = core.inspectCurrent(codeRoot, input.release);
            if (cur.healthy && cur.releaseId === t.release.releaseId && sameList(cur.features, t.features)) return { status: 'skipped', code: 'CURRENT_OK' };
            const options = release.verifyOptions(input.release, fs);
            const ready = core.findReadyStage(codeRoot, t.release.releaseId, t.features, options);
            if (ready) {
                ctx.scratch.stagingDir = ready.dir;
                return { status: 'skipped', code: 'ALREADY_STAGED' };
            }
            const sources = input.sources || input.source;
            const staged = core.stageSelectionInto({ sources, codeRoot, features: t.features, profile: null, options, ctx });
            ctx.scratch.stagingDir = staged.stagingDir;
            return { detail: { files: staged.files, bytes: staged.bytes } };
        });
    }

    function verifyStep(name) {
        return core.step(name, (record, ctx) => {
            const input = needInput(ctx).parsed;
            const dir = ctx.scratch.stagingDir;
            if (!dir) return { status: 'skipped', code: 'CURRENT_OK' };
            try {
                const result = stageLib().verifyPayload(dir, release.verifyOptions(input.release, fs));
                return { detail: { files: result.files, bytes: result.bytes } };
            } catch (error) {
                throw release.mapPayloadError(error) || error;
            }
        });
    }

    function activateStep(name) {
        return core.step(name, (record, ctx) => {
            const t = record.plan.target;
            const input = needInput(ctx).parsed;
            const codeRoot = record.plan.stageRoot || t.roots.code;
            if (!t.release) return { status: 'skipped', code: 'NOT_APPLICABLE' };
            const cur = core.inspectCurrent(codeRoot, input.release, { hash: false });
            if (cur.healthy && cur.releaseId === t.release.releaseId && sameList(cur.features, t.features) && !ctx.scratch.stagingDir) return { status: 'skipped', code: 'CURRENT_OK' };
            const options = release.verifyOptions(input.release, fs);
            const dir = ctx.scratch.stagingDir || (core.findReadyStage(codeRoot, t.release.releaseId, t.features, options) || {}).dir;
            if (!dir) throw new ManagerError(409, 'NOTHING_STAGED', 'There is no verified staged payload to activate; run the operation again.');
            try {
                stageLib().activate(dir, codeRoot, options);
            } catch (error) {
                throw release.mapPayloadError(error) || error;
            }
            return { detail: { releaseId: t.release.releaseId } };
        });
    }

    // ------------------------------------------------ install.reconfigure
    async function buildReconfigure(input, ctx) {
        exactKeys(input, new Set(['layout', 'roots', 'source', 'release', 'config']));
        const doc = ownedRecord(ctx);
        const given = parseRootsInput(input.roots);
        const config = parseConfigChanges(input.config);
        const layout = parseLayout(input.layout, doc.layout);
        const parsedRelease = parseRelease(input.release);
        const roots = { ...doc.roots, ...given };
        for (const role of ['data', 'config', 'managerStore']) {
            if (roots[role] !== doc.roots[role]) {
                throw new ManagerError(400, 'ROOT_NOT_MOVABLE', `The ${role} root cannot be moved by reconfigure; moving data belongs to backup and restore.`);
            }
        }
        const codeMoved = roots.code !== doc.roots.code;
        if (codeMoved && !doc.release) throw new ManagerError(400, 'ROOT_NOT_MOVABLE', 'An adopted source checkout is not moved by reconfigure.');
        const rootsChanged = ['code', 'cache', 'logs', 'uploads'].some(role => roots[role] !== doc.roots[role]);
        const layoutChanged = layout !== doc.layout;
        const changed = rootsChanged || layoutChanged || config.changes.length > 0;

        let sourceDir = null;
        let manifest = null;
        let selected = doc.release ? doc.release.features : [];
        if (codeMoved) {
            sourceDir = input.source !== undefined ? absolutePath(input.source, 'source') : path.join(doc.roots.code, 'current');
            const info = sourceInfo(sourceDir, parsedRelease);
            manifest = info.manifest;
            if (info.releaseId !== doc.release.releaseId) throw new ManagerError(409, 'RELEASE_MISMATCH', 'The source is not the release recorded for this installation.');
        } else if (doc.release) {
            manifest = currentManifest(doc.roots.code);
        }
        const pre = await runPreflight({
            kind: 'install.reconfigure', roots, layout, settings, manifest, features: selected.filter(id => id !== 'core'), database: doc.database, env: core.env, fs,
            probePort: deps.probePort, runtimeUser: doc.runtimeUser, createRuntimeUser: Boolean(doc.runtimeUser) && isRoot(), accountCreatable: core.serviceAccountCreatable(), home: deps.home, includeManagerPort: false, via: ctx.auth ? ctx.auth.via : 'local'
        });
        const steps = stepList(RECONFIGURE_STEPS);
        const target = { layout, roots, database: doc.database, features: selected, release: doc.release, dependencies: doc.owned.dependencies, runtimeUser: doc.runtimeUser, createRuntimeUser: Boolean(doc.runtimeUser) && isRoot(), previousRoots: doc.roots };
        const signature = core.signatureOf({ kind: 'install.reconfigure', id: doc.installationId, roots, layout, configIds: config.changes.map(item => item.id) });
        const plan = {
            action: 'reconfigure',
            signature,
            stateDigest: core.signatureOf({ revision: doc.revision }),
            noop: !changed,
            target,
            stageRoot: codeMoved ? roots.code : null,
            source: codeMoved ? { kind: 'local-directory' } : null,
            downloads: [],
            downloadHook: release.DOWNLOAD_HOOK,
            changes: { roots: rootsChanged, layout: layoutChanged, config: config.changes.map(item => item.id) },
            services: describeServices(doc, { unregister: false }).services,
            retainedData: { roots: ['data', 'config', 'managerStore'] },
            privilegedSteps: privilegedPlan(rootsChanged || layoutChanged ? steps : []),
            steps,
            installationId: doc.installationId
        };
        ledgerMatch(plan, 'install.reconfigure', ctx, signature);
        return finish(plan, pre, { revision: doc.revision, privateInput: { raw: input, parsed: { source: sourceDir, sources: sourceDir, release: parsedRelease, changes: config.changes, secrets: config.secrets } } });
    }

    function reconfigureKind() {
        const moved = (t) => t.roots.code !== t.previousRoots.code;
        return {
            kind: 'install.reconfigure',
            public: true,
            allowed: (state, via) => state.state === 'claimed' && SESSION_VIA.includes(via),
            async plan(input, ctx) {
                const built = await buildReconfigure(input, ctx);
                return { plan: built.plan, revision: built.revision, privateInput: built.privateInput };
            },
            validate: revalidator(buildReconfigure),
            steps: [
                core.step('preflight', async (record, ctx) => {
                    const again = await buildReconfigure(needInput(ctx).raw, ctx);
                    if (!again.pre.ok) throw failedPreflight(again.pre);
                    return { detail: { warnings: again.pre.findings.filter(item => item.severity === 'warn').length } };
                }),
                gate(stageStep('stage'), moved),
                gate(verifyStep('verify'), moved),
                core.step('write-config', (record, ctx) => {
                    const t = record.plan.target;
                    const input = needInput(ctx).parsed;
                    return core.writeConfigStep({ configPath: t.roots.config, changes: input.changes, secrets: input.secrets, layout: t.layout });
                }),
                gate(activateStep('activate'), moved),
                core.step('record', (record, ctx) => {
                    const t = record.plan.target;
                    const doc = core.ownedInstall(ctx);
                    const same = model.ROOT_ROLES.every(role => doc.roots[role] === t.roots[role]) && doc.layout === t.layout;
                    if (same) return { status: 'skipped', code: 'ALREADY_DONE' };
                    ctx.store.updateInstallation(draft => ({
                        ...draft,
                        layout: t.layout,
                        roots: t.roots,
                        owned: { ...draft.owned, files: model.ownedFiles({ origin: draft.origin === 'adopt' ? 'adopt' : 'install', roots: t.roots }) }
                    }));
                    return { detail: { layout: t.layout } };
                }),
                core.step('retire-old', (record) => {
                    const t = record.plan.target;
                    if (!moved(t)) return { status: 'skipped', code: 'NOT_CHANGED' };
                    let removed = 0;
                    for (const dir of core.payloadRemovals(t.previousRoots)) {
                        if (core.removeOwnedPath(dir, t.previousRoots)) removed++;
                    }
                    paths.removeIfEmpty(t.previousRoots.code, fs);
                    return { detail: { removed } };
                }),
                core.step('register-service', (record, ctx) => {
                    const changed = record.plan.changes.roots || record.plan.changes.layout;
                    return serviceSteps.register(record, ctx, { enabled: changed && record.plan.services.some(item => item.action === 'register') });
                })
            ],
            result: (scratch) => ({ restartRequired: true, installationId: scratch.installationId, ...(scratch.service ? { service: scratch.service } : {}) })
        };
    }

    /** Skip a step with NOT_CHANGED when the operation does not touch what it is about. */
    function gate(stepSpec, applies) {
        return {
            name: stepSpec.name,
            async run(record, ctx) {
                if (applies(record.plan.target)) return stepSpec.run(record, ctx);
                const detail = await core.step(stepSpec.name, () => ({ status: 'skipped', code: 'NOT_CHANGED' })).run(record, ctx);
                return detail;
            }
        };
    }

    // ----------------------------------------------------- install.repair
    async function buildRepair(input, ctx) {
        exactKeys(input === undefined ? {} : input, new Set(['source', 'release']));
        const raw = input || {};
        const doc = ownedRecord(ctx);
        const parsedRelease = parseRelease(raw.release);
        const roots = doc.roots;
        const selected = doc.release ? doc.release.features : [];
        const { services, unknown } = describeServices(doc, { unregister: false });
        let current = { present: false, healthy: false };
        let manifest = null;
        let sources = [];
        let sourceDir = null;
        if (doc.release) {
            current = core.inspectCurrent(roots.code, parsedRelease, { hash: true });
            const intact = current.healthy && current.releaseId === doc.release.releaseId && sameList(current.features, doc.release.features);
            const candidates = [];
            if (raw.source !== undefined) candidates.push(absolutePath(raw.source, 'source'));
            candidates.push(path.join(roots.code, 'previous'), path.join(roots.code, 'releases', doc.release.releaseId));
            for (const candidate of candidates) {
                try {
                    const info = sourceInfo(candidate);
                    if (info.releaseId !== doc.release.releaseId) {
                        if (candidate === candidates[0] && raw.source !== undefined) throw new ManagerError(409, 'RELEASE_MISMATCH', 'The source is not the release recorded for this installation.');
                        continue;
                    }
                    try {
                        stageLib().verifyPayload(info.dir, release.verifyOptions(parsedRelease, fs));
                    } catch (error) {
                        throw release.mapPayloadError(error) || error;
                    }
                    sources.push(info.dir);
                    manifest = manifest || info.manifest;
                } catch (error) {
                    if (candidate === candidates[0] && raw.source !== undefined) throw error;
                }
            }
            if (!intact && sources.length === 0) {
                throw new ManagerError(409, 'REPAIR_SOURCE_REQUIRED', 'The recorded release is damaged and no copy of it is at hand; give "source": a verified payload directory of that release.');
            }
            sourceDir = sources[0] || null;
            if (!manifest) manifest = currentManifest(roots.code);
        }
        const pre = await runPreflight({
            kind: 'install.repair', roots, layout: doc.layout, settings, manifest, features: selected.filter(id => id !== 'core'), database: doc.database, env: core.env, fs,
            probePort: deps.probePort, runtimeUser: doc.runtimeUser, createRuntimeUser: Boolean(doc.runtimeUser) && isRoot(), accountCreatable: core.serviceAccountCreatable(), home: deps.home, includeManagerPort: false, via: ctx.auth ? ctx.auth.via : 'local'
        });
        const steps = stepList(REPAIR_STEPS);
        const target = { layout: doc.layout, roots, database: doc.database, features: selected, release: doc.release, dependencies: doc.owned.dependencies, runtimeUser: doc.runtimeUser, createRuntimeUser: Boolean(doc.runtimeUser) && isRoot() };
        const signature = core.signatureOf({ kind: 'install.repair', id: doc.installationId, release: doc.release && doc.release.releaseId });
        const plan = {
            action: 'repair',
            signature,
            stateDigest: core.signatureOf({ revision: doc.revision, current: current.releaseId || null, healthy: current.healthy || false }),
            noop: false,
            target,
            source: sourceDir ? { kind: 'local-directory' } : null,
            downloads: [],
            downloadHook: release.DOWNLOAD_HOOK,
            current: { present: current.present, healthy: current.healthy, code: current.code || null },
            services,
            retainedData: { roots: ['data', 'config', 'managerStore'] },
            privilegedSteps: privilegedPlan(steps),
            steps,
            installationId: doc.installationId
        };
        ledgerMatch(plan, 'install.repair', ctx, signature);
        return finish(plan, pre, { revision: doc.revision, unknownServices: unknown, privateInput: { raw: input, parsed: { source: sourceDir, sources: sources.length ? sources : null, release: parsedRelease } } });
    }

    function repairKind() {
        return {
            kind: 'install.repair',
            public: true,
            allowed: (state, via) => state.state === 'claimed' && SESSION_VIA.includes(via),
            async plan(input, ctx) {
                const built = await buildRepair(input, ctx);
                if (built.unknownServices.length) throw new ManagerError(409, 'UNKNOWN_SERVICE_OWNER', 'A service in the record was not registered by the installer; the manager never touches it.', { services: built.unknownServices });
                return { plan: built.plan, revision: built.revision, privateInput: built.privateInput };
            },
            validate: revalidator(buildRepair),
            steps: [
                core.step('preflight', async (record, ctx) => {
                    const again = await buildRepair(needInput(ctx).raw, ctx);
                    if (!again.pre.ok) throw failedPreflight(again.pre);
                    return { detail: { warnings: again.pre.findings.filter(item => item.severity === 'warn').length } };
                }),
                stageStep('stage'),
                verifyStep('verify'),
                core.step('init-db', async (record) => {
                    const t = record.plan.target;
                    const out = await deps.initDatabase({ roots: t.roots, settings, database: t.database });
                    return { detail: { engine: out.engine, tables: out.tables } };
                }),
                core.step('write-features', (record) => {
                    const t = record.plan.target;
                    if (!t.release) return { status: 'skipped', code: 'NOT_APPLICABLE' };
                    return core.writeFeaturesStep({ dataDir: t.roots.data, selected: t.features });
                }),
                activateStep('activate'),
                core.step('register-service', (record, ctx) => serviceSteps.register(record, ctx, { enabled: record.plan.services.some(item => item.action === 'register') }))
            ],
            result: (scratch) => ({ restartRequired: Boolean(scratch.stagingDir), ...(scratch.service ? { service: scratch.service } : {}) })
        };
    }

    // --------------------------------------------------- install.uninstall
    /**
     * The Docker database this manager owns, as an uninstall sees it. By default it is
     * left exactly as it is (the data outlives the installation); `removeDockerData`
     * names the resources it would delete, each re-checked against its labels.
     */
    async function dockerUninstallView(doc, removeDockerData) {
        const recorded = dockerState.read(settings.storeDir, fs);
        if (!recorded.present) return { view: null, findings: [] };
        const names = dockerService.createDockerService({ settings, fs, now, logger }).resourceNames(doc.installationId);
        if (!removeDockerData) {
            return { view: { action: 'kept', note: 'The container, its data and its network are left as they are. Remove them with removeDockerData.', names }, findings: [] };
        }
        try {
            const removal = await dockerService.createDockerService({ settings, fs, now, logger }).removalPlan({ installationId: doc.installationId });
            const findings = removal.foreign.map(item => ({ code: 'DOCKER_RESOURCE_FOREIGN', severity: 'block', detail: `a ${item.kind} named "${item.name}" has no label of this installation and would not be touched; resolve it first` }));
            return { view: { action: 'remove', names, resources: removal.resources, hostPath: removal.hostPath, hostPathNote: removal.hostPath ? 'a directory you chose is never deleted by the installer' : null }, findings };
        } catch (error) {
            return { view: { action: 'remove', names, resources: [], unavailable: true }, findings: [{ code: 'DOCKER_UNAVAILABLE', severity: 'block', detail: 'Docker cannot be reached, so the database cannot be removed. Start Docker, or uninstall without removeDockerData.' }] };
        }
    }

    async function buildUninstall(input, ctx) {
        const raw = input === undefined ? {} : input;
        exactKeys(raw, new Set(['keepData', 'confirm', 'acknowledgeUnknownServices', 'removeDockerData']));
        const keepData = parseBoolean(raw.keepData, 'keepData', true);
        const removeDockerData = parseBoolean(raw.removeDockerData, 'removeDockerData', false);
        const acknowledged = parseBoolean(raw.acknowledgeUnknownServices, 'acknowledgeUnknownServices', false);
        if (raw.confirm !== undefined) textField(raw.confirm, 'confirm', { max: 64 });
        const doc = ownedRecord(ctx);
        const roots = doc.roots;
        const removes = [];
        const retained = [];
        for (const entry of doc.owned.files) {
            if (entry.scope === 'payload') {
                for (const dir of core.payloadRemovals(roots)) removes.push({ role: 'code', path: dir, scope: 'payload' });
            } else if (keepData) {
                retained.push({ role: entry.role, path: entry.path });
            } else {
                removes.push({ role: entry.role, path: entry.path, scope: entry.scope });
            }
        }
        for (const item of removes) paths.assertRemovable(item.path, { codeRoot: item.role === 'code' ? null : roots.code, home: deps.home, fs });
        for (const item of removes.filter(entry => entry.role === 'code')) paths.assertContained(roots.code, item.path, fs);
        const { services, unknown } = describeServices(doc, { unregister: true });
        const sqliteInside = paths.isSameOrInside(roots.data, settings.sqlitePath);
        const database = doc.database.external
            ? { engine: doc.database.engine, action: 'not deleted: external' }
            : { engine: doc.database.engine, action: keepData ? 'kept' : (sqliteInside ? 'removed with the data root' : 'not deleted: outside the owned roots') };
        const confirmation = { required: !keepData || removeDockerData, satisfied: (keepData && !removeDockerData) || raw.confirm === doc.installationId };
        const dockerDatabase = await dockerUninstallView(doc, removeDockerData);
        const pre = { ok: true, findings: [...dockerDatabase.findings] };
        // "Delete my data" does not reach into Docker on its own: the volume keeps the
        // database, and the overlay that held the only credential goes with the data root.
        if (!keepData && !removeDockerData && dockerDatabase.view) {
            pre.findings.push({ code: 'DOCKER_DATA_RETAINED', severity: 'warn', detail: `the Docker database keeps its data in the volume "${dockerDatabase.view.names.volume}" (and its container keeps running); this uninstall removes neither. Pass removeDockerData to delete them too, or remove them by hand afterwards.` });
        }
        if (roots.managerStore !== settings.storeDir) pre.findings.push({ code: 'ROOTS_MISMATCH', severity: 'block', detail: 'the recorded manager store is not where this manager keeps it' });
        if (registry.get(settings.storeDir)) pre.findings.push({ code: 'WORKERS_RUNNING', severity: 'block', detail: 'the manager is supervising the application workers' });
        // The registry only sees this process; the CLI runs in another one, so the
        // layout's worker ports are the cross-process signal that something is still running.
        // A service the installer registered is stopped by the unregister step itself, so
        // its ports are checked after that step instead (assertStopped).
        const stopsItself = services.some(item => item.action === 'unregister') && core.privilegedAvailable('service.unregister');
        const { list: workerPorts } = portsFor({ layout: doc.layout, features: doc.release ? doc.release.features : [], env: settings.env || process.env, settings });
        if (!stopsItself) {
            for (const entry of workerPorts) {
                if (await deps.probePort(entry.port) === 'busy') {
                    pre.findings.push({ code: 'WORKERS_RUNNING', severity: 'block', detail: `the ${entry.name} port ${entry.port} is in use: an application process is still running; stop it first` });
                }
            }
        }
        pre.ok = pre.findings.every(item => item.severity !== 'block');
        const steps = stepList(UNINSTALL_STEPS);
        const signature = core.signatureOf({ kind: 'install.uninstall', id: doc.installationId, keepData, removeDockerData });
        const plan = {
            action: 'uninstall',
            signature,
            stateDigest: core.signatureOf({ revision: doc.revision }),
            noop: false,
            installationId: doc.installationId,
            keepData,
            removeDockerData,
            ...(dockerDatabase.view ? { dockerDatabase: dockerDatabase.view } : {}),
            target: { layout: doc.layout, roots, database: doc.database, features: doc.release ? doc.release.features : [], release: doc.release },
            removes,
            retainedData: { roots: retained.map(item => item.role), paths: retained.map(item => item.path) },
            exclusiveDependencies: doc.owned.dependencies.filter(dep => dep.ownedBy === 'installer').map(dep => dep.name),
            systemDependenciesLeft: doc.owned.dependencies.filter(dep => dep.ownedBy === 'system').map(dep => dep.name),
            database,
            services,
            unknownServices: unknown,
            confirmation,
            tombstone: true,
            downloads: [],
            privilegedSteps: privilegedPlan(steps.filter(item => item.name === 'unregister-service')),
            steps
        };
        ledgerMatch(plan, 'install.uninstall', ctx, signature);
        return finish(plan, pre, { revision: doc.revision, unknownServices: acknowledged ? [] : unknown, privateInput: { raw, parsed: { keepData, acknowledged, removeDockerData } } });
    }

    /** After the service is unregistered nothing of the application may still hold its ports. */
    async function assertStopped(record) {
        const t = record.plan.target;
        const { list } = portsFor({ layout: t.layout, features: t.features, env: settings.env || process.env, settings });
        for (let attempt = 0; attempt < 20; attempt++) {
            let busy = null;
            for (const entry of list) {
                if (await deps.probePort(entry.port) === 'busy') busy = entry;
            }
            if (!busy) return;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new ManagerError(409, 'WORKERS_RUNNING', 'An application process still holds its port after the service was removed; stop it, then run the uninstall again.');
    }

    function removeTree(target, keep, roots) {
        const resolved = paths.assertRemovable(target, { codeRoot: roots.code, home: deps.home, fs });
        let entries;
        try {
            entries = fs.readdirSync(resolved);
        } catch (error) {
            if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
            throw error;
        }
        let removed = false;
        for (const name of entries) {
            const child = path.join(resolved, name);
            if (keep.some(item => paths.isSameOrInside(child, item))) continue;
            fs.rmSync(child, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
            removed = true;
        }
        return removed;
    }

    function uninstallKind() {
        return {
            kind: 'install.uninstall',
            public: true,
            allowed: (state, via) => state.state === 'claimed' && SESSION_VIA.includes(via),
            async plan(input, ctx) {
                const built = await buildUninstall(input, ctx);
                if (built.unknownServices.length) throw new ManagerError(409, 'UNKNOWN_SERVICE_OWNER', 'A service in the record was not registered by the installer; the manager never touches it. Pass acknowledgeUnknownServices to leave it in place.', { services: built.unknownServices });
                return { plan: built.plan, revision: built.revision, privateInput: built.privateInput };
            },
            validate: revalidator(buildUninstall),
            steps: [
                core.step('preflight', async (record, ctx) => {
                    const again = await buildUninstall(needInput(ctx).raw, ctx);
                    if (!again.pre.ok) throw failedPreflight(again.pre);
                    return {};
                }),
                core.step('unregister-service', async (record, ctx) => {
                    const wanted = record.plan.services.some(item => item.action === 'unregister');
                    const outcome = await serviceSteps.unregister(record, ctx, { enabled: wanted });
                    if (outcome.status === 'done') await assertStopped(record);
                    return outcome;
                }),
                core.step('tombstone', (record) => {
                    tombstone.writeTombstone(settings.storeDir, { installationId: record.plan.installationId, operationId: record.id, dataRemoved: !record.plan.keepData, now }, fs);
                    return { detail: { dataRemoved: !record.plan.keepData } };
                }),
                core.step('docker-postgres', async (record) => {
                    if (!record.plan.removeDockerData) return { status: 'skipped', code: 'KEEP_DOCKER_DATA' };
                    if (!record.plan.dockerDatabase) return { status: 'skipped', code: 'NOT_OWNED' };
                    const out = await dockerService.createDockerService({ settings, fs, now, logger }).retire({ installationId: record.plan.installationId, remove: true });
                    return { detail: { removed: out.removed.length, container: out.removed.includes('container'), volume: out.removed.includes('volume'), network: out.removed.includes('network') } };
                }),
                core.step('remove-code', (record) => {
                    const roots = record.plan.target.roots;
                    let removed = 0;
                    for (const item of record.plan.removes.filter(entry => entry.role === 'code')) {
                        if (core.removeOwnedPath(item.path, roots)) removed++;
                    }
                    if (removed === 0 && !record.plan.removes.some(entry => entry.role === 'code')) return { status: 'skipped', code: 'NOT_OWNED' };
                    return { detail: { removed } };
                }),
                core.step('remove-data', (record) => {
                    if (record.plan.keepData) return { status: 'skipped', code: 'KEEP_DATA' };
                    const roots = record.plan.target.roots;
                    const keep = [roots.managerStore, tombstone.tombstonePath(roots.managerStore)];
                    let removed = 0;
                    // The overlay holds the database connection; the store survives (it carries the tombstone) but this secret does not.
                    if (environment.remove(settings.storeDir, fs)) removed++;
                    for (const item of record.plan.removes.filter(entry => entry.role !== 'code')) {
                        if (item.scope === 'file') {
                            if (core.removeOwnedPath(item.path, roots)) removed++;
                        } else if (paths.isSameOrInside(item.path, roots.managerStore)) {
                            if (removeTree(item.path, keep, roots)) removed++;
                        } else if (core.removeOwnedPath(item.path, roots)) {
                            removed++;
                        }
                    }
                    return { detail: { removed } };
                }),
                core.step('remove-ownership', (record, ctx) => {
                    ctx.store.removeInstallation();
                    for (const file of [ctx.store.paths.bridgeKey, ctx.store.paths.bootstrap, ctx.store.paths.bootstrapCredential]) files.removeIfPresent(file, fs);
                    ctx.scratch.removed = true;
                    return { detail: { dataRemoved: !record.plan.keepData } };
                })
            ],
            result: (scratch) => ({ removed: Boolean(scratch.removed) })
        };
    }

    return [newKind(), reconfigureKind(), repairKind(), uninstallKind()];
}

module.exports = { createInstallKinds, createKinds: createInstallKinds, NEW_STEPS, RECONFIGURE_STEPS, REPAIR_STEPS, UNINSTALL_STEPS };
