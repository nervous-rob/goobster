/**
 * HTTP auth + error translation for project trigger routes
 * (GET/POST/PATCH/DELETE /api/app/projects/:slug/triggers).
 *
 * Fake-injected projectTriggers service — no sandbox, no keys.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-project-trigger-api-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const USER = '100000000000000001';
const OTHER = '100000000000000002';

let server;
let port;

const ProjectTriggerError = class extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
};

const fakeTriggers = {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
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
        deps: { projectTriggers: fakeTriggers }
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

describe('project trigger API auth', () => {
    test('every trigger route requires a session', async () => {
        const paths = [
            { method: 'GET', reqPath: '/api/app/projects/lab/triggers' },
            { method: 'POST', reqPath: '/api/app/projects/lab/triggers', body: { name: 'x' } },
            { method: 'GET', reqPath: '/api/app/projects/lab/triggers/1' },
            { method: 'PATCH', reqPath: '/api/app/projects/lab/triggers/1', body: { isEnabled: false } },
            { method: 'DELETE', reqPath: '/api/app/projects/lab/triggers/1' }
        ];
        for (const call of paths) {
            const res = await request(call);
            expect(res.status).toBe(401);
            expect(res.json.error.code).toBe('UNAUTHENTICATED');
        }
        expect(fakeTriggers.list).not.toHaveBeenCalled();
        expect(fakeTriggers.create).not.toHaveBeenCalled();
    });

    test('authenticated list and create pass the session userId', async () => {
        fakeTriggers.list.mockResolvedValue([{ id: 1, name: 'Nightly' }]);
        fakeTriggers.create.mockResolvedValue({ id: 1, name: 'Nightly' });
        const cookie = await login();
        const listed = await request({
            reqPath: '/api/app/projects/lab/triggers',
            headers: { Cookie: cookie }
        });
        expect(listed.status).toBe(200);
        expect(listed.json.triggers).toEqual([{ id: 1, name: 'Nightly' }]);
        expect(fakeTriggers.list).toHaveBeenCalledWith({ userId: USER, project: 'lab' });

        const created = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/triggers',
            headers: { Cookie: cookie },
            body: {
                name: 'Nightly', kind: 'cron', schedule: '0 2 * * *',
                action: 'run_script', actionAssetId: 9
            }
        });
        expect(created.status).toBe(200);
        expect(fakeTriggers.create).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER,
            project: 'lab',
            name: 'Nightly',
            kind: 'cron',
            action: 'run_script'
        }));
    });

    test('translates ProjectTriggerError and scopes PATCH/DELETE to the session user', async () => {
        fakeTriggers.update.mockRejectedValue(
            new ProjectTriggerError(404, 'NO_SUCH_TRIGGER', 'No trigger called "1"')
        );
        const cookie = await login(OTHER, 'other');
        const res = await request({
            method: 'PATCH',
            reqPath: '/api/app/projects/lab/triggers/1',
            headers: { Cookie: cookie },
            body: { isEnabled: false }
        });
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe('NO_SUCH_TRIGGER');
        expect(fakeTriggers.update).toHaveBeenCalledWith(expect.objectContaining({
            userId: OTHER, project: 'lab', trigger: '1', isEnabled: false
        }));
    });
});
