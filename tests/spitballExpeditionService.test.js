/**
 * Spitball Expeditions (services/spitballExpeditionService.js + the runner).
 * Spec: documentation/spitball_expeditions.md
 *
 * Exercises the durable lifecycle against the real database (both engines via
 * the CI matrix): creation + input validation + caps, the state machine
 * (pause/continue/cancel, illegal transitions, ownership 404s), the
 * deterministic continuation policy (budgets, novelty saturation, no new
 * sources, no leads), the recursive loop with a mocked pipeline (cycle N's
 * Leads become cycle N+1's frontier input, transcripts never carry forward),
 * failure isolation (a crashing cycle fails the expedition without corrupting
 * state), restart safety (orphaned RUNNING runs park PAUSED, queued ones are
 * picked back up), research provenance through the knowledge graph legalizer,
 * domain events, and /forget-me erasure.
 */
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-spitball-test-${process.pid}.sqlite`);

// The legalizer's semantic dedupe requires embeddingService internally; mock
// the module so tests never reach a real embedding backend.
jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    embedBatch: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    cosineSimilarity: jest.fn(() => 0)
}));

const db = require('@goobster/core/db');
const domainEventBus = require('@goobster/core/services/domainEventBus');
const spitballConfig = require('@goobster/core/config/spitballConfig');
const lensConfig = require('@goobster/core/config/spitballLensConfig');
const expeditionService = require('@goobster/core/services/spitballExpeditionService');
const { SpitballExpeditionService, SpitballError } = require('@goobster/core/services/spitballExpeditionService');
const { SpitballExpeditionRunner } = require('@goobster/core/services/spitballExpeditionRunner');

let userSeq = 0;
function nextUser() {
    userSeq += 1;
    return `sb-user-${process.pid}-${userSeq}`;
}

/** A cycle result the continuation policy reads as "worth continuing". */
function richCycleResult({ leads, novelty = 0.8, coverage = 0.4, summary = 'Learned things.' } = {}) {
    return {
        plan: { questions: ['q1'], searchQueries: ['s1'] },
        counters: {
            sourceCount: 4, sourcesAccepted: 3, claimsExtracted: 6,
            notesProposed: 5, notesCreated: 4, notesMerged: 1,
            edgesCreated: 3, tagsAdded: 2, conflictsFound: 0
        },
        coverage: {
            summary,
            unresolvedQuestions: ['what remains open?'],
            majorNewConcepts: ['concept-a', 'concept-b'],
            coverageScore: coverage,
            noveltyScore: novelty
        },
        leads: leads ?? [
            { topic: 'promising subtopic', kind: 'subtopic', reason: 'central', expectedValue: 0.6, novelty: 0.7 }
        ],
        noveltyScore: novelty,
        coverageScore: coverage
    };
}

/** A pipeline that returns canned results per cycle number and records calls. */
function mockPipeline(resultsByCycle) {
    const calls = [];
    return {
        calls,
        async runCycle({ expedition, cycle, frontierInput }) {
            calls.push({ expeditionId: expedition.id, cycleNumber: cycle.cycleNumber, frontierInput });
            const result = resultsByCycle[cycle.cycleNumber - 1];
            if (result instanceof Error) throw result;
            if (!result) throw new Error(`mock pipeline has no result for cycle ${cycle.cycleNumber}`);
            return result;
        }
    };
}

/** A reflection stand-in: records runScope calls instead of weaving. */
function fakeReflection({ fail = false } = {}) {
    const runs = [];
    return {
        runs,
        async runScope(params) {
            runs.push(params);
            if (fail) throw new Error('reflection exploded');
            return { runId: runs.length, summary: {} };
        }
    };
}

function makeRunner(pipeline, { service = expeditionService, reflection = fakeReflection() } = {}) {
    return new SpitballExpeditionRunner({ service, pipeline, reflection });
}

async function runToCompletion(runner, expeditionId) {
    runner.kick(expeditionId);
    await runner.waitFor(expeditionId);
}

afterAll(async () => {
    await domainEventBus.close();
});

describe('lens profiles', () => {
    test('presets are well-formed and resolvable', () => {
        expect(lensConfig.LENSES.length).toBeGreaterThanOrEqual(5);
        for (const lens of lensConfig.LENSES) {
            expect(lens.id).toMatch(/^[a-z][a-z-]*$/);
            expect(lens.name.length).toBeGreaterThan(0);
            expect(Array.isArray(lens.sourcePreferences)).toBe(true);
            expect(Array.isArray(lens.relationshipPriorities)).toBe(true);
            expect(Array.isArray(lens.noteArchetypes)).toBe(true);
            expect(typeof lens.epistemicPolicy).toBe('object');
            expect(lensConfig.getLens(lens.id)).toBe(lens);
            expect(lensConfig.isValidLensId(lens.id)).toBe(true);
        }
        expect(lensConfig.isValidLensId(lensConfig.DEFAULT_LENS_ID)).toBe(true);
    });

    test('lookup is case/whitespace tolerant and rejects unknowns', () => {
        expect(lensConfig.getLens(' Mathematics ')).toBe(lensConfig.getLens('mathematics'));
        expect(lensConfig.getLens('neo4j-vibes')).toBeNull();
        expect(lensConfig.isValidLensId(null)).toBe(false);
    });

    test('every lens ships a well-formed example note network for the generator', () => {
        const kgConfig = require('@goobster/core/config/knowledgeGraphConfig');
        expect(typeof lensConfig.GRAPH_USE_CASES).toBe('string');
        expect(lensConfig.GRAPH_USE_CASES).toContain('contradicts');
        expect(lensConfig.GRAPH_USE_CASES).toContain('tag');
        for (const lens of lensConfig.LENSES) {
            const example = lens.example;
            expect(example?.scenario?.length).toBeGreaterThan(0);
            expect(example.notes.length).toBeGreaterThanOrEqual(3);
            const labels = new Set(example.notes.map(note => note.label));
            for (const note of example.notes) {
                // Examples must model LEGAL output: real kg node types only
                expect(kgConfig.NODE_TYPES).toContain(note.type);
                expect(note.label.length).toBeLessThanOrEqual(kgConfig.MAX_LABEL_LENGTH);
                expect(note.tags.length).toBeGreaterThan(0);
            }
            // Connections reference example notes and carry real relations
            expect(example.connections.length).toBeGreaterThan(0);
            for (const edge of example.connections) {
                expect(labels.has(edge.source)).toBe(true);
                expect(labels.has(edge.target)).toBe(true);
                expect(edge.relation.length).toBeGreaterThan(0);
                expect(edge.relation.length).toBeLessThanOrEqual(kgConfig.MAX_RELATION_LENGTH);
            }
            // At least one shared tag, demonstrating implicit clustering
            const counts = {};
            for (const note of example.notes) {
                for (const tag of note.tags) counts[tag] = (counts[tag] || 0) + 1;
            }
            expect(Object.values(counts).some(count => count >= 2)).toBe(true);
        }
    });
});

describe('expedition creation', () => {
    test('creates a QUEUED expedition in the personal scope with preset budgets', async () => {
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({
            userId, seed: 'positive Grassmannian', lensId: 'mathematics',
            intent: 'understand scattering amplitudes', depth: 'focused'
        });
        expect(expedition.status).toBe('QUEUED');
        expect(expedition.guildId).toBe(`dm:${userId}`);
        expect(expedition.scopeKey).toBe(`USER:${userId}`);
        expect(expedition.seed).toBe('positive Grassmannian');
        expect(expedition.lensId).toBe('mathematics');
        expect(expedition.lens.name).toBe('Mathematics');
        expect(expedition.maxCycles).toBe(spitballConfig.DEPTH_PRESETS.focused.maxCycles);
        expect(expedition.maxSources).toBe(spitballConfig.DEPTH_PRESETS.focused.maxSources);
        expect(expedition.maxNotes).toBe(spitballConfig.DEPTH_PRESETS.focused.maxNotes);
        expect(expedition.currentCycle).toBe(0);
        expect(expedition.researchBrief).toMatchObject({
            shape: 'deep_dive',
            depthPerUnit: 'deep'
        });
        expect(expedition.continuationProposal).toBeNull();
    });

    test('a roster-of-figures intent stores a survey brief', async () => {
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({
            userId,
            seed: 'modern physics',
            intent: 'a history of all the most important figures that lead to modern physics',
            depth: 'deep'
        });
        expect(expedition.researchBrief.shape).toBe('survey');
        expect(expedition.researchBrief.unitKind).toBe('person');
        expect(expedition.researchBrief.varietyTarget).toBeGreaterThanOrEqual(12);
    });

    test('defaults lens and depth; validates inputs', async () => {
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({ userId, seed: 'road runner biology' });
        expect(expedition.lensId).toBe(lensConfig.DEFAULT_LENS_ID);
        expect(expedition.depth).toBe(spitballConfig.DEFAULT_DEPTH);

        await expect(expeditionService.createExpedition({ userId: nextUser(), seed: '   ' }))
            .rejects.toMatchObject({ code: 'SEED_REQUIRED' });
        await expect(expeditionService.createExpedition({ userId: nextUser(), seed: 'x', lensId: 'flask-vibes' }))
            .rejects.toMatchObject({ code: 'UNKNOWN_LENS' });
        await expect(expeditionService.createExpedition({ userId: nextUser(), seed: 'x', depth: 'bottomless' }))
            .rejects.toMatchObject({ code: 'UNKNOWN_DEPTH' });
    });

    test('clamps seed/intent/lensText to input caps', async () => {
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({
            userId,
            seed: 'S'.repeat(1000),
            intent: 'I'.repeat(5000),
            lensText: 'L'.repeat(5000)
        });
        expect(expedition.seed.length).toBe(spitballConfig.INPUT_CAPS.maxSeedLength);
        expect(expedition.intent.length).toBe(spitballConfig.INPUT_CAPS.maxIntentLength);
        expect(expedition.lensText.length).toBe(spitballConfig.INPUT_CAPS.maxLensTextLength);
    });

    test('enforces the active-expeditions cap per user', async () => {
        const userId = nextUser();
        const service = new SpitballExpeditionService({ ...spitballConfig, maxActiveExpeditionsPerUser: 1 });
        await service.createExpedition({ userId, seed: 'first topic' });
        await expect(service.createExpedition({ userId, seed: 'second topic' }))
            .rejects.toMatchObject({ code: 'TOO_MANY_ACTIVE' });
    });
});

describe('state machine', () => {
    test('pause -> continue -> cancel round trip', async () => {
        const userId = nextUser();
        const created = await expeditionService.createExpedition({ userId, seed: 'byzantine iconoclasm' });

        const paused = await expeditionService.pauseExpedition(created.id, { userId });
        expect(paused.status).toBe('PAUSED');
        expect(paused.stopReason).toBe('USER_PAUSED');

        const resumed = await expeditionService.continueExpedition(created.id, { userId });
        expect(resumed.status).toBe('QUEUED');
        expect(resumed.stopReason).toBeNull();

        const cancelled = await expeditionService.cancelExpedition(created.id, { userId });
        expect(cancelled.status).toBe('CANCELLED');
        expect(cancelled.stopReason).toBe('USER_CANCELLED');
        expect(cancelled.finishedAt).toBeTruthy();
    });

    test('illegal transitions are rejected without corrupting state', async () => {
        const userId = nextUser();
        const created = await expeditionService.createExpedition({ userId, seed: 'desalination membranes' });
        await expeditionService.cancelExpedition(created.id, { userId });

        await expect(expeditionService.pauseExpedition(created.id, { userId }))
            .rejects.toMatchObject({ code: 'BAD_STATE' });
        await expect(expeditionService.continueExpedition(created.id, { userId }))
            .rejects.toMatchObject({ code: 'BAD_STATE' });
        await expect(expeditionService.cancelExpedition(created.id, { userId }))
            .rejects.toMatchObject({ code: 'BAD_STATE' });
        const after = await expeditionService.getExpedition(created.id, { userId });
        expect(after.status).toBe('CANCELLED');
    });

    test('strangers get the same 404 as a missing expedition', async () => {
        const owner = nextUser();
        const created = await expeditionService.createExpedition({ userId: owner, seed: 'private topic' });
        await expect(expeditionService.getExpedition(created.id, { userId: nextUser() }))
            .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
        await expect(expeditionService.getExpedition(999999, { userId: owner }))
            .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
        await expect(expeditionService.cancelExpedition(created.id, { userId: nextUser() }))
            .rejects.toMatchObject({ status: 404 });
    });

    test('claimForRun is atomic: a second claim loses', async () => {
        const userId = nextUser();
        const created = await expeditionService.createExpedition({ userId, seed: 'double-run guard' });
        expect(await expeditionService.claimForRun(created.id)).toBe(true);
        expect(await expeditionService.claimForRun(created.id)).toBe(false);
    });
});

describe('continuation policy (pure decisions)', () => {
    const base = {
        status: 'RUNNING', currentCycle: 1, maxCycles: 3,
        notesCreated: 5, maxNotes: 60, sourcesAccepted: 3, maxSources: 25
    };
    const goodCycle = { status: 'COMPLETED', sourcesAccepted: 3, noveltyScore: 0.8, coverageScore: 0.4 };
    const goodLeads = [{ topic: 'next', expectedValue: 0.5 }];

    test('continues when budgets and signals allow', () => {
        const decision = expeditionService.decideContinuation({ expedition: base, cycle: goodCycle, leads: goodLeads });
        expect(decision).toEqual({ continue: true, reason: null });
    });

    test('hard budgets always stop', () => {
        expect(expeditionService.decideContinuation({
            expedition: { ...base, currentCycle: 3 }, cycle: goodCycle, leads: goodLeads
        }).reason).toBe('MAX_CYCLES');
        expect(expeditionService.decideContinuation({
            expedition: { ...base, notesCreated: 60 }, cycle: goodCycle, leads: goodLeads
        }).reason).toBe('MAX_NOTES');
        expect(expeditionService.decideContinuation({
            expedition: { ...base, sourcesAccepted: 25 }, cycle: goodCycle, leads: goodLeads
        }).reason).toBe('MAX_SOURCES');
    });

    test('information-quality conditions stop', () => {
        expect(expeditionService.decideContinuation({
            expedition: base, cycle: { ...goodCycle, sourcesAccepted: 0 }, leads: goodLeads
        }).reason).toBe('NO_NEW_SOURCES');
        expect(expeditionService.decideContinuation({
            expedition: base, cycle: { ...goodCycle, coverageScore: 0.95 }, leads: goodLeads
        }).reason).toBe('COVERAGE_SATURATED');
        expect(expeditionService.decideContinuation({
            expedition: base, cycle: goodCycle, leads: []
        }).reason).toBe('NO_LEADS');
        expect(expeditionService.decideContinuation({
            expedition: base, cycle: goodCycle, leads: [{ topic: 'weak', expectedValue: 0.05 }]
        }).reason).toBe('NO_LEADS');
    });

    test('novelty must stay low for consecutive cycles before stopping', () => {
        const lowNovelty = { ...goodCycle, noveltyScore: 0.05 };
        // One low-novelty cycle alone does not stop
        expect(expeditionService.decideContinuation({
            expedition: base, cycle: lowNovelty, leads: goodLeads, recentCycles: [goodCycle]
        }).continue).toBe(true);
        // Two in a row saturate
        expect(expeditionService.decideContinuation({
            expedition: base, cycle: lowNovelty, leads: goodLeads, recentCycles: [lowNovelty]
        }).reason).toBe('NOVELTY_SATURATED');
    });

    test('a paused/cancelled expedition never continues', () => {
        expect(expeditionService.decideContinuation({
            expedition: { ...base, status: 'PAUSED', stopReason: 'USER_PAUSED' },
            cycle: goodCycle, leads: goodLeads
        })).toEqual({ continue: false, reason: 'USER_PAUSED' });
    });

    test('an incomplete survey roster is not a quality stop', () => {
        const incomplete = {
            rosterIncomplete: true,
            uncoveredUnits: [{ label: 'Niels Bohr', kind: 'person' }]
        };
        expect(expeditionService.decideContinuation({
            expedition: base,
            cycle: { ...goodCycle, coverageScore: 0.95 },
            leads: [],
            progress: incomplete
        })).toEqual({ continue: true, reason: null });
        expect(expeditionService.decideContinuation({
            expedition: base,
            cycle: { ...goodCycle, noveltyScore: 0.05 },
            leads: [],
            recentCycles: [{ ...goodCycle, noveltyScore: 0.05 }],
            progress: incomplete
        })).toEqual({ continue: true, reason: null });
        // Hard budgets still win
        expect(expeditionService.decideContinuation({
            expedition: { ...base, currentCycle: 3 },
            cycle: goodCycle,
            leads: goodLeads,
            progress: incomplete
        }).reason).toBe('MAX_CYCLES');
    });
});

describe('the recursive loop (mocked pipeline)', () => {
    test('cycle N leads feed cycle N+1 frontier input; transcripts never carry forward', async () => {
        const userId = nextUser();
        const leads1 = [
            { topic: 'positroid stratification', kind: 'subtopic', expectedValue: 0.9, novelty: 0.9 },
            { topic: 'cluster algebras link', kind: 'cross_domain_connection', expectedValue: 0.5, novelty: 0.6 }
        ];
        const pipeline = mockPipeline([
            richCycleResult({ leads: leads1, summary: 'Mapped the landscape.' }),
            richCycleResult({ leads: [], summary: 'Expanded the frontier.' })
        ]);
        const expedition = await expeditionService.createExpedition({
            userId, seed: 'positive Grassmannian', lensId: 'mathematics', intent: 'amplitudes', depth: 'standard'
        });
        const runner = makeRunner(pipeline);
        await runToCompletion(runner, expedition.id);

        expect(pipeline.calls.length).toBe(2);
        const first = pipeline.calls[0].frontierInput;
        expect(first.cycleNumber).toBe(1);
        expect(first.originalSeed).toBe('positive Grassmannian');
        expect(first.previousLeads).toEqual([]);
        expect(first.acceptedSources).toEqual([]);
        expect(first.acceptedClaims).toEqual([]);
        expect(first.gaps).toEqual([]);

        const second = pipeline.calls[1].frontierInput;
        expect(second.cycleNumber).toBe(2);
        expect(second.originalSeed).toBe('positive Grassmannian');
        expect(second.intent).toBe('amplitudes');
        expect(second.previousLeads.map(l => l.topic)).toEqual(leads1.map(l => l.topic));
        expect(second.unresolvedQuestions).toEqual(['what remains open?']);
        expect(second.gaps).toEqual(expect.arrayContaining(['what remains open?']));
        expect(second.coverageSummary).toBe('Mapped the landscape.');
        expect(second.avoidRepeating).toEqual(expect.arrayContaining(['concept-a', 'concept-b']));
        expect(second.acceptedSources).toEqual([]);
        expect(second.acceptedClaims).toEqual([]);
        // The compact recursive contract: no transcript-shaped payloads
        expect(JSON.stringify(second)).not.toContain('assistant');

        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.status).toBe('COMPLETED');
        expect(done.stopReason).toBe('NO_LEADS');
        expect(done.currentCycle).toBe(2);
        expect(done.notesCreated).toBe(8); // 4 per cycle rollup
        const cycles = await expeditionService.listCycles(expedition.id, { userId });
        expect(cycles.map(c => c.status)).toEqual(['COMPLETED', 'COMPLETED']);
        expect(cycles[0].leads.map(l => l.topic)).toEqual(leads1.map(l => l.topic));
    });

    test('hard maxCycles always terminates recursion', async () => {
        const userId = nextUser();
        // A pipeline that always wants to continue
        const always = () => richCycleResult({});
        const pipeline = { calls: [], runCycle: async ({ cycle }) => { pipeline.calls.push(cycle.cycleNumber); return always(); } };
        const expedition = await expeditionService.createExpedition({ userId, seed: 'unbounded topic', depth: 'standard' });
        await runToCompletion(makeRunner(pipeline), expedition.id);
        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.status).toBe('COMPLETED');
        expect(done.stopReason).toBe('MAX_CYCLES');
        expect(done.currentCycle).toBe(done.maxCycles);
        expect(pipeline.calls.length).toBe(done.maxCycles);
        expect(done.continuationProposal?.needed).toBe(true);
        expect(done.continuationProposal?.suggestedCycles).toBeGreaterThanOrEqual(1);
    });

    test('extendExpedition accepts a proposal and re-queues with raised budgets', async () => {
        const userId = nextUser();
        const always = () => richCycleResult({});
        const pipeline = { calls: [], runCycle: async ({ cycle }) => { pipeline.calls.push(cycle.cycleNumber); return always(); } };
        const expedition = await expeditionService.createExpedition({
            userId,
            seed: 'modern physics',
            intent: 'a history of all the most important figures that lead to modern physics',
            depth: 'focused'
        });
        await runToCompletion(makeRunner(pipeline), expedition.id);
        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.status).toBe('COMPLETED');
        expect(done.stopReason).toBe('MAX_CYCLES');
        expect(done.continuationProposal?.needed).toBe(true);

        const extended = await expeditionService.extendExpedition(done.id, { userId });
        expect(extended.status).toBe('QUEUED');
        expect(extended.maxCycles).toBeGreaterThan(done.maxCycles);
        expect(extended.maxSources).toBeGreaterThan(done.maxSources);
        expect(extended.currentCycle).toBe(done.currentCycle);
        expect(extended.continuationProposal).toBeNull();
        expect(extended.stopReason).toBeNull();

        await expect(expeditionService.extendExpedition(extended.id, { userId }))
            .rejects.toMatchObject({ code: 'BAD_STATE' });
    });

    test('no accepted sources stops safely after one cycle', async () => {
        const userId = nextUser();
        const empty = richCycleResult({});
        empty.counters.sourcesAccepted = 0;
        empty.counters.sourceCount = 0;
        const expedition = await expeditionService.createExpedition({ userId, seed: 'obscure topic', depth: 'standard' });
        await runToCompletion(makeRunner(mockPipeline([empty])), expedition.id);
        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.status).toBe('COMPLETED');
        expect(done.stopReason).toBe('NO_NEW_SOURCES');
        expect(done.currentCycle).toBe(1);
    });

    test('sustained low novelty saturates', async () => {
        const userId = nextUser();
        const low = () => richCycleResult({ novelty: 0.05 });
        const pipeline = mockPipeline([low(), low(), low(), low(), low(), low()]);
        const expedition = await expeditionService.createExpedition({ userId, seed: 'repetitive topic', depth: 'deep' });
        await runToCompletion(makeRunner(pipeline), expedition.id);
        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.stopReason).toBe('NOVELTY_SATURATED');
        expect(done.currentCycle).toBe(spitballConfig.CONTINUATION.lowNoveltyStreakToStop);
    });

    test('a failing cycle records the error and fails the expedition cleanly', async () => {
        const userId = nextUser();
        const pipeline = mockPipeline([
            richCycleResult({}),
            new Error('search provider exploded')
        ]);
        const expedition = await expeditionService.createExpedition({ userId, seed: 'fragile topic', depth: 'standard' });
        await runToCompletion(makeRunner(pipeline), expedition.id);

        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.status).toBe('FAILED');
        expect(done.stopReason).toBe('FAILED');
        expect(done.lastError).toBe('search provider exploded');
        const cycles = await expeditionService.listCycles(expedition.id, { userId });
        expect(cycles.map(c => [c.cycleNumber, c.status])).toEqual([[1, 'COMPLETED'], [2, 'FAILED']]);
        expect(cycles[1].lastError).toBe('search provider exploded');
        // First cycle's results survive intact
        expect(done.notesCreated).toBe(4);
    });

    test('checkpoint() renews the lease while RUNNING and throws once it is not', async () => {
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({ userId, seed: 'checkpoint topic' });
        await expeditionService.claimForRun(expedition.id);
        await expect(expeditionService.checkpoint(expedition.id)).resolves.toBeUndefined();

        await expeditionService.pauseExpedition(expedition.id, { userId });
        await expect(expeditionService.checkpoint(expedition.id)).rejects.toMatchObject({
            name: 'ExpeditionInterrupted',
            expeditionStatus: 'PAUSED'
        });
        await expect(expeditionService.checkpoint(999999)).rejects.toMatchObject({
            name: 'ExpeditionInterrupted',
            expeditionStatus: 'MISSING'
        });
    });

    test('Pause stops a running cycle at its next checkpoint - no further spend', async () => {
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({ userId, seed: 'mid-cycle pause', depth: 'deep' });
        const stagesAfterPause = [];
        const pipeline = {
            async runCycle({ checkpoint }) {
                await checkpoint(); // still running: fine
                await expeditionService.pauseExpedition(expedition.id, { userId });
                await checkpoint(); // must throw ExpeditionInterrupted here
                stagesAfterPause.push('search'); // never reached
                return richCycleResult({});
            }
        };
        await runToCompletion(makeRunner(pipeline), expedition.id);

        expect(stagesAfterPause).toEqual([]);
        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.status).toBe('PAUSED');
        expect(done.stopReason).toBe('USER_PAUSED');
        // The interrupted cycle is CANCELLED, never FAILED, and nothing failed
        const cycles = await expeditionService.listCycles(expedition.id, { userId });
        expect(cycles.map(c => c.status)).toEqual(['CANCELLED']);
        expect(done.lastError).toBeNull();
        // And the expedition can continue afterwards
        await expeditionService.continueExpedition(expedition.id, { userId });
        expect((await expeditionService.getById(expedition.id)).status).toBe('QUEUED');
    });

    test('Cancel stops a running cycle at its next checkpoint', async () => {
        const userId = nextUser();
        const events = [];
        const unsubscribe = domainEventBus.subscribe('research.expedition_failed', (e) => events.push(e));
        try {
            const expedition = await expeditionService.createExpedition({ userId, seed: 'mid-cycle cancel' });
            const pipeline = {
                async runCycle({ checkpoint }) {
                    await expeditionService.cancelExpedition(expedition.id, { userId });
                    await checkpoint();
                    throw new Error('unreachable');
                }
            };
            await runToCompletion(makeRunner(pipeline), expedition.id);

            const done = await expeditionService.getExpedition(expedition.id, { userId });
            expect(done.status).toBe('CANCELLED');
            expect(done.stopReason).toBe('USER_CANCELLED');
            const cycles = await expeditionService.listCycles(expedition.id, { userId });
            expect(cycles.map(c => c.status)).toEqual(['CANCELLED']);
            // A cooperative stop is not a failure
            expect(events.filter(e => e.payload.userId === userId)).toEqual([]);
        } finally {
            unsubscribe();
        }
    });

    test('pausing mid-run stops the loop between cycles', async () => {
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({ userId, seed: 'pause me', depth: 'deep' });
        const pipeline = {
            async runCycle({ cycle }) {
                if (cycle.cycleNumber === 1) {
                    // The user pauses while the first cycle is still running
                    await expeditionService.pauseExpedition(expedition.id, { userId });
                }
                return richCycleResult({});
            }
        };
        await runToCompletion(makeRunner(pipeline), expedition.id);
        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.status).toBe('PAUSED');
        expect(done.currentCycle).toBe(1);
    });
});

describe('restart safety and the run lease', () => {
    test('claimForRun records the lease owner', async () => {
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({ userId, seed: 'lease topic' });
        expect(await expeditionService.claimForRun(expedition.id, { runnerId: 'runner-abc123' })).toBe(true);
        const row = await expeditionService.getById(expedition.id);
        expect(row.runnerId).toBe('runner-abc123');
        await expeditionService.cancelExpedition(expedition.id, { userId });
    });

    test('a RUNNING expedition with a fresh heartbeat is NEVER stolen', async () => {
        const userId = nextUser();
        // Another process legitimately drives this one (fresh lease)
        const foreign = await expeditionService.createExpedition({ userId, seed: 'foreign topic' });
        await expeditionService.claimForRun(foreign.id, { runnerId: 'runner-elsewhere' });

        const parked = await expeditionService.reapOrphans(new Set());
        expect(parked).not.toContain(foreign.id);
        expect((await expeditionService.getById(foreign.id)).status).toBe('RUNNING');
        await expeditionService.cancelExpedition(foreign.id, { userId });
    });

    test('orphaned RUNNING expeditions (stale lease) park PAUSED and QUEUED ones are picked up', async () => {
        const userId = nextUser();
        // Simulate a crash: a RUNNING expedition + cycle nobody is driving,
        // with a heartbeat older than the stale threshold
        const orphan = await expeditionService.createExpedition({ userId, seed: 'orphan topic' });
        await expeditionService.claimForRun(orphan.id);
        await expeditionService.startCycle(orphan.id, { frontierInput: null });
        await db.run(
            `UPDATE spitball_expeditions SET lastHeartbeatAt = datetime('now', '-2 hours') WHERE id = @id`,
            { id: orphan.id }
        );
        // And a queued expedition waiting for pickup
        const queued = await expeditionService.createExpedition({ userId, seed: 'queued topic' });

        // start() picks up every QUEUED expedition in the database, including
        // leftovers from earlier tests - a pipeline result for the target plus
        // safe failures for the rest, and every kicked loop is awaited so no
        // run outlives the test.
        const runner = makeRunner({
            async runCycle({ expedition }) {
                if (expedition.id !== queued.id) throw new Error('not part of this test');
                return richCycleResult({ leads: [] });
            }
        });
        const kicked = await runner.start();
        expect(kicked).toContain(queued.id);
        for (const id of kicked) await runner.waitFor(id);

        const parked = await expeditionService.getExpedition(orphan.id, { userId });
        expect(parked.status).toBe('PAUSED');
        expect(parked.lastError).toMatch(/lease expired/);
        const orphanCycles = await expeditionService.listCycles(orphan.id, { userId });
        expect(orphanCycles[0].status).toBe('CANCELLED');

        const ran = await expeditionService.getExpedition(queued.id, { userId });
        expect(ran.status).toBe('COMPLETED');
    });
});

describe('post-cycle reflection (spec §21)', () => {
    test('weave/tidy runs once per cycle that committed enough notes', async () => {
        const userId = nextUser();
        const reflection = fakeReflection();
        const expedition = await expeditionService.createExpedition({ userId, seed: 'reflective topic', depth: 'focused' });
        // richCycleResult commits 4 notes + 1 merge >= the weave floor
        await runToCompletion(makeRunner(mockPipeline([richCycleResult({ leads: [] })]), { reflection }), expedition.id);

        expect(reflection.runs.length).toBe(1);
        expect(reflection.runs[0]).toMatchObject({
            guildId: `dm:${userId}`,
            scopeKey: `USER:${userId}`,
            subjectType: 'USER',
            subjectId: userId,
            passes: ['weave', 'tidy'],
            trigger: 'scheduled',
            requestedBy: 'spitball'
        });
        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.status).toBe('COMPLETED');
    });

    test('an empty cycle does not trigger reflection', async () => {
        const userId = nextUser();
        const reflection = fakeReflection();
        const empty = richCycleResult({ leads: [] });
        empty.counters.notesCreated = 0;
        empty.counters.notesMerged = 0;
        const expedition = await expeditionService.createExpedition({ userId, seed: 'quiet topic', depth: 'focused' });
        await runToCompletion(makeRunner(mockPipeline([empty]), { reflection }), expedition.id);
        expect(reflection.runs.length).toBe(0);
    });

    test('a reflection failure costs connectivity, never the expedition', async () => {
        const userId = nextUser();
        const reflection = fakeReflection({ fail: true });
        const expedition = await expeditionService.createExpedition({ userId, seed: 'fragile weave', depth: 'focused' });
        await runToCompletion(makeRunner(mockPipeline([richCycleResult({ leads: [] })]), { reflection }), expedition.id);
        expect(reflection.runs.length).toBe(1);
        const done = await expeditionService.getExpedition(expedition.id, { userId });
        expect(done.status).toBe('COMPLETED');
    });
});

describe('note revision history (spec §27)', () => {
    const kg = require('@goobster/core/services/knowledgeGraphService');
    const guildId = `dm:rev-${process.pid}`;
    const scopeKey = 'USER:rev';

    test('creation and material edits accumulate typed revisions; no-ops do not', async () => {
        const node = await kg.upsertNode({
            guildId, scopeKey, label: 'Revised note', content: 'First form.', source: 'research'
        });
        // A repeat write with identical content is not a new representation
        await kg.upsertNode({ guildId, scopeKey, label: 'Revised note', content: 'First form.', source: 'research' });
        // A human correction is
        await kg.upsertNode({ guildId, scopeKey, label: 'Revised note', content: 'Human-corrected form.', source: 'user' });
        // And a later research expansion is
        await kg.upsertNode({ guildId, scopeKey, label: 'Revised note', content: 'Research-expanded form with more detail.', source: 'research' });

        const revisions = await kg.listNodeRevisions(node.id);
        expect(revisions.map(r => [r.revisionNumber, r.changeKind])).toEqual([
            [3, 'research_expand'],
            [2, 'human_edit'],
            [1, 'created']
        ]);
        expect(revisions[1].content).toBe('Human-corrected form.');
        expect(revisions[2].content).toBe('First form.');
    });

    test('merges snapshot a reflection_merge revision on the kept node', async () => {
        await kg.upsertNode({ guildId, scopeKey, label: 'Keep me', content: 'Kept.', source: 'user' });
        await kg.upsertNode({ guildId, scopeKey, label: 'Drop me', content: 'Dropped.', source: 'user' });
        await kg.mergeNodes({ guildId, scopeKey, keepLabel: 'Keep me', dropLabel: 'Drop me' });
        const keep = await kg.getNode(guildId, 'Keep me', scopeKey);
        const revisions = await kg.listNodeRevisions(keep.id);
        expect(revisions[0].changeKind).toBe('reflection_merge');
    });

    test('history is bounded per node', async () => {
        const node = await kg.upsertNode({ guildId, scopeKey, label: 'Busy note', content: 'v0', source: 'tool' });
        for (let i = 1; i <= 25; i++) {
            await kg.upsertNode({ guildId, scopeKey, label: 'Busy note', content: `version ${i}`, source: 'tool' });
        }
        const revisions = await kg.listNodeRevisions(node.id, 100);
        expect(revisions.length).toBeLessThanOrEqual(20);
        // The newest state survives the cap
        expect(revisions[0].content).toBe('version 25');
    });

    test('revisions cascade with the node (privacy rides kg_nodes)', async () => {
        const node = await kg.upsertNode({ guildId, scopeKey, label: 'Doomed note', content: 'x', source: 'user' });
        expect((await kg.listNodeRevisions(node.id)).length).toBe(1);
        await kg.deleteNode(guildId, 'Doomed note', scopeKey);
        expect((await kg.listNodeRevisions(node.id)).length).toBe(0);
    });
});

describe('domain events', () => {
    test('lifecycle publishes bounded research.* events', async () => {
        const userId = nextUser();
        const events = [];
        const unsubscribe = domainEventBus.subscribe('research.*', (event) => {
            if (event.payload.userId === userId) events.push(event);
        });
        try {
            const highLead = { topic: 'high value lead', kind: 'mechanism', expectedValue: 0.9, novelty: 0.9 };
            const result = richCycleResult({ leads: [highLead] });
            result.counters.conflictsFound = 2;
            const secondResult = richCycleResult({ leads: [] });

            const expedition = await expeditionService.createExpedition({ userId, seed: 'event topic', depth: 'standard' });
            await runToCompletion(makeRunner(mockPipeline([result, secondResult])), expedition.id);

            const topics = events.map(e => e.topic);
            expect(topics).toEqual([
                'research.expedition_started',
                'research.cycle_started',
                'research.cycle_completed',
                'research.conflict_found',
                'research.lead_discovered',
                'research.cycle_started',
                'research.cycle_completed',
                'research.expedition_completed'
            ]);
            const completed = events.find(e => e.topic === 'research.expedition_completed');
            expect(completed.payload).toMatchObject({
                userId, expeditionId: expedition.id, stopReason: 'NO_LEADS', cycles: 2
            });
            const lead = events.find(e => e.topic === 'research.lead_discovered');
            expect(lead.payload).toMatchObject({ topic: 'high value lead', kind: 'mechanism' });
            // Payloads stay small: ids and scalars, no model output blobs
            for (const event of events) {
                expect(JSON.stringify(event.payload).length).toBeLessThan(1000);
            }
        } finally {
            unsubscribe();
        }
    });

    test('research topics are watchable', () => {
        const { WATCHABLE_TOPICS } = require('@goobster/core/services/attentionWatchService');
        expect(WATCHABLE_TOPICS).toEqual(expect.arrayContaining([
            'research.expedition_completed',
            'research.expedition_failed',
            'research.lead_discovered',
            'research.conflict_found',
            'research.*'
        ]));
    });
});

describe('research provenance through the legalizer', () => {
    test('research mutations carry expedition + claim provenance and dedupe against existing notes', async () => {
        const kg = require('@goobster/core/services/knowledgeGraphService');
        const kgConfig = require('@goobster/core/config/knowledgeGraphConfig');
        const userId = nextUser();
        const guildId = `dm:${userId}`;
        const scopeKey = `USER:${userId}`;

        const expedition = await expeditionService.createExpedition({ userId, seed: 'provenance topic' });
        const sourceId = await db.insert(
            `INSERT INTO research_sources (expeditionId, userId, provider, url, canonicalUrl, title, accepted)
             VALUES (@expeditionId, @userId, 'web', 'https://example.org/p', 'https://example.org/p', 'A paper', 1)`,
            { expeditionId: expedition.id, userId }
        );
        const claimId = await db.insert(
            `INSERT INTO research_claims (sourceId, expeditionId, text, kind, confidence)
             VALUES (@sourceId, @expeditionId, 'The thing decomposes into cells.', 'factual', 0.9)`,
            { sourceId, expeditionId: expedition.id }
        );

        // An existing note the research should reuse rather than duplicate
        await kg.upsertNode({ guildId, scopeKey, label: 'Existing concept', content: 'Already known.', source: 'user' });

        const applied = await kg.applyMutations({
            guildId,
            scopeKey,
            source: 'research',
            limits: kgConfig.LIMITS.research,
            provenance: { sourceKind: 'expedition', sourceId: expedition.id },
            mutations: {
                upsert: [
                    { type: 'concept', label: 'Cell decomposition', content: 'It decomposes.', claimIds: [claimId] },
                    { type: 'concept', label: 'Existing concept', content: 'Already known, extended.' }
                ],
                link: [{ source: 'Cell decomposition', target: 'Existing concept', relation: 'part_of', relationKind: 'associative' }]
            }
        });
        expect(applied.nodesUpserted).toBe(2);
        expect(applied.linksCreated).toBe(1);

        const node = await kg.getNode(guildId, 'Cell decomposition', scopeKey);
        expect(node.source).toBe('research');
        const provenance = await db.all(
            'SELECT sourceKind, sourceId FROM kg_provenance WHERE nodeId = @id ORDER BY sourceKind',
            { id: node.id }
        );
        expect(provenance).toEqual(expect.arrayContaining([
            { sourceKind: 'expedition', sourceId: expedition.id },
            { sourceKind: 'research_claim', sourceId: claimId }
        ]));

        // Claim -> source resolves through the research tables (the "why does
        // this note say this?" trace)
        const claim = await db.get('SELECT * FROM research_claims WHERE id = @id', { id: claimId });
        const source = await db.get('SELECT * FROM research_sources WHERE id = @id', { id: claim.sourceId });
        expect(source.url).toBe('https://example.org/p');

        // No duplicate of the existing note was created
        const dupes = await db.all(
            `SELECT id FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey AND label = 'Existing concept'`,
            { guildId, scopeKey }
        );
        expect(dupes.length).toBe(1);

        // A later structural touch by another writer (the weave pass linking
        // existing notes) must not rebrand who authored the knowledge
        await kg.applyMutations({
            guildId, scopeKey, source: 'consolidation', limits: kgConfig.LIMITS.reflection,
            mutations: { link: [{ source: 'Existing concept', target: 'Cell decomposition', relation: 'related_to' }] }
        });
        const afterWeave = await kg.getNode(guildId, 'Cell decomposition', scopeKey);
        expect(afterWeave.source).toBe('research');

        // Research limits forbid deletes
        expect(kgConfig.LIMITS.research.maxMutationsDelete).toBe(0);
        const deleted = await kg.applyMutations({
            guildId, scopeKey, source: 'research', limits: kgConfig.LIMITS.research,
            mutations: { delete: ['Existing concept'] }
        });
        expect(deleted.nodesDeleted).toBe(0);
        expect(await kg.getNode(guildId, 'Existing concept', scopeKey)).toBeTruthy();
    });

    test('source dedupe: one canonical URL per expedition', async () => {
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({ userId, seed: 'dedupe topic' });
        const insert = () => db.insert(
            `INSERT INTO research_sources (expeditionId, userId, provider, canonicalUrl, accepted)
             VALUES (@expeditionId, @userId, 'web', 'https://example.org/same', 0)`,
            { expeditionId: expedition.id, userId }
        );
        await insert();
        let second = null;
        try {
            second = await insert(); // expected to throw: UNIQUE rejects it
        } catch {
            // the constraint held
        }
        if (second !== null) {
            // Diagnostic breadcrumbs for the flaky path
            const ddl = db.engine === 'postgres'
                ? await db.all(`SELECT indexdef AS sql FROM pg_indexes WHERE tablename = 'research_sources'`)
                : await db.all(`SELECT sql FROM sqlite_master WHERE name = 'research_sources'`);
            console.error('DEDUPE DEBUG', {
                engine: db.engine,
                dbPath: process.env.GOOBSTER_DB_PATH,
                dbUrl: process.env.GOOBSTER_DB_URL,
                secondId: second,
                ddl
            });
        }
        expect(second).toBeNull();
    });
});

describe('note evidence ("why does Goobster believe this?")', () => {
    test('resolves the Note -> Claim -> Source chain, owner-only', async () => {
        const kg = require('@goobster/core/services/knowledgeGraphService');
        const kgConfig = require('@goobster/core/config/knowledgeGraphConfig');
        const userId = nextUser();
        const guildId = `dm:${userId}`;
        const scopeKey = `USER:${userId}`;

        const expedition = await expeditionService.createExpedition({ userId, seed: 'evidence topic' });
        const sourceId = await db.insert(
            `INSERT INTO research_sources (expeditionId, userId, provider, sourceType, url, canonicalUrl, title, accepted)
             VALUES (@expeditionId, @userId, 'arxiv', 'preprint', 'https://arxiv.org/abs/1', 'https://arxiv.org/abs/1', 'The paper', 1)`,
            { expeditionId: expedition.id, userId }
        );
        const claimId = await db.insert(
            `INSERT INTO research_claims (sourceId, expeditionId, text, kind, confidence)
             VALUES (@sourceId, @expeditionId, 'The thing is so.', 'factual', 0.9)`,
            { sourceId, expeditionId: expedition.id }
        );
        await kg.applyMutations({
            guildId, scopeKey, source: 'research', limits: kgConfig.LIMITS.research,
            provenance: { sourceKind: 'expedition', sourceId: expedition.id },
            mutations: { upsert: [{ type: 'concept', label: 'Evidence-backed note', content: 'So.', claimIds: [claimId] }] }
        });
        const node = await kg.getNode(guildId, 'Evidence-backed note', scopeKey);

        const evidence = await expeditionService.getNoteEvidence(node.id, { userId });
        expect(evidence.note.label).toBe('Evidence-backed note');
        expect(evidence.expeditions.map(e => e.id)).toEqual([expedition.id]);
        expect(evidence.claims).toHaveLength(1);
        expect(evidence.claims[0]).toMatchObject({
            text: 'The thing is so.',
            kind: 'factual',
            source: { title: 'The paper', url: 'https://arxiv.org/abs/1', provider: 'arxiv' }
        });

        // Strangers get the same 404 as a missing note
        await expect(expeditionService.getNoteEvidence(node.id, { userId: nextUser() }))
            .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
        await expect(expeditionService.getNoteEvidence(999999, { userId }))
            .rejects.toMatchObject({ status: 404 });
    });

    test('a hand-written note reports its non-research provenance', async () => {
        const kg = require('@goobster/core/services/knowledgeGraphService');
        const userId = nextUser();
        const guildId = `dm:${userId}`;
        const scopeKey = `USER:${userId}`;
        const created = await kg.upsertNode({ guildId, scopeKey, label: 'Manual note', content: 'Mine.', source: 'user' });
        await kg.addProvenance({ nodeId: created.id, sourceKind: 'user', sourceId: null });

        const evidence = await expeditionService.getNoteEvidence(created.id, { userId });
        expect(evidence.claims).toEqual([]);
        expect(evidence.expeditions).toEqual([]);
        expect(evidence.otherProvenance.user).toBe(1);
    });
});

describe('privacy', () => {
    test('/forget-me erases expeditions, cycles, sources, and claims', async () => {
        const privacyService = require('@goobster/core/services/privacyService');
        const userId = nextUser();
        const expedition = await expeditionService.createExpedition({ userId, seed: 'private research' });
        await expeditionService.claimForRun(expedition.id);
        const cycle = await expeditionService.startCycle(expedition.id, {});
        const sourceId = await db.insert(
            `INSERT INTO research_sources (expeditionId, cycleId, userId, provider, canonicalUrl, accepted)
             VALUES (@expeditionId, @cycleId, @userId, 'web', 'https://example.org/private', 1)`,
            { expeditionId: expedition.id, cycleId: cycle.id, userId }
        );
        await db.insert(
            `INSERT INTO research_claims (sourceId, expeditionId, cycleId, text)
             VALUES (@sourceId, @expeditionId, @cycleId, 'private claim')`,
            { sourceId, expeditionId: expedition.id, cycleId: cycle.id }
        );

        const before = await expeditionService.auditUser(userId);
        expect(before).toEqual({ expeditions: 1, cycles: 1, researchSources: 1, researchClaims: 1 });

        const report = await privacyService.buildUserReport({ userId });
        expect(report.spitball).toMatchObject({ expeditions: 1, activeExpeditions: 1, researchSources: 1 });

        const counts = await privacyService.forgetUser({ userId });
        expect(counts.spitballExpeditions).toBe(1);
        expect(counts.spitballCycles).toBe(1);
        expect(counts.researchSources).toBe(1);
        expect(counts.researchClaims).toBe(1);

        const audit = await privacyService.auditUser({ userId });
        expect(audit.byTable.spitball_expeditions).toBe(0);
        expect(audit.byTable.spitball_expedition_cycles).toBe(0);
        expect(audit.byTable.research_sources).toBe(0);
        expect(audit.byTable.research_claims).toBe(0);
        expect(audit.total).toBe(0);

        expect(await expeditionService.auditUser(userId))
            .toEqual({ expeditions: 0, cycles: 0, researchSources: 0, researchClaims: 0 });
    });
});

describe('feature gate', () => {
    test('a disabled service refuses everything with 403 DISABLED', async () => {
        const disabled = new SpitballExpeditionService({ ...spitballConfig, enabled: false });
        await expect(disabled.createExpedition({ userId: nextUser(), seed: 'nope' }))
            .rejects.toMatchObject({ status: 403, code: 'DISABLED' });
        await expect(disabled.listExpeditions({ userId: nextUser() }))
            .rejects.toMatchObject({ code: 'DISABLED' });
        expect(new SpitballExpeditionRunner({ service: disabled }).start()).resolves.toEqual([]);
    });

    test('SpitballError carries the status+code contract', () => {
        const error = new SpitballError(409, 'BAD_STATE', 'nope');
        expect(error.status).toBe(409);
        expect(error.code).toBe('BAD_STATE');
        expect(error.message).toBe('nope');
    });
});
