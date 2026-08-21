/**
 * Pure helpers for Spitball Expedition research: source normalization,
 * inspectable scoring pieces, and the strict-JSON clamps for every model
 * stage output (plan, claims, knowledge proposals, coverage, Leads).
 * Spec: documentation/spitball_expeditions.md
 *
 * No I/O here (the attentionScore/optionsMath separation): everything is
 * deterministic and unit-testable. Model output passes through these clamps
 * before anything downstream trusts it - structure validated, arrays capped,
 * scores clamped, strings trimmed, unknown enum values coerced or dropped,
 * malformed output degrading to null rather than partial writes.
 */

const crypto = require('node:crypto');

const CLAIM_KINDS = [
    'factual', 'interpretive', 'quantitative', 'causal',
    'historical', 'methodological', 'reported_opinion', 'hypothesis'
];

const LEAD_KINDS = [
    'subtopic', 'open_question', 'contradiction', 'missing_evidence',
    'primary_source', 'mechanism', 'cross_domain_connection',
    'historical_gap', 'method', 'person'
];

/** Tracking params that never identify a document. */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid|igshid|ref_src)/;

/**
 * Canonical form of a source URL: https, lowercase host, no fragment, no
 * tracking params, no trailing slash. Returns null for unusable input.
 * @param {string} url
 * @returns {string|null}
 */
function canonicalizeUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return null;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return null;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    const params = [...parsed.searchParams.keys()];
    for (const key of params) {
        if (TRACKING_PARAMS.test(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    let text = parsed.toString();
    if (text.endsWith('/') && parsed.pathname === '/' && !parsed.search) text = text.slice(0, -1);
    return text.slice(0, 500);
}

/** Stable content hash for dedupe (whitespace-insensitive). */
function contentHash(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) return null;
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

/** Clamp a number into [0, 1]; non-numbers become the fallback. */
function clampScore(value, fallback = 0.5) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
}

function cleanString(value, max) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, max) : null;
}

function cleanStringArray(value, { maxItems, maxLength }) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
        const text = cleanString(item, maxLength);
        if (text && !out.some(existing => existing.toLowerCase() === text.toLowerCase())) {
            out.push(text);
        }
        if (out.length >= maxItems) break;
    }
    return out;
}

/**
 * Deterministic keyword-overlap relevance in [0, 1]: the fallback scorer when
 * embeddings are unavailable. Fraction of distinct query terms (>2 chars)
 * present in the text.
 */
function keywordOverlap(queryText, documentText) {
    const terms = [...new Set(String(queryText || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2))];
    if (terms.length === 0) return 0;
    const haystack = String(documentText || '').toLowerCase();
    let hits = 0;
    for (const term of terms) {
        if (haystack.includes(term)) hits += 1;
    }
    return hits / terms.length;
}

/**
 * The inspectable source-selection score (spec §13):
 * relevance × quality × novelty. All inputs already clamped to [0, 1].
 */
function sourceValue({ relevance, quality, novelty }) {
    return clampScore(relevance, 0) * clampScore(quality, 0.5) * clampScore(novelty, 1);
}

/** Research plan clamp (stage 2). Returns null when unusably malformed. */
function clampPlan(parsed, caps) {
    if (!parsed || typeof parsed !== 'object') return null;
    const plan = {
        questions: cleanStringArray(parsed.questions, { maxItems: caps.maxQuestionsPerPlan, maxLength: 300 }),
        searchQueries: cleanStringArray(parsed.searchQueries, { maxItems: caps.maxSearchQueriesPerPlan, maxLength: 200 }),
        expectedConcepts: cleanStringArray(parsed.expectedConcepts, { maxItems: 20, maxLength: 120 }),
        relationshipTargets: cleanStringArray(parsed.relationshipTargets, { maxItems: 15, maxLength: 60 }),
        excludeTerms: cleanStringArray(parsed.excludeTerms, { maxItems: 10, maxLength: 60 })
    };
    if (plan.searchQueries.length === 0) return null;
    return plan;
}

/** Claim-extraction clamp (stage 6). Always returns an array (possibly empty). */
function clampClaims(parsed, caps) {
    const rows = Array.isArray(parsed?.claims) ? parsed.claims : Array.isArray(parsed) ? parsed : [];
    const out = [];
    for (const row of rows) {
        const text = cleanString(row?.text, 500);
        if (!text) continue;
        out.push({
            text,
            kind: CLAIM_KINDS.includes(row?.kind) ? row.kind : 'factual',
            confidence: clampScore(row?.confidence, 0.5),
            sourceLocation: cleanString(row?.sourceLocation, 120),
            concepts: cleanStringArray(row?.concepts, { maxItems: 8, maxLength: 120 })
        });
        if (out.length >= caps.maxClaimsPerSource) break;
    }
    return out;
}

/**
 * Knowledge-proposal clamp (stages 8-10): note upserts (with claim
 * references), typed connections, and contradictions - shaped for the graph
 * legalizer, which stays the final authority.
 * @param {Object} parsed - model output
 * @param {Object} params - { validClaimIds: Set<number>, nodeTypes: string[], maxNotes, maxLinks }
 */
