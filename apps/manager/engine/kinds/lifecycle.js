/**
 * The apply flow's operation kinds (documentation/manager_lifecycle.md):
 *
 *   lifecycle.apply    public. Input { changeRef, graceSeconds?: 10..600 (60),
 *                      onExpired?: 'apply'|'cancel' ('apply') }. Validates the
 *                      referenced change, stages it, persists the pending
 *                      revision with its deadline in lifecycle.json and
 *                      announces it; the supervisor runs the countdown.
 *                      The plan's revision is lifecycle.json `current`.
 *   lifecycle.cancel   internal (POST /lifecycle/cancel): only before the
 *                      stop-new-work signal went out.
 *   lifecycle.restart  internal (POST /lifecycle/restart-now, /lifecycle/restart):
 *                      scope 'pending' skips the countdown, scope 'workers'
 *                      restarts the workers at the current revision (out of
 *                      CRASH_LOOP). The supervisor also journals its own
 *                      staged restarts under this kind, one record each.
 */

const nodeFs = require('node:fs');
const { ManagerError } = require('../../errors');
const files = require('../../store/files');
const { createJournal } = require('../../store/journal');
const { mapStateError } = require('./featuresSet');
const { probeAppDatabase } = require('../../appDatabase');
const registry = require('../../lifecycle/registry');
const stage = require('../../lifecycle/stage');
const notice = require('../../lifecycle/notice');
const { createLifecycleStore } = require('../../lifecycle/store');

const DEFAULT_GRACE_SECONDS = 60;
const MIN_GRACE_SECONDS = 10;
const MAX_GRACE_SECONDS = 600;
const APPLY_KEYS = new Set(['changeRef', 'graceSeconds', 'onExpired']);
const ON_EXPIRED = ['apply', 'cancel'];
const RESTARTABLE_KINDS = new Set(['features.set', 'config.set']);

function allowed(state, via) {
    if (state.state === 'claimed') return ['bridge', 'setup', 'recovery'].includes(via);
    if (state.state === 'recovery') return via === 'recovery';
    return false;
}

