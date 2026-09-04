/**
 * Phase 9 project parlors (§14 of documentation/projects_redesign_plan.md):
 * the built-in Goobster seat, the project-linked discussion (lazy creation,
 * one-way membership sync, linked-conversation guards, cap exemption), the
 * seat's PROJECT-scope knowledge routing, actor-bound tool context, and
 * cascade on project delete. Throwaway SQLite DB, AI/embeddings mocked.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-project-parlor-${process.pid}.sqlite`);

const mockEmbedding = {
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) =>
        texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    // 0, not 1: a similarity of 1 would make the legalizer's semantic
    // dedupe merge every distinct note; retrieval then exercises the
    // keyword-fallback path instead, which is what these tests assert.
    cosineSimilarity: () => 0
};
jest.mock('@goobster/core/services/embeddingService', () => mockEmbedding);

const mockAi = {
    chat: jest.fn(),
    generateText: jest.fn(),
    supportsNativeWebSearch: () => false
};
jest.mock('@goobster/core/services/aiService', () => mockAi);

// Persona turns offer tools from the real registry; these wrapped commands
// boot heavy voice/music services at load time (parlorService.test pattern).
jest.mock('@goobster/core/utils/imageDetectionHandler', () => ({ generateImage: jest.fn() }));

const db = require('@goobster/core/db');
const { dmScopeId } = require('@goobster/core/utils/dmScope');
const parlorService = require('@goobster/core/services/parlorService');
const knowledgeGraphService = require('@goobster/core/services/knowledgeGraphService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const {
    ObservatoryService, PROJECTS_ROOT, DASHBOARDS_ROOT
} = require('@goobster/core/services/observatoryService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-project-parlor-sandbox-${process.pid}`);

const OWNER = '600000000000000001';
const MEMBER = '600000000000000002';
const STRANGER = '600000000000000003';

function makeService(observatory = {}) {
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
            maxRenderFrames: 100,
            renderFps: 24,
            maxAssetsPerProject: 20,
            maxVersionsPerAsset: 50,
            maxUploadMb: 8,
            ffmpegPath: 'ffmpeg',
            ...observatory
        },
        sandbox: new SandboxService({
            enabled: true,
            scope: 'everywhere',
            timeoutMs: 15_000,
            maxCpuSeconds: 15,
            maxMemoryMb: 2048,
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

function fakeGateway({ invitee = MEMBER, name = 'Frieda' } = {}) {
    return {
        isGoobsterGateway: true,
        getUser: jest.fn(async (id) => (id === invitee
            ? { id: invitee, username: name.toLowerCase(), globalName: name, bot: false }
            : null)),
        sendDm: jest.fn(async () => ({ ok: true, channelId: 'dm-1', messageId: 'm-1' }))
    };
}

async function makeProject(svc, { name = 'Neuro Lab' } = {}) {
    await svc.createProject({ userId: OWNER, name });
    return await svc.resolveProjectForActor({ userId: OWNER, project: name });
}

async function addMember(svc, project, { inviteeId = MEMBER, inviteeName = 'Frieda' } = {}) {
    const gateway = fakeGateway({ invitee: inviteeId, name: inviteeName });
    const { invite } = await svc.invite({
        gateway, userId: OWNER, ownerName: 'Rob', project: project.slug, inviteeId
    });
    return await svc.respondInvite({
        userId: inviteeId, userName: inviteeName, inviteId: invite.id, accept: true
    });
}

async function expectCode(fn, code) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(code);
    return caught;
}

beforeEach(async () => {
    for (const table of [
        'parlor_messages', 'parlor_participants', 'parlor_members',
        'parlor_invites', 'parlor_conversations', 'parlor_personas',
        'project_invites', 'project_members',
        'observatory_jobs', 'observatory_projects',
        'kg_node_embeddings', 'kg_provenance', 'kg_node_tags', 'kg_tags',
        'kg_edges', 'kg_nodes'
    ]) {
        await db.run(`DELETE FROM ${table}`);
    }
    mockAi.chat.mockReset();
    mockAi.generateText.mockReset();
    mockAi.generateText.mockResolvedValue('{"notes": []}');
    mockAi.chat.mockResolvedValue({ content: 'A considered reply.', toolCalls: [] });
});

afterAll(async () => {
    await db.closeConnection();
    for (const userId of [OWNER, MEMBER, STRANGER]) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
        try { fs.rmSync(path.join(DASHBOARDS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
    }
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* gone */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.GOOBSTER_DB_PATH + suffix); } catch { /* already gone */ }
    }
});

