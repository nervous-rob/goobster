/**
 * Stitched journeys for the distinctive product loop:
 *   Study / Parlor → Projects → Spitball → Attention → conversation
 *
 * These are the three complete loops the hardening review asked for,
 * proven at the service/API layer (see documentation/adr/0004-playwright-journeys.md).
 * No network, no Discord token. Playwright UI coverage is the next increment.
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
const kgConfig = require('@goobster/core/config/knowledgeGraphConfig');
const expeditionService = require('@goobster/core/services/spitballExpeditionService');
const parlorService = require('@goobster/core/services/parlorService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const { ObservatoryService, PROJECTS_ROOT, DASHBOARDS_ROOT } = require('@goobster/core/services/observatoryService');
const { ProjectAssetService } = require('@goobster/core/services/projectAssetService');
const { ProjectTriggerService } = require('@goobster/core/services/projectTriggerService');
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
    test('a sourced claim becomes a note whose evidence resolves Note → Claim → Source', async () => {
        const userId = OWNER;
        const guildId = dmScopeId(userId);
        const scopeKey = `USER:${userId}`;

        const expedition = await expeditionService.createExpedition({
            userId, seed: 'positive Grassmannian'
        });
        const sourceId = await db.insert(
            `INSERT INTO research_sources
                (expeditionId, userId, provider, sourceType, url, canonicalUrl, title, accepted)
             VALUES
                (@expeditionId, @userId, 'arxiv', 'preprint',
                 'https://arxiv.org/abs/1234.5678', 'https://arxiv.org/abs/1234.5678',
                 'Total positivity', 1)`,
            { expeditionId: expedition.id, userId }
        );
        const claimId = await db.insert(
            `INSERT INTO research_claims (sourceId, expeditionId, text, kind, confidence)
             VALUES (@sourceId, @expeditionId, 'The positive Grassmannian parametrizes cells.', 'factual', 0.91)`,
            { sourceId, expeditionId: expedition.id }
        );

        const claims = await expeditionService.listClaims(expedition.id, { userId });
        expect(claims).toHaveLength(1);
        expect(claims[0].text).toMatch(/parametrizes cells/);

        await knowledgeGraphService.applyMutations({
            guildId, scopeKey, source: 'research', limits: kgConfig.LIMITS.research,
            provenance: { sourceKind: 'expedition', sourceId: expedition.id },
            mutations: {
                upsert: [{
                    type: 'concept',
                    label: 'Positive Grassmannian',
                    content: 'It parametrizes cells.',
                    claimIds: [claimId]
                }]
            }
        });
        const node = await knowledgeGraphService.getNode(guildId, 'Positive Grassmannian', scopeKey);
        expect(node.source).toBe('research');

        const evidence = await expeditionService.getNoteEvidence(node.id, { userId });
        expect(evidence.note.label).toBe('Positive Grassmannian');
        expect(evidence.expeditions.map(row => row.id)).toEqual([expedition.id]);
        expect(evidence.claims).toHaveLength(1);
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
    test('a failed job plus a scheduled trigger surfaces an Observatory notice', async () => {
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
        const triggers = new ProjectTriggerService({
            observatory: {
                async run() {
                    return { mode: 'background', project: project.slug, jobId: 1, status: 'RUNNING' };
                }
            }
        });
        const trigger = await triggers.create({
            userId: OWNER,
            project: project.slug,
            name: 'Nightly ingest',
            kind: 'cron',
            schedule: '0 2 * * *',
            action: 'run_script',
            actionAssetId: script.id,
            actionParams: { background: true }
        });
        expect(trigger.isEnabled).toBe(true);
        expect(trigger.nextRun).toBeTruthy();

        await db.insert(
            `INSERT INTO observatory_jobs
                (projectId, userId, language, code, status, finishedAt, error)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'FAILED', datetime('now'), 'boom')`,
            { projectId: project.id, userId: OWNER }
        );

        await policies.setInitiative(OWNER, 'assist');
        const policy = await policies.get(OWNER);
        aiService.generateText.mockImplementation(keepAll());

        const summary = await attention.sweepUser({ policy, gateway: fakeGateway() });
        expect(summary.notices.some(notice =>
            /failed/i.test(notice.title) && /Emergence/i.test(notice.title)
        )).toBe(true);
    });
});
