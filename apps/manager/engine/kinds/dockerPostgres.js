/**
 * The operations on the Docker PostgreSQL instance the manager owns
 * (documentation/docker_postgres.md). The read-only daemon check is a route
 * (`GET /manager/api/docker/status`), not a kind; these change something:
 *
 *   database.docker.provision    create the network, the data volume (or the chosen
 *                                directory) and the container, wait until it is healthy,
 *                                create the application role and its database through the
 *                                #338 library, apply the schema and verify it. The
 *                                installation is NOT connected yet: the application URL is
 *                                staged, and database.connect (`{ owned: 'docker' }`) is the
 *                                cutover, inside the maintenance barrier.
 *   database.docker.start|stop   the container, by name
 *   database.docker.repair       recreate a missing (or drifted) container over the SAME
 *                                storage; the data is never recreated
 *   database.docker.reconfigure  change port, bind address or memory limit; backup first,
 *                                inside a held maintenance barrier
 *
 * Every resource is named after the installation and re-checked against its labels
 * before it is changed (`RESOURCE_FOREIGN`). The superuser password and the
 * application password are `privateInput`: in memory, never in a plan, the journal,
 * the audit log, a result or an argv.
 */

const nodeFs = require('node:fs');
const { ManagerError } = require('../../errors');
const environment = require('../../environment');
const { createBarrier } = require('../../maintenance/barrier');
const { createInstallCore, exactKeys, parseBoolean } = require('../../install/engine');
const { lazy } = require('../../lazy');
const { createDockerService, parseRequest, mapDocker } = require('../../docker/service');
const { createReadiness } = require('../../docker/readiness');
const passwords = require('../../docker/passwords');
const dbInput = require('../../database/input');

const backupService = lazy('@goobster/core/services/backupService');

const SESSION_VIA = ['local', 'bridge', 'setup', 'recovery'];
const PROVISION_STEPS = ['preflight', 'create', 'wait-healthy', 'provision', 'verify'];
const START_STEPS = ['preflight', 'start', 'wait-healthy'];
const STOP_STEPS = ['preflight', 'stop'];
const REPAIR_STEPS = ['preflight', 'repair', 'wait-healthy'];
const RECONFIGURE_STEPS = ['preflight', 'backup', 'recreate', 'wait-healthy', 'update-url', 'verify'];
const allowedInstalled = (managerState, via) => managerState.state === 'claimed' && SESSION_VIA.includes(via);

const NO_KEYS = new Set([]);
const PROVISION_KEYS = new Set(['port', 'bind', 'acknowledgeLanBind', 'storage', 'role', 'database', 'memoryMb', 'pull', 'acknowledgeBackupTools']);
const RECONFIGURE_KEYS = new Set(['port', 'bind', 'acknowledgeLanBind', 'memoryMb', 'storage', 'major', 'backup', 'maintenance']);
const BACKUP_KEYS = new Set(['dir', 'passphrase', 'skipConfig']);

/** The daemon check as a plan carries it: facts and verdicts, nothing of the environment. */
function daemonSummary(report) {
    return {
        cli: report.cli,
        daemon: { reachable: report.daemon.reachable, code: report.daemon.code, serverVersion: report.daemon.serverVersion, flavor: report.daemon.flavor, rootless: report.daemon.rootless, socket: report.daemon.socket },
        platform: report.platform,
        image: report.image,
        backupTools: report.backupTools,
        storage: report.storage,
        compatibility: report.compatibility
    };
}

