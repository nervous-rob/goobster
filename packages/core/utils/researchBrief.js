/**
 * Pure helpers for Spitball Expedition research briefs: infer how wide and
 * deep a run should search from the seed + intent, keep a roster of coverage
 * units, diversify queries/sources away from already-covered units, floor
 * coverage when the intent is still incomplete, and decide whether more
 * cycles should be proposed at a stop.
 *
 * No I/O (the researchSources / attentionScore separation). Models may
 * propose a roster; these clamps and the continuation policy own the
 * numbers. Spec: documentation/spitball_expeditions.md
 */

const { cleanString, cleanStringArray, clampScore, textSimilarity } = require('./researchSources');

const RESEARCH_SHAPES = ['survey', 'timeline', 'deep_dive', 'comparison', 'default'];
const DEPTH_PER_UNIT = ['shallow', 'medium', 'deep'];
const UNIT_KINDS = ['person', 'concept', 'event', 'work', 'mixed'];

const SURVEY_RE = /\b(all|every|each|complete|comprehensive|catalog(?:ue)?|roster|list of|map of|overview of|survey of|most important|key figures|key people|important figures|who (?:were|are|was))\b/i;
const PEOPLE_RE = /\b(figures?|people|persons|scientists?|physicists?|mathematicians?|thinkers?|pioneers?|founders?|who)\b/i;
const TIMELINE_RE = /\b(history|historical|evolution|evolved|timeline|predecessors?|lineage|led to|leads? to|leading to)\b/i;
const DEEP_RE = /\b(how does|how do|how did|mechanism|explain|understand|why does|derive|proof|in depth|deep dive|details of)\b/i;
const COMPARE_RE = /\b(vs\.?|versus|compare|comparison|difference between|contrast)\b/i;

const VARIETY_BY_SHAPE = {
    survey: { focused: 6, standard: 12, deep: 18 },
    timeline: { focused: 4, standard: 8, deep: 14 },
    comparison: { focused: 2, standard: 3, deep: 4 },
    deep_dive: { focused: 2, standard: 3, deep: 4 },
    default: { focused: 3, standard: 5, deep: 8 }
};

const DEPTH_PER_UNIT_BY_SHAPE = {
    survey: 'shallow',
    timeline: 'medium',
    comparison: 'medium',
    deep_dive: 'deep',
    default: 'medium'
};

function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function combinedPurpose(seed, intent) {
    return [seed, intent].filter(Boolean).join(' ');
}

/**
 * Infer the research shape from seed + intent. Comparison wins over survey
 * (a "compare all X vs Y" is still a comparison); survey wins over timeline
 * when the wording asks for a roster ("history of all the most important
 * figures"); otherwise timeline / deep-dive / default.
 */
function inferResearchShape(seed, intent) {
    const text = combinedPurpose(seed, intent);
    if (!text.trim()) return 'default';
    if (COMPARE_RE.test(text)) return 'comparison';
    if (SURVEY_RE.test(text) || (PEOPLE_RE.test(text) && /\b(all|every|most|important|key)\b/i.test(text))) {
        return 'survey';
    }
    if (TIMELINE_RE.test(text)) return 'timeline';
    if (DEEP_RE.test(text)) return 'deep_dive';
    return 'default';
}

function inferUnitKind(seed, intent, shape) {
    const text = combinedPurpose(seed, intent);
    if (PEOPLE_RE.test(text) || shape === 'survey' && /\bwho\b/i.test(text)) return 'person';
    if (TIMELINE_RE.test(text) && /\b(event|war|revolution|discovery)\b/i.test(text)) return 'event';
    return 'mixed';
}

function varietyTargetFor(shape, depth) {
    const table = VARIETY_BY_SHAPE[shape] || VARIETY_BY_SHAPE.default;
    return table[depth] || table.standard;
}

/**
 * Deterministic research brief from seed + intent + depth. No roster of
 * named units — those come from a model enrichment or from units discovered
 * during cycles — but shape, variety target, and search strategy are set
 * before the first query is planned.
 */
