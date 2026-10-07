/**
 * The operations on the native PostgreSQL cluster the manager owns
 * (documentation/native_postgres.md). The read-only host check is a route
 * (`GET /manager/api/native/status`), not a kind; these change something:
 *
 *   database.native.provision   install the PostgreSQL packages when approved, create the
 *                               cluster (its own data directory, its own port, its own
 *                               service), the application role, its database and the
 *                               extensions, apply the schema and verify it. The installation
 *                               is NOT connected yet: the application URL is staged, and
 *                               database.connect (`{ owned: 'native' }`) is the cutover,
 *                               inside the maintenance barrier.
 *   database.native.start|stop  the cluster's service, by name
 *   database.native.repair      converge the cluster's configuration and start it; the data
 *                               is never recreated
 *   database.native.relocate    move the data directory; a verified backup first, inside a
 *                               held maintenance barrier. The old directory is kept.
 *
 * Every privileged step goes through the closed helper protocol
 * (apps/manager/privileged.js) and is re-checked there against the manager's own
 * record and the marker in the data directory. A cluster that is not ours is never
 * changed. The application password is `privateInput`: in memory, never in a plan,
 * the journal, the audit log, a result or an argv; the helper receives its SCRAM
 * verifier only.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { ManagerError } = require('../../errors');
const { createBarrier } = require('../../maintenance/barrier');
const { createInstallCore, exactKeys, parseBoolean } = require('../../install/engine');
const { lazy } = require('../../lazy');
const { createNativeService, parseRequest, mapNative } = require('../../native/service');
const passwords = require('../../native/passwords');
const dbInput = require('../../database/input');

const backupService = lazy('@goobster/core/services/backupService');

const SESSION_VIA = ['local', 'bridge', 'setup', 'recovery'];
const PROVISION_STEPS = ['preflight', 'packages', 'cluster', 'schema', 'verify'];
const START_STEPS = ['preflight', 'start', 'wait-ready'];
const STOP_STEPS = ['preflight', 'stop'];
const REPAIR_STEPS = ['preflight', 'repair', 'wait-ready'];
const RELOCATE_STEPS = ['preflight', 'backup', 'relocate', 'verify'];
const allowedInstalled = (managerState, via) => managerState.state === 'claimed' && SESSION_VIA.includes(via);

const NO_KEYS = new Set([]);
const PROVISION_KEYS = new Set(['port', 'bind', 'acknowledgeLanBind', 'dataDirectory', 'role', 'database', 'installPackages', 'acknowledgeBackupTools', 'acknowledgeMount']);
const RELOCATE_KEYS = new Set(['target', 'acknowledgeMount', 'backup', 'maintenance']);
const BACKUP_KEYS = new Set(['dir', 'passphrase', 'skipConfig']);
const PRIVILEGED_STEPS = Object.freeze([{ name: 'packages', privileged: 'package.install' }, { name: 'cluster', privileged: 'postgres.cluster.create' }]);

/** The host check as a plan carries it: facts and verdicts, nothing of the environment. */
function hostSummary(host) {
    return {
        supported: host.supported,
        reason: host.reason,
        distro: host.distro,
        packageManager: host.packageManager,
        major: host.major,
        packages: host.packages,
        clusters: host.clusters.map(item => ({ name: item.name, version: item.version, port: item.port, online: item.online, owned: item.owned })),
        systemd: host.systemd,
        selinux: host.selinux,
        backupTools: host.backupTools ? { ok: host.backupTools.ok, code: host.backupTools.code, version: host.backupTools.version } : null
    };
}

