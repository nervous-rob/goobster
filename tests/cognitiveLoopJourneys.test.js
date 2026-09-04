/**
 * Stitched journeys for the distinctive product loop:
 *   Study / Parlor → Projects → Spitball → Attention → conversation
 *
 * These are the three complete loops the hardening review asked for,
 * proven at the service/API layer (see documentation/adr/0004-playwright-journeys.md).
 * Expedition and trigger journeys drive the real runner / settle path
 * with fake external providers. No network, no Discord token.
 * Playwright UI coverage lives in e2e/journeys.spec.js.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-journeys-${process.pid}.sqlite`);

const mockEmbedding = {
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) =>
        texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    // 0, not 1: a similarity of 1 would make the legalizer's semantic
    // dedupe merge every distinct note; retrieval then exercises the
    // keyword-fallback path instead, which is what these journeys assert.
    cosineSimilarity: () => 0
};
jest.mock('@goobster/core/services/embeddingService', () => mockEmbedding);

const mockAi = {
    chat: jest.fn(async () => ({ content: 'A considered reply.', toolCalls: [] })),
    generateText: jest.fn(),
    supportsNativeWebSearch: () => false
};
jest.mock('@goobster/core/services/aiService', () => mockAi);
jest.mock('@goobster/core/utils/chatHandler', () => ({
    handleChatInteraction: jest.fn()
}));
jest.mock('@goobster/core/utils/imageDetectionHandler', () => ({ generateImage: jest.fn() }));

const db = require('@goobster/core/db');
const { dmScopeId } = require('@goobster/core/utils/dmScope');
const knowledgeGraphService = require('@goobster/core/services/knowledgeGraphService');
const expeditionService = require('@goobster/core/services/spitballExpeditionService');
const { SpitballExpeditionRunner } = require('@goobster/core/services/spitballExpeditionRunner');
const { SpitballResearchPipeline } = require('@goobster/core/services/spitballResearchPipeline');
const parlorService = require('@goobster/core/services/parlorService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const { ObservatoryService, PROJECTS_ROOT, DASHBOARDS_ROOT } = require('@goobster/core/services/observatoryService');
const { ProjectAssetService } = require('@goobster/core/services/projectAssetService');
const projectTriggerService = require('@goobster/core/services/projectTriggerService');
const attention = require('@goobster/core/services/attentionService');
const policies = require('@goobster/core/services/attentionPolicyService');
const aiService = require('@goobster/core/services/aiService');

const OWNER = '700000000000000001';
const MEMBER = '700000000000000002';
const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-journeys-sandbox-${process.pid}`);

function makeObservatory() {
    return new ObservatoryService({
        config: {
            enabled: true,
            scope: 'everywhere',
            maxProjectsPerUser: 5,
            maxMembersPerProject: 5,
            maxProjectMb: 64,
            maxActiveJobsPerUser: 2,
            maxResumes: 3,
            maxWorkspaceFiles: 50,
            maxRenderFrames: 10,
            renderFps: 24,
            maxAssetsPerProject: 20,
            maxVersionsPerAsset: 20,
            maxUploadMb: 8,
            ffmpegPath: 'ffmpeg'
        },
        sandbox: new SandboxService({
            enabled: true,
            scope: 'everywhere',
            timeoutMs: 15_000,
            maxCpuSeconds: 15,
            maxMemoryMb: 256,
            maxWriteMb: 16,
            maxOutputBytes: 64 * 1024,
            maxOutputFiles: 8,
            maxFileSizeBytes: 8 * 1024 * 1024,
            runsPerWindow: 1000,
            maxConcurrent: 4,
            retentionHours: 24,
            allowNetwork: false,
            pythonCommand: 'python3',
            extraBinds: [],
            runsDir: SANDBOX_ROOT
        })
    });
}

function keepAll(message = 'Worth your attention.') {
    return async (prompt) => {
        const keys = [...prompt.matchAll(/\[key: ([^\]]+)\]/g)].map(m => m[1]);
        return JSON.stringify({
            keep: keys.map(key => ({ key, adjust: 0, reason: 'worth it' })),
            drop: [],
            message
        });
    };
}

function fakeGateway() {
    return {
        isGoobsterGateway: true,
        sendDm: jest.fn(async () => ({ ok: true, channelId: 'dm-1', messageId: 'm-1' }))
    };
}

const noEmbeddings = {
    async embed() { throw new Error('no embedding backend in journeys'); },
    cosineSimilarity() { return 0 }
};

function respond(handler, prompt) {
    if (handler === undefined) throw new Error('stage not stubbed');
    const value = typeof handler === 'function' ? handler(prompt) : handler;
    if (value instanceof Error) throw value;
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function fakePipelineAi(responses) {
    return {
        async generateText(prompt) {
            if (prompt.includes('planning one cycle')) return respond(responses.plan, prompt);
            if (prompt.includes('Review each research source')) {
                return respond(responses.sourceReview ?? { reviews: [] }, prompt);
            }
            if (prompt.includes('Extract structured evidence')) return respond(responses.claims, prompt);
            if (prompt.includes('Which of these claims are OFF-TOPIC')) {
                return respond(responses.claimReview ?? { dropClaimIds: [] }, prompt);
            }
            if (prompt.includes('ATOMIC knowledge notes')) return respond(responses.knowledge, prompt);
            if (prompt.includes('Evaluate this research cycle')) return respond(responses.coverage, prompt);
            throw new Error(`unexpected pipeline prompt: ${prompt.slice(0, 80)}`);
        }
    };
}

function fakeSearch(hits) {
    return {
        async search() {
            return hits;
        }
    };
}

async function waitForJob(svc, userId, jobId, { timeoutMs = 25_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const job = await svc.getJob({ userId, jobId });
        if (job.status !== 'RUNNING') return job;
        if (Date.now() > deadline) throw new Error(`Job #${jobId} still RUNNING after ${timeoutMs}ms`);
        await new Promise(resolve => setTimeout(resolve, 150));
    }
}

beforeAll(() => {
    fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
});

afterAll(async () => {
    await db.closeConnection();
    try { fs.rmSync(process.env.GOOBSTER_DB_PATH, { force: true }); } catch { /* held */ }
    for (const suffix of ['-shm', '-wal']) {
        try { fs.rmSync(process.env.GOOBSTER_DB_PATH + suffix, { force: true }); } catch { /* gone */ }
    }
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* gone */ }
    try { fs.rmSync(path.join(PROJECTS_ROOT, OWNER), { recursive: true, force: true }); } catch { /* gone */ }
    try { fs.rmSync(path.join(DASHBOARDS_ROOT, OWNER), { recursive: true, force: true }); } catch { /* gone */ }
});

