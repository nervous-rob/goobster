/**
 * Voice Live (services/voiceLiveService.js + the /api/app/voice/live
 * WebSocket in web/appApi.js): cookie-authenticated streaming transcription
 * for the Study voice chat - the energy gate -> realtime STT -> committed
 * utterance pipeline with partial transcripts and the batch fallback.
 *
 * Runs against a throwaway SQLite database with the ElevenLabs socket
 * mocked (no network) - the real Scribe protocol client is covered by
 * scribeRealtime.test.js.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const express = require('express');
const WebSocket = require('ws');

const TEST_DB = path.join(os.tmpdir(), `goobster-voicelive-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { VoiceLiveService } = require('@goobster/core/services/voiceLiveService');
const { createWebAppContext, createWebAppApp, attachWebAppWebSocket } = require('@goobster/core/web/appApi');
const webSessionService = require('@goobster/core/services/webSessionService');

const USER = '500000000000000001';

/* ---------- fakes ---------- */

/** Scripted stand-in for ScribeRealtimeConnection. */
let scribeBehavior;
let fakeScribes;
class FakeScribe extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        this.modelId = 'scribe_v2_realtime';
        this.ready = false;
        this.closed = false;
        this.sent = [];
        fakeScribes.push(this);
    }
    async connect() {
        if (scribeBehavior.failConnect) throw new Error('scribe connect failed');
        this.ready = true;
    }
    sendAudio(chunk) {
        this.sent.push(chunk);
        if (scribeBehavior.partialOnAudio) this.emit('partial', scribeBehavior.partialOnAudio);
    }
    async commit() {
        if (scribeBehavior.failCommit) {
            this.emit('error', new Error('scribe commit failed'));
            throw new Error('scribe commit failed');
        }
        return scribeBehavior.commitText ?? '';
    }
    close() {
        this.closed = true;
    }
}

const fakeWebVoice = {
    transcribe: jest.fn(async () => ({ text: 'fallback transcript words' }))
};
const fakeUsage = { log: jest.fn() };
const silentLogger = { log: () => {}, warn: () => {}, error: () => {}, info: () => {} };

let liveService;
let server;
let port;

/* ---------- PCM + WS helpers ---------- */

/** 200ms of loud (speech-like) 16kHz mono s16le PCM, base64. */
function loudChunk() {
    const samples = 3200;
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 === 0 ? 3000 : -3000, i * 2);
    return buf.toString('base64');
}

/** 200ms of silence. */
function quietChunk() {
    return Buffer.alloc(3200 * 2).toString('base64');
}

