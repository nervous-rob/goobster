/**
 * Parlor Live (services/parlorLiveService.js + the /api/app/parlor/live
 * WebSocket in web/appApi.js): per-persona voices resolved at save time,
 * cookie-authenticated live sessions with membership checks, the energy
 * gate -> realtime STT -> parlor turn pipeline with the batch fallback,
 * per-persona TTS fan-out tagged with personaId, solo barge-in, utterance
 * queueing behind the turn lock, and the SSE observe tap.
 *
 * Runs against a throwaway SQLite database with the AI/embedding backends
 * and the ElevenLabs sockets mocked (no network) - the real Scribe and TTS
 * protocol clients are covered by scribeRealtime.test.js and
 * multiContextTTS.test.js.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const express = require('express');
const WebSocket = require('ws');

const TEST_DB = path.join(os.tmpdir(), `goobster-parlorlive-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const mockEmbedding = {
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) =>
        texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    cosineSimilarity: () => 1
};
jest.mock('@goobster/core/services/embeddingService', () => mockEmbedding);

const mockAi = {
    chat: jest.fn(),
    generateText: jest.fn(),
    supportsNativeWebSearch: () => false
};
jest.mock('@goobster/core/services/aiService', () => mockAi);

// Persona turns offer tools from the real registry; these wrapped commands
// boot heavy voice/music services at load time (parlorService.test.js
// pattern).

const db = require('@goobster/core/db');
const parlorService = require('@goobster/core/services/parlorService');
const { ParlorLiveService } = require('@goobster/core/services/parlorLiveService');
const { createWebAppContext, createWebAppApp, attachWebAppWebSocket } = require('@goobster/bot/web/appApi');
const webSessionService = require('@goobster/core/services/webSessionService');

const OWNER = '400000000000000001';
const FRIEND = '400000000000000002';
const STRANGER = '400000000000000003';

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

/** Fake ElevenLabs TTS service (resolveVoice + streaming synthesis). */
let ttsStreams;
const fakeTts = {
    apiKey: 'xi-test-key',
    modelId: 'eleven_flash_v2_5',
    listVoices: jest.fn(async () => [
        { id: 'voiceAAA1111111111', name: 'Aria', category: 'premade' },
        { id: 'voiceBBB2222222222', name: 'Baxter', category: 'premade' }
    ]),
    resolveVoice: jest.fn(async (query) => {
        if (query === 'Aria' || query === 'voiceAAA1111111111') {
            return { id: 'voiceAAA1111111111', name: 'Aria' };
        }
        throw new Error(`ElevenLabs voice "${query}" not found in your voice library.`);
    }),
    fetchStream: jest.fn(async () => {
        const body = Readable.from([Buffer.from('MP3-one'), Buffer.from('MP3-two')]);
        ttsStreams.push(body);
        return { body };
    })
};

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
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/app/parlor/live`, { headers });
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

/** Join a live session and wait for the ack. */
async function joinLive({ userId, userName, conversationId }) {
    const { token } = await webSessionService.create({ userId, userName });
    const client = new LiveClient({ token });
    await client.open();
    client.send({ type: 'join', conversationId });
    await client.waitFor(m => m.type === 'joined' || m.type === 'error');
    return client;
}

/* ---------- fixtures ---------- */

async function makePersona(overrides = {}) {
    return await parlorService.createPersona({
        ownerId: OWNER,
        name: 'The Researcher',
        emoji: '🔬',
        charter: 'You are a careful researcher.',
        ...overrides
    });
}

async function makeConversation(personaIds) {
    return await parlorService.createConversation({ ownerId: OWNER, personaIds });
}

/* ---------- lifecycle ---------- */

beforeAll((done) => {
    liveService = new ParlorLiveService({
        parlor: parlorService,
        tts: () => fakeTts,
        elevenLabsKey: () => 'xi-test-key',
        createScribe: (opts) => new FakeScribe(opts),
        webVoice: fakeWebVoice,
        usageTracker: fakeUsage,
        logger: silentLogger
    });
    // Routes resolve persona voices through the live TTS stack; pin the
    // fake so the spec never depends on real keys in the environment.
    const parlorForRoutes = Object.create(parlorService);
    parlorForRoutes.setPersonaVoice = async (params) =>
        await parlorService.setPersonaVoice({ ...params, tts: fakeTts });
    const ctx = createWebAppContext({
        client: null,
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: silentLogger,
        deps: { parlor: parlorForRoutes, parlorLive: liveService }
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
    liveService.stopAll();
    await new Promise(resolve => server.close(resolve));
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(async () => {
    for (const table of ['parlor_messages', 'parlor_participants', 'parlor_members',
        'parlor_invites', 'parlor_conversations',
        'parlor_note_tags', 'parlor_tags', 'parlor_notes', 'parlor_personas',
        'web_sessions', 'usage_log']) {
        await db.run(`DELETE FROM ${table}`);
    }
    liveService.stopAll();
    liveService._recentJoins.clear();
    parlorService._recentTurns.clear();
    parlorService._activeTurns.clear();
    scribeBehavior = { commitText: 'Hello there personas', failConnect: false, failCommit: false, partialOnAudio: null };
    fakeScribes = [];
    ttsStreams = [];
    jest.clearAllMocks();
    mockAi.generateText.mockResolvedValue('{"notes": []}');
    mockAi.chat.mockResolvedValue({ content: 'A considered spoken reply.', toolCalls: [] });
    fakeWebVoice.transcribe.mockResolvedValue({ text: 'fallback transcript words' });
});

/* ---------- persona voices ---------- */

describe('persona voices (setPersonaVoice)', () => {
    test('resolves the voice at save time and stores id + display name', async () => {
        const persona = await makePersona();
        const updated = await parlorService.setPersonaVoice({
            ownerId: OWNER, personaId: persona.id, voice: 'Aria', tts: fakeTts
        });
        expect(updated.voiceId).toBe('voiceAAA1111111111');
        expect(updated.voiceName).toBe('Aria');
        expect((await parlorService.listPersonas(OWNER))[0].voiceId).toBe('voiceAAA1111111111');
    });

    test('an unresolvable voice fails at edit time with BAD_VOICE', async () => {
        const persona = await makePersona();
        await expect(parlorService.setPersonaVoice({
            ownerId: OWNER, personaId: persona.id, voice: 'Nonexistent', tts: fakeTts
        })).rejects.toMatchObject({ status: 400, code: 'BAD_VOICE' });
    });

    test('an empty voice clears back to the default', async () => {
        const persona = await makePersona();
        await parlorService.setPersonaVoice({ ownerId: OWNER, personaId: persona.id, voice: 'Aria', tts: fakeTts });
        const cleared = await parlorService.setPersonaVoice({
            ownerId: OWNER, personaId: persona.id, voice: '', tts: fakeTts
        });
        expect(cleared.voiceId).toBeNull();
        expect(cleared.voiceName).toBeNull();
        // Clearing never needs the TTS service at all
        await parlorService.setPersonaVoice({ ownerId: OWNER, personaId: persona.id, voice: null, tts: null });
    });

    test('another user cannot set my persona voice', async () => {
        const persona = await makePersona();
        await expect(parlorService.setPersonaVoice({
            ownerId: STRANGER, personaId: persona.id, voice: 'Aria', tts: fakeTts
        })).rejects.toMatchObject({ code: 'NO_SUCH_PERSONA' });
    });
});

describe('capabilities and voices', () => {
    test('capabilities reflect the ElevenLabs key', () => {
        expect(liveService.capabilities()).toEqual({ live: true });
        const keyless = new ParlorLiveService({ elevenLabsKey: () => null, tts: () => null });
        expect(keyless.capabilities()).toEqual({ live: false });
    });

    test('listVoices proxies the TTS service and degrades to 503 without one', async () => {
        await expect(liveService.listVoices()).resolves.toHaveLength(2);
        const keyless = new ParlorLiveService({ elevenLabsKey: () => null, tts: () => null });
        await expect(keyless.listVoices()).rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' });
    });
});

/* ---------- HTTP routes ---------- */

describe('the parlor voice routes', () => {
    const http = require('node:http');

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
                    resolve({ status: res.statusCode, json });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    async function cookieFor(userId) {
        const { token } = await webSessionService.create({ userId, userName: 'tester' });
        return `goobster_web_session=${token}`;
    }

    test('live capabilities and the voice library require a session', async () => {
        expect((await request({ reqPath: '/api/app/parlor/live/capabilities' })).status).toBe(401);
        expect((await request({ reqPath: '/api/app/parlor/voices' })).status).toBe(401);
    });

    test('live capabilities and voices answer for a signed-in user', async () => {
        const cookie = await cookieFor(OWNER);
        const caps = await request({ reqPath: '/api/app/parlor/live/capabilities', headers: { cookie } });
        expect(caps.json).toEqual({ live: true });
        const voices = await request({ reqPath: '/api/app/parlor/voices', headers: { cookie } });
        expect(voices.json.voices.map(v => v.name)).toEqual(['Aria', 'Baxter']);
    });

    test('PUT /personas/:id/voice resolves and stores; bad names 400', async () => {
        const persona = await makePersona();
        const cookie = await cookieFor(OWNER);
        const saved = await request({
            method: 'PUT',
            reqPath: `/api/app/parlor/personas/${persona.id}/voice`,
            headers: { cookie },
            body: { voice: 'Aria' }
        });
        expect(saved.status).toBe(200);
        expect(saved.json.voiceId).toBe('voiceAAA1111111111');
        expect(saved.json.voiceName).toBe('Aria');

        const bad = await request({
            method: 'PUT',
            reqPath: `/api/app/parlor/personas/${persona.id}/voice`,
            headers: { cookie },
            body: { voice: 'Nonexistent' }
        });
        expect(bad.status).toBe(400);
        expect(bad.json.error.code).toBe('BAD_VOICE');

        const cleared = await request({
            method: 'PUT',
            reqPath: `/api/app/parlor/personas/${persona.id}/voice`,
            headers: { cookie },
            body: { voice: '' }
        });
        expect(cleared.status).toBe(200);
        expect(cleared.json.voiceId).toBeNull();
    });
});

/* ---------- WebSocket auth ---------- */

describe('live WebSocket auth', () => {
    test('upgrades without a session cookie are rejected', async () => {
        const client = new LiveClient({});
        await expect(client.open()).rejects.toThrow(/401/);
    });

    test('cross-origin upgrades are rejected', async () => {
        const { token } = await webSessionService.create({ userId: OWNER, userName: 'rob' });
        const client = new LiveClient({ token, origin: 'https://evil.example' });
        await expect(client.open()).rejects.toThrow(/403/);
    });

    test('same-origin upgrades with a valid cookie connect', async () => {
        const { token } = await webSessionService.create({ userId: OWNER, userName: 'rob' });
        const client = new LiveClient({ token, origin: `http://127.0.0.1:${port}` });
        await expect(client.open()).resolves.toBeUndefined();
        client.close();
    });

    test('joining requires discussion access (strangers see a 404-shaped error)', async () => {
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: STRANGER, userName: 'sneaky', conversationId: conversation.id });
        const error = await client.waitFor('error');
        expect(error.code).toBe('NO_SUCH_CONVERSATION');
        client.close();
    });

    test('owner and member join; listeners are announced', async () => {
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        await db.run(
            `INSERT INTO parlor_members (conversationId, userId, userName, invitedBy)
             VALUES (@c, @u, 'friend', @o)`,
            { c: conversation.id, u: FRIEND, o: OWNER }
        );

        const owner = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        const joined = await owner.waitFor('joined');
        expect(joined.role).toBe('owner');
        expect(joined.listeners).toEqual([{ userId: OWNER, userName: 'rob' }]);

        const friend = await joinLive({ userId: FRIEND, userName: 'friend', conversationId: conversation.id });
        expect((await friend.waitFor('joined')).role).toBe('member');
        const announced = await owner.waitFor('listener_join');
        expect(announced.userId).toBe(FRIEND);

        owner.close();
        friend.close();
    });
});

