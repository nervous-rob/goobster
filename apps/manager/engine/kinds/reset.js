/**
 * `data.reset`: empty one scope of the installation's application data
 * (documentation/data_reset.md).
 *
 *   { scope: 'instance' }                    every application table, the derived
 *                                            vector index and every owned file set
 *   { scope: 'feature', feature: '<id>' }    the data of one feature that is not active
 *
 * Input (allow-list): { scope, feature?, backup: { dir, passphrase?,
 * skipConfig? }, confirm, maintenance: { operationId, fence },
 * expectedRevision? }. The backup directory, the passphrase and the typed
 * confirmation stay in memory (`privateInput`); the plan and the journal
 * carry names, counts and ids only.
 *
 * It runs only inside the maintenance barrier a `maintenance.enter` left at
 * `quiesced`, and it does not release it: `maintenance.release` is the
 * operator's next step.
 *
 *   preflight   the barrier is held with that fence, every writer
 *               acknowledged, the typed confirmation matches, the database
 *               is this installation's, a purged feature is not active
 *   backup      barrier -> backup; write the archive; verify it (counts,
 *               schema fingerprint, files); a backup that cannot be
 *               verified blocks
 *   mutate      barrier -> mutate (irreversible); db/reset.js
 *   verify      barrier -> verify; re-read what the plan promised
 *   cutover     barrier -> cutover; the instance is paused; result recorded
 *
 * Resuming: the steps after `backup` are idempotent, so a second
 * `data.reset` under the same (non-stale) barrier carries on from the
 * barrier's phase and never takes a second backup it does not need.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ManagerError } = require('../../errors');
const files = require('../../store/files');
const { lazy } = require('../../lazy');
const { createBarrier } = require('../../maintenance/barrier');
const { isStale } = require('../../maintenance/store');
const paths = require('../../install/paths');

const inventoryModule = lazy('@goobster/core/db/resetInventory');
const resetModule = lazy('@goobster/core/db/reset');
const backupService = lazy('@goobster/core/services/backupService');
const facade = lazy('@goobster/core/db');
const runtimePaths = lazy('@goobster/core/runtimePaths');

const INPUT_KEYS = new Set(['scope', 'feature', 'backup', 'confirm', 'maintenance', 'expectedRevision']);
const BACKUP_KEYS = new Set(['dir', 'passphrase', 'skipConfig']);
const MAINTENANCE_KEYS = new Set(['operationId', 'fence']);
const HELD_PHASES = Object.freeze(['quiesced', 'backup', 'mutate', 'verify', 'cutover']);
const PAST_BACKUP = Object.freeze(['mutate', 'verify', 'cutover']);
const VER_CODE = 'BACKUP_VERIFIED';
const VIA_FOR_INSTANCE = Object.freeze(['recovery', 'local']);
const STEP_NAMES = Object.freeze(['preflight', 'backup', 'mutate', 'verify', 'cutover']);

function allowed(state, via) {
    return state.state === 'claimed' && ['bridge', 'setup', 'recovery', 'local'].includes(via);
}

/* --------------------------------------------------------------- input */