function clampKnowledgeProposals(parsed, { validClaimIds, nodeTypes, maxNotes, maxLinks }) {
    const source = parsed?.mutations && typeof parsed.mutations === 'object' ? parsed.mutations : parsed;
    if (!source || typeof source !== 'object') return null;

    const upsert = [];
    for (const node of Array.isArray(source.upsert) ? source.upsert : []) {
        const label = cleanString(node?.label, 120);
        if (!label) continue;
        const claimIds = (Array.isArray(node?.claimIds) ? node.claimIds : [])
            .map(Number)
            .filter(id => validClaimIds.has(id))
            .slice(0, 8);
        upsert.push({
            type: nodeTypes.includes(node?.type) ? node.type : 'concept',
            label,
            content: cleanString(node?.content, 1000),
            salience: clampScore(node?.salience, 0.5),
            confidence: clampScore(node?.confidence, 0.5),
            tags: cleanStringArray(node?.tags, { maxItems: 6, maxLength: 40 }),
            claimIds
        });
        if (upsert.length >= maxNotes) break;
    }

    const link = [];
    for (const edge of Array.isArray(source.link) ? source.link : []) {
        const from = cleanString(edge?.source, 120);
        const to = cleanString(edge?.target, 120);
        const relation = cleanString(edge?.relation, 60);
        if (!from || !to || !relation || from.toLowerCase() === to.toLowerCase()) continue;
        link.push({
            source: from,
            target: to,
            relation,
            relationKind: ['causal', 'logical', 'associative', 'temporal', 'social'].includes(edge?.relationKind)
                ? edge.relationKind
                : null,
            weight: clampScore(edge?.weight, 0.5)
        });
        if (link.length >= maxLinks) break;
    }

    const contradict = [];
    for (const pair of Array.isArray(source.contradict) ? source.contradict : []) {
        const from = cleanString(pair?.source, 120);
        const to = cleanString(pair?.target, 120);
        if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
        contradict.push({ source: from, target: to });
        if (contradict.length >= 4) break;
    }

    if (upsert.length === 0 && link.length === 0 && contradict.length === 0) return null;
    return { upsert, link, contradict };
}

/** Coverage-evaluation clamp (stage 13). Never null: degrades to a shell. */
function clampCoverage(parsed, caps) {
    const src = parsed && typeof parsed === 'object' ? parsed : {};
    return {
        summary: cleanString(src.summary, 1000),
        coveredQuestions: cleanStringArray(src.coveredQuestions, { maxItems: caps.maxQuestionsPerPlan, maxLength: 300 }),
        partiallyCoveredQuestions: cleanStringArray(src.partiallyCoveredQuestions, { maxItems: caps.maxQuestionsPerPlan, maxLength: 300 }),
        unresolvedQuestions: cleanStringArray(src.unresolvedQuestions, { maxItems: caps.maxQuestionsPerPlan, maxLength: 300 }),
        majorNewConcepts: cleanStringArray(src.majorNewConcepts, { maxItems: 15, maxLength: 120 }),
        conflicts: cleanStringArray(src.conflicts, { maxItems: 8, maxLength: 300 }),
        coverageScore: clampScore(src.coverageScore, 0),
        noveltyScore: clampScore(src.noveltyScore, 0)
    };
}

/**
 * Lead clamp + deterministic ranking (stage 14):
 * leadValue = relevance × novelty × uncertainty (expectedValue when the model
 * omitted it). Always sorted best-first, capped.
 */
function clampLeads(parsed, caps) {
    const rows = Array.isArray(parsed?.leads) ? parsed.leads : Array.isArray(parsed) ? parsed : [];
    const out = [];
    for (const row of rows) {
        const topic = cleanString(row?.topic, 200);
        if (!topic) continue;
        const relevance = clampScore(row?.relevance, 0.5);
        const novelty = clampScore(row?.novelty, 0.5);
        const uncertainty = clampScore(row?.uncertainty, 0.5);
        const expectedValue = Number.isFinite(Number(row?.expectedValue))
            ? clampScore(row.expectedValue, 0)
            : clampScore(relevance * novelty * uncertainty, 0);
        out.push({
            topic,
            kind: LEAD_KINDS.includes(row?.kind) ? row.kind : 'subtopic',
            reason: cleanString(row?.reason, 300),
            relevance,
            novelty,
            uncertainty,
            expectedValue,
            suggestedQueries: cleanStringArray(row?.suggestedQueries, { maxItems: 4, maxLength: 200 })
        });
    }
    out.sort((a, b) => b.expectedValue - a.expectedValue);
    return out.slice(0, caps.maxLeadsPerCycle);
}

module.exports = {
    CLAIM_KINDS,
    LEAD_KINDS,
    canonicalizeUrl,
    contentHash,
    clampScore,
    cleanString,
    cleanStringArray,
    keywordOverlap,
    sourceValue,
    clampPlan,
    clampClaims,
    clampKnowledgeProposals,
    clampCoverage,
    clampLeads
};
