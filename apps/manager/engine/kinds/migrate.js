/**
 * The SQLite to Postgres migration's operation kinds
 * (documentation/db_migration.md):
 *
 *   db.migrate.preflight  read-only. Inspects the SQLite source and the
 *                         selected Postgres target without creating anything
 *                         on either; holds no barrier; may run while the
 *                         application is up.
 *   db.migrate            the operation: inside the maintenance barrier,
 *                         after a verified backup, copy, verify, start the
 *                         application on the target under validation, then
 *                         switch the connection. Re-running the same input
 *                         resumes.
 *   db.migrate.rollback   before the first Postgres write: drop exactly what
 *                         the operation created and restore the source
 *                         configuration. Refused after (`POSTGRES_HAS_WRITES`).
 *
 * None is plannable over HTTP (the target URL and the backup passphrase are
 * `privateInput`, in memory only); the CLI plans them in-process and the
 * portal's preflight route runs the read-only one. Nothing here opens an
 * application database: every step that does runs in a child process
 * (../../migration/childEntry.js), the way install/dbInit.js does.
 */

const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const { ManagerError } = require('../../errors');
const files = require('../../store/files');
const environment = require('../../environment');
const { createBarrier, NEXT_PHASES } = require('../../maintenance/barrier');
const registry = require('../../lifecycle/registry');
const { createInstallCore, exactKeys, textField, absolutePath, parseBoolean } = require('../../install/engine');
const { createChildRunner } = require('../../migration/runChild');
const { createMigrationState } = require('../../migration/state');
const { validateOnTarget } = require('../../migration/validation');
const { ROLLBACK_LIMIT } = require('@goobster/core/db/migration');
const { describeTarget, publicTarget } = require('@goobster/core/db/migration/target');
const { MigrationError } = require('@goobster/core/db/migration/errors');

const MIGRATE_STEPS = ['preflight', 'maintenance', 'backup', 'snapshot', 'provision', 'copy', 'verify', 'validate', 'cutover', 'settle', 'release'];
const ROLLBACK_STEPS = ['check', 'revert-switch', 'drop', 'record', 'release'];
const PREFLIGHT_VIA = ['bridge', 'setup', 'recovery', 'local'];
const OPERATION_VIA = ['recovery', 'local'];
const PHASE_RANK = Object.freeze({ quiesced: 0, backup: 1, mutate: 2, verify: 3, cutover: 4 });
const HEX_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_ONLY = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const BOUNDARY = 'before-first-postgres-write';

const preflightAllowed = (state, via) => state.state === 'claimed' && PREFLIGHT_VIA.includes(via);
const operationAllowed = (state, via) => state.state === 'claimed' && OPERATION_VIA.includes(via);

function invalid(message) {
    return new ManagerError(400, 'INVALID_INPUT', message);
}

function parseTarget(value) {
    exactKeys(value, new Set(['url']), '"target"');
    const url = textField(value.url, 'target.url', { max: 2048 });
    let description;
    try {
        description = describeTarget(url);
    } catch (error) {
        throw invalid(error instanceof MigrationError ? error.message : 'The target is not a Postgres connection URL.');
    }
    return { url, description };
}

function parseMaintenance(value) {
    if (value === undefined) return null;
    exactKeys(value, new Set(['operationId', 'fence']), '"maintenance"');
    if (typeof value.operationId !== 'string' || !HEX_ID.test(value.operationId)) throw invalid('"maintenance.operationId" must be the id maintenance.enter returned.');
    if (!Number.isInteger(value.fence) || value.fence < 1) throw invalid('"maintenance.fence" must be the fence maintenance.enter returned.');
    return { operationId: value.operationId, fence: value.fence };
}

function parseMigrateInput(input, { fs, settings }) {
    exactKeys(input, new Set(['target', 'backup', 'provision', 'confirm', 'maintenance', 'expectedRevision', 'roots', 'release']));
    const target = parseTarget(input.target);
    exactKeys(input.backup, new Set(['dir', 'passphrase', 'skipConfig']), '"backup"');
    const skipConfig = parseBoolean(input.backup.skipConfig, 'backup.skipConfig', false);
    const dir = absolutePath(input.backup.dir, 'backup.dir');
    let passphrase = null;
    if (input.backup.passphrase !== undefined) passphrase = textField(input.backup.passphrase, 'backup.passphrase', { max: 1024 });
    if (!skipConfig && !passphrase && fs.existsSync(settings.configPath)) {
        throw invalid('config.json holds secrets and is only ever archived encrypted: give "backup.passphrase", or set "backup.skipConfig".');
    }
    let provisionExtensions = false;
    if (input.provision !== undefined) {
        exactKeys(input.provision, new Set(['extensions']), '"provision"');
        provisionExtensions = parseBoolean(input.provision.extensions, 'provision.extensions', false);
    }
    const confirm = input.confirm === undefined ? null : textField(input.confirm, 'confirm', { max: 200 });
    let dataRoot = null;
    if (input.roots !== undefined) {
        exactKeys(input.roots, new Set(['data']), '"roots"');
        dataRoot = absolutePath(input.roots.data, 'roots.data');
    }
    const expectedRevision = input.expectedRevision;
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) throw invalid('"expectedRevision" must be a non-negative integer.');
    return {
        target,
        backup: { dir, passphrase, skipConfig },
        provisionExtensions,
        confirm,
        maintenance: parseMaintenance(input.maintenance),
        dataRoot,
        expectedRevision,
        release: parseBoolean(input.release, 'release', false)
    };
}