function parseInput(input) {
    if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
    for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field data.reset does not accept.');
    }
    let scope;
    try {
        scope = inventoryModule.normalizeScope({ scope: input.scope, ...(input.feature !== undefined ? { feature: input.feature } : {}) });
    } catch (error) {
        throw mapCoreError(error);
    }
    const backup = input.backup;
    if (backup === undefined || backup === null) {
        throw new ManagerError(400, 'BACKUP_REQUIRED', 'A reset only runs after a verified backup: "backup.dir" says where to write it.');
    }
    if (!files.isPlainObject(backup)) throw new ManagerError(400, 'INVALID_INPUT', '"backup" must be an object.');
    for (const key of Object.keys(backup)) {
        if (!BACKUP_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', '"backup" has a field data.reset does not accept.');
    }
    const dir = backup.dir;
    if (typeof dir !== 'string' || dir.length === 0 || dir.length > 4096 || dir.includes('\0') || !path.isAbsolute(dir)
        || dir.split(/[\\/]+/).includes('..')) {
        throw new ManagerError(400, 'BACKUP_REQUIRED', '"backup.dir" must be an absolute directory path (no ".." segments) to write the backup into.');
    }
    if (backup.passphrase !== undefined && (typeof backup.passphrase !== 'string' || backup.passphrase.length === 0 || backup.passphrase.length > 1024)) {
        throw new ManagerError(400, 'INVALID_INPUT', '"backup.passphrase" must be a non-empty string.');
    }
    if (backup.skipConfig !== undefined && typeof backup.skipConfig !== 'boolean') {
        throw new ManagerError(400, 'INVALID_INPUT', '"backup.skipConfig" must be a boolean.');
    }
    const maintenance = input.maintenance;
    if (!files.isPlainObject(maintenance)) {
        throw new ManagerError(400, 'INVALID_INPUT', '"maintenance" must be { operationId, fence } of the maintenance.enter operation.');
    }
    for (const key of Object.keys(maintenance)) {
        if (!MAINTENANCE_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', '"maintenance" has a field data.reset does not accept.');
    }
    if (typeof maintenance.operationId !== 'string' || maintenance.operationId.length === 0 || maintenance.operationId.length > 64
        || !Number.isInteger(maintenance.fence) || maintenance.fence < 1) {
        throw new ManagerError(400, 'INVALID_INPUT', '"maintenance" must be { operationId, fence } of the maintenance.enter operation.');
    }
    if (input.confirm !== undefined && typeof input.confirm !== 'string') {
        throw new ManagerError(400, 'INVALID_INPUT', '"confirm" must be text.');
    }
    if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
        throw new ManagerError(400, 'INVALID_INPUT', '"expectedRevision" must be a non-negative integer.');
    }
    return {
        scope,
        backup: { dir, passphrase: backup.passphrase || null, skipConfig: backup.skipConfig === true },
        confirm: typeof input.confirm === 'string' ? input.confirm : '',
        maintenance: { operationId: maintenance.operationId, fence: maintenance.fence },
        expectedRevision: input.expectedRevision
    };
}

function mapCoreError(error) {
    if (error instanceof ManagerError) return error;
    switch (error && error.code) {
    case 'INVALID_SCOPE':
        return new ManagerError(400, 'INVALID_INPUT', error.message);
    case 'CORE_NOT_PURGEABLE':
    case 'UNKNOWN_FEATURE':
        return new ManagerError(400, error.code, error.message);
    case 'FILE_SET_UNSAFE':
        return new ManagerError(409, 'FILE_SET_UNSAFE', error.message, error.details ? { set: error.details.set } : null);
    case 'PASSPHRASE_REQUIRED':
        return new ManagerError(400, 'PASSPHRASE_REQUIRED', 'config.json is only ever stored encrypted: supply "backup.passphrase", or set "backup.skipConfig".');
    case 'UNVERIFIED':
        return new ManagerError(409, 'BACKUP_UNVERIFIED', 'The backup could not be verified, so nothing was changed.', { problems: error.problems || [] });
    default:
        return new ManagerError(409, 'RESET_FAILED', 'The reset step failed; the manager log has the cause.');
    }
}

/* ------------------------------------------------------------ the target */

