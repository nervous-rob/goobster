/**
 * The Spitball Expedition research pipeline: one Cycle's worth of stages
 * (spec: documentation/spitball_expeditions.md §8):
 *
 *   1. build existing-knowledge context (bounded Spitball slice, never a dump)
 *   2. research plan (strict JSON, deterministic fallback)
 *   3. search (provider-agnostic adapters via spitballSearchService)
 *   4-5. normalize + score + select sources (inspectable math, persisted
 *        accept/reject decisions in research_sources)
 *   6. claim extraction (structured evidence in research_claims - evidence
 *      before synthesis)
 *   7-10. atomic note / tag / typed-connection proposals (Lens-biased)
 *   11. legalize via knowledgeGraphLegalizer (the ONLY graph write path;
 *       provenance: expedition + research_claim rows)
 *   13-14. coverage evaluation + ranked Leads (one combined model call)
 *
 * The runner (spitballExpeditionRunner) owns budgets, cycle state, and the
 * continue/stop decision; this module owns the semantic work inside one
 * cycle. Model output is never trusted raw: every stage parses through the
 * clamps in utils/researchSources.js, and a malformed response degrades to a
 * deterministic fallback (plan) or a smaller cycle (claims/notes/coverage) -
 * never a partial arbitrary write.
 *
 * Model routing stays in aiService/aiConfig (no hardcoded model ids); usage
 * is attributed to the expedition owner's scope.
 */

const db = require('../db');
const logger = require('../utils/logger');
const aiService = require('./aiService');
const embeddingService = require('./embeddingService');
const knowledgeGraphService = require('./knowledgeGraphService');
const searchServiceSingleton = require('./spitballSearchService');
const spitballConfig = require('../config/spitballConfig');
const lensConfig = require('../config/spitballLensConfig');
const kgConfig = require('../config/knowledgeGraphConfig');
const {
    canonicalizeUrl, contentHash, clampScore, keywordOverlap, sourceValue,
    clampPlan, clampClaims, clampKnowledgeProposals, clampCoverage, clampLeads
} = require('../utils/researchSources');

/** Static quality prior per source type (inspectable, tunable). */
const SOURCE_TYPE_QUALITY = {
    peer_reviewed: 0.95,
    primary_source: 0.9,
    reference: 0.8,
    review_article: 0.8,
    preprint: 0.7,
    news: 0.6,
    search_synthesis: 0.55,
    other: 0.5
};

/**
 * Render a lens's example note network as prompt text: a concrete picture of
 * well-formed atomic notes, tag clustering, and meaningful connections in
 * this research context.
 */
