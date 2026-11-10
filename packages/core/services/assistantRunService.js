/**
 * One delegated run (DA-3, ADR 0018): executes a claimed initiative with the
 * shared agent loop, under the responsibility's grant.
 *
 * What makes a run safe to leave unattended:
 *  - The model is offered a fixed, explicit set of tools (TOOLS, one module
 *    per capability under ./assistant/runTools). Each one names the
 *    operation and resource it needs, and `authorize()` is asked before
 *    every call. A tool that is not in the table does not run.
 *  - Every call is journaled in `assistant_run_operations` before it is
 *    dispatched and after it returns. A resumed run replays finished calls
 *    from the journal instead of repeating them; a write left in flight by a
 *    crash is UNCERTAIN and stops the run for review.
 *  - The lease on the initiative is renewed as the run works. When renewal
 *    fails (cancelled, paused, revoked, reaped) the run stops and writes no
 *    result.
 *  - Model tokens are reserved against the payer's account cap by aiService
 *    (background admission), and the responsibility's own daily token and
 *    search budgets are hard caps on top. An unset budget is a conservative
 *    default, never unlimited. An exhausted budget parks the run until the
 *    window resets; it does not poll.
 *
 *  - A run that has read the person's private knowledge does not write
 *    into a project other people can read (`PRIVATE_CONTEXT`).
 *  - A run dispatched for an `agent` step of a project plan (ADR 0019)
 *    claims the step only inside the plan revision a person approved and
 *    started, and the step is marked done only after its reported result
 *    is verified against the journal and the workspace. See
 *    ./assistant/planStepRun.js.
 *
 * It never takes the foreground chat claim (`web_live_turns`).
 * Spec: documentation/delegated_runs.md.
 */

const crypto = require('node:crypto');
const db = require('../db');
const logger = require('../utils/logger');
const workContext = require('../utils/workContext');
const workFailureService = require('./workFailureService');
const assistantConfig = require('../config/assistantConfig');
const control = require('./assistantControlService');
const requireOptional = require('../utils/optionalModule').forModule(module);
const { clip, RESULT_CHARS, SUMMARY_CHARS } = require('./assistant/runTools/shared');

/**
 * Used when the responsibility sets no budget of its own (per UTC day), and
 * the most its own budget can allow. These are the configured values; what
 * the host set in the Host room wins (assistantControlService.budgetDefaults).
 */
const DEFAULT_BUDGETS = Object.freeze({
    modelTokens: assistantConfig.defaultModelTokens,
    searches: assistantConfig.defaultSearches,
    computeSeconds: assistantConfig.defaultComputeSeconds
});
const MAX_ROUNDS = 8;
const RUN_DEADLINE_MS = 10 * 60 * 1000;
const REPLY_TOKENS = 1200;
/** Pushes and pull requests per responsibility per UTC day when the grant sets no `externalOperations`. */
const DEFAULT_EXTERNAL_OPERATIONS = 2;
/** The most a grant's own `externalOperations` can allow in a day. */
const MAX_EXTERNAL_OPERATIONS = 20;
/** How soon a run waiting on its expedition looks again (events usually wake it sooner). */
const CHILD_RECHECK_MS = 5 * 60 * 1000;

/** authorize() codes after which the run cannot continue at all. */
const STOP_CODES = new Set([
    'RESPONSIBILITY_NOT_FOUND', 'RESPONSIBILITY_REVOKED', 'RESPONSIBILITY_EXPIRED', 'RESPONSIBILITY_INACTIVE',
    'REVISION_CONFLICT', 'ACTOR_MISMATCH', 'ATTENTION_NOT_ENROLLED', 'FEATURE_UNAVAILABLE', 'ASSISTANT_PAUSED'
]);

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function dayStart(now = new Date()) {
    return `${now.toISOString().slice(0, 10)} 00:00:00`;
}

function nextDay(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
}

/** Stable hash of a tool's arguments (key order does not matter). */
function argsHash(args) {
    const sorted = (value) => {
        if (Array.isArray(value)) return value.map(sorted);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
        }
        return value;
    };
    return crypto.createHash('sha256').update(JSON.stringify(sorted(args || {}))).digest('hex').slice(0, 32);
}

/**
 * The tools a run may be offered: one module per capability under
 * ./assistant/runTools (the spec contract is described in its index).
 */
const TOOLS = require('./assistant/runTools');

class AssistantRunService {
    constructor() {
        this.TOOLS = TOOLS;
        this.DEFAULT_BUDGETS = DEFAULT_BUDGETS;
    }

    present(row, { operations = null } = {}) {
        if (!row) return null;
        return {
            id: Number(row.id),
            initiativeId: Number(row.initiativeId),
            responsibilityId: Number(row.responsibilityId),
            attempt: Number(row.attempt),
            status: row.status,
            stopCode: row.stopCode || null,
            outcome: row.outcome || null,
            rounds: Number(row.rounds || 0),
            tokensUsed: Number(row.tokensUsed || 0),
            searches: Number(row.searches || 0),
            computeSeconds: Number(row.computeSeconds || 0),
            resultTitle: row.resultTitle || null,
            resultSummary: row.resultSummary || null,
            updateId: row.updateId == null ? null : Number(row.updateId),
            startedAt: row.startedAt,
            endedAt: row.endedAt || null,
            ...(operations ? {
                // What it did, without the retrieved text.
                operations: operations.map(op => ({
                    tool: op.tool, operation: op.operation || null, resourceKind: op.resourceKind || null,
                    status: op.status, refusalCode: op.refusalCode || null, at: op.createdAt
                }))
            } : {})
        };
    }

    /** The run of one of the person's initiatives, with what it did. */
    async forInitiative({ userId, initiativeId }) {
        const row = await db.get(
            'SELECT * FROM assistant_runs WHERE initiativeId = @id AND ownerUserId = @userId',
            { id: Number(initiativeId), userId: String(userId) }
        );
        if (!row) return null;
        const operations = await db.all(
            'SELECT tool, operation, resourceKind, status, refusalCode, createdAt FROM assistant_run_operations WHERE runId = @id ORDER BY id',
            { id: row.id }
        );
        return this.present(row, { operations });
    }

