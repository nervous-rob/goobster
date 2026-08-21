/**
 * Spitball Expedition Lens profiles — the high-level interpretive/research
 * context a user picks when starting an Expedition.
 * Spec: documentation/spitball_expeditions.md §7.
 *
 * A Lens is a first-class configuration, not a free-text prompt insert. It
 * biases preferred source classes, relationship vocabulary, note archetypes,
 * and evidence standards throughout the research pipeline. Users may add
 * free-text custom context (lensText) on top of any preset.
 *
 * Note archetypes are model guidance; committed notes are still clamped to
 * the legal kg_nodes types by the knowledge graph legalizer/service.
 */

const LENSES = [
    {
        id: 'general',
        name: 'General',
        description: 'Balanced research with no domain bias.',
        sourcePreferences: ['reference', 'review_article', 'news', 'primary_source'],
        relationshipPriorities: ['related_to', 'part_of', 'example_of', 'causes', 'leads_to', 'contradicts'],
        noteArchetypes: ['concept', 'fact', 'person', 'event', 'thing'],
        epistemicPolicy: {
            citationsRequired: true,
            distinguishClaimFromInference: true,
            preferPrimarySources: false
        }
    },
    {
        id: 'scientific-literature',
        name: 'Scientific Literature',
        description: 'Peer-reviewed findings, methods, and open questions.',
        sourcePreferences: ['peer_reviewed', 'primary_source', 'preprint', 'review_article'],
        relationshipPriorities: ['supports', 'contradicts', 'extends', 'derived_from', 'measured_by', 'depends_on'],
        noteArchetypes: ['concept', 'finding', 'method', 'experiment', 'open_question'],
        epistemicPolicy: {
            citationsRequired: true,
            distinguishClaimFromInference: true,
            preferPrimarySources: true
        }
    },
    {
        id: 'mathematics',
        name: 'Mathematics',
        description: 'Definitions, constructions, theorems, and their connections.',
        sourcePreferences: ['reference', 'peer_reviewed', 'preprint', 'lecture_notes'],
        relationshipPriorities: ['generalizes', 'specializes', 'parameterizes', 'decomposes_into', 'used_in', 'equivalent_to', 'depends_on'],
        noteArchetypes: ['definition', 'theorem', 'construction', 'example', 'open_question'],
        epistemicPolicy: {
            citationsRequired: true,
            distinguishClaimFromInference: true,
            preferPrimarySources: false
        }
    },
    {
        id: 'history',
        name: 'History',
        description: 'Events, actors, sources, and historiographical disputes.',
        sourcePreferences: ['primary_source', 'peer_reviewed', 'reference', 'archive'],
        relationshipPriorities: ['precedes', 'influenced', 'contemporary_with', 'primary_source_for', 'contested_by', 'revision_of', 'caused', 'responded_to'],
        noteArchetypes: ['event', 'person', 'institution', 'primary_source', 'interpretation', 'historiographical_dispute'],
        epistemicPolicy: {
            citationsRequired: true,
            distinguishClaimFromInference: true,
            preferPrimarySources: true
        }
    },
    {
        id: 'engineering',
        name: 'Engineering',
        description: 'Mechanisms, materials, constraints, and tradeoffs.',
        sourcePreferences: ['peer_reviewed', 'standard', 'datasheet', 'review_article'],
        relationshipPriorities: ['enables', 'constrains', 'fails_by', 'optimized_by', 'tradeoff_with', 'requires', 'measured_by', 'manufactured_with'],
        noteArchetypes: ['mechanism', 'material', 'process', 'failure_mode', 'constraint', 'metric', 'tradeoff', 'application'],
        epistemicPolicy: {
            citationsRequired: true,
            distinguishClaimFromInference: true,
            preferPrimarySources: false
        }
    },
    {
        id: 'journalism',
        name: 'Journalism',
        description: 'Reported facts, sourcing quality, and open disputes.',
        sourcePreferences: ['news', 'primary_source', 'official_statement', 'archive'],
        relationshipPriorities: ['reported_by', 'confirmed_by', 'disputed_by', 'preceded_by', 'responded_to', 'contradicts'],
        noteArchetypes: ['event', 'fact', 'person', 'claim_in_dispute', 'open_question'],
        epistemicPolicy: {
            citationsRequired: true,
            distinguishClaimFromInference: true,
            preferPrimarySources: true
        }
    },
    {
        id: 'storytelling',
        name: 'Fictional Storytelling',
        description: 'Characters, settings, themes, and narrative mechanics.',
        sourcePreferences: ['reference', 'review_article', 'essay'],
        relationshipPriorities: ['motivates', 'conflicts_with', 'foreshadows', 'reveals', 'mirrors', 'causes', 'changes', 'located_in', 'member_of'],
        noteArchetypes: ['character', 'motivation', 'setting', 'theme', 'conflict', 'event', 'symbol', 'world_rule'],
        epistemicPolicy: {
            citationsRequired: false,
            distinguishClaimFromInference: false,
            preferPrimarySources: false
        }
    },
    {
        id: 'philosophy',
        name: 'Philosophy',
        description: 'Arguments, positions, objections, and their lineage.',
        sourcePreferences: ['primary_source', 'reference', 'peer_reviewed', 'essay'],
        relationshipPriorities: ['argues_for', 'objects_to', 'presupposes', 'entails', 'reinterprets', 'contradicts', 'influenced'],
        noteArchetypes: ['position', 'argument', 'objection', 'distinction', 'person', 'open_question'],
        epistemicPolicy: {
            citationsRequired: true,
            distinguishClaimFromInference: true,
            preferPrimarySources: true
        }
    }
];

const DEFAULT_LENS_ID = 'general';

const byId = new Map(LENSES.map(lens => [lens.id, lens]));

/** @returns {Array<Object>} all preset lens profiles (frozen shape, do not mutate) */
function listLenses() {
    return LENSES;
}

/**
 * @param {string} id
 * @returns {Object|null} the lens profile, or null when unknown
 */
function getLens(id) {
    return byId.get(String(id || '').trim().toLowerCase()) || null;
}

/** @param {string} id @returns {boolean} */
function isValidLensId(id) {
    return byId.has(String(id || '').trim().toLowerCase());
}

module.exports = { LENSES, DEFAULT_LENS_ID, listLenses, getLens, isValidLensId };