function createKinds({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const core = createInstallCore({ settings, fs, now, logger });
    const service = () => createNativeService({ settings, fs, now, logger });
    const deps = () => settings.nativeDeps || {};
    const barrier = () => createBarrier({ settings, fs, now, logger, ...((settings.databaseDeps || {}).barrier || {}) });

    const needInput = (ctx) => {
        if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
        return ctx.input;
    };

    const installationOf = (ctx) => core.ownedInstall(ctx, { requireManaged: false }).installationId;

    async function wrapped(call) {
        try {
            return await call();
        } catch (error) {
            throw mapNative(error);
        }
    }

    const stepList = (names) => names.map(name => ({ name }));

    // ============================================================== provision
    function provisionKind() {
        async function build(raw, ctx) {
            const request = parseRequest(raw, { keys: PROVISION_KEYS, allowTransient: deps().allowTransient === true });
            const installationId = installationOf(ctx);
            const view = await wrapped(() => service().assess({ installationId, request }));
            return { request, installationId, view };
        }

        return {
            kind: 'database.native.provision',
            public: true,
            allowed: allowedInstalled,
            async plan(raw, ctx) {
                const { request, installationId, view } = await build(raw, ctx);
                return {
                    plan: {
                        target: 'native-database',
                        effect: 'provision-native-database',
                        mode: view.mode,
                        names: view.names,
                        cluster: view.cluster,
                        request: view.request,
                        port: view.port,
                        storage: view.storage,
                        packages: view.packages,
                        backupTools: view.backupTools ? { ok: view.backupTools.ok, code: view.backupTools.code, version: view.backupTools.version, remedy: view.backupTools.remedy } : null,
                        host: hostSummary(view.host),
                        elevation: { available: view.elevation.available, kind: view.elevation.kind },
                        findings: view.findings,
                        ok: view.ok,
                        blocks: view.blocks,
                        credentials: { application: 'generated; held in memory, then only in the manager overlay; the helper receives its SCRAM-SHA-256 verifier, never the password' },
                        actions: ['create-cluster', 'create-role', 'create-database', 'create-extension.citext', 'create-extension.vector', 'create-schema', 'grant'],
                        connect: 'database.connect with { connection: { owned: "native" } } switches the installation to it (a SQLite installation with data is the migration)',
                        boundary: 'this installation\'s own cluster, data directory and service, by exact name; no other PostgreSQL cluster, setting or file is touched. Packages stay installed if it is removed.',
                        privilegedSteps: PRIVILEGED_STEPS,
                        steps: stepList(PROVISION_STEPS),
                        installationId
                    },
                    revision: null,
                    privateInput: { raw, request, password: passwords.generate() }
                };
            },
            async validate(record, ctx) {
                const { view } = await build(needInput(ctx).raw, ctx);
                service().assertAssessed(view);
            },
            steps: [
                {
                    name: 'preflight',
                    async run(record, ctx) {
                        const { request, installationId, view } = await build(needInput(ctx).raw, ctx);
                        service().assertAssessed(view);
                        ctx.scratch.view = view;
                        ctx.scratch.installationId = installationId;
                        ctx.scratch.request = request;
                        return { mode: view.mode, warnings: view.findings.filter(item => item.severity === 'warn').length, packages: view.packages.install.length };
                    }
                },
                {
                    name: 'packages',
                    async run(record, ctx) {
                        const out = await wrapped(() => service().installPackages({ installationId: ctx.scratch.installationId, request: ctx.scratch.request, view: ctx.scratch.view, operationId: record.id, scope: { record, ctx } }));
                        ctx.scratch.packages = out;
                        return { installed: out.installed.length, skipped: out.skipped === true };
                    }
                },
                {
                    name: 'cluster',
                    async run(record, ctx) {
                        const { password } = needInput(ctx);
                        const out = await wrapped(() => service().createCluster({ installationId: ctx.scratch.installationId, request: ctx.scratch.request, view: ctx.scratch.view, password, scope: { record, ctx } }));
                        ctx.scratch.cluster = out;
                        return { created: out.created, resumed: out.resumed, provisioned: out.provisioned };
                    }
                },
                {
                    name: 'schema',
                    async run(record, ctx) {
                        const { password } = needInput(ctx);
                        const svc = service();
                        const out = await wrapped(() => svc.applySchema({ password }));
                        ctx.scratch.application = out.application;
                        ctx.scratch.tables = out.tables;
                        return { tables: out.tables };
                    }
                },
                {
                    name: 'verify',
                    async run(record, ctx) {
                        const out = await wrapped(() => service().verify({ application: ctx.scratch.application }));
                        ctx.scratch.schema = out.schema;
                        return { schema: out.schema };
                    }
                }
            ],
            result: scratch => ({
                provisioned: true,
                names: scratch.view ? scratch.view.names : null,
                port: scratch.request ? scratch.request.port : null,
                schema: scratch.schema || null,
                connected: false,
                next: 'database.connect with { connection: { owned: "native" } }'
            }),
            auditDetail: (record, scratch) => ({
                cluster: record.plan.names.cluster,
                service: record.plan.names.service,
                major: record.plan.host.major,
                mode: record.plan.mode,
                packagesInstalled: scratch.packages ? scratch.packages.installed.length : 0,
                created: scratch.cluster ? scratch.cluster.created === true : false
            })
        };
    }

    // ================================================== start / stop / repair
    function simpleKind({ name, keys = NO_KEYS, steps, plan, run, result }) {
        return {
            kind: name,
            public: true,
            allowed: allowedInstalled,
            async plan(raw, ctx) {
                const value = raw === undefined || raw === null ? {} : raw;
                exactKeys(value, keys, `"${name}" input`);
                const installationId = installationOf(ctx);
                const built = await wrapped(() => plan({ installationId, value }));
                const doc = service().record().doc;
                return { plan: { target: 'native-database', names: service().resourceNames(installationId, doc ? doc.family : null, doc ? doc.cluster.name : null, doc ? doc.cluster.dataDirectory : null), steps: stepList(steps), installationId, ...built }, revision: null, privateInput: { value } };
            },
            async validate(record, ctx) {
                const installationId = installationOf(ctx);
                const again = await wrapped(() => plan({ installationId, value: needInput(ctx).value }));
                if (again.ok === false) throw new ManagerError(409, 'PREFLIGHT_FAILED', `This cannot be done yet: ${[...new Set(again.blocks.map(item => item.code))].join(', ')}.`, { findings: again.blocks.slice(0, 12) });
            },
            steps: steps.map(step => ({
                name: step,
                async run(record, ctx) {
                    ctx.scratch.installationId = ctx.scratch.installationId || installationOf(ctx);
                    return wrapped(() => run(step, { record, ctx, installationId: ctx.scratch.installationId }));
                }
            })),
            result: (scratch) => result(scratch),
            auditDetail: (record) => ({ cluster: record.plan.names.cluster, service: record.plan.names.service })
        };
    }

    async function controlBlocks(svc, installationId) {
        const doc = svc.record().doc;
        const blocks = [];
        if (!doc) {
            blocks.push({ code: 'NO_NATIVE_DATABASE', detail: 'There is no native database record.', remedy: 'Provision one first.' });
            return { doc, blocks };
        }
        if (!svc.elevation().available) blocks.push({ code: 'ELEVATION_UNAVAILABLE', detail: 'Starting or stopping the cluster needs administrator rights, and none can be obtained here without a password prompt.', remedy: 'Run the manager as root or allow passwordless sudo.' });
        void installationId;
        return { doc, blocks };
    }

    function startKind() {
        return simpleKind({
            name: 'database.native.start',
            steps: START_STEPS,
            async plan({ installationId }) {
                const { blocks } = await controlBlocks(service(), installationId);
                return { effect: 'start-native-database', blocks, ok: blocks.length === 0 };
            },
            async run(step, { installationId, ctx, record }) {
                const svc = service();
                if (step === 'preflight') return {};
                if (step === 'start') {
                    const out = await svc.start({ installationId, scope: { record, ctx } });
                    ctx.scratch.out = out;
                    return { changed: out.changed };
                }
                const ready = await svc.waitReady({ timeoutMs: deps().waitMs || 60_000 });
                ctx.scratch.ready = ready.ready;
                return { ready: true };
            },
            result: scratch => ({ running: true, ready: scratch.ready === true, changed: scratch.out ? scratch.out.changed : false })
        });
    }

    function stopKind() {
        return simpleKind({
            name: 'database.native.stop',
            keys: new Set(['acknowledgeInUse']),
            steps: STOP_STEPS,
            async plan({ installationId, value }) {
                const svc = service();
                const { doc, blocks } = await controlBlocks(svc, installationId);
                const inUse = Boolean(doc) && svc.connectedToOwned(doc);
                if (inUse && value.acknowledgeInUse !== true) {
                    blocks.push({ code: 'DATABASE_IN_USE', detail: 'This installation is connected to the database. Stopping it takes the application\'s data away until it is started again.', remedy: 'Pass acknowledgeInUse after stopping the workers (or entering maintenance).' });
                }
                return { effect: 'stop-native-database', inUse, blocks, ok: blocks.length === 0 };
            },
            async run(step, { installationId, ctx, record }) {
                if (step === 'preflight') return {};
                const out = await service().stop({ installationId, scope: { record, ctx } });
                ctx.scratch.out = out;
                return { changed: out.changed };
            },
            result: scratch => ({ stopped: true, changed: scratch.out ? scratch.out.changed : false })
        });
    }

    function repairKind() {
        return simpleKind({
            name: 'database.native.repair',
            steps: REPAIR_STEPS,
            async plan({ installationId }) {
                const out = await service().repairPlan({ installationId });
                return { effect: 'repair-native-database', action: out.action, reasons: out.reasons, cluster: out.cluster, storageKept: true, blocks: out.blocks, findings: out.findings, ok: out.ok };
            },
            async run(step, { installationId, ctx, record }) {
                const svc = service();
                if (step === 'preflight') return {};
                if (step === 'repair') {
                    const out = await svc.repair({ installationId, scope: { record, ctx } });
                    ctx.scratch.out = out;
                    return { action: out.action, converged: out.converged };
                }
                const ready = await svc.waitReady({ timeoutMs: deps().waitMs || 60_000 });
                ctx.scratch.ready = ready.ready;
                return { ready: true };
            },
            result: scratch => ({ repaired: true, action: scratch.out ? scratch.out.action : 'none', ready: scratch.ready === true })
        });
    }

    // ============================================================== relocate
    function parseBackup(value) {
        if (value === undefined || value === null) {
            throw new ManagerError(400, 'BACKUP_REQUIRED', 'Moving a database that holds data first takes a verified backup: "backup.dir" says where to write it.');
        }
        exactKeys(value, BACKUP_KEYS, '"backup"');
        if (typeof value.dir !== 'string' || !nodePath.isAbsolute(value.dir) || value.dir.split(/[\\/]/).includes('..') || value.dir.includes('\0')) {
            throw new ManagerError(400, 'BACKUP_REQUIRED', '"backup.dir" must be an absolute directory path (no ".." segments).');
        }
        if (value.passphrase !== undefined && (typeof value.passphrase !== 'string' || value.passphrase.length === 0 || value.passphrase.length > 1024)) {
            throw new ManagerError(400, 'INVALID_INPUT', '"backup.passphrase" must be a non-empty string.');
        }
        return { dir: value.dir, passphrase: value.passphrase || null, skipConfig: parseBoolean(value.skipConfig, 'backup.skipConfig', false) };
    }

    function heldBarrier(maintenance) {
        const view = barrier().view();
        if (!view.active || view.operationId !== maintenance.operationId || view.fence !== maintenance.fence) {
            throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier is not held with that operation id and fence; enter maintenance first.');
        }
        if (view.stale) throw new ManagerError(409, 'STALE_MAINTENANCE', 'The barrier was left by an earlier manager process and is never resumed automatically.');
        const writers = Object.entries(view.writers || {});
        if (writers.length === 0 || writers.some(([, info]) => info.acked !== true)) {
            throw new ManagerError(409, 'WRITER_UNACKNOWLEDGED', 'Not every writer acknowledged the fence; the application may still be writing.');
        }
    }

    function relocateKind() {
        function parse(raw) {
            const value = raw === undefined || raw === null ? {} : raw;
            exactKeys(value, RELOCATE_KEYS, '"database.native.relocate" input');
            if (typeof value.target !== 'string') throw new ManagerError(400, 'INVALID_INPUT', '"target" must name the new data directory (an absolute path).');
            const checked = lazy('@goobster/core/db/native').paths.checkDataDirectory(value.target, { allowTransient: deps().allowTransient === true });
            if (!checked.ok) throw new ManagerError(400, checked.code, `"target": ${checked.detail}`);
            const maintenance = dbInput.parseMaintenance(value.maintenance);
            if (!maintenance) throw new ManagerError(400, 'MAINTENANCE_REQUIRED', 'Moving the database needs the maintenance barrier held (maintenance.enter): pass its "maintenance.operationId" and "maintenance.fence".');
            return { target: checked.path, acknowledgeMount: parseBoolean(value.acknowledgeMount, 'acknowledgeMount', false), backup: parseBackup(value.backup), maintenance };
        }

        return {
            kind: 'database.native.relocate',
            public: true,
            allowed: allowedInstalled,
            async plan(raw, ctx) {
                const parsed = parse(raw);
                const installationId = installationOf(ctx);
                const svc = service();
                const review = await wrapped(() => svc.relocationPlan({ target: parsed.target, acknowledgeMount: parsed.acknowledgeMount }));
                const doc = svc.record().doc;
                return {
                    plan: {
                        target: 'native-database',
                        effect: 'relocate-native-database',
                        names: svc.resourceNames(installationId, doc ? doc.family : null, doc ? doc.cluster.name : null, doc ? doc.cluster.dataDirectory : null),
                        from: review.from,
                        to: review.to,
                        backup: { required: true, verified: 'table counts, schema fingerprint and file counts', includesConfig: !parsed.backup.skipConfig, configEncrypted: true },
                        maintenance: { operationId: parsed.maintenance.operationId, fence: parsed.maintenance.fence },
                        findings: review.findings,
                        blocks: review.blocks,
                        ok: review.ok,
                        originalKept: true,
                        boundary: 'copies this installation\'s own data directory to the target, verifies the copy, switches the cluster to it and starts it; the original directory is kept, and an interrupted copy leaves it in place',
                        privilegedSteps: [{ name: 'relocate', privileged: 'postgres.cluster.relocate' }],
                        steps: stepList(RELOCATE_STEPS),
                        installationId
                    },
                    revision: null,
                    privateInput: { raw, parsed }
                };
            },
            async validate(record, ctx) {
                const { parsed } = needInput(ctx);
                const review = await wrapped(() => service().relocationPlan({ target: parsed.target, acknowledgeMount: parsed.acknowledgeMount }));
                if (!review.ok) throw new ManagerError(409, 'PREFLIGHT_FAILED', `The database cannot be moved yet: ${[...new Set(review.blocks.map(item => item.code))].join(', ')}.`, { findings: review.blocks.slice(0, 12) });
                heldBarrier(parsed.maintenance);
            },
            steps: [
                {
                    name: 'preflight',
                    async run(record, ctx) {
                        const { parsed } = needInput(ctx);
                        heldBarrier(parsed.maintenance);
                        ctx.scratch.installationId = installationOf(ctx);
                        await wrapped(async () => service().planRelocation({ target: parsed.target }));
                        return { barrier: 'held' };
                    }
                },
                {
                    name: 'backup',
                    async run(record, ctx) {
                        const { parsed } = needInput(ctx);
                        const given = parsed.backup;
                        const backups = deps().backupService ? deps().backupService() : backupService;
                        try {
                            const created = await backups.createBackup({
                                destDir: given.dir,
                                passphrase: given.passphrase,
                                includeConfig: !given.skipConfig,
                                dataDir: settings.dataDir,
                                configPath: settings.configPath,
                                logger: { info() {}, warn() {}, error() {} }
                            });
                            ctx.scratch.archive = created.dir;
                            const verified = backups.verifyBackup(created.dir, { expectCounts: await backups.tableCounts() });
                            ctx.scratch.backupVerified = true;
                            service().noteBackup();
                            return { verified: true, tables: verified.tables, fileSets: verified.files };
                        } catch (error) {
                            service().clearRelocation();
                            if (error instanceof ManagerError) throw error;
                            if (error && error.code === 'PASSPHRASE_REQUIRED') throw new ManagerError(400, 'PASSPHRASE_REQUIRED', 'config.json is only ever stored encrypted: supply "backup.passphrase", or set "backup.skipConfig".');
                            throw new ManagerError(409, 'BACKUP_FAILED', 'The backup could not be written or verified, so nothing was changed.', { reason: error && error.code ? String(error.code).slice(0, 40) : null });
                        }
                    }
                },
                {
                    name: 'relocate',
                    async run(record, ctx) {
                        if (ctx.scratch.backupVerified !== true) throw new ManagerError(409, 'BACKUP_UNVERIFIED', 'No verified backup exists for this change; nothing was changed.');
                        const { parsed } = needInput(ctx);
                        heldBarrier(parsed.maintenance);
                        const out = await wrapped(() => service().relocate({ installationId: ctx.scratch.installationId, target: parsed.target, acknowledgeMount: parsed.acknowledgeMount, scope: { record, ctx } }));
                        ctx.scratch.moved = out;
                        return { moved: out.moved };
                    }
                },
                {
                    name: 'verify',
                    async run(record, ctx) {
                        const out = await wrapped(() => service().waitReady({ timeoutMs: deps().waitMs || 60_000 }));
                        ctx.scratch.ready = out.ready;
                        return { ready: true };
                    }
                }
            ],
            result: scratch => ({ relocated: true, moved: scratch.moved ? scratch.moved.moved : false, ready: scratch.ready === true, backupVerified: scratch.backupVerified === true, originalKept: true, barrier: 'held', next: 'maintenance.release' }),
            auditDetail: (record, scratch) => ({
                cluster: record.plan.names.cluster,
                service: record.plan.names.service,
                backupVerified: scratch.backupVerified === true,
                moved: scratch.moved ? scratch.moved.moved === true : false
            })
        };
    }

    return [provisionKind(), startKind(), stopKind(), repairKind(), relocateKind()];
}

module.exports = { createKinds, PROVISION_STEPS, START_STEPS, STOP_STEPS, REPAIR_STEPS, RELOCATE_STEPS, hostSummary };
