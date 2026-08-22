/**
 * The Spitball research pipeline (services/spitballResearchPipeline.js) and
 * its pure helpers (utils/researchSources.js).
 * Spec: documentation/spitball_expeditions.md
 *
 * The pure clamps are tested directly (URL canonicalization, content hashes,
 * every strict-JSON stage parser). The pipeline is tested against the real
 * database and the real knowledge graph legalizer with deterministic fake
 * model/search adapters: a full single-cycle vertical slice (plan -> search
 * -> sources -> claims -> notes -> provenance -> coverage -> Leads), source
 * accept/reject bookkeeping, dedupe on retry, budget enforcement, safe
 * degradation on malformed/failed model output, and the runner-driven
 * end-to-end expedition.
 */
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-spitball-pipeline-test-${process.pid}.sqlite`);

// The legalizer's semantic dedupe requires embeddingService internally; mock
// the module so tests never reach a real embedding backend (the
// knowledgeReflectionService.test.js convention).
jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    embedBatch: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    cosineSimilarity: jest.fn(() => 0)
}));

const db = require('@goobster/core/db');
const spitballConfig = require('@goobster/core/config/spitballConfig');
const kgConfig = require('@goobster/core/config/knowledgeGraphConfig');
const kg = require('@goobster/core/services/knowledgeGraphService');
const expeditionService = require('@goobster/core/services/spitballExpeditionService');
const { SpitballExpeditionRunner } = require('@goobster/core/services/spitballExpeditionRunner');
const { SpitballResearchPipeline } = require('@goobster/core/services/spitballResearchPipeline');
const { SpitballSearchService } = require('@goobster/core/services/spitballSearchService');
const domainEventBus = require('@goobster/core/services/domainEventBus');
const {
    canonicalizeUrl, contentHash, keywordOverlap, sourceValue,
    textSimilarity, noveltyFromSimilarity, noteConfidenceCeiling,
    clampPlan, clampClaims, clampKnowledgeProposals, clampCoverage, clampLeads
} = require('@goobster/core/utils/researchSources');

const CAPS = spitballConfig.PIPELINE_CAPS;

let userSeq = 0;
function nextUser() {
    userSeq += 1;
    return `sbp-user-${process.pid}-${userSeq}`;
}

/** Embeddings stub that always fails -> deterministic keyword relevance. */
const noEmbeddings = {
    async embed() { throw new Error('no embedding backend in tests'); },
    cosineSimilarity() { return 0; }
};

/** A fake model that dispatches on the stage marker in each prompt. */
function fakeAi(responses) {
    const calls = [];
    return {
        calls,
        async generateText(prompt) {
            calls.push(prompt);
            if (prompt.includes('planning one cycle')) return respond(responses.plan, prompt);
            if (prompt.includes('Extract structured evidence')) return respond(responses.claims, prompt);
            if (prompt.includes('ATOMIC knowledge notes')) return respond(responses.knowledge, prompt);
            if (prompt.includes('Evaluate this research cycle')) return respond(responses.coverage, prompt);
            throw new Error('unexpected prompt in test');
        }
    };
    function respond(handler, prompt) {
        if (handler === undefined) throw new Error('stage not stubbed');
        const value = typeof handler === 'function' ? handler(prompt) : handler;
        if (value instanceof Error) throw value;
        return typeof value === 'string' ? value : JSON.stringify(value);
    }
}

function fakeSearch(resultsByQuery) {
    const queries = [];
    const opts = [];
    return {
        queries,
        opts,
        async search(query, options = {}) {
            queries.push(query);
            opts.push(options);
            const make = resultsByQuery[query] ?? resultsByQuery['*'] ?? [];
            return typeof make === 'function' ? make(query) : make;
        }
    };
}

function draft(overrides = {}) {
    return {
        provider: 'wikipedia',
        sourceType: 'reference',
        url: 'https://en.wikipedia.org/wiki/Positive_Grassmannian',
        title: 'Positive Grassmannian',
        author: null,
        publisher: 'Wikipedia',
        publishedAt: '2026-01-01',
        text: 'The positive Grassmannian decomposes into positroid cells. Scattering amplitudes relate to its geometry.',
        metadata: {},
        ...overrides
    };
}

const GOOD_PLAN = {
    questions: ['What is the positive Grassmannian?'],
    searchQueries: ['positive Grassmannian overview'],
    expectedConcepts: ['positroid cells', 'scattering amplitudes'],
    relationshipTargets: ['decomposes_into'],
    excludeTerms: []
};

function goodResponses({ claimIdsRef } = {}) {
    return {
        plan: GOOD_PLAN,
        claims: {
            claims: [
                { text: 'The positive Grassmannian decomposes into positroid cells.', kind: 'factual', confidence: 0.9, sourceLocation: 'intro', concepts: ['positroid cells'] },
                { text: 'Scattering amplitudes relate to positive Grassmannian geometry.', kind: 'interpretive', confidence: 0.7 }
            ]
        },
        knowledge: () => ({
            upsert: [
                {
                    type: 'concept', label: 'Positroid cell decomposition',
                    content: 'The positive Grassmannian decomposes into positroid cells.',
                    salience: 0.7, confidence: 0.85,
                    tags: ['geometry', 'positroids'],
                    claimIds: claimIdsRef ? claimIdsRef() : []
                },
                {
                    type: 'concept', label: 'Amplitude-geometry connection',
                    content: 'Scattering amplitudes connect to the geometry of the positive Grassmannian.',
                    tags: ['scattering_amplitudes'],
                    claimIds: claimIdsRef ? claimIdsRef() : []
                }
            ],
            link: [
                { source: 'Positroid cell decomposition', target: 'Amplitude-geometry connection', relation: 'used_in', relationKind: 'associative', weight: 0.7 }
            ]
        }),
        coverage: {
            coverage: {
                summary: 'Mapped the basic decomposition and its amplitude connection.',
                coveredQuestions: ['What is the positive Grassmannian?'],
                unresolvedQuestions: ['How are positroid cells parameterized?'],
                majorNewConcepts: ['positroid cells'],
                conflicts: [],
                coverageScore: 0.5,
                noveltyScore: 0.8
            },
            leads: [
                { topic: 'positroid stratification', kind: 'subtopic', reason: 'central mechanism', relevance: 0.9, novelty: 0.9, uncertainty: 0.8, expectedValue: 0.85, suggestedQueries: ['positroid stratification review'] },
                { topic: 'weak aside', kind: 'subtopic', relevance: 0.1, novelty: 0.1, uncertainty: 0.1 }
            ]
        }
    };
}

async function makeExpeditionAndCycle({ userId, depth = 'focused' } = {}) {
    const expedition = await expeditionService.createExpedition({
        userId, seed: 'positive Grassmannian', lensId: 'mathematics',
        intent: 'understand scattering amplitudes', depth
    });
    await expeditionService.claimForRun(expedition.id);
    const running = await expeditionService.getById(expedition.id);
    const cycle = await expeditionService.startCycle(expedition.id, {
        frontierInput: await expeditionService.buildFrontierInput(running)
    });
    return { expedition: running, cycle };
}

afterAll(async () => {
    await domainEventBus.close();
});

describe('pure helpers (utils/researchSources.js)', () => {
    test('canonicalizeUrl normalizes and rejects junk', () => {
        expect(canonicalizeUrl('HTTPS://Example.org/Path?utm_source=x&q=1#frag'))
            .toBe('https://example.org/Path?q=1');
        expect(canonicalizeUrl('https://example.org/')).toBe('https://example.org');
        expect(canonicalizeUrl('ftp://example.org/file')).toBeNull();
        expect(canonicalizeUrl('not a url')).toBeNull();
        expect(canonicalizeUrl(null)).toBeNull();
    });

    test('contentHash is whitespace/case-insensitive and stable', () => {
        expect(contentHash('Hello   World')).toBe(contentHash('hello world'));
        expect(contentHash('hello world')).not.toBe(contentHash('goodbye world'));
        expect(contentHash('   ')).toBeNull();
    });

    test('keywordOverlap and sourceValue stay in [0, 1]', () => {
        expect(keywordOverlap('positive Grassmannian', 'the positive Grassmannian decomposes')).toBe(1);
        expect(keywordOverlap('quantum gravity', 'a cooking recipe')).toBe(0);
        expect(sourceValue({ relevance: 1, quality: 1, novelty: 1 })).toBe(1);
        expect(sourceValue({ relevance: 5, quality: -2, novelty: 1 })).toBe(0);
    });

    test('clampPlan validates structure and caps arrays', () => {
        expect(clampPlan(null, CAPS)).toBeNull();
        expect(clampPlan({ searchQueries: [] }, CAPS)).toBeNull();
        expect(clampPlan({ searchQueries: ['   '] }, CAPS)).toBeNull();
        const plan = clampPlan({
            questions: Array.from({ length: 50 }, (_, i) => `q${i}`),
            searchQueries: ['one', 'two', 'ONE', 'one'],
            expectedConcepts: ['a'],
            junkKey: 'dropped'
        }, CAPS);
        expect(plan.questions.length).toBe(CAPS.maxQuestionsPerPlan);
        expect(plan.searchQueries).toEqual(['one', 'two']);
        expect(plan.junkKey).toBeUndefined();
    });

    test('clampClaims coerces kinds, clamps confidence, caps count', () => {
        const claims = clampClaims({
            claims: [
                { text: 'A', kind: 'nonsense', confidence: 7 },
                { text: '', kind: 'factual' },
                ...Array.from({ length: 30 }, (_, i) => ({ text: `claim ${i}`, kind: 'causal', confidence: 0.5 }))
            ]
        }, CAPS);
        expect(claims.length).toBe(CAPS.maxClaimsPerSource);
        expect(claims[0]).toMatchObject({ text: 'A', kind: 'factual', confidence: 1 });
        expect(clampClaims('garbage', CAPS)).toEqual([]);
    });

    test('clampKnowledgeProposals filters foreign claimIds, self-loops, bad types', () => {
        const proposals = clampKnowledgeProposals({
            upsert: [
                { type: 'weird_type', label: 'Note A', content: 'x', claimIds: [1, 999, 'nan'] },
                { label: '' }
            ],
            link: [
                { source: 'Note A', target: 'Note A', relation: 'related_to' },
                { source: 'Note A', target: 'Note B', relation: 'part_of', relationKind: 'bogus' }
            ],
            contradict: [{ source: 'Note A', target: 'Note B' }]
        }, { validClaimIds: new Set([1]), nodeTypes: kgConfig.NODE_TYPES, maxNotes: 12, maxLinks: 20 });
        expect(proposals.upsert.length).toBe(1);
        expect(proposals.upsert[0]).toMatchObject({ type: 'concept', label: 'Note A', claimIds: [1] });
        expect(proposals.link.length).toBe(1);
        expect(proposals.link[0]).toMatchObject({ relation: 'part_of', relationKind: null });
        expect(proposals.contradict).toEqual([{ source: 'Note A', target: 'Note B' }]);
        expect(clampKnowledgeProposals({ upsert: [], link: [] }, { validClaimIds: new Set(), nodeTypes: kgConfig.NODE_TYPES, maxNotes: 12, maxLinks: 20 })).toBeNull();
    });

    test('clampLeads computes missing expectedValue and ranks best-first', () => {
        const leads = clampLeads({
            leads: [
                { topic: 'weak', relevance: 0.2, novelty: 0.2, uncertainty: 0.2 },
                { topic: 'strong', kind: 'mechanism', relevance: 0.9, novelty: 0.9, uncertainty: 0.9 },
                { topic: 'explicit', expectedValue: 0.5 },
                { topic: '' }
            ]
        }, CAPS);
        expect(leads.map(l => l.topic)).toEqual(['strong', 'explicit', 'weak']);
        expect(leads[0].expectedValue).toBeCloseTo(0.9 * 0.9 * 0.9, 5);
        expect(leads[0].kind).toBe('mechanism');
        expect(leads[2].expectedValue).toBeCloseTo(0.008, 5);
    });

    test('textSimilarity and noveltyFromSimilarity behave at the boundaries', () => {
        expect(textSimilarity('the quick brown fox', 'the quick brown fox')).toBe(1);
        expect(textSimilarity('quantum sensing diamonds', 'sourdough starter hydration')).toBe(0);
        const partial = textSimilarity('positive grassmannian cells decompose', 'positive grassmannian cluster algebras relate');
        expect(partial).toBeGreaterThan(0);
        expect(partial).toBeLessThan(1);
        expect(textSimilarity('', 'anything')).toBe(0);

        expect(noveltyFromSimilarity(0.1, 0.2)).toBe(1);   // below the floor: fully novel
        expect(noveltyFromSimilarity(0.2, 0.2)).toBe(1);   // at the floor
        expect(noveltyFromSimilarity(1, 0.2)).toBe(0);     // identical: zero novelty
        expect(noveltyFromSimilarity(0.6, 0.2)).toBeCloseTo(0.5, 5);
        expect(noveltyFromSimilarity(0.9, 1)).toBe(1);     // degenerate floor
    });

    test('noteConfidenceCeiling: evidence decides what a note may claim', () => {
        expect(noteConfidenceCeiling([])).toBe(0);
        // One mediocre synthesis claim cannot support near-certainty
        expect(noteConfidenceCeiling([{ confidence: 0.7, sourceId: 1, sourceQuality: 0.55 }]))
            .toBeCloseTo(0.385, 5);
        // A strong claim from a strong source supports a strong note
        expect(noteConfidenceCeiling([{ confidence: 0.95, sourceId: 1, sourceQuality: 0.95 }]))
            .toBeCloseTo(0.9025, 4);
        // Independent corroboration buys a bounded boost
        const corroborated = noteConfidenceCeiling([
            { confidence: 0.9, sourceId: 1, sourceQuality: 0.9 },
            { confidence: 0.8, sourceId: 2, sourceQuality: 0.9 },
            { confidence: 0.8, sourceId: 3, sourceQuality: 0.9 }
        ]);
        expect(corroborated).toBeCloseTo(0.81 + 0.1, 5);
        // Same-source repetition is not corroboration
        const sameSource = noteConfidenceCeiling([
            { confidence: 0.9, sourceId: 1, sourceQuality: 0.9 },
            { confidence: 0.8, sourceId: 1, sourceQuality: 0.9 }
        ]);
        expect(sameSource).toBeCloseTo(0.81, 5);
        // Nothing generated ever reaches 1.0
        expect(noteConfidenceCeiling([
            { confidence: 1, sourceId: 1, sourceQuality: 1 },
            { confidence: 1, sourceId: 2, sourceQuality: 1 },
            { confidence: 1, sourceId: 3, sourceQuality: 1 },
            { confidence: 1, sourceId: 4, sourceQuality: 1 }
        ])).toBe(0.98);
    });

    test('requireClaims drops evidence-less notes and their edges; confidence is evidence-capped', () => {
        const claimDetails = new Map([
            [1, { confidence: 0.7, sourceId: 10, sourceQuality: 0.55 }]
        ]);
        const proposals = clampKnowledgeProposals({
            upsert: [
                { type: 'concept', label: 'Grounded note', content: 'x', confidence: 0.99, claimIds: [1] },
                { type: 'concept', label: 'Vibes-only note', content: 'y', confidence: 0.97, claimIds: [] },
                { type: 'concept', label: 'Fake-claims note', content: 'z', confidence: 0.9, claimIds: [777] }
            ],
            link: [
                { source: 'Grounded note', target: 'Vibes-only note', relation: 'related_to' },
                { source: 'Grounded note', target: 'Existing elsewhere', relation: 'part_of' }
            ],
            contradict: [
                { source: 'Fake-claims note', target: 'Grounded note' }
            ]
        }, {
            validClaimIds: new Set([1]),
            claimDetails,
            requireClaims: true,
            nodeTypes: kgConfig.NODE_TYPES,
            maxNotes: 12,
            maxLinks: 20
        });
        expect(proposals.upsert.map(n => n.label)).toEqual(['Grounded note']);
        expect(proposals.droppedForNoEvidence).toBe(2);
        // The model's 0.99 was capped by what one mediocre claim supports
        expect(proposals.upsert[0].confidence).toBeCloseTo(0.385, 5);
        // Links/contradictions referencing dropped notes cannot sneak them in
        expect(proposals.link).toEqual([
            expect.objectContaining({ source: 'Grounded note', target: 'Existing elsewhere' })
        ]);
        expect(proposals.contradict).toEqual([]);
    });

    test('clampCoverage never returns null and clamps scores', () => {
        const coverage = clampCoverage({ coverageScore: 3, noveltyScore: -1, summary: 'ok' }, CAPS);
        expect(coverage).toMatchObject({ coverageScore: 1, noveltyScore: 0, summary: 'ok' });
        expect(clampCoverage(undefined, CAPS).coverageScore).toBe(0);
    });
});

describe('single-cycle vertical slice (fake model + search, real DB + legalizer)', () => {
    test('plan -> search -> sources -> claims -> notes -> provenance -> coverage -> leads', async () => {
        const userId = nextUser();
        const { expedition, cycle } = await makeExpeditionAndCycle({ userId });

        // An existing note + tag the research should reuse, not duplicate
        await kg.upsertNode({
            guildId: expedition.guildId, scopeKey: expedition.scopeKey,
            label: 'Amplitude-geometry connection', content: 'Known already.', source: 'user'
        });
        await kg.addTagsToNode({
            guildId: expedition.guildId, scopeKey: expedition.scopeKey,
            label: 'Amplitude-geometry connection', tags: ['geometry']
        });

        let persistedClaimIds = [];
        const ai = fakeAi({
            ...goodResponses({ claimIdsRef: () => persistedClaimIds }),
            knowledge: (prompt) => {
                // The prompt carries persisted claim ids; ground notes in them
                persistedClaimIds = [...prompt.matchAll(/\[claim (\d+)\]/g)].map(m => Number(m[1]));
                return JSON.stringify(goodResponses({ claimIdsRef: () => persistedClaimIds }).knowledge());
            }
        });
        const search = fakeSearch({
            'positive Grassmannian overview': [
                draft(),
                draft({ url: 'https://example.org/irrelevant', title: 'Cooking pasta', text: 'Boil water and add salt to taste for the pasta.' }),
                draft({ url: 'https://en.wikipedia.org/wiki/Positive_Grassmannian?utm_source=x' }) // same canonical URL
            ]
        });
        const pipeline = new SpitballResearchPipeline({ ai, embeddings: noEmbeddings, search: null, searchService: search });

        const result = await pipeline.runCycle({ expedition, cycle });

        // Plan + prompts carried the lens and intent
        expect(result.plan.searchQueries).toEqual(['positive Grassmannian overview']);
        expect(ai.calls[0]).toContain('Mathematics');
        expect(ai.calls[0]).toContain('understand scattering amplitudes');

        // Sources: relevant accepted, junk rejected with a reason, duplicate URL skipped
        const sources = await db.all(
            'SELECT * FROM research_sources WHERE expeditionId = @id ORDER BY id',
            { id: expedition.id }
        );
        expect(sources.length).toBe(2);
        const acceptedSource = sources.find(s => s.accepted === 1 || s.accepted === true);
        const rejected = sources.find(s => !(s.accepted === 1 || s.accepted === true));
        expect(acceptedSource.canonicalUrl).toBe('https://en.wikipedia.org/wiki/Positive_Grassmannian');
        expect(acceptedSource.contentHash).toBeTruthy();
        expect(rejected.rejectionReason).toBe('below relevance threshold');
        expect(result.counters.sourceCount).toBe(2);
        expect(result.counters.sourcesAccepted).toBe(1);

        // Claims persisted with provenance to their source
        const claims = await db.all(
            'SELECT * FROM research_claims WHERE expeditionId = @id ORDER BY id',
            { id: expedition.id }
        );
        expect(claims.length).toBe(2);
        expect(claims.every(claim => claim.sourceId === acceptedSource.id)).toBe(true);
        expect(claims[0].kind).toBe('factual');
        expect(result.counters.claimsExtracted).toBe(2);

        // Notes committed through the legalizer with research provenance
        const newNode = await kg.getNode(expedition.guildId, 'Positroid cell decomposition', expedition.scopeKey);
        expect(newNode).toBeTruthy();
        expect(newNode.source).toBe('research');
        const provenance = await db.all(
            'SELECT sourceKind, sourceId FROM kg_provenance WHERE nodeId = @id',
            { id: newNode.id }
        );
        expect(provenance).toEqual(expect.arrayContaining([
            { sourceKind: 'expedition', sourceId: expedition.id },
            { sourceKind: 'research_claim', sourceId: claims[0].id }
        ]));

        // Confidence was capped deterministically by the evidence: two claims
        // (0.9, 0.7) from one 0.9-quality source support at most 0.81, so the
        // model's proposed 0.85 could not survive
        expect(newNode.confidence).toBeCloseTo(0.81, 5);

        // The existing note was reused (updated in place), never duplicated
        const dupes = await db.all(
            `SELECT id FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey
             AND label = 'Amplitude-geometry connection'`,
            { guildId: expedition.guildId, scopeKey: expedition.scopeKey }
        );
        expect(dupes.length).toBe(1);
        expect(result.counters.notesProposed).toBe(2);
        expect(result.counters.notesCreated + result.counters.notesMerged).toBe(2);
        expect(result.counters.edgesCreated).toBe(1);
        expect(result.counters.tagsAdded).toBeGreaterThan(0);

        // The tagging prompt offered the existing vocabulary
        const knowledgePrompt = ai.calls.find(p => p.includes('ATOMIC knowledge notes'));
        expect(knowledgePrompt).toContain('Reuse these existing tags');
        expect(knowledgePrompt).toContain('geometry');

        // ... and taught the generator HOW the graph is used: the shared
        // use-case block plus this lens's example note network
        expect(knowledgePrompt).toContain('How this knowledge graph is used');
        expect(knowledgePrompt).toContain('Example of well-formed notes and connectivity');
        expect(knowledgePrompt).toContain('Positroid cell'); // the mathematics lens example
        expect(knowledgePrompt).toContain('-decomposes_into->');

        // The Lens shaped source selection: preferences were handed to the
        // search registry, and the preferred 'reference' class got its
        // quality bonus on the accepted source
        expect(search.opts[0].preferredSourceTypes).toEqual(
            expect.arrayContaining(['reference', 'preprint'])
        );
        expect(acceptedSource.qualityScore).toBeCloseTo(0.9, 5);

        // Coverage + ranked Leads (weak lead ranked last)
        expect(result.coverage.summary).toContain('decomposition');
        expect(result.coverage.unresolvedQuestions).toEqual(['How are positroid cells parameterized?']);
        expect(result.leads.map(lead => lead.topic)).toEqual(['positroid stratification', 'weak aside']);
        expect(result.noveltyScore).toBe(0.8);
    });

    test('a mid-cycle Pause interrupts the real pipeline before further spend', async () => {
        const userId = nextUser();
        const { expedition, cycle } = await makeExpeditionAndCycle({ userId });
        const ai = fakeAi(goodResponses({ claimIdsRef: () => [] }));
        // The user pauses while the search stage is fetching
        const search = {
            async search() {
                await expeditionService.pauseExpedition(expedition.id, { userId });
                return [draft()];
            }
        };
        const pipeline = new SpitballResearchPipeline({ ai, embeddings: noEmbeddings, searchService: search });

        await expect(pipeline.runCycle({
            expedition, cycle,
            checkpoint: () => expeditionService.checkpoint(expedition.id)
        })).rejects.toMatchObject({ name: 'ExpeditionInterrupted' });

        // Nothing after the interrupt spent anything: no sources persisted,
        // no claim-extraction or knowledge model calls
        const sources = await db.all(
            'SELECT id FROM research_sources WHERE expeditionId = @id', { id: expedition.id }
        );
        expect(sources).toEqual([]);
        expect(ai.calls.some(p => p.includes('Extract structured evidence'))).toBe(false);
        expect(ai.calls.some(p => p.includes('ATOMIC knowledge notes'))).toBe(false);
    });

    test('semantic novelty rejects same-topic rewordings before claim extraction', async () => {
        const userId = nextUser();
        const { expedition, cycle } = await makeExpeditionAndCycle({ userId, depth: 'standard' });
        const original = draft(); // canonical positive-Grassmannian text
        const reworded = draft({
            url: 'https://mirror.example.org/grassmannian-summary',
            title: 'A summary of the positive Grassmannian',
            // Different bytes and URL, same content in shuffled words: the
            // hash/URL dedupe misses it; the novelty gate must not
            text: 'Scattering amplitudes relate to its geometry. The positive Grassmannian decomposes into positroid cells indeed.'
        });
        let persistedClaimIds = [];
        const ai = fakeAi({
            ...goodResponses({ claimIdsRef: () => persistedClaimIds }),
            knowledge: (prompt) => {
                persistedClaimIds = [...prompt.matchAll(/\[claim (\d+)\]/g)].map(m => Number(m[1]));
                return JSON.stringify(goodResponses({ claimIdsRef: () => persistedClaimIds }).knowledge());
            }
        });
        const search = fakeSearch({ '*': [original, reworded] });
        const pipeline = new SpitballResearchPipeline({ ai, embeddings: noEmbeddings, searchService: search });

        const result = await pipeline.runCycle({ expedition, cycle });
        expect(result.counters.sourcesAccepted).toBe(1);
        const rejected = await db.get(
            `SELECT rejectionReason, noveltyScore FROM research_sources
             WHERE expeditionId = @id AND accepted = 0`,
            { id: expedition.id }
        );
        expect(rejected.rejectionReason).toBe('redundant with accepted sources');
        expect(rejected.noveltyScore).toBeLessThanOrEqual(0.35);
        // Only the accepted source reached claim extraction
        expect(ai.calls.filter(p => p.includes('Extract structured evidence'))).toHaveLength(1);
    });

    test('a retried cycle dedupes sources by canonical URL and content hash', async () => {
        const userId = nextUser();
        const { expedition, cycle } = await makeExpeditionAndCycle({ userId, depth: 'standard' });
        const ai = fakeAi(goodResponses({ claimIdsRef: () => [] }));
        const search = fakeSearch({ '*': [draft()] });
        const pipeline = new SpitballResearchPipeline({ ai, embeddings: noEmbeddings, searchService: search });

        const first = await pipeline.runCycle({ expedition, cycle });
        expect(first.counters.sourcesAccepted).toBe(1);

        // Same results again (a retry or the next cycle finding the same pages)
        const fresh = await expeditionService.getById(expedition.id);
        const secondCycle = await expeditionService.startCycle(expedition.id, {});
        const second = await pipeline.runCycle({ expedition: fresh, cycle: secondCycle });
        expect(second.counters.sourceCount).toBe(0);
        expect(second.counters.sourcesAccepted).toBe(0);
        expect(second.coverage.summary).toContain('No usable sources');
        expect(second.leads).toEqual([]);
    });

    test('the per-cycle accepted-source cap and expedition budget hold', async () => {
        const userId = nextUser();
        const { expedition, cycle } = await makeExpeditionAndCycle({ userId, depth: 'focused' });
        // Each text is lexically distinct (so the novelty gate is not what
        // rejects them) while staying relevant to the seed
        const facets = [
            'cluster algebra mutations quiver seeds exchange relations',
            'amplituhedron volume forms twistor variables locality unitarity',
            'plabic graph moves trip permutations boundary measurements',
            'totally nonnegative matrices minors cell parametrization charts',
            'soliton solutions kadomtsev petviashvili equation regularity',
            'juggling patterns affine permutations bounded windows cyclic',
            'canonical bases crystal combinatorics parametrizations lusztig',
            'flag varieties schubert calculus intersection cohomology strata',
            'momentum twistors dual conformal symmetry loop integrands',
            'matroid strata realization spaces mnev universality boundaries',
            'network parametrization edge weights gauge equivalence flows',
            'shifted symplectic structures derived geometry lagrangians'
        ];
        const many = facets.map((facet, i) =>
            draft({
                url: `https://example.org/grassmannian-${i}`,
                title: `Positive Grassmannian article ${i}`,
                text: `Positive Grassmannian study ${i}: ${facet}.`
            }));
        const ai = fakeAi(goodResponses({ claimIdsRef: () => [] }));
        const search = fakeSearch({ '*': many });
        const pipeline = new SpitballResearchPipeline({ ai, embeddings: noEmbeddings, searchService: search });

        const result = await pipeline.runCycle({ expedition, cycle });
        expect(result.counters.sourcesAccepted)
            .toBeLessThanOrEqual(Math.min(CAPS.maxAcceptedSourcesPerCycle, expedition.maxSources));
        const rejectedForBudget = await db.get(
            `SELECT COUNT(*) AS c FROM research_sources
             WHERE expeditionId = @id AND accepted = 0 AND rejectionReason = 'source budget reached'`,
            { id: expedition.id }
        );
        expect(rejectedForBudget.c).toBeGreaterThan(0);
    });

    test('a failed planner degrades to deterministic frontier/seed queries', async () => {
        const userId = nextUser();
        const { expedition, cycle } = await makeExpeditionAndCycle({ userId });
        const ai = fakeAi({ ...goodResponses({ claimIdsRef: () => [] }), plan: new Error('model down') });
        const search = fakeSearch({ '*': [draft()] });
        const pipeline = new SpitballResearchPipeline({ ai, embeddings: noEmbeddings, searchService: search });

        const result = await pipeline.runCycle({ expedition, cycle });
        expect(search.queries).toContain('positive Grassmannian');
        expect(result.counters.sourcesAccepted).toBe(1);
    });

    test('malformed knowledge output commits nothing (no partial writes)', async () => {
        const userId = nextUser();
        const { expedition, cycle } = await makeExpeditionAndCycle({ userId });
        const ai = fakeAi({
            ...goodResponses({ claimIdsRef: () => [] }),
            knowledge: 'this is not json at all'
        });
        const search = fakeSearch({ '*': [draft()] });
        const pipeline = new SpitballResearchPipeline({ ai, embeddings: noEmbeddings, searchService: search });

        const result = await pipeline.runCycle({ expedition, cycle });
        expect(result.counters.claimsExtracted).toBe(2);
        expect(result.counters.notesProposed).toBe(0);
        expect(result.counters.notesCreated).toBe(0);
        const nodes = await db.all(
            `SELECT id FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey AND source = 'research'`,
            { guildId: expedition.guildId, scopeKey: expedition.scopeKey }
        );
        expect(nodes.length).toBe(0);
        // Novelty is deterministically floored when nothing new was created
        expect(result.noveltyScore).toBeLessThanOrEqual(0.05);
    });

    test('a failed coverage call falls back and lets the policy stop cleanly', async () => {
        const userId = nextUser();
        const { expedition, cycle } = await makeExpeditionAndCycle({ userId });
        let persistedClaimIds = [];
        const ai = fakeAi({
            ...goodResponses({ claimIdsRef: () => persistedClaimIds }),
            knowledge: (prompt) => {
                persistedClaimIds = [...prompt.matchAll(/\[claim (\d+)\]/g)].map(m => Number(m[1]));
                return JSON.stringify(goodResponses({ claimIdsRef: () => persistedClaimIds }).knowledge());
            },
            coverage: new Error('model down')
        });
        const search = fakeSearch({ '*': [draft()] });
        const pipeline = new SpitballResearchPipeline({ ai, embeddings: noEmbeddings, searchService: search });

        const result = await pipeline.runCycle({ expedition, cycle });
        expect(result.leads).toEqual([]);
        expect(result.coverage.summary).toContain('unavailable');
        const decision = expeditionService.decideContinuation({
            expedition: await expeditionService.getById(expedition.id),
            cycle: { status: 'COMPLETED', sourcesAccepted: result.counters.sourcesAccepted, noveltyScore: result.noveltyScore, coverageScore: result.coverageScore },
            leads: result.leads
        });
        expect(decision.continue).toBe(false);
    });
});

