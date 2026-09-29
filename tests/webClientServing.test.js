/**
 * SSE parser + React client serving at /app. The React client (apps/web) is
 * the only web client: share links are SPA routes, and a missing build
 * answers WEB_CLIENT_UNBUILT instead of falling back to anything.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-web-client-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const eventBusService = require('@goobster/core/services/eventBusService');

const BOT = '900000000000000001';
// A private dist directory: parallel suites must never share (or delete)
// one another's index.html, and the real apps/web/dist stays untouched.
const DIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-web-dist-'));
const DIST_INDEX = path.join(DIST_DIR, 'index.html');
const FIXTURE = '<!doctype html><html><head><title>spa-fixture</title><link rel="stylesheet" href="/app/style.css"></head><body><div id="root"></div></body></html>';

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

function mount() {
    const ctx = createWebAppContext({
        client: fakeClient,
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} },
        deps: { chat: fakeChat, webDistDir: DIST_DIR }
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

describe('React client serving', () => {
    beforeAll(() => {
        fs.writeFileSync(DIST_INDEX, FIXTURE);
    });

    afterAll(async () => {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
        await eventBusService.close();
        await db.closeConnection();
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
        }
    });

    test('serves the SPA at /app and deep client routes', async () => {
        const { server, port } = await mount();
        try {
            const cfg = await request(port, { reqPath: '/api/app/config' });
            expect(cfg.status).toBe(200);
            expect(cfg.json.nextClient).toBeUndefined();
            const page = await request(port, { reqPath: '/app/' });
            expect(page.status).toBe(200);
            expect(page.raw).toContain('spa-fixture');
            expect(page.raw).toContain('/app/style.css');
            const deep = await request(port, { reqPath: '/app/study/12' });
            expect(deep.status).toBe(200);
            expect(deep.raw).toContain('spa-fixture');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('/app/next bookmarks redirect onto /app', async () => {
        const { server, port } = await mount();
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

    test('a missing build answers WEB_CLIENT_UNBUILT, never a fallback client', async () => {
        const unbuilt = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-web-unbuilt-'));
        const ctx = createWebAppContext({
            client: fakeClient,
            config: { clientId: '123', webapp: { enabled: true, devMode: true } },
            logger: { error: () => {}, warn: () => {}, info: () => {} },
            deps: { chat: fakeChat, webDistDir: unbuilt }
        });
        const app = express();
        app.use(createWebAppApp(ctx));
        const { server, port } = await listen(app);
        try {
            const page = await request(port, { reqPath: '/app/' });
            expect(page.status).toBe(503);
            expect(page.json.error.code).toBe('WEB_CLIENT_UNBUILT');
        } finally {
            await new Promise((resolve) => server.close(resolve));
            fs.rmSync(unbuilt, { recursive: true, force: true });
        }
    });

    test('the service worker is served no-cache with the build stamp; hashed assets are immutable', async () => {
        fs.writeFileSync(path.join(DIST_DIR, 'sw.js'), "const BUILD = '__GOOBSTER_BUILD__';\nconst CACHE = `goobster-app-${BUILD}`;\n");
        fs.mkdirSync(path.join(DIST_DIR, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(DIST_DIR, 'assets', 'index-abc123.js'), 'export const ok = 1;');
        fs.writeFileSync(path.join(DIST_DIR, 'manifest.webmanifest'), '{"name":"fixture"}');
        const { server, port } = await mount();
        try {
            const sw = await request(port, { reqPath: '/app/sw.js' });
            expect(sw.status).toBe(200);
            expect(sw.headers['cache-control']).toBe('no-cache');
            expect(sw.headers['content-type']).toContain('javascript');
            expect(sw.raw).not.toContain('__GOOBSTER_BUILD__');
            const stamp = sw.raw.match(/const BUILD = '([0-9a-f]{12})'/);
            expect(stamp).not.toBeNull();
            // The stamp is the index.html content hash: same build, same cache name.
            const again = await request(port, { reqPath: '/app/sw.js' });
            expect(again.raw).toBe(sw.raw);

            const asset = await request(port, { reqPath: '/app/assets/index-abc123.js' });
            expect(asset.status).toBe(200);
            expect(asset.headers['cache-control']).toContain('immutable');
            expect(asset.headers['cache-control']).toContain('max-age=31536000');

            const manifest = await request(port, { reqPath: '/app/manifest.webmanifest' });
            expect(manifest.status).toBe(200);
            expect(manifest.headers['cache-control']).toBe('no-cache');
            const page = await request(port, { reqPath: '/app/chat' });
            expect(page.headers['cache-control']).toBe('no-cache');

            // The share target falls back to a fresh chat when no worker intercepted it.
            const share = await request(port, { method: 'POST', reqPath: '/app/share-target' });
            expect(share.status).toBe(303);
            expect(share.headers.location).toBe('/app/chat');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('share links are SPA routes and the legacy client is gone', async () => {
        const { server, port } = await mount();
        try {
            const page = await request(port, { reqPath: '/app/share/tokentoken' });
            expect(page.status).toBe(200);
            expect(page.raw).toContain('spa-fixture');
            // The legacy ES-module client no longer exists on disk or at /app.
            expect(fs.existsSync(path.join(__dirname, '../packages/core/web/app'))).toBe(false);
            for (const gone of ['/app/share.js', '/app/app.js', '/app/chat.js', '/app/share.html']) {
                const res = await request(port, { reqPath: gone });
                expect(res.status).toBe(404);
            }
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe('client styles and PWA shell', () => {
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

    test('the mark exists in every accent and matches the generator', () => {
        const { ACCENTS } = require('@goobster/core/config/userSettingsSchema');
        const berries = require('../scripts/generate-berry-icons');
        const accents = berries.readAccents();
        expect(Object.keys(accents).sort()).toEqual([...ACCENTS].sort());
        const master = fs.readFileSync(berries.MASTER, 'utf8');
        for (const id of ACCENTS) {
            const file = path.join(berries.OUT_DIR, `${id}.svg`);
            expect(fs.existsSync(file)).toBe(true);
            expect(fs.readFileSync(file, 'utf8')).toBe(berries.renderBerry(id, accents[id], master));
        }
        // Blueberry is the master's own palette, so its render keeps the master's colours.
        const strip = (svg) => svg.replace(/^<!--[\s\S]*?-->\n/, '');
        expect(strip(berries.renderBerry('blueberry', accents.blueberry, master))).toBe(strip(master));
        // Every other accent recolours the berry (the leaf and sheen are untouched).
        expect(berries.renderBerry('mint', accents.mint, master)).not.toContain('#6f7cf2');
        expect(berries.renderBerry('mint', accents.mint, master)).toContain('#6bcf9c');
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

    test('the manifest is complete for an installed app (documentation/pwa.md)', () => {
        const pub = path.join(__dirname, '../apps/web/public');
        const manifest = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
        expect(manifest.id).toBe('/app/');
        expect(manifest.lang).toBe('en');
        expect(manifest.display_override).toEqual(['window-controls-overlay', 'standalone']);
        expect(manifest.launch_handler.client_mode).toContain('navigate-existing');
        expect(Array.isArray(manifest.categories) && manifest.categories.length > 0).toBe(true);
        // Shortcuts point at canonical rooms inside the scope, with icons.
        const { canonicalPath } = require('../apps/web/src/lib/rooms.cjs');
        expect(manifest.shortcuts.length).toBeGreaterThanOrEqual(3);
        for (const shortcut of manifest.shortcuts) {
            expect(shortcut.url.startsWith('/app/')).toBe(true);
            const inApp = shortcut.url.slice(4);
            expect(canonicalPath(inApp)).toBe(inApp);
            expect(shortcut.icons[0].src.startsWith('/app/icons/')).toBe(true);
            expect(fs.existsSync(path.join(pub, shortcut.icons[0].src.replace(/^\/app\//, '')))).toBe(true);
        }
        // Screenshots: one per form factor, files present, sizes as declared.
        expect(manifest.screenshots.map(s => s.form_factor).sort()).toEqual(['narrow', 'wide']);
        for (const shot of manifest.screenshots) {
            const file = path.join(pub, shot.src.replace(/^\/app\//, ''));
            expect(fs.existsSync(file)).toBe(true);
            const [w, h] = shot.sizes.split('x').map(Number);
            const png = fs.readFileSync(file);
            expect(png.readUInt32BE(16)).toBe(w);
            expect(png.readUInt32BE(20)).toBe(h);
        }
        // Share target: POST multipart into the scope, handled by the worker.
        expect(manifest.share_target).toMatchObject({ action: '/app/share-target', method: 'POST', enctype: 'multipart/form-data' });
        expect(manifest.share_target.params.files[0].accept).toContain('image/*');
        expect(fs.existsSync(path.join(pub, 'offline.html'))).toBe(true);
    });

    test('the service worker recovers stale chunks, serves offline, and handles push + share (documentation/pwa.md)', () => {
        const sw = fs.readFileSync(path.join(__dirname, '../apps/web/public/sw.js'), 'utf8');
        // Build-stamped cache, replaced by the server on the way out.
        expect(sw).toContain("const BUILD = '__GOOBSTER_BUILD__'");
        expect(sw).toContain('goobster-app-${BUILD}');
        expect(sw).toContain("'/app/offline.html'");
        // Documents are never cached; an offline navigation gets the offline page.
        expect(sw).toMatch(/request\.mode === 'navigate'/);
        expect(sw).toContain('caches.match(OFFLINE_PAGE)');
        // A 404 for a chunk that vanished with a deploy falls back to the cached copy.
        expect(sw).toMatch(/if \(fresh\.ok\)[\s\S]*const cached = await caches\.match\(request\);\s*return cached \|\| fresh;/);
        expect(sw).toContain("url.pathname.startsWith('/app/assets/')");
        // Push and its click land on a portal path; a visible window suppresses the toast.
        expect(sw).toContain("addEventListener('push'");
        expect(sw).toContain("addEventListener('notificationclick'");
        expect(sw).toContain("addEventListener('pushsubscriptionchange'");
        expect(sw).toContain("visibilityState === 'visible'");
        expect(sw).toContain('goobster:navigate');
        // Share target parks the payload and redirects into the chat.
        expect(sw).toContain("url.pathname === '/app/share-target'");
        expect(sw).toContain('/app/chat?shared=1');
        // The update handshake.
        expect(sw).toContain('SKIP_WAITING');
        expect(sw).toContain('self.skipWaiting()');
        // Live-only paths stay live.
        expect(sw).toContain("url.pathname === '/app/sw.js'");
    });

    test('index.html carries the installed-app metas and the client wires the PWA plumbing', () => {
        const html = fs.readFileSync(path.join(__dirname, '../apps/web/index.html'), 'utf8');
        expect(html).toContain('name="color-scheme"');
        expect(html).toContain('name="mobile-web-app-capable"');
        expect(html).toContain('name="apple-mobile-web-app-title"');
        const main = fs.readFileSync(path.join(__dirname, '../apps/web/src/main.tsx'), 'utf8');
        expect(main).toContain('registerServiceWorker()');
        expect(main).toContain('captureInstallPrompt()');
        expect(main).toContain('installChunkRecovery()');
        expect(main).toContain('<ChunkErrorBoundary>');
        const shell = fs.readFileSync(path.join(__dirname, '../apps/web/src/shell/AppShell.tsx'), 'utf8');
        expect(shell).toContain('setAppBadge(');
        expect(shell).toContain('useOnline()');
        expect(shell).toContain('useServiceWorkerUpdate()');
        expect(shell).toContain('showLocalNotification(');
        expect(shell).toContain('offline-banner');
        expect(shell).toContain('update-banner');
        const query = fs.readFileSync(path.join(__dirname, '../apps/web/src/lib/query.ts'), 'utf8');
        expect(query).toContain("networkMode: 'offlineFirst'");
        const study = fs.readFileSync(path.join(__dirname, '../apps/web/src/rooms/StudyRoom.tsx'), 'utf8');
        expect(study).toContain('consumeSharedPayload');
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
