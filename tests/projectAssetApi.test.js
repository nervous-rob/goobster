/**
 * HTTP auth + error translation for project asset routes
 * (GET/POST/PATCH/DELETE /api/app/projects/:slug/assets[...]).
 *
 * Fake-injected projectAssets service — no Observatory sandbox, no keys.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-project-asset-api-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const USER = '100000000000000001';
const OTHER = '100000000000000002';

let server;
let port;

const ProjectAssetError = class extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
};

const fakeAssets = {
    list: jest.fn(),
    save: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    listVersions: jest.fn(),
    rollback: jest.fn()
};

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
        deps: { projectAssets: fakeAssets }
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

describe('project asset API auth', () => {
    test('every asset route requires a session', async () => {
        const paths = [
            { method: 'GET', reqPath: '/api/app/projects/lab/assets' },
            { method: 'POST', reqPath: '/api/app/projects/lab/assets', body: { kind: 'app' } },
            { method: 'GET', reqPath: '/api/app/projects/lab/assets/dash' },
            { method: 'PATCH', reqPath: '/api/app/projects/lab/assets/dash', body: { name: 'x' } },
            { method: 'DELETE', reqPath: '/api/app/projects/lab/assets/dash' },
            { method: 'GET', reqPath: '/api/app/projects/lab/assets/dash/versions' },
            { method: 'GET', reqPath: '/api/app/projects/lab/assets/dash/versions/1' },
            { method: 'POST', reqPath: '/api/app/projects/lab/assets/dash/rollback', body: { version: 1 } }
        ];
        for (const call of paths) {
            const res = await request(call);
            expect(res.status).toBe(401);
            expect(res.json.error.code).toBe('UNAUTHENTICATED');
        }
        expect(fakeAssets.list).not.toHaveBeenCalled();
        expect(fakeAssets.save).not.toHaveBeenCalled();
        expect(fakeAssets.rollback).not.toHaveBeenCalled();
    });

    test('authenticated list and save pass the session userId', async () => {
        fakeAssets.list.mockResolvedValue([{ slug: 'dash', kind: 'app' }]);
        fakeAssets.save.mockResolvedValue({ slug: 'dash', version: 1 });
        const cookie = await login();
        const listed = await request({
            reqPath: '/api/app/projects/lab/assets?kind=app',
            headers: { Cookie: cookie }
        });
        expect(listed.status).toBe(200);
        expect(listed.json.assets).toEqual([{ slug: 'dash', kind: 'app' }]);
        expect(fakeAssets.list).toHaveBeenCalledWith({
            userId: USER, project: 'lab', kind: 'app'
        });

        const saved = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/assets',
            headers: { Cookie: cookie },
            body: { name: 'Dash', kind: 'app', language: 'html', source: '<html></html>' }
        });
        expect(saved.status).toBe(200);
        expect(fakeAssets.save).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER,
            project: 'lab',
            kind: 'app',
            origin: 'portal'
        }));
    });

    test('translates ProjectAssetError and never calls through for another user\'s session', async () => {
        fakeAssets.get.mockRejectedValue(
            new ProjectAssetError(404, 'NO_SUCH_ASSET', 'No asset called "dash"')
        );
        const cookie = await login(OTHER, 'other');
        const res = await request({
            reqPath: '/api/app/projects/lab/assets/dash',
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe('NO_SUCH_ASSET');
        expect(fakeAssets.get).toHaveBeenCalledWith({
            userId: OTHER, project: 'lab', asset: 'dash', version: null
        });
    });

    test('get version, list versions, and rollback wire the path params', async () => {
        fakeAssets.get.mockResolvedValue({ slug: 'dash', version: 2 });
        fakeAssets.listVersions.mockResolvedValue({ versions: [{ version: 2 }] });
        fakeAssets.rollback.mockResolvedValue({ slug: 'dash', version: 1 });
        const cookie = await login();

        const versioned = await request({
            reqPath: '/api/app/projects/lab/assets/dash/versions/2',
            headers: { Cookie: cookie }
        });
        expect(versioned.status).toBe(200);
        expect(fakeAssets.get).toHaveBeenCalledWith({
            userId: USER, project: 'lab', asset: 'dash', version: '2'
        });

        const history = await request({
            reqPath: '/api/app/projects/lab/assets/dash/versions',
            headers: { Cookie: cookie }
        });
        expect(history.status).toBe(200);
        expect(fakeAssets.listVersions).toHaveBeenCalledWith({
            userId: USER, project: 'lab', asset: 'dash'
        });

        const rolled = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/assets/dash/rollback',
            headers: { Cookie: cookie },
            body: { version: 1 }
        });
        expect(rolled.status).toBe(200);
        expect(fakeAssets.rollback).toHaveBeenCalledWith({
            userId: USER, project: 'lab', asset: 'dash', version: 1
        });
    });
});
