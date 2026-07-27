/**
 * GBA run broadcasting (Goobster Plays Pokémon, Phase 1): guild-scoped
 * pairing lifecycle, the harness WebSocket protocol (hello/status/post),
 * rate-limited channel posting through a fake Discord client, and the
 * pairing HTTP endpoint — against a throwaway SQLite database and a real
 * ws server on an ephemeral port.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const TEST_DB = path.join(os.tmpdir(), `goobster-gbarun-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const express = require('express');
const WebSocket = require('ws');
const db = require('../db');
const gbaRunService = require('../services/gbaRunService');
const { createGbaRunApp, attachGbaRunWebSocket } = require('../web/gbaRunApi');
const { parsePlaybook, PlaybookError } = require('../clients/gba-mcp/lib/playbook');

const GUILD = '600000000000000001';
const CHANNEL = '700000000000000001';
const PNG_BASE64 = Buffer.from('pretend-png-bytes').toString('base64');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let server;
let port;
let sentMessages;
let fakeClient;

beforeAll(async () => {
    sentMessages = [];
    fakeClient = {
        channels: {
            fetch: jest.fn(async (channelId) => {
                if (channelId !== CHANNEL) throw new Error('Unknown Channel');
                return {
                    isTextBased: () => true,
                    send: async (payload) => { sentMessages.push({ channelId, payload }); }
                };
            })
        }
    };
    gbaRunService.configure({ enabled: true, client: fakeClient, logger: silentLogger, minPostIntervalMs: 0 });

    const app = express();
    app.use(createGbaRunApp({ logger: silentLogger }));
    server = http.createServer(app);
    attachGbaRunWebSocket(server, { logger: silentLogger });
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

/** Connect a fake harness and authenticate with the given token. */
function connectHarness(token) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/gba-run/ws`);
        const acks = [];
        const waiters = [];
        socket.on('error', reject);
        socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', token })));
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            if (message.type === 'ready') resolve(socket);
            if (message.type === 'error') reject(new Error(message.code));
            if (message.type === 'ack') {
                const waiter = waiters.shift();
                if (waiter) waiter(message);
                else acks.push(message);
            }
        });
        socket.nextAck = () => new Promise(res => {
            if (acks.length) res(acks.shift());
            else waiters.push(res);
        });
    });
}

describe('pairing lifecycle', () => {
    afterEach(() => {
        gbaRunService.unlink(GUILD);
        gbaRunService._redeemAttempts = [];
    });

    test('link code redeems once, binds the channel, and stores only a token hash', () => {
        const { code } = gbaRunService.createPairingCode(GUILD, CHANNEL);
        expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

        const { token, guildId } = gbaRunService.redeemPairingCode(code, 'Gaming laptop');
        expect(guildId).toBe(GUILD);
        expect(token).toHaveLength(64);

        const row = db.get('SELECT channelId, tokenHash, label FROM gba_run_clients WHERE guildId = @g', { g: GUILD });
        expect(row.channelId).toBe(CHANNEL);
        expect(row.label).toBe('Gaming laptop');
        expect(row.tokenHash).not.toContain(token);

        // Single use
        expect(() => gbaRunService.redeemPairingCode(code)).toThrow(/invalid or expired/i);
    });

    test('one outstanding code per guild — a new link replaces the old code', () => {
        const first = gbaRunService.createPairingCode(GUILD, CHANNEL);
        const second = gbaRunService.createPairingCode(GUILD, CHANNEL);
        expect(() => gbaRunService.redeemPairingCode(first.code)).toThrow(/invalid or expired/i);
        expect(gbaRunService.redeemPairingCode(second.code).guildId).toBe(GUILD);
    });

    test('expired codes are rejected and redeeming is throttled', () => {
        const { code } = gbaRunService.createPairingCode(GUILD, CHANNEL);
        gbaRunService.pairCodes.get(code).expiresAt = Date.now() - 1;
        expect(() => gbaRunService.redeemPairingCode(code)).toThrow(/invalid or expired/i);

        gbaRunService._redeemAttempts = [];
        for (let i = 0; i < 10; i++) {
            expect(() => gbaRunService.redeemPairingCode('AAAA-AAAA')).toThrow(/invalid or expired/i);
        }
        expect(() => gbaRunService.redeemPairingCode('AAAA-AAAA')).toThrow(/too many/i);
    });

    test('unlink reports whether a pairing existed', () => {
        const { code } = gbaRunService.createPairingCode(GUILD, CHANNEL);
        gbaRunService.redeemPairingCode(code);
        expect(gbaRunService.unlink(GUILD)).toBe(true);
        expect(gbaRunService.unlink(GUILD)).toBe(false);
        expect(gbaRunService.getStatus(GUILD).linked).toBe(false);
    });

    test('the HTTP pair endpoint exchanges a code for a token', async () => {
        const { code } = gbaRunService.createPairingCode(GUILD, CHANNEL);
        const response = await fetch(`http://127.0.0.1:${port}/api/gba-run/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code, label: 'HTTP laptop' })
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.guildId).toBe(GUILD);
        expect(body.token).toHaveLength(64);

        const bad = await fetch(`http://127.0.0.1:${port}/api/gba-run/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: 'WRONG-CODE' })
        });
        expect(bad.status).toBe(400);
    });
});

describe('harness WebSocket protocol', () => {
    let token;
    let socket;

    beforeEach(() => {
        sentMessages.length = 0;
        gbaRunService._redeemAttempts = [];
        const { code } = gbaRunService.createPairingCode(GUILD, CHANNEL);
        ({ token } = gbaRunService.redeemPairingCode(code, 'WS laptop'));
    });

    afterEach(() => {
        try { socket?.close(); } catch { /* already closed */ }
        socket = null;
        gbaRunService.unlink(GUILD);
    });

    test('rejects a bad token', async () => {
        await expect(connectHarness('deadbeef')).rejects.toThrow('AUTH_FAILED');
        expect(gbaRunService.isConnected(GUILD)).toBe(false);
    });

    test('authenticates and reports status, including the announced game', async () => {
        socket = await connectHarness(token);
        expect(gbaRunService.isConnected(GUILD)).toBe(true);

        socket.send(JSON.stringify({ type: 'status', game: { title: 'POKEMON FIRE', code: 'BPRE' } }));
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(gbaRunService.getStatus(GUILD)).toMatchObject({
            linked: true,
            connected: true,
            channelId: CHANNEL,
            label: 'WS laptop',
            game: { title: 'POKEMON FIRE', code: 'BPRE' }
        });
    });

    test('posts text and screenshots into the bound channel and acks', async () => {
        socket = await connectHarness(token);
        socket.send(JSON.stringify({ type: 'post', seq: 1, text: 'Here we go!', image: PNG_BASE64, filename: 'step-1.png' }));
        const ack = await socket.nextAck();
        expect(ack).toMatchObject({ seq: 1, posted: true });

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].payload.content).toBe('Here we go!');
        expect(sentMessages[0].payload.files[0].name).toBe('step-1.png');
        expect(Buffer.compare(sentMessages[0].payload.files[0].attachment, Buffer.from(PNG_BASE64, 'base64'))).toBe(0);
    });

    test('rejects empty posts and oversized images with ack errors', async () => {
        socket = await connectHarness(token);

        socket.send(JSON.stringify({ type: 'post', seq: 2 }));
        expect(await socket.nextAck()).toMatchObject({ seq: 2, posted: false, error: expect.stringMatching(/text and\/or image/) });

        socket.send(JSON.stringify({ type: 'post', seq: 3, image: 'x'.repeat(4 * 1024 * 1024 + 1) }));
        expect(await socket.nextAck()).toMatchObject({ seq: 3, posted: false, error: expect.stringMatching(/too large/) });

        expect(sentMessages).toHaveLength(0);
    });

    test('unsafe filenames fall back to a default', async () => {
        socket = await connectHarness(token);
        socket.send(JSON.stringify({ type: 'post', seq: 4, image: PNG_BASE64, filename: '../../etc/passwd' }));
        expect(await socket.nextAck()).toMatchObject({ seq: 4, posted: true });
        expect(sentMessages[0].payload.files[0].name).toBe('gba-run.png');
    });

    test('queue overflows are acked as rate limited, not buffered forever', async () => {
        // Block draining with a long interval so the queue fills.
        gbaRunService.configure({ enabled: true, client: fakeClient, logger: silentLogger, minPostIntervalMs: 60000 });
        // Prime lastPostAt so every queued post must wait out the interval.
        gbaRunService._postQueues.set(GUILD, { queue: [], timer: null, lastPostAt: Date.now() });
        try {
            socket = await connectHarness(token);
            for (let i = 0; i < 21; i++) {
                socket.send(JSON.stringify({ type: 'post', seq: 10 + i, text: `post ${i}` }));
            }
            const acks = [];
            for (let i = 0; i < 1; i++) acks.push(await socket.nextAck());
            expect(acks[0]).toMatchObject({ posted: false, error: expect.stringMatching(/queue is full/) });
        } finally {
            gbaRunService.configure({ enabled: true, client: fakeClient, logger: silentLogger, minPostIntervalMs: 0 });
            gbaRunService._postQueues.delete(GUILD);
        }
    });

    test('posting fails cleanly when the channel is gone', async () => {
        db.run('UPDATE gba_run_clients SET channelId = @c WHERE guildId = @g', { c: '999999999999999999', g: GUILD });
        socket = await connectHarness(token);
        socket.send(JSON.stringify({ type: 'post', seq: 30, text: 'hello?' }));
        expect(await socket.nextAck()).toMatchObject({ seq: 30, posted: false, error: expect.stringMatching(/channel not found/) });
        expect(sentMessages).toHaveLength(0);
    });

    test('posting is a no-op ack when the feature is disabled', async () => {
        socket = await connectHarness(token);
        gbaRunService.configure({ enabled: false, client: fakeClient, logger: silentLogger, minPostIntervalMs: 0 });
        try {
            socket.send(JSON.stringify({ type: 'post', seq: 40, text: 'anyone home?' }));
            expect(await socket.nextAck()).toMatchObject({ seq: 40, posted: false, error: expect.stringMatching(/disabled/) });
        } finally {
            gbaRunService.configure({ enabled: true, client: fakeClient, logger: silentLogger, minPostIntervalMs: 0 });
        }
    });

    test('unlink disconnects the live harness', async () => {
        socket = await connectHarness(token);
        const closed = new Promise(resolve => socket.on('close', resolve));
        gbaRunService.unlink(GUILD);
        await closed;
        expect(gbaRunService.isConnected(GUILD)).toBe(false);
    });
});

describe('playbook parsing (run driver)', () => {
    test('parses and normalizes every step kind', () => {
        const playbook = parsePlaybook({
            name: 'Demo',
            steps: [
                { post: 'hi', screen: true },
                { press: ['UP', 'B+RIGHT'], hold: 8, gap: 2 },
                { wait: 120 },
                { save: 1 },
                { load: 1 },
                { note: 'checkpoint' }
            ]
        });
        expect(playbook.name).toBe('Demo');
        expect(playbook.steps.map(s => s.kind)).toEqual(['post', 'press', 'wait', 'save', 'load', 'note']);
        expect(playbook.steps[1].presses).toEqual([
            { mask: 1 << 6, label: 'UP' },
            { mask: (1 << 1) | (1 << 4), label: 'B+RIGHT' }
        ]);
        expect(playbook.steps[1].holdFrames).toBe(8);
        expect(playbook.steps[2].frames).toBe(120);
    });

    test('rejects malformed playbooks with step positions', () => {
        expect(() => parsePlaybook(null)).toThrow(PlaybookError);
        expect(() => parsePlaybook({ steps: [] })).toThrow(/non-empty/);
        expect(() => parsePlaybook({ steps: [{ press: ['UP'], wait: 5 }] })).toThrow(/step 1: exactly one/);
        expect(() => parsePlaybook({ steps: [{ post: 'ok' }, { press: ['WARP'] }] })).toThrow(/step 2: Unknown button "WARP"/);
        expect(() => parsePlaybook({ steps: [{ post: '', screen: false }] })).toThrow(/step 1: a post needs/);
        expect(() => parsePlaybook({ steps: [{ post: 'x', upscale: 9 }] })).toThrow(/upscale/);
    });

    test('the shipped demo playbook is valid', () => {
        const raw = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', 'clients', 'gba-mcp', 'playbooks', 'keytest-demo.json'), 'utf8'));
        const playbook = parsePlaybook(raw);
        expect(playbook.steps.length).toBeGreaterThan(5);
        expect(playbook.steps.some(s => s.kind === 'post' && s.screen)).toBe(true);
    });
});
