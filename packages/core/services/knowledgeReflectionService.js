const db = require('../db');
const aiService = require('./aiService');
const memoryService = require('./memoryService');
const knowledgeGraphService = require('./knowledgeGraphService');
const kgConfig = require('../config/knowledgeGraphConfig');
const { isDmScopeId } = require('../utils/dmScope');

const LIMITS = kgConfig.LIMITS.reflection;
const REFLECTION = kgConfig.REFLECTION;

/** Machine-readable reflection error (mirrors WebDashboardError's contract). */
class ReflectionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ReflectionError';
        this.code = code;
    }
}

/** Derive subject metadata back out of a scopeKey. */
function subjectFromScopeKey(scopeKey) {
    if (scopeKey === 'GUILD') return { subjectType: 'GUILD', subjectId: null };
    if (scopeKey.startsWith('USER:')) {
        return { subjectType: 'USER', subjectId: scopeKey.slice('USER:'.length) };
    }
    if (scopeKey.startsWith('PARLOR:')) {
        return { subjectType: 'USER', subjectId: null };
    }
    return { subjectType: null, subjectId: null };
}

function parseJsonBlock(response) {
    const jsonMatch = String(response || '').match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/** Accept both { mutations: {...} } and bare mutation objects. */
function extractMutations(parsed) {
    if (!parsed) return null;
    const candidate = parsed.mutations && typeof parsed.mutations === 'object'
        ? parsed.mutations
        : parsed;
    return knowledgeGraphService.hasMutationPayload(candidate) ? candidate : null;
}

function sumApplied(target, applied) {
    for (const key of Object.keys(applied || {})) {
        if (typeof applied[key] === 'number') {
            target[key] = (target[key] || 0) + applied[key];
        }
    }
    return target;
}

/* ------------------------------------------------------------------------ */
/* Passes                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * distill — the on-demand sleep cycle: reviews undistilled raw memories for
 * the scope and proposes graph mutations. Unlike the nightly consolidation
 * it is not limited to the last 24 hours, and each memory is presented with
 * its id so the model can cite provenance (`memoryIds`) per upsert.
 */
async function runDistillPass(ctx) {
    const { guildId, scopeKey, subjectType, subjectId } = ctx;

    let authorClause = '';
    const params = { guildId, max: LIMITS.maxMemoriesReviewed };
    if (subjectType === 'USER' && subjectId && !isDmScopeId(guildId)) {
        // In a guild, a personal reflection only reads the user's own memories
        // (the same boundary the dashboard enforces for browsing).
        authorClause = 'AND authorId = @authorId';
        params.authorId = subjectId;
    }
    const memories = await db.all(
        `SELECT id, authorName, content, createdAt FROM memory_embeddings
         WHERE guildId = @guildId AND distilledAt IS NULL ${authorClause}
         ORDER BY id ASC LIMIT @max`,
        params
    );
    if (memories.length === 0) {
        return { memoriesReviewed: 0, skipped: 'nothing new to distill' };
    }

    const existingGraph = await knowledgeGraphService.describeForPrompt({
        guildId,
        scopeKey,
        limit: 15
    });
    const transcript = memories
        .map(m => `[#${m.id}] [${m.createdAt}] ${m.authorName || 'someone'}: ${m.content}`)
        .join('\n');

    const prompt = `You are distilling a Discord bot's raw memories into a knowledge graph. Review the memory snippets and produce structured graph mutations.

Extract durable knowledge: preferences, projects, relationships, running jokes, conventions. Skip small talk and anything the existing graph already covers.

Respond with ONLY JSON:
{
  "mutations": {
    "upsert": [{ "type": "fact|concept|opinion|experience|person|place|event|thing", "label": "short unique title", "content": "detail", "salience": 0.7, "confidence": 0.8, "tags": ["topic"], "memoryIds": [123] }],
    "link": [{ "source": "label", "target": "label", "relation": "caused_by|part_of|relates_to|...", "relationKind": "causal|logical|associative|temporal|social", "weight": 0.8 }],
    "tag": [{ "label": "existing node label", "tags": ["tag"] }],
    "merge": [{ "keep": "label-a", "drop": "label-b" }],
    "contradict": [{ "source": "older claim", "target": "newer claim" }]
  }
}

Each upsert should cite the memory ids (the [#id] prefixes) it came from in "memoryIds". Caps: <=${LIMITS.maxMutationsUpsert} upserts, <=${LIMITS.maxMutationsLink} links. Empty arrays are fine.

MEMORY SNIPPETS:
${transcript}

EXISTING GRAPH:
${existingGraph || '(empty)'}

Scope: ${subjectType === 'USER' ? `USER ${subjectId}` : 'GUILD-wide'}`;

    const response = await aiService.generateText(prompt, {
        temperature: 0.2,
        max_tokens: 1400
    });
    const mutations = extractMutations(parseJsonBlock(response));
    if (!mutations) {
        return { memoriesReviewed: memories.length, skipped: 'model proposed no mutations' };
    }

    const applied = await knowledgeGraphService.applyMutations({
        guildId,
        scopeKey,
        subjectType,
        subjectId,
        source: 'consolidation',
        mutations,
        limits: LIMITS
    });

    let memoriesDistilled = 0;
    if (knowledgeGraphService.hasMutationWork(applied)) {
        const ids = memories.map(m => m.id);
        await memoryService.markDistilled(ids);
        memoriesDistilled = ids.length;
    }
    return { memoriesReviewed: memories.length, memoriesDistilled, ...applied };
}

/**
 * weave — relationship weaving: reviews the scope's existing nodes (least
 * connected first) and proposes typed edges, tags, merges, and
 * contradictions BETWEEN THEM. It never invents nodes: proposals whose
 * labels are not already in the reviewed inventory are dropped before the
 * legalizer runs (kg.link would otherwise create stub endpoints).
 */
async function runWeavePass(ctx) {
    const { guildId, scopeKey, subjectType, subjectId } = ctx;

    if (subjectType) {
        // Pull any not-yet-mirrored legacy facts into the graph first so the
        // weave sees every fact as a node it can connect.
        await knowledgeGraphService.syncLegacyFacts({ guildId, subjectType, subjectId });
    }

    const nodes = await db.all(
        `SELECT n.id, n.type, n.label, n.content, n.salience,
                (SELECT COUNT(*) FROM kg_edges e
                 WHERE e.guildId = n.guildId AND e.scopeKey = n.scopeKey
                   AND (e.sourceId = n.id OR e.targetId = n.id)) AS degree
         FROM kg_nodes n
         WHERE n.guildId = @guildId AND n.scopeKey = @scopeKey
         ORDER BY degree ASC, (n.salience * n.confidence) DESC, n.updatedAt DESC
         LIMIT @max`,
        { guildId, scopeKey, max: LIMITS.maxNodesReviewed }
    );
    if (nodes.length < 2) {
        return { nodesReviewed: nodes.length, skipped: 'not enough notes to weave' };
    }

    const ids = new Set(nodes.map(n => n.id));
    const edges = (await knowledgeGraphService.edgesFor(guildId, nodes.map(n => n.id), scopeKey))
        .filter(e => ids.has(e.sourceId) && ids.has(e.targetId));

    const inventory = nodes
        .map(n => `- [${n.type}] "${n.label}"${n.content ? `: ${n.content}` : ''} (connections: ${n.degree})`)
        .join('\n');
    const existingEdges = edges.length > 0
        ? edges.map(e => `- "${e.sourceLabel}" --${e.relation}--> "${e.targetLabel}"`).join('\n')
        : '(none)';

    const prompt = `You are enriching a knowledge graph by finding the semantic relationships hidden between existing notes. Review the note inventory and propose typed edges connecting related notes, tags that cluster them, merges for duplicates, and contradictions.

Rules:
- Use ONLY labels from the inventory below, exactly as written. Never invent new notes.
- Do not repeat existing edges.
- Prefer specific relations (caused_by, part_of, works_with, prefers, before) over generic relates_to.
- relationKind must be one of: causal, logical, associative, temporal, social.

Respond with ONLY JSON:
{
  "link": [{ "source": "label", "target": "label", "relation": "verb_phrase", "relationKind": "associative", "weight": 0.8 }],
  "tag": [{ "label": "label", "tags": ["topic"] }],
  "merge": [{ "keep": "label-a", "drop": "label-b" }],
  "contradict": [{ "source": "claim-a", "target": "claim-b" }]
}

Caps: <=${LIMITS.maxMutationsLink} links, <=${LIMITS.maxMutationsMerge} merges. Empty arrays are fine.

NOTE INVENTORY:
${inventory}

EXISTING EDGES (do not repeat):
${existingEdges}`;

    const response = await aiService.generateText(prompt, {
        temperature: 0.2,
        max_tokens: 1200
    });
    const parsed = parseJsonBlock(response);
    if (!parsed) {
        return { nodesReviewed: nodes.length, skipped: 'model returned no proposals' };
    }

    const known = new Set(nodes.map(n => String(n.label).trim().toLowerCase()));
    const knows = label => known.has(String(label || '').trim().toLowerCase());
    const mutations = {
        link: (Array.isArray(parsed.link) ? parsed.link : [])
            .filter(e => e && knows(e.source) && knows(e.target)),
        tag: (Array.isArray(parsed.tag) ? parsed.tag : [])
            .filter(t => t && knows(t.label)),
        merge: (Array.isArray(parsed.merge) ? parsed.merge : [])
            .filter(m => m && knows(m.keep) && knows(m.drop)),
        contradict: (Array.isArray(parsed.contradict) ? parsed.contradict : [])
            .filter(c => c && knows(c.source) && knows(c.target))
    };
    if (!knowledgeGraphService.hasMutationPayload(mutations)) {
        return { nodesReviewed: nodes.length, skipped: 'no usable proposals' };
    }

    const applied = await knowledgeGraphService.applyMutations({
        guildId,
        scopeKey,
        subjectType,
        subjectId,
        source: 'consolidation',
        mutations,
        limits: LIMITS
    });
    return { nodesReviewed: nodes.length, ...applied };
}

/**
 * attend — the reflection pass that does not modify knowledge.
 *
 * The other passes ask "what can be distilled, woven, or tidied?". This one
 * asks a different question: **what latent open loops are sitting in what this
 * person said?** A dropped "I'll finish that this weekend", a "we're waiting to
 * hear whether CI passed", a "I still haven't figured out why..." — each is a
 * loop the person is carrying, and none of them is knowledge.
 *
 * Crucially it does not turn every hint into a task. Mined items land in the
 * ledger's uncertain `candidate` state with capped confidence and provenance
 * back to the memories they came from; they only become something Goobster
 * will act on after independent corroboration. Guessing is allowed here
 * precisely because guessing is cheap when the guess cannot interrupt anyone.
 */
async function runAttendPass(ctx) {
    const { guildId, scopeKey, subjectType, subjectId } = ctx;
    // Attention is per-person: a guild-wide scope has no one to attend to.
    if (subjectType !== 'USER' || !subjectId) {
        return { skipped: 'attend only runs on a personal scope' };
    }

    const attentionLedgerService = require('./attentionLedgerService');
    const attentionPolicyService = require('./attentionPolicyService');
    const attentionConfig = require('../config/attentionConfig');

    // Enrollment is the opt-in for the whole attention system, mining
    // included: nobody gets a ledger because a reflection ran.
    const policy = await attentionPolicyService.get(subjectId);
    if (!policy?.enabled) {
        return { skipped: 'the user has not enabled proactive attention' };
    }

    const ATTEND = attentionConfig.ATTEND;
    const params = { guildId, max: ATTEND.maxMemoriesReviewed };
    let authorClause = '';
    if (!isDmScopeId(guildId)) {
        authorClause = 'AND authorId = @authorId';
        params.authorId = subjectId;
    }
    const memories = await db.all(
        `SELECT id, content, createdAt FROM memory_embeddings
         WHERE guildId = @guildId ${authorClause}
         ORDER BY id DESC LIMIT @max`,
        params
    );
    if (memories.length === 0) {
        return { memoriesReviewed: 0, skipped: 'nothing recent to attend to' };
    }

    const existing = await attentionLedgerService.listItems({
        userId: subjectId,
        guildId,
        states: attentionConfig.LIVE_STATES,
        limit: ATTEND.maxItemsShown
    });
    const inventory = existing.length > 0
        ? existing.map(item =>
            `- [${item.kind}] "${item.subject}" (${item.state}, confidence ${item.confidence.toFixed(2)})${item.goal ? `: ${item.goal}` : ''}`
        ).join('\n')
        : '(none yet)';

    const transcript = memories
        .reverse()
        .map(m => `[#${m.id}] [${m.createdAt}] ${m.content}`)
        .join('\n');

    const prompt = `You are reading one person's recent messages looking for OPEN LOOPS - things they are carrying that are not finished. Not facts about them, not knowledge: unfinished business.

The kinds of loop worth recording:
- commitment: they said they would do something ("I'll finish that this weekend")
- deadline: something has a date attached ("Thursday's presentation")
- waiting_for: they are blocked on someone or something else ("waiting to hear whether CI passed")
- open_question: something unresolved they keep returning to ("I still haven't figured out why...")
- goal: a larger thing the smaller things serve
- concern: something bothering them that has not been dealt with
- opportunity: something available to them that they have not taken up

Rules:
- These are GUESSES. Set confidence honestly: <=0.4 for one offhand remark, up to ${ATTEND.maxMinedConfidence} only when they said it plainly and more than once.
- Cite the memory ids you inferred each loop from in "provenance". A loop with no evidence is not a loop.
- Reuse an existing subject EXACTLY when a loop is already tracked, so it gets corroborated instead of duplicated.
- Resolve loops the recent messages show are finished or dropped ("state": "resolved" or "abandoned").
- Skip anything already resolved, purely hypothetical, or trivially small. An empty answer is a good answer.
- "deadline" must be an absolute UTC datetime you can actually justify from the text, or omitted entirely.

Respond with ONLY JSON:
{
  "upsert": [{ "kind": "commitment", "subject": "short stable handle", "goal": "what they are trying to reach", "unresolved": ["specific next step"], "importance": 0.7, "confidence": 0.5, "category": "general|research|observatory|knowledge|schedule|github", "deadline": "YYYY-MM-DD HH:MM:SS", "provenance": [{ "kind": "memory", "id": 123 }] }],
  "resolve": [{ "kind": "commitment", "subject": "existing subject", "state": "resolved" }],
  "touch": [{ "kind": "goal", "subject": "existing subject" }]
}

Caps: <=${ATTEND.maxUpserts} upserts, <=${ATTEND.maxResolves} resolves.

ALREADY TRACKED (reuse these subjects verbatim where they apply):
${inventory}

RECENT MESSAGES:
${transcript}`;

    const response = await aiService.generateText(prompt, {
        temperature: 0.2,
        max_tokens: 1200,
        usageContext: { guildId, userId: subjectId }
    });
    const parsed = parseJsonBlock(response);
    const mutations = parsed?.mutations && typeof parsed.mutations === 'object' ? parsed.mutations : parsed;
    if (!attentionLedgerService.AttentionLedgerService.hasPayload(mutations)) {
        return { memoriesReviewed: memories.length, skipped: 'no open loops proposed' };
    }

    const applied = await attentionLedgerService.applyMutations({
        guildId,
        userId: subjectId,
        source: 'reflection',
        mutations,
        limits: ATTEND
    });
    return { memoriesReviewed: memories.length, itemsTracked: existing.length, ...applied };
}

/** tidy — deterministic cleanup: caps, orphan pruning. No model call. */
async function runTidyPass(ctx) {
    const { guildId, scopeKey } = ctx;
    const before = await knowledgeGraphService.getStats(guildId, scopeKey);
    await knowledgeGraphService.pruneScope(guildId, scopeKey);
    const after = await knowledgeGraphService.getStats(guildId, scopeKey);
    return {
        nodesPruned: Math.max(0, before.nodes - after.nodes),
        edgesPruned: Math.max(0, before.edges - after.edges),
        nodes: after.nodes,
        edges: after.edges
    };
}

/* ------------------------------------------------------------------------ */
/* Service                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Reflection: a generalized knowledge-enrichment framework over the user
 * knowledge graph. A run executes an ordered list of registered passes
 * against one graph scope; every pass proposes mutations that flow through
 * the deterministic legalizer (the model proposes, code decides). Runs are
 * recorded in kg_reflection_runs so the web app can poll progress across
 * processes and restarts.
 *
 * Two ways in:
 *  - Manual: the Library "Reflect" button (webDashboardService.startReflection).
 *  - Scheduled: start() ticks in the bot process under a singleton lock and
 *    reflects on under-connected scopes automatically.
 *
 * Spec: documentation/user_knowledge_graph.md
 */
class KnowledgeReflectionService {
    constructor() {
        this.timer = null;
        this.firstTick = null;
        this._passes = new Map();

        this.registerPass('distill', {
            description: 'Distill undistilled raw memories into graph nodes and edges',
            run: runDistillPass
        });
        this.registerPass('weave', {
            description: 'Propose semantic relationships between existing notes',
            run: runWeavePass
        });
        this.registerPass('attend', {
            description: 'Mine latent open loops into the attention ledger',
            run: runAttendPass
        });
        this.registerPass('tidy', {
            description: 'Deterministic cap and orphan pruning',
            run: runTidyPass
        });
    }

    /** Default pass list for a manual button press. */
    get manualPasses() {
        return ['distill', 'weave', 'attend', 'tidy'];
    }

    /**
     * Scheduled runs skip distill: the nightly consolidation already covers
     * fresh memories, so the routine focuses on connecting what exists.
     * `attend` is included because open loops go stale on their own schedule,
     * and it no-ops cheaply on scopes with no enrolled owner.
     */
    get scheduledPasses() {
        return ['weave', 'attend', 'tidy'];
    }

    /**
     * Register (or replace) a named pass. This is the generalization seam:
     * future routines (e.g. a salience-decay pass or a summarize pass) plug
     * in here and are immediately runnable manually or on the schedule.
     * @param {string} name
     * @param {{ description: string, run: (ctx: Object) => Promise<Object> }} pass
     */
    registerPass(name, pass) {
        if (!/^[a-z][a-z0-9_-]*$/.test(String(name)) || typeof pass?.run !== 'function') {
            throw new Error(`Invalid reflection pass: ${name}`);
        }
        this._passes.set(name, { description: pass.description || '', run: pass.run });
    }

    listPasses() {
        return [...this._passes.entries()].map(([name, pass]) => ({
            name,
            description: pass.description
        }));
    }

    /* ---------------- scheduling (the regular routine) ---------------- */

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.runDueScopes().catch(err =>
            console.error('[Reflection] Scheduled tick failed:', err.message)
        ), REFLECTION.tickMs);
        this.firstTick = setTimeout(() => this.runDueScopes().catch(err =>
            console.error('[Reflection] Initial tick failed:', err.message)
        ), REFLECTION.firstTickDelayMs);
        console.log('[Reflection] Scheduled (12h, weave under-connected scopes)');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.firstTick) {
            clearTimeout(this.firstTick);
            this.firstTick = null;
        }
    }

    /**
     * One scheduled tick: find under-connected scopes that have not been
     * reflected on recently and weave them, bounded per tick.
     * @returns {Promise<{ scopesReflected: number }>}
     */
    async runDueScopes() {
        const outcome = await db.withSingletonLock('knowledge_reflection', async () => {
            await this._failStaleRuns();
            const due = await this.findDueScopes();
            let reflected = 0;
            for (const scope of due.slice(0, REFLECTION.maxScopesPerTick)) {
                try {
                    await this.runScope({
                        guildId: scope.guildId,
                        scopeKey: scope.scopeKey,
                        ...subjectFromScopeKey(scope.scopeKey),
                        passes: this.scheduledPasses,
                        trigger: 'scheduled'
                    });
                    reflected++;
                } catch (error) {
                    if (error?.code === 'REFLECTION_BUSY') continue;
                    console.error(
                        `[Reflection] Scope ${scope.guildId}/${scope.scopeKey} failed:`,
                        error.message
                    );
                }
            }
            if (reflected > 0) {
                console.log(`[Reflection] Scheduled tick reflected on ${reflected} scope(s)`);
            }
            return { scopesReflected: reflected };
        });
        if (!outcome.acquired) return { scopesReflected: 0, skipped: true };
        return outcome.result;
    }

    /**
     * Scopes worth a scheduled weave: enough nodes to connect, fewer edges
     * than the deficit ratio allows, and no run inside the cooldown window.
     */
    async findDueScopes() {
        return await db.all(
            `SELECT n.guildId, n.scopeKey, COUNT(*) AS nodes,
                    (SELECT COUNT(*) FROM kg_edges e
                     WHERE e.guildId = n.guildId AND e.scopeKey = n.scopeKey) AS edges
             FROM kg_nodes n
             WHERE n.scopeKey NOT LIKE 'PARLOR:%'
             GROUP BY n.guildId, n.scopeKey
             HAVING COUNT(*) >= @minNodes
                AND (SELECT COUNT(*) FROM kg_edges e
                     WHERE e.guildId = n.guildId AND e.scopeKey = n.scopeKey)
                    < COUNT(*) * CAST(@deficitRatio AS REAL)
                AND NOT EXISTS (
                    SELECT 1 FROM kg_reflection_runs r
                    WHERE r.guildId = n.guildId AND r.scopeKey = n.scopeKey
                      AND r.startedAt >= @cooldownCutoff
                )
             ORDER BY (SELECT COUNT(*) FROM kg_edges e
                       WHERE e.guildId = n.guildId AND e.scopeKey = n.scopeKey) * 1.0 / COUNT(*) ASC`,
            {
                minNodes: REFLECTION.minNodesForScheduledWeave,
                deficitRatio: REFLECTION.weaveEdgeDeficitRatio,
                cooldownCutoff: new Date(Date.now() - REFLECTION.scopeCooldownHours * 60 * 60 * 1000)
            }
        );
    }

    /* ---------------- run lifecycle ---------------- */

    /**
     * Create a run row and kick off execution. The returned promise for the
     * run resolves immediately (for fire-and-return API handlers); await
     * `execution` to wait for the passes to finish.
     * @param {Object} params
     * @param {string} params.guildId - conversation scope (guild id or dm:<userId>)
     * @param {string} params.scopeKey - '', 'GUILD', or 'USER:<id>'
     * @param {string[]} [params.passes]
     * @param {string} [params.trigger] - 'manual' | 'scheduled'
     * @param {string} [params.requestedBy]
     * @returns {Promise<{ run: Object, execution: Promise<Object> }>}
     * @throws {ReflectionError} REFLECTION_BUSY when a live run holds the scope
     */
    async startRun({
        guildId,
        scopeKey = '',
        subjectType = null,
        subjectId = null,
        passes = null,
        trigger = 'manual',
        requestedBy = null
    } = {}) {
        if (!guildId) throw new ReflectionError('BAD_SCOPE', 'A scope is required.');
        const passNames = Array.isArray(passes) && passes.length > 0
            ? passes
            : this.manualPasses;
        for (const name of passNames) {
            if (!this._passes.has(name)) {
                throw new ReflectionError('BAD_PASS', `Unknown reflection pass: ${name}`);
            }
        }

        const runId = await db.transaction(async (tx) => {
            await this._failStaleRuns(tx, guildId, scopeKey);
            const live = await tx.get(
                `SELECT id FROM kg_reflection_runs
                 WHERE guildId = @guildId AND scopeKey = @scopeKey AND status = 'running'`,
                { guildId, scopeKey }
            );
            if (live) {
                throw new ReflectionError('REFLECTION_BUSY',
                    'A reflection is already running for this scope - give it a moment.');
            }
            return await tx.insert(
                `INSERT INTO kg_reflection_runs (guildId, scopeKey, runTrigger, requestedBy, passes)
                 VALUES (@guildId, @scopeKey, @trigger, @requestedBy, @passes)`,
                {
                    guildId,
                    scopeKey,
                    trigger: trigger === 'scheduled' ? 'scheduled' : 'manual',
                    requestedBy,
                    passes: JSON.stringify(passNames)
                }
            );
        });

        const run = await this.getRun(runId);
        const execution = this._execute(runId, {
            guildId,
            scopeKey,
            subjectType,
            subjectId,
            passes: passNames
        });
        return { run, execution };
    }

    /** Create a run and wait for it to finish (scheduler + tests). */
    async runScope(params) {
        const { execution } = await this.startRun(params);
        return await execution;
    }

    async _execute(runId, ctx) {
        const summary = {};
        try {
            for (const name of ctx.passes) {
                summary[name] = await this._passes.get(name).run(ctx) || {};
            }
            await db.run(
                `UPDATE kg_reflection_runs
                 SET status = 'completed', summary = @summary, finishedAt = CURRENT_TIMESTAMP
                 WHERE id = @runId`,
                { runId, summary: JSON.stringify(summary) }
            );
            this._publishCompleted(runId, ctx, summary);
        } catch (error) {
            console.error(`[Reflection] Run ${runId} failed:`, error.message);
            await db.run(
                `UPDATE kg_reflection_runs
                 SET status = 'failed', summary = @summary, error = @error,
                     finishedAt = CURRENT_TIMESTAMP
                 WHERE id = @runId`,
                {
                    runId,
                    summary: JSON.stringify(summary),
                    error: String(error.message || error).slice(0, 500)
                }
            );
        }
        return await this.getRun(runId);
    }

    /**
     * Announce a finished run on the domain bus so watches and the attention
     * sweep can react to what it produced. Fire-and-forget.
     */
    _publishCompleted(runId, ctx, summary) {
        try {
            const domainEventBus = require('./domainEventBus');
            domainEventBus.publish(domainEventBus.TOPICS.REFLECTION_COMPLETED, {
                userId: ctx.subjectType === 'USER' ? ctx.subjectId : null,
                runId,
                guildId: ctx.guildId,
                scopeKey: ctx.scopeKey,
                passes: ctx.passes,
                contradictions: Object.values(summary || {})
                    .reduce((total, pass) => total + (Number(pass?.contradictions) || 0), 0)
            });
        } catch { /* reflection never depends on the bus */ }
    }

    /** Mark dead 'running' rows (crashed process) as failed. */
    async _failStaleRuns(handle = db, guildId = null, scopeKey = null) {
        let sql = `UPDATE kg_reflection_runs
                   SET status = 'failed', error = 'interrupted (process restart)',
                       finishedAt = CURRENT_TIMESTAMP
                   WHERE status = 'running' AND startedAt < @staleCutoff`;
        const params = {
            staleCutoff: new Date(Date.now() - REFLECTION.staleRunMinutes * 60 * 1000)
        };
        if (guildId !== null) {
            sql += ' AND guildId = @guildId AND scopeKey = @scopeKey';
            params.guildId = guildId;
            params.scopeKey = scopeKey;
        }
        await handle.run(sql, params);
    }

    async getRun(runId) {
        const row = await db.get(
            'SELECT * FROM kg_reflection_runs WHERE id = @runId',
            { runId: Number(runId) }
        );
        return row ? this._present(row) : null;
    }

    /** The most recent run for a scope (for button state + "last reflected"). */
    async getLatestRun(guildId, scopeKey) {
        await this._failStaleRuns(db, guildId, scopeKey);
        const row = await db.get(
            `SELECT * FROM kg_reflection_runs
             WHERE guildId = @guildId AND scopeKey = @scopeKey
             ORDER BY id DESC LIMIT 1`,
            { guildId, scopeKey }
        );
        return row ? this._present(row) : null;
    }

    _present(row) {
        let passes = [];
        let summary = null;
        try { passes = JSON.parse(row.passes) || []; } catch { /* keep [] */ }
        try { summary = row.summary ? JSON.parse(row.summary) : null; } catch { /* keep null */ }
        return {
            id: row.id,
            trigger: row.runTrigger,
            status: row.status,
            passes,
            summary,
            error: row.error || null,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt || null
        };
    }
}

module.exports = new KnowledgeReflectionService();
module.exports.ReflectionError = ReflectionError;
