/**
 * Spitball Expeditions — durable state and lifecycle for autonomous research
 * runs over the user's knowledge graph (user-facing name: Spitball).
 * Spec: documentation/spitball_expeditions.md
 *
 * This service owns the Expedition/Cycle rows (spitball_expeditions,
 * spitball_expedition_cycles) and the evidence tables (research_sources,
 * research_claims). It deliberately does NOT write knowledge: generated
 * Notes/Connections/Tags flow through knowledgeGraphLegalizer from the
 * research pipeline (services/spitballResearchPipeline.js), preserving the
 * house rule that models propose and deterministic code legalizes.
 *
 * The state machine (spec §31):
 *
 *   DRAFT -> QUEUED -> RUNNING -> { PAUSED -> QUEUED ... } -> COMPLETED
 *                                                          -> FAILED
 *                                                          -> CANCELLED
 *
 * Continuation between cycles is a deterministic policy (decideContinuation):
 * models may estimate novelty/coverage, but budgets and the state machine own
 * whether work continues. stopReason is always recorded explicitly.
 *
 * Domain events (research.*) are hints, never the source of truth: every
 * decision here is recomputable from the rows.
 */

const db = require('../db');
const logger = require('../utils/logger');
const spitballConfig = require('../config/spitballConfig');
const lensConfig = require('../config/spitballLensConfig');
const domainEventBus = require('./domainEventBus');
const { dmScopeId } = require('../utils/dmScope');

class SpitballError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'SpitballError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Thrown by checkpoint() when an expedition stops being RUNNING mid-cycle
 * (the user pressed Pause/Cancel, or another process took over). The runner
 * treats it as a cooperative stop - the cycle is CANCELLED, never FAILED -
 * so Pause/Cancel actually halt token spend at the next stage boundary
 * instead of merely relabeling the row while the cycle keeps working.
 */
class ExpeditionInterrupted extends Error {
    constructor(status) {
        super(`Expedition is no longer running (${status}).`);
        this.name = 'ExpeditionInterrupted';
        this.expeditionStatus = status;
    }
}

/** Parse a stored JSON column, returning null instead of throwing. */
function parseJson(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function clampText(value, max) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, max) : null;
}

/** Cycle counter columns rolled from finishCycle results. */
const CYCLE_COUNTERS = [
    'sourceCount', 'sourcesAccepted', 'claimsExtracted', 'notesProposed',
    'notesCreated', 'notesMerged', 'edgesCreated', 'tagsAdded', 'conflictsFound'
];

class SpitballExpeditionService {
    constructor(config = spitballConfig) {
        this.config = config;
    }

    get enabled() {
        return this.config.enabled === true;
    }

    _requireEnabled() {
        if (!this.enabled) {
            throw new SpitballError(403, 'DISABLED', 'Spitball Expeditions are disabled on this server.');
        }
    }

    // --- Creation and reads --------------------------------------------------

