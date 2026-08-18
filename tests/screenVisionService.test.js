/**
 * Screen vision: pairing lifecycle, the companion WebSocket protocol
 * (hello/capture/frame), frame caching, and the pairing HTTP endpoint -
 * against a throwaway SQLite database and a real ws server on an
 * ephemeral port.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DB = path.join(os.tmpdir(), `goobster-screenvision-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const express = require('express');
const WebSocket = require('ws');
const db = require('@goobster/core/db');
const screenVisionService = require('@goobster/core/services/screenVisionService');
const { createScreenVisionApp, attachScreenVisionWebSocket } = require('@goobster/bot/web/screenVisionApi');

const USER = '500000000000000001';
const TINY_PNG_BASE64 = Buffer.from('not-a-real-png-but-fine-for-transport').toString('base64');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let server;
let port;

beforeAll(async () => {
    screenVisionService.configure({ enabled: true, logger: silentLogger });
    const app = express();
    app.use(createScreenVisionApp({ logger: silentLogger }));
    server = http.createServer(app);
    attachScreenVisionWebSocket(server, { logger: silentLogger });
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

/** Connect a fake companion and authenticate with the given token. */
function connectCompanion(token, { autoFrame = true, meta } = {}) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/screen/ws`);
        socket.on('error', reject);
        socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', token })));
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.type === 'ready') resolve(socket);
            if (message.type === 'error') reject(new Error(message.code));
            if (message.type === 'capture' && autoFrame) {
                socket.send(JSON.stringify({
                    type: 'frame',
                    requestId: message.requestId,
                    format: 'image/jpeg',
                    data: TINY_PNG_BASE64,
                    meta: meta || { windowTitle: 'ELDEN RING', appName: 'eldenring.exe' }
                }));
            }
        });
    });
}

describe('pairing lifecycle', () => {
    afterEach(async () => {
        await screenVisionService.unlink(USER);
        screenVisionService._redeemAttempts = [];
    });

    test('link code redeems once and stores only a token hash', async () => {
        const { code } = screenVisionService.createPairingCode(USER);
        expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

        const { token, userId } = await screenVisionService.redeemPairingCode(code, 'Test PC');
        expect(userId).toBe(USER);
        expect(token).toHaveLength(64);

        const row = await db.get('SELECT tokenHash, label FROM screen_vision_clients WHERE userId = @u', { u: USER });
        expect(row.label).toBe('Test PC');
        expect(row.tokenHash).not.toContain(token);

        // Single use
        await expect((async () => await screenVisionService.redeemPairingCode(code))()).rejects.toThrow(/invalid or expired/i);
    });

    test('invalid and expired codes are rejected', async () => {
        await expect((async () => await screenVisionService.redeemPairingCode('NOPE-NOPE'))()).rejects.toThrow(/invalid or expired/i);

        const { code } = screenVisionService.createPairingCode(USER);
        screenVisionService.pairCodes.get(code).expiresAt = Date.now() - 1;
        await expect((async () => await screenVisionService.redeemPairingCode(code))()).rejects.toThrow(/invalid or expired/i);
    });

    test('redeeming is throttled', async () => {
        for (let i = 0; i < 10; i++) {
            await expect((async () => await screenVisionService.redeemPairingCode('AAAA-AAAA'))()).rejects.toThrow(/invalid or expired/i);
        }
        await expect((async () => await screenVisionService.redeemPairingCode('AAAA-AAAA'))()).rejects.toThrow(/too many/i);
    });

    test('unlink reports whether a pairing existed', async () => {
        const { code } = screenVisionService.createPairingCode(USER);
        await screenVisionService.redeemPairingCode(code);
        expect(await screenVisionService.unlink(USER)).toBe(true);
        expect(await screenVisionService.unlink(USER)).toBe(false);
        expect((await screenVisionService.getStatus(USER)).linked).toBe(false);
    });

    test('serves the self-install page and the zero-dependency companion app', async () => {
        const page = await fetch(`http://127.0.0.1:${port}/companion`);
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toContain('text/html');
        expect(await page.text()).toContain('Goobster Screen Companion');

        const script = await fetch(`http://127.0.0.1:${port}/companion.js`);
        expect(script.status).toBe(200);
        expect(script.headers.get('content-type')).toContain('javascript');
        const source = await script.text();
        expect(source).toContain('goobster-screen-companion');
        // Zero-dependency guarantee: the served app must only use node builtins
        const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
        expect(requires.length).toBeGreaterThan(0);
        for (const specifier of requires) {
            expect(specifier).toMatch(/^node:/);
        }
    });

    test('install page shows binary downloads only when a releases URL is configured', async () => {
        const withoutReleases = await (await fetch(`http://127.0.0.1:${port}/companion`)).text();
        expect(withoutReleases).not.toContain('__RELEASES_URL__'); // placeholder always replaced
        expect(withoutReleases).toContain("var releasesUrl = '';");

        screenVisionService.configure({
            enabled: true,
            releasesUrl: 'https://github.com/example/goobster/releases/latest',
            logger: silentLogger
        });
        try {
            const withReleases = await (await fetch(`http://127.0.0.1:${port}/companion`)).text();
            expect(withReleases).toContain("var releasesUrl = 'https://github.com/example/goobster/releases/latest';");
        } finally {
            screenVisionService.configure({ enabled: true, logger: silentLogger });
        }
    });

    test('getInstallUrl reflects the configured public URL', () => {
        screenVisionService.configure({ enabled: true, publicUrl: 'https://goob.example.com/', logger: silentLogger });
        expect(screenVisionService.getInstallUrl('AAAA-2222')).toBe('https://goob.example.com/companion?code=AAAA-2222');
        screenVisionService.configure({ enabled: true, logger: silentLogger });
        expect(screenVisionService.getInstallUrl('AAAA-2222')).toBeNull();
    });

    test('the HTTP pair endpoint exchanges a code for a token', async () => {
        const { code } = screenVisionService.createPairingCode(USER);
        const response = await fetch(`http://127.0.0.1:${port}/api/screen/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code, label: 'HTTP PC' })
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.userId).toBe(USER);
        expect(body.token).toHaveLength(64);

        const bad = await fetch(`http://127.0.0.1:${port}/api/screen/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: 'WRONG-CODE' })
        });
        expect(bad.status).toBe(400);
    });
});