    /** Short run summaries for a list of the person's initiatives, keyed by initiative id. */
    async summaries({ userId, initiativeIds }) {
        const ids = [...new Set((initiativeIds || []).map(Number).filter(Number.isSafeInteger))];
        const map = new Map();
        if (!ids.length) return map;
        const params = { userId: String(userId) };
        const marks = ids.map((id, index) => { params[`i${index}`] = id; return `@i${index}`; });
        const rows = await db.all(
            `SELECT * FROM assistant_runs WHERE ownerUserId = @userId AND initiativeId IN (${marks.join(', ')})`, params
        );
        for (const row of rows) map.set(Number(row.initiativeId), this.present(row));
        return map;
    }

    /**
     * The grant's daily caps: the host's default when it sets none, and
     * never more than that default when it does (a responsibility's own
     * budget can be lower than the host's number, not higher).
     * @param {{ budgetsJson?: string }} responsibility
     * @param {{ modelTokens: number, searches: number, computeSeconds: number }} [hostDefaults]
     */
    budgets(responsibility, hostDefaults = DEFAULT_BUDGETS) {
        let stored = {};
        try { stored = JSON.parse(responsibility.budgetsJson || '{}') || {}; } catch { stored = {}; }
        const pick = (key) => (Number.isSafeInteger(stored[key]) ? Math.min(stored[key], hostDefaults[key]) : hostDefaults[key]);
        return { modelTokens: pick('modelTokens'), searches: pick('searches'), computeSeconds: pick('computeSeconds') };
    }

    /**
     * The grant's daily cap on operations that leave this installation
     * (a push, a pull request): its own number up to the ceiling, or a
     * small default when unset. Never unlimited.
     */
    externalBudget(responsibility) {
        let stored;
        try { stored = JSON.parse(responsibility.budgetsJson || '{}') || {}; } catch { stored = {}; }
        return Number.isSafeInteger(stored.externalOperations)
            ? Math.min(stored.externalOperations, MAX_EXTERNAL_OPERATIONS)
            : DEFAULT_EXTERNAL_OPERATIONS;
    }

    /**
     * Outside operations the responsibility's runs made today (UTC), or may
     * have made, before journal row `beforeId`: read from the journal, so a
     * crash loses none. A call that was refused, or that answered "Not ...",
     * reached nothing and is not counted.
     */
    async _externalUsed(responsibilityId, beforeId, now = new Date()) {
        const tools = Object.keys(TOOLS).filter(name => TOOLS[name].budget === 'externalOperations');
        if (!tools.length) return 0;
        const params = { rid: responsibilityId, before: beforeId, day: dayStart(now) };
        const marks = tools.map((name, index) => { params[`t${index}`] = name; return `@t${index}`; });
        const row = await db.get(
            `SELECT COUNT(*) AS n FROM assistant_run_operations o
             JOIN assistant_runs r ON r.id = o.runId
             WHERE r.responsibilityId = @rid AND o.id < @before AND o.createdAt >= @day
               AND o.tool IN (${marks.join(', ')})
               AND (o.status IN ('PREPARED', 'DISPATCHED', 'UNCERTAIN', 'FAILED')
                    OR (o.status = 'SUCCEEDED' AND COALESCE(o.resultText, '') NOT LIKE 'Not %'))`,
            params
        );
        return Number(row?.n || 0);
    }

