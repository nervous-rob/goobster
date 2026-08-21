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
 *
 * Each lens also carries an `example` - a tiny well-formed note network for
 * that research context. The note generator is shown the example (plus the
 * shared GRAPH_USE_CASES block) so it understands HOW the graph is used
 * downstream, not just what shape to output: atomic notes, tags for implicit
 * clustering, explicit typed connections only for real assertions, and
 * preserved contradictions.
 */

/**
 * How Spitball knowledge is actually consumed once committed. Shown to the
 * note generator so it writes for the graph's real use cases rather than for
 * a report.
 */
const GRAPH_USE_CASES = [
    'How this knowledge graph is used once you commit notes:',
    '- Chat retrieval: when the user asks about something, a small ranked slice of related notes is injected into the conversation. Each note must therefore stand alone - a reader sees ONE note without its neighbors, so "it" and "this method" with no referent are useless.',
    '- The Map: the user browses notes as a force-directed graph. Connections are edges they will visually follow; a wrong or trivial edge is worse than none.',
    '- Implicit clustering: notes sharing a tag are already related on the Map and in retrieval. Do NOT add a connection that only says "these share a topic" - the shared tag already says it.',
    '- Reflection: a background pass later weaves, merges, and prunes. Duplicated or vague notes get merged away; precise labels and content survive.',
    '- Contradiction tracking: conflicting claims stay as separate notes joined by a contradicts edge, which the assistant can surface proactively. Never average a disagreement into one note.',
    '- Cross-research linking: future expeditions on other topics reuse these notes and connect to them. Prefer general, reusable labels ("Membrane fouling") over run-specific ones ("Fouling as discussed in source 3").'
].join('\n');

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
        },
        example: {
            scenario: 'Researching the Pomodoro technique for everyday use.',
            notes: [
                { type: 'concept', label: 'Pomodoro technique', tags: ['productivity', 'time_management'] },
                { type: 'fact', label: 'Pomodoro interval structure', tags: ['time_management'] },
                { type: 'person', label: 'Francesco Cirillo', tags: ['productivity'] }
            ],
            connections: [
                { source: 'Pomodoro interval structure', relation: 'part_of', target: 'Pomodoro technique' },
                { source: 'Francesco Cirillo', relation: 'created', target: 'Pomodoro technique' }
            ],
            commentary: 'The two notes tagged time_management already cluster; only real assertions (part_of, created) became edges.'
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
        },
        example: {
            scenario: 'Reading the NV-center magnetometry literature.',
            notes: [
                { type: 'concept', label: 'NV-center spin readout', tags: ['quantum_sensing', 'nv_centers'] },
                { type: 'fact', label: 'Room-temperature ODMR contrast', tags: ['nv_centers', 'measurements'] },
                { type: 'fact', label: 'Reported picotesla NV sensitivity', tags: ['measurements'] },
                { type: 'fact', label: 'Sensitivity limited to nanotesla in ambient conditions', tags: ['measurements'] }
            ],
            connections: [
                { source: 'Room-temperature ODMR contrast', relation: 'supports', target: 'NV-center spin readout' },
                { source: 'Reported picotesla NV sensitivity', relation: 'contradicts', target: 'Sensitivity limited to nanotesla in ambient conditions' }
            ],
            commentary: 'The two sensitivity findings disagree, so BOTH were kept and joined by contradicts - a finding note per result, never one averaged note.'
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
        },
        example: {
            scenario: 'Learning the positive Grassmannian.',
            notes: [
                { type: 'concept', label: 'Positive Grassmannian', tags: ['geometry', 'grassmannians'] },
                { type: 'concept', label: 'Positroid cell', tags: ['geometry', 'positroids'] },
                { type: 'fact', label: 'Positroid cell decomposition', tags: ['positroids'] },
                { type: 'concept', label: 'Plabic graph', tags: ['combinatorics', 'positroids'] }
            ],
            connections: [
                { source: 'Positive Grassmannian', relation: 'decomposes_into', target: 'Positroid cell' },
                { source: 'Plabic graph', relation: 'parameterizes', target: 'Positroid cell' },
                { source: 'Positroid cell decomposition', relation: 'example_of', target: 'Positive Grassmannian' }
            ],
            commentary: 'Definitions became concept notes, the theorem a fact note; each edge is a precise mathematical relationship, not "related_to" filler.'
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
        },
        example: {
            scenario: 'Researching Byzantine iconoclasm.',
            notes: [
                { type: 'event', label: 'First Iconoclasm (726-787)', tags: ['byzantium', 'iconoclasm'] },
                { type: 'person', label: 'Leo III the Isaurian', tags: ['byzantium'] },
                { type: 'thing', label: 'Ecloga of Leo III', tags: ['primary_sources', 'byzantium'] },
                { type: 'opinion', label: 'Economic reading of iconoclasm', tags: ['iconoclasm', 'historiography'] }
            ],
            connections: [
                { source: 'Leo III the Isaurian', relation: 'initiated', target: 'First Iconoclasm (726-787)' },
                { source: 'Ecloga of Leo III', relation: 'primary_source_for', target: 'First Iconoclasm (726-787)' },
                { source: 'Economic reading of iconoclasm', relation: 'interprets', target: 'First Iconoclasm (726-787)' }
            ],
            commentary: 'Events, actors, primary sources, and historiographical interpretations are separate notes; interpretations are opinion-typed, never presented as fact.'
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
        },
        example: {
            scenario: 'Investigating cheaper seawater desalination.',
            notes: [
                { type: 'concept', label: 'Reverse osmosis membrane', tags: ['desalination', 'membranes'] },
                { type: 'fact', label: 'Membrane fouling', tags: ['membranes', 'failure_modes'] },
                { type: 'concept', label: 'Energy recovery device', tags: ['desalination', 'energy'] },
                { type: 'fact', label: 'Permeability-selectivity tradeoff', tags: ['membranes'] }
            ],
            connections: [
                { source: 'Reverse osmosis membrane', relation: 'fails_by', target: 'Membrane fouling' },
                { source: 'Energy recovery device', relation: 'enables', target: 'Reverse osmosis membrane' },
                { source: 'Permeability-selectivity tradeoff', relation: 'constrains', target: 'Reverse osmosis membrane' }
            ],
            commentary: 'Mechanisms, failure modes, and tradeoffs are first-class notes wired with engineering relations (fails_by, enables, constrains), not prose paragraphs.'
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
        },
        example: {
            scenario: 'Covering a disputed infrastructure failure.',
            notes: [
                { type: 'event', label: 'Northgate bridge closure', tags: ['infrastructure', 'northgate'] },
                { type: 'fact', label: 'Inspection report cited corrosion', tags: ['northgate', 'official_records'] },
                { type: 'fact', label: 'Contractor disputes corrosion finding', tags: ['northgate', 'disputes'] }
            ],
            connections: [
                { source: 'Inspection report cited corrosion', relation: 'explains', target: 'Northgate bridge closure' },
                { source: 'Inspection report cited corrosion', relation: 'disputed_by', target: 'Contractor disputes corrosion finding' }
            ],
            commentary: 'Each claim keeps its attribution; the dispute is represented explicitly instead of picking a winner.'
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
        },
        example: {
            scenario: 'Building a mystery novel setting.',
            notes: [
                { type: 'person', label: 'Inspector Mara Voss', tags: ['characters', 'harbor_mystery'] },
                { type: 'concept', label: "Voss's fear of open water", tags: ['motivations', 'harbor_mystery'] },
                { type: 'place', label: 'Saltmarsh Quay', tags: ['settings', 'harbor_mystery'] },
                { type: 'event', label: 'The lighthouse keeper vanishes', tags: ['plot_events', 'harbor_mystery'] }
            ],
            connections: [
                { source: "Voss's fear of open water", relation: 'motivates', target: 'Inspector Mara Voss' },
                { source: 'The lighthouse keeper vanishes', relation: 'located_in', target: 'Saltmarsh Quay' },
                { source: "Voss's fear of open water", relation: 'conflicts_with', target: 'The lighthouse keeper vanishes' }
            ],
            commentary: 'Characters, motivations, settings, and events are separate atomic notes so future chapters can recombine them; narrative tension is an explicit conflicts_with edge.'
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
        },
        example: {
            scenario: 'Studying the extended mind thesis.',
            notes: [
                { type: 'concept', label: 'Extended mind thesis', tags: ['philosophy_of_mind', 'externalism'] },
                { type: 'concept', label: 'Parity principle argument', tags: ['externalism', 'arguments'] },
                { type: 'concept', label: 'Coupling-constitution objection', tags: ['externalism', 'objections'] },
                { type: 'person', label: 'Andy Clark', tags: ['philosophy_of_mind'] }
            ],
            connections: [
                { source: 'Parity principle argument', relation: 'argues_for', target: 'Extended mind thesis' },
                { source: 'Coupling-constitution objection', relation: 'objects_to', target: 'Parity principle argument' },
                { source: 'Andy Clark', relation: 'proposed', target: 'Extended mind thesis' }
            ],
            commentary: 'Positions, arguments, and objections are distinct notes so the dialectic stays navigable; the objection targets the ARGUMENT it actually attacks, not the thesis.'
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

module.exports = { LENSES, DEFAULT_LENS_ID, GRAPH_USE_CASES, listLenses, getLens, isValidLensId };