describe('journey: Expedition → claims → notes → evidence', () => {
    test('the runner + pipeline persist a sourced note whose evidence resolves Note → Claim → Source', async () => {
        const userId = OWNER;
        let persistedClaimIds = [];
        const ai = fakePipelineAi({
            plan: {
                questions: ['What is the positive Grassmannian?'],
                searchQueries: ['positive Grassmannian overview'],
                expectedConcepts: ['positroid cells']
            },
            sourceReview: (prompt) => {
                const ids = [...prompt.matchAll(/\[source (\d+)\]/g)].map(m => Number(m[1]));
                return {
                    reviews: ids.map(sourceId => ({
                        sourceId, relevant: true, onTopicScore: 0.95, reason: 'on topic'
                    }))
                };
            },
            claims: {
                claims: [{
                    text: 'The positive Grassmannian parametrizes cells.',
                    kind: 'factual',
                    confidence: 0.91,
                    concepts: ['positroid cells']
                }]
            },
            knowledge: (prompt) => {
                persistedClaimIds = [...prompt.matchAll(/\[claim (\d+)\]/g)].map(m => Number(m[1]));
                return {
                    upsert: [{
                        type: 'concept',
                        label: 'Positive Grassmannian',
                        content: 'It parametrizes cells.',
                        claimIds: persistedClaimIds
                    }],
                    link: []
                };
            },
            coverage: {
                coverage: {
                    summary: 'Mapped the parametrization.',
                    coveredQuestions: ['What is the positive Grassmannian?'],
                    unresolvedQuestions: [],
                    searchGaps: [],
                    majorNewConcepts: ['positroid cells'],
                    conflicts: [],
                    coverageScore: 0.6,
                    noveltyScore: 0.8
                },
                leads: []
            }
        });
        const pipeline = new SpitballResearchPipeline({
            ai,
            embeddings: noEmbeddings,
            searchService: fakeSearch([{
                provider: 'arxiv',
                sourceType: 'preprint',
                url: 'https://arxiv.org/abs/1234.5678',
                title: 'Total positivity',
                author: null,
                publisher: 'arXiv',
                publishedAt: '2026-01-01',
                text: 'The positive Grassmannian parametrizes cells. Scattering amplitudes relate to its geometry.',
                metadata: {}
            }])
        });
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
        const claims = await expeditionService.listClaims(expedition.id, { userId });
        expect(claims.some(row => /parametrizes cells/.test(row.text))).toBe(true);

        const node = await knowledgeGraphService.getNode(
            done.guildId, 'Positive Grassmannian', done.scopeKey
        );
        expect(node.source).toBe('research');

        const evidence = await expeditionService.getNoteEvidence(node.id, { userId });
        expect(evidence.note.label).toBe('Positive Grassmannian');
        expect(evidence.expeditions.map(row => row.id)).toEqual([expedition.id]);
        expect(evidence.claims[0]).toMatchObject({
            text: 'The positive Grassmannian parametrizes cells.',
            source: { title: 'Total positivity', url: 'https://arxiv.org/abs/1234.5678', provider: 'arxiv' }
        });
    });
});

