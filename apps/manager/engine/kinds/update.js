/**
 * The update operation kinds (documentation/manager_update.md):
 *
 *   update.check    ask the configured source for its signed index and say what it offers;
 *                   writes only `last-check.json` in the manager store
 *   update.stage    download, verify and stage the offered release; `current` does not change
 *   update.apply    the staged release, inside the maintenance barrier: preflight, a verified
 *                   backup, quiesce, activate, the OS handoff, verify, cutover, release
 *   update.policy   set the update policy in the sealed installation record
 *   update.recover  the operator's decision after a schema-changing update failed: restore or retry
 *
 * They are public (the portal's Host room plans them over HTTP and the command line runs them).
 * They take no path from the caller: the source, the roots and the staged release come from the
 * sealed record and the manager's own state, so a portal assertion cannot point an update at a
 * directory of its choosing. Every step records `done|skipped|failed|deferred` in the `progress`
 * ledger of the operation record (the same ledger the install kinds write).
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { ManagerError } = require('../../errors');
const release = require('../../install/release');
const backupPaths = require('../../backup/paths');
const { createInstallCore, exactKeys } = require('../../install/engine');
const policyModule = require('../../update/policy');
const fingerprints = require('../../update/schemaFingerprint');
const wiring = require('../../update/wiring');
const { createUpdateCore } = require('../../update/core');
const { createStageHelpers } = require('../../update/stageRelease');
const { createApplier } = require('../../update/apply');

const VIA = ['local', 'bridge'];
const RECOVER_VIA = ['local', 'recovery'];
const CHECK_STEPS = ['fetch-index', 'verify-index', 'compare', 'record'];
const STAGE_STEPS = ['preflight', 'fetch-index', 'verify-index', 'space', 'download', 'verify-artifact', 'verify-payload', 'stage', 'record'];
const APPLY_STEPS = ['preflight', 'maintenance', 'backup', 'activate', 'handoff', 'verify', 'cutover', 'release'];
const RECOVER_STEPS = ['restore-data', 'put-back', 'verify', 'release'];
const RETRY_STEPS = ['verify', 'cutover', 'release'];

const stepList = (names) => names.map(name => ({ name }));

function claimed(state, via, allowedVia) {
    return state.state === 'claimed' && allowedVia.includes(via);
}

function createKinds({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const install = createInstallCore({ settings, fs, now, logger });
    const core = createUpdateCore({ settings, fs, now, logger, install });
    const stageHelpers = createStageHelpers({ core });
    const { state } = core;
    const parts = () => {
        const bound = wiring.get(settings.storeDir);
        if (!bound) throw new ManagerError(409, 'NOT_AVAILABLE', 'The update kinds need a manager that was built with createManager.');
        return bound;
    };
    const applier = (() => {
        let made = null;
        return () => {
            if (!made) {
                const { store, journal } = parts();
                made = createApplier({ core, store, journal, logger });
            }
            return made;
        };
    })();

    const needInput = (ctx) => {
        if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
        return ctx.input;
    };

    function emptyInput(input, what) {
        exactKeys(input === undefined ? {} : input, new Set(), what);
    }

    const stampOf = () => now().toISOString();

    // ------------------------------------------------------- shared facts
    function pendingStates() {
        return { handoff: state.read('handoff'), recovery: state.read('recovery') };
    }

    function assertNotInFlight(what) {
        const { handoff, recovery } = pendingStates();
        if (recovery) throw new ManagerError(409, 'RECOVERY_PENDING', `An update needs a decision before ${what}: restore the pre-update backup or retry (see update status).`);
        if (handoff) throw new ManagerError(409, 'UPDATE_IN_PROGRESS', `An update is still being handed over; ${what} when it has finished.`);
    }

    function planBase(action, ctx) {
        const doc = core.ownedRecord(ctx);
        const policy = core.policyOf(doc);
        const source = policyModule.sourceOf(policy);
        return {
            doc,
            policy,
            view: {
                action,
                installed: { releaseId: doc.release.releaseId, version: doc.release.version, target: doc.release.target },
                channel: policy.channel,
                source: { kind: source.kind, ...(source.kind === 'github-release' ? { owner: source.owner, repo: source.repo } : {}) }
            }
        };
    }

    // -------------------------------------------------------- update.check
    function checkKind() {
        async function build(input, ctx) {
            emptyInput(input, 'update.check');
            const { doc, view } = planBase('check', ctx);
            const steps = stepList(CHECK_STEPS);
            const signature = install.signatureOf({ kind: 'update.check', id: doc.installationId, release: doc.release.releaseId });
            return { doc, plan: { ...view, signature, stateDigest: install.signatureOf({ revision: doc.revision }), writes: ['last-check'], steps }, revision: doc.revision };
        }
        return {
            kind: 'update.check',
            public: true,
            allowed: (st, via) => claimed(st, via, [...VIA, 'recovery']),
            async plan(input, ctx) {
                const built = await build(input, ctx);
                return { plan: built.plan, revision: built.revision, privateInput: { raw: input } };
            },
            async validate(record, ctx) {
                const built = await build(needInput(ctx).raw, ctx);
                if (built.plan.stateDigest !== record.plan.stateDigest) throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since this plan was made; plan again.');
            },
            steps: [
                install.step('fetch-index', async (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    core.sweepTemp();
                    try {
                        const fetched = await core.fetchIndexFiles(doc);
                        ctx.scratch.fetched = fetched;
                        return { detail: { source: fetched.source.kind } };
                    } catch (error) {
                        const blocked = core.blockedOf(error);
                        ctx.scratch.blocked = blocked;
                        return { status: 'skipped', code: blocked.code };
                    }
                }),
                install.step('verify-index', (record, ctx) => {
                    if (ctx.scratch.blocked || !ctx.scratch.fetched) return { status: 'skipped', code: ctx.scratch.blocked ? ctx.scratch.blocked.code : 'NOTHING_FETCHED' };
                    const doc = core.ownedRecord(ctx);
                    try {
                        ctx.scratch.verified = core.verifyIndexFiles(doc, ctx.scratch.fetched.dir);
                    } catch (error) {
                        ctx.scratch.blocked = core.blockedOf(error);
                        return { status: 'skipped', code: ctx.scratch.blocked.code };
                    } finally {
                        core.removeTree(ctx.scratch.fetched.dir);
                    }
                    return { detail: { signed: ctx.scratch.verified.verdict.signed } };
                }),
                install.step('compare', (record, ctx) => {
                    if (ctx.scratch.blocked || !ctx.scratch.verified) return { status: 'skipped', code: ctx.scratch.blocked ? ctx.scratch.blocked.code : 'NOTHING_VERIFIED' };
                    const doc = core.ownedRecord(ctx);
                    ctx.scratch.comparison = core.compare(doc, ctx.scratch.verified);
                    return { detail: { outcome: ctx.scratch.comparison.outcome } };
                }),
                install.step('record', (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    const result = ctx.scratch.blocked || ctx.scratch.comparison;
                    ctx.scratch.result = result;
                    core.recordCheck({ ...result, installed: { releaseId: doc.release.releaseId, version: doc.release.version } });
                    return { detail: { outcome: result.outcome } };
                })
            ],
            result: (scratch) => {
                const r = scratch.result || { outcome: 'blocked', code: 'NO_RESULT' };
                return { outcome: r.outcome, ...(r.code ? { code: r.code } : {}), ...(r.latest ? { latest: r.latest } : {}), ...(r.artifact ? { size: r.artifact.size } : {}) };
            },
            auditDetail: (record, scratch) => ({ outcome: scratch.result ? scratch.result.outcome : 'blocked', ...(scratch.result && scratch.result.code ? { code: scratch.result.code } : {}) })
        };
    }

    // -------------------------------------------------------- update.stage
    /** A step that removes the half-staged download when it fails. */
    function cleaning(name, body) {
        return install.step(name, async (record, ctx) => {
            try {
                return await body(record, ctx);
            } catch (error) {
                if (ctx.scratch.landed && ctx.scratch.landed.provisional) core.removeTree(ctx.scratch.landed.provisional);
                throw error;
            }
        });
    }

    function stageKind() {
        async function build(input, ctx) {
            emptyInput(input, 'update.stage');
            assertNotInFlight('staging another release');
            const { doc, view } = planBase('stage', ctx);
            const steps = stepList(STAGE_STEPS);
            const signature = install.signatureOf({ kind: 'update.stage', id: doc.installationId, release: doc.release.releaseId });
            return {
                doc,
                plan: {
                    ...view,
                    signature,
                    stateDigest: install.signatureOf({ revision: doc.revision }),
                    downloads: [{ what: 'payload archive for this platform', verifiedBy: 'signed release index, then the payload manifest' }],
                    currentUnchanged: true,
                    steps
                },
                revision: doc.revision
            };
        }
        return {
            kind: 'update.stage',
            public: true,
            allowed: (st, via) => claimed(st, via, VIA),
            async plan(input, ctx) {
                const built = await build(input, ctx);
                return { plan: built.plan, revision: built.revision, privateInput: { raw: input } };
            },
            async validate(record, ctx) {
                const built = await build(needInput(ctx).raw, ctx);
                if (built.plan.stateDigest !== record.plan.stateDigest) throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since this plan was made; plan again.');
            },
            steps: [
                install.step('preflight', (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    assertNotInFlight('staging another release');
                    stageHelpers.sweep(doc, { keep: [doc.release.releaseId, (state.read('staged') || {}).releaseId] });
                    return { detail: { current: doc.release.version } };
                }),
                install.step('fetch-index', async (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    core.sweepTemp();
                    try {
                        ctx.scratch.fetched = await core.fetchIndexFiles(doc);
                    } catch (error) {
                        core.recordCheck({ ...core.blockedOf(error), installed: { releaseId: doc.release.releaseId, version: doc.release.version } });
                        throw error;
                    }
                    return { detail: { source: ctx.scratch.fetched.source.kind } };
                }),
                install.step('verify-index', (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    const installed = { releaseId: doc.release.releaseId, version: doc.release.version };
                    let verified;
                    try {
                        verified = core.verifyIndexFiles(doc, ctx.scratch.fetched.dir);
                    } catch (error) {
                        core.removeTree(ctx.scratch.fetched.dir);
                        core.recordCheck({ ...core.blockedOf(error), installed });
                        throw error;
                    }
                    const comparison = core.compare(doc, verified);
                    ctx.scratch.verified = verified;
                    ctx.scratch.comparison = comparison;
                    core.recordCheck({ ...comparison, installed });
                    if (comparison.outcome === 'blocked') {
                        core.removeTree(ctx.scratch.fetched.dir);
                        throw new ManagerError(409, comparison.code, 'The release index offers no payload for this platform.');
                    }
                    if (comparison.outcome !== 'available') {
                        core.removeTree(ctx.scratch.fetched.dir);
                        throw new ManagerError(409, 'NO_UPDATE_AVAILABLE', 'The installation already runs the newest release the source offers.');
                    }
                    return { detail: { version: comparison.latest.version, signed: verified.verdict.signed } };
                }),
                install.step('space', (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    try {
                        const need = stageHelpers.checkSpace({ doc, artifactSize: ctx.scratch.comparison.artifact.size });
                        return { detail: need };
                    } catch (error) {
                        core.removeTree(ctx.scratch.fetched.dir);
                        throw error;
                    }
                }),
                install.step('download', async (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    try {
                        ctx.scratch.landed = await stageHelpers.download({
                            doc,
                            source: ctx.scratch.fetched.source,
                            artifact: ctx.scratch.comparison.artifact,
                            index: ctx.scratch.verified.index,
                            running: ctx.scratch.verified.running
                        });
                    } finally {
                        core.removeTree(ctx.scratch.fetched.dir);
                    }
                    return { detail: { size: ctx.scratch.comparison.artifact.size } };
                }),
                cleaning('verify-artifact', (record, ctx) => {
                    ctx.scratch.artifact = stageHelpers.verifyArtifact({ landed: ctx.scratch.landed, index: ctx.scratch.verified.index, running: ctx.scratch.verified.running });
                    return { detail: { sha256: 'matched', members: 'safe' } };
                }),
                cleaning('verify-payload', (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    ctx.scratch.payload = stageHelpers.verifyPayload({ doc, landed: ctx.scratch.landed, releaseId: ctx.scratch.artifact.releaseId });
                    return { detail: { files: ctx.scratch.payload.verified.files, releaseId: ctx.scratch.payload.releaseId } };
                }),
                install.step('stage', (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    const staged = stageHelpers.stageFromRelease({ doc, payloadDir: ctx.scratch.payload.dir, ctx });
                    ctx.scratch.staged = staged;
                    return { detail: { files: staged.files, bytes: staged.bytes } };
                }),
                install.step('record', (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    const running = core.runningRelease(doc);
                    const landed = ctx.scratch.payload;
                    const changing = fingerprints.schemaChanging(running.schemaFingerprint, landed.fingerprint);
                    ctx.scratch.record = state.write('staged', {
                        releaseId: landed.releaseId,
                        version: landed.verified.core,
                        target: running.target,
                        features: doc.release.features,
                        stagingDir: path.basename(ctx.scratch.staged.stagingDir),
                        schemaFingerprint: landed.fingerprint,
                        fromFingerprint: running.schemaFingerprint,
                        schemaChanging: changing,
                        fromReleaseId: doc.release.releaseId,
                        stagedAt: stampOf()
                    });
                    return { detail: { schemaChanging: changing } };
                })
            ],
            result: (scratch) => scratch.record ? {
                staged: true,
                releaseId: scratch.record.releaseId,
                version: scratch.record.version,
                schemaChanging: scratch.record.schemaChanging,
                features: scratch.record.features
            } : { staged: false },
            auditDetail: (record, scratch) => scratch.record ? { version: scratch.record.version, schemaChanging: scratch.record.schemaChanging } : null
        };
    }

    // -------------------------------------------------------- update.apply
    function applyKind() {
        const A = () => applier();

        function checkStaged(doc) {
            const staged = state.read('staged');
            if (!staged) throw new ManagerError(409, 'NOTHING_STAGED', 'No release is staged; run update.stage first.');
            if (staged.fromReleaseId !== doc.release.releaseId) {
                throw new ManagerError(409, 'STAGE_STALE', 'The staged release was prepared for a different installed release; stage again.');
            }
            const options = core.payloadVerifyOptions();
            const ready = install.findReadyStage(doc.roots.code, staged.releaseId, staged.features, { ...options, hash: false });
            if (!ready) throw new ManagerError(409, 'NOTHING_STAGED', 'The staged payload is not on disk any more or no longer verifies; stage again.');
            return { staged, dir: ready.dir };
        }

        async function build(input, ctx) {
            const raw = input === undefined ? {} : input;
            exactKeys(raw, new Set(['when']), 'update.apply');
            const when = raw.when === undefined ? 'now' : raw.when;
            if (when !== 'now' && when !== 'window') throw new ManagerError(400, 'INVALID_INPUT', '"when" must be "now" or "window".');
            assertNotInFlight('applying another update');
            const { doc, policy, view } = planBase('apply', ctx);
            if (!doc.updater || doc.updater.kind !== 'manager') {
                throw new ManagerError(409, 'UPDATER_NOT_MANAGER', 'Another updater owns this installation (a timer or PM2); only one updater may act. Hand updates to the manager first (adopt without keepUpdater).');
            }
            const { staged, dir } = checkStaged(doc);
            const availability = A().handoffAvailability(doc);
            if (availability.mode === 'unavailable') {
                throw new ManagerError(409, 'HANDOFF_UNAVAILABLE', 'The manager is not run by an OS service, so it cannot hand itself over to the new release. The update stays staged. Stop the manager and run "node apps/manager/cli.js update apply" on this machine, or start the manager from its service.', { exitCode: availability.exitCode });
            }
            const barrier = A().barrier();
            barrier.assertEnterable();
            const window = policy.window || null;
            const inWindow = !window || policyModule.inWindow(window, now());
            const scheduled = when === 'window' && !inWindow;
            const steps = stepList(APPLY_STEPS);
            const running = core.runningRelease(doc);
            const signature = install.signatureOf({ kind: 'update.apply', id: doc.installationId, from: doc.release.releaseId, to: staged.releaseId });
            const plan = {
                ...view,
                signature,
                stateDigest: install.signatureOf({ revision: doc.revision, staged: staged.releaseId, current: running.releaseId }),
                from: { releaseId: running.releaseId, version: running.version },
                to: { releaseId: staged.releaseId, version: staged.version },
                features: staged.features,
                schemaChanging: Boolean(staged.schemaChanging),
                rollback: staged.schemaChanging
                    ? 'Automatic only while no worker got past /health on the new release; after that the barrier stays held and you decide: restore the backup (loses writes since it) or retry.'
                    : 'Automatic: the previous release is put back and verified.',
                backup: { required: true, verified: true, includesConfig: false, estimateBytes: stageHelpers.backupEstimate() },
                downtime: 'From the moment every writer is quiesced to the moment the barrier is released: the backup, the activation, the restart and the verification all happen inside it.',
                handoff: { mode: availability.mode, exitCode: availability.exitCode, selfReplacing: availability.selfReplacing },
                window: window ? { ...window } : null,
                when,
                ...(scheduled ? { scheduled: { opensAt: policyModule.nextOpen(window, now()).toISOString() } } : {}),
                installedFiles: 'config.json, features.json and the data roots are never touched',
                steps
            };
            return { doc, plan, revision: doc.revision, privateInput: { raw, staged, stagingDir: dir, when, scheduled } };
        }

        const gate = (name, body) => install.step(name, async (record, ctx) => {
            if (ctx.scratch.scheduled) return { status: 'skipped', code: 'SCHEDULED' };
            return body(record, ctx);
        });

        /** Release the barrier of a run that failed before it changed anything. */
        async function backOut(record, ctx) {
            const op = ctx.scratch.op;
            if (!op) return;
            try {
                await A().barrier().release({ operationId: op.operationId, fence: op.fence, actor: record.actor });
            } catch { }
        }

        const guarded = (name, body) => gate(name, async (record, ctx) => {
            try {
                return await body(record, ctx);
            } catch (error) {
                if (!ctx.scratch.mutating) await backOut(record, ctx);
                throw error;
            }
        });

        const handoffOf = (record, ctx) => {
            const h = ctx.scratch.handoff;
            if (!h) throw new ManagerError(409, 'HANDOFF_LOST', 'The update lost its handoff record; read update status.');
            return h;
        };

        return {
            kind: 'update.apply',
            public: true,
            allowed: (st, via) => claimed(st, via, VIA),
            async plan(input, ctx) {
                const built = await build(input, ctx);
                return { plan: built.plan, revision: built.revision, privateInput: built.privateInput };
            },
            async validate(record, ctx) {
                const input = needInput(ctx);
                const built = await build(input.raw, ctx);
                if (built.plan.stateDigest !== record.plan.stateDigest) throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation or the staged release changed since this plan was made; plan again.');
                ctx.input = built.privateInput;
            },
            steps: [
                install.step('preflight', async (record, ctx) => {
                    const input = needInput(ctx);
                    const doc = core.ownedRecord(ctx);
                    ctx.scratch.scheduled = Boolean(input.scheduled);
                    ctx.scratch.staged = input.staged;
                    ctx.scratch.stagingDir = input.stagingDir;
                    if (input.scheduled) {
                        state.write('scheduled', { requestedAt: stampOf(), opensAt: record.plan.scheduled.opensAt, release: input.staged.version });
                        return { status: 'skipped', code: 'SCHEDULED', detail: { opensAt: record.plan.scheduled.opensAt } };
                    }
                    state.clear('scheduled');
                    ctx.scratch.mode = A().handoffMode(doc);
                    return { detail: { mode: ctx.scratch.mode } };
                }),
                guarded('maintenance', async (record, ctx) => {
                    const b = A().barrier();
                    const resolved = await b.preflight({ actor: record.actor, ctx });
                    const { fence } = b.begin({ operationId: record.id, actor: record.actor, via: record.via, reason: 'update' });
                    ctx.scratch.op = { operationId: record.id, fence };
                    const out = await b.quiesce({ operationId: record.id, fence, resolved, timeoutSeconds: 120, actor: record.actor });
                    await b.verify({ operationId: record.id, fence, resolved, writers: out.writers, sent: out.sent, actor: record.actor });
                    ctx.scratch.quiescedAtMs = now().getTime();
                    return { detail: { fence, writers: Object.keys(out.writers).length } };
                }),
                guarded('backup', async (record, ctx) => {
                    const op = ctx.scratch.op;
                    const probe = await A().runChild('probeTarget', { engine: settings.dbUrl ? 'postgres' : 'sqlite', sqlitePath: settings.sqlitePath });
                    if (!probe.hasData) {
                        ctx.scratch.backup = null;
                        return { status: 'skipped', code: 'TARGET_EMPTY' };
                    }
                    A().ensurePhase(op, 'backup', record.actor);
                    const dir = path.join(settings.dataDir, 'backups');
                    backupPaths.assertDestination(settings, dir);
                    const out = await A().runChild('backup', { destDir: dir, passphrase: null, includeConfig: false, quiesced: true, compareLive: true });
                    if (!out.verified) {
                        throw new ManagerError(409, 'BACKUP_UNVERIFIED', 'The backup taken before the update could not be verified against the live database; nothing was changed and the update did not run.', { problems: out.problems, tables: out.mismatchedTables });
                    }
                    ctx.scratch.backup = { name: path.basename(out.dir), at: stampOf() };
                    return { detail: { verified: true, tables: out.tables, rows: out.rows } };
                }),
                gate('activate', async (record, ctx) => {
                    const op = ctx.scratch.op;
                    const doc = core.ownedRecord(ctx);
                    const staged = ctx.scratch.staged;
                    const options = core.payloadVerifyOptions();
                    const stage = release.payloadStage();
                    const from = core.runningRelease(doc);
                    const baseHandoff = {
                        operationId: op.operationId,
                        fence: op.fence,
                        actor: record.actor,
                        phase: 'activating',
                        from: { releaseId: from.releaseId, version: from.version, features: from.features, target: from.target, schemaFingerprint: from.schemaFingerprint || null },
                        to: { releaseId: staged.releaseId, version: staged.version, features: staged.features, target: staged.target, schemaFingerprint: staged.schemaFingerprint },
                        schemaChanging: Boolean(staged.schemaChanging),
                        backup: ctx.scratch.backup,
                        quiescedAtMs: ctx.scratch.quiescedAtMs,
                        attempts: 0,
                        startedAt: stampOf()
                    };
                    try {
                        A().ensurePhase(op, 'mutate', record.actor);
                    } catch (error) {
                        await backOut(record, ctx);
                        throw error;
                    }
                    ctx.scratch.mutating = true;
                    state.write('watchdog', { operationId: op.operationId, previousReleaseId: from.releaseId, toReleaseId: staged.releaseId, deadline: new Date(now().getTime() + A().watchdogMs()).toISOString() });
                    ctx.scratch.handoff = state.write('handoff', baseHandoff);
                    A().prewarm();
                    try {
                        stage.activate(ctx.scratch.stagingDir, doc.roots.code, options);
                    } catch (error) {
                        try { stage.recoverInstall(doc.roots.code); } catch { }
                        if (A().currentReleaseId(doc.roots.code) === from.releaseId) {
                            state.clear('handoff');
                            state.clear('watchdog');
                            try { await A().barrier().release({ operationId: op.operationId, fence: op.fence, acknowledgeMutation: true, actor: record.actor }); } catch { }
                        }
                        throw release.mapPayloadError(error) || error;
                    }
                    ctx.scratch.handoff = state.write('handoff', { ...baseHandoff, phase: 'pending', flippedAt: stampOf() });
                    state.clear('staged');
                    return { detail: { releaseId: staged.releaseId } };
                }),
                gate('handoff', async (record, ctx) => {
                    const doc = core.ownedRecord(ctx);
                    const mode = A().handoffMode(doc);
                    ctx.scratch.modeAtHandoff = mode;
                    if (mode === 'inline') return { status: 'skipped', code: 'INLINE' };
                    if (mode === 'exit') {
                        A().scheduleExit();
                        return { code: 'HANDOFF_PENDING', detail: { handoff: 'pending', exitCode: A().EXIT_SELF_UPDATE } };
                    }
                    return { code: 'HANDOFF_PENDING', detail: { handoff: 'pending', next: 'manager-start' } };
                }),
                gate('verify', async (record, ctx) => {
                    if (ctx.scratch.modeAtHandoff !== 'inline') return { status: 'deferred', code: 'HANDOFF_PENDING' };
                    const h = handoffOf(record, ctx);
                    const verified = await A().verifyPhase(h, { restart: true });
                    if (verified.ok) return { code: verified.code || undefined, detail: { reached: verified.reached } };
                    const out = await A().failure(h, { code: verified.code, reached: verified.reached });
                    ctx.scratch.failure = out;
                    throw new ManagerError(409, out.outcome === 'recovery' ? 'UPDATE_RECOVERY_REQUIRED' : 'UPDATE_ROLLED_BACK',
                        out.outcome === 'recovery'
                            ? 'The new release failed after the database was in use and the update changed the schema. The maintenance barrier stays held; decide with update recovery: restore the backup or retry.'
                            : 'The new release did not verify; the previous release was put back and verified.',
                        { cause: verified.code, outcome: out.outcome });
                }),
                gate('cutover', async (record, ctx) => {
                    if (ctx.scratch.modeAtHandoff !== 'inline') return { status: 'deferred', code: 'HANDOFF_PENDING' };
                    const h = state.read('handoff');
                    A().cutoverPhase(h);
                    return { detail: { releaseId: h.to.releaseId } };
                }),
                gate('release', async (record, ctx) => {
                    if (ctx.scratch.modeAtHandoff !== 'inline') return { status: 'deferred', code: 'HANDOFF_PENDING' };
                    const h = state.read('handoff');
                    const out = await A().releasePhase(h, { outcome: 'applied' });
                    ctx.scratch.downtimeMs = out.downtimeMs;
                    ctx.scratch.applied = true;
                    return { detail: { downtimeMs: out.downtimeMs } };
                })
            ],
            result: (scratch) => {
                if (scratch.scheduled) return { outcome: 'scheduled' };
                const h = scratch.handoff;
                const applied = Boolean(scratch.applied);
                return {
                    outcome: applied ? 'applied' : 'handoff-pending',
                    ...(h ? { from: h.from.version, to: h.to.version, schemaChanging: h.schemaChanging } : {}),
                    ...(applied ? { downtimeMs: scratch.downtimeMs } : { handoff: scratch.modeAtHandoff === 'exit' ? 'The manager is leaving with exit code 76; the OS service restarts it on the new release and it finishes the update.' : 'The new release is in place; the manager completes the update when it next starts.' }),
                    ...(scratch.backup ? { backup: { verified: true, at: scratch.backup.at } } : {})
                };
            },
            auditDetail: (record, scratch) => scratch.scheduled
                ? { outcome: 'scheduled' }
                : { outcome: scratch.applied ? 'applied' : 'handoff-pending', mode: scratch.modeAtHandoff || 'none', schemaChanging: Boolean(scratch.handoff && scratch.handoff.schemaChanging), ...(scratch.downtimeMs !== undefined ? { downtimeMs: scratch.downtimeMs } : {}) }
        };
    }

    // ------------------------------------------------------- update.policy
    function policyKind() {
        function parse(input, doc) {
            exactKeys(input, new Set(['channel', 'mode', 'window', 'source']), 'update.policy');
            const base = { ...core.policyOf(doc) };
            const merged = { ...base };
            for (const key of ['channel', 'mode']) if (input[key] !== undefined) merged[key] = input[key];
            if (input.window !== undefined) {
                if (input.window === null) delete merged.window;
                else merged.window = input.window;
            }
            if (input.source !== undefined) {
                if (input.source === null) delete merged.source;
                else merged.source = input.source;
            }
            return policyModule.normalise(merged);
        }
        return {
            kind: 'update.policy',
            public: true,
            allowed: (st, via) => claimed(st, via, VIA),
            plan(input, ctx) {
                const doc = core.ownedRecord(ctx);
                const next = parse(input === undefined ? {} : input, doc);
                const effective = policyModule.effectiveMode(next, doc.updater);
                return {
                    plan: {
                        action: 'policy',
                        from: core.policyOf(doc),
                        to: next,
                        effectiveMode: effective.mode,
                        ...(effective.capped ? { capped: 'apply is honoured only while the manager is the updater' } : {}),
                        steps: stepList(['record']),
                        stateDigest: install.signatureOf({ revision: doc.revision })
                    },
                    revision: doc.revision,
                    privateInput: { next }
                };
            },
            validate(record, ctx) {
                const doc = core.ownedRecord(ctx);
                if (doc.revision !== record.revision) throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since this plan was made; plan again.');
            },
            steps: [
                install.step('record', (record, ctx) => {
                    const { next } = needInput(ctx);
                    const stored = ctx.store.updateInstallation(draft => ({ ...draft, update: next }), { expectedRevision: record.revision });
                    ctx.scratch.policy = stored.update || next;
                    return { detail: { mode: next.mode, channel: next.channel } };
                })
            ],
            result: (scratch) => ({ policy: scratch.policy }),
            auditDetail: (record, scratch) => ({ mode: scratch.policy.mode, channel: scratch.policy.channel, source: scratch.policy.source ? scratch.policy.source.kind : 'default', window: Boolean(scratch.policy.window) })
        };
    }

    // ------------------------------------------------------ update.recover
    function recoverKind() {
        function build(input) {
            exactKeys(input === undefined ? {} : input, new Set(['decision']), 'update.recover');
            const raw = input || {};
            if (raw.decision !== 'restore' && raw.decision !== 'retry') throw new ManagerError(400, 'INVALID_INPUT', '"decision" must be "restore" or "retry".');
            const recovery = state.read('recovery');
            const handoff = state.read('handoff');
            if (!recovery || !handoff) throw new ManagerError(409, 'NO_RECOVERY_PENDING', 'No update is waiting for a decision.');
            if (raw.decision === 'restore' && !recovery.backup) throw new ManagerError(409, 'NO_BACKUP', 'This update took no backup (the database held no data), so there is nothing to restore; retry instead.');
            return { decision: raw.decision, recovery, handoff };
        }
        return {
            kind: 'update.recover',
            public: true,
            allowed: (st, via) => claimed(st, via, RECOVER_VIA),
            plan(input, ctx) {
                const doc = core.ownedRecord(ctx);
                const { decision, recovery } = build(input);
                const view = applier().recoveryView();
                return {
                    plan: {
                        action: 'recover',
                        decision,
                        recovery: view,
                        effect: decision === 'restore'
                            ? `The data returns to the backup taken at ${recovery.backup.at}; writes since then are lost (a safety backup of the data as it is now is taken first). The previous release is put back.`
                            : 'The new release is started again and verified; nothing is restored.',
                        steps: stepList(decision === 'restore' ? RECOVER_STEPS : RETRY_STEPS),
                        stateDigest: install.signatureOf({ revision: doc.revision, op: recovery.operationId, at: recovery.at })
                    },
                    revision: doc.revision,
                    privateInput: { raw: input || {} }
                };
            },
            validate(record, ctx) {
                const { recovery } = build(needInput(ctx).raw);
                if (install.signatureOf({ revision: record.revision, op: recovery.operationId, at: recovery.at }) !== record.plan.stateDigest) {
                    throw new ManagerError(409, 'REVISION_CONFLICT', 'The recovery state changed since this plan was made; plan again.');
                }
            },
            steps: [
                install.step('restore-data', (record) => {
                    if (record.plan.decision !== 'restore') return { status: 'skipped', code: 'NOT_REQUESTED' };
                    const recovery = state.read('recovery');
                    if (!recovery || !recovery.restoredAt) {
                        throw new ManagerError(409, 'RESTORE_FIRST', 'The data has not been restored yet; use the recovery command, which restores it and then finishes the update.');
                    }
                    return { detail: { restored: true } };
                }),
                install.step('put-back', async (record, ctx) => {
                    const h = state.read('handoff');
                    const recovery = state.read('recovery');
                    if (record.plan.decision === 'restore') {
                        ctx.scratch.out = await applier().finishRestore(h);
                        return { detail: { outcome: ctx.scratch.out.outcome } };
                    }
                    ctx.scratch.out = await applier().retry(h, recovery);
                    return { detail: { outcome: ctx.scratch.out.outcome } };
                }),
                install.step('verify', (record, ctx) => {
                    const out = ctx.scratch.out;
                    if (out.outcome === 'recovery') throw new ManagerError(409, 'UPDATE_RECOVERY_REQUIRED', 'The decision was carried out and the release still does not verify; the barrier stays held. Decide again.', { cause: out.code });
                    return { detail: { outcome: out.outcome } };
                }),
                install.step('release', (record, ctx) => {
                    const out = ctx.scratch.out;
                    if (out.outcome === 'rolling_back') return { status: 'deferred', code: 'HANDOFF_PENDING' };
                    return { detail: { outcome: out.outcome, ...(out.downtimeMs !== undefined && out.downtimeMs !== null ? { downtimeMs: out.downtimeMs } : {}) } };
                })
            ],
            result: (scratch) => scratch.out || null,
            auditDetail: (record, scratch) => ({ decision: record.plan.decision, outcome: scratch.out ? scratch.out.outcome : 'unknown' })
        };
    }

    /**
     * The operator's decision as one call: for `restore`, the previous release goes back on disk,
     * the data is restored from the backup taken before the update (`backup.restore` inside the
     * held barrier, which restarts the workers on the previous release) and `update.recover`
     * finishes it; for `retry`, `update.recover` alone.
     */
    async function decide({ decision, auth }) {
        const { engine, store } = parts();
        const h = state.read('handoff');
        const r = state.read('recovery');
        if (!h || !r) throw new ManagerError(409, 'NO_RECOVERY_PENDING', 'No update is waiting for a decision.');
        if (decision === 'restore') {
            if (!r.backup) throw new ManagerError(409, 'NO_BACKUP', 'This update took no backup (the database held no data), so there is nothing to restore; retry instead.');
            if (!r.restoredAt) {
                const doc = store.readInstallation();
                if (doc.status !== 'ok') throw new ManagerError(409, 'NOT_INSTALLED', 'There is no usable installation record.');
                const bar = applier().adoptBarrier(h);
                if (!bar) throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier of this update is not held any more; read the maintenance state.');
                applier().putPreviousBack(doc.doc, h.from);
                await engine.run('backup.restore', {
                    dir: path.join(settings.dataDir, 'backups', r.backup.name),
                    confirm: doc.doc.installationId,
                    maintenance: { operationId: h.operationId, fence: h.fence },
                    acceptSchemaChange: true,
                    withoutConfig: true
                }, auth);
                state.write('recovery', { ...(state.read('recovery') || r), restoredAt: stampOf() });
            }
        }
        return engine.run('update.recover', { decision }, auth);
    }
    wiring.setDecider(settings.storeDir, decide);
    wiring.setApplier(settings.storeDir, () => applier());

    return [checkKind(), stageKind(), applyKind(), policyKind(), recoverKind()];
}

module.exports = { createKinds, CHECK_STEPS, STAGE_STEPS, APPLY_STEPS, RECOVER_STEPS, RETRY_STEPS };
