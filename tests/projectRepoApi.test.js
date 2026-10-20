/**
 * HTTP contract for project repositories (ADR 0015):
 * GET/POST /repos, GET/DELETE /repos/:name and POST /repos/:name/{pull,
 * commit, push, branch, reset} under /api/app/projects/:slug - auth,
 * parameter passing, and the service-error contract (status + code).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-repos-api-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const USER = '100000000000000003';

class RepoError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const fakeRepos = {
    list: jest.fn(),
    clone: jest.fn(),
    status: jest.fn(),
    remove: jest.fn(),
    pull: jest.fn(),
    commit: jest.fn(),
    push: jest.fn(),
    checkout: jest.fn(),
    reset: jest.fn()
};
const fakeObservatory = {
    enabled: true,
    organizationEnabled: true,
    repos: fakeRepos
};

let server;
let port;

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
                try { json = JSON.parse(data); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function login(userId = USER, name = 'rob') {
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
    const ctx = createWebAppContext({
        client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { observatory: fakeObservatory }
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
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

beforeEach(async () => {
    jest.clearAllMocks();
    await db.run('DELETE FROM web_sessions');
});

describe('project repository routes', () => {
    test('every route requires a session', async () => {
        for (const call of [
            { reqPath: '/api/app/projects/lab/repos' },
            { method: 'POST', reqPath: '/api/app/projects/lab/repos', body: { repo: 'acme/widgets' } },
            { reqPath: '/api/app/projects/lab/repos/widgets' },
            { method: 'DELETE', reqPath: '/api/app/projects/lab/repos/widgets' },
            { method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/pull' },
            { method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/commit', body: { message: 'x' } },
            { method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/push' },
            { method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/branch', body: { branch: 'x' } },
            { method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/reset' }
        ]) {
            const res = await request(call);
            expect(res.status).toBe(401);
        }
        for (const fn of Object.values(fakeRepos)) expect(fn).not.toHaveBeenCalled();
    });

    test('listing and clone pass owner, repo, branch and name through', async () => {
        fakeRepos.list.mockResolvedValue({ enabled: true, maxRepos: 3, repos: [] });
        fakeRepos.clone.mockResolvedValue({ name: 'widgets', repo: 'acme/widgets' });
        const cookie = await login();

        const listed = await request({ reqPath: '/api/app/projects/lab/repos?owner=42', headers: { Cookie: cookie } });
        expect(listed.status).toBe(200);
        expect(listed.json).toEqual({ enabled: true, maxRepos: 3, repos: [] });
        expect(fakeRepos.list).toHaveBeenCalledWith({ userId: USER, project: 'lab', owner: '42' });

        const cloned = await request({
            method: 'POST', reqPath: '/api/app/projects/lab/repos', headers: { Cookie: cookie },
            body: { repo: 'https://github.com/acme/widgets', branch: 'dev', name: 'w' }
        });
        expect(cloned.status).toBe(200);
        expect(cloned.json).toEqual({ name: 'widgets', repo: 'acme/widgets' });
        expect(fakeRepos.clone).toHaveBeenCalledWith({
            userId: USER, project: 'lab', owner: undefined, repo: 'https://github.com/acme/widgets', branch: 'dev', name: 'w'
        });
    });

    test('status, actions and removal address one clone by name', async () => {
        for (const fn of Object.values(fakeRepos)) fn.mockResolvedValue({ ok: true });
        const cookie = await login();
        const base = { userId: USER, project: 'lab', owner: undefined, name: 'widgets' };

        expect((await request({ reqPath: '/api/app/projects/lab/repos/widgets', headers: { Cookie: cookie } })).status).toBe(200);
        expect(fakeRepos.status).toHaveBeenCalledWith(base);

        await request({ method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/pull', headers: { Cookie: cookie } });
        expect(fakeRepos.pull).toHaveBeenCalledWith(base);

        await request({ method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/commit', headers: { Cookie: cookie }, body: { message: 'add notes' } });
        expect(fakeRepos.commit).toHaveBeenCalledWith({ ...base, message: 'add notes', paths: null });

        await request({ method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/commit', headers: { Cookie: cookie }, body: { message: 'only one', paths: ['a.txt'] } });
        expect(fakeRepos.commit).toHaveBeenLastCalledWith({ ...base, message: 'only one', paths: ['a.txt'] });

        await request({ method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/push', headers: { Cookie: cookie }, body: { branch: 'feature/x' } });
        expect(fakeRepos.push).toHaveBeenCalledWith({ ...base, branch: 'feature/x' });
        await request({ method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/push', headers: { Cookie: cookie } });
        expect(fakeRepos.push).toHaveBeenLastCalledWith({ ...base, branch: null });

        await request({ method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/branch', headers: { Cookie: cookie }, body: { branch: 'main' } });
        expect(fakeRepos.checkout).toHaveBeenCalledWith({ ...base, branch: 'main' });

        await request({ method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/reset', headers: { Cookie: cookie } });
        expect(fakeRepos.reset).toHaveBeenCalledWith(base);

        await request({ method: 'DELETE', reqPath: '/api/app/projects/lab/repos/widgets?owner=42', headers: { Cookie: cookie } });
        expect(fakeRepos.remove).toHaveBeenCalledWith({ ...base, owner: '42' });
    });

    test('service errors keep their status and code', async () => {
        fakeRepos.clone.mockRejectedValue(new RepoError(403, 'NO_GITHUB', 'connect first'));
        fakeRepos.push.mockRejectedValue(new RepoError(409, 'REJECTED', 'pull first'));
        const cookie = await login();

        const cloned = await request({
            method: 'POST', reqPath: '/api/app/projects/lab/repos', headers: { Cookie: cookie }, body: { repo: 'acme/widgets' }
        });
        expect(cloned.status).toBe(403);
        expect(cloned.json.error.code).toBe('NO_GITHUB');

        const pushed = await request({ method: 'POST', reqPath: '/api/app/projects/lab/repos/widgets/push', headers: { Cookie: cookie } });
        expect(pushed.status).toBe(409);
        expect(pushed.json.error.code).toBe('REJECTED');
    });
});
