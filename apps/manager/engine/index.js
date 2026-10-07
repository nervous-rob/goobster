/**
 * The setup engine: one contract for every front (the manager API now; the
 * wizard, the headless CLI and the portal's operator pages later, ADR 0013
 * decision 8).
 *
 *   plan(kind, input, auth)        -> a `planned` operation with a redacted plan
 *   validate(id, auth)             -> re-checks preconditions, `validated`
 *   apply(id, { revision }, auth)  -> takes the mutation lock, runs the steps,
 *                                     `applied` or `failed`, one audit record
 *   status(id), list()
 *
 * Operations are durable journal records (store/journal.js). Inputs are
 * checked against each kind's allow-list; an input value the plan must not
 * show (a label, later a key) stays in memory only, so a restart between
 * plan and apply means planning again. There is no kind that runs a shell
 * command or writes a caller-chosen path, and no kind may take a privileged
 * operation's name (privileged.js).
 */

const { ManagerError } = require('../errors');
const privileged = require('../privileged');

const DEFAULT_PLAN_TTL_MS = 15 * 60 * 1000;

/**
 * @typedef {Object} EngineAuth
 * @property {string|null} principal operator principal id, or `local:<kind>` for a local session, or null
 * @property {'bridge'|'setup'|'recovery'|'bootstrap'|'recovery-credential'} via
 */

/**
 * @typedef {Object} ManagerState
 * @property {'unclaimed'|'claimed'|'recovery'} state
 * @property {string|null} reason
 * @property {Object|null} installation
 */

/**
 * @typedef {Object} OperationKind
 * @property {string} kind
 * @property {boolean} public plannable through POST /manager/api/operations
 * @property {(state: ManagerState, via: string) => boolean} allowed
 * @property {(input: any, ctx: Object) => ({ plan: Object, revision: number|null, privateInput?: any }|Promise<Object>)} plan
 * @property {(record: Object, ctx: Object) => (void|Promise<void>)} [validate] runs at validate and again inside the lock
 * @property {Array<{ name: string, run: (record: Object, ctx: Object) => any }>} steps a step returns its journal detail
 * @property {(scratch: Object) => any} [result] the caller's in-memory result (sessions, ids); never journaled
 */

function publicError(error) {
    if (error instanceof ManagerError) return error;
    return new ManagerError(500, 'STEP_FAILED', 'The operation step failed; the manager log has the cause.');
}

/**
 * @param {Object} params
 * @param {ReturnType<import('../store/journal').createJournal>} params.journal
 * @param {ReturnType<import('../store/lock').createLock>} params.lock
 * @param {Record<string, OperationKind>} params.kinds
 * @param {() => ManagerState} params.currentState
 * @param {Object} [params.context] passed to kinds as ctx
 * @param {{ beforeStep?: Function }} [params.hooks] fault injection for tests
 * @param {(entry: Object) => void} [params.onAudit]
 * @param {() => Date} [params.now]
 * @param {Object} [params.logger]
 */