function renderLensExample(lens) {
    const example = lens?.example;
    if (!example) return null;
    return [
        `Example of well-formed notes and connectivity (${example.scenario}):`,
        ...example.notes.map(note => `  note: [${note.type}] "${note.label}" tags: ${note.tags.join(', ')}`),
        ...example.connections.map(edge => `  connection: "${edge.source}" -${edge.relation}-> "${edge.target}"`),
        example.commentary ? `  why this works: ${example.commentary}` : null
    ].filter(Boolean).join('\n');
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

class SpitballResearchPipeline {
    /**
     * Every dependency is injectable so the recursive loop and each stage can
     * be tested with deterministic mocks (spec §47.4).
     */
    constructor({
        ai = aiService,
        embeddings = embeddingService,
        kg = knowledgeGraphService,
        searchService = searchServiceSingleton,
        config = spitballConfig
    } = {}) {
        this.ai = ai;
        this.embeddings = embeddings;
        this.kg = kg;
        this.searchService = searchService;
        this.config = config;
    }

    /**
     * Run one full research cycle. See the module doc for the stage list.
     * @param {Object} params - { expedition, cycle, frontierInput, heartbeat }
     * @returns {Promise<Object>} { plan, counters, coverage, leads, noveltyScore, coverageScore }
     */
    async runCycle({ expedition, cycle, frontierInput = null, heartbeat = async () => {} } = {}) {
        const caps = this.config.PIPELINE_CAPS;
        const usageContext = { guildId: expedition.guildId, userId: expedition.userId };
        const lens = lensConfig.getLens(expedition.lensId) || lensConfig.getLens(lensConfig.DEFAULT_LENS_ID);

        // Stage 1: what do we already know?
        const context = await this._buildContext(expedition, lens, frontierInput);
        await heartbeat();

        // Stage 2: plan (model, deterministic fallback)
        const plan = await this._generatePlan({ expedition, lens, context, frontierInput, usageContext });
        await heartbeat();

        // Stage 3: search (the Lens influences which source classes are sought)
        const drafts = await this._search(plan, lens, heartbeat);

        // Stages 4-5: normalize, persist, score, select
        const remainingSourceBudget = Math.max(0, expedition.maxSources - (expedition.sourcesAccepted || 0));
        const { accepted, sourceCount } = await this._normalizeAndSelectSources({
            expedition, cycle, drafts, plan, lens, remainingSourceBudget
        });
        await heartbeat();

        const counters = {
            sourceCount,
            sourcesAccepted: accepted.length,
            claimsExtracted: 0,
            notesProposed: 0,
            notesCreated: 0,
            notesMerged: 0,
            edgesCreated: 0,
            tagsAdded: 0,
            conflictsFound: 0
        };

        if (accepted.length === 0) {
            return {
                plan,
                counters,
                coverage: clampCoverage({
                    summary: 'No usable sources were found for this cycle.',
                    unresolvedQuestions: plan.questions,
                    coverageScore: 0,
                    noveltyScore: 0
                }, caps),
                leads: [],
                noveltyScore: 0,
                coverageScore: 0
            };
        }

        // Stage 6: evidence before synthesis
        const claims = await this._extractClaims({ expedition, cycle, accepted, lens, usageContext, heartbeat });
        counters.claimsExtracted = claims.length;

        // Stages 7-11: propose knowledge, legalize, persist provenance
        if (claims.length > 0) {
            const applied = await this._generateAndLegalizeKnowledge({
                expedition, lens, context, frontierInput, claims, usageContext, counters
            });
            if (applied) {
                counters.notesCreated = Math.max(0, applied.nodesUpserted - applied.nodesMerged);
                counters.notesMerged = applied.nodesMerged;
                counters.edgesCreated = applied.linksCreated;
                counters.tagsAdded = applied.tagsApplied;
                counters.conflictsFound = applied.contradictions;
            }
        }
        await heartbeat();

        // Stages 13-14: coverage + Leads (one combined call)
        const { coverage, leads } = await this._evaluateCoverageAndLeads({
            expedition, lens, plan, frontierInput, claims, counters, usageContext
        });

        // Novelty: the model's estimate, sanity-bounded by a deterministic
        // ceiling - a cycle that created nothing new cannot claim novelty.
        const createdSomething = counters.notesCreated + counters.edgesCreated > 0;
        const noveltyScore = createdSomething ? coverage.noveltyScore : Math.min(coverage.noveltyScore, 0.05);

        return {
            plan,
            counters,
            coverage,
            leads,
            noveltyScore,
            coverageScore: coverage.coverageScore
        };
    }

    // --- Stage 1: existing-knowledge context -----------------------------------

    async _buildContext(expedition, lens, frontierInput) {
        const caps = this.config.PIPELINE_CAPS;
        let knowledgeExcerpt = null;
        try {
            knowledgeExcerpt = await this.kg.describeForPrompt({
                guildId: expedition.guildId,
                scopeKey: expedition.scopeKey,
                query: expedition.seed,
                limit: 12
            });
        } catch (error) {
            logger.warn?.(`[spitball] Existing-knowledge excerpt failed: ${error.message}`);
        }
        let existingTags = [];
        try {
            const rows = await db.all(
                `SELECT name FROM kg_tags
                 WHERE guildId = @guildId AND scopeKey = @scopeKey
                 ORDER BY id DESC LIMIT 40`,
                { guildId: expedition.guildId, scopeKey: expedition.scopeKey }
            );
            existingTags = rows.map(row => row.name);
        } catch (error) {
            logger.warn?.(`[spitball] Existing-tag listing failed: ${error.message}`);
        }
        return {
            knowledgeExcerpt: knowledgeExcerpt ? String(knowledgeExcerpt).slice(0, caps.contextNoteChars) : null,
            existingTags,
            avoidRepeating: frontierInput?.avoidRepeating || []
        };
    }

    // --- Stage 2: research plan -------------------------------------------------

    async _generatePlan({ expedition, lens, context, frontierInput, usageContext }) {
        const caps = this.config.PIPELINE_CAPS;
        const previousLeads = frontierInput?.previousLeads || [];
        const parts = [
            'You are planning one cycle of autonomous research. Output ONLY JSON:',
            '{"questions": ["..."], "searchQueries": ["..."], "expectedConcepts": ["..."], "relationshipTargets": ["..."], "excludeTerms": ["..."]}',
            '',
            `Seed topic: ${expedition.seed}`,
            `Lens: ${lens.name} (prefer sources: ${lens.sourcePreferences.join(', ')}; relationship vocabulary: ${lens.relationshipPriorities.join(', ')})`,
            expedition.lensText ? `Extra lens context: ${expedition.lensText}` : null,
            expedition.intent ? `The user's intent (stay anchored to this): ${expedition.intent}` : null,
            frontierInput && frontierInput.cycleNumber > 1
                ? `This is cycle ${frontierInput.cycleNumber}. Expand the FRONTIER below; do not re-research the seed itself.`
                : 'This is the first cycle: map the landscape of the seed topic.',
            previousLeads.length > 0
                ? `Frontier leads from the previous cycle (pursue the most valuable):\n${previousLeads.map(lead => `- ${lead.topic}${lead.reason ? ` (${lead.reason})` : ''}`).join('\n')}`
                : null,
            frontierInput?.unresolvedQuestions?.length > 0
                ? `Unresolved questions: ${frontierInput.unresolvedQuestions.join(' | ')}`
                : null,
            context.avoidRepeating.length > 0
                ? `Already covered (do NOT plan queries about these): ${context.avoidRepeating.join(', ')}`
                : null,
            context.knowledgeExcerpt
                ? `Existing knowledge in the user's Spitball (build on this, avoid duplicating it):\n${context.knowledgeExcerpt}`
                : 'The user has no existing knowledge on this topic yet.',
            `Limits: at most ${caps.maxQuestionsPerPlan} questions and ${caps.maxSearchQueriesPerPlan} search queries.`
        ].filter(Boolean);

        try {
            const response = await this.ai.generateText(parts.join('\n'), { max_tokens: 900, usageContext });
            const plan = clampPlan(parseJsonBlock(response), caps);
            if (plan) return plan;
        } catch (error) {
            logger.warn?.(`[spitball] Plan generation failed (deterministic fallback): ${error.message}`);
        }
        // Deterministic fallback: the frontier leads' suggested queries, else
        // the seed through the lens. Research degrades, it never dies here.
        const fallbackQueries = [];
        for (const lead of previousLeads) {
            for (const query of lead.suggestedQueries || []) fallbackQueries.push(query);
            if (lead.topic) fallbackQueries.push(`${lead.topic} ${expedition.seed}`);
        }
        if (fallbackQueries.length === 0) {
            fallbackQueries.push(expedition.seed, `${expedition.seed} ${lens.name}`);
        }
        return clampPlan({
            questions: frontierInput?.unresolvedQuestions?.length > 0
                ? frontierInput.unresolvedQuestions
                : [`What is ${expedition.seed}?`],
            searchQueries: fallbackQueries
        }, caps);
    }

    // --- Stage 3: search --------------------------------------------------------

    async _search(plan, lens, heartbeat) {
        const caps = this.config.PIPELINE_CAPS;
        const queries = plan.searchQueries.slice(0, caps.maxSearchQueriesUsed);
        const drafts = [];
        for (const query of queries) {
            const results = await this.searchService.search(query, {
                limitPerProvider: caps.maxResultsPerProviderQuery,
                preferredSourceTypes: lens.sourcePreferences
            });
            drafts.push(...results);
            await heartbeat();
        }
        return drafts;
    }

    // --- Stages 4-5: normalize, score, select ----------------------------------

    async _normalizeAndSelectSources({ expedition, cycle, drafts, plan, lens, remainingSourceBudget }) {
        const caps = this.config.PIPELINE_CAPS;
        const anchorText = [expedition.seed, expedition.intent, plan.expectedConcepts.join(' ')]
            .filter(Boolean).join(' ');
        let anchorVector;
        try {
            anchorVector = await this.embeddings.embed(anchorText);
        } catch {
            anchorVector = null; // keyword fallback below
        }

        // Existing hashes/URLs from earlier cycles: retries must not duplicate
        const existing = await db.all(
            'SELECT canonicalUrl, contentHash FROM research_sources WHERE expeditionId = @expeditionId',
            { expeditionId: expedition.id }
        );
        const seenUrls = new Set(existing.map(row => row.canonicalUrl).filter(Boolean));
        const seenHashes = new Set(existing.map(row => row.contentHash).filter(Boolean));

        // Normalize + in-batch dedupe
        const candidates = [];
        for (const draft of drafts) {
            const text = String(draft.text || '').slice(0, caps.maxSourceTextChars);
            if (!text) continue;
            const canonical = canonicalizeUrl(draft.url);
            const hash = contentHash(text);
            if (canonical && seenUrls.has(canonical)) continue;
            if (hash && seenHashes.has(hash)) continue;
            if (canonical) seenUrls.add(canonical);
            if (hash) seenHashes.add(hash);

            let relevance;
            if (anchorVector) {
                try {
                    const embedded = await this.embeddings.embed(text.slice(0, 2000));
                    relevance = embedded.model === anchorVector.model
                        ? clampScore((this.embeddings.cosineSimilarity(anchorVector.vector, embedded.vector) + 1) / 2, 0)
                        : keywordOverlap(anchorText, text);
                } catch {
                    relevance = keywordOverlap(anchorText, text);
                }
            } else {
                relevance = keywordOverlap(anchorText, text);
            }
            // Lens-preferred source classes get a quality bonus: the Lens
            // shapes source weighting, not just prompt wording.
            const baseQuality = SOURCE_TYPE_QUALITY[draft.sourceType] ?? SOURCE_TYPE_QUALITY.other;
            const quality = lens?.sourcePreferences?.includes(draft.sourceType)
                ? Math.min(1, baseQuality + 0.1)
                : baseQuality;
            // Novelty vs this expedition's earlier material is already handled
            // by the hash/URL dedupe above; unseen content starts fully novel.
            const novelty = 1;
            candidates.push({
                draft, text, canonical, hash, relevance, quality, novelty,
                value: sourceValue({ relevance, quality, novelty })
            });
        }
        candidates.sort((a, b) => b.value - a.value);

        const acceptBudget = Math.min(caps.maxAcceptedSourcesPerCycle, remainingSourceBudget);
        const accepted = [];
        let sourceCount = 0;
        for (const candidate of candidates) {
            const isAccepted = accepted.length < acceptBudget && candidate.relevance >= caps.minSourceRelevance;
            const rejectionReason = isAccepted
                ? null
                : candidate.relevance < caps.minSourceRelevance
                    ? 'below relevance threshold'
                    : 'source budget reached';
            let sourceId;
            try {
                sourceId = await db.insert(
                    `INSERT INTO research_sources
                        (expeditionId, cycleId, userId, provider, sourceType, url, canonicalUrl,
                         title, author, publisher, publishedAt, contentHash, extractedText,
                         metadataJson, relevanceScore, qualityScore, noveltyScore, accepted, rejectionReason)
                     VALUES
                        (@expeditionId, @cycleId, @userId, @provider, @sourceType, @url, @canonicalUrl,
                         @title, @author, @publisher, @publishedAt, @contentHash, @extractedText,
                         @metadataJson, @relevanceScore, @qualityScore, @noveltyScore, @accepted, @rejectionReason)`,
                    {
                        expeditionId: expedition.id,
                        cycleId: cycle.id,
                        userId: expedition.userId,
                        provider: String(candidate.draft.provider || 'web').slice(0, 40),
                        sourceType: candidate.draft.sourceType ? String(candidate.draft.sourceType).slice(0, 40) : null,
                        url: candidate.draft.url ? String(candidate.draft.url).slice(0, 500) : null,
                        canonicalUrl: candidate.canonical,
                        title: candidate.draft.title ? String(candidate.draft.title).slice(0, 300) : null,
                        author: candidate.draft.author ? String(candidate.draft.author).slice(0, 200) : null,
                        publisher: candidate.draft.publisher ? String(candidate.draft.publisher).slice(0, 200) : null,
                        publishedAt: candidate.draft.publishedAt ? String(candidate.draft.publishedAt).slice(0, 40) : null,
                        contentHash: candidate.hash,
                        extractedText: candidate.text,
                        metadataJson: candidate.draft.metadata ? JSON.stringify(candidate.draft.metadata) : null,
                        relevanceScore: candidate.relevance,
                        qualityScore: candidate.quality,
                        noveltyScore: candidate.novelty,
                        accepted: isAccepted,
                        rejectionReason
                    }
                );
            } catch (error) {
                // A canonical-URL race (unique constraint) is a dedupe win
                logger.warn?.(`[spitball] Source persist skipped: ${error.message}`);
                continue;
            }
            sourceCount += 1;
            if (isAccepted) accepted.push({ id: sourceId, ...candidate });
        }
        return { accepted, sourceCount };
    }

    // --- Stage 6: claim extraction ----------------------------------------------

    async _extractClaims({ expedition, cycle, accepted, lens, usageContext, heartbeat }) {
        const caps = this.config.PIPELINE_CAPS;
        const claims = [];
        for (const source of accepted) {
            const prompt = [
                'Extract structured evidence claims from this source. Output ONLY JSON:',
                `{"claims": [{"text": "one self-contained claim", "kind": "factual|interpretive|quantitative|causal|historical|methodological|reported_opinion|hypothesis", "confidence": 0.0, "sourceLocation": "where in the source", "concepts": ["..."]}]}`,
                '',
                `Research topic: ${expedition.seed}${expedition.intent ? ` (intent: ${expedition.intent})` : ''}`,
                `Lens: ${lens.name}.${lens.epistemicPolicy.distinguishClaimFromInference ? ' Distinguish what the source SAYS from what one might infer; only extract what it says.' : ''}`,
                source.draft.sourceType === 'search_synthesis'
                    ? 'This source is a synthesized web-search answer: treat its statements as reported, not primary (cap confidence at 0.7).'
                    : null,
                `Confidence reflects extraction certainty and source directness - do not default everything to 0.9.`,
                `At most ${caps.maxClaimsPerSource} claims. Skip filler; keep each claim atomic and specific.`,
                '',
                `SOURCE (${source.draft.title || source.draft.url || 'untitled'}):`,
                source.text.slice(0, caps.claimExtractionChars)
            ].filter(Boolean).join('\n');

            let extracted = [];
            try {
                const response = await this.ai.generateText(prompt, { max_tokens: 1000, usageContext });
                extracted = clampClaims(parseJsonBlock(response), caps);
            } catch (error) {
                logger.warn?.(`[spitball] Claim extraction failed for source #${source.id}: ${error.message}`);
            }
            for (const claim of extracted) {
                const claimId = await db.insert(
                    `INSERT INTO research_claims
                        (sourceId, expeditionId, cycleId, text, kind, confidence, sourceLocation, metadataJson)
                     VALUES
                        (@sourceId, @expeditionId, @cycleId, @text, @kind, @confidence, @sourceLocation, @metadataJson)`,
                    {
                        sourceId: source.id,
                        expeditionId: expedition.id,
                        cycleId: cycle.id,
                        text: claim.text,
                        kind: claim.kind,
                        confidence: claim.confidence,
                        sourceLocation: claim.sourceLocation,
                        metadataJson: claim.concepts.length > 0 ? JSON.stringify({ concepts: claim.concepts }) : null
                    }
                );
                claims.push({ id: claimId, sourceId: source.id, sourceTitle: source.draft.title, ...claim });
            }
            await heartbeat();
        }
        return claims;
    }

    // --- Stages 7-11: knowledge proposals through the legalizer ------------------

    async _generateAndLegalizeKnowledge({ expedition, lens, context, frontierInput, claims, usageContext, counters }) {
        const caps = this.config.PIPELINE_CAPS;
        const limits = kgConfig.LIMITS.research;
        const claimLines = claims.map(claim =>
            `[claim ${claim.id}] (${claim.kind}, confidence ${claim.confidence}) ${claim.text}`);

        const prompt = [
            'Turn these research claims into ATOMIC knowledge notes and typed connections. Output ONLY JSON:',
            '{"upsert": [{"type": "concept|fact|person|place|event|thing", "label": "short unique title", "content": "one self-contained idea, <=1000 chars", "salience": 0.5, "confidence": 0.5, "tags": ["..."], "claimIds": [1]}],',
            ' "link": [{"source": "label", "target": "label", "relation": "part_of", "relationKind": "causal|logical|associative|temporal|social", "weight": 0.5}],',
            ' "contradict": [{"source": "label A", "target": "label B"}]}',
            '',
            `Research topic: ${expedition.seed}${expedition.intent ? ` (intent: ${expedition.intent})` : ''}`,
            `Lens: ${lens.name}. Prefer relationship vocabulary: ${lens.relationshipPriorities.join(', ')}. Note archetypes to think in: ${lens.noteArchetypes.join(', ')}.`,
            '',
            lensConfig.GRAPH_USE_CASES,
            '',
            renderLensExample(lens),
            '',
            'Rules:',
            '- One note = one concept/claim/mechanism/question that stands on its own. No topic dumps.',
            '- Every note MUST cite the claimIds it is grounded in.',
            '- confidence reflects the underlying claims (corroboration raises it, single synthesis lowers it).',
            '- Connections are meaningful assertions; shared tags already cluster related notes, so do not link everything.',
            '- If two claims genuinely disagree, keep BOTH notes and declare them in "contradict" - never merge a disagreement away.',
            context.existingTags.length > 0
                ? `- Reuse these existing tags when they fit (invent new ones sparingly): ${context.existingTags.join(', ')}`
                : null,
            context.knowledgeExcerpt
                ? `- Existing notes in the graph (link to them by exact label instead of duplicating them):\n${context.knowledgeExcerpt}`
                : null,
            context.avoidRepeating.length > 0
                ? `- Already covered in earlier cycles (do not recreate): ${context.avoidRepeating.join(', ')}`
                : null,
            `- At most ${limits.maxMutationsUpsert} notes and ${limits.maxMutationsLink} connections.`,
            '',
            'CLAIMS:',
            ...claimLines
        ].filter(Boolean).join('\n');

        let proposals = null;
        try {
            const response = await this.ai.generateText(prompt, { max_tokens: 1600, usageContext });
            proposals = clampKnowledgeProposals(parseJsonBlock(response), {
                validClaimIds: new Set(claims.map(claim => claim.id)),
                nodeTypes: kgConfig.NODE_TYPES,
                maxNotes: limits.maxMutationsUpsert,
                maxLinks: limits.maxMutationsLink
            });
        } catch (error) {
            logger.warn?.(`[spitball] Knowledge generation failed: ${error.message}`);
        }
        if (!proposals) return null;
        counters.notesProposed = proposals.upsert.length;

        return this.kg.applyMutations({
            guildId: expedition.guildId,
            scopeKey: expedition.scopeKey,
            subjectType: 'USER',
            subjectId: expedition.userId,
            source: 'research',
            limits,
            provenance: { sourceKind: 'expedition', sourceId: expedition.id },
            mutations: proposals
        });
    }

    // --- Stages 13-14: coverage + Leads ------------------------------------------

    async _evaluateCoverageAndLeads({ expedition, lens, plan, frontierInput, claims, counters, usageContext }) {
        const caps = this.config.PIPELINE_CAPS;
        const prompt = [
            'Evaluate this research cycle and identify the frontier. Output ONLY JSON:',
            '{"coverage": {"summary": "...", "coveredQuestions": ["..."], "partiallyCoveredQuestions": ["..."], "unresolvedQuestions": ["..."], "majorNewConcepts": ["..."], "conflicts": ["..."], "coverageScore": 0.0, "noveltyScore": 0.0},',
            ' "leads": [{"topic": "...", "kind": "subtopic|open_question|contradiction|missing_evidence|primary_source|mechanism|cross_domain_connection|historical_gap|method|person", "reason": "...", "relevance": 0.0, "novelty": 0.0, "uncertainty": 0.0, "expectedValue": 0.0, "suggestedQueries": ["..."]}]}',
            '',
            `Original seed: ${expedition.seed}`,
            expedition.intent ? `Original intent: ${expedition.intent}` : null,
            `Lens: ${lens.name}.`,
            `Plan questions this cycle set out to answer: ${plan.questions.join(' | ') || '(none)'}`,
            frontierInput?.unresolvedQuestions?.length > 0
                ? `Questions still open from earlier cycles: ${frontierInput.unresolvedQuestions.join(' | ')}`
                : null,
            `This cycle extracted ${claims.length} claims and committed ${counters.notesCreated} new notes, ${counters.notesMerged} merges, ${counters.edgesCreated} connections, ${counters.conflictsFound} conflicts.`,
            'Claims gathered this cycle:',
            ...claims.slice(0, 40).map(claim => `- (${claim.kind}) ${claim.text}`),
            '',
            'Scoring guidance: coverageScore is how well the ORIGINAL purpose is now covered (not note count).',
            'noveltyScore is how much genuinely NEW understanding this cycle added relative to what was already known.',
            `Leads are the most valuable next frontiers: unresolved dependencies, unexplained mechanisms, contradictions, missing primary sources. At most ${caps.maxLeadsPerCycle}, ranked by expectedValue = relevance x novelty x uncertainty.`
        ].filter(Boolean).join('\n');

        try {
            const response = await this.ai.generateText(prompt, { max_tokens: 1400, usageContext });
            const parsed = parseJsonBlock(response);
            if (parsed) {
                return {
                    coverage: clampCoverage(parsed.coverage || parsed, caps),
                    leads: clampLeads(parsed, caps)
                };
            }
        } catch (error) {
            logger.warn?.(`[spitball] Coverage evaluation failed (deterministic fallback): ${error.message}`);
        }
        // Deterministic fallback: an honest shell. No leads means the
        // continuation policy ends the expedition cleanly (NO_LEADS).
        return {
            coverage: clampCoverage({
                summary: `Gathered ${claims.length} claims and committed ${counters.notesCreated} notes; coverage evaluation was unavailable this cycle.`,
                unresolvedQuestions: plan.questions,
                coverageScore: 0,
                noveltyScore: counters.notesCreated > 0 ? 0.3 : 0
            }, caps),
            leads: []
        };
    }
}

const defaultPipeline = new SpitballResearchPipeline();

module.exports = defaultPipeline;
module.exports.SpitballResearchPipeline = SpitballResearchPipeline;
module.exports.SOURCE_TYPE_QUALITY = SOURCE_TYPE_QUALITY;
module.exports.parseJsonBlock = parseJsonBlock;
