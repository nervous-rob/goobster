/**
 * The maintenance barrier's operation kinds (documentation/maintenance_barrier.md):
 *
 *   maintenance.enter    public. Input { reason, timeoutSeconds?: 10..600 (120),
 *                        expectedRevision? }. Preflight (refuse what cannot be
 *                        fenced), fence (persist the incremented fence and
 *                        `active: true`), quiesce (every writer acknowledges
 *                        this fence), verify. Returns { operationId, fence }.
 *   maintenance.release  public. Input { operationId, fence, force?,
 *                        acknowledgeMutation? }. Persists `active: false`,
 *                        then tells the writers to resume. Not un-pausing.
 *
 * Both run through plan / validate / apply and write the audit actions
 * `manager.maintenance.enter` / `manager.maintenance.release`; a forced
 * release is audited `forced: true`.
 */

const nodeFs = require('node:fs');
const { ManagerError } = require('../../errors');
const files = require('../../store/files');
const { createBarrier, DEFAULT_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } = require('../../maintenance/barrier');

const ENTER_KEYS = new Set(['reason', 'timeoutSeconds', 'expectedRevision']);
const RELEASE_KEYS = new Set(['operationId', 'fence', 'force', 'acknowledgeMutation']);
const REASON_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,63}$/;
const FORCE_VIA = ['bridge', 'recovery'];

function allowed(state, via) {
    if (state.state === 'claimed') return ['bridge', 'setup', 'recovery'].includes(via);
    if (state.state === 'recovery') return via === 'recovery';
    return false;
}

function parseEnterInput(input) {
    if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
    for (const key of Object.keys(input)) {
        if (!ENTER_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field maintenance.enter does not accept.');
    }
    const { reason, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, expectedRevision } = input;
    if (typeof reason !== 'string' || !REASON_RE.test(reason)) {
        throw new ManagerError(400, 'INVALID_INPUT', '"reason" must be a short label of letters, digits and . _ : / - (64 characters at most).');
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < MIN_TIMEOUT_SECONDS || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
        throw new ManagerError(400, 'INVALID_INPUT', `"timeoutSeconds" must be an integer from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}.`);
    }
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
        throw new ManagerError(400, 'INVALID_INPUT', '"expectedRevision" must be a non-negative integer.');
    }
    return { reason, timeoutSeconds, expectedRevision };
}

