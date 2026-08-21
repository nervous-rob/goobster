/**
 * The attention service: the part of Goobster that decides whether something
 * that changed is worth your attention.
 *
 * The shape of the pipeline matters more than any individual rule:
 *
 *   durable state ──▶ deterministic candidates ──▶ scoring ──▶ model triage
 *                                                      │
 *                                            initiative policy + budget
 *                                                      │
 *                          discard / inbox / mention / DM / urgent
 *
 * **Candidates are generated deterministically, never by asking a model what
 * might matter.** Handing a memory dump to an LLM every N minutes and asking
 * "anything Rob needs?" produces unpredictable nagging, large token bills,
 * and hallucinated relevance. Instead, known state produces a bounded
 * candidate list (a deadline inside the horizon, a job that changed status, a
 * loop that stopped moving, a contradiction that appeared), and the model is
 * only asked the narrow question it is actually good at: *given these few
 * candidates, which — if any — is worth interrupting for, and how would you
 * say it in one breath?*
 *
 * Because candidates are re-derived from state on every sweep, the pipeline is
 * idempotent through `attention_notices.dedupeKey` rather than through
 * remembering events. A missed domain event only delays a notice; it never
 * loses one.
 *
 * The ability to decide *not* to say something is part of the feature, so
 * every stage can quietly reduce loudness: the score bands, the per-category
 * calibration learned from dismissals, the initiative ceiling, the contact
 * budget, and quiet hours.
 *
 * Spec: documentation/attention.md
 */

const db = require('../db');
const aiService = require('./aiService');
const attentionLedgerService = require('./attentionLedgerService');
const attentionPolicyService = require('./attentionPolicyService');
const domainEventBus = require('./domainEventBus');
const config = require('../config/attentionConfig');
const score = require('../utils/attentionScore');
const { dmScopeId } = require('../utils/dmScope');
const logger = require('../utils/logger');

const { CANDIDATES, HEARTBEAT, MAX_TITLE_LENGTH, MAX_DETAIL_LENGTH } = config;

/** Statuses a notice can still be reacted to in. */
const OPEN_STATUSES = ['surfaced', 'delivered', 'opened', 'snoozed'];

/** Feedback signals a user (or the system) can record against a notice. */
const FEEDBACK_SIGNALS = ['surfaced', 'opened', 'dismissed', 'acted_on', 'snoozed', 'useful', 'annoying'];

function toUtcText(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** Stored UTC text -> epoch ms (the tables have no timezone suffix). */
function utcMs(text) {
    if (!text) return null;
    const ms = new Date(`${String(text).replace(' ', 'T')}Z`).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/** ISO-ish year+week bucket, so a recurring nudge can re-raise later. */
function weekBucket(date = new Date()) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 1);
    const week = Math.floor((date.getTime() - start) / (7 * 86_400_000));
    return `${date.getUTCFullYear()}W${String(week).padStart(2, '0')}`;
}

