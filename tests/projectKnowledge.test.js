/**
 * Phase 8: the project Spitball — PROJECT:<id> scope isolation, legalizer-only
 * writes, note/recall tool actions, consolidation routing by conversation,
 * project-targeted expeditions, Knowledge-tab API auth, and erasure.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-project-kg-${process.pid}.sqlite`);

jest.mock('@goobster/core/services/embeddingService', () => ({
    embed: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    embedBatch: jest.fn(() => { throw new Error('no embeddings in tests'); }),
    cosineSimilarity: jest.fn(() => 0)
}));

jest.mock('@goobster/core/services/aiService', () => ({
    generateText: jest.fn(async () => JSON.stringify({
        mutations: {
            upsert: [{
                type: 'concept',
                label: 'Dock decision',
                content: 'Use the project graph for 🔭 turns',
                tags: ['project']
            }]
        }
    })),
    chat: jest.fn()
}));

const db = require('@goobster/core/db');
const { dmScopeId } = require('@goobster/core/utils/dmScope');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const {
    ObservatoryService, PROJECTS_ROOT, DASHBOARDS_ROOT
} = require('@goobster/core/services/observatoryService');
const knowledgeGraphService = require('@goobster/core/services/knowledgeGraphService');
const expeditionService = require('@goobster/core/services/spitballExpeditionService');
const privacyService = require('@goobster/core/services/privacyService');
const memoryConsolidationService = require('@goobster/core/services/memoryConsolidationService');
const aiService = require('@goobster/core/services/aiService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const sandboxConfig = require('@goobster/core/config/sandboxConfig');
const observatoryConfig = require('@goobster/core/config/observatoryConfig');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-pkg-sandbox-${process.pid}`);
const OWNER = '600000000000000001';
const MEMBER = '600000000000000002';
const STRANGER = '600000000000000003';
const TOOL_USER = '600000000000000004';

function makeService(overrides = {}) {
    return new ObservatoryService({
        config: {
            enabled: true,
            scope: 'everywhere',
            maxProjectsPerUser: 40,
            maxMembersPerProject: 5,
            maxProjectMb: 64,
            maxActiveJobsPerUser: 2,
            maxResumes: 2,
            maxWorkspaceFiles: 50,
            maxWorkspaceReadMb: 8,
            maxUploadMb: 8,
            maxRenderFrames: 10,
            renderFps: 24,
            ffmpegCommand: 'ffmpeg',
            maxAssetsPerProject: 20,
            maxVersionsPerAsset: 20,
            ...overrides
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

async function expectCode(fn, code) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe(code);
}

function request({ port, method = 'GET', reqPath, headers = {}, body = null }) {
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

afterAll(async () => {
    await eventBusService.close();
    await db.closeConnection();
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* gone */ }
    try { fs.rmSync(path.join(PROJECTS_ROOT, OWNER), { recursive: true, force: true }); } catch { /* gone */ }
    try { fs.rmSync(path.join(DASHBOARDS_ROOT, OWNER), { recursive: true, force: true }); } catch { /* gone */ }
    try { fs.rmSync(process.env.GOOBSTER_DB_PATH, { force: true }); } catch { /* gone */ }
});