describe('companion WebSocket protocol', () => {
    let token;
    let socket;

    beforeEach(async () => {
        screenVisionService._redeemAttempts = [];
        const { code } = screenVisionService.createPairingCode(USER);
        ({ token } = await screenVisionService.redeemPairingCode(code, 'WS PC'));
    });

    afterEach(async () => {
        try { socket?.close(); } catch { /* already closed */ }
        socket = null;
        await screenVisionService.unlink(USER);
        screenVisionService.frameCache.clear();
    });

    test('rejects a bad token', async () => {
        await expect(connectCompanion('deadbeef')).rejects.toThrow('AUTH_FAILED');
        expect(screenVisionService.isConnected(USER)).toBe(false);
    });

    test('authenticates, reports connected, and serves a capture', async () => {
        socket = await connectCompanion(token);
        expect(screenVisionService.isConnected(USER)).toBe(true);
        expect(await screenVisionService.getStatus(USER)).toMatchObject({ linked: true, connected: true, label: 'WS PC' });

        const frame = await screenVisionService.captureFrame(USER);
        expect(frame.dataUrl).toBe(`data:image/jpeg;base64,${TINY_PNG_BASE64}`);
        expect(frame.meta).toEqual({ windowTitle: 'ELDEN RING', appName: 'eldenring.exe' });
    });

    test('caches recent frames instead of re-requesting', async () => {
        let captureRequests = 0;
        socket = await connectCompanion(token);
        socket.on('message', (raw) => {
            if (JSON.parse(raw.toString()).type === 'capture') captureRequests++;
        });

        const first = await screenVisionService.captureFrame(USER);
        const second = await screenVisionService.captureFrame(USER);
        expect(second).toBe(first);
        expect(captureRequests).toBe(1);
    });

    test('capture timeout resolves null instead of throwing', async () => {
        socket = await connectCompanion(token, { autoFrame: false });
        const frame = await screenVisionService.captureFrame(USER, { timeoutMs: 200 });
        expect(frame).toBeNull();
    });

    test('client capture errors resolve null', async () => {
        socket = new WebSocket(`ws://127.0.0.1:${port}/api/screen/ws`);
        await new Promise((resolve, reject) => {
            socket.on('error', reject);
            socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', token })));
            socket.on('message', (raw) => {
                const message = JSON.parse(raw.toString());
                if (message.type === 'ready') resolve();
                if (message.type === 'capture') {
                    socket.send(JSON.stringify({ type: 'capture_error', requestId: message.requestId, message: 'display asleep' }));
                }
            });
        });
        const frame = await screenVisionService.captureFrame(USER);
        expect(frame).toBeNull();
    });

    test('capture returns null when no companion is connected', async () => {
        expect(await screenVisionService.captureFrame(USER)).toBeNull();
    });

    test('unlink disconnects the live companion', async () => {
        socket = await connectCompanion(token);
        const closed = new Promise(resolve => socket.on('close', resolve));
        await screenVisionService.unlink(USER);
        await closed;
        expect(screenVisionService.isConnected(USER)).toBe(false);
    });

    test('captureFrame is a no-op when the feature is disabled', async () => {
        socket = await connectCompanion(token);
        screenVisionService.configure({ enabled: false, logger: silentLogger });
        try {
            expect(await screenVisionService.captureFrame(USER)).toBeNull();
        } finally {
            screenVisionService.configure({ enabled: true, logger: silentLogger });
        }
    });
});