function inferResearchBrief(seed, intent, depth = 'standard') {
    const shape = inferResearchShape(seed, intent);
    const cleanDepth = ['focused', 'standard', 'deep'].includes(depth) ? depth : 'standard';
    const unitKind = inferUnitKind(seed, intent, shape);
    const varietyTarget = varietyTargetFor(shape, cleanDepth);
    const depthPerUnit = DEPTH_PER_UNIT_BY_SHAPE[shape] || 'medium';
    return clampResearchBrief({
        shape,
        varietyTarget,
        depthPerUnit,
        unitKind,
        coverageUnits: [],
        searchStrategy: defaultSearchStrategy(shape, unitKind, varietyTarget)
    });
}

function defaultSearchStrategy(shape, unitKind, varietyTarget) {
    if (shape === 'survey' && unitKind === 'person') {
        return `Enumerate a roster of ~${varietyTarget} distinct people the intent implies and spread searches across them. Do not linger on one famous name.`;
    }
    if (shape === 'survey') {
        return `Cover ~${varietyTarget} distinct facets of the topic. Each query should target a different facet, not restate the seed.`;
    }
    if (shape === 'timeline') {
        return `Walk the lineage in order. Spread queries across eras and predecessors instead of deepening the most famous node.`;
    }
    if (shape === 'comparison') {
        return 'Give each side of the comparison its own queries and sources; do not collapse onto one pole.';
    }
    if (shape === 'deep_dive') {
        return 'Stay on the mechanism or explanation the intent asked for; prefer depth on that unit over a wide roster.';
    }
    return 'Let the seed set the center of gravity and the intent set how wide to roam.';
}

function clampUnit(raw) {
    const label = cleanString(raw?.label ?? raw?.name ?? raw, 120);
    if (!label) return null;
    const kind = UNIT_KINDS.includes(raw?.kind) ? raw.kind : 'concept';
    return { label, kind };
}

/**
 * Clamp a (possibly model-produced) research brief. Malformed input degrades
 * to a deterministic shell rather than null — later stages always have a
 * brief to read.
 */
function clampResearchBrief(parsed, { maxUnits = 24 } = {}) {
    const src = parsed && typeof parsed === 'object' ? parsed : {};
    const shape = RESEARCH_SHAPES.includes(src.shape) ? src.shape : 'default';
    const depthPerUnit = DEPTH_PER_UNIT.includes(src.depthPerUnit) ? src.depthPerUnit : (DEPTH_PER_UNIT_BY_SHAPE[shape] || 'medium');
    const unitKind = UNIT_KINDS.includes(src.unitKind) ? src.unitKind : 'mixed';
    const variety = Number(src.varietyTarget);
    const units = [];
    const rawUnits = Array.isArray(src.coverageUnits) ? src.coverageUnits : [];
    for (const row of rawUnits) {
        const unit = clampUnit(row);
        if (!unit) continue;
        if (units.some(existing => sameUnit(existing.label, unit.label))) continue;
        units.push(unit);
        if (units.length >= maxUnits) break;
    }
    return {
        shape,
        varietyTarget: Number.isFinite(variety)
            ? Math.min(24, Math.max(1, Math.round(variety)))
            : varietyTargetFor(shape, 'standard'),
        depthPerUnit,
        unitKind,
        coverageUnits: units,
        searchStrategy: cleanString(src.searchStrategy, 400) || defaultSearchStrategy(shape, unitKind, varietyTargetFor(shape, 'standard'))
    };
}

function sameUnit(a, b) {
    const left = String(a || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const right = String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!left || !right) return false;
    if (left === right) return true;
    return unitMentioned(left, right) && unitMentioned(right, left);
}

/**
 * Whether `haystack` refers to a coverage unit. Full-phrase match, or the
 * last significant token of a multi-word name (so "Albert Einstein" hits
 * a page titled "Einstein") when that token is long enough to be specific.
 */
