/**
 * HTTP-level tests for the unified settings routes (web/routes/settings.js):
 * auth, the aggregated read, section writes with revision conflicts, the
 * reset preview/apply pair, and the two-step retention flow - against a
 * throwaway SQLite database, a fake Discord client, and a fake voice bridge.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-usersettings-api-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const { dmScopeId } = require('@goobster/core/utils/dmScope');
const attentionPolicyService = require('@goobster/core/services/attentionPolicyService');

const USER = '100000000000000001';
const BOT = '900000000000000001';

let server;
let port;

const DIST_DIR = path.join(__dirname, '../apps/web/dist');
const DIST_INDEX = path.join(DIST_DIR, 'index.html');
let wroteDistFixture = false;

const fakeClient = {
    user: { id: BOT, username: 'Goobster' },
    guilds: { cache: new Map() }
};

const fakeVoice = {
    capabilities: jest.fn(() => ({ stt: true, tts: false, live: false }))
};

function request({ method = 'GET', reqPath = '/', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1', port, method, path: reqPath,
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
                resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function login(userId = USER, name = 'rob') {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    expect(res.status).toBe(200);
    return res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session=')).split(';')[0];
}

let cookie;
const authed = (opts) => request({ ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });

beforeAll((done) => {
    if (!fs.existsSync(DIST_INDEX)) {
        fs.mkdirSync(DIST_DIR, { recursive: true });
        fs.writeFileSync(DIST_INDEX, '<!doctype html><html><body><div id="root"></div></body></html>');
        wroteDistFixture = true;
    }
    const ctx = createWebAppContext({
        client: fakeClient,
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { voice: fakeVoice }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', async () => {
        port = server.address().port;
        cookie = await login();
        done();
    });
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB + suffix, { force: true });
    if (wroteDistFixture) fs.rmSync(DIST_INDEX, { force: true });
});

describe('auth', () => {
    test('every settings route needs a session', async () => {
        for (const [method, reqPath] of [
            ['GET', '/api/app/settings'],
            ['PATCH', '/api/app/settings/profile'],
            ['POST', '/api/app/settings/profile/reset-preview'],
            ['POST', '/api/app/settings/profile/reset'],
            ['POST', '/api/app/settings/memory/retention-preview'],
            ['POST', '/api/app/settings/memory/retention']
        ]) {
            const res = await request({ method, reqPath, body: method === 'GET' ? null : {} });
            expect([401, 403]).toContain(res.status);
        }
    });
});

describe('GET /api/app/settings', () => {
    test('returns every section with revisions, scopes, and voice capabilities from the bridge', async () => {
        const res = await authed({ reqPath: '/api/app/settings' });
        expect(res.status).toBe(200);
        expect(res.json.schemaVersion).toBe(1);
        expect(Object.keys(res.json.sections).sort()).toEqual(
            ['account', 'appearance', 'chat', 'connections', 'initiative', 'memory', 'profile', 'voice']
        );
        expect(res.json.sections.profile).toMatchObject({ revision: 1, scope: 'private' });
        expect(res.json.sections.account.values.userId).toBe(USER);
        expect(res.json.capabilities).toEqual({ stt: true, tts: false, liveVoice: false });
        expect(fakeVoice.capabilities).toHaveBeenCalled();
    });
});

describe('PATCH /api/app/settings/:section', () => {
    test('saves a section and returns the new revision plus fresh data', async () => {
        const res = await authed({
            method: 'PATCH', reqPath: '/api/app/settings/profile',
            body: { expectedRevision: 1, changes: { callUser: 'Rob', memeMode: true } }
        });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ section: 'profile', revision: 2 });
        expect(res.json.data.values).toMatchObject({ callUser: 'Rob', memeMode: true });
        expect(res.json.data.effective.callUser).toBe('Rob');
    });

    test('a stale revision is a 409 with the current revision in details', async () => {
        const res = await authed({
            method: 'PATCH', reqPath: '/api/app/settings/profile',
            body: { expectedRevision: 1, changes: { callUser: 'Someone else' } }
        });
        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe('SETTINGS_CONFLICT');
        expect(res.json.error.details).toMatchObject({ currentRevision: 2, section: 'profile' });
        const fresh = await authed({ reqPath: '/api/app/settings' });
        expect(fresh.json.sections.profile.values.callUser).toBe('Rob');
    });

    test('validation failures are 400s with a machine-readable code', async () => {
        const res = await authed({
            method: 'PATCH', reqPath: '/api/app/settings/voice',
            body: { changes: { speed: 9 } }
        });
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe('BAD_SPEED');
    });

    test('unknown sections are 404, read-only ones 400', async () => {
        expect((await authed({ method: 'PATCH', reqPath: '/api/app/settings/bogus', body: { changes: {} } })).status).toBe(404);
        expect((await authed({ method: 'PATCH', reqPath: '/api/app/settings/account', body: { changes: {} } })).status).toBe(400);
    });

    test('initiative edits never enable attention by themselves', async () => {
        const res = await authed({
            method: 'PATCH', reqPath: '/api/app/settings/initiative',
            body: { changes: { initiative: 'assist', maxContactsPerDay: 2 } }
        });
        expect(res.status).toBe(200);
        expect(res.json.data.values).toMatchObject({ enabled: false, initiative: 'assist', maxContactsPerDay: 2 });
        expect((await attentionPolicyService.get(USER)).enabled).toBe(false);

        const on = await authed({ method: 'PATCH', reqPath: '/api/app/settings/initiative', body: { changes: { enabled: true } } });
        expect(on.json.data.values.enabled).toBe(true);
    });
});

describe('reset flow', () => {
    test('preview then reset', async () => {
        const preview = await authed({ method: 'POST', reqPath: '/api/app/settings/profile/reset-preview', body: {} });
        expect(preview.status).toBe(200);
        expect(preview.json.changes).toEqual({ callUser: null, memeMode: false });

        const reset = await authed({
            method: 'POST', reqPath: '/api/app/settings/profile/reset',
            body: { expectedRevision: preview.json.currentRevision }
        });
        expect(reset.status).toBe(200);
        expect(reset.json.revision).toBe(preview.json.currentRevision + 1);
        expect(reset.json.data.values).toMatchObject({ callUser: null, memeMode: false });
    });
});

describe('retention flow', () => {
    beforeAll(async () => {
        const old = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        for (const [content, createdAt] of [['old memory', old], ['fresh memory', null]]) {
            await db.run(
                `INSERT INTO memory_embeddings (guildId, authorId, content, embedding, dims, model, createdAt)
                 VALUES (@scope, @u, @content, @embedding, 2, 'test-embed', COALESCE(@createdAt, CURRENT_TIMESTAMP))`,
                { scope: dmScopeId(USER), u: USER, content, embedding: Buffer.from(new Float32Array([0.1, 0.2]).buffer), createdAt }
            );
        }
    });

    test('preview reports the impact without deleting', async () => {
        const res = await authed({ method: 'POST', reqPath: '/api/app/settings/memory/retention-preview', body: { days: 90 } });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ proposedRetentionDays: 90, memoryCount: 2, affectedCount: 1 });
        const { c } = await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @s', { s: dmScopeId(USER) });
        expect(c).toBe(2);
    });

    test('apply purges and reports the count; the section revision moves', async () => {
        const res = await authed({
            method: 'POST', reqPath: '/api/app/settings/memory/retention',
            body: { days: 90, expectedRevision: 1 }
        });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ section: 'memory', revision: 2, purged: 1 });
        expect(res.json.data.values.retentionDays).toBe(90);
        const { c } = await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @s', { s: dmScopeId(USER) });
        expect(c).toBe(1);
    });

    test('bad windows are 400 BAD_RETENTION', async () => {
        const res = await authed({ method: 'POST', reqPath: '/api/app/settings/memory/retention-preview', body: { days: 1e9 } });
        expect(res.status).toBe(400);
        expect(res.json.error.code).toBe('BAD_RETENTION');
    });
});