describe('journey: Collaborator → project Parlor → actor-bound tool → project knowledge', () => {
    test('a member at the project table writes project knowledge as themselves', async () => {
        const svc = makeObservatory();
        const project = await svc.createProject({ userId: OWNER, name: 'Neuro Lab' });
        const gateway = {
            isGoobsterGateway: true,
            getUser: jest.fn(async (id) => (id === MEMBER
                ? { id: MEMBER, username: 'frieda', globalName: 'Frieda', bot: false }
                : null)),
            sendDm: jest.fn(async () => ({ ok: true, channelId: 'dm-1', messageId: 'm-1' }))
        };
        const { invite } = await svc.invite({
            gateway, userId: OWNER, ownerName: 'Rob', project: project.slug, inviteeId: MEMBER
        });
        await svc.respondInvite({ userId: MEMBER, userName: 'Frieda', inviteId: invite.id, accept: true });

        const { conversation, role } = await svc.getProjectParlor({
            userId: MEMBER, project: project.slug, owner: OWNER
        });
        expect(role).toBe('collaborator');

        const coords = {
            guildId: dmScopeId(OWNER),
            scopeKey: knowledgeGraphService.projectScopeKey(project.id)
        };
        await knowledgeGraphService.applyMutations({
            ...coords, subjectType: 'USER', subjectId: OWNER, source: 'tool',
            mutations: {
                upsert: [{ type: 'concept', label: 'Ingest cadence', content: 'The ingest runs nightly.' }]
            }
        });
        mockAi.chat.mockResolvedValue({ content: 'A considered reply.', toolCalls: [] });
        mockAi.generateText.mockResolvedValue(JSON.stringify({
            notes: [{ title: 'Render at 60fps', content: 'The team prefers 60fps renders.', tags: ['render'] }]
        }));

        const contextSpy = jest.spyOn(parlorService, '_buildPersonaToolContext');
        try {
            const turn = await parlorService.startTurn({
                userId: MEMBER, userName: 'Frieda',
                conversationId: conversation.id,
                message: 'Goobster, what is our ingest cadence?'
            });
            const events = { messages: [] };
            await turn.run({ onPersonaMessage: (m) => events.messages.push(m) });
            expect(events.messages).toHaveLength(1);

            const args = contextSpy.mock.calls[0][0];
            expect(args.actorId).toBe(MEMBER);

            const transcript = await parlorService.getMessages({
                userId: MEMBER, conversationId: conversation.id
            });
            const reply = transcript.find(m => m.role === 'persona');
            expect(reply.grounding.map(g => g.title)).toContain('Ingest cadence');

            const projectNote = await db.get(
                `SELECT id FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey AND label = @label`,
                { ...coords, label: 'Render at 60fps' }
            );
            expect(projectNote).toBeTruthy();
        } finally {
            contextSpy.mockRestore();
        }
    });
});