function unitMentioned(haystack, label) {
    const text = String(haystack || '');
    const full = String(label || '').replace(/\s+/g, ' ').trim();
    if (!text || !full) return false;
    if (text.toLowerCase().includes(full.toLowerCase())) return true;
    const tokens = full.split(/\s+/).filter(token => token.replace(/[.]/g, '').length > 2);
    if (tokens.length === 0) return false;
    const last = tokens[tokens.length - 1].replace(/[.]/g, '');
    if (last.length < 4) return false;
    return new RegExp(`\\b${escapeRegExp(last)}\\b`, 'i').test(text);
}

function matchCoveredUnits(units, haystacks) {
    const list = Array.isArray(units) ? units : [];
    const piles = Array.isArray(haystacks) ? haystacks.filter(Boolean) : [];
    return list.filter(unit => piles.some(hay => unitMentioned(hay, unit.label)));
}

/**
 * Progress of a brief against evidence already in hand. Coverage is
 * `coveredCount / target`, where target is the larger of the intent's
 * varietyTarget and the roster length — a survey that only named two
 * people is still incomplete.
 */
function coverageProgress(brief, { haystacks = [], extraCoveredLabels = [] } = {}) {
    const safe = clampResearchBrief(brief);
    const piles = [...haystacks, ...extraCoveredLabels].filter(Boolean);
    const coveredFromRoster = matchCoveredUnits(safe.coverageUnits, piles);
    const discovered = [];
    for (const label of extraCoveredLabels) {
        const text = cleanString(label, 120);
        if (!text) continue;
        if (coveredFromRoster.some(unit => sameUnit(unit.label, text))) continue;
        if (discovered.some(unit => sameUnit(unit.label, text))) continue;
        discovered.push({ label: text, kind: safe.unitKind === 'person' ? 'person' : 'concept' });
    }
    const coveredUnits = [...coveredFromRoster, ...discovered];
    const uncoveredUnits = safe.coverageUnits.filter(unit =>
        !coveredUnits.some(covered => sameUnit(covered.label, unit.label)));
    const coveredCount = coveredUnits.length;
    const target = Math.max(safe.varietyTarget, safe.coverageUnits.length, 1);
    const wide = safe.shape === 'survey' || safe.shape === 'timeline';
    // A default/deep-dive run without an explicit roster is not "incomplete"
    // just because varietyTarget > concepts found — that would block NO_LEADS.
    const rosterIncomplete = wide
        ? coveredCount < target
        : (safe.coverageUnits.length > 0 && uncoveredUnits.length > 0);
    return {
        brief: safe,
        coveredUnits,
        uncoveredUnits,
        coveredCount,
        target,
        rosterIncomplete,
        coverageFloor: rosterIncomplete ? clampScore(coveredCount / target, 0) : null
    };
}

function mergeRoster(brief, discoveredLabels, { maxUnits = 24 } = {}) {
    const safe = clampResearchBrief(brief, { maxUnits });
    const units = [...safe.coverageUnits];
    for (const label of discoveredLabels || []) {
        const text = cleanString(label, 120);
        if (!text) continue;
        if (units.some(unit => sameUnit(unit.label, text))) continue;
        units.push({ label: text, kind: safe.unitKind === 'person' ? 'person' : 'concept' });
        if (units.length >= maxUnits) break;
    }
    return { ...safe, coverageUnits: units };
}

/**
 * How many search queries a cycle should actually fire. High-variety
 * intents get more query slots (capped by maxSearchQueriesPerPlan) so a
 * survey is not forced through five Einstein-shaped searches.
 */
function searchQueryBudget(brief, caps = {}) {
    const base = Number(caps.maxSearchQueriesUsed);
    const planCap = Number(caps.maxSearchQueriesPerPlan);
    const floor = Number.isFinite(base) && base > 0 ? base : 5;
    const ceiling = Number.isFinite(planCap) && planCap > 0 ? planCap : 10;
    const target = Number(brief?.varietyTarget) || 0;
    if (target <= 4) return Math.min(floor, ceiling);
    const extra = Math.ceil((target - 4) / 4);
    return Math.min(ceiling, floor + extra);
}