describe('search provider registry', () => {
    test('a broken provider is skipped, results merge across providers', async () => {
        const service = new SpitballSearchService([
            { name: 'broken', isAvailable: () => true, search: async () => { throw new Error('boom'); } },
            { name: 'silent', isAvailable: () => false, search: async () => [draft({ url: 'https://never.example' })] },
            { name: 'ok', isAvailable: () => true, search: async () => [draft()] }
        ]);
        expect(service.availableProviders()).toEqual(['broken', 'ok']);
        const results = await service.search('anything');
        expect(results.length).toBe(1);
        expect(results[0].url).toContain('Positive_Grassmannian');
    });

    test('onlyWhenPreferred providers run only when the Lens wants their class', async () => {
        const scholarly = {
            name: 'scholarly',
            sourceTypes: ['preprint', 'peer_reviewed'],
            onlyWhenPreferred: true,
            isAvailable: () => true,
            search: jest.fn(async () => [draft({ url: 'https://arxiv.example/1', sourceType: 'preprint' })])
        };
        const general = {
            name: 'general', sourceTypes: ['reference'],
            isAvailable: () => true, search: async () => [draft()]
        };
        const service = new SpitballSearchService([scholarly, general]);

        // A lens that does not prefer preprints: scholarly stays out
        const casual = await service.search('q', { preferredSourceTypes: ['reference', 'news'] });
        expect(scholarly.search).not.toHaveBeenCalled();
        expect(casual.length).toBe(1);

        // A scholarly lens brings it in
        const scholarlyResults = await service.search('q', { preferredSourceTypes: ['peer_reviewed', 'preprint'] });
        expect(scholarly.search).toHaveBeenCalledTimes(1);
        expect(scholarlyResults.length).toBe(2);

        // No preferences at all (defensive callers): opt-in providers stay out
        await service.search('q');
        expect(scholarly.search).toHaveBeenCalledTimes(1);
    });
});

