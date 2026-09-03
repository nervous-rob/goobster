/**
 * Owner-only Observatory content route used by the applet capability bridge.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-applet-cap-api-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const USER = '100000000000000001';
const OTHER = '100000000000000002';

let server;
let port;

const ObservatoryError = class extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
};

const fakeObservatory = {
    enabled: true,
    readWorkspaceFile: jest.fn()
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
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                let json = null;
                try { json = JSON.parse(raw.toString('utf8')); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, json, raw: raw.toString('utf8'), buffer: raw });
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
    await db.run('DELETE FROM web_applets');
});

describe('GET /api/app/observatory/projects/:slug/content/*', () => {
    test('requires a session', async () => {
        const res = await request({
            reqPath: '/api/app/observatory/projects/jwst-atlas/content/live_pointings/pointings.json'
        });
        expect(res.status).toBe(401);
        expect(res.json.error.code).toBe('UNAUTHENTICATED');
        expect(fakeObservatory.readWorkspaceFile).not.toHaveBeenCalled();
    });

    test('returns owner file bytes with the service MIME type', async () => {
        fakeObservatory.readWorkspaceFile.mockResolvedValue({
            relativePath: 'live_pointings/pointings.json',
            name: 'pointings.json',
            mime: 'application/json',
            bytes: Buffer.from('{"ok":true}'),
            size: 11
        });
        const cookie = await login();
        const res = await request({
            reqPath: '/api/app/observatory/projects/jwst-atlas/content/live_pointings/pointings.json',
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/json');
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.raw).toBe('{"ok":true}');
        expect(fakeObservatory.readWorkspaceFile).toHaveBeenCalledWith({
            userId: USER,
            slug: 'jwst-atlas',
            relativePath: 'live_pointings/pointings.json'
        });
    });

    test('translates ObservatoryError and never serves another user\'s project', async () => {
        fakeObservatory.readWorkspaceFile.mockRejectedValue(
            new ObservatoryError(404, 'NO_SUCH_PROJECT', 'No project called "jwst-atlas"')
        );
        const cookie = await login(OTHER, 'other');
        const res = await request({
            reqPath: '/api/app/observatory/projects/jwst-atlas/content/notes.txt',
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe('NO_SUCH_PROJECT');
        expect(fakeObservatory.readWorkspaceFile).toHaveBeenCalledWith({
            userId: OTHER,
            slug: 'jwst-atlas',
            relativePath: 'notes.txt'
        });
    });
});

describe('PATCH /api/app/applets/:id grants', () => {
    test('persists legalized grants on a pin', async () => {
        const cookie = await login();
        const source = '<html><head><meta name="goobster-observatory-read" content="jwst-atlas"><title>Reader</title></head></html>';
        const pinned = await request({
            method: 'POST',
            reqPath: '/api/app/applets',
            headers: { Cookie: cookie },
            body: { language: 'html', source, grants: { observatoryRead: ['jwst-atlas', 'nope'] } }
        });
        expect(pinned.status).toBe(200);
        expect(pinned.json.grants).toEqual({ observatoryRead: ['jwst-atlas'] });

        const patched = await request({
            method: 'PATCH',
            reqPath: `/api/app/applets/${pinned.json.id}`,
            headers: { Cookie: cookie },
            body: { grants: { observatoryRead: [] } }
        });
        expect(patched.status).toBe(200);
        expect(patched.json.grants).toEqual({ observatoryRead: [] });
    });
});