/** How many accepted sources may cluster on one coverage unit this cycle. */
function maxSourcesPerUnit(brief) {
    if (!brief) return Number.POSITIVE_INFINITY;
    if (brief.depthPerUnit === 'shallow') return 2;
    if (brief.depthPerUnit === 'medium') return 3;
    return 8;
}

function intentQuerySeeds(seed, intent, brief, coveredLabels = []) {
    const topic = cleanString(seed, 120) || 'the topic';
    const shape = brief?.shape || inferResearchShape(seed, intent);
    const unitKind = brief?.unitKind || inferUnitKind(seed, intent, shape);
    const queries = [];
    if (shape === 'survey' || unitKind === 'person') {
        queries.push(`most important figures in ${topic}`);
        queries.push(`pioneers of ${topic}`);
        if (coveredLabels.length) {
            queries.push(`${topic} figures besides ${coveredLabels[0]}`);
        }
    }
    if (shape === 'timeline' || TIMELINE_RE.test(combinedPurpose(seed, intent))) {
        queries.push(`history of ${topic}`);
        queries.push(`predecessors of ${topic}`);
    }
    if (shape === 'comparison') {
        queries.push(`${topic} comparison`);
    }
    if (intent) queries.push(`${topic} ${cleanString(intent, 80)}`);
    return queries;
}

/**
 * Keep queries that spread across the intent. Near-duplicates drop;
 * queries that only name already-covered units yield to uncovered-unit
 * and intent-seed queries.
 */
function shouldDiversifyQueries(brief, queries = [], coveredLabels = [], uncoveredUnits = []) {
    if (brief?.shape === 'survey' || brief?.shape === 'timeline') return true;
    if (coveredLabels.length || uncoveredUnits.length) return true;
    for (let i = 0; i < queries.length; i += 1) {
        for (let j = i + 1; j < queries.length; j += 1) {
            if (textSimilarity(queries[i], queries[j]) > 0.62) return true;
        }
    }
    return false;
}

function diversifySearchQueries(queries, {
    coveredLabels = [],
    uncoveredUnits = [],
    seed,
    intent,
    brief = null,
    maxQueries = 5,
    fillFromIntent = null
} = {}) {
    const out = [];
    const used = new Set();
    const add = (value) => {
        const text = cleanString(value, 200);
        if (!text || out.length >= maxQueries) return false;
        const key = text.toLowerCase();
        if (used.has(key)) return false;
        if (out.some(existing => textSimilarity(existing, text) > 0.62)) return false;
        used.add(key);
        out.push(text);
        return true;
    };

    const preferred = [];
    const coveredFocused = [];
    for (const query of queries || []) {
        const hitsCovered = coveredLabels.some(label => unitMentioned(query, label));
        const hitsUncovered = uncoveredUnits.some(unit => unitMentioned(query, unit.label));
        if (hitsCovered && !hitsUncovered && coveredLabels.length) coveredFocused.push(query);
        else preferred.push(query);
    }
    for (const query of preferred) add(query);

    // At most one already-covered query, and only if the haul is still thin.
    if (coveredFocused.length && out.length < Math.max(1, Math.floor(maxQueries / 3))) {
        add(coveredFocused[0]);
    }
    for (const unit of uncoveredUnits) {
        add(`${unit.label} ${seed}`);
    }
    const useIntentSeeds = fillFromIntent == null
        ? (brief?.shape === 'survey' || brief?.shape === 'timeline' || uncoveredUnits.length > 0)
        : fillFromIntent;
    if (useIntentSeeds) {
        for (const query of intentQuerySeeds(seed, intent, brief, coveredLabels)) {
            add(query);
        }
    }
    // Do not refill leftover slots with more already-covered queries when
    // the intent still has uncovered units (or is a survey/timeline).
    const allowMoreCovered = uncoveredUnits.length === 0
        && brief?.shape !== 'survey'
        && brief?.shape !== 'timeline';
    if (allowMoreCovered) {
        for (const query of coveredFocused.slice(1)) add(query);
    }
    return out;
}

