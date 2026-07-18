/**
 * Multi-context TTS client (services/voice/multiContextTTSService.js)
 * against a local WebSocket server speaking the ElevenLabs multi-stream
 * protocol: context initialization, incremental text, flush/finish,
 * barge-in (close_context), and socket shutdown.
 */
const { WebSocketServer } = require('ws');
const { MultiContextTTSService } = require('../services/voice/multiContextTTSService');

let server;
let port;
let received;
let serverSocket;

function startServer() {
    // Bind this server's messages to the array current at creation time so
    // late messages from a previous test's socket can't pollute a new test.
    const bucket = received;
    return new Promise((resolve) => {
        server = new WebSocketServer({ port: 0 }, () => {
            port = server.address().port;
            resolve();
        });
        server.on('connection', (ws) => {
            serverSocket = ws;
            ws.on('message', (raw) => bucket.push(JSON.parse(raw.toString())));
        });
    });
}

function makeService() {
    return new MultiContextTTSService({
        apiKey: 'test-key',
        voiceId: 'voiceABC123',
        baseUrl: `ws://127.0.0.1:${port}`
    });
}

/** Discord voice connection stand-in. */
function fakeConnection() {
    return { subscribe: jest.fn() };
}

const waitFor = (fn, ms = 1500) => new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
        if (fn()) return resolve();
        if (Date.now() - start > ms) return reject(new Error('waitFor timed out'));
        setTimeout(poll, 10);
    };
    poll();
});

beforeEach(async () => {
    received = [];
    serverSocket = null;
    await startServer();
});

afterEach(() => {
    for (const client of server?.clients ?? []) client.terminate();
    server?.close();
});

describe('MultiContextTTSService', () => {
    test('connect() resolves and reports isConnected', async () => {
        const tts = makeService();
        await tts.connect();
        expect(tts.isConnected()).toBe(true);
        tts.destroy();
        expect(tts.isConnected()).toBe(false);
    });

    test('speak() initializes a context and streams text deltas', async () => {
        const tts = makeService();
        await tts.connect();

        const handle = tts.speak(fakeConnection());
        handle.appendText('Hello ');
        handle.appendText('world.');
        await waitFor(() => received.length >= 3);

        // Context init: single-space text, voice settings, chunk schedule
        expect(received[0]).toMatchObject({
            text: ' ',
            context_id: handle.contextId,
            voice_settings: expect.objectContaining({ stability: expect.any(Number) }),
            generation_config: expect.objectContaining({ chunk_length_schedule: expect.any(Array) })
        });
        expect(received[1]).toEqual({ text: 'Hello ', context_id: handle.contextId });
        expect(received[2]).toEqual({ text: 'world.', context_id: handle.contextId });

        tts.destroy();
    });

    test('finish() flushes, waits for isFinal, then closes the context', async () => {
        const tts = makeService();
        await tts.connect();

        const handle = tts.speak(fakeConnection());
        handle.appendText('Short reply.');

        const finishPromise = handle.finish();
        await waitFor(() => received.some(m => m.flush === true));

        // No audio was sent, so playback never started; isFinal resolves finish
        serverSocket.send(JSON.stringify({ contextId: handle.contextId, isFinal: true }));
        await finishPromise;

        await waitFor(() => received.some(m => m.close_context === true));
        expect(received.at(-1)).toMatchObject({
            context_id: handle.contextId,
            close_context: true
        });
        expect(tts.contexts.size).toBe(0);
        tts.destroy();
    });

    test('abort() closes the context server-side immediately (barge-in)', async () => {
        const tts = makeService();
        await tts.connect();

        const handle = tts.speak(fakeConnection());
        handle.appendText('A long reply that will be interrupted');
        handle.abort();

        await waitFor(() => received.some(m => m.close_context === true));
        expect(tts.contexts.size).toBe(0);
        tts.destroy();
    });

    test('each reply gets a fresh context id', async () => {
        const tts = makeService();
        await tts.connect();
        const first = tts.speak(fakeConnection());
        first.abort();
        const second = tts.speak(fakeConnection());
        expect(second.contextId).not.toBe(first.contextId);
        second.abort();
        tts.destroy();
    });

    test('destroy() sends close_socket', async () => {
        const tts = makeService();
        await tts.connect();
        tts.destroy();
        await waitFor(() => received.some(m => m.close_socket === true));
    });

    test('audio chunks are routed to the owning context', async () => {
        const tts = makeService();
        await tts.connect();
        const handle = tts.speak(fakeConnection());

        const ctx = tts.contexts.get(handle.contextId);
        const written = [];
        ctx.mp3Stream.write = (buf) => { written.push(buf); return true; };

        const audio = Buffer.from('fake-mp3-bytes').toString('base64');
        serverSocket.send(JSON.stringify({ contextId: handle.contextId, audio }));
        // Audio for unknown contexts is ignored
        serverSocket.send(JSON.stringify({ contextId: 'other', audio }));
        await waitFor(() => written.length === 1);

        expect(written[0].toString()).toBe('fake-mp3-bytes');
        tts.destroy();
    });
});
