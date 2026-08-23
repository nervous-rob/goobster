require('dotenv').config();

// config.json is optional (e.g. env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../../../config.json');
} catch {
    // config.json optional at load time
}

const spitball = fileConfig.spitball || {};

/** Clamp a numeric knob into [min, max], falling back to def when unset/invalid. */
function bounded(value, def, min, max) {
    if (value === null || value === undefined || value === '') return def;
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

/**
 * Spitball Expeditions — autonomous research runs over the user's knowledge
 * graph (user-facing name: Spitball). Spec: documentation/spitball_expeditions.md
 *
 * Vocabulary constants (statuses, stop reasons) are fixed like the attention
 * config; budget knobs are operator-tunable through config.json like the
 * Observatory, each with a hard ceiling so a config typo can never remove a
 * guardrail.
 */

/** Expedition lifecycle. Terminal states: COMPLETED, FAILED, CANCELLED. */
const STATUSES = ['DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'];
const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];
const CYCLE_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'];

/** Why an expedition stopped. Recorded explicitly on the row (spec §25). */
const STOP_REASONS = [
    'MAX_CYCLES',
    'MAX_NOTES',
    'MAX_SOURCES',
    'NOVELTY_SATURATED',
    'COVERAGE_SATURATED',
    'NO_NEW_SOURCES',
    'NO_LEADS',
    'USER_PAUSED',
    'USER_CANCELLED',
    'FAILED'
];

/**
 * Depth presets map product-friendly modes to hard budgets. Budgets are
 * resolved onto the expedition row at creation time, so retuning a preset
 * never changes a run already underway. Numbers are a starting point, not a
 * public contract (spec §39).
 */
const DEPTH_PRESETS = {
    focused: { maxCycles: 1, maxSources: 8, maxNotes: 20 },
    standard: { maxCycles: 3, maxSources: 25, maxNotes: 60 },
    deep: { maxCycles: 6, maxSources: 60, maxNotes: 150 }
};

const DEFAULT_DEPTH = 'standard';

/** Input caps (validated at creation; system boundary). */
const INPUT_CAPS = {
    maxSeedLength: 200,
    maxIntentLength: 1000,
    maxLensTextLength: 500
};

/**
 * Deterministic continuation policy: models may estimate novelty/coverage,
 * but these limits and the state machine own whether work continues (§40).
 */
const CONTINUATION = {
    /** Cycles whose noveltyScore falls at/below this count as low-novelty. */
    noveltyFloor: 0.15,
    /** Consecutive low-novelty cycles before stopping (NOVELTY_SATURATED). */
    lowNoveltyStreakToStop: 2,
    /** Coverage at/above this ends the run (COVERAGE_SATURATED). */
    coverageCeiling: 0.9,
    /** Leads below this expected value are not worth another cycle. */
    minLeadValue: 0.2
};

/** Bounded pipeline shapes (parser clamps; spec §46). */
const PIPELINE_CAPS = {
    maxQuestionsPerPlan: 10,
    maxSearchQueriesPerPlan: 8,
    /** Search queries actually executed per cycle (cost bound). */
    maxSearchQueriesUsed: 4,
    /** Source drafts requested per provider per query. */
    maxResultsPerProviderQuery: 3,
    /** Sources accepted into claim extraction per cycle (model-call bound). */
    maxAcceptedSourcesPerCycle: 6,
    /**
     * After score-based selection, a source-review stage (model + purpose
     * overlap fallback) must keep at least this many sources or the cycle
     * re-searches once with refined queries. 1 = "any on-topic haul is enough".
     */
    minAcceptedSourcesAfterReview: 1,
    /** How many extra search-and-review passes a cycle may take. */
    maxSourceReviewRetries: 1,
    /** Reviewer onTopicScore at/below this rejects the source. */
    minSourceReviewScore: 0.45,
    /**
     * When the reviewer is silent or down, lexical overlap of title+text
     * against seed+intent+concepts must clear this or the source is dropped.
     * Higher than minSourceRelevance so a weak keyword hit is not enough.
     */
    minSourceReviewFallbackOverlap: 0.28,
    /** Title + excerpt handed to the source reviewer (prompt bound). */
    sourceReviewExcerptChars: 700,
    /** Source candidates below this relevance are rejected outright. */
    minSourceRelevance: 0.15,
    /**
     * Source candidates whose content is redundant with already-accepted
     * evidence (novelty at/below this) are rejected before any claim
     * extraction spends tokens on them.
     */
    minSourceNovelty: 0.35,
    /** Embedding-cosine similarity at/below which content is fully novel. */
    noveltyCosineFloor: 0.6,
    /** Lexical-Jaccard similarity at/below which content is fully novel. */
    noveltyLexicalFloor: 0.2,
    maxLeadsPerCycle: 8,
    maxClaimsPerSource: 10,
    maxSourceTextChars: 20_000,
    /** Source text handed to the claim extractor (prompt bound). */
    claimExtractionChars: 6000,
    /** Existing-knowledge excerpt in the planner prompt. */
    contextNoteChars: 2500,
    /** Leads carried into the next cycle's frontier input. */
    maxFrontierLeads: 5,
    /** Concept labels in the avoid-repeating list of the recursive state. */
    maxAvoidRepeating: 40
};

module.exports = {
    /**
     * Master switch (default on: expeditions are user-initiated like chat,
     * bounded by budgets; set spitball.enabled=false to hide the feature).
     */
    enabled: !(process.env.GOOBSTER_SPITBALL_ENABLED === '0'
        || process.env.GOOBSTER_SPITBALL_ENABLED === 'false'
        || spitball.enabled === false),

    STATUSES,
    TERMINAL_STATUSES,
    CYCLE_STATUSES,
    STOP_REASONS,
    DEPTH_PRESETS,
    DEFAULT_DEPTH,
    INPUT_CAPS,
    CONTINUATION,
    PIPELINE_CAPS,

    /**
     * Post-ingestion reflection at the cycle boundary (spec §21): after a
     * cycle commits at least minNotesForWeave notes, a weave/tidy pass runs
     * over the expedition's scope so fresh research gets connected into the
     * existing graph - batched per cycle, never per write.
     */
    cycleReflection: {
        enabled: spitball.cycleReflectionEnabled !== false,
        minNotesForWeave: bounded(spitball.minNotesForWeave, 3, 1, 100)
    },

    /** Expeditions one user may have QUEUED/RUNNING at once. */
    maxActiveExpeditionsPerUser: bounded(spitball.maxActiveExpeditionsPerUser, 2, 1, 20),
    /** Non-terminal expeditions (incl. PAUSED drafts) one user may keep. */
    maxOpenExpeditionsPerUser: bounded(spitball.maxOpenExpeditionsPerUser, 10, 1, 100),
    /**
     * A RUNNING expedition whose heartbeat is older than this is an orphan
     * (crashed process) and is parked PAUSED at startup, resumable by the
     * user (the observatory orphan-reap rule, with a safer default action).
     */
    staleRunMinutes: bounded(spitball.staleRunMinutes, 30, 5, 720),
    /** Cycles per expedition ceiling regardless of preset/config. */
    hardMaxCycles: 12
};