describe('presence metadata and context building', () => {
    const memberPlaying = {
        presence: {
            activities: [
                { type: 4, name: 'Custom Status', state: 'vibing' },
                { type: 0, name: 'ELDEN RING', details: 'Exploring Leyndell', state: 'Level 92' }
            ]
        }
    };

    test('getPresenceGame extracts rich presence details', () => {
        expect(screenVisionService.getPresenceGame(memberPlaying))
            .toBe('ELDEN RING - Exploring Leyndell - Level 92');
        expect(screenVisionService.getPresenceGame({ presence: { activities: [] } })).toBeNull();
        expect(screenVisionService.getPresenceGame(null)).toBeNull();
    });

    test('buildUserScreenContext with presence only (no companion)', async () => {
        const context = await screenVisionService.buildUserScreenContext({
            userId: USER, userName: 'Alice', member: memberPlaying
        });
        expect(context.frame).toBeNull();
        expect(context.line).toContain('ELDEN RING - Exploring Leyndell');
        expect(context.line).toContain('cannot see their screen');
    });

    test('buildUserScreenContext returns null with nothing to add', async () => {
        expect(await screenVisionService.buildUserScreenContext({
            userId: USER, userName: 'Alice', member: null
        })).toBeNull();
    });

    test('parseImageDataUrl accepts frames and rejects everything else', () => {
        const { parseImageDataUrl } = require('@goobster/core/utils/imageDataUrl');
        const parsed = parseImageDataUrl(`data:image/jpeg;base64,${TINY_PNG_BASE64}`);
        expect(parsed).toEqual({ mimeType: 'image/jpeg', data: TINY_PNG_BASE64 });
        expect(parseImageDataUrl('https://cdn.discordapp.com/attachments/x.png')).toBeNull();
        expect(parseImageDataUrl('data:text/html;base64,PGI+')).toBeNull();
        expect(parseImageDataUrl(null)).toBeNull();
    });

    test('buildUserScreenContext attaches the live frame when connected', async () => {
        screenVisionService._redeemAttempts = [];
        const { code } = screenVisionService.createPairingCode(USER);
        const { token } = await screenVisionService.redeemPairingCode(code);
        const socket = await connectCompanion(token);
        try {
            const context = await screenVisionService.buildUserScreenContext({
                userId: USER, userName: 'Alice', member: memberPlaying
            });
            expect(context.frame.dataUrl).toContain('data:image/jpeg;base64,');
            expect(context.line).toContain('live screenshot');
            expect(context.line).toContain('ELDEN RING');
        } finally {
            socket.close();
            await screenVisionService.unlink(USER);
            screenVisionService.frameCache.clear();
        }
    });
});