/** host:port/database of a connection URL, never a credential. */
function urlIdentity(raw) {
    try {
        const url = new URL(raw);
        return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
    } catch {
        return null;
    }
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Which database this process's facade will write to, compared with what the
 * manager and the installation record say. On Postgres every statement the
 * reset issues is unqualified, so it reaches only the schema the adapter's
 * search_path selects (the installation's own); no other schema is addressed.
 */
async function resolveTarget({ settings, installation, deps }) {
    const db = deps.db();
    const engine = db.engine;
    const expectedEngine = settings.dbUrl ? 'postgres' : 'sqlite';
    const refuse = (why) => new ManagerError(409, 'FOREIGN_TARGET', 'The database this process would reset is not the one recorded for this installation; nothing was changed.', { reason: why });
    if (engine !== expectedEngine) throw refuse('ENGINE');
    if (installation && installation.database && installation.database.engine !== engine) throw refuse('RECORDED_ENGINE');
    if (installation && installation.roots && path.resolve(installation.roots.data) !== path.resolve(settings.dataDir)) throw refuse('DATA_ROOT');
    let identity;
    if (engine === 'postgres') {
        const facadeUrl = deps.facadeDbUrl();
        const mine = urlIdentity(facadeUrl);
        if (!mine || mine !== urlIdentity(settings.dbUrl)) throw refuse('DATABASE');
        identity = mine;
    } else {
        const storage = await db.describeStorage();
        const resolved = path.resolve(storage.path);
        if (resolved !== path.resolve(settings.sqlitePath)) throw refuse('DATABASE');
        if (installation && installation.roots && installation.database && !installation.database.external) {
            const rel = path.relative(path.resolve(installation.roots.data), resolved);
            if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw refuse('DATA_ROOT');
        }
        identity = resolved;
    }
    return { engine, fingerprint: sha(`${engine}|${identity}`) };
}

/* ----------------------------------------------------------- the barrier */

function createGuard({ settings, fs, now, logger }) {
    const barrier = () => createBarrier({ settings, fs, now, logger });

    function held(ref, ctx) {
        const b = barrier();
        const { doc, problem } = b.store.read();
        const notHeld = (reason, extra = {}) => new ManagerError(409, 'MAINTENANCE_NOT_HELD',
            'Maintenance is not held by that operation and fence; enter maintenance first (maintenance.enter) and pass its operation id and fence.', { reason, ...extra });
        if (problem) throw notHeld('UNREADABLE');
        if (!doc.active) throw notHeld('NOT_ACTIVE');
        if (doc.operationId !== ref.operationId || doc.fence !== ref.fence) throw notHeld('FENCE_MISMATCH');
        if (isStale(doc)) throw notHeld('STALE');
        if (!HELD_PHASES.includes(doc.phase)) throw notHeld('NOT_QUIESCED', { phase: doc.phase });
        const expected = ctx ? b.plannedWriters(ctx) : [];
        const names = new Set([...expected, ...Object.keys(doc.writers || {})]);
        const unacknowledged = [...names].filter(name => !(doc.writers && doc.writers[name] && doc.writers[name].acked === true)).sort();
        if (unacknowledged.length > 0) {
            throw new ManagerError(409, 'WRITER_UNACKNOWLEDGED', 'Not every writer acknowledged the fence; the reset was refused.', { writers: unacknowledged });
        }
        return doc;
    }

    function backupVerified(doc) {
        return (doc.journal || []).some(entry => entry && entry.fence === doc.fence && entry.code === VER_CODE);
    }

    return { barrier, held, backupVerified };
}

/* ------------------------------------------------------------ the preview */

function resolveRoots({ settings, installation }) {
    const rec = installation && installation.roots ? installation.roots : null;
    const cacheDir = rec ? rec.cache : (settings.env.GOOBSTER_CACHE_DIR || runtimePaths.cacheDir);
    return {
        dataDir: rec ? rec.data : settings.dataDir,
        cacheDir,
        extraRoots: rec && rec.uploads ? [rec.uploads] : []
    };
}

function protectedPaths(settings) {
    return [settings.storeDir, settings.dataDir, settings.configPath, settings.sqlitePath, `${settings.sqlitePath}-wal`, `${settings.sqlitePath}-shm`,
        settings.featuresPath, settings.root].filter(Boolean);
}

function buildPlanParts({ settings, installation, scope }) {
    const inventory = inventoryModule.buildInventory(resolveRoots({ settings, installation }));
    let plan;
    try {
        plan = inventoryModule.planScope(inventory, scope);
        inventoryModule.assertFileSetsSafe(plan.files, protectedPaths(settings), inventory.allowedRoots);
    } catch (error) {
        throw mapCoreError(error);
    }
    return { inventory, plan };
}

/**
 * What a reset of `scope` would do, for the CLI's --dry-run and the plan
 * route: names and counts, never a row, plus the text to type. Reads the
 * manager store and the file system only (no database is opened).
 */
function previewReset({ settings, fs = nodeFs, scope: scopeInput }) {
    let scope;
    try {
        scope = inventoryModule.normalizeScope(scopeInput);
    } catch (error) {
        throw mapCoreError(error);
    }
    const { createStore } = require('../../store/installation');
    const installation = createStore({ root: settings.storeDir, fs }).readInstallation();
    const doc = installation.status === 'ok' ? installation.doc : null;
    const { inventory, plan } = buildPlanParts({ settings, installation: doc, scope });
    const fileCounts = {};
    for (const set of plan.files) {
        const count = inventoryModule.countTree(set.path);
        fileCounts[set.id] = { files: count.files, bytes: count.bytes };
    }
    const featureStateActive = (() => {
        if (scope.scope !== 'feature') return null;
        try {
            const { createFeatureState } = require('@goobster/core/features/featureState');
            const { readConfigJson } = require('../../manager');
            return createFeatureState({ filePath: settings.featuresPath, env: settings.env, config: readConfigJson(settings.configPath, fs).config, logger: { warn: () => {} } }).isActive(scope.feature);
        } catch {
            return null;
        }
    })();
    const described = inventoryModule.describePlan(plan, { inventory, installationId: doc ? doc.installationId : null, fileCounts });
    return {
        ...described,
        empty: Boolean(plan.empty),
        featureActive: featureStateActive,
        backup: { required: true, verified: 'table counts, schema fingerprint and file counts', includesConfig: fs.existsSync(settings.configPath), configEncrypted: true },
        boundary: 'The reset needs a held maintenance barrier (maintenance.enter) and runs only after a verified backup; it is irreversible once the mutate phase begins.',
        steps: STEP_NAMES
    };
}

/* ------------------------------------------------------------------ kind */

function createKinds({ settings, fs = nodeFs, now = () => new Date(), logger = console, deps: overrides = {} }) {
    const deps = {
        db: () => facade,
        facadeDbUrl: () => process.env.GOOBSTER_DB_URL || '',
        removeOwned: (target) => paths.removeOwned(target, { codeRoot: settings.root, fs }),
        ...overrides
    };
    const guard = createGuard({ settings, fs, now, logger });

    function readInstallation(ctx) {
        const read = ctx.store.readInstallation();
        if (read.status !== 'ok') throw new ManagerError(409, 'NOT_INSTALLED', 'There is no usable installation record to reset against.');
        return read.doc;
    }

    function isFeatureActive(ctx, feature) {
        try {
            return ctx.createFeatureState().isActive(feature);
        } catch {
            throw new ManagerError(409, 'FEATURE_STATE_UNREADABLE', 'features.json cannot be read, so it is not known whether the feature is active; nothing was changed.');
        }
    }

    function assertBackupDestination(inventory, plan, dir) {
        const resolved = path.resolve(dir);
        for (const set of plan.files) {
            const root = path.resolve(set.path);
            const rel = path.relative(root, resolved);
            if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
                throw new ManagerError(409, 'BACKUP_DESTINATION_UNSAFE', 'The backup destination lies inside data this reset will remove; choose a directory outside it.');
            }
        }
        for (const protectedPath of [settings.storeDir]) {
            const rel = path.relative(path.resolve(protectedPath), resolved);
            if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
                throw new ManagerError(409, 'BACKUP_DESTINATION_UNSAFE', 'The backup destination lies inside the manager store; choose another directory.');
            }
        }
    }

    function checkInput(record, ctx, { atApply }) {
        const privateInput = ctx.input;
        if (!privateInput) {
            throw new ManagerError(409, 'PRIVATE_INPUT_LOST', 'The manager restarted since this plan was made; plan the reset again.');
        }
        if (record.plan.scope === 'instance' && !VIA_FOR_INSTANCE.includes(record.via)) {
            throw new ManagerError(403, 'INSTANCE_RESET_REQUIRES_LOCAL',
                'A full-instance reset needs the recovery credential or the local CLI; a bridge session may purge one dormant feature only.');
        }
        const installation = readInstallation(ctx);
        const expected = inventoryModule.confirmationFor(installation.installationId, record.plan);
        if (privateInput.confirm !== expected) {
            throw new ManagerError(400, 'CONFIRMATION_REQUIRED',
                record.plan.scope === 'feature'
                    ? 'Type the installation id, a colon and the feature id (<installationId>:<feature>) to confirm; nothing was changed.'
                    : 'Type the installation id to confirm; nothing was changed.');
        }
        if (!privateInput.backup.skipConfig && !privateInput.backup.passphrase && fs.existsSync(settings.configPath)) {
            throw mapCoreError({ code: 'PASSPHRASE_REQUIRED' });
        }
        if (record.plan.scope === 'feature' && isFeatureActive(ctx, record.plan.feature)) {
            throw new ManagerError(409, 'FEATURE_ACTIVE', 'That feature is active. Disable it first (features.set), restart, then purge its data; nothing was changed.', { feature: record.plan.feature });
        }
        guard.held(record.plan.maintenance, ctx);
        if (atApply) {
            const doc = guard.barrier().store.read().doc;
            if (record.revision !== null && doc.revision !== record.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The maintenance state changed since this plan was made; plan again.', { expected: record.revision, actual: doc.revision });
            }
        }
        return installation;
    }

    const kind = {
        kind: 'data.reset',
        public: true,
        allowed,
        async plan(input, ctx) {
            const parsed = parseInput(input);
            const installation = readInstallation(ctx);
            const { inventory, plan } = buildPlanParts({ settings, installation, scope: parsed.scope });
            const doc = guard.held(parsed.maintenance, ctx);
            if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== doc.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The maintenance state changed since it was read; read it again.', { expected: parsed.expectedRevision, actual: doc.revision });
            }
            if (parsed.scope.scope === 'feature' && isFeatureActive(ctx, parsed.scope.feature)) {
                throw new ManagerError(409, 'FEATURE_ACTIVE', 'That feature is active. Disable it first (features.set), restart, then purge its data; nothing was changed.', { feature: parsed.scope.feature });
            }
            assertBackupDestination(inventory, plan, parsed.backup.dir);
            const target = await resolveTarget({ settings, installation, deps });
            const described = inventoryModule.describePlan(plan, { inventory });
            return {
                plan: {
                    target: 'installation',
                    effect: 'data-reset',
                    scope: plan.scope,
                    feature: plan.feature,
                    digest: plan.digest,
                    boundary: 'irreversible-after-mutate',
                    maintenance: parsed.maintenance,
                    database: target,
                    tables: {
                        cleared: described.tables.cleared.length,
                        partial: described.tables.partial.length,
                        cascading: described.tables.cascading.length,
                        kept: described.tables.kept.map(entry => entry.table),
                        recreated: described.tables.recreated.map(entry => entry.table)
                    },
                    derived: plan.derived,
                    files: described.files.map(set => ({ id: set.id, owner: set.owner, inBackup: set.inBackup })),
                    keptFiles: plan.keptFiles.map(entry => entry.id),
                    backup: { includesConfig: !parsed.backup.skipConfig && fs.existsSync(settings.configPath), verified: true },
                    resumable: true,
                    steps: STEP_NAMES
                },
                revision: doc.revision,
                privateInput: { confirm: parsed.confirm, backup: parsed.backup }
            };
        },
        async validate(record, ctx) {
            checkInput(record, ctx, { atApply: Boolean(ctx.scratch) });
            const installation = readInstallation(ctx);
            const target = await resolveTarget({ settings, installation, deps });
            if (target.fingerprint !== record.plan.database.fingerprint) {
                throw new ManagerError(409, 'FOREIGN_TARGET', 'The database changed since this plan was made; plan again.', { reason: 'CHANGED' });
            }
            if (ctx.scratch) {
                const { inventory, plan } = buildPlanParts({ settings, installation, scope: record.plan.feature ? { scope: 'feature', feature: record.plan.feature } : { scope: 'instance' } });
                if (plan.digest !== record.plan.digest) {
                    throw new ManagerError(409, 'REVISION_CONFLICT', 'The reset plan changed since it was made; plan again.');
                }
                ctx.scratch.inventory = inventory;
                ctx.scratch.scopePlan = plan;
                ctx.scratch.target = target;
            }
        },
        steps: [
            {
                name: 'preflight',
                async run(record, ctx) {
                    const doc = guard.held(record.plan.maintenance, ctx);
                    ctx.scratch.resumedFrom = PAST_BACKUP.includes(doc.phase) ? doc.phase : null;
                    ctx.scratch.backupVerified = false;
                    if (ctx.scratch.resumedFrom) {
                        if (!guard.backupVerified(doc)) {
                            throw new ManagerError(409, 'BACKUP_UNVERIFIED', 'This barrier has no verified backup on record; release it and start again.');
                        }
                        ctx.scratch.backupVerified = true;
                    }
                    return { phase: doc.phase, resumed: Boolean(ctx.scratch.resumedFrom), scope: record.plan.scope };
                }
            },
            {
                name: 'backup',
                async run(record, ctx) {
                    const ref = record.plan.maintenance;
                    if (ctx.scratch.resumedFrom) return { skipped: true, reason: 'ALREADY_VERIFIED' };
                    const b = guard.barrier();
                    const doc = guard.held(ref, ctx);
                    if (doc.phase === 'quiesced') b.advance({ operationId: ref.operationId, fence: ref.fence, to: 'backup', actor: record.actor });
                    const input = ctx.input.backup;
                    const service = deps.backupService ? deps.backupService() : backupService;
                    let verified;
                    try {
                        const created = await service.createBackup({
                            destDir: input.dir,
                            passphrase: input.passphrase,
                            includeConfig: !input.skipConfig,
                            dataDir: ctx.scratch.inventory.dataDir,
                            configPath: settings.configPath,
                            logger: { info() {}, warn() {}, error() {} }
                        });
                        ctx.scratch.archive = created.dir;
                        verified = service.verifyBackup(created.dir, { expectCounts: await service.tableCounts() });
                    } catch (error) {
                        throw mapBackupError(error);
                    }
                    b.settle({ operationId: ref.operationId, fence: ref.fence, outcome: 'ok', code: VER_CODE, actor: record.actor });
                    ctx.scratch.backupVerified = true;
                    return { verified: true, tables: verified.tables, fileSets: verified.files, configIncluded: Boolean(verified.manifest.config && verified.manifest.config.included) };
                }
            },
            {
                name: 'mutate',
                async run(record, ctx) {
                    const ref = record.plan.maintenance;
                    const b = guard.barrier();
                    const doc = guard.held(ref, ctx);
                    if (!ctx.scratch.backupVerified) throw new ManagerError(409, 'BACKUP_UNVERIFIED', 'No verified backup exists for this reset; nothing was changed.');
                    if (doc.phase === 'backup') b.advance({ operationId: ref.operationId, fence: ref.fence, to: 'mutate', actor: record.actor });
                    let outcome;
                    try {
                        outcome = await (deps.runReset || ((params) => resetModule.runReset(params)))({
                            inventory: ctx.scratch.inventory,
                            scope: record.plan.feature ? { scope: 'feature', feature: record.plan.feature } : { scope: 'instance' },
                            removeOwned: deps.removeOwned,
                            protectedPaths: protectedPaths(settings)
                        });
                    } catch (error) {
                        b.settle({ operationId: ref.operationId, fence: ref.fence, outcome: 'failed', code: 'MUTATE_FAILED', actor: record.actor });
                        if (error instanceof ManagerError) throw error;
                        logger.error?.(`[manager] data.reset mutate failed: ${error && (error.code || error.name)}`);
                        throw new ManagerError(500, 'RESET_FAILED',
                            'The reset stopped part way. The barrier stays up; run data.reset again under it to finish, or release it with acknowledgeMutation and restore the backup.', { phase: 'mutate' });
                    }
                    ctx.scratch.outcome = outcome;
                    b.settle({ operationId: ref.operationId, fence: ref.fence, outcome: 'ok', code: 'MUTATE_DONE', actor: record.actor });
                    return {
                        tables: Object.keys(outcome.tables).length,
                        rows: outcome.rows,
                        vectors: outcome.vectors.before - outcome.vectors.after,
                        files: outcome.files.total,
                        compacted: outcome.compacted
                    };
                }
            },
            {
                name: 'verify',
                async run(record, ctx) {
                    const ref = record.plan.maintenance;
                    const b = guard.barrier();
                    const doc = guard.held(ref, ctx);
                    if (doc.phase === 'mutate') b.advance({ operationId: ref.operationId, fence: ref.fence, to: 'verify', actor: record.actor });
                    const verdict = await resetModule.verifyReset({
                        inventory: ctx.scratch.inventory,
                        scope: record.plan.feature ? { scope: 'feature', feature: record.plan.feature } : { scope: 'instance' }
                    });
                    if (!verdict.ok) {
                        b.settle({ operationId: ref.operationId, fence: ref.fence, outcome: 'failed', code: 'VERIFY_FAILED', actor: record.actor });
                        throw new ManagerError(409, 'VERIFY_FAILED', 'The data left after the reset does not match the plan; the barrier stays up.', { findings: verdict.findings.slice(0, 20) });
                    }
                    b.settle({ operationId: ref.operationId, fence: ref.fence, outcome: 'ok', code: 'VERIFY_DONE', actor: record.actor });
                    return { findings: 0 };
                }
            },
            {
                name: 'cutover',
                async run(record, ctx) {
                    const ref = record.plan.maintenance;
                    const b = guard.barrier();
                    const doc = guard.held(ref, ctx);
                    if (doc.phase === 'verify') b.advance({ operationId: ref.operationId, fence: ref.fence, to: 'cutover', actor: record.actor });
                    let paused = false;
                    if (record.plan.scope === 'instance') {
                        const state = require('@goobster/core/services/instanceStateService');
                        paused = Boolean(await state.getPause());
                        if (!paused) {
                            await state.pause({ reason: resetModule.PAUSE_REASON, by: 'manager', detail: { scope: 'instance' } });
                            paused = true;
                        }
                    }
                    b.settle({ operationId: ref.operationId, fence: ref.fence, outcome: 'ok', code: 'RESET_COMPLETE', actor: record.actor });
                    ctx.scratch.paused = paused;
                    return { paused, released: false };
                }
            }
        ],
        auditDetail(record, scratch) {
            const outcome = scratch.outcome || null;
            return {
                scope: record.plan.scope,
                ...(record.plan.feature ? { feature: record.plan.feature } : {}),
                tables: outcome ? Object.keys(outcome.tables).length : 0,
                files: outcome ? outcome.files.total : 0,
                vectors: outcome ? outcome.vectors.before - outcome.vectors.after : 0,
                backupVerified: scratch.backupVerified === true
            };
        },
        result: scratch => ({
            scope: scratch.scopePlan ? scratch.scopePlan.scope : null,
            feature: scratch.scopePlan ? scratch.scopePlan.feature : null,
            resumed: Boolean(scratch.resumedFrom),
            backup: { verified: scratch.backupVerified === true, archive: scratch.archive || null },
            outcome: scratch.outcome || null,
            paused: scratch.paused === true,
            barrier: 'held',
            next: 'maintenance.release'
        })
    };

    return [kind];
}

function mapBackupError(error) {
    if (error instanceof ManagerError) return error;
    if (error && error.name === 'BackupError') {
        if (error.code === 'PASSPHRASE_REQUIRED') return mapCoreError(error);
        if (error.code === 'UNVERIFIED') return mapCoreError(error);
        return new ManagerError(409, 'BACKUP_FAILED', 'The backup could not be written, so nothing was changed.', { reason: error.code || null });
    }
    return new ManagerError(409, 'BACKUP_FAILED', 'The backup could not be written, so nothing was changed.');
}

module.exports = { createKinds, previewReset, parseInput, resolveTarget, STEP_NAMES, HELD_PHASES };