function parseRollbackInput(input) {
    exactKeys(input, new Set(['target', 'confirm', 'releaseMaintenance']));
    const target = input.target === undefined ? null : parseTarget(input.target);
    return {
        target,
        confirm: input.confirm === undefined ? null : textField(input.confirm, 'confirm', { max: 200 }),
        releaseMaintenance: parseBoolean(input.releaseMaintenance, 'releaseMaintenance', false)
    };
}

function codeOf(error) {
    return error && typeof error.code === 'string' && CODE_ONLY.test(error.code) ? error.code : 'STEP_FAILED';
}

/** Names, counts and booleans of an inspection, never a path or a URL. */
function sanitizeReport(report) {
    return {
        source: report.source,
        target: report.target ? {
            ...publicTarget(report.target),
            reachable: report.target.reachable,
            serverVersion: report.target.serverVersion ?? null,
            schemaExists: report.target.schemaExists ?? null,
            relationCount: report.target.relationCount ?? null,
            canCreateInSchema: report.target.canCreateInSchema ?? null,
            extensions: report.target.extensions || {},
            freeBytes: report.target.freeBytes ?? null
        } : null,
        blocks: report.blocks,
        provisioning: report.provisioning,
        warnings: report.warnings,
        estimate: report.estimate
    };
}