/* ---------- the live voice pipeline ---------- */

describe('the live voice pipeline', () => {
    test('speech -> realtime STT -> parlor turn -> per-persona speech fan-out', async () => {
        const persona = await makePersona();
        await parlorService.setPersonaVoice({ ownerId: OWNER, personaId: persona.id, voice: 'Aria', tts: fakeTts });
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'audio', data: loudChunk() });
        client.send({ type: 'audio', data: loudChunk() });
        client.send({ type: 'utterance-end' });

        // The committed transcript becomes a NORMAL parlor turn
        const utterance = await client.waitFor('utterance');
        expect(utterance.text).toBe('Hello there personas');
        const userMessage = await client.waitFor('user_message');
        expect(userMessage.content).toBe('Hello there personas');
        expect(userMessage.userId).toBe(OWNER);

        const personaMessage = await client.waitFor('persona_message');
        expect(personaMessage.personaId).toBe(persona.id);
        expect(personaMessage.content).toBe('A considered spoken reply.');

        // Persona speech streams down tagged with the persona, in their voice
        const speechStart = await client.waitFor('speech_start');
        expect(speechStart.personaId).toBe(persona.id);
        expect(speechStart.personaName).toBe('The Researcher');
        await client.waitFor('speech_end');
        const chunks = client.ofType('speech_chunk');
        expect(Buffer.from(chunks[0].data, 'base64').toString()).toBe('MP3-one');
        expect(fakeTts.fetchStream).toHaveBeenCalledWith(
            'A considered spoken reply.', { voiceId: 'voiceAAA1111111111' });

        await client.waitFor('turn_done');

        // The realtime STT got the audio (energy gate crossed) and closed
        expect(fakeScribes).toHaveLength(1);
        expect(fakeScribes[0].sent.length).toBeGreaterThanOrEqual(2);
        expect(fakeScribes[0].closed).toBe(true);
        // STT keyterms carry the cast's names
        expect(fakeScribes[0].opts.keyterms).toContain('The Researcher');

        // Rows landed in the normal transcript tables
        const rows = await db.all('SELECT role, content FROM parlor_messages WHERE conversationId = @c ORDER BY id', { c: conversation.id });
        expect(rows.map(r => r.role)).toEqual(['user', 'persona']);

        // Usage attributed to the owner's DM scope (the host pays)
        expect(fakeUsage.log).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'transcription-realtime', guildId: `dm:${OWNER}`, userId: OWNER
        }));
        expect(fakeUsage.log).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'tts-live', guildId: `dm:${OWNER}`, userId: OWNER
        }));
        client.close();
    });

    test('open-mic noise never opens an STT connection', async () => {
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'audio', data: quietChunk() });
        client.send({ type: 'audio', data: quietChunk() });
        client.send({ type: 'utterance-end' });

        await client.waitFor('utterance_empty');
        expect(fakeScribes).toHaveLength(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM parlor_messages')).c).toBe(0);
        client.close();
    });

    test('a wordless transcript never becomes a turn', async () => {
        scribeBehavior.commitText = '   ';
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'audio', data: loudChunk() });
        client.send({ type: 'utterance-end' });
        await client.waitFor('utterance_empty');
        expect((await db.get('SELECT COUNT(*) AS c FROM parlor_messages')).c).toBe(0);
        client.close();
    });

    test('realtime STT failure falls back to per-utterance batch STT', async () => {
        scribeBehavior.failCommit = true;
        scribeBehavior.commitText = null;
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'audio', data: loudChunk() });
        client.send({ type: 'utterance-end' });

        const utterance = await client.waitFor('utterance');
        expect(utterance.text).toBe('fallback transcript words');
        // The fallback got a WAV of the buffered PCM
        const call = fakeWebVoice.transcribe.mock.calls[0][0];
        expect(call.mimeType).toBe('audio/wav');
        expect(Buffer.from(call.audioBase64, 'base64').subarray(0, 4).toString()).toBe('RIFF');
        await client.waitFor('turn_done');
        client.close();
    });

    test('typed "say" messages run as voiced turns too', async () => {
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'say', text: 'Typed but still spoken back' });
        const userMessage = await client.waitFor('user_message');
        expect(userMessage.content).toBe('Typed but still spoken back');
        await client.waitFor('speech_end');
        await client.waitFor('turn_done');
        client.close();
    });

    test('nudge runs one persona with no new user message', async () => {
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'nudge', personaId: persona.id });
        const personaMessage = await client.waitFor('persona_message');
        expect(personaMessage.personaId).toBe(persona.id);
        await client.waitFor('turn_done');
        expect(client.ofType('user_message')).toHaveLength(0);
        client.close();
    });

    test('utterances queue while a turn is running (the turn lock arbitrates)', async () => {
        // Slow generation so the second utterance lands mid-turn
        let releaseFirst;
        mockAi.chat.mockImplementationOnce(() => new Promise(resolve => {
            releaseFirst = () => resolve({ content: 'First reply.', toolCalls: [] });
        }));
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'say', text: 'First utterance' });
        await client.waitFor(m => m.type === 'persona_start');
        client.send({ type: 'say', text: 'Second utterance' });
        const queued = await client.waitFor(m => m.type === 'utterance' && m.text === 'Second utterance');
        expect(queued.queued).toBe(true);

        releaseFirst();
        await client.waitFor(m => m.type === 'user_message' && m.content === 'Second utterance');
        await client.waitFor(m => client.ofType('turn_done').length >= 2);
        const rows = await db.all('SELECT role, content FROM parlor_messages ORDER BY id');
        expect(rows.filter(r => r.role === 'user').map(r => r.content))
            .toEqual(['First utterance', 'Second utterance']);
        client.close();
    });

    test('solo barge-in: real words abort the in-flight speech', async () => {
        // A speech stream that never ends on its own
        const endless = new PassThrough();
        fakeTts.fetchStream.mockImplementationOnce(async () => {
            endless.write(Buffer.from('MP3-endless'));
            return { body: endless };
        });
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'say', text: 'Talk to me' });
        await client.waitFor('speech_chunk');

        // The user starts talking; the STT hears actual words
        scribeBehavior.partialOnAudio = 'wait stop';
        client.send({ type: 'audio', data: loudChunk() });

        const end = await client.waitFor(m => m.type === 'speech_end' && m.interrupted === true);
        expect(end.interrupted).toBe(true);
        expect(endless.destroyed).toBe(true);
        client.close();
    });

    test('validation: empty say, bad nudge, oversized audio', async () => {
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'say', text: '   ' });
        expect((await client.waitFor('error')).code).toBe('EMPTY_MESSAGE');
        client.send({ type: 'nudge', personaId: 'nope' });
        await client.waitFor(m => m.type === 'error' && m.code === 'BAD_PERSONA');
        client.send({ type: 'audio', data: 'a'.repeat(300 * 1024) });
        await client.waitFor(m => m.type === 'error' && m.code === 'BAD_AUDIO');
        client.close();
    });

    test('a second live connection for the same user replaces the first', async () => {
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const first = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await first.waitFor('joined');
        const second = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await second.waitFor('joined');
        await first.waitFor('session_replaced');
        first.close();
        second.close();
    });

    test('personas without a configured voice get a stable default from the pool', async () => {
        const persona = await makePersona(); // no voiceId
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        client.send({ type: 'say', text: 'Speak up' });
        await client.waitFor('speech_end');
        const [, opts] = fakeTts.fetchStream.mock.calls[0];
        expect(typeof opts.voiceId).toBe('string');
        expect(opts.voiceId.length).toBeGreaterThan(10);
        expect(opts.voiceId).toBe(liveService._defaultVoiceFor(persona.id));
        client.close();
    });
});

