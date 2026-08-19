/**
 * Phase 4: SSE parser + webapp.nextClient serving of /app/next.
 * The React client stays opt-in; /app remains the legacy ES-module client.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-web-next-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const BOT = '900000000000000001';
const NEXT_DIR = path.join(__dirname, '../apps/web/dist');
const NEXT_INDEX = path.join(NEXT_DIR, 'index.html');
const FIXTURE = '<!doctype html><html><head><title>next-fixture</title><link rel="stylesheet" href="/app/next/style.css"></head><body><div id="root"></div></body></html>';

const { parseSseFrame, queryKeysForInvalidation } = require('../apps/web/src/lib/parseSse.cjs');

const fakeClient = {
    user: { id: BOT, username: 'Goobster' },
    guilds: { cache: new Map() }
};
const fakeChat = { maxInputLength: 20000 };

function request(port, { method = 'GET', reqPath = '/', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* html or empty */ }
                resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
    });
}

function mount(nextClient) {
    const ctx = createWebAppContext({
        client: fakeClient,
        config: { clientId: '123', webapp: { enabled: true, devMode: true, nextClient } },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { chat: fakeChat }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    return listen(app);
}

describe('parseSse', () => {
    test('parses an event + JSON data frame', () => {
        expect(parseSseFrame('event: delta\ndata: {"text":"hi"}')).toEqual({
            event: 'delta',
            data: { text: 'hi' }
        });
    });

    test('defaults the event name and rejects empty or non-JSON frames', () => {
        expect(parseSseFrame('data: {"ok":true}')).toEqual({ event: 'message', data: { ok: true } });
        expect(parseSseFrame('event: ping')).toBeNull();
        expect(parseSseFrame('data: not-json')).toBeNull();
    });

    test('maps invalidation hints onto query-key prefixes', () => {
        expect(queryKeysForInvalidation(['home'])).toEqual([['home']]);
        expect(queryKeysForInvalidation(['tasks'])).toEqual([['tasks'], ['home']]);
        expect(queryKeysForInvalidation(['tasks', 'home'])).toEqual([['tasks'], ['home']]);
        expect(queryKeysForInvalidation(['unknown-hint'])).toEqual([['unknown-hint']]);
        expect(queryKeysForInvalidation([])).toEqual([]);
    });
});

describe('webapp.nextClient', () => {
    let wroteFixture = false;
    let existingIndex = null;

    beforeAll(() => {
        if (fs.existsSync(NEXT_INDEX)) {
            existingIndex = fs.readFileSync(NEXT_INDEX, 'utf8');
        } else {
            fs.mkdirSync(NEXT_DIR, { recursive: true });
            wroteFixture = true;
        }
        fs.writeFileSync(NEXT_INDEX, FIXTURE);
    });

    afterAll(async () => {
        if (wroteFixture) {
            try { fs.unlinkSync(NEXT_INDEX); } catch { /* already gone */ }
            try { fs.rmdirSync(NEXT_DIR); } catch { /* dist had other files */ }
        } else if (existingIndex !== null) {
            fs.writeFileSync(NEXT_INDEX, existingIndex);
        }
        await eventBusService.close();
        await db.closeConnection();
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
        }
    });

    test('config reports nextClient off by default and /app/next is not the React app', async () => {
        const { server, port } = await mount(false);
        try {
            const cfg = await request(port, { reqPath: '/api/app/config' });
            expect(cfg.status).toBe(200);
            expect(cfg.json.nextClient).toBe(false);
            const page = await request(port, { reqPath: '/app/next/' });
            expect(page.status).toBe(404);
            expect(page.raw).not.toContain('next-fixture');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('config reports nextClient on and serves the built SPA plus client routes', async () => {
        const { server, port } = await mount(true);
        try {
            const cfg = await request(port, { reqPath: '/api/app/config' });
            expect(cfg.status).toBe(200);
            expect(cfg.json.nextClient).toBe(true);
            const page = await request(port, { reqPath: '/app/next/' });
            expect(page.status).toBe(200);
            expect(page.raw).toContain('next-fixture');
            expect(page.raw).toContain('/app/next/style.css');
            const deep = await request(port, { reqPath: '/app/next/study/12' });
            expect(deep.status).toBe(200);
            expect(deep.raw).toContain('next-fixture');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('flag on without a build answers NEXT_CLIENT_UNBUILT', async () => {
        const backup = NEXT_INDEX + '.bak-test';
        fs.renameSync(NEXT_INDEX, backup);
        const { server, port } = await mount(true);
        try {
            const page = await request(port, { reqPath: '/app/next/' });
            expect(page.status).toBe(404);
            expect(page.json.error.code).toBe('NEXT_CLIENT_UNBUILT');
        } finally {
            fs.renameSync(backup, NEXT_INDEX);
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe('next-client styles', () => {
    test('index.html links the stable unhashed stylesheet', () => {
        const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
        expect(html).toContain('href="/app/next/style.css"');
    });

    test('React extras style pane chrome the design system omitted', () => {
        const css = fs.readFileSync(path.join(__dirname, '../apps/web/src/styles.css'), 'utf8');
        expect(css).toContain('.pane-header');
        expect(css).toContain('.pane-body');
        expect(css).not.toMatch(/^\.pane \{ display: none/m);
    });
});