    /** The operations the responsibility grants, for a tool deciding whether it is on offer. */
    _grants(responsibility) {
        try {
            const parsed = JSON.parse(responsibility.operationsJson || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    /** Which capabilities still in the pilot the responsibility's owner has (assistantAccessService). */
    async _capabilities(responsibility) {
        try {
            return (await require('./assistantAccessService').describe(responsibility.ownerUserId)).capabilities || {};
        } catch {
            return {};
        }
    }

    /** Tokens this run has reserved or spent so far (the work ledger's own rows). */
    async tokensFor(runId) {
        const row = await db.get(
            `SELECT COALESCE(SUM(COALESCE(actualTokens, estimatedTokens)), 0) AS n FROM usage_reservations
             WHERE workKind = 'assistant_run' AND workId = @id AND status <> 'released'`,
            { id: String(runId) }
        );
        // A child expedition is this run's cost too: counted once, here.
        const children = await this._children(runId);
        let childTokens = 0;
        for (const child of children) {
            const used = await db.get(
                `SELECT COALESCE(SUM(COALESCE(actualTokens, estimatedTokens)), 0) AS n FROM usage_reservations
                 WHERE workKind = 'expedition' AND workId = @id AND status <> 'released'`,
                { id: String(child.id) }
            );
            childTokens += Number(used?.n || 0);
        }
        return Number(row?.n || 0) + childTokens;
    }

    /** What the responsibility's other runs used today (UTC). */
    async _usedToday(responsibilityId, exceptRunId, now) {
        const row = await db.get(
            `SELECT COALESCE(SUM(tokensUsed), 0) AS tokens, COALESCE(SUM(searches), 0) AS searches,
                    COALESCE(SUM(computeSeconds), 0) AS compute FROM assistant_runs
             WHERE responsibilityId = @rid AND id <> @run AND startedAt >= @day`,
            { rid: responsibilityId, run: exceptRunId, day: dayStart(now) }
        );
        return { tokens: Number(row?.tokens || 0), searches: Number(row?.searches || 0), compute: Number(row?.compute || 0) };
    }

    /** Open, or resume, the run row of a claimed initiative. */
    async _open(initiative, responsibility) {
        const existing = await db.get('SELECT * FROM assistant_runs WHERE initiativeId = @id', { id: initiative.id });
        const now = utcText();
        if (existing) {
            await db.run(
                `UPDATE assistant_runs SET attempt = attempt + 1, status = 'RUNNING', stopCode = NULL,
                    responsibilityRevision = @revision, heartbeatAt = @now, endedAt = NULL, updatedAt = @now
                 WHERE id = @id`,
                { id: existing.id, revision: initiative.responsibilityRevision, now }
            );
            return db.get('SELECT * FROM assistant_runs WHERE id = @id', { id: existing.id });
        }
        const id = await db.insert(
            `INSERT INTO assistant_runs
                (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId, heartbeatAt)
             VALUES (@initiativeId, @responsibilityId, @revision, @owner, @acting, @payer, @now)`,
            {
                initiativeId: initiative.id,
                responsibilityId: responsibility.id,
                revision: initiative.responsibilityRevision,
                owner: responsibility.ownerUserId,
                acting: responsibility.actingUserId || null,
                payer: responsibility.payerUserId || responsibility.ownerUserId,
                now
            }
        );
        return db.get('SELECT * FROM assistant_runs WHERE id = @id', { id });
    }

    async _project(responsibility) {
        if (!responsibility.projectId) return null;
        const row = await db.get('SELECT id, slug, name, userId FROM observatory_projects WHERE id = @id', { id: responsibility.projectId });
        return row ? { id: Number(row.id), slug: row.slug, name: row.name, ownerId: row.userId } : null;
    }

    _messages({ responsibility, initiative, project, tools }) {
        const system = [
            'You are doing one bounded piece of delegated work for a person, unattended. They are not watching and cannot answer questions now.',
            `The responsibility they delegated: "${responsibility.title}".${responsibility.outcome ? ` What good looks like: ${responsibility.outcome}` : ''}`,
            project ? `It is linked to their project "${project.name}".` : '',
            `You may only use these tools: ${tools.join(', ')}. Anything else - sending, scheduling, deleting, changing what the person wrote - is not yours to do. If the work needs an action you cannot take, say so in your report instead of attempting it.`,
            'Changing something is the exception, not the goal: write or edit only when the responsibility clearly calls for it, and say exactly what you changed in your report.',
            'A refused tool call means that is outside what was delegated. Do not retry it or look for another way around it.',
            'Work in few steps. When you have what the person needs, or have confirmed nothing needs their attention, call finish once. Report only what you actually found, with where it came from. Never invent a source.'
        ].filter(Boolean).join('\n');
        const user = [
            `What changed and why this was picked up: ${initiative.title}`,
            initiative.reason ? `Detail: ${initiative.reason}` : '',
            'Look into it within the responsibility above and report.'
        ].filter(Boolean).join('\n');
        return [{ role: 'system', content: system }, { role: 'user', content: user }];
    }

    /** The journaled, authorized tool executor for one run. */
    _executor(ctx) {
        const seen = new Map();
        const responsibilities = require('./assistantResponsibilityService');
        const journal = async (fields) => db.insert(
            `INSERT INTO assistant_run_operations
                (runId, ownerUserId, tool, argsHash, seq, operation, resourceKind, resourceId, effect, status, refusalCode)
             VALUES (@runId, @owner, @tool, @hash, @seq, @operation, @resourceKind, @resourceId, @effect, @status, @refusalCode)`,
            {
                runId: ctx.run.id, owner: ctx.run.ownerUserId, operation: null, resourceKind: null, resourceId: null,
                effect: 'read', refusalCode: null, ...fields
            }
        );
        const mark = (id, status, resultText = null) => db.run(
            'UPDATE assistant_run_operations SET status = @status, resultText = @resultText, updatedAt = @now WHERE id = @id',
            { id, status, resultText, now: utcText() }
        );

        return async (name, rawArgs) => {
            if (ctx.stop) return 'This task has been stopped.';
            if (!(await ctx.heartbeat())) return 'This task has been stopped.';
            const { interactionContext: _ignored, ...args } = rawArgs || {};
            const spec = Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : null;
            const hash = argsHash(args);
            const key = `${name}:${hash}`;
            const seq = (seen.get(key) || 0) + 1;
            seen.set(key, seq);
            if (!spec || !ctx.offered.has(name)) {
                await journal({ tool: clip(name, 80), hash, seq, status: 'REFUSED', refusalCode: 'UNKNOWN_TOOL' }).catch(() => {});
                return 'That tool is not available for this task.';
            }

            // A resumed run: what already happened is not done again.
            const prior = await db.get(
                'SELECT * FROM assistant_run_operations WHERE runId = @runId AND tool = @tool AND argsHash = @hash AND seq = @seq',
                { runId: ctx.run.id, tool: name, hash, seq }
            );
            if (prior?.status === 'SUCCEEDED') {
                if (spec.final) await spec.run(args, ctx);
                if (spec.source === 'private') ctx.privateRead = true;
                if (typeof spec.replay === 'function') return spec.replay(prior, ctx);
                return prior.resultText || '';
            }
            if (prior?.status === 'REFUSED') return `Not allowed (${prior.refusalCode || 'REFUSED'}).`;
            let reconciledAbsent = false;
            if (prior && spec.effect === 'write' && !spec.atomic && typeof spec.reconcile === 'function') {
                // In flight when the worker died. Ask the world, by the
                // operation's own identity, whether it happened.
                ctx.opId = prior.id;
                let verdict = { state: 'unknown' };
                try { verdict = await spec.reconcile(args, ctx); } catch { /* unknown */ }
                if (verdict.state === 'done') {
                    await mark(prior.id, 'SUCCEEDED', verdict.result);
                    return verdict.result;
                }
                reconciledAbsent = verdict.state === 'absent';
            }
            if (prior && spec.effect === 'write' && !spec.atomic && !reconciledAbsent) {
                // It may or may not have happened. Never retried blindly.
                await mark(prior.id, 'UNCERTAIN');
                ctx.halt('OPERATION_UNCERTAIN');
                return 'This task has been stopped for review.';
            }

            const need = await spec.needs(args, ctx);
            const base = {
                tool: name, hash, seq, effect: spec.effect,
                operation: need?.operation || null,
                resourceKind: need?.resource?.kind || null,
                resourceId: need?.resource?.id != null ? String(need.resource.id) : null
            };
            const refuse = async (code) => {
                if (prior) await db.run('UPDATE assistant_run_operations SET status = \'REFUSED\', refusalCode = @code, updatedAt = @now WHERE id = @id', { id: prior.id, code, now: utcText() });
                else await journal({ ...base, status: 'REFUSED', refusalCode: code });
                return `Not allowed (${code}).`;
            };
            if (need?.refuse) return refuse(need.refuse);
            for (const required of need ? [need, ...(need.also || [])] : []) {
                const verdict = await responsibilities.authorize({
                    responsibilityId: ctx.run.responsibilityId,
                    revision: ctx.run.responsibilityRevision,
                    operation: required.operation,
                    resource: required.resource,
                    actorUserId: ctx.actor
                });
                if (!verdict.ok) {
                    if (STOP_CODES.has(verdict.code)) ctx.halt(verdict.code);
                    // A plan step is project work: without the project there is nothing left to do.
                    if (ctx.planStep && verdict.code === 'RESOURCE_UNAVAILABLE' && required.resource?.kind === 'project') ctx.halt(verdict.code);
                    return refuse(verdict.code);
                }
            }
            if (spec.publishes === 'project' && ctx.privateRead) {
                // What it read from the person's private knowledge may be in
                // what it writes: only a project nobody else reads may take it.
                const allowed = await require('./knowledgeTransferService').privateContextAllowed({ userId: ctx.actor, project: ctx.project });
                if (!allowed) return refuse('PRIVATE_CONTEXT');
            }
            // Outside this installation nobody's audience is known: never after a private read.
            if (spec.publishes === 'external' && ctx.privateRead) return refuse('PRIVATE_CONTEXT');
            if (spec.budget === 'searches') {
                if (ctx.used.searches + ctx.searches >= ctx.budgets.searches) return refuse('SEARCH_BUDGET');
                ctx.searches += 1;
            }
            if (spec.budget === 'computeSeconds' && ctx.used.compute + ctx.compute >= ctx.budgets.computeSeconds) {
                return refuse('COMPUTE_BUDGET');
            }
            if (typeof spec.guard === 'function') {
                // Allowed by the grant; now what only the world can say (a protected branch).
                let blocked = 'GUARD_FAILED';
                try { blocked = await spec.guard(args, ctx); } catch { /* could not be checked: refused */ }
                if (blocked) return refuse(blocked);
            }

            const id = prior ? prior.id : await journal({ ...base, status: 'PREPARED' });
            ctx.opId = id;
            if (spec.budget === 'externalOperations'
                && await this._externalUsed(ctx.run.responsibilityId, id) >= ctx.externalBudget) {
                // Counted after its own row exists, so calls racing for the
                // last one cannot both take it: the later row sees the earlier.
                await db.run(
                    "UPDATE assistant_run_operations SET status = 'REFUSED', refusalCode = 'EXTERNAL_BUDGET', updatedAt = @now WHERE id = @id",
                    { id, now: utcText() }
                );
                return 'Not allowed (EXTERNAL_BUDGET).';
            }
            await mark(id, 'DISPATCHED');
            let result;
            try {
                if (spec.atomic) {
                    // The change and its journal row commit together or not at all.
                    result = await db.transaction(async () => {
                        const text = clip(await spec.run(args, ctx), RESULT_CHARS);
                        await mark(id, 'SUCCEEDED', text);
                        return text;
                    });
                    await ctx.account();
                    return result;
                }
                result = clip(await spec.run(args, ctx), RESULT_CHARS);
            } catch (error) {
                await mark(id, 'FAILED');
                // The reason stays out of the ledger and the journal; the
                // model gets a code it can act on.
                return `That did not work (${error?.code || 'ERROR'}).`;
            }
            await mark(id, 'SUCCEEDED', result);
            if (spec.source === 'private') ctx.privateRead = true;
            await ctx.account();
            ctx.childPending();
            return result;
        };
    }

    /**
     * Execute a claimed initiative to a settled state. Never throws: every
     * exit settles the initiative (or finds the lease already gone).
     * @param {{ initiative: Object, leaseToken: string, shouldStop?: () => boolean, now?: Date }} params
     * @returns {Promise<{ status: string, stopCode?: string, outcome?: string, runId?: number }>}
     */
    async execute({ initiative, leaseToken, shouldStop = () => false, now = new Date() }) {
        const initiatives = require('./assistantInitiativeService');
        const responsibility = await db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id: initiative.responsibilityId });
        if (!responsibility) {
            await initiatives.settle({ id: initiative.id, leaseToken, status: 'FAILED', stopCode: 'RESPONSIBILITY_NOT_FOUND' });
            return { status: 'FAILED', stopCode: 'RESPONSIBILITY_NOT_FOUND' };
        }
        const run = await this._open(initiative, responsibility);
        const actor = responsibility.actingUserId || responsibility.ownerUserId;
        const project = await this._project(responsibility);
        const budgets = this.budgets(responsibility, await control.budgetDefaults());
        const used = await this._usedToday(responsibility.id, run.id, now);
        const { features } = require('../features/featureState');
        const planStep = initiative.planStep || null;
        const steps = planStep ? require('./assistant/planStepRun') : null;
        // Private knowledge this run already read (a resumed run remembers).
        const journaled = await db.all(
            "SELECT DISTINCT tool FROM assistant_run_operations WHERE runId = @runId AND status = 'SUCCEEDED'", { runId: run.id }
        );
        // Can anyone but the person read what is written into the project?
        const sharedProject = project
            ? !(await require('./knowledgeTransferService').privateContextAllowed({ userId: actor, project }))
            : false;
        // Each tool says when it is on offer (a linked project, a feature
        // that is on, a plan-step run, an operation the grant names, a
        // capability still in the pilot). A plan step in a project other
        // people read is not offered the person's private knowledge at all.
        const offer = { project, features, planStep, grants: this._grants(responsibility), capabilities: await this._capabilities(responsibility) };
        const offered = new Set(Object.keys(TOOLS).filter((name) => {
            const spec = TOOLS[name];
            if (typeof spec.available === 'function' && !spec.available(offer)) return false;
            return !(planStep && sharedProject && spec.source === 'private');
        }));

        const ctx = {
            run, actor, project, budgets, used, offered,
            externalBudget: this.externalBudget(responsibility),
            // The agent plan step this run carries out, once dispatched.
            planStep: null,
            stepReport: null,
            privateRead: journaled.some(row => TOOLS[row.tool]?.source === 'private'),
            searches: Number(run.searches || 0),
            compute: Number(run.computeSeconds || 0),
            fileHashes: new Map(),
            opId: null,
            // The one research expedition this run started, if any.
            child: null,
            childPending() {
                if (this.child && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(this.child.status)) this.halt('CHILD_PENDING');
            },
            tokens: Number(run.tokensUsed || 0),
            stop: null,
            result: null,
            scope: require('../utils/dmScope').dmScopeId(actor),
            interactionContext: { user: { id: actor, username: 'you' }, guildId: null, isAutomation: true, skipHistory: false },
            halt(code) { if (!this.stop) this.stop = code; },
            heartbeat: async () => {
                if (shouldStop()) { ctx.halt('RUNNER_STOPPING'); return false; }
                if (await ctx.hostStopped()) return false;
                const alive = await initiatives.renewLease({ id: initiative.id, leaseToken });
                if (!alive) ctx.halt('LEASE_LOST');
                else await db.run('UPDATE assistant_runs SET heartbeatAt = @now WHERE id = @id', { id: run.id, now: utcText() });
                return alive;
            },
            // The host's stop-all, read from the database so every process agrees.
            hostStopped: async () => {
                const paused = await control.isPaused();
                if (paused) ctx.halt(control.PAUSED_CODE);
                return paused;
            },
            account: async () => {
                ctx.tokens = Math.max(ctx.tokens, await this.tokensFor(run.id));
                if (ctx.used.tokens + ctx.tokens >= ctx.budgets.modelTokens) ctx.halt('TOKEN_BUDGET');
                // Checked after each step too, so no further model round starts.
                await ctx.hostStopped();
            }
        };

        const finishRun = async (fields) => db.run(
            `UPDATE assistant_runs SET status = @status, stopCode = @stopCode, outcome = @outcome, rounds = @rounds,
                tokensUsed = @tokens, searches = @searches, computeSeconds = @compute, resultTitle = @title, resultSummary = @summary,
                updateId = @updateId, endedAt = @endedAt, updatedAt = @now
             WHERE id = @id`,
            {
                id: run.id, stopCode: null, outcome: null, title: null, summary: null, updateId: null,
                rounds: ctx.rounds || 0, tokens: ctx.tokens, searches: ctx.searches, compute: ctx.compute,
                endedAt: ['RUNNING', 'WAITING'].includes(fields.status) ? null : utcText(), now: utcText(), ...fields
            }
        );
        const park = async (waitReason, stopCode, recheckAfter) => {
            const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'WAITING', waitReason, stopCode, recheckAfter });
            await finishRun({ status: settled.ok ? 'WAITING' : 'CANCELLED', stopCode: settled.ok ? stopCode : 'LEASE_LOST' });
            return { status: settled.ok ? 'WAITING' : 'CANCELLED', stopCode, runId: run.id };
        };