describe('journey: Project job → artifact → trigger → Attention notice', () => {
    test('a real failed job fires the event trigger and surfaces an Observatory notice', async () => {
        const svc = makeObservatory();
        const project = await svc.createProject({ userId: OWNER, name: 'Emergence study' });
        await svc.writeWorkspaceFile({
            userId: OWNER, slug: project.slug, relativePath: 'out/result.json',
            bytes: Buffer.from('{"ok":false}', 'utf8')
        });
        const listed = await svc.listFiles({ userId: OWNER, project: project.slug });
        expect(listed.files.some(file => file.path === 'out/result.json')).toBe(true);

        const assets = new ProjectAssetService();
        const script = await assets.save({
            userId: OWNER, project: project.slug, name: 'Ingest',
            kind: 'script', language: 'python', source: 'print("hi")', origin: 'portal'
        });

        // ObservatoryService._finishJob calls the singleton. Inject a fake
        // observatory only for the follow-up hop so the settle path is real
        // and the run_script action does not start a second sandbox job.
        const triggerRuns = [];
        const previousObservatory = projectTriggerService._observatory;
        projectTriggerService._observatory = {
            async run(opts) {
                triggerRuns.push(opts);
                return { mode: 'background', project: project.slug, jobId: 99, status: 'RUNNING' };
            }
        };
        try {
            const trigger = await projectTriggerService.create({
                userId: OWNER,
                project: project.slug,
                name: 'On ingest failure',
                kind: 'event',
                eventTopic: 'job_failed',
                action: 'run_script',
                actionAssetId: script.id,
                actionParams: { background: true }
            });

            const started = await svc.run({
                userId: OWNER,
                project: project.slug,
                language: 'bash',
                code: 'echo boom >&2; exit 3',
                background: true
            });
            const job = await waitForJob(svc, OWNER, started.jobId);
            expect(job.status).toBe('FAILED');
            expect(job.stderrTail).toContain('boom');

            // Status flips before evaluateJobSettled; wait for the settle path.
            const deadline = Date.now() + 15_000;
            let after;
            while (Date.now() < deadline) {
                after = await db.get(
                    'SELECT lastRun, lastOutcome FROM project_triggers WHERE id = @id',
                    { id: trigger.id }
                );
                if (after?.lastRun) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            expect(after.lastRun).toBeTruthy();
            expect(triggerRuns).toHaveLength(1);
            expect(triggerRuns[0]).toMatchObject({
                userId: OWNER,
                project: project.slug,
                language: 'python',
                startedBy: 'trigger',
                triggerId: trigger.id,
                assetVersionId: script.currentVersionId
            });

            await policies.setInitiative(OWNER, 'assist');
            const policy = await policies.get(OWNER);
            aiService.generateText.mockImplementation(keepAll());

            const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
            expect(summary.notices.some(notice =>
                /failed/i.test(notice.title) && /Emergence/i.test(notice.title)
            )).toBe(true);
        } finally {
            projectTriggerService._observatory = previousObservatory;
        }
    }, 25_000);
});