describe('runner end to end with the real pipeline', () => {
    test('a focused expedition researches, commits knowledge, and completes', async () => {
        const userId = nextUser();
        const events = [];
        const unsubscribe = domainEventBus.subscribe('research.*', (event) => {
            if (event.payload.userId === userId) events.push(event.topic);
        });
        try {
            let persistedClaimIds = [];
            const ai = fakeAi({
                ...goodResponses({ claimIdsRef: () => persistedClaimIds }),
                knowledge: (prompt) => {
                    persistedClaimIds = [...prompt.matchAll(/\[claim (\d+)\]/g)].map(m => Number(m[1]));
                    return JSON.stringify(goodResponses({ claimIdsRef: () => persistedClaimIds }).knowledge());
                }
            });
            const search = fakeSearch({ '*': [draft()] });
            const pipeline = new SpitballResearchPipeline({ ai, embeddings: noEmbeddings, searchService: search });
            const runner = new SpitballExpeditionRunner({
                pipeline,
                reflection: { runScope: async () => ({}) }
            });

            const expedition = await expeditionService.createExpedition({
                userId, seed: 'positive Grassmannian', lensId: 'mathematics',
                intent: 'understand scattering amplitudes', depth: 'focused'
            });
            runner.kick(expedition.id);
            await runner.waitFor(expedition.id);

            const done = await expeditionService.getExpedition(expedition.id, { userId });
            expect(done.status).toBe('COMPLETED');
            expect(done.stopReason).toBe('MAX_CYCLES'); // focused = 1 cycle
            expect(done.notesCreated + done.edgesCreated).toBeGreaterThan(0);
            expect(done.summary).toContain('decomposition');

            const detail = await expeditionService.getExpeditionDetail(expedition.id, { userId });
            expect(detail.cycles.length).toBe(1);
            expect(detail.cycles[0].status).toBe('COMPLETED');
            expect(detail.sources.some(source => source.accepted)).toBe(true);
            expect(detail.leads[0].topic).toBe('positroid stratification');

            // Committed notes are immediately retrievable (spec §50.11)
            const excerpt = await kg.describeForPrompt({
                guildId: done.guildId, scopeKey: done.scopeKey, query: 'positroid'
            });
            expect(excerpt).toContain('Positroid cell decomposition');

            expect(events).toEqual(expect.arrayContaining([
                'research.expedition_started',
                'research.cycle_started',
                'research.cycle_completed',
                'research.lead_discovered',
                'research.expedition_completed'
            ]));
        } finally {
            unsubscribe();
        }
    });
});