        // A child expedition still working: keep waiting, without a model call.
        const pendingChild = await this._pendingChild(run.id);
        if (pendingChild) return park('dependency', 'CHILD_PENDING', new Date(now.getTime() + CHILD_RECHECK_MS));

        // Nothing is spent when today's budget is already gone.
        if (used.tokens >= budgets.modelTokens) return park('budget', 'TOKEN_BUDGET', nextDay(now));

        // A plan step: authorized and claimed before any model call.
        let stepWork = null;
        if (planStep) {
            const dispatched = await steps.dispatch({ initiative, run, responsibility, actor, project });
            if (!dispatched.ok) return this._planStepRefused({ dispatched, steps, run, initiative, leaseToken, actor, now, park, finishRun });
            stepWork = { step: dispatched.step, mission: dispatched.mission };
            ctx.planStep = { id: dispatched.step.id, missionId: dispatched.mission.id };
            if (dispatched.settled) {
                // A crash after the step was settled: finish the bookkeeping, do no work again.
                return this._planStepAlreadySettled({
                    settledAs: dispatched.settled, stepWork, run, initiative, leaseToken, responsibility, project, actor, finishRun
                });
            }
        }
        const releaseStep = async (code) => {
            if (stepWork) await steps.release({ runId: run.id, stepId: stepWork.step.id, code });
        };

