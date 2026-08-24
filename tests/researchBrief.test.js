/**
 * Pure helpers for seed+intent research briefs (utils/researchBrief.js).
 * No database, no network: shape inference, roster matching, query
 * diversification, coverage flooring, lead synthesis, and the
 * more-cycles proposal.
 */
const spitballConfig = require('@goobster/core/config/spitballConfig');
const {
    inferResearchShape,
    inferResearchBrief,
    clampResearchBrief,
    unitMentioned,
    coverageProgress,
    mergeRoster,
    searchQueryBudget,
    shouldDiversifyQueries,
    diversifySearchQueries,
    sourceVarietyRejection,
    titleClusterRejection,
    floorCoverageAgainstBrief,
    synthesizeLeadsForUncovered,
    mergeLeads,
    buildContinuationProposal,
    clampContinuationProposal
} = require('@goobster/core/utils/researchBrief');

const CAPS = spitballConfig.PIPELINE_CAPS;

describe('inferResearchShape / inferResearchBrief', () => {
    test('a roster-of-figures intent is a high-variety survey', () => {
        const brief = inferResearchBrief(
            'modern physics',
            'a history of all the most important figures that lead to modern physics',
            'deep'
        );
        expect(brief.shape).toBe('survey');
        expect(brief.unitKind).toBe('person');
        expect(brief.depthPerUnit).toBe('shallow');
        expect(brief.varietyTarget).toBeGreaterThanOrEqual(12);
        expect(brief.searchStrategy).toMatch(/roster|people|figures/i);
    });

    test('understand/mechanism wording is a deep dive', () => {
        const brief = inferResearchBrief(
            'positive Grassmannian',
            'understand scattering amplitudes',
            'focused'
        );
        expect(brief.shape).toBe('deep_dive');
        expect(brief.depthPerUnit).toBe('deep');
        expect(brief.varietyTarget).toBeLessThanOrEqual(4);
    });

    test('history-of-X without a roster is a timeline', () => {
        expect(inferResearchShape('calculus', 'the history of its invention')).toBe('timeline');
    });

    test('vs/compare is a comparison even when "all" appears', () => {
        expect(inferResearchShape('GR vs Newtonian gravity', 'compare all predictions')).toBe('comparison');
    });

    test('bare seed with no intent is default', () => {
        expect(inferResearchShape('positroid cells', null)).toBe('default');
    });
});

describe('clampResearchBrief', () => {
    test('coerces junk and dedupes units', () => {
        const brief = clampResearchBrief({
            shape: ' vibes ',
            varietyTarget: 99,
            coverageUnits: [
                { label: 'Einstein', kind: 'person' },
                { label: 'einstein', kind: 'person' },
                { label: '  ', kind: 'person' },
                'Niels Bohr'
            ]
        });
        expect(brief.shape).toBe('default');
        expect(brief.varietyTarget).toBe(24);
        expect(brief.coverageUnits.map(unit => unit.label)).toEqual(['Einstein', 'Niels Bohr']);
    });
});

describe('unit matching and coverage progress', () => {
    test('Albert Einstein matches a page titled Einstein', () => {
        expect(unitMentioned('Einstein field equations', 'Albert Einstein')).toBe(true);
        expect(unitMentioned('I. I. Rabi and molecular beams', 'Isidor Isaac Rabi')).toBe(true);
        expect(unitMentioned('Maxwell\'s equations', 'Albert Einstein')).toBe(false);
    });

    test('a survey with two covered names is still incomplete', () => {
        const brief = inferResearchBrief(
            'modern physics',
            'history of all the most important figures',
            'deep'
        );
        const rostered = mergeRoster(brief, ['Albert Einstein', 'I. I. Rabi', 'Niels Bohr']);
        const progress = coverageProgress(rostered, {
            extraCoveredLabels: ['Albert Einstein', 'I. I. Rabi']
        });
        expect(progress.rosterIncomplete).toBe(true);
        expect(progress.coveredCount).toBe(2);
        expect(progress.uncoveredUnits.map(unit => unit.label)).toContain('Niels Bohr');
        expect(progress.coverageFloor).toBeLessThan(0.5);
    });

    test('a default/deep-dive without a roster is not incomplete', () => {
        const brief = inferResearchBrief('positive Grassmannian', 'amplitudes', 'standard');
        const progress = coverageProgress(brief, {
            extraCoveredLabels: ['positroid cells', 'amplitudes']
        });
        expect(brief.shape).toBe('default');
        expect(progress.rosterIncomplete).toBe(false);
        expect(progress.coverageFloor).toBeNull();
    });
});

