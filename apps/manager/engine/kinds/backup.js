/**
 * Backup and restore as manager operations (documentation/backup_and_restore.md).
 *
 *   backup.create    write an archive and verify it. A backup only reads the
 *                    application, so it needs no barrier; when one is held
 *                    the backup runs inside it and is compared with the live
 *                    row counts (a live one is checked for completeness only).
 *   backup.restore   replace the database, the file sets and (when the
 *                    passphrase opens it) config.json from an archive,
 *                    inside the maintenance barrier. The instance comes back
 *                    paused and the barrier stays up until it is released:
 *                    maintenance is not paused (ADR 0013 decision 11).
 *
 * Input allow-lists:
 *
 *   backup.create   { dir, includeConfig?, passphrase?, expectedRevision? }
 *   backup.restore  { dir, confirm, withoutConfig?, passphrase?, acceptSchemaChange?,
 *                     safetyDir?, maintenance?: { operationId, fence }, release?,
 *                     expectedRevision? }
 *
 * The passphrase and the typed confirmation stay in memory (`privateInput`):
 * a restart between plan and apply is `PLAN_INPUT_LOST`. The plan, the
 * journal, the audit row and the result carry names, counts, booleans and
 * the operator's own locations - never a passphrase and never a value out of
 * config.json. The audit detail is numbers and flags only.
 *
 * Nothing here opens an application database: every step that does runs in a
 * helper process (../../backup/childEntry.js).
 *
 * Restore steps, and what a failure leaves behind:
 *
 *   preflight    the archive is whole, made by this engine and schema (or the
 *                change is accepted), the target is this installation's, a
 *                passphrase opens config.json (decrypted in memory only), and
 *                the typed confirmation matches. Nothing has changed.
 *   maintenance  holds (or enters) the barrier, `quiesced`.
 *   backup       a target that holds data gets a safety backup, verified
 *                against the live counts, in `safetyDir`. A backup that cannot
 *                be verified stops everything; the barrier is given back.
 *   mutate       barrier -> mutate (irreversible). Sub-steps, each recorded in
 *                restore.json: the database, then each file set, then
 *                config.json. What is replaced is moved aside, never deleted.
 *                A failure leaves the operation failed, the barrier held, the
 *                set-aside material in place and the failing sub-step named;
 *                nothing is rolled back automatically. Running the same
 *                restore again carries on from the first sub-step that is not
 *                done.
 *   verify       barrier -> verify. Opens the restored database, marks every
 *                piece of in-flight work "interrupted by restore" (never
 *                retried), pauses the instance, compares the row counts.
 *   cutover      barrier -> cutover, workers restarted onto the restored data,
 *                the restore recorded. The barrier stays up (or is released
 *                with `release`).
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ManagerError } = require('../../errors');
const { createBarrier, NEXT_PHASES } = require('../../maintenance/barrier');
const registry = require('../../lifecycle/registry');
const { createInstallCore, exactKeys, textField, parseBoolean } = require('../../install/engine');
const { createChildRunner } = require('../../backup/runChild');
const { createRestoreState } = require('../../backup/state');
const backupPaths = require('../../backup/paths');
const { lazy } = require('../../lazy');

// The manager boots with no database code loaded (tests/managerBoot.test.js): these load on first use.
const archive = lazy('@goobster/core/services/backupArchive');

const CREATE_STEPS = ['preflight', 'archive', 'verify'];
const RESTORE_STEPS = ['preflight', 'maintenance', 'backup', 'mutate', 'verify', 'cutover', 'release'];
const PHASE_RANK = Object.freeze({ quiesced: 0, backup: 1, mutate: 2, verify: 3, cutover: 4 });
const HEX_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_ONLY = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const VIA = ['bridge', 'setup', 'recovery', 'local'];
const BOUNDARY = 'irreversible-after-mutate';

const allowed = (state, via) => state.state === 'claimed' && VIA.includes(via);

function invalid(message) {
    return new ManagerError(400, 'INVALID_INPUT', message);
}

/** Archive and backup errors as the manager's: stable codes, messages with no secret in them. */
function mapArchiveError(error) {
    if (error instanceof ManagerError) return error;
    if (error && error.name === 'BackupError') {
        switch (error.code) {
        case 'PASSPHRASE_REQUIRED':
            return new ManagerError(400, 'PASSPHRASE_REQUIRED', 'config.json holds secrets and is only ever archived encrypted: give "passphrase", or leave config.json out ("includeConfig": false).');
        case 'BAD_PASSPHRASE':
            return new ManagerError(409, 'BAD_PASSPHRASE', 'The passphrase does not open this archive. Nothing was changed.');
        case 'ENGINE_MISMATCH':
            return new ManagerError(409, 'ENGINE_MISMATCH', error.message, { archiveEngine: error.archiveEngine, targetEngine: error.targetEngine });
        case 'SCHEMA_MISMATCH':
            return new ManagerError(409, 'SCHEMA_MISMATCH', error.message, { archiveSchema: error.archiveSchema, targetSchema: error.targetSchema });
        case 'UNVERIFIED':
            return new ManagerError(409, 'BACKUP_UNVERIFIED', 'The backup could not be verified, so nothing was changed.', { problems: error.problems || [] });
        case 'NOT_AN_ARCHIVE':
        case 'BAD_MANIFEST':
        case 'BAD_FORMAT':
            return new ManagerError(409, error.code, error.message);
        case 'DESTINATION_INSIDE_DATA':
            return new ManagerError(409, 'BACKUP_DESTINATION_UNSAFE', error.message);
        default:
            return new ManagerError(409, 'BACKUP_FAILED', 'The backup step failed.', { reason: typeof error.code === 'string' && CODE_ONLY.test(error.code) ? error.code : null });
        }
    }
    return error;
}