    /**
     * Create a durable Expedition. Personal expeditions write into the user's
     * personal graph scope: guildId defaults to the portal DM scope and
     * scopeKey is always USER:<userId> (never weaken privacy boundaries).
     * Budgets are resolved from the depth preset at creation time.
     * @returns {Promise<Object>} the created expedition row (shaped)
     */
    async createExpedition({
        userId,
        guildId = null,
        seed,
        lensId = null,
        lensText = null,
        intent = null,
        depth = null,
        autoStart = true
    } = {}) {
        this._requireEnabled();
        if (!userId) throw new SpitballError(400, 'BAD_REQUEST', 'A user is required.');

        const caps = this.config.INPUT_CAPS;
        const cleanSeed = clampText(seed, caps.maxSeedLength);
        if (!cleanSeed) throw new SpitballError(400, 'SEED_REQUIRED', 'An expedition needs a topic to research.');

        let cleanLensId = lensConfig.DEFAULT_LENS_ID;
        if (lensId !== null && lensId !== undefined && String(lensId).trim() !== '') {
            if (!lensConfig.isValidLensId(lensId)) {
                throw new SpitballError(400, 'UNKNOWN_LENS', `Unknown lens: ${String(lensId).slice(0, 60)}`);
            }
            cleanLensId = lensConfig.getLens(lensId).id;
        }

        const cleanDepth = String(depth || this.config.DEFAULT_DEPTH).trim().toLowerCase();
        const preset = this.config.DEPTH_PRESETS[cleanDepth];
        if (!preset) {
            throw new SpitballError(400, 'UNKNOWN_DEPTH',
                `Depth must be one of: ${Object.keys(this.config.DEPTH_PRESETS).join(', ')}.`);
        }

        const cleanGuildId = clampText(guildId, 64) || dmScopeId(userId);
        const scopeKey = `USER:${userId}`;

        const open = await db.get(
            `SELECT
                SUM(CASE WHEN status IN ('QUEUED', 'RUNNING') THEN 1 ELSE 0 END) AS active,
                COUNT(*) AS open
             FROM spitball_expeditions
             WHERE userId = @userId AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
            { userId }
        );
        if ((open?.active || 0) >= this.config.maxActiveExpeditionsPerUser) {
            throw new SpitballError(409, 'TOO_MANY_ACTIVE',
                `You already have ${open.active} expedition(s) underway. Wait for one to finish or pause it first.`);
        }
        if ((open?.open || 0) >= this.config.maxOpenExpeditionsPerUser) {
            throw new SpitballError(409, 'TOO_MANY_OPEN',
                'Too many open expeditions. Cancel or finish some before starting another.');
        }

        const id = await db.insert(
            `INSERT INTO spitball_expeditions
                (userId, guildId, scopeKey, seed, lensId, lensText, intent, depth, status,
                 maxCycles, maxSources, maxNotes)
             VALUES
                (@userId, @guildId, @scopeKey, @seed, @lensId, @lensText, @intent, @depth, @status,
                 @maxCycles, @maxSources, @maxNotes)`,
            {
                userId,
                guildId: cleanGuildId,
                scopeKey,
                seed: cleanSeed,
                lensId: cleanLensId,
                lensText: clampText(lensText, caps.maxLensTextLength),
                intent: clampText(intent, caps.maxIntentLength),
                depth: cleanDepth,
                status: autoStart ? 'QUEUED' : 'DRAFT',
                maxCycles: Math.min(preset.maxCycles, this.config.hardMaxCycles),
                maxSources: preset.maxSources,
                maxNotes: preset.maxNotes
            }
        );
        return this.getExpedition(id, { userId });
    }

    /** Internal fetch without ownership (runner use). @returns {Object|null} */
    async getById(id) {
        const row = await db.get(
            'SELECT * FROM spitball_expeditions WHERE id = @id', { id: Number(id) }
        );
        return row ? this._shapeExpedition(row) : null;
    }

    /** Ownership-checked fetch: strangers get the same 404 as a missing row. */
    async getExpedition(id, { userId } = {}) {
        this._requireEnabled();
        const row = await this.getById(id);
        if (!row || row.userId !== String(userId)) {
            throw new SpitballError(404, 'NOT_FOUND', 'No such expedition.');
        }
        return row;
    }

    /** @returns {Promise<Object[]>} the user's expeditions, newest first */
    async listExpeditions({ userId, status = null, limit = 50 } = {}) {
        this._requireEnabled();
        if (!userId) throw new SpitballError(400, 'BAD_REQUEST', 'A user is required.');
        const clauses = ['userId = @userId'];
        const params = { userId, limit: Math.min(Math.max(Number(limit) || 50, 1), 200) };
        if (status) {
            if (!this.config.STATUSES.includes(status)) {
                throw new SpitballError(400, 'BAD_REQUEST', 'Unknown status filter.');
            }
            clauses.push('status = @status');
            params.status = status;
        }
        const rows = await db.all(
            `SELECT * FROM spitball_expeditions
             WHERE ${clauses.join(' AND ')}
             ORDER BY id DESC LIMIT @limit`,
            params
        );
        return rows.map(row => this._shapeExpedition(row));
    }

    /** Expedition + cycles + latest Leads + source rollup, for the detail view. */
    async getExpeditionDetail(id, { userId } = {}) {
        const expedition = await this.getExpedition(id, { userId });
        const cycles = await this.listCycles(id, { userId });
        const sources = await this.listSources(id, { userId });
        const leads = [];
        for (const cycle of cycles) {
            for (const lead of cycle.leads || []) {
                leads.push({ ...lead, cycleNumber: cycle.cycleNumber });
            }
        }
        leads.sort((a, b) => (b.expectedValue ?? 0) - (a.expectedValue ?? 0));
        return { expedition, cycles, sources, leads };
    }

    /** @returns {Promise<Object[]>} cycles oldest-first with parsed JSON columns */
    async listCycles(expeditionId, { userId } = {}) {
        await this.getExpedition(expeditionId, { userId });
        const rows = await db.all(
            `SELECT * FROM spitball_expedition_cycles
             WHERE expeditionId = @expeditionId
             ORDER BY cycleNumber ASC`,
            { expeditionId: Number(expeditionId) }
        );
        return rows.map(row => this._shapeCycle(row));
    }

    /** @returns {Promise<Object[]>} research sources for an expedition */
    async listSources(expeditionId, { userId, acceptedOnly = false } = {}) {
        await this.getExpedition(expeditionId, { userId });
        const rows = await db.all(
            `SELECT id, cycleId, provider, sourceType, url, canonicalUrl, title, author,
                    publisher, publishedAt, retrievedAt, relevanceScore, qualityScore,
                    noveltyScore, accepted, rejectionReason
             FROM research_sources
             WHERE expeditionId = @expeditionId ${acceptedOnly ? 'AND accepted = 1' : ''}
             ORDER BY id ASC`,
            { expeditionId: Number(expeditionId) }
        );
        return rows.map(row => ({ ...row, accepted: row.accepted === 1 || row.accepted === true }));
    }

    /** @returns {Promise<Object[]>} claims for one source (owner-checked via expedition) */
    async listClaims(expeditionId, { userId, sourceId = null } = {}) {
        await this.getExpedition(expeditionId, { userId });
        const clauses = ['expeditionId = @expeditionId'];
        const params = { expeditionId: Number(expeditionId) };
        if (sourceId) {
            clauses.push('sourceId = @sourceId');
            params.sourceId = Number(sourceId);
        }
        return db.all(
            `SELECT id, sourceId, cycleId, text, kind, confidence, sourceLocation, createdAt
             FROM research_claims WHERE ${clauses.join(' AND ')} ORDER BY id ASC`,
            params
        );
    }

    /**
     * The evidence trail behind one of the user's notes ("why does Goobster
     * believe this?"): the note, the expeditions that touched it, and each
     * grounding claim resolved to its research source - the
     * Note -> Claim -> Source chain, plus a summary of non-research
     * provenance (memories, facts, artifacts).
     * Ownership: only nodes in the requesting user's personal scope resolve;
     * anything else gets the same 404 as a missing note.
     * @param {number} nodeId - kg_nodes id
     * @returns {Promise<Object>} { note, expeditions, claims, otherProvenance }
     */
    async getNoteEvidence(nodeId, { userId } = {}) {
        this._requireEnabled();
        const node = await db.get(
            `SELECT id, guildId, scopeKey, type, label, content, salience, confidence, source
             FROM kg_nodes WHERE id = @id`,
            { id: Number(nodeId) }
        );
        if (!node || node.scopeKey !== `USER:${userId}`) {
            throw new SpitballError(404, 'NOT_FOUND', 'No such note.');
        }

        const provenance = await db.all(
            'SELECT sourceKind, sourceId FROM kg_provenance WHERE nodeId = @id ORDER BY id',
            { id: node.id }
        );
        const claimIds = provenance
            .filter(row => row.sourceKind === 'research_claim' && Number.isFinite(Number(row.sourceId)))
            .map(row => Number(row.sourceId));
        const expeditionIds = new Set(provenance
            .filter(row => row.sourceKind === 'expedition' && Number.isFinite(Number(row.sourceId)))
            .map(row => Number(row.sourceId)));

        let claims = [];
        if (claimIds.length > 0) {
            // Integer ids from our own rows - safe to inline for the IN list
            claims = await db.all(
                `SELECT c.id, c.text, c.kind, c.confidence, c.sourceLocation, c.expeditionId,
                        s.id AS sourceRowId, s.title AS sourceTitle, s.url AS sourceUrl,
                        s.provider AS sourceProvider, s.sourceType, s.publisher AS sourcePublisher
                 FROM research_claims c
                 JOIN research_sources s ON s.id = c.sourceId
                 WHERE c.id IN (${claimIds.join(',')})
                 ORDER BY c.confidence DESC, c.id`,
                {}
            );
            for (const claim of claims) expeditionIds.add(claim.expeditionId);
        }

        let expeditions = [];
        if (expeditionIds.size > 0) {
            expeditions = await db.all(
                `SELECT id, seed, lensId, status, finishedAt FROM spitball_expeditions
                 WHERE id IN (${[...expeditionIds].join(',')}) AND userId = @userId
                 ORDER BY id DESC`,
                { userId }
            );
        }

        const otherProvenance = {};
        for (const row of provenance) {
            if (row.sourceKind === 'research_claim' || row.sourceKind === 'expedition') continue;
            otherProvenance[row.sourceKind] = (otherProvenance[row.sourceKind] || 0) + 1;
        }

        return {
            note: node,
            expeditions,
            claims: claims.map(claim => ({
                id: claim.id,
                text: claim.text,
                kind: claim.kind,
                confidence: claim.confidence,
                sourceLocation: claim.sourceLocation,
                source: {
                    id: claim.sourceRowId,
                    title: claim.sourceTitle,
                    url: claim.sourceUrl,
                    provider: claim.sourceProvider,
                    sourceType: claim.sourceType,
                    publisher: claim.sourcePublisher
                }
            })),
            otherProvenance
        };
    }

    // --- User lifecycle actions ----------------------------------------------

    /**
     * Pause a queued or running expedition. A running cycle stops at its next
     * checkpoint (stage boundaries and source/query loops), so no further
     * model or search spend happens after this returns; the interrupted
     * cycle is marked CANCELLED by the runner.
     */
    async pauseExpedition(id, { userId } = {}) {
        const expedition = await this.getExpedition(id, { userId });
        const changed = (await db.run(
            `UPDATE spitball_expeditions
             SET status = 'PAUSED', stopReason = 'USER_PAUSED', updatedAt = datetime('now')
             WHERE id = @id AND status IN ('QUEUED', 'RUNNING')`,
            { id: expedition.id }
        )).changes > 0;
        if (!changed) {
            throw new SpitballError(409, 'BAD_STATE', `Only a queued or running expedition can be paused (this one is ${expedition.status}).`);
        }
        return this.getExpedition(id, { userId });
    }

    /**
     * Continue a paused (or draft) expedition: back to QUEUED for the runner.
     * The caller (API/tool layer) kicks the runner after this returns.
     */
    async continueExpedition(id, { userId } = {}) {
        const expedition = await this.getExpedition(id, { userId });
        if (!['PAUSED', 'DRAFT'].includes(expedition.status)) {
            throw new SpitballError(409, 'BAD_STATE', `Only a paused expedition can continue (this one is ${expedition.status}).`);
        }
        const active = await db.get(
            `SELECT COUNT(*) AS c FROM spitball_expeditions
             WHERE userId = @userId AND status IN ('QUEUED', 'RUNNING') AND id != @id`,
            { userId: expedition.userId, id: expedition.id }
        );
        if ((active?.c || 0) >= this.config.maxActiveExpeditionsPerUser) {
            throw new SpitballError(409, 'TOO_MANY_ACTIVE', 'Too many expeditions already underway.');
        }
        const changed = (await db.run(
            `UPDATE spitball_expeditions
             SET status = 'QUEUED', stopReason = NULL, lastError = NULL, updatedAt = datetime('now')
             WHERE id = @id AND status IN ('PAUSED', 'DRAFT')`,
            { id: expedition.id }
        )).changes > 0;
        if (!changed) throw new SpitballError(409, 'BAD_STATE', 'The expedition changed state; try again.');
        return this.getExpedition(id, { userId });
    }

    /** Cancel any non-terminal expedition. Terminal states never change. */
    async cancelExpedition(id, { userId } = {}) {
        const expedition = await this.getExpedition(id, { userId });
        const changed = (await db.run(
            `UPDATE spitball_expeditions
             SET status = 'CANCELLED', stopReason = 'USER_CANCELLED',
                 finishedAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = @id AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
            { id: expedition.id }
        )).changes > 0;
        if (!changed) {
            throw new SpitballError(409, 'BAD_STATE', `The expedition already finished (${expedition.status}).`);
        }
        await db.run(
            `UPDATE spitball_expedition_cycles
             SET status = 'CANCELLED', finishedAt = datetime('now')
             WHERE expeditionId = @id AND status = 'RUNNING'`,
            { id: expedition.id }
        );
        this._publish(domainEventBus.TOPICS.RESEARCH_EXPEDITION_CANCELLED, {
            userId: expedition.userId,
            expeditionId: expedition.id,
            stopReason: 'USER_CANCELLED'
        });
        return this.getExpedition(id, { userId });
    }

    // --- Runner-facing lifecycle ----------------------------------------------

    /**
     * Atomically claim a QUEUED expedition for a run loop (the
     * claim-before-run rule: a duplicated kick or second process can never
     * double-run one). The claim records the lease: which runner owns the
     * run, with lastHeartbeatAt as its expiry clock.
     * @returns {Promise<boolean>} whether this caller owns the run
     */
    async claimForRun(id, { runnerId = null } = {}) {
        const before = await this.getById(id);
        if (!before) return false;
        const claimed = (await db.run(
            `UPDATE spitball_expeditions
             SET status = 'RUNNING',
                 startedAt = COALESCE(startedAt, datetime('now')),
                 lastError = NULL,
                 runnerId = @runnerId,
                 lastHeartbeatAt = datetime('now'),
                 updatedAt = datetime('now')
             WHERE id = @id AND status = 'QUEUED'`,
            { id: Number(id), runnerId: runnerId ? String(runnerId).slice(0, 64) : null }
        )).changes > 0;
        if (claimed && !before.startedAt) {
            this._publish(domainEventBus.TOPICS.RESEARCH_EXPEDITION_STARTED, {
                userId: before.userId,
                expeditionId: before.id,
                depth: before.depth,
                maxCycles: before.maxCycles
            });
        }
        return claimed;
    }

    /** Touch the run heartbeat (between pipeline stages). */
    async heartbeat(id) {
        await db.run(
            `UPDATE spitball_expeditions SET lastHeartbeatAt = datetime('now')
             WHERE id = @id AND status = 'RUNNING'`,
            { id: Number(id) }
        );
    }

    /**
     * The cooperative stop point: renew the run lease AND assert the
     * expedition is still RUNNING, in one statement - zero touched rows means
     * the user paused/cancelled (or the row vanished), and the cycle must
     * stop before spending anything else. Pipelines call this before/after
     * model calls and inside source/query loops.
     * @throws {ExpeditionInterrupted} when the expedition is not RUNNING
     */
    async checkpoint(id) {
        const touched = (await db.run(
            `UPDATE spitball_expeditions SET lastHeartbeatAt = datetime('now')
             WHERE id = @id AND status = 'RUNNING'`,
            { id: Number(id) }
        )).changes > 0;
        if (!touched) {
            const row = await this.getById(id);
            throw new ExpeditionInterrupted(row?.status || 'MISSING');
        }
    }

    /**
     * Open the next cycle: bumps currentCycle and inserts a RUNNING cycle row
     * carrying the compact recursive state (frontierInput, never a transcript).
     * @returns {Promise<Object>} the cycle row
     */
    async startCycle(expeditionId, { frontierInput = null } = {}) {
        const expedition = await this.getById(expeditionId);
        if (!expedition || expedition.status !== 'RUNNING') {
            throw new SpitballError(409, 'BAD_STATE', 'Only a running expedition can start a cycle.');
        }
        const cycleNumber = expedition.currentCycle + 1;
        const cycleId = await db.insert(
            `INSERT INTO spitball_expedition_cycles (expeditionId, cycleNumber, frontierInputJson)
             VALUES (@expeditionId, @cycleNumber, @frontierInputJson)`,
            {
                expeditionId: expedition.id,
                cycleNumber,
                frontierInputJson: frontierInput ? JSON.stringify(frontierInput) : null
            }
        );
        await db.run(
            `UPDATE spitball_expeditions
             SET currentCycle = @cycleNumber, lastHeartbeatAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = @id`,
            { id: expedition.id, cycleNumber }
        );
        this._publish(domainEventBus.TOPICS.RESEARCH_CYCLE_STARTED, {
            userId: expedition.userId,
            expeditionId: expedition.id,
            cycleId,
            cycleNumber
        });
        const row = await db.get(
            'SELECT * FROM spitball_expedition_cycles WHERE id = @id', { id: cycleId }
        );
        return this._shapeCycle(row);
    }

    /**
     * Record a cycle's exact results (the auditability rule) and roll the
     * counters up onto the expedition. Publishes cycle/lead/conflict events.
     * @param {number} cycleId
     * @param {Object} params
     * @param {'COMPLETED'|'FAILED'} [params.status]
     * @param {Object} [params.counters] - CYCLE_COUNTERS subset
     * @param {Object} [params.plan] - structured research plan
     * @param {Object} [params.coverage] - coverage summary object
     * @param {Array<Object>} [params.leads] - ranked Leads
     * @param {number} [params.noveltyScore]
     * @param {number} [params.coverageScore]
     * @param {string} [params.error]
     */
    async finishCycle(cycleId, {
        status = 'COMPLETED',
        counters = {},
        plan = null,
        coverage = null,
        leads = null,
        noveltyScore = null,
        coverageScore = null,
        error = null
    } = {}) {
        if (!this.config.CYCLE_STATUSES.includes(status) || status === 'RUNNING') {
            throw new SpitballError(400, 'BAD_REQUEST', `Illegal cycle status: ${status}`);
        }
        const cycle = await db.get(
            'SELECT * FROM spitball_expedition_cycles WHERE id = @id', { id: Number(cycleId) }
        );
        if (!cycle) throw new SpitballError(404, 'NOT_FOUND', 'No such cycle.');

        const cleanCounters = {};
        for (const key of CYCLE_COUNTERS) {
            const n = Number(counters?.[key]);
            cleanCounters[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
        }
        const cleanLeads = Array.isArray(leads)
            ? leads.slice(0, this.config.PIPELINE_CAPS.maxLeadsPerCycle)
            : null;

        const changed = (await db.run(
            `UPDATE spitball_expedition_cycles
             SET status = @status,
                 researchPlanJson = COALESCE(@plan, researchPlanJson),
                 frontierOutputJson = COALESCE(@leads, frontierOutputJson),
                 coverageSummaryJson = COALESCE(@coverage, coverageSummaryJson),
                 sourceCount = @sourceCount, sourcesAccepted = @sourcesAccepted,
                 claimsExtracted = @claimsExtracted, notesProposed = @notesProposed,
                 notesCreated = @notesCreated, notesMerged = @notesMerged,
                 edgesCreated = @edgesCreated, tagsAdded = @tagsAdded,
                 conflictsFound = @conflictsFound,
                 noveltyScore = @noveltyScore, coverageScore = @coverageScore,
                 lastError = @error, finishedAt = datetime('now')
             WHERE id = @id AND status = 'RUNNING'`,
            {
                id: cycle.id,
                status,
                plan: plan ? JSON.stringify(plan) : null,
                leads: cleanLeads ? JSON.stringify(cleanLeads) : null,
                coverage: coverage ? JSON.stringify(coverage) : null,
                ...cleanCounters,
                noveltyScore: Number.isFinite(Number(noveltyScore)) ? Number(noveltyScore) : null,
                coverageScore: Number.isFinite(Number(coverageScore)) ? Number(coverageScore) : null,
                error: error ? String(error).slice(0, 2000) : null
            }
        )).changes > 0;
        if (!changed) return null; // already finished (cancel race) - keep first result

        await db.run(
            `UPDATE spitball_expeditions
             SET sourcesAccepted = sourcesAccepted + @sourcesAccepted,
                 notesCreated = notesCreated + @notesCreated,
                 edgesCreated = edgesCreated + @edgesCreated,
                 lastHeartbeatAt = datetime('now'),
                 updatedAt = datetime('now')
             WHERE id = @expeditionId`,
            {
                expeditionId: cycle.expeditionId,
                sourcesAccepted: cleanCounters.sourcesAccepted,
                notesCreated: cleanCounters.notesCreated,
                edgesCreated: cleanCounters.edgesCreated
            }
        );

        const expedition = await this.getById(cycle.expeditionId);
        const base = {
            userId: expedition?.userId,
            expeditionId: cycle.expeditionId,
            cycleId: cycle.id,
            cycleNumber: cycle.cycleNumber
        };
        this._publish(domainEventBus.TOPICS.RESEARCH_CYCLE_COMPLETED, {
            ...base,
            status,
            newNotes: cleanCounters.notesCreated,
            newConnections: cleanCounters.edgesCreated,
            leadCount: cleanLeads?.length || 0
        });
        if (cleanCounters.conflictsFound > 0) {
            this._publish(domainEventBus.TOPICS.RESEARCH_CONFLICT_FOUND, {
                ...base,
                conflictsFound: cleanCounters.conflictsFound
            });
        }
        const highValueFloor = 0.75;
        for (const lead of cleanLeads || []) {
            const value = Number(lead?.expectedValue);
            if (Number.isFinite(value) && value >= highValueFloor) {
                this._publish(domainEventBus.TOPICS.RESEARCH_LEAD_DISCOVERED, {
                    ...base,
                    topic: String(lead.topic || '').slice(0, 120),
                    kind: String(lead.kind || '').slice(0, 40),
                    expectedValue: value
                });
            }
        }
        return this._shapeCycle(await db.get(
            'SELECT * FROM spitball_expedition_cycles WHERE id = @id', { id: cycle.id }
        ));
    }

    /** Terminal success. Only a RUNNING expedition completes (race-safe). */
    async completeExpedition(id, { stopReason, summary = null } = {}) {
        if (!this.config.STOP_REASONS.includes(stopReason)) {
            throw new SpitballError(400, 'BAD_REQUEST', `Illegal stop reason: ${stopReason}`);
        }
        const changed = (await db.run(
            `UPDATE spitball_expeditions
             SET status = 'COMPLETED', stopReason = @stopReason,
                 summary = @summary, finishedAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = @id AND status = 'RUNNING'`,
            { id: Number(id), stopReason, summary: clampText(summary, 4000) }
        )).changes > 0;
        if (changed) {
            const expedition = await this.getById(id);
            this._publish(domainEventBus.TOPICS.RESEARCH_EXPEDITION_COMPLETED, {
                userId: expedition.userId,
                expeditionId: expedition.id,
                stopReason,
                cycles: expedition.currentCycle,
                notesCreated: expedition.notesCreated,
                edgesCreated: expedition.edgesCreated
            });
        }
        return changed;
    }

    /** Terminal failure: the error is recorded, state is never corrupted. */
    async failExpedition(id, { error } = {}) {
        const changed = (await db.run(
            `UPDATE spitball_expeditions
             SET status = 'FAILED', stopReason = 'FAILED', lastError = @error,
                 finishedAt = datetime('now'), updatedAt = datetime('now')
             WHERE id = @id AND status = 'RUNNING'`,
            { id: Number(id), error: clampText(error, 2000) || 'Unknown error' }
        )).changes > 0;
        if (changed) {
            const expedition = await this.getById(id);
            this._publish(domainEventBus.TOPICS.RESEARCH_EXPEDITION_FAILED, {
                userId: expedition.userId,
                expeditionId: expedition.id,
                stopReason: 'FAILED'
            });
        }
        return changed;
    }

    /**
     * Park orphaned runs: RUNNING rows nobody in this process is driving AND
     * whose heartbeat lease has expired (staleRunMinutes) become PAUSED
     * (safer than auto-resuming research spend), and their RUNNING cycles are
     * CANCELLED. The owner can Continue. A RUNNING row with a fresh
     * heartbeat is assumed to be legitimately owned by another process -
     * ownership is the durable lease (runnerId + lastHeartbeatAt), never
     * process-local inference alone.
     * @param {Set<number>} liveIds - expedition ids with a live in-process loop
     * @returns {Promise<number[]>} parked expedition ids
     */
    async reapOrphans(liveIds = new Set()) {
        const cutoff = new Date(Date.now() - this.config.staleRunMinutes * 60_000);
        const rows = await db.all(
            `SELECT id, runnerId FROM spitball_expeditions
             WHERE status = 'RUNNING'
               AND (lastHeartbeatAt IS NULL OR lastHeartbeatAt < @cutoff)`,
            { cutoff }
        );
        const parked = [];
        for (const row of rows) {
            if (liveIds.has(row.id)) continue;
            const changed = (await db.run(
                `UPDATE spitball_expeditions
                 SET status = 'PAUSED', lastError = 'The run lease expired (process crash or restart).',
                     stopReason = NULL, updatedAt = datetime('now')
                 WHERE id = @id AND status = 'RUNNING'
                   AND (lastHeartbeatAt IS NULL OR lastHeartbeatAt < @cutoff)`,
                { id: row.id, cutoff }
            )).changes > 0;
            if (!changed) continue;
            await db.run(
                `UPDATE spitball_expedition_cycles
                 SET status = 'CANCELLED', lastError = 'The process restarted mid-cycle.',
                     finishedAt = datetime('now')
                 WHERE expeditionId = @id AND status = 'RUNNING'`,
                { id: row.id }
            );
            parked.push(row.id);
        }
        return parked;
    }

    /** Ids of expeditions waiting for a runner (restart pickup). */
    async listQueuedIds() {
        const rows = await db.all(`SELECT id FROM spitball_expeditions WHERE status = 'QUEUED' ORDER BY id ASC`);
        return rows.map(row => row.id);
    }

    // --- Continuation policy ---------------------------------------------------

    /**
     * The deterministic continue/stop decision after a completed cycle
     * (spec §25/§40). Models may have estimated novelty/coverage inside the
     * cycle; this function owns whether another cycle may run.
     * @param {Object} params
     * @param {Object} params.expedition - fresh expedition row (post-rollup)
     * @param {Object} params.cycle - the finished cycle row (shaped)
     * @param {Array<Object>} [params.leads] - the cycle's ranked Leads
     * @param {Array<Object>} [params.recentCycles] - completed cycles, newest last
     * @returns {{continue: boolean, reason: string|null}}
     */
    decideContinuation({ expedition, cycle, leads = null, recentCycles = [] } = {}) {
        const policy = this.config.CONTINUATION;
        if (!expedition || expedition.status !== 'RUNNING') {
            return { continue: false, reason: expedition?.stopReason || 'USER_PAUSED' };
        }
        if (expedition.currentCycle >= expedition.maxCycles) {
            return { continue: false, reason: 'MAX_CYCLES' };
        }
        if (expedition.notesCreated >= expedition.maxNotes) {
            return { continue: false, reason: 'MAX_NOTES' };
        }
        if (expedition.sourcesAccepted >= expedition.maxSources) {
            return { continue: false, reason: 'MAX_SOURCES' };
        }
        if ((cycle?.sourcesAccepted || 0) === 0) {
            return { continue: false, reason: 'NO_NEW_SOURCES' };
        }
        const coverage = Number(cycle?.coverageScore);
        if (Number.isFinite(coverage) && coverage >= policy.coverageCeiling) {
            return { continue: false, reason: 'COVERAGE_SATURATED' };
        }
        const streak = [...recentCycles, cycle]
            .filter(c => c && c.status === 'COMPLETED')
            .slice(-policy.lowNoveltyStreakToStop);
        if (streak.length >= policy.lowNoveltyStreakToStop
            && streak.every(c => Number.isFinite(Number(c.noveltyScore)) && Number(c.noveltyScore) <= policy.noveltyFloor)) {
            return { continue: false, reason: 'NOVELTY_SATURATED' };
        }
        const usableLeads = (Array.isArray(leads) ? leads : []).filter(lead =>
            Number.isFinite(Number(lead?.expectedValue)) && Number(lead.expectedValue) >= policy.minLeadValue);
        if (usableLeads.length === 0) {
            return { continue: false, reason: 'NO_LEADS' };
        }
        return { continue: true, reason: null };
    }

    /**
     * Build the compact recursive state handed to the next cycle (spec §24):
     * original purpose + previous Leads + coverage + avoid-repeating list.
     * Never a prior model transcript.
     * @param {Object} expedition - shaped expedition row
     * @returns {Promise<Object>} frontier input for the next cycle
     */
    async buildFrontierInput(expedition) {
        const caps = this.config.PIPELINE_CAPS;
        const cycles = (await db.all(
            `SELECT * FROM spitball_expedition_cycles
             WHERE expeditionId = @id AND status = 'COMPLETED'
             ORDER BY cycleNumber ASC`,
            { id: expedition.id }
        )).map(row => this._shapeCycle(row));

        const last = cycles[cycles.length - 1] || null;
        const avoid = [];
        const unresolved = [];
        for (const cycle of cycles) {
            for (const concept of cycle.coverage?.majorNewConcepts || []) {
                if (avoid.length < caps.maxAvoidRepeating) avoid.push(String(concept).slice(0, 120));
            }
        }
        for (const question of last?.coverage?.unresolvedQuestions || []) {
            if (unresolved.length < caps.maxQuestionsPerPlan) unresolved.push(String(question).slice(0, 300));
        }
        return {
            originalSeed: expedition.seed,
            lensId: expedition.lensId,
            lensText: expedition.lensText,
            intent: expedition.intent,
            cycleNumber: expedition.currentCycle + 1,
            previousLeads: (last?.leads || []).slice(0, caps.maxFrontierLeads),
            unresolvedQuestions: unresolved,
            coverageSummary: last?.coverage?.summary || null,
            avoidRepeating: avoid
        };
    }

    // --- Privacy ---------------------------------------------------------------

    /**
     * Full-user erasure: expeditions cascade cycles, sources, and claims.
     * Generated kg_* knowledge is already erased by the existing personal
     * graph deletion in privacyService.
     */
    async forgetUser(userId) {
        const counts = await this.auditUser(userId);
        await db.run('DELETE FROM spitball_expeditions WHERE userId = @userId', { userId });
        return counts;
    }

    /** Row counts for the leftover audit. */
    async auditUser(userId) {
        const [expeditions, cycles, sources, claims] = await Promise.all([
            db.get('SELECT COUNT(*) AS c FROM spitball_expeditions WHERE userId = @userId', { userId }),
            db.get(
                `SELECT COUNT(*) AS c FROM spitball_expedition_cycles
                 WHERE expeditionId IN (SELECT id FROM spitball_expeditions WHERE userId = @userId)`,
                { userId }
            ),
            db.get('SELECT COUNT(*) AS c FROM research_sources WHERE userId = @userId', { userId }),
            db.get(
                `SELECT COUNT(*) AS c FROM research_claims
                 WHERE expeditionId IN (SELECT id FROM spitball_expeditions WHERE userId = @userId)`,
                { userId }
            )
        ]);
        return {
            expeditions: expeditions?.c || 0,
            cycles: cycles?.c || 0,
            researchSources: sources?.c || 0,
            researchClaims: claims?.c || 0
        };
    }

    // --- Shaping ---------------------------------------------------------------

    _shapeExpedition(row) {
        return {
            ...row,
            lens: row.lensId ? lensConfig.getLens(row.lensId) : null
        };
    }

    _shapeCycle(row) {
        return {
            ...row,
            plan: parseJson(row.researchPlanJson),
            frontierInput: parseJson(row.frontierInputJson),
            leads: parseJson(row.frontierOutputJson) || [],
            coverage: parseJson(row.coverageSummaryJson)
        };
    }

    /** Fire-and-forget: the bus must never break a lifecycle write. */
    _publish(topic, payload) {
        try {
            domainEventBus.publish(topic, payload);
        } catch (error) {
            logger.warn?.(`[spitball] Event ${topic} not published: ${error.message}`);
        }
    }
}

module.exports = new SpitballExpeditionService();
module.exports.SpitballExpeditionService = SpitballExpeditionService;
module.exports.SpitballError = SpitballError;
module.exports.ExpeditionInterrupted = ExpeditionInterrupted;
