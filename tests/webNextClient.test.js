/**
 * Phase 4 flip: SSE parser + React client served at /app.
 * webapp.nextClient: false keeps the legacy ES-module client (rollback).
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
const FIXTURE = '<!doctype html><html><head><title>next-fixture</title><link rel="stylesheet" href="/app/style.css"></head><body><div id="root"></div></body></html>';

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

    test('scoped hints (name:id) target one keyed query, numeric ids as numbers', () => {
        expect(queryKeysForInvalidation(['parlor-messages:12']))
            .toEqual([['parlor-messages', 12]]);
        expect(queryKeysForInvalidation(['parlor-members:7', 'parlor-conversations']))
            .toEqual([['parlor-members', 7], ['parlor-conversations']]);
        // Non-numeric ids stay strings; duplicates collapse
        expect(queryKeysForInvalidation(['memory:dm-abc', 'memory:dm-abc']))
            .toEqual([['memory', 'dm-abc']]);
    });
});

describe('webapp.nextClient flip', () => {
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

    test('nextClient: false keeps /app on the legacy client and does not serve the SPA fixture', async () => {
        const { server, port } = await mount(false);
        try {
            const cfg = await request(port, { reqPath: '/api/app/config' });
            expect(cfg.status).toBe(200);
            expect(cfg.json.nextClient).toBe(false);
            const page = await request(port, { reqPath: '/app/' });
            expect(page.status).toBe(200);
            expect(page.raw).not.toContain('next-fixture');
            expect(page.raw).toMatch(/Goobster|view-login|id="view-app"/);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('default (built) serves the React SPA at /app and deep client routes', async () => {
        const { server, port } = await mount(undefined);
        try {
            const cfg = await request(port, { reqPath: '/api/app/config' });
            expect(cfg.status).toBe(200);
            expect(cfg.json.nextClient).toBe(true);
            const page = await request(port, { reqPath: '/app/' });
            expect(page.status).toBe(200);
            expect(page.raw).toContain('next-fixture');
            expect(page.raw).toContain('/app/style.css');
            const deep = await request(port, { reqPath: '/app/study/12' });
            expect(deep.status).toBe(200);
            expect(deep.raw).toContain('next-fixture');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('/app/next bookmarks redirect onto /app', async () => {
        const { server, port } = await mount(undefined);
        try {
            const root = await request(port, { reqPath: '/app/next/' });
            expect(root.status).toBe(302);
            expect(root.headers.location).toBe('/app/');
            const deep = await request(port, { reqPath: '/app/next/parlor/3' });
            expect(deep.status).toBe(302);
            expect(deep.headers.location).toBe('/app/parlor/3');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('default without a build keeps leftover /app HTML', async () => {
        const backup = NEXT_INDEX + '.bak-test-default';
        fs.renameSync(NEXT_INDEX, backup);
        const { server, port } = await mount(undefined);
        try {
            const cfg = await request(port, { reqPath: '/api/app/config' });
            expect(cfg.json.nextClient).toBe(false);
            const page = await request(port, { reqPath: '/app/' });
            expect(page.status).toBe(200);
            expect(page.raw).not.toContain('next-fixture');
            expect(page.raw).toMatch(/Goobster|view-login|id="view-app"/);
        } finally {
            fs.renameSync(backup, NEXT_INDEX);
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('explicit nextClient: true without a build answers NEXT_CLIENT_UNBUILT', async () => {
        const backup = NEXT_INDEX + '.bak-test';
        fs.renameSync(NEXT_INDEX, backup);
        const { server, port } = await mount(true);
        try {
            const page = await request(port, { reqPath: '/app/' });
            expect(page.status).toBe(404);
            expect(page.json.error.code).toBe('NEXT_CLIENT_UNBUILT');
        } finally {
            fs.renameSync(backup, NEXT_INDEX);
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('share viewer still serves the read-only HTML', async () => {
        const { server, port } = await mount(undefined);
        try {
            const page = await request(port, { reqPath: '/app/share/tokentoken' });
            expect(page.status).toBe(200);
            expect(page.raw).toContain('Shared conversation');
            expect(page.raw).toContain('/app/share.js');
            const script = await request(port, { reqPath: '/app/share.js' });
            expect(script.status).toBe(200);
            expect(script.raw).toMatch(/share|token/i);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe('next-client styles and PWA shell', () => {
    test('index.html links the stable unhashed stylesheet and PWA manifest at /app', () => {
        const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
        expect(html).toContain('href="/app/style.css"');
        expect(html).toContain('href="/app/manifest.webmanifest"');
        expect(html).toContain('viewport-fit=cover');
        expect(html).toContain('theme-color');
    });

    test('PWA icon set is present for installability', () => {
        const icons = path.join(__dirname, '../apps/web/public/icons');
        for (const name of ['goobster.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon-180.png']) {
            expect(fs.existsSync(path.join(icons, name))).toBe(true);
        }
    });

    test('manifest and service worker target /app, not /app/next', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/web/public/manifest.webmanifest'), 'utf8'));
        expect(manifest.start_url).toBe('/app/');
        expect(manifest.scope).toBe('/app/');
        expect(manifest.display).toBe('standalone');
        const sw = fs.readFileSync(path.join(__dirname, '../apps/web/public/sw.js'), 'utf8');
        expect(sw).toContain("'/app/manifest.webmanifest'");
        expect(sw).toContain("url.pathname.startsWith('/api/')");
        expect(sw).toContain('/app/share/');
        expect(sw).not.toContain('/app/next');
    });

    test('React extras style pane chrome the design system omitted', () => {
        const css = fs.readFileSync(path.join(__dirname, '../apps/web/src/styles.css'), 'utf8');
        expect(css).toContain('.pane-header');
        expect(css).toContain('.pane-body');
        expect(css).not.toMatch(/^\.pane \{ display: none/m);
    });

    test('Study conversation library becomes a drawer on a narrow pane / phone', () => {
        const css = fs.readFileSync(path.join(__dirname, '../apps/web/src/styles.css'), 'utf8');
        expect(css).toContain('container-type: inline-size');
        expect(css).toContain('.icon-action.chats-btn');
        expect(css).toContain('.conversations-backdrop');
        expect(css).toMatch(/@container \(max-width: 720px\)/);
        expect(css).toMatch(/\.conversations-panel\.open[\s\S]*transform:\s*none/);
        const study = fs.readFileSync(path.join(__dirname, '../apps/web/src/rooms/StudyRoom.tsx'), 'utf8');
        expect(study).toContain('chats-btn');
        expect(study).toContain('useConversationDrawer');
        expect(study).toContain('HeaderOverflow');
        const parlor = fs.readFileSync(path.join(__dirname, '../apps/web/src/rooms/ParlorRoom.tsx'), 'utf8');
        expect(parlor).toContain('chats-btn');
        expect(parlor).toContain('useConversationDrawer');
    });

    test('Conservatory audio starts inside the playback gesture on mobile', () => {
        const tone = fs.readFileSync(
            path.join(__dirname, '../apps/web/src/music-lab/lib/stageInstruments.ts'),
            'utf8'
        );
        expect(tone).toContain("import * as ToneNamespace from 'tone'");
        expect(tone).not.toContain("await import('tone')");
        expect(tone.indexOf('const start = Tone.start()')).toBeLessThan(tone.indexOf('await start'));

        const nativeAudio = fs.readFileSync(
            path.join(__dirname, '../apps/web/src/music-lab/hooks/useAudioEngine.ts'),
            'utf8'
        );
        expect(nativeAudio.indexOf('const resume = context.resume()')).toBeLessThan(nativeAudio.indexOf('await resume'));
        expect(nativeAudio).toContain("String(context.state) !== 'running'");
    });

    test('Conservatory shell uses mobile-safe navigation and touch sizing', () => {
        const layout = fs.readFileSync(
            path.join(__dirname, '../apps/web/src/music-lab/ConservatoryLayout.tsx'),
            'utf8'
        );
        const globals = fs.readFileSync(
            path.join(__dirname, '../apps/web/src/music-lab/styles/globals.css'),
            'utf8'
        );
        const rhythm = fs.readFileSync(
            path.join(__dirname, '../apps/web/src/music-lab/styles/rhythm.css'),
            'utf8'
        );
        expect(layout).toContain('title-row conservatory-title-row');
        expect(globals).toMatch(/@media \(max-width: 720px\)/);
        expect(globals).toMatch(/\.conservatory-toolbar \.site-nav[\s\S]*overflow-x:\s*auto/);
        expect(globals).toContain('env(safe-area-inset-bottom)');
        expect(globals).toMatch(/\.conservatory-toolbar \.engine-switch-btn[\s\S]*min-height:\s*44px/);
        expect(rhythm).toMatch(/\.re-header > \.engine-switch[\s\S]*display:\s*none/);
    });

    test('graph canvas class is styled for the React client', () => {
        const css = fs.readFileSync(path.join(__dirname, '../apps/web/src/legacy.css'), 'utf8');
        expect(css).toContain('.graph-canvas');
        expect(css).toMatch(/\.graph-canvas[\s\S]*width:\s*100%/);
    });

    test('clickable list rows reset native button chrome', () => {
        const css = fs.readFileSync(path.join(__dirname, '../apps/web/src/legacy.css'), 'utf8');
        expect(css).toContain('button.list-row');
        expect(css).toMatch(/button\.list-row[\s\S]*background:\s*transparent/);
    });

    test('parlor persona controls reset native button chrome', () => {
        const css = fs.readFileSync(path.join(__dirname, '../apps/web/src/legacy.css'), 'utf8');
        expect(css).toContain('button.persona-item');
        expect(css).toContain('button.participant-chip');
        expect(css).toContain('button.persona-pick');
        expect(css).toMatch(/button\.persona-item[\s\S]*background:\s*transparent/);
    });
});