/* ---------- the SSE observe tap ---------- */

describe('observeTurn (SSE turns reach the live session)', () => {
    test('events for a conversation with a live session broadcast and voice', async () => {
        const persona = await makePersona();
        const conversation = await makeConversation([persona.id]);
        const client = await joinLive({ userId: OWNER, userName: 'rob', conversationId: conversation.id });
        await client.waitFor('joined');

        liveService.observeTurn(conversation.id, 'persona_start', {
            id: persona.id, name: persona.name, voiceId: null
        });
        liveService.observeTurn(conversation.id, 'delta', { text: 'Hel' });
        liveService.observeTurn(conversation.id, 'persona_message', {
            id: 99, personaId: persona.id, personaName: persona.name,
            content: 'Observed reply.', isError: false
        });
        liveService.observeTurn(conversation.id, 'done', { ok: true });

        await client.waitFor(m => m.type === 'delta' && m.text === 'Hel');
        await client.waitFor(m => m.type === 'persona_message' && m.content === 'Observed reply.');
        await client.waitFor('speech_end');
        await client.waitFor('turn_done');
        expect(fakeTts.fetchStream).toHaveBeenCalledWith('Observed reply.', expect.any(Object));
        client.close();
    });

    test('events for conversations without a session are ignored quietly', () => {
        expect(() => liveService.observeTurn(424242, 'delta', { text: 'x' })).not.toThrow();
    });
});
