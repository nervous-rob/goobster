/**
 * HTTP contract for workspace history (ADR 0014):
 * GET /history, GET /history/diff, GET /history/:rev/content/*,
 * POST /history/:rev/restore and POST /history/commit under
 * /api/app/projects/:slug - auth, parameter passing, and the
 * service-error contract (status + code).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-history-api-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const USER = '100000000000000002';

class HistoryError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const fakeHistory = {
    log: jest.fn(),
    diff: jest.fn(),
    show: jest.fn(),
    restore: jest.fn(),
    commit: jest.fn()
};
const fakeObservatory = {
    enabled: true,
    organizationEnabled: true,
    history: fakeHistory
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
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                let json = null;
                try { json = JSON.parse(raw.toString('utf8')); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, json, raw });
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

describe('workspace history routes', () => {
    test('every route requires a session', async () => {
        for (const call of [
            { reqPath: '/api/app/projects/lab/history' },
            { reqPath: '/api/app/projects/lab/history/diff?rev=abc1234' },
            { reqPath: '/api/app/projects/lab/history/abc1234/content/data/a.csv' },
            { method: 'POST', reqPath: '/api/app/projects/lab/history/abc1234/restore', body: { path: 'a.csv' } },
            { method: 'POST', reqPath: '/api/app/projects/lab/history/commit', body: { message: 'x' } }
        ]) {
            const res = await request(call);
            expect(res.status).toBe(401);
        }
        for (const fn of Object.values(fakeHistory)) expect(fn).not.toHaveBeenCalled();
    });

    test('the listing passes owner, path and limit through and returns the service payload verbatim', async () => {
        fakeHistory.log.mockResolvedValue({ enabled: true, commits: [{ short: 'abc1234' }] });
        const cookie = await login();
        const res = await request({
            reqPath: '/api/app/projects/lab/history?owner=42&path=data%2Fa.csv&limit=5',
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ enabled: true, commits: [{ short: 'abc1234' }] });
        expect(fakeHistory.log).toHaveBeenCalledWith({
            userId: USER, project: 'lab', owner: '42', path: 'data/a.csv', limit: '5'
        });
    });

    test('diff forwards rev, to, path and the line window', async () => {
        fakeHistory.diff.mockResolvedValue({ label: 'x', empty: false, content: '+a' });
        const cookie = await login();
        const res = await request({
            reqPath: '/api/app/projects/lab/history/diff?rev=abc1234&to=workspace&path=a.txt&offset=3&limit=10',
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(200);
        expect(res.json.content).toBe('+a');
        expect(fakeHistory.diff).toHaveBeenCalledWith({
            userId: USER, project: 'lab', owner: undefined, rev: 'abc1234', to: 'workspace',
            path: 'a.txt', offset: '3', limit: '10'
        });
    });

    test('content at a snapshot streams the bytes with the portal MIME and an inline or attachment disposition', async () => {
        fakeHistory.show.mockResolvedValue({
            relativePath: 'data/a.csv', name: 'a.csv', bytes: Buffer.from('x,y\n1,2\n'), size: 8
        });
        const cookie = await login();
        const inline = await request({
            reqPath: '/api/app/projects/lab/history/abc1234/content/data/a.csv',
            headers: { Cookie: cookie }
        });
        expect(inline.status).toBe(200);
        expect(inline.raw.toString()).toBe('x,y\n1,2\n');
        expect(inline.headers['content-type']).toMatch(/text\/csv/);
        expect(inline.headers['content-disposition']).toBe('inline; filename="a.csv"');
        expect(inline.headers['cache-control']).toBe('private, no-store');
        expect(fakeHistory.show).toHaveBeenCalledWith({
            userId: USER, project: 'lab', owner: undefined, rev: 'abc1234', path: 'data/a.csv'
        });

        const download = await request({
            reqPath: '/api/app/projects/lab/history/abc1234/content/data/a.csv?download=1',
            headers: { Cookie: cookie }
        });
        expect(download.headers['content-disposition']).toBe('attachment; filename="a.csv"');
    });

    test('restore and commit post through to the service', async () => {
        fakeHistory.restore.mockResolvedValue({ restored: 'a.txt', changed: true });
        fakeHistory.commit.mockResolvedValue({ committed: true, short: 'abc1234' });
        const cookie = await login();

        const restored = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/history/abc1234/restore?owner=42',
            headers: { Cookie: cookie },
            body: { path: 'a.txt' }
        });
        expect(restored.status).toBe(200);
        expect(restored.json).toEqual({ restored: 'a.txt', changed: true });
        expect(fakeHistory.restore).toHaveBeenCalledWith({
            userId: USER, project: 'lab', owner: '42', rev: 'abc1234', path: 'a.txt'
        });

        const whole = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/history/abc1234/restore',
            headers: { Cookie: cookie },
            body: {}
        });
        expect(whole.status).toBe(200);
        expect(fakeHistory.restore).toHaveBeenLastCalledWith(expect.objectContaining({ path: null }));

        const committed = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/history/commit',
            headers: { Cookie: cookie },
            body: { message: 'checkpoint before the big refactor' }
        });
        expect(committed.status).toBe(200);
        expect(committed.json).toEqual({ committed: true, short: 'abc1234' });
        expect(fakeHistory.commit).toHaveBeenCalledWith({
            userId: USER, project: 'lab', owner: undefined, message: 'checkpoint before the big refactor'
        });
    });

    test('service errors keep their status and code', async () => {
        fakeHistory.diff.mockRejectedValue(new HistoryError(503, 'GIT_MISSING', 'no git'));
        fakeHistory.show.mockRejectedValue(new HistoryError(404, 'NOT_FOUND', 'nope'));
        fakeHistory.restore.mockRejectedValue(new HistoryError(400, 'BAD_REV', 'bad'));
        const cookie = await login();

        const diff = await request({ reqPath: '/api/app/projects/lab/history/diff', headers: { Cookie: cookie } });
        expect(diff.status).toBe(503);
        expect(diff.json.error.code).toBe('GIT_MISSING');

        const content = await request({
            reqPath: '/api/app/projects/lab/history/abc1234/content/x.txt', headers: { Cookie: cookie }
        });
        expect(content.status).toBe(404);
        expect(content.json.error.code).toBe('NOT_FOUND');

        const restore = await request({
            method: 'POST', reqPath: '/api/app/projects/lab/history/--bad/restore',
            headers: { Cookie: cookie }, body: {}
        });
        expect(restore.status).toBe(400);
        expect(restore.json.error.code).toBe('BAD_REV');
    });
});
