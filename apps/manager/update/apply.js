/**
 * Applying a staged release (documentation/manager_update.md): the maintenance barrier around
 * activate, the OS-supervised handoff, verification, cutover, the compatible rollback and the
 * recovery a schema-changing failure leaves behind.
 *
 * One machine serves two callers. The `update.apply` kind runs it from plan to the handoff (and,
 * when this manager's own code does not change, on to the release of the barrier). A manager that
 * starts and finds `handoff.json` runs the rest (`resume`). Every durable boundary is written to
 * the update state before the step it announces, so a crash anywhere leaves a state `resume`
 * can read.
 *
 * Nothing here names a path, a URL, a token or a row in a ledger, an audit row or a log line.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ManagerError } = require('../errors');
const release = require('../install/release');
const registry = require('../lifecycle/registry');
const { createBarrier } = require('../maintenance/barrier');
const { createChildRunner } = require('../backup/runChild');
const { createServiceRefresh } = require('./serviceTemplate');

/** The exit code a manager leaves with to be restarted by the OS supervisor on the new release. 75 is the workers'. */
const EXIT_SELF_UPDATE = 76;
const WATCHDOG_MS = 10 * 60_000;
const EXIT_DELAY_MS = 1200;
const VERIFY_TIMEOUT_MS = 150_000;
const SETTLE_MS = 30_000;
const SETTLE_ENV = 'GOOBSTER_UPDATE_SETTLE_MS';
const RANK = Object.freeze({ quiesced: 0, backup: 1, mutate: 2, verify: 3, cutover: 4 });
const NEXT_STEP_NAMES = Object.freeze(['verify', 'cutover', 'release']);