function codeOf(error) {
    return error && typeof error.code === 'string' && CODE_ONLY.test(error.code) ? error.code : 'STEP_FAILED';
}

function parseMaintenance(value) {
    if (value === undefined) return null;
    exactKeys(value, new Set(['operationId', 'fence']), '"maintenance"');
    if (typeof value.operationId !== 'string' || !HEX_ID.test(value.operationId)) throw invalid('"maintenance.operationId" must be the id maintenance.enter returned.');
    if (!Number.isInteger(value.fence) || value.fence < 1) throw invalid('"maintenance.fence" must be the fence maintenance.enter returned.');
    return { operationId: value.operationId, fence: value.fence };
}

function parseRevision(value) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw invalid('"expectedRevision" must be a non-negative integer.');
    return value;
}

function parsePassphrase(value) {
    return value === undefined ? null : textField(value, 'passphrase', { max: 1024 });
}

function parseCreateInput(input, { settings, fs }) {
    exactKeys(input, new Set(['dir', 'includeConfig', 'passphrase', 'expectedRevision']));
    const dir = backupPaths.parseDirectory(input.dir, 'dir');
    backupPaths.assertDestination(settings, dir);
    const includeConfig = parseBoolean(input.includeConfig, 'includeConfig', true);
    const passphrase = parsePassphrase(input.passphrase);
    const configExists = fs.existsSync(settings.configPath);
    if (includeConfig && configExists && !passphrase) throw mapArchiveError({ name: 'BackupError', code: 'PASSPHRASE_REQUIRED' });
    return { dir, includeConfig: includeConfig && configExists, configExists, passphrase: includeConfig ? passphrase : null, expectedRevision: parseRevision(input.expectedRevision) };
}

function parseRestoreInput(input) {
    exactKeys(input, new Set(['dir', 'confirm', 'withoutConfig', 'passphrase', 'acceptSchemaChange', 'safetyDir', 'maintenance', 'release', 'expectedRevision']));
    const dir = backupPaths.parseDirectory(input.dir, 'dir');
    const safetyDir = input.safetyDir === undefined ? null : backupPaths.parseDirectory(input.safetyDir, 'safetyDir');
    return {
        dir,
        safetyDir,
        confirm: input.confirm === undefined ? null : textField(input.confirm, 'confirm', { max: 200 }),
        withoutConfig: parseBoolean(input.withoutConfig, 'withoutConfig', false),
        passphrase: parsePassphrase(input.passphrase),
        acceptSchemaChange: parseBoolean(input.acceptSchemaChange, 'acceptSchemaChange', false),
        maintenance: parseMaintenance(input.maintenance),
        release: parseBoolean(input.release, 'release', false),
        expectedRevision: parseRevision(input.expectedRevision)
    };
}

