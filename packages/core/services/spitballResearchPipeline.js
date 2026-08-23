/**
 * The Spitball Expedition research pipeline: one Cycle's worth of stages
 * (spec: documentation/spitball_expeditions.md §8):
 *
 *   1. build existing-knowledge context (bounded Spitball slice, never a dump)
 *   2. research plan (strict JSON, deterministic fallback)
 *   3. search (provider-agnostic adapters via spitballSearchService)
 *   4-5. normalize + score + select sources (inspectable math, persisted
 *        accept/reject decisions in research_sources)
 *   5.5. source review (model keep/drop vs seed+intent; purpose-overlap
 *        fallback) and one refined re-search if the haul is rejected
 *   6. claim extraction (structured evidence in research_claims - evidence
 *      before synthesis)
 *   6.5. claim review (off-topic claims dropped; a source whose whole haul
 *        was dropped is rejected and can trigger a retry)
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
    textSimilarity, noveltyFromSimilarity,
    clampPlan, clampClaims, clampKnowledgeProposals, clampCoverage, clampLeads,
    clampSourceReview, clampClaimReview, purposeOverlap
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
     * @param {Object} params - { expedition, cycle, frontierInput, checkpoint }
     *   checkpoint() is the cooperative stop point (renews the run lease and
     *   throws ExpeditionInterrupted once the user pauses/cancels); it is
     *   called between stages, around model calls, and inside source/query
     *   loops - always OUTSIDE the local try/catch blocks, so an interrupt
     *   propagates to the runner instead of degrading like a model failure.
     * @returns {Promise<Object>} { plan, counters, coverage, leads, noveltyScore, coverageScore }
     */
    async runCycle({ expedition, cycle, frontierInput = null, checkpoint = null, heartbeat = null } = {}) {
        const stop = checkpoint || heartbeat || (async () => {});
        const caps = this.config.PIPELINE_CAPS;
        const usageContext = { guildId: expedition.guildId, userId: expedition.userId };
        const lens = lensConfig.getLens(expedition.lensId) || lensConfig.getLens(lensConfig.DEFAULT_LENS_ID);

        // Stage 1: what do we already know?
        const context = await this._buildContext(expedition, lens, frontierInput);
        await stop();

        // Stage 2: plan (model, deterministic fallback)
        const plan = await this._generatePlan({ expedition, lens, context, frontierInput, usageContext });
        await stop();

        // Stage 3: search (the Lens influences which source classes are sought)
        const drafts = await this._search(plan, lens, stop);
        await stop(); // before normalize/rank spends embeddings

        // Stages 4-5 + 5.5: normalize, persist, score, select, then review
        // against the seed+intent. A rejected haul gets one refined re-search
        // so a drifted Wikipedia/arxiv hit cannot become the cycle's evidence.
        const rejectedTopics = [];
        let accepted = [];
        let sourceCount = 0;
        let didRetry = false;
        const gather = async (searchDrafts) => {
            const remainingSourceBudget = Math.max(0, Math.min(
                caps.maxAcceptedSourcesPerCycle - accepted.length,
                expedition.maxSources - (expedition.sourcesAccepted || 0) - accepted.length
            ));
            const selected = await this._normalizeAndSelectSources({
                expedition, cycle, drafts: searchDrafts, plan, lens, remainingSourceBudget
            });
            sourceCount += selected.sourceCount;
            const reviewed = await this._reviewSources({
                expedition, lens, plan, accepted: selected.accepted, usageContext, stop
            });
            rejectedTopics.push(...reviewed.rejected);
            accepted.push(...reviewed.kept);
            return reviewed.kept;
        };

        await gather(drafts);
        if (accepted.length < caps.minAcceptedSourcesAfterReview && caps.maxSourceReviewRetries > 0) {
            const refined = this._refineQueries(plan, rejectedTopics, expedition);
            if (refined.length > 0) {
                didRetry = true;
                const moreDrafts = await this._search({ ...plan, searchQueries: refined }, lens, stop);
                await stop();
                await gather(moreDrafts);
            }
        }
        await stop();

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
                    summary: rejectedTopics.length > 0
                        ? 'Sources were found but none survived relevance review for this cycle.'
                        : 'No usable sources were found for this cycle.',
                    unresolvedQuestions: plan.questions,
                    coverageScore: 0,
                    noveltyScore: 0
                }, caps),
                leads: [],
                noveltyScore: 0,
                coverageScore: 0
            };
        }

        // Stages 6 + 6.5: evidence before synthesis, then drop claims that
        // drifted off the seed/intent even if their source survived review.
        let claims = await this._extractClaims({ expedition, cycle, accepted, lens, usageContext, stop });
        claims = await this._reviewClaims({
            expedition, lens, plan, claims, accepted, usageContext, stop
        });
        accepted = accepted.filter(source => !source.rejectedAfterClaims);
        counters.sourcesAccepted = accepted.length;
        counters.claimsExtracted = claims.length;

        if (claims.length === 0 && !didRetry && caps.maxSourceReviewRetries > 0) {
            const refined = this._refineQueries(plan, rejectedTopics, expedition);
            if (refined.length > 0) {
                const moreDrafts = await this._search({ ...plan, searchQueries: refined }, lens, stop);
                await stop();
                const newlyKept = await gather(moreDrafts);
                if (newlyKept.length > 0) {
                    let extra = await this._extractClaims({
                        expedition, cycle, accepted: newlyKept, lens, usageContext, stop
                    });
                    extra = await this._reviewClaims({
                        expedition, lens, plan, claims: extra, accepted: newlyKept, usageContext, stop
                    });
                    accepted = accepted.filter(source => !source.rejectedAfterClaims);
                    claims = extra;
                }
                counters.sourceCount = sourceCount;
                counters.sourcesAccepted = accepted.length;
                counters.claimsExtracted = claims.length;
            }
        }
        await stop();

        // Stages 7-11: propose knowledge, legalize, persist provenance
        if (claims.length > 0) {
            const applied = await this._generateAndLegalizeKnowledge({
                expedition, lens, context, frontierInput, claims, accepted, usageContext, counters
            });
            if (applied) {
                counters.notesCreated = Math.max(0, applied.nodesUpserted - applied.nodesMerged);
                counters.notesMerged = applied.nodesMerged;
                counters.edgesCreated = applied.linksCreated;
                counters.tagsAdded = applied.tagsApplied;
                counters.conflictsFound = applied.contradictions;
            }
        }
        await stop();

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

    async _search(plan, lens, stop) {
        const caps = this.config.PIPELINE_CAPS;
        const queries = plan.searchQueries.slice(0, caps.maxSearchQueriesUsed);
        const drafts = [];
        for (const query of queries) {
            await stop();
            const results = await this.searchService.search(query, {
                limitPerProvider: caps.maxResultsPerProviderQuery,
                preferredSourceTypes: lens.sourcePreferences
            });
            drafts.push(...results);
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
            let vector = null;
            if (anchorVector) {
                try {
                    const embedded = await this.embeddings.embed(text.slice(0, 2000));
                    if (embedded.model === anchorVector.model) {
                        relevance = clampScore((this.embeddings.cosineSimilarity(anchorVector.vector, embedded.vector) + 1) / 2, 0);
                        vector = embedded; // reused below for semantic novelty
                    } else {
                        relevance = keywordOverlap(anchorText, text);
                    }
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
            candidates.push({ draft, text, canonical, hash, relevance, quality, vector });
        }
        // Greedy selection order: strongest relevance x quality first, then
        // each candidate's novelty is judged against what is ALREADY accepted
        // (previous cycles + earlier picks this cycle), so redundant evidence
        // is rejected before claim extraction spends tokens on it.
        candidates.sort((a, b) => (b.relevance * b.quality) - (a.relevance * a.quality));

        // Evidence already in this expedition, as novelty comparators. Text
        // heads always work (lexical Jaccard); embeddings sharpen it when the
        // candidate was embedded for relevance anyway.
        const priorEvidence = (await db.all(
            `SELECT extractedText FROM research_sources
             WHERE expeditionId = @expeditionId AND accepted = 1
             ORDER BY id DESC LIMIT 60`,
            { expeditionId: expedition.id }
        )).map(row => ({ text: String(row.extractedText || '').slice(0, 2000), vector: null }));

        const acceptBudget = Math.min(caps.maxAcceptedSourcesPerCycle, remainingSourceBudget);
        const accepted = [];
        let sourceCount = 0;
        for (const candidate of candidates) {
            candidate.novelty = this._noveltyAgainst(candidate, priorEvidence);
            candidate.value = sourceValue(candidate);
            const redundant = candidate.novelty <= caps.minSourceNovelty;
            const isAccepted = accepted.length < acceptBudget
                && candidate.relevance >= caps.minSourceRelevance
                && !redundant;
            const rejectionReason = isAccepted
                ? null
                : candidate.relevance < caps.minSourceRelevance
                    ? 'below relevance threshold'
                    : redundant
                        ? 'redundant with accepted sources'
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
            if (isAccepted) {
                accepted.push({ id: sourceId, ...candidate });
                priorEvidence.push({ text: candidate.text.slice(0, 2000), vector: candidate.vector });
            }
        }
        return { accepted, sourceCount };
    }

    /**
     * Semantic novelty of a candidate against evidence this expedition has
     * already accepted (spec §13: novelty must be a first-class signal, or
     * recursion keeps re-reading the same material). Similarity is embedding
     * cosine when both sides carry vectors from the relevance pass, else
     * lexical Jaccard - each with its own fully-novel floor, mapped through
     * noveltyFromSimilarity. Deterministic and inspectable; the worst match
     * decides.
     */
    _noveltyAgainst(candidate, priorEvidence) {
        const caps = this.config.PIPELINE_CAPS;
        let novelty = 1;
        for (const prior of priorEvidence) {
            let reading;
            if (candidate.vector && prior.vector && prior.vector.model === candidate.vector.model) {
                const cosine = clampScore(this.embeddings.cosineSimilarity(candidate.vector.vector, prior.vector.vector), 0);
                reading = noveltyFromSimilarity(cosine, caps.noveltyCosineFloor);
            } else {
                reading = noveltyFromSimilarity(textSimilarity(candidate.text, prior.text), caps.noveltyLexicalFloor);
            }
            if (reading < novelty) novelty = reading;
            if (novelty === 0) break;
        }
        return novelty;
    }

    /**
     * Stage 5.5: models propose keep/drop for each tentatively accepted
     * source; code applies the verdict (or a purpose-overlap fallback when
     * the reviewer is silent). Rejected rows stay persisted with an explicit
     * reason so the UI can show why they were not used.
     */
    async _reviewSources({ expedition, lens, plan, accepted, usageContext, stop }) {
        const caps = this.config.PIPELINE_CAPS;
        if (!accepted.length) return { kept: [], rejected: [] };
        await stop();

        const purpose = {
            seed: expedition.seed,
            intent: expedition.intent,
            concepts: plan.expectedConcepts
        };
        let reviews = new Map();
        try {
            const lines = accepted.map(source => {
                const excerpt = source.text.slice(0, caps.sourceReviewExcerptChars);
                return `[source ${source.id}] "${source.draft.title || 'untitled'}" (${source.draft.url || 'no url'})\n${excerpt}`;
            });
            const prompt = [
                'Review each research source for relevance to the expedition. Output ONLY JSON:',
                '{"reviews": [{"sourceId": 1, "relevant": true, "onTopicScore": 0.0, "reason": "one short reason"}]}',
                '',
                `Seed topic: ${expedition.seed}`,
                expedition.intent
                    ? `User's intent (a source that does not serve this is irrelevant): ${expedition.intent}`
                    : null,
                `Lens: ${lens.name}.`,
                plan.questions?.length ? `This cycle's questions: ${plan.questions.join(' | ')}` : null,
                plan.expectedConcepts?.length ? `Expected concepts: ${plan.expectedConcepts.join(', ')}` : null,
                '',
                'A source is relevant only if a careful reader would use it as evidence for the seed and intent.',
                'Shared vocabulary is not enough: an article that mentions the topic in passing, as an analogy, or in a list of unrelated examples is NOT relevant.',
                `onTopicScore is 0-1. Below ${caps.minSourceReviewScore} you MUST set relevant=false.`,
                '',
                'SOURCES:',
                ...lines
            ].filter(Boolean).join('\n');
            const response = await this.ai.generateText(prompt, { max_tokens: 800, usageContext });
            reviews = clampSourceReview(parseJsonBlock(response), {
                validSourceIds: new Set(accepted.map(source => source.id))
            });
        } catch (error) {
            logger.warn?.(`[spitball] Source review failed (lexical fallback): ${error.message}`);
        }

        const kept = [];
        const rejected = [];
        for (const source of accepted) {
            const review = reviews.get(source.id);
            let keep;
            let reason;
            if (review) {
                keep = review.relevant && review.onTopicScore >= caps.minSourceReviewScore;
                reason = review.reason || (keep ? null : 'reviewer judged off-topic');
            } else {
                const overlap = purposeOverlap(purpose, `${source.draft.title || ''} ${source.text}`);
                keep = overlap >= caps.minSourceReviewFallbackOverlap;
                reason = keep
                    ? 'reviewer silent; kept by purpose overlap'
                    : 'reviewer silent; below purpose-overlap fallback';
            }
            if (keep) {
                kept.push(source);
            } else {
                await this._markSourceRejected(source.id, `review: ${reason}`);
                rejected.push({
                    id: source.id,
                    title: source.draft.title,
                    reason
                });
            }
        }
        return { kept, rejected };
    }

    async _markSourceRejected(sourceId, rejectionReason) {
        await db.run(
            `UPDATE research_sources
             SET accepted = 0, rejectionReason = @rejectionReason
             WHERE id = @id`,
            { id: sourceId, rejectionReason: String(rejectionReason || 'rejected').slice(0, 300) }
        );
    }

    /**
     * Deterministic re-search queries after a review rejection: unused plan
     * questions and the seed through the intent, never the already-tried
     * query list (those pages were just rejected).
     */
    _refineQueries(plan, rejected, expedition) {
        const caps = this.config.PIPELINE_CAPS;
        const used = new Set((plan.searchQueries || []).map(query => query.toLowerCase()));
        const queries = [];
        const add = (value) => {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            if (!text || used.has(text.toLowerCase())) return;
            used.add(text.toLowerCase());
            queries.push(text.slice(0, 200));
        };
        if (expedition.intent) add(`${expedition.seed} ${expedition.intent}`);
        for (const question of plan.questions || []) add(`${expedition.seed} ${question}`);
        for (const concept of plan.expectedConcepts || []) add(`${expedition.seed} ${concept}`);
        if (rejected.length > 0 && queries.length === 0) {
            add(`${expedition.seed} primary sources`);
        }
        return queries.slice(0, caps.maxSearchQueriesUsed);
    }

    // --- Stage 6: claim extraction ----------------------------------------------

    async _extractClaims({ expedition, cycle, accepted, lens, usageContext, stop }) {
        const caps = this.config.PIPELINE_CAPS;
        const claims = [];
        for (const source of accepted) {
            // Outside the try below: an interrupt must propagate, a model
            // failure must not.
            await stop();
            const prompt = [
                'Extract structured evidence claims from this source. Output ONLY JSON:',
                `{"claims": [{"text": "one self-contained claim", "kind": "factual|interpretive|quantitative|causal|historical|methodological|reported_opinion|hypothesis", "confidence": 0.0, "sourceLocation": "where in the source", "concepts": ["..."]}]}`,
                '',
                `Research topic: ${expedition.seed}${expedition.intent ? ` (intent: ${expedition.intent})` : ''}`,
                `Lens: ${lens.name}.${lens.epistemicPolicy.distinguishClaimFromInference ? ' Distinguish what the source SAYS from what one might infer; only extract what it says.' : ''}`,
                'Only extract claims that directly address the research topic and the user\'s intent.',
                'Skip asides, analogies, and material about unrelated domains even when the source mentions them.',
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
                try {
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
                    if (!Number.isFinite(Number(claimId))) continue;
                    claims.push({ id: claimId, sourceId: source.id, sourceTitle: source.draft.title, ...claim });
                } catch (error) {
                    logger.warn?.(`[spitball] Claim persist skipped for source #${source.id}: ${error.message}`);
                }
            }
        }
        return claims;
    }

    /**
     * Stage 6.5: drop claims that do not serve the seed/intent, even when
     * they came from an accepted source. A source whose entire haul is
     * dropped is unmarked as accepted so it cannot ground notes.
     */
    async _reviewClaims({ expedition, lens, plan, claims, accepted, usageContext, stop }) {
        if (!claims.length) return claims;
        await stop();

        let drop = new Set();
        try {
            const prompt = [
                'Which of these claims are OFF-TOPIC for the expedition? Output ONLY JSON:',
                '{"dropClaimIds": [1, 2]}',
                '',
                `Seed: ${expedition.seed}`,
                expedition.intent ? `Intent: ${expedition.intent}` : null,
                `Lens: ${lens.name}.`,
                plan.questions?.length ? `Questions this cycle set out to answer: ${plan.questions.join(' | ')}` : null,
                'Drop a claim if it does not help answer the seed/intent, even if it came from an accepted source.',
                'Keep on-topic background a reader would need. An empty drop list is a valid answer.',
                '',
                'CLAIMS:',
                ...claims.slice(0, 40).map(claim => `[claim ${claim.id}] ${claim.text}`)
            ].filter(Boolean).join('\n');
            const response = await this.ai.generateText(prompt, { max_tokens: 400, usageContext });
            drop = clampClaimReview(parseJsonBlock(response), {
                validClaimIds: new Set(claims.map(claim => claim.id))
            });
        } catch (error) {
            logger.warn?.(`[spitball] Claim review failed (keeping extracted claims): ${error.message}`);
        }
        if (drop.size === 0) return claims;

        const kept = [];
        const droppedBySource = new Map();
        for (const claim of claims) {
            if (!drop.has(claim.id)) {
                kept.push(claim);
                continue;
            }
            droppedBySource.set(claim.sourceId, (droppedBySource.get(claim.sourceId) || 0) + 1);
            try {
                await db.run('DELETE FROM research_claims WHERE id = @id', { id: claim.id });
            } catch (error) {
                logger.warn?.(`[spitball] Off-topic claim #${claim.id} delete failed: ${error.message}`);
            }
        }
        const remainingBySource = new Map();
        for (const claim of kept) {
            remainingBySource.set(claim.sourceId, (remainingBySource.get(claim.sourceId) || 0) + 1);
        }
        for (const source of accepted) {
            if ((remainingBySource.get(source.id) || 0) === 0 && droppedBySource.has(source.id)) {
                await this._markSourceRejected(source.id, 'review: all extracted claims were off-topic');
                source.rejectedAfterClaims = true;
            }
        }
        return kept;
    }

    // --- Stages 7-11: knowledge proposals through the legalizer ------------------

    async _generateAndLegalizeKnowledge({ expedition, lens, context, frontierInput, claims, accepted, usageContext, counters }) {
        const limits = kgConfig.LIMITS.research;
        // Evidence details for the deterministic confidence ceiling: each
        // claim's extraction confidence weighted by its source's quality.
        const qualityBySource = new Map((accepted || []).map(source => [source.id, source.quality]));
        const claimDetails = new Map(claims.map(claim => [claim.id, {
            confidence: claim.confidence,
            sourceId: claim.sourceId,
            sourceQuality: qualityBySource.get(claim.sourceId)
        }]));
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
            '- Every note MUST cite the claimIds it is grounded in. A note citing no claims is DISCARDED.',
            '- Write ONLY notes that serve the seed and the user\'s intent. Ignore claims that drifted off-topic.',
            '- confidence reflects the underlying claims (corroboration raises it, single synthesis lowers it); it is capped deterministically by the evidence you cite, so inflating it does nothing.',
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
                claimDetails,
                requireClaims: true,
                nodeTypes: kgConfig.NODE_TYPES,
                maxNotes: limits.maxMutationsUpsert,
                maxLinks: limits.maxMutationsLink
            });
        } catch (error) {
            logger.warn?.(`[spitball] Knowledge generation failed: ${error.message}`);
        }
        if (!proposals) return null;
        if (proposals.droppedForNoEvidence > 0) {
            logger.warn?.(`[spitball] Dropped ${proposals.droppedForNoEvidence} note proposal(s) citing no claims (expedition #${expedition.id})`);
        }
        counters.notesProposed = proposals.upsert.length + (proposals.droppedForNoEvidence || 0);

        try {
            return await this.kg.applyMutations({
                guildId: expedition.guildId,
                scopeKey: expedition.scopeKey,
                subjectType: 'USER',
                subjectId: expedition.userId,
                source: 'research',
                limits,
                provenance: { sourceKind: 'expedition', sourceId: expedition.id },
                mutations: proposals
            });
        } catch (error) {
            // A legalizer write must not fail the expedition (a stale node id
            // after prune used to surface as FOREIGN KEY constraint failed).
            logger.warn?.(`[spitball] Knowledge legalizer failed: ${error.message}`);
            return null;
        }
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
