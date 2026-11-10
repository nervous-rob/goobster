/**
 * One delegated run (DA-3, ADR 0018): executes a claimed initiative with the
 * shared agent loop, under the responsibility's grant.
 *
 * What makes a run safe to leave unattended:
 *  - The model is offered a fixed, explicit set of tools (TOOLS below). Each
 *    one names the operation and resource it needs, and `authorize()` is
 *    asked before every call. A tool that is not in the table does not run.
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
const assistantConfig = require('../config/assistantConfig');
const control = require('./assistantControlService');
const requireOptional = require('../utils/optionalModule').forModule(module);

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
const RESULT_CHARS = 16_000;
const SUMMARY_CHARS = 2000;
const FILE_CHARS = 12_000;
const WRITE_CHARS = 200_000;
/** How soon a run waiting on its expedition looks again (events usually wake it sooner). */
const CHILD_RECHECK_MS = 5 * 60 * 1000;

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** authorize() codes after which the run cannot continue at all. */
const STOP_CODES = new Set([
    'RESPONSIBILITY_NOT_FOUND', 'RESPONSIBILITY_REVOKED', 'RESPONSIBILITY_EXPIRED', 'RESPONSIBILITY_INACTIVE',
    'REVISION_CONFLICT', 'ACTOR_MISMATCH', 'ATTENTION_NOT_ENROLLED', 'FEATURE_UNAVAILABLE', 'ASSISTANT_PAUSED'
]);

/**
 * The version of the instructions a run is given (`_messages`). Raise it
 * when they change on purpose: evaluation results are compared per version
 * (documentation/delegated_evaluation.md).
 */