function createEngine({ journal, lock, kinds, currentState, context = {}, hooks = {}, onAudit = null, now = () => new Date(), planTtlMs = DEFAULT_PLAN_TTL_MS, logger = console }) {
    for (const name of Object.keys(kinds)) {
        if (privileged.isPrivileged(name)) throw new Error(`operation kind ${name} collides with a privileged operation`);
    }
    const privateInputs = new Map();

    function view(record) {
        const out = {
            id: record.id,
            kind: record.kind,
            status: record.status,
            actor: record.actor,
            via: record.via,
            plan: record.plan,
            revision: record.revision,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            steps: record.steps
        };
        if (record.error) out.error = record.error;
        if (record.problem) out.problem = record.problem;
        return out;
    }

    function load(id) {
        const { record, problem } = journal.read(id);
        if (!record) {
            if (problem === 'MISSING') throw new ManagerError(404, 'OPERATION_NOT_FOUND', 'There is no such operation.');
            throw new ManagerError(409, 'OPERATION_UNREADABLE', 'The operation record cannot be read; it was left as it is.', { problem });
        }
        return record;
    }

    function kindOf(record) {
        const spec = kinds[record.kind];
        if (!spec) throw new ManagerError(409, 'UNKNOWN_KIND', 'This manager does not know the operation kind of that record.');
        return spec;
    }

    function assertOwner(record, auth) {
        if (record.actor !== (auth.principal ?? null) || record.via !== auth.via) {
            throw new ManagerError(403, 'OPERATION_NOT_OWNED', 'The operation belongs to another operator or session.');
        }
    }

    function assertAllowed(spec, auth) {
        const state = currentState();
        if (!spec.allowed(state, auth.via)) {
            throw new ManagerError(409, 'STATE_NOT_ALLOWED', `"${spec.kind}" is not available in the ${state.state} state with this authentication.`, { state: state.state });
        }
        return state;
    }

    function assertFresh(record) {
        if (now().getTime() - Date.parse(record.createdAt) > planTtlMs) {
            journal.update(record.id, (r) => {
                r.status = 'cancelled';
                r.error = { code: 'PLAN_EXPIRED', message: 'The plan expired before it was applied.' };
                return r;
            });
            privateInputs.delete(record.id);
            throw new ManagerError(409, 'PLAN_EXPIRED', 'The plan expired; plan the change again.');
        }
    }

    const ctxFor = (record, auth) => ({ ...context, auth, input: record ? privateInputs.get(record.id) : undefined });

    async function plan(kind, input, auth, { internal = false } = {}) {
        const spec = Object.prototype.hasOwnProperty.call(kinds, kind) ? kinds[kind] : null;
        if (!spec || (!spec.public && !internal)) {
            throw new ManagerError(400, 'UNKNOWN_KIND', 'Unknown operation kind.');
        }
        assertAllowed(spec, auth);
        const planned = await spec.plan(input, ctxFor(null, auth));
        const record = journal.create({
            kind,
            actor: auth.principal ?? null,
            via: auth.via,
            plan: planned.plan,
            revision: planned.revision ?? null
        });
        if (planned.privateInput !== undefined) privateInputs.set(record.id, planned.privateInput);
        return view(record);
    }

    async function validate(id, auth) {
        const record = load(id);
        assertOwner(record, auth);
        if (record.status !== 'planned' && record.status !== 'validated') {
            throw new ManagerError(409, 'OPERATION_STATE', `The operation is ${record.status}.`);
        }
        assertFresh(record);
        const spec = kindOf(record);
        assertAllowed(spec, auth);
        try {
            if (spec.validate) await spec.validate(record, ctxFor(record, auth));
        } catch (error) {
            journal.step(id, 'validate', 'failed', { code: publicError(error).code });
            throw publicError(error);
        }
        return view(journal.update(id, (r) => {
            r.status = 'validated';
            r.steps.push({ name: 'validate', status: 'done', at: now().toISOString() });
            return r;
        }));
    }

    async function audit(record, outcome) {
        try {
            const entry = await journal.appendAudit({
                action: `manager.${record.kind}`,
                actor: record.actor,
                operationId: record.id,
                outcome,
                via: record.via
            });
            if (onAudit) onAudit(entry);
        } catch (error) {
            logger.error?.(`[manager] could not append the audit record for operation ${record.id}: ${error.code || error.name}`);
        }
    }

    async function apply(id, { revision } = {}, auth) {
        const record = load(id);
        assertOwner(record, auth);
        if (record.status !== 'validated') {
            throw new ManagerError(409, 'OPERATION_STATE', record.status === 'planned'
                ? 'Validate the plan before applying it.'
                : `The operation is ${record.status}.`);
        }
        if ((revision ?? null) !== (record.revision ?? null)) {
            throw new ManagerError(409, 'REVISION_CONFLICT', 'The revision does not match the plan; reload and plan again.',
                { expected: record.revision ?? null });
        }
        assertFresh(record);
        const spec = kindOf(record);
        const held = lock.acquire(id);
        const scratch = {};
        const ctx = { ...ctxFor(record, auth), scratch };
        let current = record;
        let failure = null;
        try {
            try {
                assertAllowed(spec, auth);
                if (spec.validate) await spec.validate(record, ctx);
            } catch (error) {
                failure = publicError(error);
                current = journal.update(id, (r) => {
                    r.status = 'failed';
                    r.error = { code: failure.code, message: failure.message };
                    r.steps.push({ name: 'precheck', status: 'failed', at: now().toISOString(), detail: { code: failure.code } });
                    return r;
                });
                throw failure;
            }
            current = journal.update(id, (r) => {
                r.status = 'applying';
                return r;
            });
            for (const step of spec.steps) {
                journal.step(id, step.name, 'started');
                let detail;
                try {
                    if (hooks.beforeStep) await hooks.beforeStep({ operationId: id, kind: record.kind, step: step.name });
                    detail = await step.run(record, ctx);
                } catch (error) {
                    if (!(error instanceof ManagerError)) {
                        logger.error?.(`[manager] operation ${id} step ${step.name} failed: ${error && error.message}`);
                    }
                    failure = publicError(error);
                    current = journal.update(id, (r) => {
                        r.status = 'failed';
                        r.error = { code: failure.code, message: failure.message };
                        r.steps.push({ name: step.name, status: 'failed', at: now().toISOString(), detail: { code: failure.code } });
                        return r;
                    });
                    throw failure;
                }
                journal.step(id, step.name, detail && detail.skipped ? 'skipped' : 'done', detail || undefined);
            }
            current = journal.update(id, (r) => {
                r.status = 'applied';
                return r;
            });
        } catch (error) {
            if (!failure) {
                failure = publicError(error);
                current = journal.update(id, (r) => {
                    r.status = 'failed';
                    r.error = { code: failure.code, message: failure.message };
                    return r;
                });
            }
        } finally {
            held.release();
            privateInputs.delete(id);
        }
        await audit(current, current.status);
        if (failure) {
            const error = new ManagerError(failure.status, failure.code, failure.message, { ...(failure.details || {}), operationId: id });
            error.operation = view(current);
            throw error;
        }
        return { operation: view(current), result: spec.result ? spec.result(scratch) : undefined };
    }

    /** plan + validate + apply in one call, for the credential routes. */
    async function run(kind, input, auth) {
        const planned = await plan(kind, input, auth, { internal: true });
        const validated = await validate(planned.id, auth);
        return apply(validated.id, { revision: validated.revision }, auth);
    }

    function status(id) {
        return view(load(id));
    }

    function list() {
        return journal.list().map(view);
    }

    /**
     * After a crash: an operation left `applying` whose lock holder is gone
     * is marked failed (`INTERRUPTED`) with an audit record. It is never
     * re-run or rolled back automatically.
     */
    async function recoverInterrupted() {
        const lockState = lock.inspect();
        const recovered = [];
        for (const record of journal.list()) {
            if (record.status !== 'applying') continue;
            if (lockState.held && !lockState.stale && lockState.operationId === record.id) continue;
            const updated = journal.update(record.id, (r) => {
                r.status = 'failed';
                r.error = { code: 'INTERRUPTED', message: 'The manager stopped while this operation was being applied.' };
                r.steps.push({ name: 'recovered', status: 'done', at: now().toISOString() });
                return r;
            });
            await audit(updated, 'interrupted');
            recovered.push(record.id);
        }
        return recovered;
    }

    return { plan, validate, apply, run, status, list, recoverInterrupted, kinds: Object.keys(kinds) };
}

module.exports = { createEngine, DEFAULT_PLAN_TTL_MS };