describe('the built-in Goobster persona', () => {
    test('ensureBuiltinPersona is idempotent and flagged', async () => {
        const first = await parlorService.ensureBuiltinPersona(OWNER);
        const second = await parlorService.ensureBuiltinPersona(OWNER);
        expect(first.id).toBe(second.id);
        expect(first.builtin).toBeTruthy();
        expect(first.name).toBe('Goobster');
    });

    test('stays outside the persona cap', async () => {
        await parlorService.ensureBuiltinPersona(OWNER);
        for (let i = 0; i < 12; i++) {
            await parlorService.createPersona({
                ownerId: OWNER, name: `P${i}`, charter: 'thinks deeply'
            });
        }
        await expectCode(
            () => parlorService.createPersona({ ownerId: OWNER, name: 'One Too Many', charter: 'x' }),
            'PERSONA_CAP'
        );
    });

    test('cannot be edited or deleted', async () => {
        const persona = await parlorService.ensureBuiltinPersona(OWNER);
        await expectCode(
            () => parlorService.updatePersona({ ownerId: OWNER, personaId: persona.id, name: 'Impostor' }),
            'BUILTIN_PERSONA'
        );
        await expectCode(
            () => parlorService.deletePersona({ ownerId: OWNER, personaId: persona.id }),
            'BUILTIN_PERSONA'
        );
    });

    test('a user persona already named Goobster does not block the seat', async () => {
        await parlorService.createPersona({ ownerId: OWNER, name: 'Goobster', charter: 'a fan' });
        const persona = await parlorService.ensureBuiltinPersona(OWNER);
        expect(persona.builtin).toBeTruthy();
        expect(persona.name).toBe('Goobster (house)');
    });
});

describe('the linked project conversation', () => {
    test('getProjectParlor lazily creates: owner, title, seat, roster', async () => {
        const svc = makeService();
        const project = await makeProject(svc);
        await addMember(svc, project);

        const { conversation, role } = await svc.getProjectParlor({ userId: OWNER, project: project.slug });
        expect(role).toBe('owner');
        expect(conversation.projectId).toBe(project.id);
        expect(conversation.ownerId).toBe(OWNER);
        expect(conversation.title).toBe('🔭 Neuro Lab');

        const participants = await parlorService.listParticipants(conversation.id);
        expect(participants).toHaveLength(1);
        expect(participants[0].name).toBe('Goobster');

        const members = await db.all(
            'SELECT userId FROM parlor_members WHERE conversationId = @id', { id: conversation.id });
        expect(members.map(m => m.userId)).toEqual([MEMBER]);

        // Idempotent: the member sees the same discussion
        const again = await svc.getProjectParlor({ userId: MEMBER, project: project.slug, owner: OWNER });
        expect(again.conversation.id).toBe(conversation.id);
        expect(again.role).toBe('collaborator');
    });

    test('strangers cannot open it', async () => {
        const svc = makeService();
        const project = await makeProject(svc);
        await expectCode(
            () => svc.getProjectParlor({ userId: STRANGER, project: project.slug, owner: OWNER }),
            'NO_SUCH_PROJECT'
        );
    });

    test('membership syncs on accept and removal', async () => {
        const svc = makeService();
        const project = await makeProject(svc);
        const { conversation } = await svc.getProjectParlor({ userId: OWNER, project: project.slug });

        await addMember(svc, project);
        let members = await db.all(
            'SELECT userId FROM parlor_members WHERE conversationId = @id', { id: conversation.id });
        expect(members.map(m => m.userId)).toEqual([MEMBER]);

        await svc.removeMember({ userId: OWNER, project: project.slug, memberId: MEMBER });
        members = await db.all(
            'SELECT userId FROM parlor_members WHERE conversationId = @id', { id: conversation.id });
        expect(members).toEqual([]);
    });

    test('linked discussions refuse direct member management and deletion', async () => {
        const svc = makeService();
        const project = await makeProject(svc);
        await addMember(svc, project);
        const { conversation } = await svc.getProjectParlor({ userId: OWNER, project: project.slug });

        await expectCode(
            () => parlorService.invite({
                gateway: fakeGateway({ invitee: STRANGER }),
                ownerId: OWNER, conversationId: conversation.id, inviteeId: STRANGER
            }),
            'PROJECT_LINKED'
        );
        await expectCode(
            () => parlorService.removeMember({
                userId: OWNER, conversationId: conversation.id, memberId: MEMBER
            }),
            'PROJECT_LINKED'
        );
        await expectCode(
            () => parlorService.deleteConversation({ ownerId: OWNER, conversationId: conversation.id }),
            'PROJECT_LINKED'
        );
        const persona = await parlorService.ensureBuiltinPersona(OWNER);
        await expectCode(
            () => parlorService.setParticipant({
                ownerId: OWNER, conversationId: conversation.id, personaId: persona.id, present: false
            }),
            'BUILTIN_PERSONA'
        );
    });

    test('the roster follows maxMembersPerProject past the parlor member cap', async () => {
        const svc = makeService({ maxMembersPerProject: 6 });
        const project = await makeProject(svc);
        const { conversation } = await svc.getProjectParlor({ userId: OWNER, project: project.slug });
        for (let i = 0; i < 6; i++) {
            await addMember(svc, project, {
                inviteeId: `60000000000000100${i}`, inviteeName: `Member${i}`
            });
        }
        const members = await db.all(
            'SELECT userId FROM parlor_members WHERE conversationId = @id', { id: conversation.id });
        // 6 humans beyond the owner - more than the standalone-parlor cap of 4
        expect(members).toHaveLength(6);
    });

    test('deleting the project deletes the discussion and its messages', async () => {
        const svc = makeService();
        const project = await makeProject(svc);
        const { conversation } = await svc.getProjectParlor({ userId: OWNER, project: project.slug });
        await db.run(
            `INSERT INTO parlor_messages (conversationId, role, content, userId)
             VALUES (@id, 'user', 'hello table', @userId)`,
            { id: conversation.id, userId: OWNER }
        );
        await svc.deleteProject({ userId: OWNER, project: project.slug });
        expect(await db.get(
            'SELECT COUNT(*) AS c FROM parlor_conversations WHERE id = @id', { id: conversation.id }
        )).toEqual({ c: 0 });
        expect(await db.get(
            'SELECT COUNT(*) AS c FROM parlor_messages WHERE conversationId = @id', { id: conversation.id }
        )).toEqual({ c: 0 });
    });
});

