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
 * It never takes the foreground chat claim (`web_live_turns`).
 * Spec: documentation/delegated_runs.md.
 */

const crypto = require('node:crypto');
const db = require('../db');
const logger = require('../utils/logger');
const workContext = require('../utils/workContext');
const workFailureService = require('./workFailureService');
const requireOptional = require('../utils/optionalModule').forModule(module);
const { clip, RESULT_CHARS, SUMMARY_CHARS } = require('./assistant/runTools/shared');

/** Tells open portals that someone's run started, moved or stopped (kinds only). */
const live = () => require('./assistantLiveService');

/** Used when the responsibility sets no budget of its own (per UTC day). */
const DEFAULT_BUDGETS = { modelTokens: 200_000, searches: 20, computeSeconds: 120 };
const MAX_ROUNDS = 8;
const RUN_DEADLINE_MS = 10 * 60 * 1000;
const REPLY_TOKENS = 1200;
/** How soon a run waiting on its expedition looks again (events usually wake it sooner). */
const CHILD_RECHECK_MS = 5 * 60 * 1000;

/** authorize() codes after which the run cannot continue at all. */
const STOP_CODES = new Set([
    'RESPONSIBILITY_NOT_FOUND', 'RESPONSIBILITY_REVOKED', 'RESPONSIBILITY_EXPIRED', 'RESPONSIBILITY_INACTIVE',
    'REVISION_CONFLICT', 'ACTOR_MISMATCH', 'ATTENTION_NOT_ENROLLED', 'FEATURE_UNAVAILABLE'
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

    /** The grant's daily caps: its own numbers, or the defaults when unset. */
    budgets(responsibility) {
        let stored = {};
        try { stored = JSON.parse(responsibility.budgetsJson || '{}') || {}; } catch { stored = {}; }
        const pick = (key) => (Number.isSafeInteger(stored[key]) ? stored[key] : DEFAULT_BUDGETS[key]);
        return { modelTokens: pick('modelTokens'), searches: pick('searches'), computeSeconds: pick('computeSeconds') };
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
            live().changed(existing.ownerUserId, 'run');
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
        live().changed(responsibility.ownerUserId, 'run');
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
                if (name === 'finish') await spec.run(args, ctx);
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

            const need = spec.needs(args, ctx);
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
                    return refuse(verdict.code);
                }
            }
            if (spec.budget === 'searches') {
                if (ctx.used.searches + ctx.searches >= ctx.budgets.searches) return refuse('SEARCH_BUDGET');
                ctx.searches += 1;
            }
            if (spec.budget === 'computeSeconds' && ctx.used.compute + ctx.compute >= ctx.budgets.computeSeconds) {
                return refuse('COMPUTE_BUDGET');
            }

            const id = prior ? prior.id : await journal({ ...base, status: 'PREPARED' });
            ctx.opId = id;
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
        const budgets = this.budgets(responsibility);
        const used = await this._usedToday(responsibility.id, run.id, now);
        const { features } = require('../features/featureState');
        // Each tool says when it is on offer (a linked project, a feature that is on).
        const offered = new Set(Object.keys(TOOLS).filter((name) => (
            typeof TOOLS[name].available === 'function' ? Boolean(TOOLS[name].available({ project, features })) : true
        )));

        const ctx = {
            run, actor, project, budgets, used, offered,
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
                const alive = await initiatives.renewLease({ id: initiative.id, leaseToken });
                if (!alive) ctx.halt('LEASE_LOST');
                else {
                    await db.run('UPDATE assistant_runs SET heartbeatAt = @now WHERE id = @id', { id: run.id, now: utcText() });
                    // Progress for open portals, at most once in five seconds per run.
                    live().progress(run.ownerUserId, run.id);
                }
                return alive;
            },
            account: async () => {
                ctx.tokens = Math.max(ctx.tokens, await this.tokensFor(run.id));
                if (ctx.used.tokens + ctx.tokens >= ctx.budgets.modelTokens) ctx.halt('TOKEN_BUDGET');
            }
        };

        const finishRun = async (fields) => {
            const written = await db.run(
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
            live().forgetRun(run.id);
            live().changed(run.ownerUserId, 'run');
            return written;
        };
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

        let loop = null;
        let failure = null;
        try {
            const { runAgentLoop } = require('../utils/chat/agentOrchestrator');
            loop = await workContext.run(
                { kind: 'assistant_run', id: run.id, actor, payer: run.payerUserId || actor },
                () => runAgentLoop({
                    messages: this._messages({ responsibility, initiative, project, tools: [...offered] }),
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

        if (failure) {
            const code = failure.code === 'BUDGET_EXCEEDED' ? 'ACCOUNT_BUDGET'
                : /no ai provider|not configured|NO_PROVIDER/i.test(`${failure.code} ${failure.message}`) ? 'NO_PROVIDER' : 'PROVIDER_ERROR';
            await workFailureService.note({ kind: 'assistant_run', workId: run.id, actor, phase: 'run', code });
            if (code === 'ACCOUNT_BUDGET') return park('budget', code, nextDay(now));
            if (code === 'NO_PROVIDER') return park('dependency', code, new Date(now.getTime() + 60 * 60 * 1000));
            const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'FAILED', stopCode: code });
            await finishRun({ status: settled.ok ? 'FAILED' : 'CANCELLED', stopCode: settled.ok ? code : 'LEASE_LOST' });
            logger.warn?.(`[assistant run] run ${run.id} failed: ${code}`);
            return { status: 'FAILED', stopCode: code, runId: run.id };
        }

        if (ctx.stop === 'LEASE_LOST') {
            // Cancelled, parked or revoked while working: no result is written.
            await finishRun({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
            return { status: 'CANCELLED', stopCode: 'LEASE_LOST', runId: run.id };
        }
        if (ctx.stop === 'OPERATION_UNCERTAIN') {
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
        if (ctx.stop && !ctx.result) {
            // The grant stopped covering the work (paused, revoked, expired, edited).
            return park('responsibility', ctx.stop, null);
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
        if (!settled.ok) {
            await finishRun({ status: 'CANCELLED', stopCode: 'LEASE_LOST' });
            return { status: 'CANCELLED', stopCode: 'LEASE_LOST', runId: run.id };
        }
        let updateId = null;
        if (result.outcome === 'DONE') {
            try {
                const published = await require('./assistantUpdateService').publish({
                    audience: { userId: responsibility.ownerUserId },
                    identityKey: `initiative:${initiative.id}`,
                    kind: 'finding',
                    title: result.title || clip(initiative.title, 200),
                    summary: result.summary || null,
                    components: [...new Set([...(project ? ['projects'] : []), 'research', ...applied.components])],
                    source: { kind: 'initiative', id: initiative.id },
                    actions: [{ kind: 'open_initiative', id: String(initiative.id) }],
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
module.exports.argsHash = argsHash;