function primaryUnitsInSource(title, text, units) {
    const list = Array.isArray(units) ? units : [];
    const inTitle = list.filter(unit => unitMentioned(title, unit.label));
    if (inTitle.length) return inTitle;
    return list.filter(unit => unitMentioned(text, unit.label));
}

/**
 * Reject a source that would deepen an already-covered unit while the
 * intent's roster is still incomplete, or that would exceed the per-unit
 * source cap for this cycle.
 * @returns {string|null} rejection reason, or null to keep scoring
 */
function sourceVarietyRejection({
    title,
    text,
    units = [],
    coveredLabels = [],
    acceptedUnitCounts = new Map(),
    maxPerUnit = 2,
    rosterIncomplete = false
} = {}) {
    const roster = units.length
        ? units
        : coveredLabels.map(label => ({ label, kind: 'concept' }));
    if (!roster.length) return null;
    const primary = primaryUnitsInSource(title, text, roster);
    if (!primary.length) return null;
    const allCovered = primary.every(unit =>
        coveredLabels.some(label => sameUnit(label, unit.label)));
    if (allCovered && rosterIncomplete) return 'already-covered topic';
    for (const unit of primary) {
        const key = unit.label.toLowerCase();
        if ((acceptedUnitCounts.get(key) || 0) >= maxPerUnit) return 'unit source cap';
    }
    return null;
}

function significantNameTokens(text) {
    return String(text || '').split(/[^A-Za-z]+/).filter(token => token.length >= 5);
}

function shareSignificantName(a, b) {
    const other = new Set(significantNameTokens(b).map(token => token.toLowerCase()));
    if (other.size === 0) return false;
    return significantNameTokens(a).some(token => other.has(token.toLowerCase()));
}

/** Title-level cluster cap when the roster is still empty (cycle 1). */
function titleClusterRejection(title, acceptedTitles = [], maxPerCluster = 2) {
    const incoming = cleanString(title, 300);
    if (!incoming) return null;
    let similar = 0;
    for (const other of acceptedTitles) {
        if (textSimilarity(incoming, other) >= 0.35 || shareSignificantName(incoming, other)) {
            similar += 1;
        }
    }
    return similar >= maxPerCluster ? 'redundant topic cluster' : null;
}

function recordAcceptedUnits(acceptedUnitCounts, title, text, units) {
    const primary = primaryUnitsInSource(title, text, units);
    for (const unit of primary) {
        const key = unit.label.toLowerCase();
        acceptedUnitCounts.set(key, (acceptedUnitCounts.get(key) || 0) + 1);
    }
    return acceptedUnitCounts;
}

/**
 * A cycle must not claim the original purpose is covered when the brief's
 * roster is still short of its variety target. Floors the model's
 * coverageScore (never raises it).
 */
function floorCoverageAgainstBrief(coverage, progress) {
    if (!coverage || typeof coverage !== 'object' || !progress) return coverage;
    const floored = Number.isFinite(progress.coverageFloor)
        ? Math.min(clampScore(coverage.coverageScore, 0), progress.coverageFloor)
        : clampScore(coverage.coverageScore, 0);
    // Incomplete rosters must stay under the continuation ceiling (0.9).
    const coverageScore = progress.rosterIncomplete ? Math.min(floored, 0.85) : floored;
    const searchGaps = Array.isArray(coverage.searchGaps) ? [...coverage.searchGaps] : [];
    for (const unit of progress.uncoveredUnits || []) {
        const gap = `${unit.label} (not yet researched)`;
        if (!searchGaps.some(existing => unitMentioned(existing, unit.label))) {
            searchGaps.push(gap);
        }
    }
    return { ...coverage, coverageScore, searchGaps };
}

/**
 * Deterministic Leads for units the intent still requires. Used when the
 * model returns none (or only already-covered topics) so a survey cannot
 * stop with NO_LEADS after lingering on two names.
 */