        // A request made in a conversation (ADR 0021): read it again now, as
        // the person. Deleted, out of reach or no longer covered ends the
        // attempt here, before any model call.
        let request = null;
        const requests = !planStep && initiative.origin?.kind === 'parlor_message'
            ? require('./assistant/conversationRequestRun') : null;
        if (requests) {
            const loaded = await requests.load({ initiative, responsibility });
            if (!loaded.ok) {
                const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'SUPERSEDED', stopCode: loaded.code });
                await finishRun({ status: 'CANCELLED', stopCode: settled.ok ? loaded.code : 'LEASE_LOST' });
                return { status: settled.ok ? 'SUPERSEDED' : 'CANCELLED', stopCode: loaded.code, runId: run.id };
            }
            request = loaded.source;
        }
        // The lease is gone: cancelled, parked, revoked, or stopped by a
        // change of direction, whose update is brought up to date now that
        // the run has actually stopped.
        const leaseLost = async () => {
            await finishRun({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
            await require('./assistant/steering').afterRunStopped({ initiativeId: initiative.id });
            return { status: 'CANCELLED', stopCode: 'LEASE_LOST', runId: run.id };
        };

        let loop = null;
        let failure = null;
        try {
            const { runAgentLoop } = require('../utils/chat/agentOrchestrator');
            loop = await workContext.run(
                { kind: 'assistant_run', id: run.id, actor, payer: run.payerUserId || actor },
                () => runAgentLoop({
                    messages: stepWork
                        ? steps.messages({ responsibility, project, tools: [...offered], ...stepWork })
                        : request
                            ? requests.messages({ responsibility, project, tools: [...offered], source: request })
                            : this._messages({ responsibility, initiative, project, tools: [...offered] }),
                    chatOptions: {
                        max_tokens: REPLY_TOKENS,
                        background: true,
                        usageContext: { userId: actor, actorId: actor, guildId: `dm:${actor}` }
                    },
                    functionDefs: [...offered].map(name => TOOLS[name].definition),
                    interactionContext: ctx.interactionContext,
                    executeTool: this._executor(ctx),
                    onRoundStart: (round) => { ctx.rounds = round + 1; },
                    shouldAbort: () => Boolean(ctx.stop || ctx.result) || shouldStop(),
                    maxToolRounds: MAX_ROUNDS,
                    deadlineAt: now.getTime() + RUN_DEADLINE_MS
                }),
                { replace: true }
            );
        } catch (error) {
            failure = error;
        }
        try { ctx.tokens = Math.max(ctx.tokens, await this.tokensFor(run.id)); } catch { /* keep the last known figure */ }
        // A stop that landed during the last model call: work that has not
        // reported yet waits like the rest, and reports after the resume.
        if (!failure && !ctx.stop && !ctx.result) {
            try { await ctx.hostStopped(); } catch { /* the flag could not be read; the settle below decides */ }
        }

        if (failure) {
            const code = failure.code === 'BUDGET_EXCEEDED' ? 'ACCOUNT_BUDGET'
                : /no ai provider|not configured|NO_PROVIDER/i.test(`${failure.code} ${failure.message}`) ? 'NO_PROVIDER' : 'PROVIDER_ERROR';
            await workFailureService.note({ kind: 'assistant_run', workId: run.id, actor, phase: 'run', code });
            if (code === 'ACCOUNT_BUDGET') return park('budget', code, nextDay(now));
            if (code === 'NO_PROVIDER') return park('dependency', code, new Date(now.getTime() + 60 * 60 * 1000));
            // The step did not fail, the provider did: it goes back for a later attempt.
            await releaseStep(code);
            const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'FAILED', stopCode: code });
            await finishRun({ status: settled.ok ? 'FAILED' : 'CANCELLED', stopCode: settled.ok ? code : 'LEASE_LOST' });
            logger.warn?.(`[assistant run] run ${run.id} failed: ${code}`);
            return { status: 'FAILED', stopCode: code, runId: run.id };
        }

        if (ctx.stop === 'LEASE_LOST') {
            // Cancelled, parked, revoked or superseded while working: no result is written.
            await releaseStep('LEASE_LOST');
            return leaseLost();
        }
        if (ctx.stop === 'OPERATION_UNCERTAIN') {
            // A write that may or may not have happened is a blocker on the plan too.
            if (stepWork) {
                const closed = await steps.settle({ ctx, step: stepWork.step, ok: false, code: ctx.stop });
                if (!closed.ok) await releaseStep(closed.code);
            }
            const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'REVIEW', stopCode: ctx.stop });
            await finishRun({ status: settled.ok ? 'REVIEW' : 'CANCELLED', stopCode: ctx.stop });
            return { status: 'REVIEW', stopCode: ctx.stop, runId: run.id };
        }
        if (ctx.stop === 'RUNNER_STOPPING' || (shouldStop() && !ctx.result)) {
            // Shutdown: the lease lapses and the run resumes from its journal.
            await db.run('UPDATE assistant_runs SET rounds = @rounds, tokensUsed = @tokens, searches = @searches, computeSeconds = @compute, updatedAt = @now WHERE id = @id',
                { id: run.id, rounds: ctx.rounds || 0, tokens: ctx.tokens, searches: ctx.searches, compute: ctx.compute, now: utcText() });
            return { status: 'RUNNING', stopCode: 'RUNNER_STOPPING', runId: run.id };
        }
        if (ctx.stop === 'CHILD_PENDING') return park('dependency', 'CHILD_PENDING', new Date(now.getTime() + CHILD_RECHECK_MS));
        if (ctx.stop === 'TOKEN_BUDGET' && !ctx.result) return park('budget', 'TOKEN_BUDGET', nextDay(now));
        // Stopped by the host: it waits, and a resume puts it back in the queue.
        if (ctx.stop === control.PAUSED_CODE && !ctx.result) return park('dependency', control.PAUSED_CODE, null);
        if (ctx.stop && !ctx.result) {
            // The grant stopped covering the work (paused, revoked, expired,
            // edited), or the person lost the project of a plan step.
            await releaseStep(ctx.stop);
            return park(ctx.stop === 'RESOURCE_UNAVAILABLE' ? 'access' : 'responsibility', ctx.stop, null);
        }
        if (stepWork) {
            return this._finishPlanStep({
                ctx, steps, stepWork, loop, run, initiative, leaseToken, responsibility, project, actor, park, finishRun
            });
        }

        // What the run actually changed, read from its journal (not from
        // what the model says it did).
        const applied = await this._applied(run.id);
        const result = ctx.result || {
            outcome: 'DONE',
            title: clip(initiative.title, 200),
            summary: clip(String(loop?.content || '').trim(), SUMMARY_CHARS)
        };
        if (!ctx.result && !result.summary) {
            const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'FAILED', stopCode: 'NO_RESULT' });
            await finishRun({ status: settled.ok ? 'FAILED' : 'CANCELLED', stopCode: 'NO_RESULT' });
            return { status: 'FAILED', stopCode: 'NO_RESULT', runId: run.id };
        }

        if (applied.lines.length) {
            // A change was made: the person is always told, whatever the model reported.
            result.outcome = 'DONE';
            result.summary = clip(`${result.summary ? `${result.summary}\n\n` : ''}Changed: ${applied.lines.join(' ')}`, SUMMARY_CHARS);
        }
        // Settle first: a result is only published for work that still holds its lease.
        const settled = await initiatives.settle({
            id: initiative.id, leaseToken, status: 'COMPLETED', outcome: result.outcome,
            recheckAfter: result.outcome === 'NO_CHANGE' ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : null
        });
        if (!settled.ok) return leaseLost();
        let updateId = null;
        if (result.outcome === 'DONE') {
            try {
                const published = await require('./assistantUpdateService').publish({
                    audience: { userId: responsibility.ownerUserId },
                    identityKey: `initiative:${initiative.id}`,
                    kind: 'finding',
                    title: result.title || clip(initiative.title, 200),
                    summary: result.summary || null,
                    components: [...new Set([...(project ? ['projects'] : []), ...(request ? ['conversations'] : []), 'research', ...applied.components])],
                    source: { kind: 'initiative', id: initiative.id },
                    // A result of something asked in a conversation links back to it.
                    actions: [
                        { kind: 'open_initiative', id: String(initiative.id) },
                        ...(request ? [{ kind: 'open_conversation', id: String(request.conversationId) }] : [])
                    ],
                    responsibilityId: responsibility.id,
                    initiativeId: initiative.id,
                    producerUserId: actor,
                    deliver: true
                });
                updateId = published.update.id;
            } catch (error) {
                logger.warn?.(`[assistant run] run ${run.id} finished but its update could not be filed: ${error.message}`);
                await workFailureService.note({ kind: 'assistant_run', workId: run.id, actor, phase: 'publish', code: 'UPDATE_FAILED' });
            }
        }
        await finishRun({ status: 'COMPLETED', outcome: result.outcome, title: result.title || null, summary: result.summary || null, updateId });
        return { status: 'COMPLETED', outcome: result.outcome, runId: run.id, updateId };
    }

    // --- Plan-step runs (ADR 0019) -----------------------------------------------------

    /** Tell the person, privately, how their plan-step run ended. Never throws. */
    async _publishPlanStepUpdate({ run, initiative, responsibility, project, actor, title, summary, components = [] }) {
        try {
            const published = await require('./assistantUpdateService').publish({
                audience: { userId: responsibility.ownerUserId },
                identityKey: `initiative:${initiative.id}`,
                kind: 'progress',
                title,
                summary: summary || null,
                components: [...new Set(['projects', ...components])],
                source: { kind: 'initiative', id: initiative.id },
                actions: [{ kind: 'open_initiative', id: String(initiative.id) }, { kind: 'open_project', id: String(project.id) }],
                responsibilityId: responsibility.id,
                initiativeId: initiative.id,
                producerUserId: actor,
                deliver: true
            });
            return published.update.id;
        } catch (error) {
            logger.warn?.(`[assistant run] run ${run.id} finished but its update could not be filed: ${error.message}`);
            await workFailureService.note({ kind: 'assistant_run', workId: run.id, actor, phase: 'publish', code: 'UPDATE_FAILED' });
            return null;
        }
    }

    /** The step could not be dispatched: nothing was claimed and no model was called. */
    async _planStepRefused({ dispatched, steps, run, initiative, leaseToken, actor, now, park, finishRun }) {
        const initiatives = require('./assistantInitiativeService');
        const code = dispatched.code;
        // A resumed run may still hold the step from before.
        await steps.release({ runId: run.id, stepId: initiative.planStep.id, code });
        if (dispatched.authorize) {
            // The grant no longer covers it, or the person lost the project.
            return park(code === 'RESOURCE_UNAVAILABLE' ? 'access' : 'responsibility', code, null);
        }
        if (code === 'RESOURCE_UNAVAILABLE') return park('access', code, null);
        if (code === 'PLAN_BLOCKED') {
            // Another step failed: wait for the people on the project to unblock the plan.
            return park('dependency', code, new Date(now.getTime() + steps.BLOCKED_RECHECK_MS));
        }
        if (steps.SUPERSEDING.has(code)) {
            // The plan moved on, or someone else has the step: this attempt is void.
            const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'SUPERSEDED', stopCode: code });
            await finishRun({ status: 'CANCELLED', stopCode: settled.ok ? code : 'LEASE_LOST' });
            return { status: settled.ok ? 'SUPERSEDED' : 'CANCELLED', stopCode: code, runId: run.id };
        }
        await workFailureService.note({ kind: 'assistant_run', workId: run.id, actor, phase: 'dispatch', code });
        const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'FAILED', stopCode: code });
        await finishRun({ status: settled.ok ? 'FAILED' : 'CANCELLED', stopCode: settled.ok ? code : 'LEASE_LOST' });
        return { status: 'FAILED', stopCode: code, runId: run.id };
    }

    /** A resumed run whose step was settled before the crash: close the attempt to match. */
    async _planStepAlreadySettled({ settledAs, stepWork, run, initiative, leaseToken, responsibility, project, actor, finishRun }) {
        const initiatives = require('./assistantInitiativeService');
        const done = settledAs === 'DONE';
        const settled = await initiatives.settle({
            id: initiative.id, leaseToken, status: done ? 'COMPLETED' : 'FAILED', outcome: done ? 'DONE' : null,
            stopCode: done ? null : 'STEP_FAILED'
        });
        if (!settled.ok) {
            await finishRun({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
            return { status: 'CANCELLED', stopCode: 'LEASE_LOST', runId: run.id };
        }
        const title = clip(`${done ? 'Plan step done' : 'Plan step blocked'}: ${stepWork.step.title}`, 200);
        const updateId = await this._publishPlanStepUpdate({ run, initiative, responsibility, project, actor, title, summary: null });
        await finishRun({
            status: done ? 'COMPLETED' : 'FAILED', outcome: done ? 'DONE' : null, stopCode: done ? null : 'STEP_FAILED', title, updateId
        });
        return { status: done ? 'COMPLETED' : 'FAILED', outcome: done ? 'DONE' : undefined, stopCode: done ? undefined : 'STEP_FAILED', runId: run.id, updateId };
    }

    /**
     * The end of a plan-step run: verify what was reported, then settle the
     * step, then the attempt, then tell the person. The step comes first so
     * a crash in between resumes into _planStepAlreadySettled instead of
     * doing the work twice.
     */
    async _finishPlanStep({ ctx, steps, stepWork, loop, run, initiative, leaseToken, responsibility, project, actor, park, finishRun }) {
        const initiatives = require('./assistantInitiativeService');
        const { step, mission } = stepWork;
        const lost = async () => {
            await steps.release({ runId: run.id, stepId: step.id, code: 'LEASE_LOST' });
            await finishRun({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
            return { status: 'CANCELLED', stopCode: 'LEASE_LOST', runId: run.id };
        };
        // Nothing is written for work that no longer holds its lease.
        if (!(await initiatives.renewLease({ id: initiative.id, leaseToken }))) return lost();

        const stopped = async (code) => {
            await steps.release({ runId: run.id, stepId: step.id, code });
            return park(code === 'RESOURCE_UNAVAILABLE' ? 'access' : 'responsibility', code, null);
        };
        let verified = await steps.verify({ ctx, step, mission });
        if (!verified.ok && verified.authorize) return stopped(verified.code);

        let closed;
        if (verified.ok) {
            closed = await steps.settle({ ctx, step, ok: true, verified });
            if (!closed.ok && closed.code === 'EVIDENCE_LIMIT') verified = { ok: false, code: 'VERIFICATION_FAILED', detail: 'EVIDENCE_LIMIT' };
        }
        if (!verified.ok) closed = await steps.settle({ ctx, step, ok: false, code: verified.code });
        if (!closed.ok) {
            if (closed.code === 'RESOURCE_UNAVAILABLE' || closed.code === 'FEATURE_UNAVAILABLE') return stopped(closed.code);
            // A person closed the step, or the plan ended, while the run worked.
            const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'SUPERSEDED', stopCode: 'PLAN_STEP_CLOSED' });
            await finishRun({ status: 'CANCELLED', stopCode: settled.ok ? 'PLAN_STEP_CLOSED' : 'LEASE_LOST' });
            return { status: settled.ok ? 'SUPERSEDED' : 'CANCELLED', stopCode: 'PLAN_STEP_CLOSED', runId: run.id };
        }

        const applied = await this._applied(run.id);
        // The headline is the code's (what was verified); the model's own words follow it.
        const reported = [ctx.result?.title, ctx.result?.summary].filter(Boolean).join('\n')
            || clip(String(loop?.content || '').trim(), SUMMARY_CHARS);
        if (verified.ok) {
            const title = clip(`Plan step done: ${step.title}`, 200);
            const summary = clip(
                `${reported ? `${reported}\n\n` : ''}Files: ${verified.artifacts.map(a => a.path).join(', ')}.`, SUMMARY_CHARS
            );
            const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'COMPLETED', outcome: 'DONE' });
            if (!settled.ok) {
                await finishRun({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
                return { status: 'CANCELLED', stopCode: 'LEASE_LOST', runId: run.id };
            }
            const updateId = await this._publishPlanStepUpdate({
                run, initiative, responsibility, project, actor, title, summary, components: applied.components
            });
            await finishRun({ status: 'COMPLETED', outcome: 'DONE', title, summary, updateId });
            return { status: 'COMPLETED', outcome: 'DONE', runId: run.id, updateId };
        }

        // Not verified: a blocker on the plan, never a completed objective.
        const code = verified.code;
        await workFailureService.note({ kind: 'assistant_run', workId: run.id, actor, phase: 'verify', code: verified.detail || code });
        const title = clip(`Plan step blocked: ${step.title}`, 200);
        const why = {
            STEP_BLOCKED: 'It reported that it could not finish the step.',
            NO_STEP_REPORT: 'It ended without reporting a result.',
            VERIFICATION_FAILED: {
                NO_ARTIFACT: 'It reported the step done but named no file holding the result.',
                ARTIFACT_NOT_WRITTEN: 'A file the step needs was not written by this run.',
                ARTIFACT_MISSING: 'A file it reported is not in the project.',
                ARTIFACT_EMPTY: 'A file it reported is empty.',
                EVIDENCE_LIMIT: 'The plan cannot hold more evidence links.'
            }[verified.detail] || 'Its result could not be verified.'
        }[code];
        const summary = clip(
            `${why} The step is marked failed and the plan is blocked until someone retries or skips it.`
            + `${reported ? `\n\n${reported}` : ''}${applied.lines.length ? `\n\nChanged: ${applied.lines.join(' ')}` : ''}`,
            SUMMARY_CHARS
        );
        const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'FAILED', stopCode: code });
        if (!settled.ok) {
            await finishRun({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
            return { status: 'CANCELLED', stopCode: 'LEASE_LOST', runId: run.id };
        }
        const updateId = await this._publishPlanStepUpdate({
            run, initiative, responsibility, project, actor, title, summary, components: applied.components
        });
        await finishRun({ status: 'FAILED', stopCode: code, title, summary, updateId });
        return { status: 'FAILED', stopCode: code, runId: run.id, updateId };
    }

    /** Expeditions this run started, by the attempt id its journal row gives them. */
    async _children(runId) {
        return db.all(
            `SELECT e.id, e.status, e.userId FROM assistant_run_operations o
             JOIN spitball_expeditions e ON e.executionAttemptId = 'assistant_run:' || CAST(o.runId AS TEXT) || ':' || CAST(o.id AS TEXT)
             WHERE o.runId = @runId AND o.tool = 'startResearch'`,
            { runId }
        );
    }

    async _pendingChild(runId) {
        return (await this._children(runId)).find(child => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(child.status)) || null;
    }

    /**
     * Wake runs waiting on an expedition that has ended, and cancel
     * expeditions whose run was cancelled or failed. Called by the steward
     * and on `research.expedition_*` hints.
     */
    async reconcileChildren({ now = new Date() } = {}) {
        const out = { woken: 0, cancelled: 0 };
        const waiting = await db.all(
            `SELECT r.id AS runId, r.initiativeId FROM assistant_runs r
             JOIN assistant_initiatives i ON i.id = r.initiativeId
             WHERE i.status = 'WAITING' AND i.stopCode = 'CHILD_PENDING'`,
            {}
        );
        for (const row of waiting) {
            if (await this._pendingChild(row.runId)) continue;
            out.woken += (await db.run(
                `UPDATE assistant_initiatives SET recheckAfter = @now
                 WHERE id = @id AND status = 'WAITING' AND stopCode = 'CHILD_PENDING'`,
                { id: row.initiativeId, now: utcText(now) }
            )).changes || 0;
        }
        const orphans = await db.all(
            `SELECT e.id, e.userId FROM assistant_run_operations o
             JOIN assistant_runs r ON r.id = o.runId
             JOIN assistant_initiatives i ON i.id = r.initiativeId
             JOIN spitball_expeditions e ON e.executionAttemptId = 'assistant_run:' || CAST(o.runId AS TEXT) || ':' || CAST(o.id AS TEXT)
             WHERE o.tool = 'startResearch' AND i.status IN ('CANCELLED', 'FAILED', 'SUPERSEDED')
               AND e.status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
            {}
        );
        const expeditions = orphans.length ? requireOptional('./spitballExpeditionService', { feature: 'expeditions' }) : null;
        for (const orphan of orphans) {
            try {
                await expeditions?.cancelExpedition(orphan.id, { userId: orphan.userId });
                out.cancelled += 1;
            } catch { /* already finished */ }
        }
        return out;
    }

    /** Changes a run made, from its journal: one line per successful write. */
    async _applied(runId) {
        const rows = await db.all(
            `SELECT tool, resultText FROM assistant_run_operations
             WHERE runId = @runId AND effect = 'write' AND status = 'SUCCEEDED' ORDER BY id`,
            { runId }
        );
        const lines = [];
        const components = new Set();
        for (const row of rows) {
            const text = String(row.resultText || '');
            // A write tool that declined (title exists, note is the person's) changed nothing.
            if (!text || /^Not /.test(text)) continue;
            lines.push(text.split('\n')[0]);
            const component = TOOLS[row.tool]?.component;
            if (component) components.add(component);
        }
        return { lines, components: [...components] };
    }

    /** Retention: journals and runs of long-finished work (the initiative prune cascades too). */
    async prune({ days = 180, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        const result = await db.run(
            "DELETE FROM assistant_runs WHERE status IN ('COMPLETED', 'FAILED', 'CANCELLED') AND updatedAt < @cutoff", { cutoff }
        );
        return result.changes || 0;
    }
}

module.exports = new AssistantRunService();
module.exports.AssistantRunService = AssistantRunService;
module.exports.TOOLS = TOOLS;
module.exports.DEFAULT_BUDGETS = DEFAULT_BUDGETS;
module.exports.DEFAULT_EXTERNAL_OPERATIONS = DEFAULT_EXTERNAL_OPERATIONS;
module.exports.MAX_EXTERNAL_OPERATIONS = MAX_EXTERNAL_OPERATIONS;
module.exports.argsHash = argsHash;