/** WebSocket test client with a scan-based message inbox. */
class LiveClient {
    constructor({ token = null, origin = null } = {}) {
        const headers = {};
        if (token) headers.cookie = `goobster_web_session=${token}`;
        if (origin) headers.origin = origin;
        this.messages = [];
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/app/voice/live`, { headers });
        this.ws.on('message', (raw) => {
            try { this.messages.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
        });
    }
    open() {
        return new Promise((resolve, reject) => {
            this.ws.on('open', resolve);
            this.ws.on('error', reject);
        });
    }
    send(payload) {
        this.ws.send(JSON.stringify(payload));
    }
    /** Resolve with the first message matching `match` (type string or fn). */
    waitFor(match, timeoutMs = 4000) {
        const fn = typeof match === 'string' ? (m => m.type === match) : match;
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const poll = () => {
                const found = this.messages.find(fn);
                if (found) return resolve(found);
                if (Date.now() - started > timeoutMs) {
                    return reject(new Error(`waitFor timed out; saw: ${this.messages.map(m => m.type).join(', ')}`));
                }
                setTimeout(poll, 10);
            };
            poll();
        });
    }
    ofType(type) {
        return this.messages.filter(m => m.type === type);
    }
    close() {
        try { this.ws.close(); } catch { /* already gone */ }
    }
}

/** Open an authenticated voice-live socket and wait for the ready ack. */
async function openLive(userId = USER) {
    const { token } = await webSessionService.create({ userId, userName: 'Tester' });
    const client = new LiveClient({ token });
    await client.open();
    await client.waitFor(m => m.type === 'ready' || m.type === 'error');
    return client;
}

/* ---------- lifecycle ---------- */

beforeAll((done) => {
    liveService = new VoiceLiveService({
        elevenLabsKey: () => 'xi-test-key',
        createScribe: (opts) => new FakeScribe(opts),
        webVoice: fakeWebVoice,
        usageTracker: fakeUsage,
        logger: silentLogger
    });
    const ctx = createWebAppContext({
        client: null,
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: silentLogger,
        deps: { voiceLive: liveService }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        attachWebAppWebSocket(server, ctx);
        done();
    });
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    fakeScribes = [];
    scribeBehavior = { commitText: 'hello goobster' };
    fakeWebVoice.transcribe.mockClear();
    fakeUsage.log.mockClear();
    await db.run('DELETE FROM web_rate_events');
});

/* ---------- specs ---------- */

describe('WebSocket auth', () => {
    test('no session cookie: the upgrade is rejected', async () => {
        const client = new LiveClient({});
        await expect(client.open()).rejects.toThrow();
    });

    test('a mismatched Origin is rejected even with a valid cookie', async () => {
        const { token } = await webSessionService.create({ userId: USER, userName: 'Tester' });
        const client = new LiveClient({ token, origin: 'https://evil.example' });
        await expect(client.open()).rejects.toThrow();
    });

    test('a valid session gets a ready ack with the expected sample rate', async () => {
        const client = await openLive();
        expect(client.ofType('ready')[0]).toMatchObject({ sampleRate: 16000 });
        client.close();
    });
});

describe('utterance pipeline', () => {
    test('silence never opens STT and commits as empty', async () => {
        const client = await openLive();
        client.send({ type: 'audio', data: quietChunk() });
        client.send({ type: 'audio', data: quietChunk() });
        client.send({ type: 'utterance-end' });
        await client.waitFor('utterance_empty');
        expect(fakeScribes).toHaveLength(0);
        expect(fakeWebVoice.transcribe).not.toHaveBeenCalled();
        client.close();
    });

    test('loud audio streams partials and commits the realtime transcript', async () => {
        scribeBehavior.partialOnAudio = 'hello goob...';
        const client = await openLive();
        client.send({ type: 'audio', data: quietChunk() }); // preroll
        client.send({ type: 'audio', data: loudChunk() });  // crosses the gate
        await client.waitFor('stt_partial');
        client.send({ type: 'utterance-end' });
        const utterance = await client.waitFor('utterance');
        expect(utterance.text).toBe('hello goobster');
        // Both the buffered preroll and the hot chunk reached the STT stream
        expect(fakeScribes).toHaveLength(1);
        expect(fakeScribes[0].sent.length).toBeGreaterThanOrEqual(2);
        expect(fakeScribes[0].closed).toBe(true);
        expect(fakeUsage.log).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'transcription-realtime',
            userId: USER,
            guildId: `dm:${USER}`
        }));
        client.close();
    });

    test('falls back to batch transcription when realtime STT fails', async () => {
        scribeBehavior.failConnect = true;
        const client = await openLive();
        client.send({ type: 'audio', data: loudChunk() });
        client.send({ type: 'utterance-end' });
        const utterance = await client.waitFor('utterance');
        expect(utterance.text).toBe('fallback transcript words');
        const call = fakeWebVoice.transcribe.mock.calls[0][0];
        expect(call.mimeType).toBe('audio/wav');
        expect(call.userId).toBe(USER);
        client.close();
    });

    test('a wordless transcript commits as empty', async () => {
        scribeBehavior.commitText = '...';
        const client = await openLive();
        client.send({ type: 'audio', data: loudChunk() });
        client.send({ type: 'utterance-end' });
        await client.waitFor('utterance_empty');
        client.close();
    });

    test('cancel discards the in-flight utterance', async () => {
        const client = await openLive();
        client.send({ type: 'audio', data: loudChunk() });
        client.send({ type: 'cancel' });
        client.send({ type: 'utterance-end' });
        // The cancelled audio is gone: the commit sees no utterance at all,
        // so nothing (not even utterance_empty) comes back.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(client.ofType('utterance')).toHaveLength(0);
        expect(client.ofType('utterance_empty')).toHaveLength(0);
        expect(fakeScribes[0].closed).toBe(true);
        client.close();
    });

    test('malformed audio payloads are rejected as BAD_AUDIO', async () => {
        const client = await openLive();
        client.send({ type: 'audio', data: 42 });
        const error = await client.waitFor('error');
        expect(error.code).toBe('BAD_AUDIO');
        client.close();
    });

    test('unknown message types are rejected as BAD_TYPE', async () => {
        const client = await openLive();
        client.send({ type: 'mystery' });
        const error = await client.waitFor('error');
        expect(error.code).toBe('BAD_TYPE');
        client.close();
    });
});

describe('capabilities', () => {
    test('live requires an ElevenLabs key', () => {
        expect(new VoiceLiveService({ elevenLabsKey: () => null }).capabilities()).toEqual({ live: false });
        expect(new VoiceLiveService({ elevenLabsKey: () => 'xi' }).capabilities()).toEqual({ live: true });
    });
});