function synthesizeLeadsForUncovered({
    uncoveredUnits = [],
    coveredLabels = [],
    brief = null,
    seed,
    maxLeads = 8,
    minLeadValue = 0.2
} = {}) {
    const leads = [];
    const push = (lead) => {
        if (!lead || leads.length >= maxLeads) return;
        if (lead.expectedValue < minLeadValue) return;
        if (leads.some(existing => sameUnit(existing.topic, lead.topic))) return;
        leads.push(lead);
    };
    for (const unit of uncoveredUnits) {
        push({
            topic: unit.label,
            kind: unit.kind === 'person' ? 'person' : 'subtopic',
            reason: `The intent still needs this ${unit.kind || 'topic'}; it has not been researched yet.`,
            relevance: 0.85,
            novelty: 0.8,
            uncertainty: 0.7,
            expectedValue: clampScore(0.85 * 0.8 * 0.7, 0),
            suggestedQueries: [
                `${unit.label} ${seed || ''}`.trim(),
                `${unit.label} ${brief?.shape === 'timeline' ? 'history' : 'overview'}`
            ]
        });
    }
    const target = Number(brief?.varietyTarget) || 0;
    if (!leads.length && target > coveredLabels.length) {
        const kind = brief?.unitKind === 'person' ? 'figures' : 'topics';
        const besides = coveredLabels.slice(0, 3).join(', ');
        push({
            topic: besides ? `other ${kind} besides ${besides}` : `additional ${kind} for ${seed || 'this topic'}`,
            kind: brief?.unitKind === 'person' ? 'person' : 'subtopic',
            reason: `Covered ${coveredLabels.length} of ~${target} distinct ${kind} the intent implies.`,
            relevance: 0.8,
            novelty: 0.75,
            uncertainty: 0.7,
            expectedValue: clampScore(0.8 * 0.75 * 0.7, 0),
            suggestedQueries: intentQuerySeeds(seed, null, brief, coveredLabels).slice(0, 3)
        });
    }
    return leads;
}

function mergeLeads(modelLeads, synthesized, { coveredLabels = [], maxLeads = 8, minLeadValue = 0.2 } = {}) {
    const out = [];
    const push = (lead, { enforceMin = false } = {}) => {
        if (!lead?.topic || out.length >= maxLeads) return;
        const value = Number(lead.expectedValue);
        if (enforceMin && Number.isFinite(value) && value < minLeadValue) return;
        if (out.some(existing => sameUnit(existing.topic, lead.topic))) return;
        out.push(lead);
    };
    const coveredFocused = [];
    for (const lead of modelLeads || []) {
        const aboutCovered = coveredLabels.some(label => unitMentioned(lead.topic, label));
        if (aboutCovered) coveredFocused.push(lead);
        else push(lead);
    }
    for (const lead of synthesized || []) push(lead, { enforceMin: true });
    // Keep already-covered leads only when nothing else is on the frontier.
    if (out.length === 0) {
        for (const lead of coveredFocused) push(lead);
    }
    const uncovered = [];
    const covered = [];
    for (const lead of out) {
        if (coveredLabels.some(label => unitMentioned(lead.topic, label))) covered.push(lead);
        else uncovered.push(lead);
    }
    uncovered.sort((a, b) => (b.expectedValue || 0) - (a.expectedValue || 0));
    covered.sort((a, b) => (b.expectedValue || 0) - (a.expectedValue || 0));
    return [...uncovered, ...covered].slice(0, maxLeads);
}

function unitsPerCycle(brief) {
    const target = Number(brief?.varietyTarget) || 5;
    if (brief?.depthPerUnit === 'shallow') return Math.max(3, Math.min(6, Math.round(target / 3)));
    if (brief?.depthPerUnit === 'deep') return 2;
    return 3;
}

/**
 * Whether the stop left the original intent unfinished, and how many more
 * cycles would be a fair next slice. Budget stops (MAX_*) propose whenever
 * coverage is incomplete; quality stops only propose when the roster is
 * still short — a clean NO_LEADS on a finished deep-dive must not nag.
 */