function createKinds({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const core = createInstallCore({ settings, fs, now, logger });
    const deps = () => settings.backupDeps || {};
    const runChild = (...args) => (deps().runChild || createChildRunner({ settings, ...(deps().spawn ? { spawn: deps().spawn } : {}) }))(...args);
    const barrier = () => createBarrier({ settings, fs, now, logger, ...(deps().barrier || {}) });
    const state = () => createRestoreState({ storeDir: settings.storeDir, fs, now });
    const emit = (event) => { try { deps().onProgress?.(event); } catch { } };
    const stamp = () => now().toISOString();
    const targetEngine = () => (settings.dbUrl ? 'postgres' : 'sqlite');

    const needInput = (ctx) => {
        if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
        return ctx.input;
    };

    /** Whether the barrier is up with every writer fenced: the one case a backup is compared with live counts. */
    function barrierQuiesced() {
        try {
            const view = barrier().view();
            if (!view.active || view.stale || !(view.phase in PHASE_RANK)) return false;
            const writers = Object.entries(view.writers || {});
            return writers.length > 0 && writers.every(([, info]) => info.acked === true);
        } catch {
            return false;
        }
    }

    function checkTarget(doc) {
        const refuse = (reason) => new ManagerError(409, 'FOREIGN_TARGET', 'The database this restore would replace is not the one recorded for this installation; nothing was changed.', { reason });
        if (doc.database && doc.database.engine && doc.database.engine !== targetEngine()) throw refuse('RECORDED_ENGINE');
        if (doc.roots && doc.roots.data && path.resolve(doc.roots.data) !== path.resolve(settings.dataDir)) throw refuse('DATA_ROOT');
        if (targetEngine() === 'sqlite' && doc.roots && doc.roots.data && !(doc.database && doc.database.external)) {
            if (!backupPaths.inside(doc.roots.data, settings.sqlitePath)) throw refuse('DATABASE');
        }
    }

    async function probeTarget() {
        try {
            const probe = await runChild('probeTarget', { engine: targetEngine(), sqlitePath: settings.sqlitePath });
            return { occupied: probe.hasData === true, tables: probe.tables, rows: probe.rows, exists: probe.exists };
        } catch {
            return { occupied: null, tables: null, rows: null, exists: null };
        }
    }

    // ================================================================ create
    const createKind = {
        kind: 'backup.create',
        public: true,
        allowed,
        async plan(input, ctx) {
            const parsed = parseCreateInput(input, { settings, fs });
            const doc = core.ownedInstall(ctx, { requireManaged: false });
            if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== doc.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since it was read; read it again.', { expected: parsed.expectedRevision, actual: doc.revision });
            }
            const sets = backupPaths.fileSetPaths(settings).filter(set => fs.existsSync(set.path)).map(set => ({ id: set.id, label: set.label }));
            const secrets = archive.envSecretsPresent(settings.env).map(name => archive.describeSecret(name));
            const quiesced = barrierQuiesced();
            return {
                plan: {
                    target: 'installation',
                    effect: 'backup-create',
                    boundary: 'read-only',
                    destination: parsed.dir,
                    engine: targetEngine(),
                    database: { included: true, encrypted: false },
                    fileSets: sets,
                    config: {
                        included: parsed.includeConfig,
                        encrypted: parsed.includeConfig,
                        reason: parsed.includeConfig ? null : (parsed.configExists ? 'left out on purpose' : 'there is no config.json')
                    },
                    archiveEncrypted: false,
                    omittedSecrets: secrets,
                    maintenance: { held: quiesced, comparedWith: quiesced ? 'live-counts' : 'archive-structure' },
                    notes: [
                        'Only config.json is encrypted, with the passphrase you give; the passphrase is stored nowhere. The database and the files in the archive are not encrypted: keep it on protected storage.',
                        'Environment secrets are never in the archive; the ones listed here have to be entered again after a restore.'
                    ],
                    steps: CREATE_STEPS.map(name => ({ name }))
                },
                revision: doc.revision ?? null,
                privateInput: { parsed }
            };
        },
        validate(record, ctx) {
            const input = needInput(ctx);
            core.ownedInstall(ctx, { requireManaged: false });
            backupPaths.assertDestination(settings, input.parsed.dir);
            if (input.parsed.includeConfig && !input.parsed.passphrase) throw mapArchiveError({ name: 'BackupError', code: 'PASSPHRASE_REQUIRED' });
        },
        steps: [
            {
                name: 'preflight',
                run(record, ctx) {
                    const { parsed } = needInput(ctx);
                    const parent = backupPaths.describeDirectory(parsed.dir, fs);
                    if (parent.exists && !parent.directory) throw new ManagerError(409, 'BACKUP_DESTINATION_UNSAFE', 'The backup destination is not a directory.');
                    ctx.scratch.quiesced = barrierQuiesced();
                    return { destinationExists: parent.exists, quiesced: ctx.scratch.quiesced };
                }
            },
            {
                name: 'archive',
                async run(record, ctx) {
                    const { parsed } = needInput(ctx);
                    let out;
                    try {
                        out = await runChild('backup', {
                            destDir: parsed.dir,
                            passphrase: parsed.passphrase,
                            includeConfig: parsed.includeConfig,
                            quiesced: ctx.scratch.quiesced,
                            compareLive: ctx.scratch.quiesced
                        });
                    } catch (error) {
                        throw mapArchiveError(mapHelperError(error));
                    }
                    ctx.scratch.backup = out;
                    return { engine: out.engine, tables: out.tables, rows: out.rows, files: out.files, configIncluded: out.configIncluded };
                }
            },
            {
                name: 'verify',
                run(record, ctx) {
                    const out = ctx.scratch.backup;
                    if (!out.verified) {
                        throw new ManagerError(409, 'BACKUP_UNVERIFIED', 'The backup could not be verified against the live database. It is left where it was written; do not rely on it.',
                            { problems: out.problems, tables: out.mismatchedTables, archive: out.archive });
                    }
                    return { verified: true, comparedWithLiveCounts: out.comparedWithLiveCounts };
                }
            }
        ],
        result(scratch) {
            const out = scratch.backup;
            if (!out) return null;
            return {
                archive: out.archive,
                dir: out.dir,
                createdAt: out.createdAt,
                engine: out.engine,
                verified: out.verified === true,
                verifiedAgainst: out.comparedWithLiveCounts ? 'live-counts' : 'archive-structure',
                tables: out.tables,
                rows: out.rows,
                fileSets: out.fileSets,
                files: out.files,
                config: { included: out.configIncluded, encrypted: out.configIncluded },
                archiveEncrypted: false,
                omittedSecrets: out.envSecretsOmitted.map(name => archive.describeSecret(name)),
                next: 'Copy the archive to protected storage. Restoring it is `backup.restore`; the passphrase is needed only for config.json.'
            };
        },
        auditDetail: (record, scratch) => {
            const out = scratch.backup;
            if (!out) return null;
            return { tables: out.tables, rows: out.rows, files: out.files, configIncluded: out.configIncluded, verified: out.verified === true, quiesced: scratch.quiesced === true };
        }
    };

    /** A helper failure's code as a BackupError-like value so the mapping above names it. */
    function mapHelperError(error) {
        if (error instanceof ManagerError && typeof error.code === 'string') return { name: 'BackupError', code: error.code };
        return error;
    }

    // =============================================================== restore
    function signatureFor(doc, manifest, dir) {
        return core.signatureOf(['backup.restore', doc.installationId, path.basename(dir), manifest.createdAt, manifest.schemaFingerprint, manifest.engine]);
    }

    function readState() {
        const { doc, problem } = state().read();
        if (problem) throw new ManagerError(409, 'RESTORE_STATE_UNREADABLE', 'restore.json in the manager store cannot be read; it was left as it is.', { problem });
        return doc;
    }

    /** An earlier restore that stopped part way holds the lock on what comes next while its barrier is up. */
    function stateConflict(signature) {
        const doc = readState();
        if (!doc || doc.status === 'completed') return null;
        if (doc.signature === signature) return doc;
        const view = barrier().view();
        const held = doc.maintenance && view.active && view.operationId === doc.maintenance.operationId;
        if (held) {
            throw new ManagerError(409, 'RESTORE_IN_PROGRESS', 'An earlier restore of another archive stopped part way and its maintenance barrier is still held. Run that restore again to finish it, or release the barrier deliberately first.');
        }
        return null;
    }

    function assess(parsed) {
        try {
            return archive.assessArchive({
                dir: parsed.dir,
                targetEngine: targetEngine(),
                passphrase: parsed.passphrase,
                withConfig: !parsed.withoutConfig,
                acceptSchemaChange: parsed.acceptSchemaChange
            });
        } catch (error) {
            throw mapArchiveError(error);
        }
    }

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

    /** The barrier an earlier run of this same restore entered itself, still held by this manager process. */
    function ownBarrier() {
        const doc = readState();
        const previous = doc && doc.maintenance;
        if (!previous || !previous.entered) return null;
        const view = barrier().view();
        return view.active && view.operationId === previous.operationId && view.fence === previous.fence && !view.stale ? previous : null;
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

    const retainedOf = (doc) => {
        const out = [];
        const sub = (doc && doc.mutate) || {};
        for (const [name, entry] of Object.entries(sub)) {
            for (const location of entry.setAside || []) out.push({ kind: name === 'database' ? 'database' : name === 'config' ? 'config' : 'files', id: name === 'database' || name === 'config' ? name : name.slice('files:'.length), path: location });
        }
        const safety = doc && doc.steps && doc.steps.backup;
        if (safety && safety.dir) out.push({ kind: 'safety-backup', id: safety.archive, path: safety.dir });
        return out;
    };

    function fileSetIds(manifest) {
        const carried = new Set((manifest.files || []).map(entry => entry.id));
        const known = new Set(manifest.fileSetsKnown || []);
        return archive.FILE_SETS.map(set => set.id).filter(id => carried.has(id) || known.has(id));
    }

    function restoreKind() {
        async function buildPlan(input, ctx) {
            const parsed = parseRestoreInput(input);
            const doc = core.ownedInstall(ctx);
            checkTarget(doc);
            if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== doc.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since it was read; read it again.', { expected: parsed.expectedRevision, actual: doc.revision });
            }
            const listing = backupPaths.describeDirectory(parsed.dir, fs);
            if (!listing.exists || !listing.directory) throw new ManagerError(409, 'NOT_AN_ARCHIVE', `${parsed.dir} is not a directory.`);
            backupPaths.assertSource(settings, parsed.dir);
            const safetyDir = parsed.safetyDir || path.join(settings.dataDir, 'backups');
            backupPaths.assertDestination(settings, safetyDir);
            const assessed = assess(parsed);
            const { manifest } = assessed;
            const view = archive.describeManifest(manifest, { targetEngine: targetEngine() });
            const signature = signatureFor(doc, manifest, parsed.dir);
            const existing = stateConflict(signature);
            const target = await probeTarget();
            const ids = fileSetIds(manifest);
            const carried = new Set((manifest.files || []).map(entry => entry.id));
            const configPlan = {
                included: assessed.config.included,
                encrypted: assessed.config.encrypted,
                restore: assessed.config.restore,
                skipped: assessed.config.skipped,
                passphraseVerified: assessed.config.passphraseVerified
            };
            const secrets = [
                ...(configPlan.restore ? [] : ['config.json: recreate it from config.example.json (Discord token, client id, guild ids, any provider keys kept there)']),
                ...view.envSecretsToReenter.map(name => archive.describeSecret(name))
            ];
            const plan = {
                target: 'installation',
                effect: 'restore-backup',
                boundary: BOUNDARY,
                signature,
                archive: {
                    dir: parsed.dir,
                    createdAt: view.createdAt,
                    version: view.version,
                    engine: view.engine,
                    schemaFingerprint: view.schemaFingerprint,
                    tables: view.tables,
                    rows: view.rows,
                    fileSets: view.fileSets.map(set => ({ id: set.id, label: set.label, files: set.files })),
                    archiveEncrypted: false
                },
                compatibility: {
                    engineMatches: view.engineMatches,
                    fingerprintMatches: view.fingerprintMatches,
                    schemaChanged: assessed.schemaChanged,
                    acceptSchemaChange: parsed.acceptSchemaChange
                },
                config: configPlan,
                database: { engine: targetEngine(), occupied: target.occupied, rows: target.rows, replaced: true },
                safetyBackup: target.occupied === false
                    ? { required: false, reason: 'the target holds no data' }
                    : { required: true, dir: safetyDir, unknownOccupancy: target.occupied === null },
                replaces: {
                    database: true,
                    fileSets: ids.filter(id => carried.has(id)),
                    fileSetsAbsentInArchive: ids.filter(id => !carried.has(id)),
                    configJson: configPlan.restore
                },
                keptAside: 'What a restore replaces is moved aside (a name ending .pre-restore-<time>), never deleted; the result lists where.',
                maintenance: parsed.maintenance ? { mode: 'held', operationId: parsed.maintenance.operationId, fence: parsed.maintenance.fence } : { mode: 'enter' },
                release: parsed.release,
                afterwards: {
                    instancePaused: true,
                    maintenance: parsed.release ? 'released' : 'held',
                    resume: 'Host room -> Instance -> Resume (POST /api/app/admin/instance/resume) after you check the data; maintenance.release lifts the barrier and does not resume the instance.'
                },
                secretsToReenter: secrets,
                confirmation: { required: true, satisfied: parsed.confirm === doc.installationId },
                resumeOf: existing ? { restoreId: existing.id, status: existing.status, done: Object.keys(existing.mutate || {}).filter(name => existing.mutate[name].done) } : null,
                notes: [
                    'config.json is stored encrypted under the passphrase from backup time. The database and the files in the archive are not encrypted.',
                    'A wrong passphrase is detected before anything changes. Without a passphrase (or with "withoutConfig") config.json is left as it is.',
                    'The barrier takes the portal down; the browser loses its connection. Continue on the manager page.'
                ],
                steps: RESTORE_STEPS.map(name => ({ name }))
            };
            return { plan, doc, parsed };
        }

        return {
            kind: 'backup.restore',
            public: true,
            allowed,
            async plan(input, ctx) {
                const { plan, doc, parsed } = await buildPlan(input, ctx);
                return { plan, revision: doc.revision, privateInput: { parsed } };
            },
            async validate(record, ctx) {
                const input = needInput(ctx);
                const { parsed } = input;
                const doc = core.ownedInstall(ctx);
                if (doc.revision !== record.revision) {
                    throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since this plan was made; plan again.', { expected: record.revision, actual: doc.revision });
                }
                checkTarget(doc);
                if (parsed.confirm !== doc.installationId) {
                    throw new ManagerError(400, 'CONFIRMATION_REQUIRED', 'A restore replaces the database; "confirm" must be the installation id. Nothing was changed.');
                }
                backupPaths.assertSource(settings, parsed.dir);
                const assessed = assess(parsed);
                if (signatureFor(doc, assessed.manifest, parsed.dir) !== record.plan.signature) {
                    throw new ManagerError(409, 'ARCHIVE_CHANGED', 'The archive changed since this plan was made; plan again.');
                }
                stateConflict(record.plan.signature);
                if (parsed.maintenance) heldBarrier(parsed.maintenance);
                else if (!ownBarrier()) barrier().assertEnterable();
            },
            steps: restoreSteps(),
            result: scratch => scratch.result || null,
            auditDetail: (record, scratch) => scratch.audit || null
        };
    }

    function restoreSteps() {
        const book = (record, name, status) => emit({ event: 'step', step: name, status, operationId: record.id });

        function guarded(name, body, { track = true } = {}) {
            return {
                name,
                async run(record, ctx) {
                    book(record, name, 'started');
                    try {
                        await deps().beforeStep?.({ step: name, operationId: record.id });
                        const out = await body(record, ctx, needInput(ctx).parsed);
                        book(record, name, out && out.skipped ? 'skipped' : 'done');
                        return out;
                    } catch (error) {
                        const mapped = mapArchiveError(error);
                        const code = codeOf(mapped);
                        book(record, name, 'failed');
                        if (track) {
                            state().update(next => ({ ...next, status: 'failed', failure: { ...(next.failure && next.failure.step === name ? next.failure : {}), step: name, code, at: stamp() } }));
                            await abandonIfCancelSafe(record, ctx, code);
                        }
                        throw mapped;
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
            const doc = readState();
            return doc && doc.steps && doc.steps[name] && doc.steps[name].done === true ? doc.steps[name] : null;
        }

        function markStep(name, fields) {
            return state().update(next => ({ ...next, steps: { ...next.steps, [name]: { ...(next.steps && next.steps[name]), ...fields, done: fields.done !== false, at: stamp() } } }));
        }

        function substepDone(name) {
            const doc = readState();
            return doc && doc.mutate && doc.mutate[name] && doc.mutate[name].done === true ? doc.mutate[name] : null;
        }

        function markSubstep(name, fields) {
            return state().update(next => ({ ...next, mutate: { ...next.mutate, [name]: { ...(next.mutate && next.mutate[name]), ...fields, done: fields.done !== false, at: stamp() } } }));
        }

        async function substep(record, name, body) {
            try {
                await deps().beforeSubstep?.({ step: 'mutate', substep: name, operationId: record.id });
                return await body();
            } catch (error) {
                state().update(next => ({ ...next, failure: { step: 'mutate', substep: name, code: codeOf(error), at: stamp() } }));
                throw error;
            }
        }

        return [
            guarded('preflight', async (record, ctx, parsed) => {
                const doc = core.ownedInstall(ctx);
                const assessed = assess(parsed);
                const { manifest } = assessed;
                try {
                    archive.verifyBackup(parsed.dir, { expectFingerprint: manifest.schemaFingerprint });
                } catch (error) {
                    throw new ManagerError(409, 'ARCHIVE_INCOMPLETE', `The archive is not complete (${(error.problems || ['UNVERIFIED']).join(', ')}); nothing was changed.`, { problems: error.problems || [] });
                }
                const store = state();
                const existing = readState();
                const resuming = existing && existing.signature === record.plan.signature && existing.status !== 'completed';
                const base = {
                    version: 1,
                    id: resuming ? existing.id : `rst_${crypto.randomBytes(6).toString('hex')}`,
                    status: 'running',
                    signature: record.plan.signature,
                    installationId: doc.installationId,
                    archive: path.basename(parsed.dir),
                    archiveCreatedAt: manifest.createdAt,
                    engine: manifest.engine,
                    schemaChanged: assessed.schemaChanged,
                    tag: resuming && existing.tag ? existing.tag : archive.stamp(now()),
                    startedAt: resuming ? existing.startedAt : stamp(),
                    steps: resuming ? existing.steps || {} : {},
                    mutate: resuming ? existing.mutate || {} : {},
                    maintenance: resuming ? existing.maintenance : null,
                    resumes: resuming ? (existing.resumes || 0) + 1 : 0,
                    failure: null,
                    result: null
                };
                store.write({ ...base, steps: { ...base.steps, preflight: { done: true, at: stamp() } } });
                ctx.scratch.manifest = manifest;
                ctx.scratch.assessed = assessed;
                return { engine: manifest.engine, schemaChanged: assessed.schemaChanged, configRestore: assessed.config.restore, resumed: Boolean(resuming) };
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
                const previous = ownBarrier();
                if (previous) {
                    heldBarrier(previous);
                    ctx.scratch.maintenance = { ...previous };
                    return { mode: 'reused', fence: previous.fence };
                }
                const resolved = await b.preflight({ actor: record.actor, ctx });
                const { fence } = b.begin({ operationId: record.id, actor: record.actor, via: record.via, reason: 'restore' });
                ctx.scratch.maintenance = { operationId: record.id, fence, entered: true };
                store.update(next => ({ ...next, maintenance: { operationId: record.id, fence, entered: true } }));
                const out = await b.quiesce({ operationId: record.id, fence, resolved, timeoutSeconds: 120, actor: record.actor });
                await b.verify({ operationId: record.id, fence, resolved, writers: out.writers, sent: out.sent, actor: record.actor });
                return { mode: 'entered', fence, writers: Object.keys(out.writers) };
            }),

            guarded('backup', async (record, ctx, parsed) => {
                if (stepDone('backup')) return { skipped: true, code: 'ALREADY_DONE' };
                let probe;
                try {
                    probe = await runChild('probeTarget', { engine: targetEngine(), sqlitePath: settings.sqlitePath });
                } catch (error) {
                    // A SQLite file that is not a database cannot be backed up, but it is exactly what a
                    // restore is for: it is set aside whole by the database sub-step, never deleted.
                    if (targetEngine() !== 'sqlite' || !/^SQLITE_(NOTADB|CORRUPT)/.test(String(error && error.code))) throw error;
                    markStep('backup', { hadData: true, skipped: true, unreadable: true });
                    return { skipped: true, code: 'TARGET_UNREADABLE' };
                }
                if (!probe.hasData) {
                    markStep('backup', { hadData: false, skipped: true });
                    return { skipped: true, code: 'TARGET_EMPTY' };
                }
                ensurePhase(ctx.scratch.maintenance, 'backup', record.actor);
                const safetyDir = parsed.safetyDir || path.join(settings.dataDir, 'backups');
                backupPaths.assertDestination(settings, safetyDir);
                const includeConfig = fs.existsSync(settings.configPath) && Boolean(parsed.passphrase);
                const out = await runChild('backup', {
                    destDir: safetyDir,
                    passphrase: includeConfig ? parsed.passphrase : null,
                    includeConfig,
                    quiesced: true,
                    compareLive: true
                });
                if (!out.verified) {
                    throw new ManagerError(409, 'BACKUP_UNVERIFIED', 'The safety backup of the current data could not be verified against the live database; nothing was changed. Fix the destination and run again.',
                        { problems: out.problems, tables: out.mismatchedTables });
                }
                markStep('backup', { hadData: true, verified: true, archive: out.archive, dir: out.dir, tables: out.tables, rows: out.rows, configIncluded: out.configIncluded });
                ctx.scratch.safety = { archive: out.archive, dir: out.dir, tables: out.tables, rows: out.rows, configIncluded: out.configIncluded };
                return { archive: out.archive, verified: true, tables: out.tables, rows: out.rows, configIncluded: out.configIncluded };
            }),

            guarded('mutate', async (record, ctx, parsed) => {
                const doc = readState();
                const manifest = archive.inspectBackup(parsed.dir);
                const schemaChanged = Boolean(doc.schemaChanged);
                const hadData = Boolean(doc.steps.backup && doc.steps.backup.hadData);
                ensurePhase(ctx.scratch.maintenance, 'mutate', record.actor);
                const done = [];
                const reuse = [];

                const database = substepDone('database');
                if (database) reuse.push('database');
                else {
                    await substep(record, 'database', async () => {
                        markSubstep('database', { done: false, started: true });
                        const out = await runChild('restoreDatabase', { dir: parsed.dir, schemaChanged, hadData, tag: doc.tag });
                        markSubstep('database', { setAside: out.setAside });
                    });
                    done.push('database');
                }

                for (const id of fileSetIds(manifest)) {
                    const name = `files:${id}`;
                    if (substepDone(name)) {
                        reuse.push(name);
                        continue;
                    }
                    await substep(record, name, async () => {
                        markSubstep(name, { done: false, started: true });
                        const out = await runChild('restoreFiles', { dir: parsed.dir, only: [id], tag: doc.tag });
                        markSubstep(name, { setAside: out.setAside, files: out.files.reduce((sum, item) => sum + (item.files || 0), 0) });
                    });
                    done.push(name);
                }

                if (substepDone('config')) reuse.push('config');
                else {
                    await substep(record, 'config', async () => {
                        markSubstep('config', { done: false, started: true });
                        const out = await runChild('restoreConfig', { dir: parsed.dir, passphrase: parsed.passphrase, withConfig: !parsed.withoutConfig, tag: doc.tag });
                        markSubstep('config', { setAside: out.setAside, restored: out.restored, skipped: out.skipped });
                    });
                    done.push('config');
                }
                const after = readState();
                ctx.scratch.mutated = { sub: done.length, reused: reuse.length };
                return { substeps: done, alreadyDone: reuse, files: Object.entries(after.mutate).filter(([name]) => name.startsWith('files:')).length };
            }),

            guarded('verify', async (record, ctx, parsed) => {
                const doc = readState();
                if (doc.steps.verify && doc.steps.verify.done) {
                    ctx.scratch.finish = doc.steps.verify;
                    return { skipped: true, code: 'ALREADY_DONE' };
                }
                ensurePhase(ctx.scratch.maintenance, 'verify', record.actor);
                const manifest = archive.inspectBackup(parsed.dir);
                const configRestored = Boolean(doc.mutate.config && doc.mutate.config.restored);
                const out = await runChild('finish', { dir: parsed.dir, schemaChanged: Boolean(doc.schemaChanged), configRestored, by: 'manager backup.restore' });
                const strict = manifest.quiesced !== false && !doc.schemaChanged;
                const summary = { interrupted: out.interrupted, tables: out.tables, mismatches: out.mismatches, mismatchCount: out.mismatchCount, strict };
                if (out.mismatchCount > 0 && strict) {
                    state().update(next => ({ ...next, steps: { ...next.steps, verify: { done: false, ok: false, at: stamp(), ...summary } } }));
                    throw new ManagerError(409, 'VERIFY_FAILED', `The restored row counts do not match the archive (${out.mismatches.slice(0, 5).join(', ')}). The instance is paused and the barrier stays up; nothing was undone.`,
                        { tables: out.mismatches });
                }
                markStep('verify', summary);
                ctx.scratch.finish = summary;
                return { interrupted: Object.values(out.interrupted).reduce((sum, n) => sum + n, 0), tables: out.tables, mismatches: out.mismatchCount };
            }),

            guarded('cutover', async (record, ctx) => {
                const op = ctx.scratch.maintenance;
                ensurePhase(op, 'cutover', record.actor);
                const restarted = restartWorkers();
                ctx.scratch.workersRestarted = restarted;
                barrier().settle({ operationId: op.operationId, fence: op.fence, outcome: 'ok', code: 'RESTORE_COMPLETE', actor: record.actor });
                const finished = state().update(next => ({
                    ...next,
                    status: 'completed',
                    completedAt: stamp(),
                    failure: null,
                    result: { interrupted: ctx.scratch.finish.interrupted, tables: ctx.scratch.finish.tables, mismatches: ctx.scratch.finish.mismatchCount }
                }));
                const view = barrier().view();
                const manifest = ctx.scratch.manifest || archive.inspectBackup(needInput(ctx).parsed.dir);
                const config = finished.mutate.config || {};
                const secrets = [
                    ...(config.restored ? [] : ['config.json: recreate it from config.example.json (Discord token, client id, guild ids, any provider keys kept there)']),
                    ...((manifest.envSecrets && manifest.envSecrets.present) || []).map(name => archive.describeSecret(name))
                ];
                const interrupted = ctx.scratch.finish.interrupted || {};
                ctx.scratch.result = {
                    restoreId: finished.id,
                    archive: finished.archive,
                    archiveCreatedAt: finished.archiveCreatedAt,
                    engine: finished.engine,
                    schemaChanged: Boolean(finished.schemaChanged),
                    database: { restored: true },
                    files: Object.entries(finished.mutate).filter(([name]) => name.startsWith('files:')).map(([name, entry]) => ({ id: name.slice('files:'.length), files: entry.files || 0 })),
                    config: { restored: Boolean(config.restored), skipped: config.restored ? null : (config.skipped || null) },
                    safetyBackup: finished.steps.backup && finished.steps.backup.hadData && !finished.steps.backup.skipped ? { archive: finished.steps.backup.archive, dir: finished.steps.backup.dir, tables: finished.steps.backup.tables, rows: finished.steps.backup.rows } : null,
                    interrupted,
                    interruptedTotal: Object.values(interrupted).reduce((sum, n) => sum + n, 0),
                    rowCounts: { tables: ctx.scratch.finish.tables, mismatches: ctx.scratch.finish.mismatches, matchesArchive: ctx.scratch.finish.mismatchCount === 0 },
                    instancePaused: true,
                    maintenance: { held: true, operationId: op.operationId, fence: op.fence, phase: view.phase, enteredByRestore: op.entered },
                    workersMode: settings.workersMode,
                    workersRestarted: restarted,
                    retained: retainedOf(finished),
                    secretsToReenter: secrets,
                    resumed: (finished.resumes || 0) > 0,
                    next: ['maintenance.release (or `restore --release`): lifts the barrier; the instance stays paused', 'Host room -> Instance -> Resume: after you check the data']
                };
                ctx.scratch.audit = {
                    tables: ctx.scratch.finish.tables,
                    interrupted: ctx.scratch.result.interruptedTotal,
                    files: ctx.scratch.result.files.reduce((sum, item) => sum + item.files, 0),
                    fileSets: ctx.scratch.result.files.length,
                    configRestored: Boolean(config.restored),
                    safetyBackup: Boolean(ctx.scratch.result.safetyBackup),
                    schemaChanged: Boolean(finished.schemaChanged),
                    mismatches: ctx.scratch.finish.mismatchCount,
                    workersRestarted: restarted
                };
                return { phase: view.phase, workersRestarted: restarted };
            }),

            guarded('release', async (record, ctx, parsed) => {
                if (!parsed.release) return { skipped: true, code: 'NOT_REQUESTED' };
                const op = ctx.scratch.maintenance;
                const out = await barrier().release({ operationId: op.operationId, fence: op.fence, actor: record.actor });
                ctx.scratch.result.maintenance = { ...ctx.scratch.result.maintenance, held: false, phase: null };
                ctx.scratch.result.next = ['Host room -> Instance -> Resume: after you check the data'];
                return { outcome: out.outcome };
            }, { track: false })
        ];
    }

    return [createKind, restoreKind()];
}

module.exports = { createKinds, parseCreateInput, parseRestoreInput, mapArchiveError, CREATE_STEPS, RESTORE_STEPS, BOUNDARY };
