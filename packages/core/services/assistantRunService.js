/**
 * One delegated run (DA-3, ADR 0018): executes a claimed initiative with the
 * shared agent loop, under the responsibility's grant.
 *
 * What makes a run safe to leave unattended:
 *  - The model is offered a fixed, explicit set of tools (TOOLS below). Each
 *    one names the operation and resource it needs, and `authorize()` is
 *    asked before every call. A tool that is not in the table does not run.
 *    This increment's tools only read; nothing here writes for the person.
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

/** Used when the responsibility sets no budget of its own (per UTC day). */
const DEFAULT_BUDGETS = { modelTokens: 200_000, searches: 20 };
const MAX_ROUNDS = 8;
const RUN_DEADLINE_MS = 10 * 60 * 1000;
const REPLY_TOKENS = 1200;
const RESULT_CHARS = 16_000;
const SUMMARY_CHARS = 2000;
const FILE_CHARS = 12_000;

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

function clip(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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
 * The tools a run may be offered. `needs(args, ctx)` returns the operation
 * and resource `authorize()` must allow, or null for a tool that touches
 * nothing of the person's (public docs, the run's own report). `effect`
 * decides crash recovery: a read is safe to repeat, a write is not.
 */
const TOOLS = {
    searchWeb: {
        effect: 'read',
        budget: 'searches',
        definition: {
            name: 'searchWeb',
            description: 'Search the web and return a short sourced summary. Each search counts against a small daily budget; search only for what the task needs.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for.' } }, required: ['query'] }
        },
        needs: () => ({ operation: 'read', resource: { kind: 'web' } }),
        async run({ query }) {
            if (!query || typeof query !== 'string') return 'A search query is required.';
            return require('./perplexityService').search(query);
        }
    },
    lookupNotes: {
        effect: 'read',
        definition: {
            name: 'lookupNotes',
            description: 'Look up what is already in the person\'s own notes, memories and saved files about a topic.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look up.' } }, required: ['query'] }
        },
        needs: () => ({ operation: 'read', resource: { kind: 'knowledge', id: 'personal' } }),
        async run({ query }, ctx) {
            return require('../utils/toolsRegistry').execute('lookupNotes', {
                query: String(query || ''), about: 'me', interactionContext: ctx.interactionContext
            });
        }
    },
    listProjectFiles: {
        effect: 'read',
        definition: {
            name: 'listProjectFiles',
            description: 'List one folder of the linked project\'s workspace ("" is the top folder).',
            parameters: { type: 'object', properties: { dir: { type: 'string', description: 'Workspace-relative folder.' } } }
        },
        needs: ({ dir }, ctx) => (ctx.project
            ? { operation: 'read', resource: { kind: 'project', id: String(ctx.project.id), path: String(dir || '').replace(/\/+$/, '') || undefined } }
            : { refuse: 'NO_PROJECT' }),
        async run({ dir }, ctx) {
            const projects = requireOptional('./projectService', { feature: 'projects' });
            if (!projects) return 'Projects are not available on this installation.';
            const listing = await projects.listFiles({
                userId: ctx.actor, project: ctx.project.slug, owner: ctx.project.ownerId, path: String(dir || '')
            });
            const entries = (listing.files || listing.entries || []).slice(0, 200);
            return entries.length
                ? entries.map(entry => `${entry.kind === 'directory' ? 'dir ' : 'file'} ${entry.path}${entry.kind === 'directory' ? '/' : ` (${entry.size} bytes)`}`).join('\n')
                : 'That folder is empty.';
        }
    },
    readProjectFile: {
        effect: 'read',
        definition: {
            name: 'readProjectFile',
            description: 'Read one text file from the linked project\'s workspace.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' } }, required: ['path'] }
        },
        needs: ({ path }, ctx) => (ctx.project
            ? { operation: 'read', resource: { kind: 'project', id: String(ctx.project.id), path: String(path || '') } }
            : { refuse: 'NO_PROJECT' }),
        async run({ path }, ctx) {
            const projects = requireOptional('./projectService', { feature: 'projects' });
            if (!projects) return 'Projects are not available on this installation.';
            const file = await projects.readWorkspaceFile({
                userId: ctx.actor, slug: ctx.project.slug, owner: ctx.project.ownerId, relativePath: String(path || ''), purpose: 'portal'
            });
            if (!/^text\/|json|xml|yaml|javascript|markdown/.test(file.mime)) return `That file is ${file.mime}, not text (${file.size} bytes).`;
            return clip(file.bytes.toString('utf8'), FILE_CHARS);
        }
    },
    consultDocs: {
        effect: 'read',
        definition: {
            name: 'consultDocs',
            description: 'Search Goobster\'s own public documentation.',
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        },
        needs: () => null,
        async run({ query }, ctx) {
            return require('../utils/toolsRegistry').execute('consultDocs', {
                action: 'search', query: String(query || ''), interactionContext: ctx.interactionContext
            });
        }
    },
    finish: {
        effect: 'read',
        definition: {
            name: 'finish',
            description: 'Report the result and end the task. outcome "finding" = there is something the person should know; "no_change" = you checked and nothing needs their attention. Call this exactly once, last.',
            parameters: {
                type: 'object',
                properties: {
                    outcome: { type: 'string', enum: ['finding', 'no_change'] },
                    title: { type: 'string', description: 'One specific sentence: the result.' },
                    summary: { type: 'string', description: 'Why it matters for this responsibility, what you checked and the sources. Plain text.' }
                },
                required: ['outcome', 'title']
            }
        },
        needs: () => null,
        async run(args, ctx) {
            ctx.result = {
                outcome: args.outcome === 'no_change' ? 'NO_CHANGE' : 'DONE',
                title: clip(String(args.title || '').trim(), 200),
                summary: clip(String(args.summary || '').trim(), SUMMARY_CHARS)
            };
            return 'Recorded. Stop now.';
        }
    }
};

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

    /** The grant's daily caps: its own numbers, or the defaults when unset. */
    budgets(responsibility) {
        let stored = {};
        try { stored = JSON.parse(responsibility.budgetsJson || '{}') || {}; } catch { stored = {}; }
        const pick = (key) => (Number.isSafeInteger(stored[key]) ? stored[key] : DEFAULT_BUDGETS[key]);
        return { modelTokens: pick('modelTokens'), searches: pick('searches') };
    }

    /** Tokens this run has reserved or spent so far (the work ledger's own rows). */
    async tokensFor(runId) {
        const row = await db.get(
            `SELECT COALESCE(SUM(COALESCE(actualTokens, estimatedTokens)), 0) AS n FROM usage_reservations
             WHERE workKind = 'assistant_run' AND workId = @id AND status <> 'released'`,
            { id: String(runId) }
        );
        return Number(row?.n || 0);
    }

    /** What the responsibility's other runs used today (UTC). */
    async _usedToday(responsibilityId, exceptRunId, now) {
        const row = await db.get(
            `SELECT COALESCE(SUM(tokensUsed), 0) AS tokens, COALESCE(SUM(searches), 0) AS searches FROM assistant_runs
             WHERE responsibilityId = @rid AND id <> @run AND startedAt >= @day`,
            { rid: responsibilityId, run: exceptRunId, day: dayStart(now) }
        );
        return { tokens: Number(row?.tokens || 0), searches: Number(row?.searches || 0) };
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
            `You may only use these tools: ${tools.join(', ')}. You can read and research; you cannot change, save, send or run anything. If the work needs an action you cannot take, say so in your report instead of attempting it.`,
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
                return prior.resultText || '';
            }
            if (prior?.status === 'REFUSED') return `Not allowed (${prior.refusalCode || 'REFUSED'}).`;
            if (prior && spec.effect === 'write') {
                // In flight when the worker died: it may or may not have
                // happened. Never retried blindly.
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
            if (need) {
                const verdict = await responsibilities.authorize({
                    responsibilityId: ctx.run.responsibilityId,
                    revision: ctx.run.responsibilityRevision,
                    operation: need.operation,
                    resource: need.resource,
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

            const id = prior ? prior.id : await journal({ ...base, status: 'PREPARED' });
            await mark(id, 'DISPATCHED');
            let result;
            try {
                result = clip(await spec.run(args, ctx), RESULT_CHARS);
            } catch (error) {
                await mark(id, 'FAILED');
                // The reason stays out of the ledger and the journal; the
                // model gets a code it can act on.
                return `That did not work (${error?.code || 'ERROR'}).`;
            }
            await mark(id, 'SUCCEEDED', result);
            await ctx.account();
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
        const offered = new Set(Object.keys(TOOLS).filter(name => project || !name.includes('Project')));

        const ctx = {
            run, actor, project, budgets, used, offered,
            searches: Number(run.searches || 0),
            tokens: Number(run.tokensUsed || 0),
            stop: null,
            result: null,
            interactionContext: { user: { id: actor, username: 'you' }, guildId: null, isAutomation: true, skipHistory: false },
            halt(code) { if (!this.stop) this.stop = code; },
            heartbeat: async () => {
                if (shouldStop()) { ctx.halt('RUNNER_STOPPING'); return false; }
                const alive = await initiatives.renewLease({ id: initiative.id, leaseToken });
                if (!alive) ctx.halt('LEASE_LOST');
                else await db.run('UPDATE assistant_runs SET heartbeatAt = @now WHERE id = @id', { id: run.id, now: utcText() });
                return alive;
            },
            account: async () => {
                ctx.tokens = Math.max(ctx.tokens, await this.tokensFor(run.id));
                if (ctx.used.tokens + ctx.tokens >= ctx.budgets.modelTokens) ctx.halt('TOKEN_BUDGET');
            }
        };

        const finishRun = async (fields) => db.run(
            `UPDATE assistant_runs SET status = @status, stopCode = @stopCode, outcome = @outcome, rounds = @rounds,
                tokensUsed = @tokens, searches = @searches, resultTitle = @title, resultSummary = @summary,
                updateId = @updateId, endedAt = @endedAt, updatedAt = @now
             WHERE id = @id`,
            {
                id: run.id, stopCode: null, outcome: null, title: null, summary: null, updateId: null,
                rounds: ctx.rounds || 0, tokens: ctx.tokens, searches: ctx.searches,
                endedAt: ['RUNNING', 'WAITING'].includes(fields.status) ? null : utcText(), now: utcText(), ...fields
            }
        );
        const park = async (waitReason, stopCode, recheckAfter) => {
            const settled = await initiatives.settle({ id: initiative.id, leaseToken, status: 'WAITING', waitReason, stopCode, recheckAfter });
            await finishRun({ status: settled.ok ? 'WAITING' : 'CANCELLED', stopCode: settled.ok ? stopCode : 'LEASE_LOST' });
            return { status: settled.ok ? 'WAITING' : 'CANCELLED', stopCode, runId: run.id };
        };

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
            await db.run('UPDATE assistant_runs SET rounds = @rounds, tokensUsed = @tokens, searches = @searches, updatedAt = @now WHERE id = @id',
                { id: run.id, rounds: ctx.rounds || 0, tokens: ctx.tokens, searches: ctx.searches, now: utcText() });
            return { status: 'RUNNING', stopCode: 'RUNNER_STOPPING', runId: run.id };
        }
        if (ctx.stop === 'TOKEN_BUDGET' && !ctx.result) return park('budget', 'TOKEN_BUDGET', nextDay(now));
        if (ctx.stop && !ctx.result) {
            // The grant stopped covering the work (paused, revoked, expired, edited).
            return park('responsibility', ctx.stop, null);
        }

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
                    components: project ? ['projects', 'research'] : ['research'],
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