function createApplier({ core, store, journal, logger = console }) {
    const { settings, fs = nodeFs, now, state } = core;
    const deps = core.deps;
    const storeDir = settings.storeDir;
    const stamp = () => now().toISOString();

    const barrier = () => createBarrier({ settings, fs, now, logger, ...(deps.barrier || {}) });
    const supervisor = () => deps.supervisor || registry.get(storeDir);
    const runChild = (...args) => (deps.runChild || createChildRunner({ settings, ...(deps.spawn ? { spawn: deps.spawn } : {}) }))(...args);
    const exitHandler = () => deps.exit || registry.getExitHandler(storeDir);
    const watchdogMs = () => (Number.isFinite(deps.watchdogMs) ? deps.watchdogMs : WATCHDOG_MS);
    const verifyTimeoutMs = () => (Number.isFinite(deps.verifyTimeoutMs) ? deps.verifyTimeoutMs : VERIFY_TIMEOUT_MS);
    /** The settle window: the test seam, then GOOBSTER_UPDATE_SETTLE_MS (whole milliseconds, 0 to 600000), then 30 s. */
    const settleMs = () => {
        if (Number.isFinite(deps.settleMs)) return deps.settleMs;
        const raw = String((core.env || {})[SETTLE_ENV] ?? '').trim();
        if (/^\d{1,6}$/.test(raw) && Number(raw) <= 600_000) return Number(raw);
        return SETTLE_MS;
    };

    // ---------------------------------------------------------------- facts
    const codeRootOf = (doc) => doc.roots.code;

    function currentReleaseId(codeRoot) {
        try {
            return release.loadManifest(path.join(codeRoot, 'current'), fs).releaseId;
        } catch {
            return null;
        }
    }

    function isInside(child, parent) {
        const rel = path.relative(parent, child);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    }

    /** Does this manager process run from the payload an update replaces? */
    function selfReplacing(doc) {
        if (typeof deps.runsFromPayload === 'boolean') return deps.runsFromPayload;
        return isInside(path.resolve(settings.root), path.join(codeRootOf(doc), 'current'));
    }

    /** Will the OS restart this process when it exits with a failure code? */
    function osSupervised() {
        if (typeof deps.osSupervised === 'boolean') return deps.osSupervised;
        const env = core.env;
        if (env.GOOBSTER_MANAGER_OS_SUPERVISED === '1') return true;
        if (process.platform === 'linux' && env.INVOCATION_ID) return true;
        if (process.platform === 'darwin' && env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== '0') return true;
        return false;
    }

    /**
     * How this apply will hand over. `inline`: the manager's own code does not change, so the
     * workers restart and verify in this process. `exit`: the manager leaves with 76 and the OS
     * brings it back on the new release. `offline`: nothing is running; the next manager start
     * completes the handoff.
     */
    function handoffMode(doc) {
        const sup = supervisor();
        const replacing = selfReplacing(doc);
        if (!replacing) return sup ? 'inline' : 'offline';
        if (exitHandler() && osSupervised()) return 'exit';
        if (exitHandler()) return 'unavailable';
        return 'offline';
    }

    function handoffAvailability(doc) {
        const mode = handoffMode(doc);
        return { mode, selfReplacing: selfReplacing(doc), osSupervised: osSupervised(), supervising: Boolean(supervisor()), exitCode: EXIT_SELF_UPDATE };
    }

    function prewarm() {
        for (const load of [() => require('./apply'), () => require('./runtime'), () => require('../maintenance/barrier'), () => require('../backup/runChild'), () => require('../install/release'), () => require('../lifecycle/registry')]) {
            try { load(); } catch { }
        }
        for (const load of [release.payloadStage, release.releaseIndex]) {
            try { load(); } catch { }
        }
    }

    // --------------------------------------------------------------- ledger
    /** Mark one step of an operation's ledger (the same shape `createInstallCore().step` writes). */
    function mark(operationId, name, status, code = null) {
        try {
            journal.update(operationId, (r) => {
                const names = (r.plan && Array.isArray(r.plan.steps)) ? r.plan.steps.map(item => item.name) : [];
                const progress = Array.isArray(r.progress) ? r.progress : names.map(item => ({ name: item, status: 'pending', at: null }));
                const entry = { name, status, ...(code ? { code } : {}), at: stamp() };
                const at = progress.findIndex(item => item.name === name);
                if (at >= 0) progress[at] = entry;
                else progress.push(entry);
                r.progress = progress;
                return r;
            });
        } catch { }
    }

    async function audit(action, { operationId, actor = null, via = null, outcome, detail = null }) {
        try {
            await journal.appendAudit({ action, actor, operationId, outcome, via, detail });
        } catch { }
    }

    /** One audit entry for what the new manager finished, linked to the apply's operation by id. */
    async function auditCompletion(h, outcome, code) {
        await audit('manager.update.handoff', {
            operationId: crypto.randomUUID(),
            actor: h.actor || null,
            via: 'local',
            outcome,
            detail: { operationRef: h.operationId, ...(code ? { code } : {}), downtimeMs: h.downtimeMs ?? 0, schemaChanging: Boolean(h.schemaChanging) }
        });
    }

    // -------------------------------------------------------------- barrier
    function ensurePhase(op, target, actor = null) {
        const b = barrier();
        const view = b.view();
        if (!view.active || view.operationId !== op.operationId || view.fence !== op.fence) {
            throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier is no longer held by this update.');
        }
        if ((RANK[view.phase] ?? -1) >= RANK[target]) return view.phase;
        const order = ['quiesced', 'backup', 'mutate', 'verify', 'cutover'];
        let phase = view.phase;
        while (phase !== target) {
            const nextPhase = target === 'mutate' && phase === 'quiesced' ? 'mutate' : (order[order.indexOf(phase) + 1]);
            b.advance({ operationId: op.operationId, fence: op.fence, to: nextPhase, actor });
            phase = nextPhase;
        }
        return phase;
    }

    /** Take over the barrier a previous manager process left for this update, if it is still the update's. */
    function adoptBarrier(h) {
        const b = barrier();
        const view = b.view();
        if (!view.active) return false;
        if (view.operationId !== h.operationId || view.fence !== h.fence) return false;
        if (view.stale) b.adopt({ operationId: h.operationId, fence: h.fence, actor: h.actor || null });
        return true;
    }

    async function releaseBarrier(h, { acknowledgeMutation = false } = {}) {
        const b = barrier();
        const view = b.view();
        if (!view.active || view.operationId !== h.operationId || view.fence !== h.fence) return { outcome: 'not-held' };
        return b.release({ operationId: h.operationId, fence: h.fence, acknowledgeMutation, actor: h.actor || null });
    }

    // ------------------------------------------------------- on-disk swaps
    /**
     * Put the previous release back as `current`: rename, never copy, so a crash between the two
     * renames leaves `previous` for `recoverInstall` to promote. Falls back to staging the
     * retained copy under `releases/` when `previous` is not the release being put back.
     */
    function swapBack(codeRoot, from, options) {
        const stage = release.payloadStage();
        stage.recoverInstall(codeRoot);
        const current = path.join(codeRoot, 'current');
        const previous = path.join(codeRoot, 'previous');
        let previousId = null;
        try { previousId = release.loadManifest(previous, fs).releaseId; } catch { }
        if (previousId === from.releaseId) {
            const aside = path.join(codeRoot, `.failed-${crypto.randomBytes(4).toString('hex')}`);
            fs.renameSync(current, aside);
            fs.renameSync(previous, current);
            core.removeTree(aside);
            return { via: 'previous' };
        }
        const retained = path.join(codeRoot, 'releases', from.releaseId);
        if (!fs.existsSync(path.join(retained, stage.MANIFEST_FILE))) {
            throw new ManagerError(409, 'PREVIOUS_UNAVAILABLE', 'The previous release is not on disk any more, so it cannot be put back.');
        }
        const staged = core.install.stageSelectionInto({ sources: retained, codeRoot, features: from.features, profile: null, options });
        stage.activate(staged.stagingDir, codeRoot, options);
        return { via: 'releases' };
    }

    // ------------------------------------------------------------- verify
    /** The watch after readiness: the window's end is written to the handoff so `update status` can show it. */
    const watchOptions = (releaseId, onSettle) => ({
        releaseId,
        timeoutMs: verifyTimeoutMs(),
        settleMs: settleMs(),
        onSettle: ({ until }) => {
            if (onSettle) onSettle(until);
        }
    });

    async function restartAndVerify(releaseId, onSettle = null) {
        const sup = supervisor();
        if (!sup) return { ok: true, code: 'NOT_SUPERVISED', reached: false, skipped: true };
        if (typeof sup.restartAll !== 'function') return { ok: false, code: 'RESTART_UNSUPPORTED', reached: false };
        let out;
        try {
            out = await sup.restartAll();
        } catch (error) {
            return { ok: false, code: error && error.code ? error.code : 'RESTART_FAILED', reached: false };
        }
        if (!out.ok) return out;
        return sup.verifyRunning(watchOptions(releaseId, onSettle));
    }

    async function verifyRunning(releaseId, onSettle = null) {
        const sup = supervisor();
        if (!sup) return { ok: true, code: 'NOT_SUPERVISED', reached: false, skipped: true };
        return sup.verifyRunning(watchOptions(releaseId, onSettle));
    }

    // ----------------------------------------------------------- the phases
    const writeHandoff = (h, patch = {}) => state.write('handoff', { ...h, ...patch });

    /**
     * Step `verify`: the workers run the new release, healthy and acknowledged, and stay up for
     * the settle window. The barrier is held throughout, so the window is part of the downtime.
     */
    async function verifyPhase(h, { restart }) {
        ensurePhase(h, 'verify', h.actor);
        const onSettle = (until) => {
            try { writeHandoff(state.read('handoff') || h, { settleUntil: until }); } catch { }
        };
        const out = restart ? await restartAndVerify(h.to.releaseId, onSettle) : await verifyRunning(h.to.releaseId, onSettle);
        if (!out.ok) return { ok: false, code: out.code || 'VERIFY_FAILED', reached: Boolean(out.reached), worker: out.worker };
        writeHandoff(state.read('handoff') || h, { phase: 'verified', verifiedAt: stamp(), reached: Boolean(out.reached), settleUntil: null });
        return { ok: true, code: out.skipped ? 'NOT_SUPERVISED' : null, reached: Boolean(out.reached) };
    }

    /** Step `cutover`: the install record names the new release and the barrier moves to its last phase. */
    function cutoverPhase(h) {
        ensurePhase(h, 'cutover', h.actor);
        const doc = store.readInstallation();
        if (doc.status !== 'ok') throw new ManagerError(409, 'NOT_INSTALLED', 'There is no usable installation record to record the release in.');
        if (!doc.doc.release || doc.doc.release.releaseId !== h.to.releaseId) {
            store.updateInstallation(draft => ({
                ...draft,
                release: {
                    releaseId: h.to.releaseId,
                    version: h.to.version,
                    target: h.to.target,
                    features: h.to.features,
                    ...(h.to.schemaFingerprint ? { schemaFingerprint: h.to.schemaFingerprint } : {})
                }
            }));
        }
        try { barrier().settle({ operationId: h.operationId, fence: h.fence, outcome: 'ok', code: 'UPDATE_CUTOVER', actor: h.actor || null }); } catch { }
        writeHandoff(h, { phase: 'recorded', recordedAt: stamp() });
        return { releaseId: h.to.releaseId };
    }

    /**
     * After a successful update, and after the barrier is lifted (it is not part of the downtime): re-register the
     * operating-system service when the new release renders a different definition. Never fails the update.
     */
    async function refreshService(h) {
        const refresher = createServiceRefresh({ core: core.install, settings, store, journal, fs, now });
        const out = await refresher.refresh({ operationId: h.operationId, actor: h.actor || null, via: h.via || null });
        return ['none', 'unregistered', 'unchanged', 'baseline'].includes(out.template) ? null : out;
    }

    /** Step `release`: lift the barrier, measure the downtime, forget the handoff. */
    async function releasePhase(h, { outcome = 'applied', code = null } = {}) {
        const out = await releaseBarrier(h, { acknowledgeMutation: outcome !== 'applied' });
        const releasedAtMs = now().getTime();
        const downtimeMs = h.quiescedAtMs ? Math.max(0, releasedAtMs - h.quiescedAtMs) : null;
        const service = outcome === 'applied' ? await refreshService(h) : null;
        const last = state.write('last-apply', {
            outcome,
            ...(code ? { code } : {}),
            operationId: h.operationId,
            from: { releaseId: h.from.releaseId, version: h.from.version },
            to: { releaseId: h.to.releaseId, version: h.to.version },
            schemaChanging: Boolean(h.schemaChanging),
            ...(downtimeMs === null ? {} : { downtimeMs }),
            ...(h.backup ? { backup: { verified: true, at: h.backup.at } } : {}),
            ...(service ? { service } : {}),
            finishedAt: stamp()
        });
        state.clear('handoff');
        state.clear('watchdog');
        state.clear('recovery');
        return { outcome, downtimeMs, barrier: out.outcome, last, ...(service ? { service } : {}) };
    }

    /** The end of a successful apply: verify (done by the caller), cutover and release. */
    async function finishSuccess(h) {
        const hh = { ...h, quiescedAtMs: h.quiescedAtMs };
        cutoverPhase(hh);
        mark(h.operationId, 'cutover', 'done');
        const out = await releasePhase(hh, { outcome: 'applied' });
        mark(h.operationId, 'release', 'done');
        return out;
    }

    // ------------------------------------------------------ failure policy
    /** A failure after the flip: roll back when that is compatible, otherwise leave it to the operator. */
    async function failure(h, { code, reached = false, optionsFor }) {
        const unsafe = Boolean(h.schemaChanging) && (reached || Boolean(h.reached) || (h.attempts || 0) > 1);
        if (unsafe) return enterRecovery(h, { code: 'SCHEMA_CHANGED_DATABASE_IN_USE', cause: code, target: 'to' });
        return rollback(h, { code, optionsFor });
    }

    function enterRecovery(h, { code, cause = null, target }) {
        state.write('recovery', {
            operationId: h.operationId,
            fence: h.fence,
            code,
            ...(cause ? { cause } : {}),
            target,
            from: h.from,
            to: h.to,
            schemaChanging: Boolean(h.schemaChanging),
            backup: h.backup || null,
            quiescedAtMs: h.quiescedAtMs || null,
            actor: h.actor || null,
            at: stamp()
        });
        state.write('handoff', { ...h, phase: 'recovery', recoveryCode: code });
        state.clear('watchdog');
        mark(h.operationId, 'verify', 'failed', cause || code);
        return { outcome: 'recovery', code, cause };
    }

    /**
     * Put the previous release back and verify it. With a handoff in flight and the OS able to
     * restart this manager, the manager leaves again so that its own code is the previous one's;
     * the old manager finishes it (`resume` phase `rollback`).
     */
    async function rollback(h, { code, optionsFor }) {
        const doc = store.readInstallation();
        if (doc.status !== 'ok') return enterRecovery(h, { code: 'NOT_INSTALLED', cause: code, target: 'to' });
        const codeRoot = codeRootOf(doc.doc);
        state.write('handoff', { ...h, phase: 'rollback', rollbackCode: code });
        try {
            if (currentReleaseId(codeRoot) !== h.from.releaseId) swapBack(codeRoot, h.from, optionsFor ? optionsFor() : core.payloadVerifyOptions());
        } catch (error) {
            return enterRecovery({ ...h, phase: 'rollback' }, { code: error && error.code ? error.code : 'ROLLBACK_FAILED', cause: code, target: 'to' });
        }
        mark(h.operationId, 'verify', 'failed', code);
        const mode = handoffMode(doc.doc);
        if (mode === 'exit' && selfReplacing(doc.doc) && h.runningRelease === 'to') {
            scheduleExit();
            return { outcome: 'rolling_back', code };
        }
        return finishRollback({ ...h, phase: 'rollback', rollbackCode: code });
    }

    async function finishRollback(h) {
        const out = await restartAndVerify(h.from.releaseId);
        if (!out.ok) return enterRecovery(h, { code: 'ROLLBACK_VERIFY_FAILED', cause: out.code, target: 'from' });
        const result = await releasePhase(h, { outcome: 'rolled_back', code: h.rollbackCode || null });
        return { outcome: 'rolled_back', code: h.rollbackCode || null, downtimeMs: result.downtimeMs };
    }

    function scheduleExit(delayMs = EXIT_DELAY_MS) {
        const handler = exitHandler();
        if (!handler) return false;
        const timer = setTimeout(() => {
            Promise.resolve().then(() => handler(EXIT_SELF_UPDATE)).catch(() => {});
        }, delayMs);
        timer.unref?.();
        return true;
    }

    // ------------------------------------------------------------- resume
    /**
     * What a manager does at start when `handoff.json` exists: finish the apply the previous
     * manager process began. Returns `{ resumed: false }` when there is nothing to do.
     */
    async function resume({ optionsFor } = {}) {
        let h = state.read('handoff');
        if (!h) {
            state.clear('watchdog');
            return { resumed: false };
        }
        const doc = store.readInstallation();
        if (doc.status !== 'ok') return { resumed: false, code: 'NOT_INSTALLED' };
        const codeRoot = codeRootOf(doc.doc);
        const here = currentReleaseId(codeRoot);
        h = writeHandoff(h, { attempts: (h.attempts || 0) + 1, runningRelease: here === h.to.releaseId ? 'to' : 'from' });
        const holds = adoptBarrier(h);
        const dog = state.read('watchdog');
        const expired = Boolean(dog && Date.parse(dog.deadline) <= now().getTime());

        if (h.phase === 'activating') {
            if (here === h.from.releaseId) {
                state.clear('handoff');
                state.clear('watchdog');
                if (holds) await releaseBarrier(h, { acknowledgeMutation: true });
                state.write('last-apply', { outcome: 'abandoned', code: 'FLIP_NOT_REACHED', operationId: h.operationId, from: { releaseId: h.from.releaseId, version: h.from.version }, to: { releaseId: h.to.releaseId, version: h.to.version }, finishedAt: stamp() });
                await auditCompletion(h, 'abandoned', 'FLIP_NOT_REACHED');
                return { resumed: true, outcome: 'abandoned', code: 'FLIP_NOT_REACHED' };
            }
            if (here !== h.to.releaseId) return finishWith(enterRecovery(h, { code: 'RELEASE_UNEXPECTED', target: 'to' }), h);
            h = writeHandoff(h, { phase: 'pending', flippedAt: stamp() });
        }

        if (h.phase === 'recovery') return { resumed: true, outcome: 'recovery', code: h.recoveryCode || null };

        if (h.phase === 'rollback') {
            if (here !== h.from.releaseId) {
                try { swapBack(codeRoot, h.from, optionsFor ? optionsFor() : core.payloadVerifyOptions()); } catch (error) {
                    return finishWith(enterRecovery(h, { code: error && error.code ? error.code : 'ROLLBACK_FAILED', cause: h.rollbackCode, target: 'to' }), h);
                }
            }
            return finishWith(await finishRollback(h), h);
        }

        if (here !== h.to.releaseId) {
            return finishWith(enterRecovery(h, { code: 'RELEASE_UNEXPECTED', target: 'to' }), h);
        }

        if (h.phase === 'pending') {
            if (expired) {
                mark(h.operationId, 'verify', 'failed', 'WATCHDOG_EXPIRED');
                return finishWith(await failure(h, { code: 'WATCHDOG_EXPIRED', reached: false, optionsFor }), h);
            }
            state.clear('watchdog');
            const verified = await verifyPhase(h, { restart: false });
            if (!verified.ok) {
                mark(h.operationId, 'verify', 'failed', verified.code);
                return finishWith(await failure(h, { code: verified.code, reached: verified.reached, optionsFor }), h);
            }
            mark(h.operationId, 'verify', 'done', verified.code);
            h = state.read('handoff') || h;
        }
        if (h.phase === 'verified' || h.phase === 'recorded') {
            if (h.phase === 'verified') {
                cutoverPhase(h);
                mark(h.operationId, 'cutover', 'done');
                h = state.read('handoff') || h;
            }
            const out = await releasePhase(h, { outcome: 'applied' });
            mark(h.operationId, 'release', 'done');
            await auditCompletion({ ...h, downtimeMs: out.downtimeMs }, 'applied', null);
            return { resumed: true, outcome: 'applied', downtimeMs: out.downtimeMs };
        }
        return { resumed: false, code: 'UNKNOWN_PHASE' };
    }

    async function finishWith(outcome, h) {
        const result = await outcome;
        if (result.outcome === 'rolled_back') await auditCompletion({ ...h, downtimeMs: result.downtimeMs }, 'rolled_back', result.code);
        else if (result.outcome === 'recovery') await auditCompletion(h, 'recovery', result.code);
        return { resumed: true, ...result };
    }

    // ----------------------------------------------------------- recovery
    /** What the operator is asked to decide, without anything that is a path. */
    function recoveryView() {
        const r = state.read('recovery');
        if (!r) return null;
        return {
            code: r.code,
            cause: r.cause || null,
            target: r.target,
            at: r.at,
            from: r.from,
            to: r.to,
            schemaChanging: Boolean(r.schemaChanging),
            backup: r.backup ? { verified: true, at: r.backup.at, name: r.backup.name } : null,
            restored: Boolean(r.restoredAt),
            decisions: ['restore', 'retry'],
            warning: r.backup
                ? `Restoring returns the data to the backup taken at ${r.backup.at}; every write since then is lost (a safety backup of the data as it is now is taken first).`
                : 'There is no backup to restore.'
        };
    }

    async function retry(h, r) {
        const doc = store.readInstallation();
        if (doc.status !== 'ok') throw new ManagerError(409, 'NOT_INSTALLED', 'There is no usable installation record.');
        const codeRoot = codeRootOf(doc.doc);
        const holds = adoptBarrier(h);
        if (!holds) throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier of this update is not held any more; read the maintenance state.');
        const wantTo = r.target === 'to';
        const want = wantTo ? h.to : h.from;
        if (currentReleaseId(codeRoot) !== want.releaseId) {
            if (wantTo) throw new ManagerError(409, 'RELEASE_UNEXPECTED', 'The release on disk is not the one that failed; restore or stage the update again.');
            swapBack(codeRoot, h.from, core.payloadVerifyOptions());
        }
        state.write('handoff', { ...h, phase: wantTo ? 'pending' : 'rollback', attempts: (h.attempts || 0) });
        state.clear('recovery');
        const out = await restartAndVerify(want.releaseId);
        if (!out.ok) {
            const again = state.read('handoff') || h;
            enterRecovery({ ...again, phase: again.phase }, { code: wantTo ? 'SCHEMA_CHANGED_DATABASE_IN_USE' : 'ROLLBACK_VERIFY_FAILED', cause: out.code, target: wantTo ? 'to' : 'from' });
            return { outcome: 'recovery', code: out.code };
        }
        if (!wantTo) {
            const result = await releasePhase({ ...h, rollbackCode: h.recoveryCode }, { outcome: 'rolled_back', code: h.recoveryCode || null });
            return { outcome: 'rolled_back', downtimeMs: result.downtimeMs };
        }
        writeHandoff(h, { phase: 'verified', verifiedAt: stamp(), reached: true });
        const done = await finishSuccess({ ...h, phase: 'verified' });
        return { outcome: 'applied', downtimeMs: done.downtimeMs };
    }

    /** After the data was restored from the pre-update backup: the previous release, running, and the barrier lifted. */
    function putPreviousBack(doc, from) {
        const codeRoot = codeRootOf(doc);
        if (currentReleaseId(codeRoot) !== from.releaseId) swapBack(codeRoot, from, core.payloadVerifyOptions());
    }

    async function finishRestore(h) {
        const doc = store.readInstallation();
        if (doc.status !== 'ok') throw new ManagerError(409, 'NOT_INSTALLED', 'There is no usable installation record.');
        putPreviousBack(doc.doc, h.from);
        state.write('handoff', { ...h, phase: 'rollback', rollbackCode: 'RESTORED_FROM_BACKUP' });
        const mode = handoffMode(doc.doc);
        if (mode === 'exit' && selfReplacing(doc.doc) && h.runningRelease === 'to') {
            scheduleExit();
            return { outcome: 'rolling_back', code: 'RESTORED_FROM_BACKUP' };
        }
        const result = await finishRollback({ ...h, phase: 'rollback', rollbackCode: 'RESTORED_FROM_BACKUP' });
        return result;
    }

    // ------------------------------------------------------------- status
    function statusOf() {
        const handoff = state.read('handoff');
        const dog = state.read('watchdog');
        const settleLeft = handoff && handoff.phase === 'pending' && handoff.settleUntil ? Math.max(0, Math.ceil((Date.parse(handoff.settleUntil) - now().getTime()) / 1000)) : null;
        return {
            handoff: handoff ? {
                phase: handoff.phase,
                operationRef: handoff.operationId,
                from: handoff.from.version,
                to: handoff.to.version,
                schemaChanging: Boolean(handoff.schemaChanging),
                flippedAt: handoff.flippedAt || null,
                attempts: handoff.attempts || 0,
                ...(settleLeft === null ? {} : { settling: { until: handoff.settleUntil, secondsLeft: settleLeft } })
            } : null,
            watchdog: dog ? { deadline: dog.deadline, expired: Date.parse(dog.deadline) <= now().getTime() } : null,
            recovery: recoveryView(),
            scheduled: state.read('scheduled'),
            lastApply: state.read('last-apply')
        };
    }

    return {
        EXIT_SELF_UPDATE,
        barrier,
        supervisor,
        runChild,
        codeRootOf,
        currentReleaseId,
        selfReplacing,
        osSupervised,
        handoffMode,
        handoffAvailability,
        prewarm,
        mark,
        audit,
        ensurePhase,
        verifyPhase,
        cutoverPhase,
        releasePhase,
        finishSuccess,
        failure,
        rollback,
        enterRecovery,
        finishRollback,
        finishRestore,
        putPreviousBack,
        adoptBarrier,
        retry,
        resume,
        scheduleExit,
        watchdogMs,
        settleMs,
        recoveryView,
        statusOf,
        writeHandoff,
        NEXT_STEP_NAMES
    };
}

module.exports = { createApplier, EXIT_SELF_UPDATE, WATCHDOG_MS, SETTLE_MS, SETTLE_ENV };
