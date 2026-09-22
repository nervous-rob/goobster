/**
 * ADR 0009 - project organization is separate from execution.
 *
 * A real ObservatoryService with the execution switch OFF (and a disabled
 * sandbox) behind the real portal routes: organizing projects works -
 * direct creation with a goal, listing, opening, members, share links -
 * while anything that would run code is refused with 403 DISABLED, and
 * /me reports the two capabilities separately. Also pins the owner-safe
 * addressing that the portal's URLs rely on: two owners with one slug are
 * both listed with their ownerId, and a slug alone is ambiguous.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-project-organization-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const { ObservatoryService, PROJECTS_ROOT, DASHBOARDS_ROOT } = require('@goobster/core/services/projectService');

const ROB = '100000000000000031';
const SAM = '100000000000000032';

let server;
let port;
let svc;

function makeService(overrides = {}) {
    return new ObservatoryService({
        config: {
            enabled: false,
            scope: 'web',
            maxProjectsPerUser: 5,
            maxMembersPerProject: 5,
            maxProjectMb: 64,
            maxActiveJobsPerUser: 1,
            maxResumes: 1,
            maxWorkspaceFiles: 50,
            maxWorkspaceReadMb: 8,
            maxUploadMb: 8,
            maxRenderFrames: 10,
            renderFps: 24,
            ffmpegCommand: 'ffmpeg',
            ...overrides
        },
        sandbox: new SandboxService({
            enabled: false,
            scope: 'web',
            timeoutMs: 1000,
            maxCpuSeconds: 1,
            maxMemoryMb: 64,
            maxWriteMb: 1,
            maxOutputBytes: 1024,
            maxOutputFiles: 1,
            maxFileSizeBytes: 1024,
            runsPerWindow: 1,
            maxConcurrent: 1,
            retentionHours: 1,
            allowNetwork: false,
            pythonCommand: 'python3',
            extraBinds: [],
            requireStrongIsolation: false,
            runsDir: path.join(os.tmpdir(), `goobster-org-sandbox-${process.pid}`)
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
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* SSE or empty */ }
                resolve({ status: res.statusCode, headers: res.headers, json, text: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function login(userId, name) {
    const res = await request({
        method: 'POST',
        reqPath: '/api/app/auth/dev-session',
        body: { userId, name }
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session='));
    return setCookie.split(';')[0];
}

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
    await eventBusService.close();
    await db.closeConnection();
    for (const userId of [ROB, SAM, '100000000000000033']) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
        try { fs.rmSync(path.join(DASHBOARDS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
    }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

describe('capabilities', () => {
    test('the service separates organization from execution', () => {
        expect(svc.organizationEnabled).toBe(true);
        expect(svc.executionEnabled).toBe(false);
        // The historical name keeps meaning "may run code" for the tool registry.
        expect(svc.enabled).toBe(false);
    });

    test('/me reports features.projects and features.observatory separately', async () => {
        const cookie = await login(ROB, 'rob');
        const me = await request({ reqPath: '/api/app/me', headers: { cookie } });
        expect(me.status).toBe(200);
        expect(me.json.features.projects).toBe(true);
        expect(me.json.features.observatory).toBe(false);
    });
});

describe('organizing with execution off', () => {
    test('POST /api/app/projects creates an empty container with a goal, no model call', async () => {
        const cookie = await login(ROB, 'rob');
        const created = await request({
            method: 'POST', reqPath: '/api/app/projects', headers: { cookie },
            body: { name: 'Emergence study', goal: '  Find out whether the cadence matters.  ' }
        });
        expect(created.status).toBe(200);
        expect(created.json.project).toMatchObject({
            slug: 'emergence-study',
            name: 'Emergence study',
            description: 'Find out whether the cadence matters.',
            ownerId: ROB
        });

        const list = await request({ reqPath: '/api/app/observatory/projects', headers: { cookie } });
        expect(list.status).toBe(200);
        expect(list.json.projects).toHaveLength(1);
        expect(list.json.projects[0]).toMatchObject({
            slug: 'emergence-study', ownerId: ROB, role: 'owner',
            description: 'Find out whether the cadence matters.'
        });

        const detail = await request({
            reqPath: `/api/app/observatory/projects/emergence-study?owner=${ROB}`, headers: { cookie }
        });
        expect(detail.status).toBe(200);
        expect(detail.json.project.description).toBe('Find out whether the cadence matters.');
        expect(detail.json.jobs).toEqual([]);
        expect(fs.existsSync(path.join(PROJECTS_ROOT, ROB, 'emergence-study'))).toBe(true);
    });

    test('a name is required; a goal is optional', async () => {
        const cookie = await login(ROB, 'rob');
        const noName = await request({
            method: 'POST', reqPath: '/api/app/projects', headers: { cookie }, body: { goal: 'x' }
        });
        expect(noName.status).toBe(400);
        expect(noName.json.error.code).toBe('BAD_NAME');

        const noGoal = await request({
            method: 'POST', reqPath: '/api/app/projects', headers: { cookie }, body: { name: 'Bare' }
        });
        expect(noGoal.status).toBe(200);
        expect(noGoal.json.project.description).toBeNull();
    });

    test('creation requires a session', async () => {
        const res = await request({ method: 'POST', reqPath: '/api/app/projects', body: { name: 'Nope' } });
        expect(res.status).toBe(401);
    });

    test('members and share links are organization, not execution', async () => {
        const cookie = await login(ROB, 'rob');
        const members = await request({
            reqPath: `/api/app/projects/emergence-study/members?owner=${ROB}`, headers: { cookie }
        });
        expect(members.status).toBe(200);
        expect(members.json.role).toBe('owner');

        const share = await request({
            method: 'POST', reqPath: `/api/app/observatory/projects/emergence-study/share?owner=${ROB}`, headers: { cookie }
        });
        expect(share.status).toBe(200);
        expect(share.json.url).toMatch(/^\/app\/observatory\/share\//);
    });

    test('running, rendering and the command turn are refused with DISABLED', async () => {
        const cookie = await login(ROB, 'rob');
        const render = await request({
            method: 'POST', reqPath: `/api/app/observatory/projects/emergence-study/render?owner=${ROB}`, headers: { cookie }
        });
        expect(render.status).toBe(403);
        expect(render.json.error.code).toBe('DISABLED');
        expect(render.json.error.message).toMatch(/Code execution is off/);

        const command = await request({
            method: 'POST', reqPath: '/api/app/observatory/command', headers: { cookie },
            body: { project: 'emergence-study', owner: ROB, instructions: 'run it' }
        });
        expect(command.status).toBe(403);
        expect(command.json.error.code).toBe('DISABLED');

        const conversation = await request({
            reqPath: `/api/app/projects/emergence-study/conversation?owner=${ROB}`, headers: { cookie }
        });
        expect(conversation.status).toBe(403);
        expect(conversation.json.error.code).toBe('DISABLED');

        await expect(svc.run({ userId: ROB, project: 'emergence-study', language: 'bash', code: 'true' }))
            .rejects.toMatchObject({ status: 403, code: 'DISABLED' });
    });
});

describe('owner-safe addressing', () => {
    test('two owners may share a slug; the list names each owner and a bare slug is ambiguous', async () => {
        const rob = await login(ROB, 'rob');
        const sam = await login(SAM, 'sam');
        const theirs = await request({
            method: 'POST', reqPath: '/api/app/projects', headers: { cookie: sam },
            body: { name: 'Emergence study', goal: 'A different study with the same name.' }
        });
        expect(theirs.status).toBe(200);
        expect(theirs.json.project.slug).toBe('emergence-study');

        const { invite } = await svc.invite({ userId: SAM, project: 'emergence-study', inviteeId: ROB });
        await svc.respondInvite({ userId: ROB, inviteId: invite.id, accept: true });

        const list = await request({ reqPath: '/api/app/observatory/projects', headers: { cookie: rob } });
        const same = list.json.projects.filter(p => p.slug === 'emergence-study');
        expect(same).toHaveLength(2);
        expect(new Set(same.map(p => p.ownerId))).toEqual(new Set([ROB, SAM]));
        expect(same.find(p => p.ownerId === SAM).role).toBe('collaborator');
        // The other owner is named from her portal sign-in (principals),
        // not shown as a bare id - there is no user_nicknames row for her.
        expect(same.find(p => p.ownerId === SAM).ownerName).toBe('sam');

        // Owner-qualified opens exactly the project asked for ...
        const mine = await request({
            reqPath: `/api/app/observatory/projects/emergence-study?owner=${ROB}`, headers: { cookie: rob }
        });
        expect(mine.json.project.ownerId).toBe(ROB);
        const shared = await request({
            reqPath: `/api/app/observatory/projects/emergence-study?owner=${SAM}`, headers: { cookie: rob }
        });
        expect(shared.json.project.ownerId).toBe(SAM);
        expect(shared.json.project.role).toBe('collaborator');
        expect(shared.json.project.description).toBe('A different study with the same name.');

        // ... a bare slug prefers the caller's own project (the tool's "my
        // project"), and is ambiguous only between memberships - which is
        // why the portal resolves slug-only links from the list, where every
        // row carries its ownerId, instead of asking the server to guess.
        const bare = await request({
            reqPath: '/api/app/observatory/projects/emergence-study', headers: { cookie: rob }
        });
        expect(bare.status).toBe(200);
        expect(bare.json.project.ownerId).toBe(ROB);

        const third = await login('100000000000000033', 'tia');
        const { invite: a } = await svc.invite({ userId: ROB, project: 'emergence-study', inviteeId: '100000000000000033' });
        await svc.respondInvite({ userId: '100000000000000033', inviteId: a.id, accept: true });
        const { invite: b } = await svc.invite({ userId: SAM, project: 'emergence-study', inviteeId: '100000000000000033' });
        await svc.respondInvite({ userId: '100000000000000033', inviteId: b.id, accept: true });
        const ambiguous = await request({
            reqPath: '/api/app/observatory/projects/emergence-study', headers: { cookie: third }
        });
        expect(ambiguous.status).toBe(409);
        expect(ambiguous.json.error.code).toBe('AMBIGUOUS_PROJECT');
        const picked = await request({
            reqPath: `/api/app/observatory/projects/emergence-study?owner=${SAM}`, headers: { cookie: third }
        });
        expect(picked.status).toBe(200);
        expect(picked.json.project.ownerId).toBe(SAM);
    });
});