describe('query diversification', () => {
    test('survey intents always diversify; deep-dives with one unique query do not', () => {
        const survey = inferResearchBrief('modern physics', 'all the most important figures', 'deep');
        const dive = inferResearchBrief('positive Grassmannian', 'understand scattering amplitudes', 'focused');
        expect(shouldDiversifyQueries(survey, ['modern physics Einstein'], [], [])).toBe(true);
        expect(shouldDiversifyQueries(dive, ['positive Grassmannian overview'], [], [])).toBe(false);
    });

    test('replaces Einstein-clustered queries with uncovered figures', () => {
        const brief = inferResearchBrief('modern physics', 'all the most important figures', 'deep');
        const queries = diversifySearchQueries(
            [
                'Albert Einstein biography',
                'Einstein relativity papers',
                'Einstein photoelectric effect'
            ],
            {
                coveredLabels: ['Albert Einstein'],
                uncoveredUnits: [
                    { label: 'James Clerk Maxwell', kind: 'person' },
                    { label: 'Max Planck', kind: 'person' }
                ],
                seed: 'modern physics',
                intent: 'all the most important figures',
                brief,
                maxQueries: 5
            }
        );
        expect(queries.some(query => /Maxwell/i.test(query))).toBe(true);
        expect(queries.filter(query => /Einstein/i.test(query)).length).toBeLessThanOrEqual(1);
    });

    test('searchQueryBudget grows with variety target', () => {
        const survey = inferResearchBrief('modern physics', 'all the most important figures', 'deep');
        const dive = inferResearchBrief('X', 'understand Y', 'focused');
        expect(searchQueryBudget(survey, CAPS)).toBeGreaterThan(searchQueryBudget(dive, CAPS));
        expect(searchQueryBudget(survey, CAPS)).toBeLessThanOrEqual(CAPS.maxSearchQueriesPerPlan);
    });
});

describe('source variety', () => {
    test('rejects another Einstein biography while the roster is incomplete', () => {
        const reason = sourceVarietyRejection({
            title: 'Albert Einstein',
            text: 'Einstein developed special relativity.',
            units: [
                { label: 'Albert Einstein', kind: 'person' },
                { label: 'Niels Bohr', kind: 'person' }
            ],
            coveredLabels: ['Albert Einstein'],
            acceptedUnitCounts: new Map(),
            maxPerUnit: 2,
            rosterIncomplete: true
        });
        expect(reason).toBe('already-covered topic');
    });

    test('caps sources per unit this cycle', () => {
        const counts = new Map([['niels bohr', 2]]);
        const reason = sourceVarietyRejection({
            title: 'Niels Bohr',
            text: 'The Bohr model of the atom.',
            units: [{ label: 'Niels Bohr', kind: 'person' }],
            coveredLabels: [],
            acceptedUnitCounts: counts,
            maxPerUnit: 2,
            rosterIncomplete: true
        });
        expect(reason).toBe('unit source cap');
    });

    test('title-cluster rejection stops a cycle-1 Einstein pile-up', () => {
        expect(titleClusterRejection(
            'Albert Einstein biography',
            ['Albert Einstein', 'Einstein – life and work'],
            2
        )).toBe('redundant topic cluster');
        expect(titleClusterRejection('James Clerk Maxwell', ['Albert Einstein'], 2)).toBeNull();
    });
});

