/**
 * Phase 6: project chat dock — conversation binding, compact manifest,
 * turn lock on the dock route, and refetch hints on mutations.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-project-chat-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');
const {
    ObservatoryService,
    PROJECTS_ROOT,
    DASHBOARDS_ROOT
} = require('@goobster/core/services/projectService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const projectAssetService = require('@goobster/core/services/projectAssetService');
const projectTriggerService = require('@goobster/core/services/projectTriggerService');
const { WebChatError } = require('@goobster/core/services/webChatService');

const USER = '100000000000000001';
const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-project-chat-runs-${process.pid}`);

function makeService(observatory = {}) {
    return new ObservatoryService({
        config: {
            enabled: true,
            scope: 'everywhere',
            maxProjectsPerUser: 20,
            maxProjectMb: 64,
            maxActiveJobsPerUser: 2,
            maxResumes: 2,
            maxWorkspaceFiles: 50,
            maxWorkspaceReadMb: 8,
            maxUploadMb: 8,
            maxRenderFrames: 10,
            renderFps: 24,
            ffmpegCommand: 'ffmpeg',
            maxAssetsPerProject: 40,
            maxVersionsPerAsset: 20,
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
            requireStrongIsolation: false,
            pythonCommand: 'python3',
            extraBinds: [],
            runsDir: SANDBOX_ROOT
        })
    });
}

function request({ method = 'GET', reqPath, headers = {}, body = null }) {
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
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

let server;
let port;
let conversations = [];
const fakeChat = {
    listConversations: jest.fn(async () => conversations),
    createConversation: jest.fn(async () => {
        const created = { id: 42, title: null, messageCount: 0 };
        conversations = [created];
        return created;
    }),
    renameConversation: jest.fn(async ({ conversationId, title }) => {
        conversations = conversations.map((row) => (
            Number(row.id) === Number(conversationId) ? { ...row, title } : row
        ));
        return { id: Number(conversationId), title };
    }),
    startTurn: jest.fn(async () => ({
        conversationId: 42,
        abort: () => {},
        release: async () => {},
        run: async (events) => {
            events?.onTyping?.();
            events?.onMessage?.({ content: 'ok', attachments: [], isError: false });
        }
    }))
};

const fakeObservatory = {
    enabled: true,
    resolveProject: jest.fn(async ({ project }) => ({ slug: project, name: 'Lab' })),
    buildChatManifest: jest.fn(async () => ({
        text: 'Project manifest for "Lab" (slug: lab):\nAssets (1): dash app html v1',
        truncated: { assets: false, triggers: false, files: false }
    }))
};

async function login() {
    const res = await request({
        method: 'POST',
        reqPath: '/api/app/auth/dev-session',
        body: { userId: USER, name: 'rob' }
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'].find((c) => c.startsWith('goobster_web_session='));
    return setCookie.split(';')[0];
}

beforeAll((done) => {
    const ctx = createWebAppContext({
        client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { chat: fakeChat, observatory: fakeObservatory }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* gone */ }
});

beforeEach(async () => {
    jest.clearAllMocks();
    conversations = [];
    fakeChat.listConversations.mockImplementation(async () => conversations);
    fakeChat.createConversation.mockImplementation(async () => {
        const created = { id: 42, title: null, messageCount: 0 };
        conversations = [created];
        return created;
    });
    fakeChat.renameConversation.mockImplementation(async ({ conversationId, title }) => {
        conversations = conversations.map((row) => (
            Number(row.id) === Number(conversationId) ? { ...row, title } : row
        ));
        return { id: Number(conversationId), title };
    });
    fakeChat.startTurn.mockImplementation(async () => ({
        conversationId: 42,
        abort: () => {},
        release: async () => {},
        run: async (events) => {
            events?.onTyping?.();
            events?.onMessage?.({ content: 'ok', attachments: [], isError: false });
        }
    }));
    await db.run('DELETE FROM web_sessions');
});

describe('project chat conversation binding', () => {
    test('one 🔭 conversation per project is created and then reused', async () => {
        const cookie = await login();
        const first = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/chat',
            headers: { Cookie: cookie },
            body: { message: 'status?' }
        });
        expect(first.status).toBe(200);
        expect(fakeChat.createConversation).toHaveBeenCalledTimes(1);
        expect(fakeChat.renameConversation).toHaveBeenCalledWith(
            expect.objectContaining({ userId: USER, title: '🔭 Lab' })
        );
        expect(fakeChat.startTurn).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER,
            conversationId: 42
        }));
        expect(fakeObservatory.buildChatManifest).toHaveBeenCalledWith({
            userId: USER, project: 'lab'
        });

        const second = await request({
            method: 'POST',
            reqPath: '/api/app/observatory/command',
            headers: { Cookie: cookie },
            body: { project: 'lab', instructions: 'again' }
        });
        expect(second.status).toBe(200);
        expect(fakeChat.createConversation).toHaveBeenCalledTimes(1);
        expect(fakeChat.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({
            conversationId: 42
        }));
    });

    test('the dock route respects the per-user turn lock', async () => {
        fakeChat.startTurn.mockRejectedValueOnce(
            new WebChatError(409, 'TURN_IN_FLIGHT', 'A reply is still being generated.')
        );
        const cookie = await login();
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/chat',
            headers: { Cookie: cookie },
            body: { message: 'busy' }
        });
        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe('TURN_IN_FLIGHT');
    });
});