describe('project knowledge scope', () => {
    test('project notes never leak into personal retrieval and vice versa', async () => {
        const svc = makeService();
        const project = await svc.createProject({ userId: OWNER, name: 'Scope Lab' });
        const coords = svc.knowledgeCoords(project);
        expect(coords.scopeKey).toBe(knowledgeGraphService.projectScopeKey(project.id));
        expect(coords.guildId).toBe(dmScopeId(OWNER));

        await svc.noteKnowledge({
            userId: OWNER, project: project.slug,
            label: 'Project-only fact', content: 'Lives on the project graph'
        });
        await knowledgeGraphService.applyMutations({
            guildId: dmScopeId(OWNER),
            scopeKey: `USER:${OWNER}`,
            subjectType: 'USER',
            subjectId: OWNER,
            source: 'tool',
            mutations: {
                upsert: [{ type: 'fact', label: 'Personal-only fact', content: 'Lives on the person' }]
            }
        });

        const projectText = await knowledgeGraphService.describeForPrompt({
            guildId: coords.guildId, scopeKey: coords.scopeKey, query: 'fact'
        });
        const personalText = await knowledgeGraphService.describeForPrompt({
            guildId: dmScopeId(OWNER), scopeKey: `USER:${OWNER}`, query: 'fact'
        });
        expect(projectText).toContain('Project-only fact');
        expect(projectText).not.toContain('Personal-only fact');
        expect(personalText).toContain('Personal-only fact');
        expect(personalText).not.toContain('Project-only fact');
    });

    test('noteKnowledge writes only through applyMutations', async () => {
        const svc = makeService();
        const project = await svc.createProject({ userId: OWNER, name: 'Legalizer Lab' });
        const spy = jest.spyOn(knowledgeGraphService, 'applyMutations');
        const applied = await svc.noteKnowledge({
            userId: OWNER,
            project: project.slug,
            label: 'Decision',
            content: 'Ship Phase 8',
            tags: ['plan', 'docs'],
            edges: []
        });
        expect(spy).toHaveBeenCalled();
        const call = spy.mock.calls.find(args => args[0]?.scopeKey === knowledgeGraphService.projectScopeKey(project.id));
        expect(call).toBeTruthy();
        expect(call[0].source).toBe('tool');
        expect(call[0].guildId).toBe(dmScopeId(OWNER));
        expect(applied.nodesUpserted).toBeGreaterThan(0);
        spy.mockRestore();
    });

    test('members may note and recall; strangers cannot', async () => {
        const svc = makeService();
        const project = await svc.createProject({ userId: OWNER, name: 'Shared Lab' });
        await db.run(
            `INSERT INTO project_members (projectId, userId, role, invitedBy)
             VALUES (@id, @userId, 'collaborator', @invitedBy)`,
            { id: project.id, userId: MEMBER, invitedBy: OWNER }
        );
        await svc.noteKnowledge({
            userId: MEMBER, project: project.slug, owner: OWNER,
            label: 'Member note', content: 'Written by a collaborator'
        });
        const recalled = await svc.recallKnowledge({
            userId: MEMBER, project: project.slug, owner: OWNER, query: 'collaborator'
        });
        expect(recalled).toContain('Member note');
        await expectCode(
            () => svc.noteKnowledge({ userId: STRANGER, project: project.slug, label: 'Nope' }),
            'NO_SUCH_PROJECT'
        );
        await expectCode(
            () => svc.recallKnowledge({ userId: STRANGER, project: project.slug, query: 'Nope' }),
            'NO_SUCH_PROJECT'
        );
    });
});

describe('observatory tool note/recall', () => {
    const original = {
        sandboxEnabled: sandboxConfig.enabled,
        obsEnabled: observatoryConfig.enabled,
        obsScope: observatoryConfig.scope
    };

    afterEach(() => {
        sandboxConfig.enabled = original.sandboxEnabled;
        observatoryConfig.enabled = original.obsEnabled;
        observatoryConfig.scope = original.obsScope;
    });

    test('note_knowledge and recall_knowledge go through actor resolution', async () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'everywhere';
        const svc = require('@goobster/core/services/observatoryService');
        const created = await svc.createProject({ userId: TOOL_USER, name: 'Tool Lab' });
        const noted = await toolsRegistry.execute('observatory', {
            action: 'note_knowledge',
            project: created.slug,
            label: 'Tool note',
            content: 'Stored via the tool',
            tags: 'alpha,beta',
            interactionContext: { user: { id: TOOL_USER }, channelId: 'web:x', isWeb: true }
        });
        expect(noted).toMatch(/Noted "Tool note"/);
        const recalled = await toolsRegistry.execute('observatory', {
            action: 'recall_knowledge',
            project: created.slug,
            query: 'Stored',
            interactionContext: { user: { id: TOOL_USER }, channelId: 'web:x', isWeb: true }
        });
        expect(recalled).toContain('Tool note');
        const stranger = await toolsRegistry.execute('observatory', {
            action: 'recall_knowledge',
            project: created.slug,
            query: 'Stored',
            interactionContext: { user: { id: STRANGER }, channelId: 'web:x', isWeb: true }
        });
        expect(stranger).toMatch(/❌/);
    });
});