function createKinds({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const core = createInstallCore({ settings, fs, now, logger });
    const service = () => createDockerService({ settings, fs, now, logger });
    const deps = () => settings.dockerDeps || {};
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
            throw mapDocker(error);
        }
    }

    const stepList = (names) => names.map(name => ({ name }));

    // ============================================================== provision
    function provisionKind() {
        async function build(raw, ctx) {
            const request = parseRequest(raw, { keys: PROVISION_KEYS });
            const installationId = installationOf(ctx);
            const view = await wrapped(() => service().assess({ installationId, request }));
            return { request, installationId, view };
        }

        return {
            kind: 'database.docker.provision',
            public: true,
            allowed: allowedInstalled,
            async plan(raw, ctx) {
                const { request, installationId, view } = await build(raw, ctx);
                return {
                    plan: {
                        target: 'docker-database',
                        effect: 'provision-docker-database',
                        mode: view.mode,
                        names: view.names,
                        request: view.request,
                        port: view.port,
                        storage: view.storage,
                        image: view.image,
                        backupTools: view.backupTools ? { ok: view.backupTools.ok, code: view.backupTools.code, version: view.backupTools.version, remedy: view.backupTools.remedy } : null,
                        daemon: daemonSummary(view.daemon),
                        findings: view.findings,
                        ok: view.ok,
                        blocks: view.blocks,
                        credentials: { application: 'generated; held in memory, then only in the manager overlay', superuser: 'generated; used once to create the role; not stored anywhere' },
                        actions: ['create-role', 'create-database', 'create-extension.citext', 'create-extension.vector', 'create-schema', 'grant'],
                        connect: 'database.connect with { connection: { owned: "docker" } } switches the installation to it (a SQLite installation with data is the migration)',
                        boundary: 'this installation\'s own network, volume (or the chosen directory) and container, by exact name; nothing else',
                        steps: stepList(PROVISION_STEPS),
                        installationId
                    },
                    revision: null,
                    privateInput: { raw, request, passwords: passwords.generatePair() }
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
                        return { mode: view.mode, warnings: view.findings.filter(item => item.severity === 'warn').length, pull: view.image.willPull };
                    }
                },
                {
                    name: 'create',
                    async run(record, ctx) {
                        const { passwords: secret } = needInput(ctx);
                        const svc = service();
                        const created = await wrapped(() => svc.createResources({ installationId: ctx.scratch.installationId, request: ctx.scratch.request, superuserPassword: secret.superuser, operationId: record.id, view: ctx.scratch.view }));
                        ctx.scratch.created = created;
                        return { network: created.network, volume: created.volume, container: created.container, cleaned: created.cleaned.length };
                    }
                },
                {
                    name: 'wait-healthy',
                    async run(record, ctx) {
                        const out = await wrapped(() => service().waitHealthy({ installationId: ctx.scratch.installationId }));
                        return { health: out.health };
                    }
                },
                {
                    name: 'provision',
                    async run(record, ctx) {
                        const { passwords: secret } = needInput(ctx);
                        const svc = service();
                        const out = await svc.provisionRole({ request: ctx.scratch.request, passwords: secret });
                        ctx.scratch.application = out.application;
                        ctx.scratch.done = out.results;
                        const schema = await svc.applySchema({ request: ctx.scratch.request, url: svc.urlOf(out.application) });
                        ctx.scratch.tables = schema.tables;
                        return { done: out.results.filter(item => item.status === 'done').length, already: out.results.filter(item => item.status === 'already').length, tables: schema.tables };
                    }
                },
                {
                    name: 'verify',
                    async run(record, ctx) {
                        const out = await service().verify({ application: ctx.scratch.application });
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
                next: 'database.connect with { connection: { owned: "docker" } }'
            }),
            auditDetail: (record, scratch) => ({
                container: record.plan.names.container,
                volume: record.plan.names.volume,
                network: record.plan.names.network,
                image: record.plan.image.reference,
                mode: record.plan.mode,
                created: scratch.created ? Object.values({ n: scratch.created.network, v: scratch.created.volume, c: scratch.created.container }).filter(Boolean).length : 0,
                done: (scratch.done || []).filter(item => item.status === 'done').length
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
                return { plan: { target: 'docker-database', names: service().resourceNames(installationId), steps: stepList(steps), ...built }, revision: null, privateInput: { value } };
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
            auditDetail: (record) => ({ container: record.plan.names.container, volume: record.plan.names.volume, network: record.plan.names.network })
        };
    }

    function startKind() {
        return simpleKind({
            name: 'database.docker.start',
            steps: START_STEPS,
            async plan({ installationId }) {
                const svc = service();
                const status = await svc.status({ installationId });
                const blocks = [];
                if (!svc.record().doc) blocks.push({ code: 'NO_DOCKER_DATABASE', detail: 'There is no Docker database record.', remedy: 'Provision one first.' });
                for (const item of status.daemon.verdict.blocks) blocks.push({ code: item.code, detail: item.detail, remedy: item.remedy });
                if (status.owned && !(status.owned.container && status.owned.container.exists)) blocks.push({ code: 'CONTAINER_MISSING', detail: 'The container does not exist.', remedy: 'Repair it: the data volume is kept.' });
                return { effect: 'start-docker-database', container: status.owned ? status.owned.container : null, blocks, ok: blocks.length === 0 };
            },
            async run(step, { installationId, ctx }) {
                const svc = service();
                if (step === 'preflight') return {};
                if (step === 'start') {
                    const out = await svc.start({ installationId });
                    ctx.scratch.out = out;
                    return { health: out.health };
                }
                return { health: ctx.scratch.out ? ctx.scratch.out.health : 'healthy', skipped: true };
            },
            result: scratch => ({ running: true, health: scratch.out ? scratch.out.health : null })
        });
    }

    function stopKind() {
        return simpleKind({
            name: 'database.docker.stop',
            keys: new Set(['acknowledgeInUse']),
            steps: STOP_STEPS,
            async plan({ installationId, value }) {
                const svc = service();
                const doc = svc.record().doc;
                const status = await svc.status({ installationId });
                const blocks = [];
                if (!doc) blocks.push({ code: 'NO_DOCKER_DATABASE', detail: 'There is no Docker database record.', remedy: 'Provision one first.' });
                for (const item of status.daemon.verdict.blocks) blocks.push({ code: item.code, detail: item.detail, remedy: item.remedy });
                const inUse = Boolean(doc) && svc.connectedToOwned(doc);
                if (inUse && value.acknowledgeInUse !== true) {
                    blocks.push({ code: 'DATABASE_IN_USE', detail: 'This installation is connected to the database. Stopping it takes the application\'s data away until it is started again.', remedy: 'Pass acknowledgeInUse after stopping the workers (or entering maintenance).' });
                }
                return { effect: 'stop-docker-database', inUse, container: status.owned ? status.owned.container : null, blocks, ok: blocks.length === 0 };
            },
            async run(step, { installationId, ctx }) {
                if (step === 'preflight') return {};
                const out = await service().stop({ installationId });
                ctx.scratch.out = out;
                return { stopped: out.stopped, missing: out.missing };
            },
            result: scratch => ({ stopped: scratch.out ? scratch.out.stopped : false })
        });
    }

    function repairKind() {
        return simpleKind({
            name: 'database.docker.repair',
            steps: REPAIR_STEPS,
            async plan({ installationId }) {
                const out = await service().repairPlan({ installationId });
                return { effect: 'repair-docker-database', action: out.action, reasons: out.reasons, container: out.container, storageKept: true, blocks: out.blocks, findings: out.findings, ok: out.ok };
            },
            async run(step, { installationId, ctx }) {
                const svc = service();
                if (step === 'preflight') return {};
                if (step === 'repair') {
                    const out = await svc.repair({ installationId });
                    ctx.scratch.out = out;
                    return { action: out.action, recreated: out.recreated, started: out.started };
                }
                const out = await svc.waitHealthy({ installationId });
                ctx.scratch.health = out.health;
                return { health: out.health };
            },
            result: scratch => ({ repaired: true, action: scratch.out ? scratch.out.action : 'none', health: scratch.health || null })
        });
    }

    // ============================================================ reconfigure
    function parseBackup(value) {
        if (value === undefined || value === null) {
            throw new ManagerError(400, 'BACKUP_REQUIRED', 'Changing a database that holds data first takes a verified backup: "backup.dir" says where to write it.');
        }
        exactKeys(value, BACKUP_KEYS, '"backup"');
        if (typeof value.dir !== 'string' || !require('node:path').isAbsolute(value.dir) || value.dir.split(/[\\/]/).includes('..') || value.dir.includes('\0')) {
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

    function reconfigureKind() {
        function parse(raw) {
            const value = raw === undefined || raw === null ? {} : raw;
            exactKeys(value, RECONFIGURE_KEYS, '"database.docker.reconfigure" input');
            if (value.storage !== undefined) {
                throw new ManagerError(409, 'STORAGE_MOVE_UNSUPPORTED', 'The data directory of an existing database is not moved by the installer. Take a backup, uninstall with removeDockerData, provision with the new storage and restore (documentation/docker_postgres.md, "Moving the data").');
            }
            if (value.major !== undefined) {
                throw new ManagerError(409, 'MAJOR_UPGRADE_IS_MANUAL', `A major upgrade is never applied by the installer: back the database up and follow ${lazy('@goobster/core/db/docker').UPGRADING_DOC}.`);
            }
            const asked = parseRequest({ ...(value.port !== undefined ? { port: value.port } : {}), ...(value.bind !== undefined ? { bind: value.bind } : {}), ...(value.acknowledgeLanBind !== undefined ? { acknowledgeLanBind: value.acknowledgeLanBind } : {}), ...(value.memoryMb !== undefined ? { memoryMb: value.memoryMb } : {}) });
            const changes = {};
            if (value.port !== undefined) changes.port = asked.port;
            if (value.bind !== undefined) changes.bind = asked.bind;
            if (value.memoryMb !== undefined) changes.memoryMb = asked.memoryMb;
            if (Object.keys(changes).length === 0) throw new ManagerError(400, 'NOTHING_TO_CHANGE', 'Name what to change: "port", "bind" or "memoryMb".');
            const maintenance = dbInput.parseMaintenance(value.maintenance);
            if (!maintenance) throw new ManagerError(400, 'MAINTENANCE_REQUIRED', 'Reconfiguring the database needs the maintenance barrier held (maintenance.enter): pass its "maintenance.operationId" and "maintenance.fence".');
            return { changes, backup: parseBackup(value.backup), maintenance };
        }

        async function review(parsed, installationId) {
            const svc = service();
            const doc = svc.record().doc;
            const blocks = [];
            if (!doc || doc.step !== 'verified') blocks.push({ code: 'NO_DOCKER_DATABASE', detail: 'There is no completed Docker database to reconfigure.', remedy: 'Provision one first.' });
            const daemon = await svc.check({});
            for (const item of daemon.verdict.blocks) blocks.push({ code: item.code, detail: item.detail, remedy: item.remedy });
            if (doc && parsed.changes.port !== undefined && parsed.changes.port !== doc.request.port && blocks.length === 0) {
                const status = await svc.containersFor(installationId).portStatus(parsed.changes.port, parsed.changes.bind || doc.request.bind);
                if (!status.free) blocks.push({ code: 'PORT_IN_USE', detail: `Port ${parsed.changes.port} is not free.`, remedy: 'Choose another port.' });
            }
            return { doc, blocks };
        }

        return {
            kind: 'database.docker.reconfigure',
            public: true,
            allowed: allowedInstalled,
            async plan(raw, ctx) {
                const parsed = parse(raw);
                const installationId = installationOf(ctx);
                const { doc, blocks } = await wrapped(() => review(parsed, installationId));
                const svc = service();
                return {
                    plan: {
                        target: 'docker-database',
                        effect: 'reconfigure-docker-database',
                        names: svc.resourceNames(installationId),
                        from: doc ? { port: doc.request.port, bind: doc.request.bind, memoryMb: doc.request.memoryMb } : null,
                        to: parsed.changes,
                        backup: { required: true, verified: 'table counts, schema fingerprint and file counts', includesConfig: !parsed.backup.skipConfig, configEncrypted: true },
                        maintenance: { operationId: parsed.maintenance.operationId, fence: parsed.maintenance.fence },
                        storageKept: true,
                        blocks,
                        ok: blocks.length === 0,
                        boundary: 'recreates the container over the same storage; the data is not touched',
                        steps: stepList(RECONFIGURE_STEPS),
                        installationId
                    },
                    revision: null,
                    privateInput: { raw, parsed }
                };
            },
            async validate(record, ctx) {
                const { parsed } = needInput(ctx);
                const { blocks } = await wrapped(() => review(parsed, installationOf(ctx)));
                if (blocks.length > 0) throw new ManagerError(409, 'PREFLIGHT_FAILED', `The database cannot be reconfigured yet: ${[...new Set(blocks.map(item => item.code))].join(', ')}.`, { findings: blocks.slice(0, 12) });
                heldBarrier(parsed.maintenance);
            },
            steps: [
                {
                    name: 'preflight',
                    async run(record, ctx) {
                        const { parsed } = needInput(ctx);
                        heldBarrier(parsed.maintenance);
                        ctx.scratch.installationId = installationOf(ctx);
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
                            return { verified: true, tables: verified.tables, fileSets: verified.files };
                        } catch (error) {
                            if (error instanceof ManagerError) throw error;
                            if (error && error.code === 'PASSPHRASE_REQUIRED') throw new ManagerError(400, 'PASSPHRASE_REQUIRED', 'config.json is only ever stored encrypted: supply "backup.passphrase", or set "backup.skipConfig".');
                            throw new ManagerError(409, 'BACKUP_FAILED', 'The backup could not be written or verified, so nothing was changed.', { reason: error && error.code ? String(error.code).slice(0, 40) : null });
                        }
                    }
                },
                {
                    name: 'recreate',
                    async run(record, ctx) {
                        if (ctx.scratch.backupVerified !== true) throw new ManagerError(409, 'BACKUP_UNVERIFIED', 'No verified backup exists for this change; nothing was changed.');
                        const { parsed } = needInput(ctx);
                        const request = await wrapped(() => service().recreate({ installationId: ctx.scratch.installationId, changes: parsed.changes }));
                        ctx.scratch.request = request;
                        return { port: request.port !== undefined, recreated: true };
                    }
                },
                {
                    name: 'wait-healthy',
                    async run(record, ctx) {
                        const out = await wrapped(() => service().waitHealthy({ installationId: ctx.scratch.installationId }));
                        return { health: out.health };
                    }
                },
                {
                    name: 'update-url',
                    async run(record, ctx) {
                        const { parsed } = needInput(ctx);
                        if (parsed.changes.port === undefined && parsed.changes.bind === undefined) return { skipped: true, code: 'NOT_NEEDED' };
                        const rewritten = rewriteUrls(settings, fs, now, ctx.scratch.request);
                        return { rewritten };
                    }
                },
                {
                    name: 'verify',
                    async run(record, ctx) {
                        const out = await createReadiness({ settings, fs, now, logger }).waitReady({ timeoutMs: deps().waitMs || 60_000, pollMs: deps().pollMs || 1000 });
                        ctx.scratch.ready = out.ready || !out.owned;
                        if (!ctx.scratch.ready) throw new ManagerError(409, 'DATABASE_NOT_READY', `The database did not answer after the change (${out.reason}).`);
                        return { ready: true };
                    }
                }
            ],
            result: scratch => ({ reconfigured: true, ready: scratch.ready === true, barrier: 'held', next: 'maintenance.release' }),
            auditDetail: (record, scratch) => ({
                container: record.plan.names.container,
                changed: Object.keys(record.plan.to).join('-'),
                backupVerified: scratch.backupVerified === true
            })
        };
    }

    return [provisionKind(), startKind(), stopKind(), repairKind(), reconfigureKind()];
}

/** After a port or bind change: the URLs that name the old port now name the new one. Returns the keys rewritten. */
function rewriteUrls(settings, fs, now, request) {
    const existing = environment.read(settings.storeDir, fs).values;
    const next = { ...existing };
    const rewritten = [];
    for (const key of ['GOOBSTER_DB_URL', 'GOOBSTER_DOCKER_DB_URL']) {
        if (!existing[key]) continue;
        try {
            const url = new URL(existing[key]);
            if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') continue;
            url.port = String(request.port);
            next[key] = url.toString();
            rewritten.push(key);
        } catch { /* a value that is not a URL is left as it is */ }
    }
    if (rewritten.length > 0) {
        environment.write(settings.storeDir, next, { fs, now });
        if (rewritten.includes('GOOBSTER_DB_URL')) environment.apply(settings, next);
    }
    return rewritten;
}

module.exports = { createKinds, PROVISION_STEPS, START_STEPS, STOP_STEPS, REPAIR_STEPS, RECONFIGURE_STEPS, daemonSummary, rewriteUrls };
