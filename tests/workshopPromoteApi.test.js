/**
 * HTTP auth + userId wiring for POST /api/app/applets/promote.
 * Fake-injected applets service — no Observatory, no keys.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-workshop-promote-api-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const USER = '100000000000000011';
const OTHER = '100000000000000012';

let server;
let port;

const fakeApplets = {
    listWorkshop: jest.fn(),
    pin: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    unpin: jest.fn(),
    promote: jest.fn()
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
        deps: { applets: fakeApplets }
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

describe('promote API auth', () => {
    test('POST /api/app/applets/promote requires a session', async () => {
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/applets/promote',
            body: { name: 'Dash', language: 'html', source: '<html></html>' }
        });
        expect(res.status).toBe(401);
        expect(res.json.error.code).toBe('UNAUTHENTICATED');
        expect(fakeApplets.promote).not.toHaveBeenCalled();
    });

    test('POST /api/app/applets/:id/promote requires a session', async () => {
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/applets/3/promote',
            body: { project: 'lab' }
        });
        expect(res.status).toBe(401);
        expect(fakeApplets.promote).not.toHaveBeenCalled();
    });

    test('authenticated promote passes the session userId', async () => {
        fakeApplets.promote.mockResolvedValue({
            asset: { slug: 'dash', version: 1 },
            applet: { id: 3, migrated: true }
        });
        const cookie = await login();
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/applets/promote',
            headers: { Cookie: cookie },
            body: { appletId: 3, project: 'lab', name: 'Dash' }
        });
        expect(res.status).toBe(200);
        expect(fakeApplets.promote).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER,
            appletId: 3,
            project: 'lab',
            origin: 'portal'
        }));
    });

    test('another user\'s session is the userId that reaches promote', async () => {
        fakeApplets.promote.mockResolvedValue({ asset: { slug: 'x' }, applet: null });
        const cookie = await login(OTHER, 'other');
        await request({
            method: 'POST',
            reqPath: '/api/app/applets/9/promote',
            headers: { Cookie: cookie },
            body: { project: 'lab' }
        });
        expect(fakeApplets.promote).toHaveBeenCalledWith(expect.objectContaining({
            userId: OTHER,
            appletId: '9'
        }));
    });
});
