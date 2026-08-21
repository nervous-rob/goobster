/**
 * User knowledge graph — caps, relation taxonomy, and legalizer thresholds.
 * Spec: documentation/user_knowledge_graph.md
 */

const MAX_LABEL_LENGTH = 120;
const MAX_CONTENT_LENGTH = 1000;
const MAX_RELATION_LENGTH = 60;

const MAX_NODES_GUILD_WIDE = 500;
const MAX_NODES_USER = 500;
const MAX_EDGES_PER_SCOPE = 1500;
const MAX_TAGS_PER_SCOPE = 80;
const MAX_TAGS_PER_NODE = 8;
const MAX_TAG_LENGTH = 40;

/** Cosine similarity at or above this → merge nodes (when embeddings available). */
const SEMANTIC_MERGE_THRESHOLD = 0.88;

/** Nodes below this confidence with no provenance rows may be orphan-pruned. */
const ORPHAN_CONFIDENCE_THRESHOLD = 0.35;

/** Distilled memories older than this many days may be purged (if enabled). */
const DISTILLED_MEMORY_RETENTION_DAYS = 7;

/** Minimum author memories before consolidation runs (guild). */
const MIN_MEMORIES_PER_AUTHOR = 3;

/** Minimum memories before consolidation runs (DM scope). */
const MIN_MEMORIES_DM_SCOPE = 2;

const NODE_TYPES = ['concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing', 'artifact'];

const NODE_SOURCES = ['monologue', 'consolidation', 'tool', 'migration', 'user', 'research'];

const RELATION_KINDS = ['causal', 'logical', 'associative', 'temporal', 'social'];

const PROVENANCE_KINDS = [
    'memory', 'fact', 'consolidation', 'monologue', 'tool', 'user', 'artifact',
    // Spitball Expeditions (documentation/spitball_expeditions.md):
    // research_claim -> research_claims.id (claim -> source resolves through
    // the research tables), research_source -> research_sources.id,
    // expedition -> spitball_expeditions.id
    'research_claim', 'research_source', 'expedition'
];

/** Per-tick / per-run caps for automated writers. */
const LIMITS = {
    consolidation: {
        maxMemoriesReviewed: 120,
        maxMutationsUpsert: 12,
        maxMutationsLink: 15,
        maxMutationsDelete: 6,
        maxMutationsMerge: 4,
        maxNewFactsLegacy: 10
    },
    monologue: {
        maxNodeUpserts: 6,
        maxLinks: 10,
        maxNodeDeletes: 3
    },
    reflection: {
        maxMemoriesReviewed: 80,
        maxNodesReviewed: 60,
        maxMutationsUpsert: 12,
        maxMutationsLink: 20,
        maxMutationsDelete: 6,
        maxMutationsMerge: 6
    },
    // Spitball Expedition cycles: research proposes and connects but never
    // deletes existing knowledge (documentation/spitball_expeditions.md).
    research: {
        maxMutationsUpsert: 12,
        maxMutationsLink: 20,
        maxMutationsDelete: 0,
        maxMutationsMerge: 4
    }
};

/**
 * Reflection (on-demand + scheduled knowledge enrichment): the framework
 * behind the Library "Reflect" button and the background routine that keeps
 * graph scopes connected. Services: knowledgeReflectionService.
 */
const REFLECTION = {
    /** Scheduler tick. Each tick reflects on at most maxScopesPerTick scopes. */
    tickMs: 12 * 60 * 60 * 1000,
    /** Delay before the first scheduled tick after boot. */
    firstTickDelayMs: 10 * 60 * 1000,
    /** Any run (manual or scheduled) within this window makes a scope not-due. */
    scopeCooldownHours: 72,
    /** Cap on scopes reflected per scheduled tick (bounds model spend). */
    maxScopesPerTick: 4,
    /** Scopes need at least this many nodes before scheduled weaving helps. */
    minNodesForScheduledWeave: 10,
    /** Scopes with fewer edges than nodes × this ratio count as under-connected. */
    weaveEdgeDeficitRatio: 0.6,
    /** 'running' rows older than this are treated as dead (crashed process). */
    staleRunMinutes: 15
};

module.exports = {
    MAX_LABEL_LENGTH,
    MAX_CONTENT_LENGTH,
    MAX_RELATION_LENGTH,
    MAX_NODES_GUILD_WIDE,
    MAX_NODES_USER,
    MAX_EDGES_PER_SCOPE,
    MAX_TAGS_PER_SCOPE,
    MAX_TAGS_PER_NODE,
    MAX_TAG_LENGTH,
    SEMANTIC_MERGE_THRESHOLD,
    ORPHAN_CONFIDENCE_THRESHOLD,
    DISTILLED_MEMORY_RETENTION_DAYS,
    MIN_MEMORIES_PER_AUTHOR,
    MIN_MEMORIES_DM_SCOPE,
    NODE_TYPES,
    NODE_SOURCES,
    RELATION_KINDS,
    PROVENANCE_KINDS,
    LIMITS,
    REFLECTION
};