const PROMPT_VERSION = 1;

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
 * decides crash recovery: a read is safe to repeat, a write is not - unless
 * it is `atomic`: a write to our own database that commits in the same
 * transaction as its journal row, so "in flight" means "did not happen".
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
            ctx.fileHashes.set(String(path), sha(file.bytes));
            if (!/^text\/|json|xml|yaml|javascript|markdown/.test(file.mime)) return `That file is ${file.mime}, not text (${file.size} bytes).`;
            return clip(file.bytes.toString('utf8'), FILE_CHARS);
        }
    },
    writeProjectFile: {
        effect: 'write',
        component: 'projects',
        definition: {
            name: 'writeProjectFile',
            description: 'Create or replace one text file in the linked project\'s workspace. To change an existing file, read it with readProjectFile first in this same task; a file that changed since you read it is refused. The previous version stays in the project\'s history.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Workspace-relative file path.' },
                    content: { type: 'string', description: 'The whole new file.' }
                },
                required: ['path', 'content']
            }
        },
        needs: ({ path }, ctx) => (ctx.project
            ? { operation: 'file.edit', resource: { kind: 'project', id: String(ctx.project.id), path: String(path || '') } }
            : { refuse: 'NO_PROJECT' }),
        async _current(path, ctx) {
            const projects = requireOptional('./projectService', { feature: 'projects' });
            if (!projects) return { missing: true };
            try {
                const file = await projects.readWorkspaceFile({
                    userId: ctx.actor, slug: ctx.project.slug, owner: ctx.project.ownerId, relativePath: String(path || ''), purpose: 'portal'
                });
                return { hash: sha(file.bytes) };
            } catch (error) {
                if (error?.code === 'NOT_FOUND') return { missing: true };
                throw error;
            }
        },
        /** After a crash: the file holding exactly this content means the write happened. */
        async reconcile({ path, content }, ctx) {
            const current = await this._current(path, ctx);
            if (!current.missing && current.hash === sha(Buffer.from(String(content ?? '')))) {
                return { state: 'done', result: `Wrote ${String(path)}.` };
            }
            return { state: 'unknown' };
        },
        async run({ path, content }, ctx) {
            const projects = requireOptional('./projectService', { feature: 'projects' });
            if (!projects) return 'Not written: projects are not available on this installation.';
            const text = String(content ?? '');
            if (text.length > WRITE_CHARS) return `Not written: the file is longer than ${WRITE_CHARS} characters.`;
            const current = await this._current(path, ctx);
            if (!current.missing) {
                const seen = ctx.fileHashes.get(String(path));
                if (!seen) return 'Not written: that file exists. Read it with readProjectFile first.';
                if (seen !== current.hash) return 'Not written: the file changed since you read it. Read it again before deciding.';
            }
            await projects.writeWorkspaceFile({
                userId: ctx.actor, slug: ctx.project.slug, owner: ctx.project.ownerId, relativePath: String(path || ''), bytes: Buffer.from(text)
            });
            ctx.fileHashes.set(String(path), sha(Buffer.from(text)));
            return `Wrote ${String(path)}.`;
        }
    },
    runProjectFile: {
        effect: 'write',
        budget: 'computeSeconds',
        component: 'projects',
        definition: {
            name: 'runProjectFile',
            description: 'Run one .py, .js or .sh file from the linked project in the sandbox (no network) and return its output. Each run counts against a small daily compute budget.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Workspace-relative file to run.' },
                    args: { type: 'array', items: { type: 'string' } }
                },
                required: ['path']
            }
        },
        needs: ({ path }, ctx) => (ctx.project
            ? { operation: 'sandbox.run', resource: { kind: 'project', id: String(ctx.project.id), path: String(path || '') } }
            : { refuse: 'NO_PROJECT' }),
        _attempt: (ctx) => `assistant_run:${ctx.run.id}:${ctx.opId}`,
        /** After a crash: the job row with this attempt id says whether it ran. */
        async reconcile(_args, ctx) {
            const job = await db.get(
                'SELECT id, status, exitCode FROM observatory_jobs WHERE executionAttemptId = @attempt', { attempt: this._attempt(ctx) }
            );
            if (!job) return { state: 'absent' };
            if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
                return { state: 'done', result: `Ran as job #${job.id}: ${String(job.status).toLowerCase()} (exit ${job.exitCode ?? '?'}). Its output is in the project's Runs.` };
            }
            return { state: 'unknown' };
        },
        async run({ path, args }, ctx) {
            const projects = requireOptional('./projectService', { feature: 'projects' });
            if (!projects) return 'Not run: projects are not available on this installation.';
            const started = Date.now();
            try {
                const outcome = await projects.runFile({
                    userId: ctx.actor, project: ctx.project.slug, owner: ctx.project.ownerId, path: String(path || ''),
                    args: Array.isArray(args) ? args.map(String) : [], background: false,
                    startedBy: 'assistant', executionAttemptId: this._attempt(ctx)
                });
                const result = outcome.result || {};
                return clip(
                    `Ran ${String(path)} as job #${outcome.jobId ?? '?'}: ${result.ok ? 'ok' : 'failed'} (exit ${result.exitCode ?? '?'}).\n`
                    + `stdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`, RESULT_CHARS
                );
            } finally {
                ctx.compute += Math.max(1, Math.round((Date.now() - started) / 1000));
            }
        }
    },
    startResearch: {
        effect: 'write',
        component: 'research',
        definition: {
            name: 'startResearch',
            description: 'Start one focused research expedition on a topic: it reads sources over several minutes and writes sourced, generated notes. Use it only when a few web searches are not enough. This task pauses until it finishes and then continues with its findings. At most one per task.',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'What to research (under 200 characters).' },
                    intent: { type: 'string', description: 'What the person needs to learn from it.' }
                },
                required: ['topic']
            }
        },
        // It searches and it writes notes: both must be delegated.
        needs: () => ({
            operation: 'research', resource: { kind: 'web' },
            also: [{ operation: 'kg.generated.add', resource: { kind: 'knowledge', id: 'personal' } }]
        }),
        _attempt: (ctx) => `assistant_run:${ctx.run.id}:${ctx.opId}`,
        async _find(attempt) {
            return db.get(
                'SELECT id, status, summary, stopReason FROM spitball_expeditions WHERE executionAttemptId = @attempt', { attempt }
            );
        },
        _describe(expedition) {
            if (expedition.status === 'COMPLETED') {
                return `Research expedition #${expedition.id} finished. ${clip(expedition.summary || 'It wrote its notes; use lookupNotes to read them.', 3000)}`;
            }
            if (expedition.status === 'FAILED' || expedition.status === 'CANCELLED') {
                return `Research expedition #${expedition.id} ${expedition.status.toLowerCase()} without a result.`;
            }
            return `Started research expedition #${expedition.id}. This task pauses until it finishes.`;
        },
        /** After a crash: an expedition carrying this attempt id means it was started. */
        async reconcile(_args, ctx) {
            const expedition = await this._find(this._attempt(ctx));
            if (!expedition) return { state: 'absent' };
            ctx.child = expedition;
            return { state: 'done', result: this._describe(expedition) };
        },
        /** On a resumed run: say how the expedition ended, not that it started. */
        async replay(prior, ctx) {
            const expedition = await this._find(`assistant_run:${ctx.run.id}:${prior.id}`);
            if (!expedition) return prior.resultText || '';
            ctx.child = expedition;
            return this._describe(expedition);
        },
        async run({ topic, intent }, ctx) {
            if (ctx.child) return 'Not started: this task already ran its one research expedition.';
            const expeditions = requireOptional('./spitballExpeditionService', { feature: 'expeditions' });
            if (!expeditions) return 'Not started: research expeditions are not available on this installation.';
            const expedition = await expeditions.createExpedition({
                userId: ctx.actor, seed: String(topic || ''), intent: intent ? String(intent) : null,
                depth: 'focused', executionAttemptId: this._attempt(ctx)
            });
            ctx.child = { id: expedition.id, status: 'QUEUED' };
            return this._describe(ctx.child);
        }
    },
    listGeneratedNotes: {
        effect: 'read',
        definition: {
            name: 'listGeneratedNotes',
            description: 'List the notes you (not the person) wrote earlier and may still amend, with their id and revision.',
            parameters: { type: 'object', properties: {} }
        },
        needs: () => ({ operation: 'read', resource: { kind: 'knowledge', id: 'personal' } }),
        async run(_args, ctx) {
            const notes = await require('./knowledgeGraphService').listGeneratedNotes({ guildId: ctx.scope, userId: ctx.actor });
            return notes.length
                ? notes.map(note => `#${note.id} (revision ${note.revision}) ${note.label}: ${clip(note.content || '', 400)}`).join('\n')
                : 'There are no generated notes yet.';
        }
    },
    addGeneratedNote: {
        effect: 'write',
        atomic: true,
        component: 'knowledge',
        definition: {
            name: 'addGeneratedNote',
            description: 'Add one new note to the person\'s knowledge, marked as generated by you. Only for something sourced and worth keeping. It never replaces an existing note: a title that exists is refused.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'A short, specific title.' },
                    content: { type: 'string', description: 'The note, with where it came from.' }
                },
                required: ['title', 'content']
            }
        },
        needs: () => ({ operation: 'kg.generated.add', resource: { kind: 'knowledge', id: 'personal' } }),
        async run({ title, content }, ctx) {
            const added = await require('./knowledgeGraphService').addGeneratedNote({
                guildId: ctx.scope, userId: ctx.actor, label: title, content, originRunId: ctx.run.id
            });
            if (!added.ok) {
                return {
                    EXISTS: 'Not added: a note with that title already exists. Do not overwrite it.',
                    CAPACITY: 'Not added: the person\'s knowledge is full. Report the finding instead.',
                    BAD_REQUEST: 'Not added: a title and content are required.'
                }[added.code];
            }
            return `Added as note #${added.id}.`;
        }
    },
    amendGeneratedNote: {
        effect: 'write',
        atomic: true,
        component: 'knowledge',
        definition: {
            name: 'amendGeneratedNote',
            description: 'Replace the text of a note you generated earlier. Pass the id and revision from listGeneratedNotes. A note the person has edited or saved is theirs and cannot be amended.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    revision: { type: 'integer', description: 'The revision you read.' },
                    content: { type: 'string', description: 'The full new text.' }
                },
                required: ['id', 'revision', 'content']
            }
        },
        needs: () => ({ operation: 'kg.generated.amend', resource: { kind: 'knowledge', id: 'personal' } }),
        async run({ id, revision, content }, ctx) {
            const amended = await require('./knowledgeGraphService').amendGeneratedNote({
                guildId: ctx.scope, userId: ctx.actor, nodeId: id, content, expectedRevision: revision
            });
            if (!amended.ok) {
                return {
                    NOT_FOUND: 'Not amended: no such note.',
                    NOT_GENERATED: 'Not amended: the person has edited or saved that note, so it is theirs. Report your suggestion instead.',
                    REVISION_CONFLICT: 'Not amended: the note changed since you read it. Read it again before deciding.',
                    BAD_REQUEST: 'Not amended: content and the revision you read are required.'
                }[amended.code];
            }
            return `Amended; it is now revision ${amended.revision}.`;
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

    /**
     * Which instructions and tool definitions a run is given right now: the
     * version above, and a fingerprint that changes with any edit to the
     * instructions or to a tool's definition, bumped or not.
     * @returns {{ version: number, fingerprint: string, label: string }}
     */
    promptVersion() {
        const messages = this._messages({
            responsibility: { title: '{title}', outcome: '{outcome}' },
            initiative: { title: '{change}', reason: '{detail}' },
            project: { name: '{project}' },
            tools: Object.keys(TOOLS)
        });
        const definitions = Object.values(TOOLS).map(tool => tool.definition);
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ messages, definitions })).digest('hex').slice(0, 12);
        return { version: PROMPT_VERSION, fingerprint, label: `v${PROMPT_VERSION}-${fingerprint}` };
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
        const budgets = this.budgets(responsibility, await control.budgetDefaults());
        const used = await this._usedToday(responsibility.id, run.id, now);
        const { features } = require('../features/featureState');
        const offered = new Set(Object.keys(TOOLS).filter((name) => {
            if (name.includes('Project') && !project) return false;
            if (name === 'runProjectFile' && features.enforcedOff('sandbox')) return false;
            if (name.includes('GeneratedNote') && features.enforcedOff('knowledge')) return false;
            if (name === 'startResearch' && (features.enforcedOff('expeditions') || features.enforcedOff('knowledge'))) return false;
            return true;
        }));

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
        // Stopped by the host: it waits, and a resume puts it back in the queue.
        if (ctx.stop === control.PAUSED_CODE && !ctx.result) return park('dependency', control.PAUSED_CODE, null);
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
module.exports.PROMPT_VERSION = PROMPT_VERSION;
module.exports.argsHash = argsHash;
