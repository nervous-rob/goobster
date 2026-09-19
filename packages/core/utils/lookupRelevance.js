/**
 * Lexical relevance for knowledge lookups (graph nodes and saved artifacts).
 *
 * The SQL side of a lookup can only say "some query term appears somewhere
 * in this row"; it cannot tell an exact label match from a node that merely
 * shares the word "projects". Left to `ORDER BY salience`, a handful of
 * 0.99-salience concepts crowd out the file the user just named. This module
 * scores an over-fetched candidate set so clear query relevance wins first
 * and salience/confidence only break ties:
 *
 *   exact   — the whole query is the label or the file name
 *   strong  — the label/file name and the query contain each other
 *   phrase  — the whole query appears verbatim in the text fields, or
 *             every query term hits somewhere
 *   partial — some query terms hit (scored by coverage)
 *
 * It also cuts the bounded, match-centred excerpt a lookup returns instead
 * of a whole document. Pure functions, no I/O, no embeddings required.
 */

const TIER = Object.freeze({
    exact: 4,
    strong: 3,
    phrase: 2,
    partial: 1,
    none: 0
});

const TIER_SCORE = Object.freeze({
    [TIER.exact]: 1000,
    [TIER.strong]: 600,
    [TIER.phrase]: 300,
    [TIER.partial]: 0,
    [TIER.none]: 0
});

const MIN_TERM_LENGTH = 3;
const MAX_TERMS = 12;

/** Lowercase, collapse whitespace, drop surrounding punctuation. */
function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/^[\s"'“”‘’.,;:!?()[\]{}]+|[\s"'“”‘’.,;:!?()[\]{}]+$/g, '')
        .trim();
}

/** File name without its extension, normalized. */
function stemFileName(name) {
    const base = normalizeText(String(name || '').split(/[/\\]/).pop());
    const idx = base.lastIndexOf('.');
    return idx > 0 ? base.slice(0, idx) : base;
}

/**
 * Query terms for LIKE candidates and coverage scoring: alphanumeric runs
 * of three or more characters, deduplicated, bounded.
 * @param {string} query
 * @returns {string[]}
 */