describe('consolidation routing by conversation', () => {
    test('🔭 project conversation memories write to PROJECT scope, not USER', async () => {
        const svc = makeService();
        const project = await svc.createProject({ userId: OWNER, name: 'Dock Lab' });
        const channelId = `web:${OWNER}:docklab`;
        await db.run(
            `INSERT INTO web_conversations (userId, channelId, title)
             VALUES (@userId, @channelId, @title)`,
            { userId: OWNER, channelId, title: `🔭 ${project.name}` }
        );
        const guildId = dmScopeId(OWNER);
        for (const content of ['First dock turn about the sim', 'Second dock turn about frames']) {
            await db.run(
                `INSERT INTO memory_embeddings
                    (guildId, channelId, authorId, authorName, content, embedding, dims, model)
                 VALUES (@guildId, @channelId, @authorId, 'Owner', @content, @embedding, 1, 'test')`,
                { guildId, channelId, authorId: OWNER, content, embedding: Buffer.from([0]) }
            );
        }
        aiService.generateText.mockClear();
        await memoryConsolidationService.consolidateGuild(guildId);

        const projectNodes = await db.all(
            `SELECT label FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey`,
            { guildId, scopeKey: knowledgeGraphService.projectScopeKey(project.id) }
        );
        const personalNodes = await db.all(
            `SELECT label FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey`,
            { guildId, scopeKey: `USER:${OWNER}` }
        );
        expect(projectNodes.map(n => n.label)).toContain('Dock decision');
        expect(personalNodes.map(n => n.label)).not.toContain('Dock decision');
    });

    test('generic 🔭 Observatory conversation stays personal', async () => {
        const channelId = `web:${OWNER}:generic`;
        await db.run(
            `INSERT INTO web_conversations (userId, channelId, title)
             VALUES (@userId, @channelId, @title)`,
            { userId: OWNER, channelId, title: '🔭 Observatory' }
        );
        const dest = await makeService().resolveKnowledgeScopeForChannel(channelId);
        expect(dest).toBeNull();
    });
});

describe('project-targeted expeditions', () => {
    test('createExpedition writes to the project scope; members may launch', async () => {
        const svc = makeService();
        const project = await svc.createProject({ userId: OWNER, name: 'Expedition Lab' });
        await db.run(
            `INSERT INTO project_members (projectId, userId, role, invitedBy)
             VALUES (@id, @userId, 'collaborator', @invitedBy)`,
            { id: project.id, userId: MEMBER, invitedBy: OWNER }
        );
        const expedition = await expeditionService.createExpedition({
            userId: MEMBER,
            seed: 'background radiation of the sim',
            depth: 'focused',
            projectId: project.id,
            autoStart: false
        });
        expect(expedition.projectId).toBe(project.id);
        expect(expedition.userId).toBe(MEMBER);
        expect(expedition.guildId).toBe(dmScopeId(OWNER));
        expect(expedition.scopeKey).toBe(knowledgeGraphService.projectScopeKey(project.id));

        await knowledgeGraphService.applyMutations({
            guildId: expedition.guildId,
            scopeKey: expedition.scopeKey,
            subjectType: 'USER',
            subjectId: OWNER,
            source: 'research',
            mutations: {
                upsert: [{ type: 'concept', label: 'Expedition note', content: 'From the fake pipeline' }]
            }
        });
        const nodes = await db.all(
            `SELECT label FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey`,
            { guildId: expedition.guildId, scopeKey: expedition.scopeKey }
        );
        expect(nodes.map(n => n.label)).toContain('Expedition note');
        const personal = await db.all(
            `SELECT label FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey`,
            { guildId: dmScopeId(MEMBER), scopeKey: `USER:${MEMBER}` }
        );
        expect(personal.map(n => n.label)).not.toContain('Expedition note');

        await expectCode(
            () => expeditionService.createExpedition({
                userId: STRANGER, seed: 'nope', projectId: project.id, autoStart: false
            }),
            'NOT_FOUND'
        );
    });
});