function parseApplyInput(input) {
    if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
    for (const key of Object.keys(input)) {
        if (!APPLY_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field lifecycle.apply does not accept.');
    }
    const { changeRef, graceSeconds = DEFAULT_GRACE_SECONDS, onExpired = 'apply' } = input;
    if (typeof changeRef !== 'string' || changeRef.length > 64) {
        throw new ManagerError(400, 'INVALID_INPUT', '"changeRef" must be the operation id of an applied change.');
    }
    if (!Number.isInteger(graceSeconds) || graceSeconds < MIN_GRACE_SECONDS || graceSeconds > MAX_GRACE_SECONDS) {
        throw new ManagerError(400, 'INVALID_INPUT', `"graceSeconds" must be an integer from ${MIN_GRACE_SECONDS} to ${MAX_GRACE_SECONDS}.`);
    }
    if (!ON_EXPIRED.includes(onExpired)) throw new ManagerError(400, 'INVALID_INPUT', '"onExpired" must be "apply" or "cancel".');
    return { changeRef, graceSeconds, onExpired };
}

function emptyInput(input, kind) {
    if (input === undefined || input === null) return;
    if (!files.isPlainObject(input) || Object.keys(input).length > 0) {
        throw new ManagerError(400, 'INVALID_INPUT', `${kind} takes no input.`);
    }
}

/** The referenced change says a restart is required (a #324 config change records it in its plan or a step). */
function saysRestartRequired(record) {
    if (record.plan && record.plan.restartRequired === true) return true;
    return record.steps.some(step => step.detail && step.detail.restartRequired === true);
}

function createLifecycleKinds({ settings, fs = nodeFs, now = () => new Date() }) {
    const lifecycle = () => createLifecycleStore({ storeDir: settings.storeDir, fs, now });

    function supervisor() {
        const running = registry.get(settings.storeDir);
        if (!running) {
            throw new ManagerError(409, 'NOT_SUPERVISING',
                'This manager does not supervise the workers (start it with --supervise), so nothing would perform the restart.');
        }
        return running;
    }

    function readLifecycle() {
        const { doc, problem } = lifecycle().read();
        if (problem) {
            throw new ManagerError(409, 'LIFECYCLE_STATE_UNREADABLE',
                'lifecycle.json in the manager store cannot be read; it was left as it is. Fix or remove it, then retry.', { problem });
        }
        return doc;
    }

    /** Everything validate checks: returns the change and the lifecycle document. */
    function inspect(parsed, ctx) {
        const running = supervisor();
        if (running.stateProblem) {
            throw new ManagerError(409, 'LIFECYCLE_STATE_UNREADABLE', 'lifecycle.json in the manager store cannot be read; fix or remove it, then retry.');
        }
        const doc = readLifecycle();
        if (doc.pending) {
            throw new ManagerError(409, 'RESTART_PENDING', 'A restart is already scheduled; cancel it or wait for it to finish.',
                { revision: doc.pending.revision });
        }
        const journal = createJournal({ store: ctx.store, fs, now });
        const { record } = journal.read(parsed.changeRef);
        if (!record || !RESTARTABLE_KINDS.has(record.kind)) {
            throw new ManagerError(404, 'CHANGE_NOT_FOUND', '"changeRef" is not an applied features.set or config.set operation.');
        }
        if (record.status !== 'applied') {
            throw new ManagerError(409, 'CHANGE_NOT_APPLIED', `The referenced change is ${record.status}, not applied.`);
        }
        const state = ctx.createFeatureState();
        const status = state.status();
        if (status.error) throw mapStateError(status.error);
        const selection = stage.pendingSelection(status);
        if (record.kind === 'features.set') {
            if (selection.length === 0) {
                throw new ManagerError(409, 'NOTHING_PENDING', 'features.json has no pending change; there is nothing to restart for.');
            }
        } else if (!saysRestartRequired(record)) {
            throw new ManagerError(409, 'NO_RESTART_REQUIRED', 'The referenced change does not need a restart.');
        }
        const notInstalled = selection.find(entry => entry.to === true && entry.installed !== true);
        if (notInstalled) {
            throw new ManagerError(409, 'FEATURE_NOT_INSTALLED', `"${notInstalled.id}" is not installed and cannot be activated.`, { feature: notInstalled.id });
        }
        return { running, doc, change: record, selection: selection.map(entry => ({ id: entry.id, to: entry.to })) };
    }

    const applyKind = {
        kind: 'lifecycle.apply',
        public: true,
        allowed,
        plan(input, ctx) {
            const parsed = parseApplyInput(input);
            const { running, doc, change, selection } = inspect(parsed, ctx);
            return {
                plan: {
                    target: 'workers',
                    effect: 'staged-restart',
                    changeRef: parsed.changeRef,
                    changeKind: change.kind,
                    graceSeconds: parsed.graceSeconds,
                    onExpired: parsed.onExpired,
                    fromRevision: doc.current,
                    toRevision: doc.current + 1,
                    selection,
                    workers: running.summary().workers.map(worker => worker.name)
                },
                revision: doc.current
            };
        },
        validate(record, ctx) {
            const { doc } = inspect({ changeRef: record.plan.changeRef }, ctx);
            if (doc.current !== record.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The running revision changed since this plan was made; plan again.',
                    { expected: record.revision, actual: doc.current });
            }
        },
        steps: [
            {
                name: 'check-change',
                run(record, ctx) {
                    const { selection } = inspect({ changeRef: record.plan.changeRef }, ctx);
                    ctx.scratch.selection = selection;
                    return { selection: selection.length };
                }
            },
            {
                name: 'stage',
                async run(record, ctx) {
                    const payload = await stage.stagePayload(ctx.scratch.selection);
                    let features = [];
                    if (record.plan.changeKind === 'features.set') {
                        const staged = await stage.stageFeatures({
                            featureState: ctx.createFeatureState(),
                            revision: record.plan.toRevision,
                            storeDir: settings.storeDir,
                            fs,
                            now
                        });
                        features = staged.changed;
                    }
                    return { staged: payload.staged, features };
                }
            },
            {
                name: 'announce',
                async run(record, ctx) {
                    const announcedAt = now();
                    const deadline = new Date(announcedAt.getTime() + record.plan.graceSeconds * 1000);
                    const pending = {
                        revision: record.plan.toRevision,
                        operationId: record.id,
                        changeRef: record.plan.changeRef,
                        changeKind: record.plan.changeKind,
                        selection: ctx.scratch.selection,
                        actor: record.actor,
                        via: record.via,
                        announcedAt: announcedAt.toISOString(),
                        deadline: deadline.toISOString(),
                        graceSeconds: record.plan.graceSeconds,
                        onExpired: record.plan.onExpired,
                        phase: 'countdown'
                    };
                    lifecycle().update((doc) => {
                        if (doc.pending) {
                            throw new ManagerError(409, 'RESTART_PENDING', 'A restart is already scheduled; cancel it or wait for it to finish.');
                        }
                        if (doc.current !== record.revision) {
                            throw new ManagerError(409, 'REVISION_CONFLICT', 'The running revision changed since this plan was made; plan again.');
                        }
                        doc.pending = pending;
                        lifecycle().event(doc, 'announced', { revision: pending.revision });
                        return doc;
                    });
                    const delivered = await notice.announce({
                        settings,
                        probe: () => probeAppDatabase(settings, { fs }),
                        actor: record.actor,
                        pending
                    });
                    ctx.scratch.pending = pending;
                    ctx.scratch.notice = delivered;
                    return { deadline: pending.deadline, notice: delivered.delivered ? 'inbox' : delivered.reason };
                }
            }
        ],
        result: (scratch) => ({
            revision: scratch.pending ? scratch.pending.revision : null,
            deadline: scratch.pending ? scratch.pending.deadline : null,
            graceSeconds: scratch.pending ? scratch.pending.graceSeconds : null,
            notice: scratch.notice ? (scratch.notice.delivered ? 'inbox' : scratch.notice.reason) : null
        })
    };

    function assertCancellable() {
        const doc = readLifecycle();
        if (!doc.pending) throw new ManagerError(409, 'NOTHING_PENDING', 'There is no scheduled restart.');
        const running = registry.get(settings.storeDir);
        if (doc.pending.phase !== 'countdown' || (running && running.committing)) {
            throw new ManagerError(409, 'ALREADY_COMMITTED', 'The workers were already told to stop new work; the restart can no longer be cancelled.');
        }
        return doc;
    }

    const cancelKind = {
        kind: 'lifecycle.cancel',
        public: false,
        allowed,
        plan(input) {
            emptyInput(input, 'lifecycle.cancel');
            const doc = assertCancellable();
            return { plan: { target: 'workers', effect: 'cancel-restart', revision: doc.pending.revision }, revision: null };
        },
        validate() {
            assertCancellable();
        },
        steps: [
            {
                name: 'cancel',
                run() {
                    let cancelled = null;
                    lifecycle().update((doc) => {
                        if (!doc.pending) throw new ManagerError(409, 'NOTHING_PENDING', 'There is no scheduled restart.');
                        if (doc.pending.phase !== 'countdown') {
                            throw new ManagerError(409, 'ALREADY_COMMITTED', 'The workers were already told to stop new work; the restart can no longer be cancelled.');
                        }
                        cancelled = doc.pending.revision;
                        doc.lastOutcome = { revision: cancelled, outcome: 'cancelled', code: 'CANCELLED', at: now().toISOString() };
                        doc.pending = null;
                        lifecycle().event(doc, 'cancelled', { revision: cancelled });
                        return doc;
                    });
                    return { revision: cancelled };
                }
            }
        ]
    };

    const restartKind = {
        kind: 'lifecycle.restart',
        public: false,
        allowed,
        plan(input) {
            if (!files.isPlainObject(input) || Object.keys(input).some(key => key !== 'scope') || !['pending', 'workers'].includes(input.scope)) {
                throw new ManagerError(400, 'INVALID_INPUT', '"scope" must be "pending" or "workers".');
            }
            supervisor();
            if (input.scope === 'pending') assertCancellable();
            return { plan: { target: 'workers', effect: input.scope === 'pending' ? 'restart-now' : 'restart-workers', scope: input.scope }, revision: null };
        },
        validate(record) {
            const running = supervisor();
            if (record.plan.scope === 'pending') assertCancellable();
            else if (running.committing) throw new ManagerError(409, 'ALREADY_COMMITTED', 'A staged restart is under way; wait for it to finish.');
        },
        steps: [
            {
                name: 'restart',
                run(record, ctx) {
                    const running = supervisor();
                    if (record.plan.scope === 'pending') {
                        const pending = running.restartNow();
                        ctx.scratch.out = { revision: pending ? pending.revision : null, deadline: pending ? pending.deadline : null };
                    } else {
                        ctx.scratch.out = running.operatorRestart();
                    }
                    return ctx.scratch.out;
                }
            }
        ],
        result: (scratch) => scratch.out || null
    };

    return [applyKind, cancelKind, restartKind];
}

module.exports = { createLifecycleKinds, parseApplyInput, DEFAULT_GRACE_SECONDS, MIN_GRACE_SECONDS, MAX_GRACE_SECONDS };