describe('the Goobster seat at the table', () => {
    async function makeTable(svc) {
        const project = await makeProject(svc);
        await addMember(svc, project);
        const { conversation } = await svc.getProjectParlor({ userId: OWNER, project: project.slug });
        return { project, conversation };
    }

    function projectCoords(project) {
        return {
            guildId: dmScopeId(OWNER),
            scopeKey: knowledgeGraphService.projectScopeKey(project.id)
        };
    }

    test('retrieves from and writes back to the PROJECT scope', async () => {
        const svc = makeService();
        const { project, conversation } = await makeTable(svc);
        const coords = projectCoords(project);
        await knowledgeGraphService.applyMutations({
            ...coords,
            subjectType: 'USER',
            subjectId: OWNER,
            source: 'tool',
            mutations: {
                upsert: [{ type: 'concept', label: 'Ingest cadence', content: 'The ingest runs nightly.' }]
            }
        });
        mockAi.generateText.mockResolvedValue(JSON.stringify({
            notes: [{ title: 'Render at 60fps', content: 'The team prefers 60fps renders.', tags: ['render'] }]
        }));

        const turn = await parlorService.startTurn({
            userId: MEMBER, userName: 'Frieda',
            conversationId: conversation.id,
            message: 'Goobster, what is our ingest cadence?'
        });
        const events = { messages: [] };
        await turn.run({ onPersonaMessage: (m) => events.messages.push(m) });

        expect(events.messages).toHaveLength(1);
        expect(events.messages[0].content).toBe('A considered reply.');

        // Retrieval grounded on the seeded PROJECT-scope note
        const transcript = await parlorService.getMessages({ userId: OWNER, conversationId: conversation.id });
        const reply = transcript.find(m => m.role === 'persona');
        expect(reply.grounding.map(g => g.title)).toContain('Ingest cadence');

        // Write-back landed in the PROJECT scope, not a persona workspace
        const projectNote = await db.get(
            `SELECT id FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey AND label = @label`,
            { ...coords, label: 'Render at 60fps' }
        );
        expect(projectNote).toBeTruthy();
        const parlorScoped = await db.get(
            `SELECT COUNT(*) AS c FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey LIKE 'PARLOR:%'`,
            { guildId: coords.guildId }
        );
        expect(parlorScoped.c).toBe(0);
    });

    test('acts as the member who spoke, with the observatory tool offered', async () => {
        const svc = makeService();
        const { conversation } = await makeTable(svc);
        const contextSpy = jest.spyOn(parlorService, '_buildPersonaToolContext');
        try {
            const turn = await parlorService.startTurn({
                userId: MEMBER, userName: 'Frieda',
                conversationId: conversation.id,
                message: 'Goobster, list the project files please.'
            });
            await turn.run({});
            expect(contextSpy).toHaveBeenCalledTimes(1);
            const args = contextSpy.mock.calls[0][0];
            expect(args.actorId).toBe(MEMBER);
            expect(args.actorName).toBe('Frieda');
            const context = contextSpy.mock.results[0].value;
            expect(context.user.id).toBe(MEMBER);
            expect(context.channelId.startsWith('web:parlor:')).toBe(true);
        } finally {
            contextSpy.mockRestore();
        }
    });

    test('a standalone salon persona keeps acting as the owner', async () => {
        const persona = await parlorService.createPersona({
            ownerId: OWNER, name: 'Critic', charter: 'pushes back'
        });
        const conversation = await parlorService.createConversation({
            ownerId: OWNER, personaIds: [persona.id]
        });
        const contextSpy = jest.spyOn(parlorService, '_buildPersonaToolContext');
        try {
            const turn = await parlorService.startTurn({
                userId: OWNER, userName: 'Rob',
                conversationId: conversation.id,
                message: 'Critic, thoughts?'
            });
            await turn.run({});
            const args = contextSpy.mock.calls[0][0];
            expect(args.actorId).toBeNull();
            const context = contextSpy.mock.results[0].value;
            expect(context.user.id).toBe(OWNER);
        } finally {
            contextSpy.mockRestore();
        }
    });
});