describe('Knowledge-tab API auth', () => {
    let server;
    let port;
    let svc;

    beforeAll((done) => {
        svc = makeService();
        const ctx = createWebAppContext({
            client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
            config: { clientId: '123', webapp: { enabled: true, devMode: true } },
            logger: { error: () => {}, warn: () => {}, info: () => {} },
            deps: { observatory: svc }
        });
        const app = express();
        app.use(createWebAppApp(ctx));
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            done();
        });
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    async function cookie(userId, name) {
        const payload = JSON.stringify({ userId, name });
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, method: 'POST',
                path: '/api/app/auth/dev-session',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            }, (res) => {
                const setCookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session='));
                resolve(setCookie.split(';')[0]);
                res.resume();
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    test('owner and member can read; stranger is 404', async () => {
        const project = await svc.createProject({ userId: OWNER, name: 'Api Lab' });
        await db.run(
            `INSERT INTO project_members (projectId, userId, role, invitedBy)
             VALUES (@id, @userId, 'collaborator', @invitedBy)`,
            { id: project.id, userId: MEMBER, invitedBy: OWNER }
        );
        await svc.noteKnowledge({
            userId: OWNER, project: project.slug, label: 'API note', content: 'Visible on the tab'
        });
        const ownerCookie = await cookie(OWNER, 'owner');
        const memberCookie = await cookie(MEMBER, 'member');
        const strangerCookie = await cookie(STRANGER, 'stranger');
        const ownerRes = await request({
            port, reqPath: `/api/app/projects/${project.slug}/knowledge`,
            headers: { Cookie: ownerCookie }
        });
        expect(ownerRes.status).toBe(200);
        expect((ownerRes.json.nodes || []).some(n => n.label === 'API note')).toBe(true);
        const memberRes = await request({
            port, reqPath: `/api/app/projects/${project.slug}/knowledge?owner=${OWNER}`,
            headers: { Cookie: memberCookie }
        });
        expect(memberRes.status).toBe(200);
        const strangerRes = await request({
            port, reqPath: `/api/app/projects/${project.slug}/knowledge`,
            headers: { Cookie: strangerCookie }
        });
        expect(strangerRes.status).toBe(404);
        const notesRes = await request({
            port, reqPath: `/api/app/projects/${project.slug}/knowledge/notes`,
            headers: { Cookie: ownerCookie }
        });
        expect(notesRes.status).toBe(200);
        expect(notesRes.json.notes.some(n => n.label === 'API note')).toBe(true);
    });
});

describe('erasure of the project scope', () => {
    test('deleteProject and owner forget-me drop PROJECT nodes; member forget-me does not', async () => {
        const svc = makeService();
        const gone = await svc.createProject({ userId: OWNER, name: 'Erase Lab' });
        const kept = await svc.createProject({ userId: OWNER, name: 'Keep Lab' });
        await db.run(
            `INSERT INTO project_members (projectId, userId, role, invitedBy)
             VALUES (@id, @userId, 'collaborator', @invitedBy)`,
            { id: kept.id, userId: MEMBER, invitedBy: OWNER }
        );
        await svc.noteKnowledge({
            userId: OWNER, project: gone.slug, label: 'Doomed note', content: 'deleted with the project'
        });
        await svc.noteKnowledge({
            userId: MEMBER, project: kept.slug, owner: OWNER,
            label: 'Shared note', content: 'stays after member forget-me'
        });

        await svc.deleteProject({ userId: OWNER, project: gone.slug });
        expect((await db.get(
            `SELECT COUNT(*) AS c FROM kg_nodes WHERE scopeKey = @scopeKey`,
            { scopeKey: knowledgeGraphService.projectScopeKey(gone.id) }
        )).c).toBe(0);

        await privacyService.forgetUser({ userId: MEMBER });
        expect((await db.get(
            `SELECT COUNT(*) AS c FROM kg_nodes WHERE scopeKey = @scopeKey`,
            { scopeKey: knowledgeGraphService.projectScopeKey(kept.id) }
        )).c).toBeGreaterThan(0);

        const auditOwner = await privacyService.auditUser({ userId: OWNER });
        expect(auditOwner.byTable.kg_project_nodes).toBeGreaterThan(0);

        await privacyService.forgetUser({ userId: OWNER });
        expect((await db.get(
            `SELECT COUNT(*) AS c FROM kg_nodes WHERE scopeKey = @scopeKey`,
            { scopeKey: knowledgeGraphService.projectScopeKey(kept.id) }
        )).c).toBe(0);
        const after = await privacyService.auditUser({ userId: OWNER });
        expect(after.byTable.kg_project_nodes).toBe(0);
    });
});