function queryTerms(query) {
    const seen = new Set();
    const out = [];
    for (const term of String(query || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
        if (term.length < MIN_TERM_LENGTH || seen.has(term)) continue;
        seen.add(term);
        out.push(term);
        if (out.length >= MAX_TERMS) break;
    }
    return out;
}

function containsWord(haystack, needle) {
    return Boolean(needle) && haystack.includes(needle);
}

/**
 * Score one candidate against a query.
 *
 * @param {Object} params
 * @param {string} params.query
 * @param {string[]} [params.terms] - precomputed queryTerms(query)
 * @param {string} [params.label]
 * @param {string} [params.fileName]
 * @param {string[]} [params.texts] - content, extracted text, searchable metadata
 * @param {number} [params.salience]
 * @param {number} [params.confidence]
 * @returns {{ score: number, tier: number, coverage: number, matchedTerms: string[] }}
 */
function scoreCandidate({
    query,
    terms = null,
    label = '',
    fileName = '',
    texts = [],
    salience = 0,
    confidence = 0
} = {}) {
    const q = normalizeText(query);
    const qTerms = Array.isArray(terms) ? terms : queryTerms(query);
    const nLabel = normalizeText(label);
    const nFile = normalizeText(fileName);
    const nStem = stemFileName(fileName);
    const body = texts.map(t => normalizeText(t)).filter(Boolean);
    const everything = [nLabel, nFile, ...body].join('\n');

    const matchedTerms = qTerms.filter(term => containsWord(everything, term));
    const coverage = qTerms.length > 0 ? matchedTerms.length / qTerms.length : 0;

    let tier = TIER.none;
    if (q && (q === nLabel || (nFile && (q === nFile || q === nStem)))) {
        tier = TIER.exact;
    } else if (q && (
        (nLabel && (nLabel.startsWith(q) || q.includes(nLabel)))
        || (nFile && (q.includes(nFile) || nFile.startsWith(q)))
        || (qTerms.length >= 2 && nLabel.includes(q))
    )) {
        tier = TIER.strong;
    } else if (q && qTerms.length > 0 && (
        body.some(text => text.includes(q))
        || (qTerms.length >= 2 && coverage === 1)
    )) {
        tier = TIER.phrase;
    } else if (matchedTerms.length > 0) {
        tier = TIER.partial;
    }

    if (tier === TIER.none) {
        return { score: 0, tier, coverage, matchedTerms };
    }

    // Coverage separates "matches every word" from "shares one word"; the
    // label bonus prefers a term hit in the title over one buried in a
    // long document; tightness prefers the label the query covers best
    // ("M1943 field jacket" over "M1943 field jacket (2)"); salience and
    // confidence only order otherwise-equal candidates.
    const labelHits = qTerms.filter(term => containsWord(nLabel, term) || containsWord(nFile, term)).length;
    const score = TIER_SCORE[tier]
        + Math.round(coverage * 200)
        + labelHits * 25
        + Math.round(labelTightness(nLabel, qTerms) * 20)
        + clamp01(salience) * 10
        + clamp01(confidence) * 2;
    return { score, tier, coverage, matchedTerms };
}

/** Share of the label's characters covered by query terms (0 when none hit). */
function labelTightness(nLabel, qTerms) {
    if (!nLabel) return 0;
    let covered = 0;
    for (const term of qTerms) {
        if (containsWord(nLabel, term)) covered += term.length;
    }
    return Math.min(1, covered / nLabel.length);
}

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

/**
 * Sort by score, then salience, then recency (updatedAt text sorts
 * lexically as UTC), then lowest id. The id tie-break keeps the order
 * identical on SQLite and Postgres: rows that tie on every other key come
 * back from Postgres in whatever physical order the planner chose.
 */
function compareRanked(a, b) {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    const sa = Number(a.salience) || 0;
    const sb = Number(b.salience) || 0;
    if (sb !== sa) return sb - sa;
    const byTime = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    if (byTime !== 0) return byTime;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
}

/**
 * A bounded window of `text` centred on the first occurrence of the most
 * specific matching term (longest first, then the whole query phrase). Falls
 * back to the head of the text when nothing matches.
 *
 * @param {string} text
 * @param {{ query?: string, terms?: string[], maxChars?: number }} [opts]
 * @returns {string}
 */
function excerptAround(text, { query = '', terms = null, maxChars = 320 } = {}) {
    const source = String(text || '').replace(/\s+/g, ' ').trim();
    if (!source) return '';
    if (source.length <= maxChars) return source;

    const lower = source.toLowerCase();
    const needles = [];
    const q = normalizeText(query);
    if (q) needles.push(q);
    const qTerms = Array.isArray(terms) ? terms : queryTerms(query);
    needles.push(...[...qTerms].sort((a, b) => b.length - a.length));

    let hit = -1;
    let hitLength = 0;
    for (const needle of needles) {
        const idx = lower.indexOf(needle);
        if (idx >= 0) {
            hit = idx;
            hitLength = needle.length;
            break;
        }
    }

    if (hit < 0) {
        return `${source.slice(0, maxChars - 1).trimEnd()}…`;
    }

    const half = Math.max(0, Math.floor((maxChars - hitLength) / 2));
    let start = Math.max(0, hit - half);
    let end = Math.min(source.length, start + maxChars);
    if (end - start < maxChars) start = Math.max(0, end - maxChars);

    // Snap to word boundaries so the window does not open or close mid-word.
    if (start > 0) {
        const space = source.indexOf(' ', start);
        if (space >= 0 && space < hit) start = space + 1;
    }
    if (end < source.length) {
        const space = source.lastIndexOf(' ', end);
        if (space > hit + hitLength) end = space;
    }

    const prefix = start > 0 ? '…' : '';
    const suffix = end < source.length ? '…' : '';
    return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}

module.exports = {
    TIER,
    MIN_TERM_LENGTH,
    normalizeText,
    stemFileName,
    queryTerms,
    scoreCandidate,
    compareRanked,
    excerptAround
};