describe('compact project manifest', () => {
    const TEST_USERS = [];
    afterAll(() => {
        for (const userId of TEST_USERS) {
            try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
            try { fs.rmSync(path.join(DASHBOARDS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
        }
    });

    test('truncates long asset / trigger / workspace lists', async () => {
        const svc = makeService();
        const userId = `chat-user-${process.pid}`;
        TEST_USERS.push(userId);
        const { slug } = await svc.createProject({ userId, name: 'Busy Lab' });
        for (let i = 0; i < 12; i++) {
            await projectAssetService.save({
                userId, project: slug, name: `note-${i}`, kind: 'note',
                language: 'markdown', source: `# ${i}\n`, origin: 'portal'
            });
        }
        for (let i = 0; i < 8; i++) {
            await projectTriggerService.create({
                userId,
                project: slug,
                name: `trig-${i}`,
                kind: 'event',
                eventTopic: 'job_completed',
                action: 'agent_prompt',
                actionParams: { prompt: 'look' }
            });
        }
        for (let i = 0; i < 10; i++) {
            await svc.writeWorkspaceFile({
                userId, slug, relativePath: `file-${i}.txt`, bytes: 'x'
            });
        }
        const manifest = await svc.buildChatManifest({
            userId, project: slug, maxAssets: 5, maxTriggers: 3, maxFiles: 4
        });
        expect(manifest.truncated.assets).toBe(true);
        expect(manifest.truncated.triggers).toBe(true);
        expect(manifest.truncated.files).toBe(true);
        expect(manifest.text).toContain('Assets (12):');
        expect(manifest.text).toContain('+7 more');
        expect(manifest.text).toContain('Triggers (8):');
        expect(manifest.text).toContain('+5 more');
        expect(manifest.text).toContain('Workspace / (10):');
        expect(manifest.text).toContain('+6 more');
        expect(manifest.text).toContain('note-11');
        expect(manifest.text).not.toContain('note-0');
    });
});

describe('project refetch hints', () => {
    const TEST_USERS = [];
    afterAll(() => {
        for (const userId of TEST_USERS) {
            try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
            try { fs.rmSync(path.join(DASHBOARDS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
        }
    });

    function expectProjectHint(spy, { userId, slug, reason }) {
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
            userId,
            slug,
            reason
        }));
    }

    test('publishProjectChange carries scoped refetch hints', () => {
        const seen = [];
        const stop = eventBusService.subscribe((event) => seen.push(event));
        eventBusService.publishProjectChange({
            userId: USER, slug: 'lab', reason: 'asset'
        });
        stop();
        expect(seen).toEqual([expect.objectContaining({
            kind: 'project-changed',
            payload: expect.objectContaining({
                userId: USER,
                slug: 'lab',
                reason: 'asset',
                invalidate: [
                    'observatory',
                    'project-assets:lab',
                    'project-files:lab',
                    'project-triggers:lab'
                ]
            })
        })]);
    });

    test('asset save, trigger change, and workspace write emit refetch hints', async () => {
        const svc = makeService();
        const userId = `hint-user-${process.pid}`;
        TEST_USERS.push(userId);
        const { slug } = await svc.createProject({ userId, name: 'Hint Lab' });
        const spy = jest.spyOn(eventBusService, 'publishProjectChange');

        await projectAssetService.save({
            userId, project: slug, name: 'dash', kind: 'app',
            language: 'html', source: '<html></html>', origin: 'portal'
        });
        expectProjectHint(spy, { userId, slug, reason: 'asset' });

        spy.mockClear();
        await projectTriggerService.create({
            userId,
            project: slug,
            name: 'nightly',
            kind: 'event',
            eventTopic: 'job_failed',
            action: 'agent_prompt',
            actionParams: { prompt: 'inspect' }
        });
        expectProjectHint(spy, { userId, slug, reason: 'trigger' });

        spy.mockClear();
        await svc.writeWorkspaceFile({
            userId, slug, relativePath: 'data/out.txt', bytes: 'ok'
        });
        expectProjectHint(spy, { userId, slug, reason: 'workspace' });
        spy.mockRestore();
    });
});