function parseReleaseInput(input) {
    if (!files.isPlainObject(input)) throw new ManagerError(400, 'INVALID_INPUT', 'The input must be an object.');
    for (const key of Object.keys(input)) {
        if (!RELEASE_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The input has a field maintenance.release does not accept.');
    }
    const { operationId, fence, force = false, acknowledgeMutation = false } = input;
    if (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 64) {
        throw new ManagerError(400, 'INVALID_INPUT', '"operationId" must be the id of the maintenance.enter operation.');
    }
    if (!Number.isInteger(fence) || fence < 1) throw new ManagerError(400, 'INVALID_INPUT', '"fence" must be the fence maintenance.enter returned.');
    if (typeof force !== 'boolean' || typeof acknowledgeMutation !== 'boolean') {
        throw new ManagerError(400, 'INVALID_INPUT', '"force" and "acknowledgeMutation" must be booleans.');
    }
    return { operationId, fence, force, acknowledgeMutation };
}

function createMaintenanceKinds({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const barrier = () => createBarrier({ settings, fs, now, logger });

    const enterKind = {
        kind: 'maintenance.enter',
        public: true,
        allowed,
        plan(input, ctx) {
            const parsed = parseEnterInput(input);
            const b = barrier();
            const doc = b.assertEnterable();
            if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== doc.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The maintenance state changed since it was read; read it again.',
                    { expected: parsed.expectedRevision, actual: doc.revision });
            }
            return {
                plan: {
                    target: 'installation',
                    effect: 'maintenance-enter',
                    reason: parsed.reason,
                    timeoutSeconds: parsed.timeoutSeconds,
                    fromFence: doc.fence,
                    toFence: doc.fence + 1,
                    boundary: 'cancel-safe',
                    writers: b.plannedWriters(ctx)
                },
                revision: doc.revision
            };
        },
        validate(record) {
            const doc = barrier().assertEnterable();
            if (doc.revision !== record.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The maintenance state changed since this plan was made; plan again.',
                    { expected: record.revision, actual: doc.revision });
            }
        },
        steps: [
            {
                name: 'preflight',
                async run(record, ctx) {
                    ctx.scratch.resolved = await barrier().preflight({ actor: record.actor, ctx });
                    return { layout: ctx.scratch.resolved.layout, writers: ctx.scratch.resolved.targets.map(target => target.name) };
                }
            },
            {
                name: 'fence',
                run(record, ctx) {
                    const { fence } = barrier().begin({ operationId: record.id, actor: record.actor, via: record.via, reason: record.plan.reason });
                    ctx.scratch.fence = fence;
                    return { fence };
                }
            },
            {
                name: 'quiesce',
                async run(record, ctx) {
                    const out = await barrier().quiesce({
                        operationId: record.id,
                        fence: ctx.scratch.fence,
                        resolved: ctx.scratch.resolved,
                        timeoutSeconds: record.plan.timeoutSeconds,
                        actor: record.actor
                    });
                    ctx.scratch.writers = out.writers;
                    ctx.scratch.sent = out.sent;
                    return { acknowledged: Object.keys(out.writers) };
                }
            },
            {
                name: 'verify',
                async run(record, ctx) {
                    const state = await barrier().verify({
                        operationId: record.id,
                        fence: ctx.scratch.fence,
                        resolved: ctx.scratch.resolved,
                        writers: ctx.scratch.writers,
                        sent: ctx.scratch.sent,
                        actor: record.actor
                    });
                    ctx.scratch.state = state;
                    return { phase: state.phase };
                }
            }
        ],
        result: scratch => ({
            operationId: scratch.state ? scratch.state.operationId : null,
            fence: scratch.fence ?? null,
            phase: scratch.state ? scratch.state.phase : null,
            boundary: scratch.state ? scratch.state.boundary : null,
            writers: scratch.writers ? Object.keys(scratch.writers) : []
        })
    };

    function assertForceAllowed(record) {
        if (record.plan.force === true && !FORCE_VIA.includes(record.via)) {
            throw new ManagerError(403, 'FORCE_REQUIRES_OPERATOR',
                'A forced release needs an authenticated operator (the bridge or the recovery credential), not a setup session.');
        }
    }

    const releaseKind = {
        kind: 'maintenance.release',
        public: true,
        allowed,
        plan(input) {
            const parsed = parseReleaseInput(input);
            const b = barrier();
            b.checkRelease(parsed);
            const doc = b.store.read().doc;
            return {
                plan: {
                    target: 'installation',
                    effect: 'maintenance-release',
                    fence: parsed.fence,
                    phase: doc.phase,
                    boundary: doc.mutateBegun ? 'irreversible' : 'cancel-safe',
                    force: parsed.force,
                    acknowledgeMutation: parsed.acknowledgeMutation,
                    maintenanceRef: parsed.operationId
                },
                revision: doc.revision
            };
        },
        validate(record) {
            assertForceAllowed(record);
            const b = barrier();
            b.checkRelease({
                operationId: record.plan.maintenanceRef,
                fence: record.plan.fence,
                force: record.plan.force === true,
                acknowledgeMutation: record.plan.acknowledgeMutation === true
            });
            const doc = b.store.read().doc;
            if (doc.revision !== record.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The maintenance state changed since this plan was made; plan again.',
                    { expected: record.revision, actual: doc.revision });
            }
        },
        steps: [
            {
                name: 'release',
                async run(record, ctx) {
                    ctx.scratch.out = await barrier().release({
                        operationId: record.plan.maintenanceRef,
                        fence: record.plan.fence,
                        force: record.plan.force === true,
                        acknowledgeMutation: record.plan.acknowledgeMutation === true,
                        actor: record.actor
                    });
                    return { outcome: ctx.scratch.out.outcome, fence: ctx.scratch.out.fence, forced: ctx.scratch.out.forced };
                }
            }
        ],
        result: scratch => scratch.out || null
    };

    return [enterKind, releaseKind];
}

module.exports = { createMaintenanceKinds, parseEnterInput, parseReleaseInput };