describe('coverage floor and synthesized leads', () => {
    test('floors a model that claims the purpose is covered after two names', () => {
        const brief = mergeRoster(
            inferResearchBrief('modern physics', 'all the most important figures', 'deep'),
            ['Albert Einstein', 'I. I. Rabi', 'Niels Bohr', 'Max Planck']
        );
        const progress = coverageProgress(brief, {
            extraCoveredLabels: ['Albert Einstein', 'I. I. Rabi']
        });
        const coverage = floorCoverageAgainstBrief({
            summary: 'Thorough.',
            coverageScore: 0.95,
            noveltyScore: 0.4,
            searchGaps: []
        }, progress);
        expect(coverage.coverageScore).toBeLessThanOrEqual(0.85);
        expect(coverage.searchGaps.some(gap => /Bohr|Planck/i.test(gap))).toBe(true);
    });

    test('synthesizes leads for uncovered units and prefers them over covered ones', () => {
        const synthesized = synthesizeLeadsForUncovered({
            uncoveredUnits: [{ label: 'Niels Bohr', kind: 'person' }],
            coveredLabels: ['Albert Einstein'],
            brief: { shape: 'survey', unitKind: 'person', varietyTarget: 12 },
            seed: 'modern physics',
            minLeadValue: 0.2
        });
        expect(synthesized[0].topic).toBe('Niels Bohr');
        expect(synthesized[0].expectedValue).toBeGreaterThanOrEqual(0.2);

        const merged = mergeLeads(
            [{ topic: 'Albert Einstein further reading', expectedValue: 0.9, kind: 'person' }],
            synthesized,
            { coveredLabels: ['Albert Einstein'], maxLeads: 8, minLeadValue: 0.2 }
        );
        expect(merged[0].topic).toBe('Niels Bohr');
    });
});

describe('continuation proposal', () => {
    test('MAX_CYCLES with an incomplete survey proposes more cycles', () => {
        const brief = inferResearchBrief('modern physics', 'all the most important figures', 'deep');
        const progress = coverageProgress(mergeRoster(brief, ['Albert Einstein', 'I. I. Rabi', 'Niels Bohr']), {
            extraCoveredLabels: ['Albert Einstein', 'I. I. Rabi']
        });
        const proposal = buildContinuationProposal({
            stopReason: 'MAX_CYCLES',
            progress,
            gaps: ['Niels Bohr (not yet researched)'],
            leads: [{ topic: 'Niels Bohr', expectedValue: 0.5 }],
            coverageScore: 0.2,
            coverageCeiling: 0.9,
            expedition: { maxCycles: 6 },
            hardMaxCycles: 12
        });
        expect(proposal.needed).toBe(true);
        expect(proposal.extendable).toBe(true);
        expect(proposal.suggestedCycles).toBeGreaterThanOrEqual(1);
        expect(proposal.uncoveredUnits).toContain('Niels Bohr');
        expect(proposal.summary).toMatch(/Covered 2 of/);
    });

    test('MAX_CYCLES at the hard ceiling is needed but not extendable', () => {
        const brief = inferResearchBrief('modern physics', 'all the most important figures', 'deep');
        const progress = coverageProgress(brief, { extraCoveredLabels: ['Einstein'] });
        const proposal = buildContinuationProposal({
            stopReason: 'MAX_CYCLES',
            progress,
            gaps: ['other figures'],
            leads: [],
            coverageScore: 0.1,
            expedition: { maxCycles: 12 },
            hardMaxCycles: 12
        });
        expect(proposal.needed).toBe(true);
        expect(proposal.extendable).toBe(false);
        expect(proposal.suggestedCycles).toBe(0);
    });

    test('NO_LEADS on a finished deep-dive does not nag', () => {
        const brief = inferResearchBrief('positive Grassmannian', 'understand amplitudes', 'focused');
        const progress = coverageProgress(brief, { extraCoveredLabels: ['positroid cells'] });
        const proposal = buildContinuationProposal({
            stopReason: 'NO_LEADS',
            progress,
            gaps: [],
            leads: [],
            coverageScore: 0.4,
            expedition: { maxCycles: 1 },
            hardMaxCycles: 12
        });
        expect(proposal.needed).toBe(false);
    });

    test('clampContinuationProposal drops malformed payloads', () => {
        expect(clampContinuationProposal(null)).toEqual({ needed: false });
        expect(clampContinuationProposal({ needed: true, suggestedCycles: 3, uncoveredUnits: ['Bohr'] }))
            .toMatchObject({ needed: true, suggestedCycles: 3, uncoveredUnits: ['Bohr'] });
    });
});