function buildContinuationProposal({
    stopReason,
    progress = null,
    gaps = [],
    leads = [],
    coverageScore = null,
    coverageCeiling = 0.9,
    expedition = {},
    hardMaxCycles = 12
} = {}) {
    const budgetStop = ['MAX_CYCLES', 'MAX_NOTES', 'MAX_SOURCES'].includes(stopReason);
    const qualityStop = ['NO_LEADS', 'NOVELTY_SATURATED'].includes(stopReason);
    if (!budgetStop && !qualityStop) return { needed: false };

    const uncovered = (progress?.uncoveredUnits || []).map(unit => unit.label);
    const rosterIncomplete = Boolean(progress?.rosterIncomplete);
    const coverage = Number(coverageScore);
    const coverageIncomplete = Number.isFinite(coverage) && coverage < coverageCeiling
        && (gaps.length > 0 || (Array.isArray(leads) && leads.length > 0) || rosterIncomplete);
    const incomplete = rosterIncomplete || uncovered.length > 0 || coverageIncomplete;
    if (!incomplete) return { needed: false };
    if (qualityStop && !rosterIncomplete && uncovered.length === 0) return { needed: false };

    const remainingRoom = Math.max(0, Number(hardMaxCycles) - Number(expedition.maxCycles || 0));
    const remainingUnits = Math.max(
        uncovered.length,
        (progress?.target || 0) - (progress?.coveredCount || 0),
        gaps.length > 0 ? 3 : 0
    );
    const suggested = remainingRoom > 0
        ? Math.min(remainingRoom, Math.max(1, Math.ceil(remainingUnits / unitsPerCycle(progress?.brief))))
        : 0;
    const coveredLabels = (progress?.coveredUnits || []).map(unit => unit.label);
    const summary = rosterIncomplete
        ? `Covered ${progress.coveredCount} of ~${progress.target} distinct topics the intent implies${coveredLabels.length ? ` (so far: ${coveredLabels.slice(0, 6).join(', ')})` : ''}.`
        : (gaps[0] ? `Stopped with open gaps, starting with: ${gaps[0]}` : 'The original intent is not fully covered yet.');

    return {
        needed: true,
        extendable: remainingRoom > 0 && suggested > 0,
        reason: stopReason,
        suggestedCycles: suggested,
        uncoveredUnits: uncovered.slice(0, 16),
        remainingGaps: gaps.slice(0, 8),
        coveredCount: progress?.coveredCount || 0,
        varietyTarget: progress?.target || 0,
        summary
    };
}

function clampContinuationProposal(parsed) {
    if (!parsed || parsed.needed !== true) return { needed: false };
    return {
        needed: true,
        extendable: parsed.extendable !== false && Number(parsed.suggestedCycles) > 0,
        reason: cleanString(parsed.reason, 40),
        suggestedCycles: Math.min(12, Math.max(0, Math.round(Number(parsed.suggestedCycles) || 0))),
        uncoveredUnits: cleanStringArray(parsed.uncoveredUnits, { maxItems: 16, maxLength: 120 }),
        remainingGaps: cleanStringArray(parsed.remainingGaps, { maxItems: 8, maxLength: 300 }),
        coveredCount: Math.max(0, Math.round(Number(parsed.coveredCount) || 0)),
        varietyTarget: Math.max(0, Math.round(Number(parsed.varietyTarget) || 0)),
        summary: cleanString(parsed.summary, 500)
    };
}

module.exports = {
    RESEARCH_SHAPES,
    inferResearchShape,
    inferResearchBrief,
    clampResearchBrief,
    sameUnit,
    unitMentioned,
    matchCoveredUnits,
    coverageProgress,
    mergeRoster,
    searchQueryBudget,
    shouldDiversifyQueries,
    maxSourcesPerUnit,
    intentQuerySeeds,
    diversifySearchQueries,
    primaryUnitsInSource,
    sourceVarietyRejection,
    titleClusterRejection,
    recordAcceptedUnits,
    floorCoverageAgainstBrief,
    synthesizeLeadsForUncovered,
    mergeLeads,
    buildContinuationProposal,
    clampContinuationProposal
};
