/**
 * HTTP auth + error translation for Project Mission routes.
 * Fake-injected projectMissions service — no sandbox, no keys.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-project-mission-api-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const USER = '100000000000000011';

let server;
let port;

const ProjectMissionError = class extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
};

const fakeMissions = {
    getOpen: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    approve: jest.fn(),
    start: jest.fn(),
    mintApprovalReceipt: jest.fn(),
    complete: jest.fn(),
    retryStep: jest.fn()
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
        deps: { projectMissions: fakeMissions }
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

describe('project mission API', () => {
    test('mission routes require a session', async () => {
        const res = await request({ reqPath: '/api/app/projects/lab/mission' });
        expect(res.status).toBe(401);
        expect(fakeMissions.getOpen).not.toHaveBeenCalled();
    });

    test('GET returns the open mission and history for the session user', async () => {
        fakeMissions.getOpen.mockResolvedValue({ id: 4, status: 'DRAFT', title: 'Bench' });
        fakeMissions.list.mockResolvedValue([{ id: 4, status: 'DRAFT' }]);
        const cookie = await login();
        const res = await request({
            reqPath: '/api/app/projects/lab/mission',
            headers: { Cookie: cookie }
        });
        expect(res.status).toBe(200);
        expect(res.json.mission.title).toBe('Bench');
        expect(fakeMissions.getOpen).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER, project: 'lab'
        }));
    });

    test('POST drafts a mission; approve/start pass the session user', async () => {
        fakeMissions.create.mockResolvedValue({ id: 5, status: 'DRAFT' });
        fakeMissions.mintApprovalReceipt.mockResolvedValue({ id: 9, nonce: 'receipt-nonce' });
        fakeMissions.approve.mockResolvedValue({ id: 5, status: 'APPROVED' });
        fakeMissions.start.mockResolvedValue({ id: 5, status: 'ACTIVE' });
        const cookie = await login();
        const created = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/mission',
            headers: { Cookie: cookie },
            body: { objective: 'Measure recall', successCriteria: 'A benchmark exists' }
        });
        expect(created.status).toBe(200);
        expect(fakeMissions.create).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER,
            project: 'lab',
            objective: 'Measure recall'
        }));

        const approved = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/mission/approve',
            headers: { Cookie: cookie },
            body: {}
        });
        expect(approved.status).toBe(200);
        expect(fakeMissions.mintApprovalReceipt).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER, project: 'lab', origin: 'portal'
        }));
        expect(fakeMissions.approve).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER, project: 'lab', receiptId: 9, nonce: 'receipt-nonce'
        }));
    });

    test('POST complete mints a complete receipt for the session user', async () => {
        fakeMissions.mintApprovalReceipt.mockResolvedValue({ id: 11, nonce: 'complete-nonce' });
        fakeMissions.complete.mockResolvedValue({ id: 5, status: 'COMPLETED' });
        const cookie = await login();
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/mission/complete',
            headers: { Cookie: cookie },
            body: { verdict: 'met' }
        });
        expect(res.status).toBe(200);
        expect(fakeMissions.mintApprovalReceipt).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER, project: 'lab', origin: 'portal', kind: 'complete'
        }));
        expect(fakeMissions.complete).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER, project: 'lab', receiptId: 11, nonce: 'complete-nonce', verdict: 'met'
        }));
    });

    test('POST retry is authorized as the session user', async () => {
        fakeMissions.retryStep.mockResolvedValue({ id: 5, status: 'ACTIVE' });
        const cookie = await login();
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/mission/steps/7/retry',
            headers: { Cookie: cookie },
            body: {}
        });
        expect(res.status).toBe(200);
        expect(fakeMissions.retryStep).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER, project: 'lab', stepId: '7'
        }));
    });

    test('translates ProjectMissionError', async () => {
        fakeMissions.create.mockRejectedValue(
            new ProjectMissionError(409, 'MISSION_OPEN', 'Already have one')
        );
        const cookie = await login();
        const res = await request({
            method: 'POST',
            reqPath: '/api/app/projects/lab/mission',
            headers: { Cookie: cookie },
            body: { objective: 'Nope', successCriteria: 'Something measurable' }
        });
        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe('MISSION_OPEN');
    });
});