function createKinds({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const core = createInstallCore({ settings, fs, now, logger });
    const deps = () => settings.migrationDeps || {};
    const runChild = (...args) => (deps().runChild || createChildRunner({ settings, ...(deps().spawn ? { spawn: deps().spawn } : {}) }))(...args);
    const barrier = () => createBarrier({ settings, fs, now, logger, ...(deps().barrier || {}) });
    const state = () => createMigrationState({ storeDir: settings.storeDir, fs, now });
    const emit = (event) => { try { deps().onProgress?.(event); } catch { } };
    const stamp = () => now().toISOString();

    const needInput = (ctx) => {
        if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
        return ctx.input;
    };

    /** An environment-variable override of the connection the overlay would write. */
    function overrideWarning() {
        return settings.environment && Array.isArray(settings.environment.overridden) && settings.environment.overridden.includes('GOOBSTER_DB_URL')
            ? [{ code: 'ENV_OVERRIDES_OVERLAY', detail: 'GOOBSTER_DB_URL is set in the process environment and differs from the manager overlay; the workers see the environment value.' }]
            : [];
    }

    async function inspect(url, { alreadyPostgres = false } = {}) {
        const report = await runChild('inspect', { sqlitePath: settings.sqlitePath, url, integrity: 'quick', alreadyPostgres });
        return report;
    }

    function findingCodes(items) {
        return [...new Set(items.map(item => item.code))];
    }

    // =========================================================== preflight
    const preflightKind = {
        kind: 'db.migrate.preflight',
        public: false,
        allowed: preflightAllowed,
        plan(input, ctx) {
            exactKeys(input, new Set(['target']));
            const target = parseTarget(input.target);
            const doc = core.ownedInstall(ctx, { requireManaged: false });
            return {
                plan: {
                    target: 'database',
                    effect: 'migrate-preflight',
                    boundary: 'read-only',
                    database: { fingerprint: target.description.fingerprint },
                    steps: [{ name: 'inspect' }]
                },
                revision: doc.revision ?? null,
                privateInput: { url: target.url, description: target.description }
            };
        },
        steps: [
            {
                name: 'inspect',
                async run(record, ctx) {
                    const input = needInput(ctx);
                    const doc = core.ownedInstall(ctx, { requireManaged: false });
                    const already = Boolean(settings.dbUrl) || (doc.database && doc.database.engine === 'postgres');
                    const raw = await inspect(input.url, { alreadyPostgres: already });
                    const report = sanitizeReport(raw);
                    report.warnings = [...report.warnings, ...overrideWarning()];
                    ctx.scratch.report = report;
                    return { blocks: report.blocks.length, provisioning: report.provisioning.length, warnings: report.warnings.length };
                }
            }
        ],
        result: scratch => scratch.report ? {
            ready: scratch.report.blocks.length === 0,
            ...scratch.report,
            rollbackLimit: ROLLBACK_LIMIT
        } : null
    };

    // ============================================================ migrate
    function checkRecord(doc, parsed, settingsNow) {
        if (parsed.dataRoot && doc.roots && parsed.dataRoot !== doc.roots.data) {
            throw new ManagerError(409, 'ROOT_NOT_MOVABLE', 'The data root differs from the recorded one; a migration never moves files. Use install.reconfigure first.');
        }
        if ((doc.database && doc.database.engine === 'postgres') || settingsNow.dbUrl) {
            throw new ManagerError(409, 'ALREADY_POSTGRES', 'This installation already uses Postgres. A migration only goes from SQLite to Postgres; there is no reverse path.');
        }
    }

    function signatureFor(doc, description) {
        return core.signatureOf(['db.migrate', doc.installationId, description.fingerprint]);
    }

    function stateConflict(signature) {
        const { doc, problem } = state().read();
        if (problem) throw new ManagerError(409, 'MIGRATION_STATE_UNREADABLE', 'migration.json in the manager store cannot be read; it was left as it is.', { problem });
        if (!doc) return null;
        if (doc.status === 'switched') {
            throw new ManagerError(409, 'ALREADY_MIGRATED', 'This installation was already switched to Postgres by a migration.');
        }
        if ((doc.status === 'running' || doc.status === 'failed') && doc.signature !== signature) {
            throw new ManagerError(409, 'MIGRATION_IN_PROGRESS', 'An earlier migration to another target left a partial state; roll it back (db.migrate.rollback) first.');
        }
        return doc.status === 'rolled-back' ? null : doc;
    }

    /** What must hold for the barrier the caller says it holds. */
    function heldBarrier(maintenance) {
        const view = barrier().view();
        if (!view.active || view.operationId !== maintenance.operationId || view.fence !== maintenance.fence) {
            throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier is not held with that operation id and fence; enter maintenance first.');
        }
        if (view.stale) throw new ManagerError(409, 'STALE_MAINTENANCE', 'The barrier was left by an earlier manager process and is never resumed automatically.');
        if (!(view.phase in PHASE_RANK)) throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier is not quiesced yet.');
        const writers = Object.entries(view.writers || {});
        if (writers.length === 0 || writers.some(([, info]) => info.acked !== true)) {
            throw new ManagerError(409, 'WRITER_UNACKNOWLEDGED', 'Not every writer acknowledged the fence; the application may still be writing.');
        }
        return view;
    }

    function ensurePhase(op, target, actor) {
        const view = barrier().view();
        if (!view.active || view.operationId !== op.operationId || view.fence !== op.fence) {
            throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier is no longer held by this operation.');
        }
        if ((PHASE_RANK[view.phase] ?? -1) >= PHASE_RANK[target]) return view.phase;
        if (!(NEXT_PHASES[view.phase] || []).includes(target)) {
            throw new ManagerError(409, 'PHASE_NOT_ALLOWED', `The barrier cannot move from ${view.phase} to ${target}.`);
        }
        barrier().advance({ operationId: op.operationId, fence: op.fence, to: target, actor });
        return target;
    }

    function migrateKind() {
        function buildPlan(input, ctx) {
            const parsed = parseMigrateInput(input, { fs, settings });
            const doc = core.ownedInstall(ctx);
            checkRecord(doc, parsed, settings);
            if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== doc.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since it was read; read it again.', { expected: parsed.expectedRevision, actual: doc.revision });
            }
            const signature = signatureFor(doc, parsed.target.description);
            const existing = stateConflict(signature);
            const plan = {
                target: 'installation',
                effect: 'migrate-database',
                from: 'sqlite',
                to: 'postgres',
                database: { fingerprint: parsed.target.description.fingerprint },
                signature,
                boundary: 'cancel-safe-until-copy',
                maintenance: parsed.maintenance ? { mode: 'held', operationId: parsed.maintenance.operationId, fence: parsed.maintenance.fence } : { mode: 'enter' },
                backup: { configIncluded: !parsed.backup.skipConfig },
                provision: { extensions: parsed.provisionExtensions },
                release: parsed.release,
                confirmation: { required: true, satisfied: parsed.confirm === doc.installationId },
                resumeOf: existing ? { migrationId: existing.id, status: existing.status, completed: Object.keys(existing.steps || {}).filter(name => existing.steps[name].done) } : null,
                rollbackLimit: ROLLBACK_LIMIT,
                steps: MIGRATE_STEPS.map(name => ({ name }))
            };
            return { plan, doc, parsed };
        }

        return {
            kind: 'db.migrate',
            public: false,
            allowed: operationAllowed,
            plan(input, ctx) {
                const { plan, doc, parsed } = buildPlan(input, ctx);
                return { plan, revision: doc.revision, privateInput: { parsed, raw: input } };
            },
            async validate(record, ctx) {
                const input = needInput(ctx);
                const { parsed } = input;
                const doc = core.ownedInstall(ctx);
                if (doc.revision !== record.revision) {
                    throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since this plan was made; plan again.', { expected: record.revision, actual: doc.revision });
                }
                checkRecord(doc, parsed, settings);
                stateConflict(record.plan.signature);
                if (parsed.confirm !== doc.installationId) {
                    throw new ManagerError(400, 'CONFIRMATION_REQUIRED', 'A migration needs "confirm" to be the installation id; nothing was changed.');
                }
                if (parsed.maintenance) heldBarrier(parsed.maintenance);
                else barrier().assertEnterable();
            },
            steps: stepsFor(),
            result: scratch => scratch.result || null,
            auditDetail: scratch => scratch.audit || null
        };
    }

    function stepsFor() {
        const book = (record, name, status) => emit({ event: 'step', step: name, status, operationId: record.id });

        /** Run a step body; on failure record it in the migration state and, if the barrier is ours and cancel-safe, give it back. */
        function guarded(name, body) {
            return {
                name,
                async run(record, ctx) {
                    book(record, name, 'started');
                    try {
                        const out = await body(record, ctx, needInput(ctx).parsed);
                        book(record, name, out && out.skipped ? 'skipped' : 'done');
                        return out;
                    } catch (error) {
                        const code = codeOf(error);
                        book(record, name, 'failed');
                        state().update(next => ({ ...next, status: next.status === 'switched' ? 'switched' : 'failed', failure: { step: name, code, at: stamp() } }));
                        await abandonIfCancelSafe(record, ctx, code);
                        throw error;
                    }
                }
            };
        }

        async function abandonIfCancelSafe(record, ctx, code) {
            const op = ctx.scratch.maintenance;
            if (!op) return;
            try {
                const view = barrier().view();
                if (!view.active || view.operationId !== op.operationId) return;
                if (view.mutateBegun) {
                    barrier().settle({ operationId: op.operationId, fence: op.fence, outcome: 'failed', code, actor: record.actor });
                    return;
                }
                if (op.entered) await barrier().release({ operationId: op.operationId, fence: op.fence, actor: record.actor });
            } catch { }
        }

        function stepDone(name) {
            const { doc } = state().read();
            return doc && doc.steps && doc.steps[name] && doc.steps[name].done === true ? doc.steps[name] : null;
        }

        function markStep(name, fields) {
            return state().update(next => ({ ...next, steps: { ...next.steps, [name]: { ...(next.steps && next.steps[name]), ...fields, done: fields.done !== false, at: stamp() } } }));
        }

        return [
            guarded('preflight', async (record, ctx, parsed) => {
                const doc = core.ownedInstall(ctx);
                const store = state();
                const { doc: existing } = store.read();
                const resuming = existing && existing.signature === record.plan.signature && ['running', 'failed'].includes(existing.status);
                const raw = await inspect(parsed.target.url, { alreadyPostgres: false });
                let blocks = raw.blocks;
                let provisioning = raw.provisioning;
                if (resuming && existing.steps && existing.steps.provision) {
                    blocks = blocks.filter(item => !['TARGET_NOT_EMPTY', 'EXTENSION_UNAVAILABLE', 'EXTENSION_PRIVILEGE'].includes(item.code));
                    provisioning = [];
                }
                const unallowed = provisioning.filter(item => item.code === 'EXTENSION_NOT_INSTALLED' && !parsed.provisionExtensions);
                if (unallowed.length > 0) {
                    blocks = [...blocks, ...unallowed.map(item => ({ code: 'PROVISIONING_NOT_ALLOWED', detail: `extension ${item.extension} is not installed; allow provision.extensions to create it` }))];
                }
                if (blocks.length > 0) {
                    throw new ManagerError(409, 'PREFLIGHT_FAILED', `Preflight found ${blocks.length} problem${blocks.length === 1 ? '' : 's'} that stop the migration: ${findingCodes(blocks).join(', ')}.`,
                        { findings: blocks.map(item => ({ code: item.code, detail: item.detail })) });
                }
                const intent = provisioning.filter(item => item.code === 'EXTENSION_NOT_INSTALLED').map(item => item.extension);
                const base = {
                    version: 1,
                    id: resuming ? existing.id : `mig_${crypto.randomBytes(6).toString('hex')}`,
                    status: 'running',
                    signature: record.plan.signature,
                    installationId: doc.installationId,
                    previousDatabase: doc.database || { engine: 'sqlite', external: false },
                    target: publicTarget(parsed.target.description),
                    startedAt: resuming ? existing.startedAt : stamp(),
                    steps: resuming ? existing.steps || {} : {},
                    provisioning: resuming && existing.provisioning ? existing.provisioning : intent,
                    maintenance: resuming ? existing.maintenance : null,
                    resumes: resuming ? (existing.resumes || 0) + 1 : 0,
                    failure: null
                };
                store.write({ ...base, steps: { ...base.steps, preflight: { done: true, at: stamp() } } });
                ctx.scratch.warnings = overrideWarning();
                return { blocks: 0, provisioning: intent.length, tables: raw.estimate.tables, rows: raw.estimate.rows, resumed: Boolean(resuming) };
            }),

            guarded('maintenance', async (record, ctx, parsed) => {
                const store = state();
                if (parsed.maintenance) {
                    heldBarrier(parsed.maintenance);
                    ctx.scratch.maintenance = { ...parsed.maintenance, entered: false };
                    store.update(next => ({ ...next, maintenance: { ...parsed.maintenance, entered: false } }));
                    return { mode: 'held', fence: parsed.maintenance.fence };
                }
                const b = barrier();
                const previous = store.read().doc.maintenance;
                if (previous && previous.entered) {
                    const view = b.view();
                    if (view.active && view.operationId === previous.operationId && view.fence === previous.fence && !view.stale) {
                        heldBarrier(previous);
                        ctx.scratch.maintenance = { ...previous };
                        return { mode: 'reused', fence: previous.fence };
                    }
                }
                const resolved = await b.preflight({ actor: record.actor, ctx });
                const { fence } = b.begin({ operationId: record.id, actor: record.actor, via: record.via, reason: 'migration' });
                ctx.scratch.maintenance = { operationId: record.id, fence, entered: true };
                const out = await b.quiesce({ operationId: record.id, fence, resolved, timeoutSeconds: 120, actor: record.actor });
                await b.verify({ operationId: record.id, fence, resolved, writers: out.writers, sent: out.sent, actor: record.actor });
                store.update(next => ({ ...next, maintenance: { operationId: record.id, fence, entered: true } }));
                return { mode: 'entered', fence, writers: Object.keys(out.writers) };
            }),

            guarded('backup', async (record, ctx, parsed) => {
                const done = stepDone('backup');
                if (done) return { skipped: true, code: 'ALREADY_DONE' };
                ensurePhase(ctx.scratch.maintenance, 'backup', record.actor);
                const result = await runChild('backup', {
                    destDir: parsed.backup.dir,
                    passphrase: parsed.backup.passphrase,
                    includeConfig: !parsed.backup.skipConfig
                }, { sqlitePath: settings.sqlitePath });
                if (!result.verified) {
                    throw new ManagerError(409, 'BACKUP_UNVERIFIED', 'The backup could not be verified against the live database; nothing was changed. Fix the backup destination and run again.',
                        { fingerprintMatches: result.fingerprintMatches, tables: result.mismatchedTables });
                }
                markStep('backup', { archive: result.archive, verified: true, tables: result.tables, rows: result.rows, configIncluded: result.configIncluded, files: result.files });
                return { archive: result.archive, verified: true, tables: result.tables, rows: result.rows, configIncluded: result.configIncluded };
            }),

            guarded('snapshot', async () => {
                const result = await runChild('snapshot', { sqlitePath: settings.sqlitePath });
                const before = stepDone('snapshot');
                if (before && before.sha256 !== result.sha256) {
                    throw new ManagerError(409, 'SOURCE_CHANGED', 'The SQLite source changed since this migration took its snapshot. Roll the migration back (db.migrate.rollback) and start again.');
                }
                if (before) return { skipped: true, code: 'ALREADY_DONE', sha256: result.sha256.slice(0, 16) };
                markStep('snapshot', { sha256: result.sha256, bytes: result.bytes, tables: result.tables, rows: result.rows });
                return { sha256: result.sha256, bytes: result.bytes, tables: result.tables, rows: result.rows, integrity: result.integrity };
            }),

            guarded('provision', async (record, ctx, parsed) => {
                const store = state();
                const { doc } = store.read();
                if (doc.steps.provision && doc.steps.provision.done) return { skipped: true, code: 'ALREADY_DONE' };
                const intent = doc.provisioning || [];
                store.update(next => ({ ...next, steps: { ...next.steps, provision: { ...(next.steps.provision || {}), done: false, extensionsIntent: intent, at: stamp() } } }));
                const ext = await runChild('extensions', { url: parsed.target.url, extensions: parsed.provisionExtensions ? intent : [], expectEmpty: !(doc.steps.provision && doc.steps.provision.started) }, { url: parsed.target.url });
                store.update(next => ({ ...next, steps: { ...next.steps, provision: { ...next.steps.provision, started: true, extensionsCreated: ext.extensionsCreated, schema: ext.schema } } }));
                const applied = await runChild('schema', {}, { url: parsed.target.url });
                markStep('provision', { done: true, started: true, extensionsIntent: intent, extensionsCreated: ext.extensionsCreated, schema: applied.schema, tables: applied.tables.length, createdTables: applied.tables });
                return { extensionsCreated: ext.extensionsCreated, tables: applied.tables.length };
            }),

            guarded('copy', async (record, ctx, parsed) => {
                const snapshot = stepDone('snapshot');
                ensurePhase(ctx.scratch.maintenance, 'mutate', record.actor);
                const result = await runChild('copy', { sqlitePath: settings.sqlitePath, progressFile: state().progressFile, sourceSha256: snapshot.sha256 }, {
                    url: parsed.target.url,
                    onEvent: event => emit({ ...event, event: 'table' })
                });
                markStep('copy', { tables: result.tables, rows: result.rows, resumed: result.resumed, recopied: result.recopied, skipped: (result.skipped || []).length });
                return { tables: result.tables, rows: result.rows, resumed: result.resumed, recopied: result.recopied };
            }),

            guarded('verify', async (record, ctx, parsed) => {
                const snapshot = stepDone('snapshot');
                ensurePhase(ctx.scratch.maintenance, 'verify', record.actor);
                const report = await runChild('verify', { sqlitePath: settings.sqlitePath, dataDir: settings.dataDir, sourceSha256: snapshot.sha256 }, { url: parsed.target.url });
                const summary = {
                    ok: report.ok,
                    tables: report.tables,
                    rows: report.rows,
                    foreignKeys: report.foreignKeys && report.foreignKeys.checked,
                    identities: report.identities && report.identities.checked,
                    relationships: report.relationships && report.relationships.checked,
                    sampled: report.content && report.content.rowsCompared,
                    attachments: report.attachments && report.attachments.checked,
                    vectorsIndexed: report.vectors && report.vectors.indexed
                };
                if (!report.ok || report.unchangedSource === false) {
                    state().update(next => ({ ...next, steps: { ...next.steps, verify: { done: false, ok: false, at: stamp(), failures: report.failures } } }));
                    throw new ManagerError(409, 'VERIFY_FAILED', `The copy did not verify: ${(report.failures || ['SOURCE_CHANGED']).join(', ')}. The source configuration was not changed.`, {
                        failures: report.failures,
                        counts: report.counts && report.counts.mismatched,
                        foreignKeys: report.foreignKeys && report.foreignKeys.orphans,
                        identities: report.identities && report.identities.problems,
                        content: report.content && report.content.mismatches
                    });
                }
                markStep('verify', { ...Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined && value !== null)), vectors: summary.vectorsIndexed ?? 0 });
                ctx.scratch.verify = { ...summary, vectorsAvailable: report.vectors ? report.vectors.available : null };
                return summary;
            }),

            guarded('validate', async (record, ctx, parsed) => {
                const before = await runChild('targetCounts', {}, { url: parsed.target.url });
                const validate = deps().validate || validateOnTarget;
                const out = await validate({ settings, url: parsed.target.url, fs, ...(deps().validation || {}) });
                const after = await runChild('targetCounts', {}, { url: parsed.target.url });
                const changed = Object.keys({ ...before.counts, ...after.counts }).filter(table => !table.startsWith('memory_vec_') && before.counts[table] !== after.counts[table]);
                if (changed.length > 0) {
                    throw new ManagerError(409, 'VALIDATION_WROTE', 'A table on the target changed while the application was started under validation; the fence did not hold. The source configuration was not changed.', { tables: changed.slice(0, 20) });
                }
                markStep('validate', { workers: out.workers.map(item => `${item.name}:${item.healthy ? 'healthy' : 'unhealthy'}`), unchanged: true });
                return { workers: out.workers.map(item => item.name), layout: out.layout, unchanged: true };
            }),

            guarded('cutover', async (record, ctx, parsed) => {
                const store = state();
                const { doc: current } = store.read();
                if (current.status === 'switched') return { skipped: true, code: 'ALREADY_DONE' };
                ensurePhase(ctx.scratch.maintenance, 'cutover', record.actor);
                await runChild('finalize', { summary: { tables: current.steps.copy.tables, rows: current.steps.copy.rows } }, { url: parsed.target.url });
                store.update(next => ({ ...next, cutover: { phase: 'switching', at: stamp() } }));
                const existing = environment.read(settings.storeDir, fs).values;
                const values = { ...existing, GOOBSTER_DB_URL: parsed.target.url };
                environment.write(settings.storeDir, values, { fs, now });
                await deps().afterSwitchWrite?.();
                const doc = core.ownedInstall(ctx);
                ctx.store.updateInstallation(draft => ({ ...draft, database: { engine: 'postgres', external: true } }), { expectedRevision: doc.revision });
                environment.apply(settings, values);
                const copy = current.steps.copy || {};
                const verify = current.steps.verify || {};
                const summary = {
                    tables: copy.tables ?? 0,
                    rows: copy.rows ?? 0,
                    vectors: verify.vectors ?? 0,
                    provisioned: Boolean((current.steps.provision?.extensionsCreated || []).length > 0),
                    backupVerified: true
                };
                store.update(next => ({
                    ...next,
                    status: 'switched',
                    switchedAt: stamp(),
                    cutover: { phase: 'done', at: stamp() },
                    result: { ...summary, rollbackBoundary: BOUNDARY, finalTarget: next.target },
                    failure: null
                }));
                ctx.scratch.audit = summary;
                const restarted = restartWorkers();
                return { ...summary, workersRestarted: restarted, rollbackBoundary: BOUNDARY };
            }),

            guarded('settle', async (record, ctx) => {
                const op = ctx.scratch.maintenance;
                barrier().settle({ operationId: op.operationId, fence: op.fence, outcome: 'ok', actor: record.actor });
                const view = barrier().view();
                const { doc } = state().read();
                ctx.scratch.result = {
                    migrationId: doc.id,
                    status: 'switched',
                    ...doc.result,
                    maintenance: { operationId: op.operationId, fence: op.fence, phase: view.phase, enteredByMigration: op.entered },
                    instancePaused: true,
                    workersMode: settings.workersMode,
                    rollbackLimit: ROLLBACK_LIMIT,
                    warnings: ctx.scratch.warnings || []
                };
                ctx.scratch.audit = ctx.scratch.audit || { tables: doc.result.tables, rows: doc.result.rows, vectors: doc.result.vectors, provisioned: doc.result.provisioned, backupVerified: true };
                return { phase: view.phase };
            }),

            guarded('release', async (record, ctx, parsed) => {
                if (!parsed.release) return { skipped: true, code: 'NOT_REQUESTED' };
                const op = ctx.scratch.maintenance;
                const out = await barrier().release({ operationId: op.operationId, fence: op.fence, actor: record.actor });
                ctx.scratch.result.maintenance = { ...ctx.scratch.result.maintenance, released: true };
                return { outcome: out.outcome };
            })
        ];
    }

    /** After the switch the workers must start on the new connection; they boot fenced because the barrier is still up. */
    function restartWorkers() {
        try {
            const running = deps().supervisor || registry.get(settings.storeDir);
            if (!running || typeof running.operatorRestart !== 'function') return false;
            running.operatorRestart();
            return true;
        } catch {
            return false;
        }
    }

    // ============================================================ rollback
    function rollbackKind() {
        function refusal(doc) {
            const store = state();
            if (!doc) return new ManagerError(409, 'NOTHING_TO_ROLL_BACK', 'There is no migration to roll back.');
            if (doc.status === 'rolled-back') return new ManagerError(409, 'NOTHING_TO_ROLL_BACK', 'The migration was already rolled back.');
            if (store.acceptedWrites(doc)) return new ManagerError(409, 'POSTGRES_HAS_WRITES', ROLLBACK_LIMIT);
            return null;
        }

        return {
            kind: 'db.migrate.rollback',
            public: false,
            allowed: operationAllowed,
            plan(input, ctx) {
                const parsed = parseRollbackInput(input);
                const doc = core.ownedInstall(ctx, { requireManaged: false });
                const { doc: migration, problem } = state().read();
                if (problem) throw new ManagerError(409, 'MIGRATION_STATE_UNREADABLE', 'migration.json in the manager store cannot be read; it was left as it is.', { problem });
                const refused = refusal(migration);
                if (refused) throw refused;
                const needsTarget = Boolean(migration.steps && migration.steps.provision);
                if (needsTarget && !parsed.target) throw invalid('"target.url" is needed to drop what the migration created on the target.');
                if (parsed.target && parsed.target.description.fingerprint !== migration.target.fingerprint) {
                    throw new ManagerError(409, 'TARGET_MISMATCH', 'The target is not the one this migration used; nothing was changed.');
                }
                const provision = (migration.steps && migration.steps.provision) || {};
                return {
                    plan: {
                        target: 'database',
                        effect: 'migrate-rollback',
                        migrationId: migration.id,
                        wasSwitched: migration.status === 'switched',
                        boundary: BOUNDARY,
                        drops: { tables: (provision.createdTables || []).length, extensions: provision.extensionsCreated || [] },
                        releaseMaintenance: parsed.releaseMaintenance,
                        confirmation: { required: true, satisfied: parsed.confirm === doc.installationId },
                        rollbackLimit: ROLLBACK_LIMIT,
                        steps: ROLLBACK_STEPS.map(name => ({ name }))
                    },
                    revision: doc.revision ?? null,
                    privateInput: { parsed }
                };
            },
            validate(record, ctx) {
                const input = needInput(ctx);
                const doc = core.ownedInstall(ctx, { requireManaged: false });
                const { doc: migration } = state().read();
                const refused = refusal(migration);
                if (refused) throw refused;
                if (input.parsed.confirm !== doc.installationId) {
                    throw new ManagerError(400, 'CONFIRMATION_REQUIRED', 'A rollback drops what the migration created on the target; "confirm" must be the installation id. Nothing was changed.');
                }
            },
            steps: [
                {
                    name: 'check',
                    run(record) {
                        const { doc } = state().read();
                        const refused = refusal(doc);
                        if (refused) throw refused;
                        return { migrationId: doc.id, switched: doc.status === 'switched' };
                    }
                },
                {
                    name: 'revert-switch',
                    run(record, ctx) {
                        const store = state();
                        const { doc } = store.read();
                        if (doc.status !== 'switched' && !(doc.cutover && doc.cutover.phase === 'switching')) return { skipped: true, code: 'NOT_SWITCHED' };
                        const existing = environment.read(settings.storeDir, fs).values;
                        const { GOOBSTER_DB_URL: dropped, ...rest } = existing;
                        if (Object.keys(rest).length > 0) environment.write(settings.storeDir, rest, { fs, now });
                        else environment.remove(settings.storeDir, fs);
                        environment.apply(settings, rest);
                        const installation = core.ownedInstall(ctx, { requireManaged: false });
                        if (installation.database && installation.database.engine === 'postgres') {
                            ctx.store.updateInstallation(draft => ({ ...draft, database: doc.previousDatabase || { engine: 'sqlite', external: false } }));
                        }
                        store.update(next => ({ ...next, status: 'failed', cutover: { phase: 'reverted', at: stamp() }, result: null, failure: { step: 'rollback', code: 'ROLLED_BACK_SWITCH', at: stamp() } }));
                        ctx.scratch.reverted = true;
                        return { reverted: Boolean(dropped) };
                    }
                },
                {
                    name: 'drop',
                    async run(record, ctx) {
                        const { doc } = state().read();
                        const provision = doc.steps && doc.steps.provision;
                        if (!provision) return { skipped: true, code: 'NOTHING_CREATED' };
                        const input = needInput(ctx).parsed;
                        const dropped = await runChild('rollback', {
                            url: input.target.url,
                            tables: provision.createdTables || [],
                            allOurs: !provision.createdTables,
                            extensions: provision.extensionsCreated || provision.extensionsIntent || [],
                            schema: provision.schema
                        }, { url: input.target.url });
                        ctx.scratch.dropped = dropped;
                        return { tables: dropped.tables, derived: dropped.derived, extensions: dropped.extensions, retained: dropped.retained };
                    }
                },
                {
                    name: 'record',
                    run(record, ctx) {
                        const store = state();
                        store.update(next => ({ ...next, status: 'rolled-back', rolledBackAt: stamp(), cutover: null, failure: null, steps: {}, result: null }));
                        files.removeIfPresent(store.progressFile, fs);
                        ctx.scratch.result = { rolledBack: true, switchReverted: Boolean(ctx.scratch.reverted), dropped: ctx.scratch.dropped || { tables: 0, derived: 0, extensions: [], retained: [] }, rollbackLimit: ROLLBACK_LIMIT };
                        ctx.scratch.audit = { tables: (ctx.scratch.dropped || {}).tables || 0, switchReverted: Boolean(ctx.scratch.reverted) };
                        if (ctx.scratch.reverted) ctx.scratch.result.workersRestarted = restartWorkers();
                        return { rolledBack: true };
                    }
                },
                {
                    name: 'release',
                    async run(record, ctx) {
                        const input = needInput(ctx).parsed;
                        const { doc } = state().read();
                        const held = doc && doc.maintenance;
                        if (!input.releaseMaintenance || !held) return { skipped: true, code: 'NOT_REQUESTED' };
                        const view = barrier().view();
                        if (!view.active || view.operationId !== held.operationId) return { skipped: true, code: 'NOT_HELD' };
                        const out = await barrier().release({ operationId: held.operationId, fence: held.fence, force: view.stale, acknowledgeMutation: true, actor: record.actor });
                        ctx.scratch.result.maintenanceReleased = true;
                        return { outcome: out.outcome, forced: out.forced };
                    }
                }
            ],
            result: scratch => scratch.result || null,
            auditDetail: scratch => scratch.audit || null
        };
    }

    return [preflightKind, migrateKind(), rollbackKind()];
}

module.exports = { createKinds, parseMigrateInput, parseRollbackInput, MIGRATE_STEPS, ROLLBACK_STEPS, BOUNDARY };
