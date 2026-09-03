/**
 * HTTP auth + path legalization for workspace write routes
 * (PUT/DELETE /api/app/projects/:slug/content/*).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-ws-write-api-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const USER = '100000000000000001';

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
    writeWorkspaceFile: jest.fn(),
    deleteWorkspaceFile: jest.fn(),
    listFiles: jest.fn(),
    readWorkspaceFile: jest.fn()
};

function request({ method = 'GET', reqPath, headers = {}, body = null, raw = null }) {
    const payload = raw || (body ? JSON.stringify(body) : null);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers: {
                ...(payload && !raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(raw ? { 'Content-Length': Buffer.byteLength(raw) } : {}),
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

describe('workspace write routes', () => {
    test('PUT and DELETE require a session', async () => {
        for (const call of [
            { method: 'PUT', reqPath: '/api/app/projects/lab/content/notes.txt', body: { content: 'x' } },
            { method: 'DELETE', reqPath: '/api/app/projects/lab/content/notes.txt' },
            { method: 'PUT', reqPath: '/api/app/observatory/projects/lab/content/notes.txt', body: { content: 'x' } },
            { method: 'DELETE', reqPath: '/api/app/observatory/projects/lab/content/notes.txt' }
        ]) {
            const res = await request(call);
            expect(res.status).toBe(401);
        }
        expect(fakeObservatory.writeWorkspaceFile).not.toHaveBeenCalled();
        expect(fakeObservatory.deleteWorkspaceFile).not.toHaveBeenCalled();
    });

    test('PUT and DELETE pass the relative path through to the shared writer', async () => {
        fakeObservatory.writeWorkspaceFile.mockResolvedValue({ relativePath: 'data/notes.txt', size: 1 });
        fakeObservatory.deleteWorkspaceFile.mockResolvedValue({ deleted: true, relativePath: 'data/notes.txt' });
        const cookie = await login();
        const put = await request({
            method: 'PUT',
            reqPath: '/api/app/projects/lab/content/data/notes.txt',
            headers: { Cookie: cookie },
            body: { content: 'hello' }
        });
        expect(put.status).toBe(200);
        expect(fakeObservatory.writeWorkspaceFile).toHaveBeenCalledWith({
            userId: USER,
            slug: 'lab',
            relativePath: 'data/notes.txt',
            bytes: Buffer.from('hello')
        });

        const del = await request({
            method: 'DELETE',
            reqPath: '/api/app/projects/lab/content/data/notes.txt',
            headers: { Cookie: cookie }
        });
        expect(del.status).toBe(200);
        expect(fakeObservatory.deleteWorkspaceFile).toHaveBeenCalledWith({
            userId: USER,
            slug: 'lab',
            relativePath: 'data/notes.txt'
        });
    });

    test('write routes surface traversal refusal from legalizeWorkspacePath', async () => {
        fakeObservatory.writeWorkspaceFile.mockRejectedValue(
            new ObservatoryError(400, 'BAD_PATH', 'Path must stay inside the project workspace.')
        );
        fakeObservatory.deleteWorkspaceFile.mockRejectedValue(
            new ObservatoryError(400, 'BAD_PATH', 'Path must stay inside the project workspace.')
        );
        const cookie = await login();
        const put = await request({
            method: 'PUT',
            reqPath: '/api/app/projects/lab/content/../../../etc/passwd',
            headers: { Cookie: cookie },
            body: { content: 'x' }
        });
        expect(put.status).toBe(400);
        expect(put.json.error.code).toBe('BAD_PATH');
        const del = await request({
            method: 'DELETE',
            reqPath: '/api/app/observatory/projects/lab/content/../../../etc/passwd',
            headers: { Cookie: cookie }
        });
        expect(del.status).toBe(400);
        expect(del.json.error.code).toBe('BAD_PATH');
    });
});