function clip(text, max) {
    const value = String(text ?? '').trim();
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function parseJsonBlock(response) {
    const match = String(response || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------------ */
/* Candidate generators                                                      */
/*                                                                           */
/* Each one is a pure-ish read over durable state that answers "has          */
/* something changed here that a person might care about?". None of them      */
/* calls a model, and none of them decides anything: they only propose.      */
/* ------------------------------------------------------------------------ */

/** A deadline is coming up on a loop Goobster is tracking. */
async function generateDeadlines(ctx) {
    const out = [];
    const horizon = CANDIDATES.deadlineHorizonHours * 3600_000;
    for (const item of ctx.items) {
        if (!item.deadlineAt) continue;
        const due = utcMs(item.deadlineAt);
        if (due === null) continue;
        const remaining = due - ctx.now;
        if (remaining > horizon) continue;

        let urgency = score.deadlineUrgency(remaining);
        // Somebody actively working on a thing does not need reminding that
        // it is due. Deciding not to speak is as much the job as speaking.
        const lastActivity = utcMs(item.lastActivityAt);
        const recentlyTouched = lastActivity !== null && ctx.now - lastActivity < 24 * 3600_000;
        if (recentlyTouched) urgency *= 0.45;

        const hours = Math.round(remaining / 3600_000);
        out.push({
            key: `deadline:item:${item.id}:${String(item.deadlineAt).slice(0, 10)}`,
            itemId: item.id,
            category: item.category,
            title: `${item.subject} is due ${remaining < 0 ? `${Math.abs(hours)}h ago` : `in ${hours}h`}`,
            detail: [
                item.goal,
                item.unresolved.length > 0 ? `Still open: ${item.unresolved.join('; ')}` : null,
                recentlyTouched ? 'They worked on this within the last day.' : null
            ].filter(Boolean).join(' '),
            urgency,
            importance: item.importance,
            confidence: item.confidence,
            actionability: item.unresolved.length > 0 ? 0.9 : 0.6
        });
    }
    return out;
}

/** A loop that should have moved and hasn't. */
async function generateStaleLoops(ctx) {
    const out = [];
    const bucket = weekBucket(new Date(ctx.now));
    for (const item of ctx.items) {
        if (item.kind === 'waiting_for') continue; // waiting is not stalling
        const lastActivity = utcMs(item.lastActivityAt) ?? utcMs(item.createdAt);
        if (lastActivity === null) continue;
        const daysIdle = (ctx.now - lastActivity) / 86_400_000;
        const urgency = score.stalenessUrgency(daysIdle);
        if (urgency <= 0) continue;
        out.push({
            key: `stale:item:${item.id}:${bucket}`,
            itemId: item.id,
            category: item.category,
            title: `${item.subject} hasn't moved in ${Math.floor(daysIdle)} days`,
            detail: [
                item.goal,
                item.unresolved.length > 0 ? `Still open: ${item.unresolved.join('; ')}` : null
            ].filter(Boolean).join(' '),
            urgency,
            importance: item.importance,
            confidence: item.confidence,
            // A stalled loop is only actionable if there is a next step.
            actionability: item.unresolved.length > 0 ? 0.75 : 0.5
        });
    }
    return out;
}

/** Something the person is waiting on has been silent too long. */
async function generateWaitingFor(ctx) {
    const out = [];
    const bucket = weekBucket(new Date(ctx.now));
    for (const item of ctx.items) {
        if (item.kind !== 'waiting_for') continue;
        const since = utcMs(item.lastActivityAt) ?? utcMs(item.createdAt);
        if (since === null) continue;
        const days = (ctx.now - since) / 86_400_000;
        if (days < CANDIDATES.waitingForDays) continue;
        out.push({
            key: `waiting:item:${item.id}:${bucket}`,
            itemId: item.id,
            category: item.category,
            title: `Still waiting on ${item.subject} (${Math.floor(days)} days)`,
            detail: item.goal || null,
            urgency: score.clamp01(days / (CANDIDATES.waitingForDays * 3)),
            importance: item.importance,
            confidence: item.confidence,
            actionability: 0.7
        });
    }
    return out;
}

/**
 * An Observatory job reached a terminal state.
 *
 * Deliberately narrow: observatoryService already sends a "your job finished"
 * follow-up, so a plain COMPLETED job is not news worth a second ping. What is
 * worth surfacing is a run that went *wrong* (the follow-up says it stopped,
 * not that it stopped badly), or a run attached to a loop Goobster is
 * tracking — where the interesting part is the result, not the completion.
 */
async function generateObservatoryJobs(ctx) {
    const cutoff = toUtcText(new Date(ctx.now - CANDIDATES.jobLookbackHours * 3600_000));
    const rows = await db.all(
        `SELECT j.id, j.status, j.error, j.segments, j.resumeCount, j.finishedAt,
                j.stderrTail, p.name AS projectName, p.slug AS projectSlug
         FROM observatory_jobs j
         JOIN observatory_projects p ON p.id = j.projectId
         WHERE j.userId = @userId AND j.status <> 'RUNNING'
           AND j.finishedAt IS NOT NULL AND j.finishedAt >= @cutoff
         ORDER BY j.finishedAt DESC
         LIMIT 20`,
        { userId: ctx.userId, cutoff }
    );

    const trackedByProject = new Map();
    for (const item of ctx.items) {
        const slug = item.metadata?.observatoryProject;
        if (slug) trackedByProject.set(String(slug), item);
    }

    const out = [];
    for (const row of rows) {
        const tracked = trackedByProject.get(row.projectSlug) || null;
        const wentWrong = row.status !== 'COMPLETED' && row.status !== 'CANCELLED';
        if (!wentWrong && !tracked) continue;

        const importance = wentWrong ? 0.8 : (tracked?.importance ?? 0.6);
        out.push({
            key: `observatory.job:${row.id}:${row.status}`,
            itemId: tracked?.id ?? null,
            category: 'observatory',
            title: wentWrong
                ? `${row.projectName}: run ${row.status.toLowerCase().replace('_', ' ')}`
                : `${row.projectName}: run finished`,
            detail: clip([
                row.error,
                row.resumeCount > 0 ? `Resumed ${row.resumeCount}x across ${row.segments} segments.` : null,
                tracked ? `Tracked loop: ${tracked.subject}${tracked.goal ? ` — ${tracked.goal}` : ''}` : null,
                row.stderrTail ? `stderr tail: ${clip(row.stderrTail, 300)}` : null
            ].filter(Boolean).join(' '), MAX_DETAIL_LENGTH),
            urgency: wentWrong ? 0.85 : 0.7,
            importance,
            // A job status is a fact, not an inference.
            confidence: 0.95,
            actionability: 0.85
        });
    }
    return out;
}

/**
 * A Spitball Expedition reached a terminal state worth attention. The
 * deliberate filter (spec: documentation/spitball_expeditions.md §34): a
 * failure is always news, but a completion is surfaced only when it carries
 * something genuinely valuable - source-backed conflicts or a high-value
 * frontier Lead - never merely "job done". Reads durable expedition rows;
 * research.* events only accelerate the sweep that runs this.
 */
async function generateResearchOutcomes(ctx) {
    const cutoff = toUtcText(new Date(ctx.now - CANDIDATES.researchLookbackHours * 3600_000));
    const rows = await db.all(
        `SELECT id, seed, status, stopReason, lastError, currentCycle,
                notesCreated, edgesCreated, finishedAt
         FROM spitball_expeditions
         WHERE userId = @userId AND status IN ('COMPLETED', 'FAILED')
           AND finishedAt IS NOT NULL AND finishedAt >= @cutoff
         ORDER BY finishedAt DESC LIMIT 10`,
        { userId: ctx.userId, cutoff }
    );

    const out = [];
    for (const row of rows) {
        if (row.status === 'FAILED') {
            out.push({
                key: `research.expedition:${row.id}:FAILED`,
                itemId: null,
                category: 'research',
                title: `Research stalled: ${clip(row.seed, 80)}`,
                detail: clip(row.lastError || 'The expedition failed before finishing.', MAX_DETAIL_LENGTH),
                urgency: 0.6,
                importance: 0.7,
                // A recorded failure is a fact.
                confidence: 0.95,
                // The person decides whether to retry, retarget, or drop it.
                actionability: 0.8
            });
            continue;
        }

        const last = await db.get(
            `SELECT frontierOutputJson, coverageSummaryJson,
                    (SELECT SUM(conflictsFound) FROM spitball_expedition_cycles
                     WHERE expeditionId = @id AND status = 'COMPLETED') AS conflicts
             FROM spitball_expedition_cycles
             WHERE expeditionId = @id AND status = 'COMPLETED'
             ORDER BY cycleNumber DESC LIMIT 1`,
            { id: row.id }
        );
        let leads = [];
        try {
            leads = JSON.parse(last?.frontierOutputJson || '[]') || [];
        } catch { /* malformed stored leads read as none */ }
        const conflicts = Number(last?.conflicts) || 0;
        const topLead = leads
            .filter(lead => Number.isFinite(Number(lead?.expectedValue)))
            .sort((a, b) => Number(b.expectedValue) - Number(a.expectedValue))[0] || null;
        const highLead = topLead && Number(topLead.expectedValue) >= CANDIDATES.researchLeadFloor
            ? topLead
            : null;
        // "Job done" alone is not worth anyone's attention.
        if (conflicts === 0 && !highLead) continue;

        out.push({
            key: `research.expedition:${row.id}:COMPLETED`,
            itemId: null,
            category: 'research',
            title: conflicts > 0
                ? `Research found conflicting evidence: ${clip(row.seed, 60)}`
                : `Research opened a strong lead: ${clip(row.seed, 60)}`,
            detail: clip([
                `${row.notesCreated} notes and ${row.edgesCreated} connections added over ${row.currentCycle} cycle${row.currentCycle === 1 ? '' : 's'}.`,
                conflicts > 0 ? `${conflicts} source-backed conflict${conflicts === 1 ? '' : 's'} preserved in the graph.` : null,
                highLead ? `Top lead: ${highLead.topic}${highLead.reason ? ` — ${highLead.reason}` : ''}` : null
            ].filter(Boolean).join(' '), MAX_DETAIL_LENGTH),
            urgency: conflicts > 0 ? 0.6 : 0.5,
            importance: conflicts > 0
                ? 0.75
                : score.clamp01(Number(highLead?.expectedValue) || 0.6),
            // Counts and stored leads are facts; the value judgement is softer.
            confidence: 0.85,
            actionability: 0.75
        });
    }
    return out;
}

/** Two things Goobster believes now contradict each other. */
async function generateContradictions(ctx) {
    const cutoff = toUtcText(new Date(ctx.now - CANDIDATES.contradictionLookbackHours * 3600_000));
    const rows = await db.all(
        `SELECT e.id, e.weight, e.createdAt, s.label AS sourceLabel, t.label AS targetLabel
         FROM kg_edges e
         JOIN kg_nodes s ON s.id = e.sourceId
         JOIN kg_nodes t ON t.id = e.targetId
         WHERE e.scopeKey = @scopeKey AND e.relation = 'contradicts'
           AND e.createdAt >= @cutoff
         ORDER BY e.id DESC LIMIT 10`,
        { scopeKey: `USER:${ctx.userId}`, cutoff }
    );
    return rows.map(row => ({
        key: `knowledge.contradiction:${row.id}`,
        itemId: null,
        category: 'knowledge',
        title: 'Two things I believe about you disagree',
        detail: clip(`"${row.sourceLabel}" contradicts "${row.targetLabel}".`, MAX_DETAIL_LENGTH),
        urgency: 0.5,
        importance: 0.65,
        // The edge's own weight is Goobster's confidence in the clash.
        confidence: score.clamp01(row.weight),
        // Resolving a contradiction needs the person; asking is the action.
        actionability: 0.8
    }));
}

/**
 * A mined loop that is still a guess. These are the quiet bottom of the
 * inbox: "you mentioned revisiting X" — never a ping, always dismissible.
 */
async function generateUnconfirmedLoops(ctx) {
    const out = [];
    for (const item of ctx.candidates) {
        if (item.confidence < 0.5) continue;
        const age = ctx.now - (utcMs(item.createdAt) ?? ctx.now);
        if (age < 3600_000) continue; // let it settle; it may corroborate itself
        out.push({
            key: `confirm:item:${item.id}`,
            itemId: item.id,
            category: item.category,
            title: `Did I get this right: ${item.subject}?`,
            detail: item.goal || 'I picked this up from something you said and I am not sure it is real.',
            urgency: 0.45,
            importance: item.importance,
            confidence: item.confidence,
            actionability: 0.8
        });
    }
    return out;
}

class AttentionService {
    constructor() {
        this._generators = new Map();
        this.registerGenerator('deadline', {
            description: 'A tracked deadline is inside the horizon',
            run: generateDeadlines
        });
        this.registerGenerator('stale_loop', {
            description: 'A tracked loop stopped moving',
            run: generateStaleLoops
        });
        this.registerGenerator('waiting_for', {
            description: 'Something being waited on has gone quiet',
            run: generateWaitingFor
        });
        this.registerGenerator('observatory_job', {
            description: 'An Observatory job reached a terminal state',
            run: generateObservatoryJobs
        });
        this.registerGenerator('research_outcome', {
            description: 'A Spitball Expedition finished with something worth attention',
            run: generateResearchOutcomes
        });
        this.registerGenerator('contradiction', {
            description: 'The knowledge graph gained a contradiction',
            run: generateContradictions
        });
        this.registerGenerator('unconfirmed_loop', {
            description: 'A mined open loop is still unconfirmed',
            run: generateUnconfirmedLoops
        });
        AttentionService.instance = this;
    }

    /**
     * Register (or replace) a deterministic candidate generator. This is the
     * extension seam: a new sensory organ (calendar, email, CI) becomes
     * proactive by adding a generator here, not by teaching the model about it.
     * @param {string} name
     * @param {{ description: string, run: (ctx: Object) => Promise<Object[]> }} generator
     */
    registerGenerator(name, generator) {
        if (!/^[a-z][a-z0-9_]*$/.test(String(name)) || typeof generator?.run !== 'function') {
            throw new Error(`Invalid attention generator: ${name}`);
        }
        this._generators.set(name, {
            description: generator.description || '',
            run: generator.run
        });
    }

    listGenerators() {
        return [...this._generators.entries()].map(([name, gen]) => ({
            name,
            description: gen.description
        }));
    }

    /* ------------------------------------------------------------------ */
    /* The sweep                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Evaluate one person: generate candidates, score them, ask the model the
     * narrow triage question, and dispose of the survivors.
     *
     * @param {Object} params
     * @param {Object} params.policy - a row from attentionPolicyService
     * @param {Object} [params.gateway] - Discord gateway for outbound contact
     * @param {boolean} [params.deliver] - false to compute without contacting
     * @returns {Promise<{userId: string, considered: number, raised: number,
     *   contacted: boolean, notices: Object[]}>}
     */
    async sweepUser({ policy, gateway = null, deliver = true } = {}) {
        const userId = policy?.userId;
        const summary = { userId, considered: 0, raised: 0, contacted: false, notices: [] };
        if (!userId || !policy?.enabled) return summary;

        await attentionLedgerService.pruneUser(userId);
        await this.expireStaleNotices(userId);

        const ctx = await this._buildContext(userId, policy);
        const candidates = await this._generateCandidates(ctx);
        summary.considered = candidates.length;
        await this._markSwept(userId);
        if (candidates.length === 0) return summary;

        const pressure = await this._measurePressure(userId, policy, ctx.now);
        const cost = score.interruptionCost(pressure);
        // Categories repeat across candidates and calibration is a per-category
        // aggregate, so it is read once per category per sweep.
        const thresholdCache = new Map();
        const scored = [];
        for (const candidate of candidates) {
            const decided = await this._decide(candidate, { ctx, policy, cost, thresholdCache });
            if (decided) scored.push(decided);
        }
        if (scored.length === 0) return summary;

        // Loudest first, so triage and the contact budget both spend
        // themselves on what matters most. Anything past the triage cap is
        // simply left for a later sweep: once the stronger candidates have
        // been raised they dedupe out, and the weaker ones move up.
        scored.sort((a, b) => b.score - a.score);
        const shortlist = scored.slice(0, CANDIDATES.maxTriaged);
        const triage = await this._triage(shortlist, ctx);
        const final = this._applyTriage(shortlist, triage, policy);

        for (const candidate of final) {
            const notice = await this._raiseNotice(userId, candidate);
            if (notice) {
                summary.raised++;
                summary.notices.push(notice);
            }
        }

        const contactable = summary.notices.filter(
            notice => notice.disposition === 'dm' || notice.disposition === 'urgent'
        );
        if (deliver && contactable.length > 0 && !pressure.blocked) {
            const message = triage?.message || this._composeFallback(contactable);
            summary.contacted = await this._contact({
                userId, gateway, notices: contactable, message,
                urgent: contactable.some(notice => notice.disposition === 'urgent')
            });
        }
        return summary;
    }

    /** Everything a sweep reads once and passes to every generator. */
    async _buildContext(userId, policy) {
        const live = await attentionLedgerService.listItems({
            userId,
            states: config.LIVE_STATES,
            limit: 120
        });
        return {
            userId,
            policy,
            now: Date.now(),
            // Contactable items are the ones initiative may act on; candidate
            // items are only ever offered for confirmation.
            items: live.filter(item => config.CONTACTABLE_STATES.includes(item.state)),
            candidates: live.filter(item => item.state === 'candidate')
        };
    }

    async _generateCandidates(ctx) {
        const out = [];
        for (const [name, generator] of this._generators) {
            try {
                const produced = await generator.run(ctx);
                for (const candidate of (produced || []).slice(0, CANDIDATES.maxPerGenerator)) {
                    if (!candidate?.key || !candidate?.title) continue;
                    out.push({
                        source: name,
                        // null = a pure observation, which any enrolled person
                        // may receive (the disposition ceiling decides how
                        // loudly). Only candidates that would have Goobster
                        // *do* something name an action class.
                        requiredAction: null,
                        category: 'general',
                        ...candidate,
                        title: clip(candidate.title, MAX_TITLE_LENGTH),
                        detail: candidate.detail ? clip(candidate.detail, MAX_DETAIL_LENGTH) : null
                    });
                }
            } catch (error) {
                logger.warn?.(`[attention] generator ${name} failed: ${error.message}`);
            }
        }
        return out.slice(0, CANDIDATES.maxPerSweep);
    }

    /**
     * Score one candidate and work out how loudly it is allowed to land.
     * Returns null when it should be dropped without a trace.
     */
    async _decide(candidate, { ctx, policy, cost, thresholdCache = new Map() }) {
        // The agency boundary comes first. Two separate questions: may
        // Goobster bring this domain up proactively at all, and - for
        // candidates that propose doing something rather than merely saying
        // something - is that class of action permitted here?
        const boundary = attentionPolicyService.boundariesFor(policy, candidate.category);
        if (boundary.proactiveRead !== true) return null;
        if (candidate.requiredAction
            && attentionPolicyService.allows(policy, candidate.category, candidate.requiredAction) === false) {
            return null;
        }

        const scored = score.scoreCandidate(candidate, cost);
        if (!thresholdCache.has(candidate.category)) {
            thresholdCache.set(candidate.category, await this.thresholdsFor(ctx.userId, candidate.category));
        }
        const thresholds = thresholdCache.get(candidate.category);
        let disposition = score.dispositionFor(scored.score, thresholds);
        if (disposition === 'discard') {
            // Interruption pressure can silence Goobster, but it should not
            // make him forget. Something that would have been worth saying in
            // a quiet moment still goes in the inbox, which costs nothing.
            if (scored.value < thresholds.discard) return null;
            disposition = 'inbox';
        }

        // Both ceilings apply: the person's level and the item's own limit.
        disposition = score.clampDisposition(disposition, policy.initiative);
        if (candidate.itemId) {
            const item = ctx.items.find(row => row.id === candidate.itemId)
                || ctx.candidates.find(row => row.id === candidate.itemId);
            if (item?.allowedInitiative) {
                disposition = score.clampDisposition(disposition, item.allowedInitiative);
            }
            // An unconfirmed guess never gets to interrupt anyone.
            if (item?.state === 'candidate' && disposition !== 'inbox') disposition = 'inbox';
        }
        return { ...candidate, ...scored, disposition, thresholds };
    }

    /**
     * The one model call in the pipeline, and it is asked a narrow question:
     * of these few already-plausible candidates, which are worth interrupting
     * for, and how would you say them together in one breath?
     *
     * The model may only nudge scores within a bounded range and drop
     * candidates; it can never invent a candidate or raise one it was not
     * shown. A failed or unparseable call degrades to the deterministic
     * scores, so triage is an improvement, never a dependency.
     */
    async _triage(shortlist, ctx) {
        if (shortlist.length === 0) return null;
        const ledger = await attentionLedgerService.describeForPrompt({ userId: ctx.userId, limit: 6 });
        const lines = shortlist.map((candidate, index) =>
            `${index + 1}. [key: ${candidate.key}] (${candidate.category}, score ${candidate.score.toFixed(2)}, would ${candidate.disposition}) ${candidate.title}${candidate.detail ? ` — ${candidate.detail}` : ''}`
        ).join('\n');

        const prompt = `You are Goobster's attention filter. Some deterministic checks noticed the things below about one person. Your ONLY job is to judge which of them are actually worth bothering them about right now, and to phrase the ones that are.

Be conservative. Interrupting someone is expensive and being able to stay quiet is part of being useful. Drop anything redundant, obvious, already-handled, or too trivial to justify a notification.

${ledger ? `${ledger}\n` : ''}CANDIDATES:
${lines}

Respond with ONLY JSON:
{
  "keep": [{ "key": "<key exactly as given>", "adjust": -0.2, "reason": "<short, for the record>" }],
  "drop": ["<key>"],
  "message": "<one short message to the person covering ONLY the kept items, in your own voice. Mention what you deliberately left alone if that is the more useful thing to say. 1-3 sentences, no lists, no preamble.>"
}

"adjust" is a small nudge in [-0.2, 0.2] to the score - use it to sharpen ranking, not to override it. Dropping everything is a valid, often correct answer (then "message" should be an empty string).`;

        try {
            const response = await aiService.generateText(prompt, {
                temperature: 0.3,
                max_tokens: 400,
                usageContext: { guildId: dmScopeId(ctx.userId), userId: ctx.userId }
            });
            const parsed = parseJsonBlock(response);
            if (!parsed) return null;
            return {
                keep: Array.isArray(parsed.keep) ? parsed.keep : [],
                drop: Array.isArray(parsed.drop) ? parsed.drop.map(String) : [],
                message: typeof parsed.message === 'string' ? parsed.message.trim() : ''
            };
        } catch (error) {
            logger.warn?.(`[attention] triage call failed: ${error.message}`);
            return null;
        }
    }

    /**
     * Fold the model's judgement into the deterministic result.
     *
     * The division of labour is the point: **scoring decides whether an
     * observation is recorded at all, triage decides only how loudly it
     * lands.** So a candidate the model vetoes is demoted to the inbox, never
     * erased — Goobster still noticed it, and the inbox costs nothing. Letting
     * the model delete observations would put it back in charge of relevance,
     * which is exactly what the deterministic generators exist to prevent.
     *
     * Adjustments are clamped, unknown keys are ignored, and triage can never
     * make something louder than scoring already allowed.
     */
    _applyTriage(shortlist, triage, policy) {
        if (!triage) return shortlist;
        const adjustments = new Map();
        const reasons = new Map();
        for (const entry of triage.keep) {
            if (!entry?.key) continue;
            const adjust = Math.max(-0.2, Math.min(0.2, Number(entry.adjust) || 0));
            adjustments.set(String(entry.key), adjust);
            if (entry.reason) reasons.set(String(entry.key), clip(entry.reason, 300));
        }
        const dropped = new Set(triage.drop);

        const out = [];
        for (const candidate of shortlist) {
            const vetoed = dropped.has(candidate.key) || !adjustments.has(candidate.key);
            if (vetoed) {
                out.push({
                    ...candidate,
                    disposition: 'inbox',
                    reason: reasons.get(candidate.key) || 'Noticed, but not worth interrupting for.'
                });
                continue;
            }
            const adjusted = candidate.score + adjustments.get(candidate.key);
            let disposition = score.dispositionFor(adjusted, candidate.thresholds);
            if (disposition === 'discard') continue;
            disposition = score.clampDisposition(disposition, policy.initiative);
            // Never let triage raise something above where scoring put it.
            if (config.DISPOSITION_RANK[disposition] > config.DISPOSITION_RANK[candidate.disposition]) {
                disposition = candidate.disposition;
            }
            out.push({
                ...candidate,
                score: adjusted,
                disposition,
                reason: reasons.get(candidate.key) || null
            });
        }
        return out;
    }

    /* ------------------------------------------------------------------ */
    /* Notices                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Record one intervention. The dedupeKey makes this idempotent: a
     * candidate re-derived on the next sweep finds its own notice and does
     * nothing, which is why the pipeline needs no durable event log.
     * @returns {Promise<Object|null>} the notice, or null when it already existed
     */
    async _raiseNotice(userId, candidate) {
        const existing = await db.get(
            'SELECT id FROM attention_notices WHERE userId = @userId AND dedupeKey = @key',
            { userId, key: candidate.key }
        );
        if (existing) return null;

        const id = Number(await db.insert(
            `INSERT INTO attention_notices (
                userId, itemId, dedupeKey, category, title, detail,
                urgency, importance, confidence, actionability, interruptionCost,
                score, disposition, reason
             ) VALUES (
                @userId, @itemId, @key, @category, @title, @detail,
                @urgency, @importance, @confidence, @actionability, @interruptionCost,
                @score, @disposition, @reason
             )`,
            {
                userId,
                itemId: candidate.itemId ?? null,
                key: candidate.key,
                category: candidate.category,
                title: candidate.title,
                detail: candidate.detail,
                urgency: candidate.urgency,
                importance: candidate.importance,
                confidence: candidate.confidence,
                actionability: candidate.actionability,
                interruptionCost: candidate.interruptionCost,
                score: candidate.score,
                disposition: candidate.disposition,
                reason: candidate.reason || null
            }
        ));
        await this.recordFeedback({ userId, noticeId: id, category: candidate.category, signal: 'surfaced' });
        domainEventBus.publish(domainEventBus.TOPICS.ATTENTION_NOTICE_SURFACED, {
            userId, noticeId: id, disposition: candidate.disposition
        });
        this._publishPortal(userId, id);
        return { id, ...candidate };
    }

    /** Tell the portal a notice appeared (fire-and-forget, like every hint). */
    _publishPortal(userId, noticeId) {
        try {
            require('./eventBusService').publish('attention-noticed', { userId, noticeId });
        } catch { /* the event bus must never break the decision */ }
    }

    /**
     * The assistant inbox for one person.
     * @param {Object} params - { userId, statuses, limit }
     * @returns {Promise<Object[]>}
     */
    async listNotices({ userId, statuses = OPEN_STATUSES, limit = 50 } = {}) {
        if (!userId) return [];
        const list = (Array.isArray(statuses) ? statuses : [statuses])
            .filter(status => typeof status === 'string');
        if (list.length === 0) return [];
        const params = { userId, limit: Math.max(1, Math.min(200, Number(limit) || 50)) };
        list.forEach((status, i) => { params[`s${i}`] = status; });
        const rows = await db.all(
            `SELECT n.*, i.subject AS itemSubject, i.kind AS itemKind
             FROM attention_notices n
             LEFT JOIN attention_items i ON i.id = n.itemId
             WHERE n.userId = @userId
               AND n.status IN (${list.map((_, i) => `@s${i}`).join(', ')})
               AND (n.snoozeUntil IS NULL OR n.snoozeUntil <= CURRENT_TIMESTAMP)
             ORDER BY n.score DESC, n.id DESC
             LIMIT @limit`,
            params
        );
        return rows.map(row => this.presentNotice(row));
    }

    presentNotice(row) {
        if (!row) return null;
        return {
            id: row.id,
            itemId: row.itemId ?? null,
            itemSubject: row.itemSubject ?? null,
            itemKind: row.itemKind ?? null,
            category: row.category,
            title: row.title,
            detail: row.detail || null,
            disposition: row.disposition,
            status: row.status,
            reason: row.reason || null,
            score: row.score,
            // The score inputs are exposed on purpose: "why did you tell me
            // this?" should always be answerable.
            factors: {
                urgency: row.urgency,
                importance: row.importance,
                confidence: row.confidence,
                actionability: row.actionability,
                interruptionCost: row.interruptionCost
            },
            deliveredAt: row.deliveredAt || null,
            snoozeUntil: row.snoozeUntil || null,
            createdAt: row.createdAt
        };
    }

    /**
     * React to a notice. Dismissal is feedback, not just a delete: it raises
     * the bar for that whole category next time.
     * @param {Object} params - { userId, noticeId, action, snoozeHours }
     * @returns {Promise<Object|null>} the updated notice
     */
    async actOnNotice({ userId, noticeId, action, snoozeHours = 24 } = {}) {
        const allowed = {
            open: 'opened',
            dismiss: 'dismissed',
            act: 'acted_on',
            snooze: 'snoozed'
        };
        const status = allowed[action];
        if (!status) return null;
        const row = await db.get(
            'SELECT * FROM attention_notices WHERE id = @id AND userId = @userId',
            { id: Number(noticeId), userId }
        );
        if (!row) return null;

        const snoozeUntil = status === 'snoozed'
            ? toUtcText(new Date(Date.now() + Math.max(1, Math.min(720, Number(snoozeHours) || 24)) * 3600_000))
            : null;
        await db.run(
            `UPDATE attention_notices
             SET status = @status, snoozeUntil = @snoozeUntil, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: row.id, status, snoozeUntil }
        );
        await this.recordFeedback({
            userId, noticeId: row.id, category: row.category, signal: status, score: row.score
        });
        // Acting on a notice is evidence its loop is alive again.
        if (status === 'acted_on' && row.itemId) {
            await attentionLedgerService.touchActivity(row.itemId);
        }
        this._publishPortal(userId, row.id);
        return this.presentNotice({ ...row, status, snoozeUntil });
    }

    /** Mark notices delivered (used by both DM contact and chat mentions). */
    async _markDelivered(ids) {
        if (ids.length === 0) return;
        const params = {};
        ids.forEach((id, i) => { params[`id${i}`] = Number(id); });
        await db.run(
            `UPDATE attention_notices
             SET status = 'delivered', deliveredAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
             WHERE id IN (${ids.map((_, i) => `@id${i}`).join(', ')}) AND status = 'surfaced'`,
            params
        );
    }

    /**
     * Notices meant to be raised the next time the person is already talking
     * to Goobster - the cheapest possible interruption, because there isn't
     * one. Taking them marks them delivered, so they surface exactly once.
     * @param {string} userId
     * @param {number} [limit]
     * @returns {Promise<Object[]>}
     */
    async takePendingMentions(userId, limit = 3) {
        if (!userId) return [];
        const rows = await db.all(
            `SELECT * FROM attention_notices
             WHERE userId = @userId AND disposition = 'mention' AND status = 'surfaced'
               AND (snoozeUntil IS NULL OR snoozeUntil <= CURRENT_TIMESTAMP)
             ORDER BY score DESC LIMIT @limit`,
            { userId, limit: Math.max(1, Math.min(5, Number(limit) || 3)) }
        );
        if (rows.length === 0) return [];
        await this._markDelivered(rows.map(row => row.id));
        return rows.map(row => this.presentNotice(row));
    }

    /**
     * A prompt block for things worth raising in conversation. Returns null
     * when there is nothing - the common case, and the quiet one.
     * @param {string} userId
     * @returns {Promise<string|null>}
     */
    async buildChatContext(userId) {
        const mentions = await this.takePendingMentions(userId);
        if (mentions.length === 0) return null;
        const lines = mentions.map(notice =>
            `- ${notice.title}${notice.detail ? ` (${notice.detail})` : ''}`);
        return `THINGS YOU NOTICED SINCE YOU LAST SPOKE (you brought these up yourself, so mention them naturally if there is any opening — and drop them entirely if the conversation is about something else):\n${lines.join('\n')}`;
    }

    /** Quietly retire notices nobody ever looked at. */
    async expireStaleNotices(userId) {
        const result = await db.run(
            `UPDATE attention_notices
             SET status = 'expired', updatedAt = CURRENT_TIMESTAMP
             WHERE userId = @userId AND status IN ('surfaced', 'delivered')
               AND createdAt < datetime('now', '-${HEARTBEAT.noticeExpiryDays} days')`,
            { userId }
        );
        return result.changes;
    }

    /* ------------------------------------------------------------------ */
    /* Budget, calibration, contact                                        */
    /* ------------------------------------------------------------------ */

    /**
     * How costly it is to speak to this person right now: how much they have
     * already been told today, whether the cooldown is running, and whether
     * they are inside their quiet hours.
     */
    async _measurePressure(userId, policy, now) {
        const dayAgo = toUtcText(new Date(now - 86_400_000));
        const recent = await db.get(
            `SELECT COUNT(*) AS c FROM attention_notices
             WHERE userId = @userId AND createdAt >= @since`,
            { userId, since: dayAgo }
        );
        const contacts = await db.get(
            `SELECT COUNT(*) AS c, MAX(deliveredAt) AS last FROM attention_notices
             WHERE userId = @userId AND disposition IN ('dm', 'urgent')
               AND deliveredAt IS NOT NULL AND deliveredAt >= @since`,
            { userId, since: dayAgo }
        );
        const lastContact = utcMs(contacts?.last);
        const cooldownMs = (policy.contactCooldownMinutes || HEARTBEAT.contactCooldownMinutes) * 60_000;
        const withinCooldown = lastContact !== null && now - lastContact < cooldownMs;
        const quietHours = attentionPolicyService.inQuietHours(policy, new Date(now));
        return {
            recentNotices: recent?.c || 0,
            withinCooldown,
            quietHours,
            // Hard stops, as opposed to the soft cost the score absorbs.
            blocked: quietHours || (contacts?.c || 0) >= (policy.maxContactsPerDay ?? HEARTBEAT.maxContactsPerDay)
        };
    }

    /**
     * The score bands for one person and category, calibrated by what they
     * actually did with past notices in it. Dismissals raise the bar;
     * acting on them lowers it.
     * @param {string} userId
     * @param {string} category
     * @returns {Promise<Object>}
     */
    async thresholdsFor(userId, category) {
        const since = toUtcText(new Date(Date.now() - config.CALIBRATION.windowDays * 86_400_000));
        const row = await db.get(
            `SELECT
                SUM(CASE WHEN signal IN ('dismissed', 'annoying') THEN 1 ELSE 0 END) AS dismissed,
                SUM(CASE WHEN signal IN ('acted_on', 'useful', 'opened') THEN 1 ELSE 0 END) AS actedOn,
                SUM(CASE WHEN signal <> 'surfaced' THEN 1 ELSE 0 END) AS samples
             FROM attention_feedback
             WHERE userId = @userId AND category = @category AND createdAt >= @since`,
            { userId, category, since }
        );
        return score.calibrateThresholds({
            dismissed: row?.dismissed || 0,
            actedOn: row?.actedOn || 0,
            samples: row?.samples || 0
        });
    }

    /**
     * Record an intervention outcome. Never throws: calibration is a nicety,
     * and losing a data point must not break the decision that produced it.
     * @param {Object} params - { userId, noticeId, category, signal, score }
     */
    async recordFeedback({ userId, noticeId = null, category = 'general', signal, score: value = null } = {}) {
        if (!userId || !FEEDBACK_SIGNALS.includes(signal)) return;
        try {
            await db.run(
                `INSERT INTO attention_feedback (userId, noticeId, category, signal, score)
                 VALUES (@userId, @noticeId, @category, @signal, @score)`,
                { userId, noticeId, category, signal, score: value }
            );
        } catch (error) {
            logger.warn?.(`[attention] feedback not recorded: ${error.message}`);
        }
    }

    /**
     * What calibration currently looks like, per category (the "is Goobster
     * learning my preferences?" view).
     * @param {string} userId
     * @returns {Promise<Object[]>}
     */
    async getCalibration(userId) {
        const since = toUtcText(new Date(Date.now() - config.CALIBRATION.windowDays * 86_400_000));
        const rows = await db.all(
            `SELECT category,
                    SUM(CASE WHEN signal IN ('dismissed', 'annoying') THEN 1 ELSE 0 END) AS dismissed,
                    SUM(CASE WHEN signal IN ('acted_on', 'useful', 'opened') THEN 1 ELSE 0 END) AS actedOn,
                    SUM(CASE WHEN signal <> 'surfaced' THEN 1 ELSE 0 END) AS samples,
                    SUM(CASE WHEN signal = 'surfaced' THEN 1 ELSE 0 END) AS surfaced
             FROM attention_feedback
             WHERE userId = @userId AND createdAt >= @since
             GROUP BY category ORDER BY category ASC`,
            { userId, since }
        );
        return rows.map(row => ({
            category: row.category,
            surfaced: row.surfaced || 0,
            dismissed: row.dismissed || 0,
            actedOn: row.actedOn || 0,
            samples: row.samples || 0,
            thresholds: score.calibrateThresholds({
                dismissed: row.dismissed || 0,
                actedOn: row.actedOn || 0,
                samples: row.samples || 0
            })
        }));
    }

    /**
     * Reach out. Delivery goes through the gateway seam, so this code never
     * touches discord.js and works the same in the bot and api processes.
     * @returns {Promise<boolean>} whether the message landed
     */
    async _contact({ userId, gateway, notices, message, urgent }) {
        if (!gateway) return false;
        const body = String(message || '').trim();
        if (!body) return false;
        const prefix = urgent ? '❗ ' : '👋 ';
        const result = await gateway.sendDm(userId, {
            content: `${prefix}${body.slice(0, 1800)}`,
            allowedMentions: { users: [], roles: [] }
        });
        if (!result?.ok) {
            logger.warn?.(`[attention] DM to ${userId} failed: ${result?.error || 'unknown'}`);
            return false;
        }
        await this._markDelivered(notices.map(notice => notice.id));
        await db.run(
            `INSERT INTO attention_state (userId, lastContactAt, dirtyAt, updatedAt)
             VALUES (@userId, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
             ON CONFLICT(userId) DO UPDATE SET
                 lastContactAt = CURRENT_TIMESTAMP,
                 dirtyAt = NULL,
                 updatedAt = CURRENT_TIMESTAMP`,
            { userId }
        );
        logger.info?.(`[attention] Reached out to ${userId} about ${notices.length} thing(s)`);
        return true;
    }

    /** A plain digest for when the triage model is unavailable. */
    _composeFallback(notices) {
        if (notices.length === 1) {
            const only = notices[0];
            return `Something worth a look: ${only.title}.${only.detail ? ` ${only.detail}` : ''}`;
        }
        const titles = notices.slice(0, 3).map(notice => notice.title);
        return `A couple of things look worth your attention: ${titles.join('; ')}.`;
    }

    /* ------------------------------------------------------------------ */
    /* Event reaction                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * React to a domain event. Deliberately cheap: an event never triggers a
     * model call, it only flags the person so the next personal heartbeat
     * looks at them first. The expensive reasoning stays on the sweep, where
     * it is bounded and budgeted.
     *
     * `conversation.message_created` is also the freshness signal for the
     * ledger: a person talking about a loop is evidence the loop is alive.
     * @param {Object} event - { topic, payload }
     */
    async onEvent(event) {
        const userId = event?.payload?.userId;
        if (!userId) return;
        const policy = await attentionPolicyService.get(userId);
        if (!policy?.enabled) return;
        await this.markDirty(userId);
    }

    /** Flag a person for priority on the next sweep. */
    async markDirty(userId) {
        await db.run(
            `INSERT INTO attention_state (userId, dirtyAt, updatedAt)
             VALUES (@userId, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(userId) DO UPDATE SET
                 dirtyAt = CURRENT_TIMESTAMP,
                 updatedAt = CURRENT_TIMESTAMP`,
            { userId }
        );
    }

    async _markSwept(userId) {
        await db.run(
            `INSERT INTO attention_state (userId, lastSweepAt, dirtyAt, updatedAt)
             VALUES (@userId, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
             ON CONFLICT(userId) DO UPDATE SET
                 lastSweepAt = CURRENT_TIMESTAMP,
                 dirtyAt = NULL,
                 updatedAt = CURRENT_TIMESTAMP`,
            { userId }
        );
    }

    /** Erase one person's notices, feedback, and heartbeat state. */
    async forgetUser(userId, handle = db) {
        if (!userId) return 0;
        let deleted = 0;
        deleted += (await handle.run('DELETE FROM attention_feedback WHERE userId = @userId', { userId })).changes;
        deleted += (await handle.run('DELETE FROM attention_notices WHERE userId = @userId', { userId })).changes;
        deleted += (await handle.run('DELETE FROM attention_state WHERE userId = @userId', { userId })).changes;
        return deleted;
    }
}

AttentionService.instance = null;

module.exports = new AttentionService();
module.exports.AttentionService = AttentionService;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
module.exports.FEEDBACK_SIGNALS = FEEDBACK_SIGNALS;
module.exports.utcMs = utcMs;
module.exports.weekBucket = weekBucket;
