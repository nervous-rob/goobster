/**
 * Realtime STT client (services/voice/scribeRealtimeService.js) against a
 * local WebSocket server speaking the ElevenLabs Scribe v2 Realtime
 * protocol: session_started handshake, input_audio_chunk streaming,
 * partial/committed transcripts, and error handling.
 */
const { WebSocketServer } = require('ws');
const { ScribeRealtimeConnection } = require('../services/voice/scribeRealtimeService');

let server;
let port;
let received;
let serverSocket;

function startServer({ autoStart = true } = {}) {
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
            if (autoStart) {
                ws.send(JSON.stringify({
                    message_type: 'session_started',
                    session_id: 'test-session',
                    config: { sample_rate: 16000 }
                }));
            }
            ws.on('message', (raw) => bucket.push(JSON.parse(raw.toString())));
        });
    });
}

/** Connection whose URL points at the local test server. */
function makeConnection() {
    return new ScribeRealtimeConnection({
        apiKey: 'test-key',
        keyterms: ['goobster'],
        baseUrl: `ws://127.0.0.1:${port}`
    });
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

describe('ScribeRealtimeConnection', () => {
    test('streams audio chunks with the documented message shape', async () => {
        const conn = makeConnection();
        await conn.connect();
        expect(conn.ready).toBe(true);

        const pcm = Buffer.from([1, 2, 3, 4]);
        conn.sendAudio(pcm);
        await waitFor(() => received.length >= 1);

        expect(received[0]).toEqual({
            message_type: 'input_audio_chunk',
            audio_base_64: pcm.toString('base64'),
            commit: false,
            sample_rate: 16000
        });
        conn.close();
    });

    test('emits partials and resolves commit() with the committed transcript', async () => {
        const conn = makeConnection();
        await conn.connect();

        const partials = [];
        conn.on('partial', (text) => partials.push(text));

        serverSocket.send(JSON.stringify({ message_type: 'partial_transcript', text: 'hello' }));
        serverSocket.send(JSON.stringify({ message_type: 'partial_transcript', text: 'hello there' }));
        await waitFor(() => partials.length === 2);

        // The server answers the commit with the final transcript
        const commitPromise = conn.commit();
        await waitFor(() => received.some(m => m.commit === true));
        serverSocket.send(JSON.stringify({ message_type: 'committed_transcript', text: 'Hello there!' }));

        await expect(commitPromise).resolves.toBe('Hello there!');
        conn.close();
    });

    test('commit() falls back to the last partial when the connection drops', async () => {
        const conn = makeConnection();
        await conn.connect();

        serverSocket.send(JSON.stringify({ message_type: 'partial_transcript', text: 'partial only' }));
        await waitFor(() => conn.partialText === 'partial only');

        const commitPromise = conn.commit();
        serverSocket.close(); // server hangs up without committing
        await expect(commitPromise).resolves.toBe('partial only');
    });

    test('insufficient_audio_activity closes quietly without an error event', async () => {
        const conn = makeConnection();
        await conn.connect();
        const errors = [];
        conn.on('error', (e) => errors.push(e));

        serverSocket.send(JSON.stringify({ message_type: 'insufficient_audio_activity', error: 'quiet stream' }));
        await new Promise(r => setTimeout(r, 50));
        expect(errors).toHaveLength(0);
        conn.close();
    });

    test('real errors are surfaced as error events', async () => {
        const conn = makeConnection();
        await conn.connect();
        const errors = [];
        conn.on('error', (e) => errors.push(e));

        serverSocket.send(JSON.stringify({ message_type: 'quota_exceeded', error: 'out of credits' }));
        await waitFor(() => errors.length === 1);
        expect(errors[0].message).toContain('quota_exceeded');
        expect(errors[0].messageType).toBe('quota_exceeded');
        conn.close();
    });

    test('sendAudio before ready does not throw and after close is a no-op', async () => {
        const conn = makeConnection();
        const connectPromise = conn.connect();
        expect(() => conn.sendAudio(Buffer.from([1, 2]))).not.toThrow();
        await connectPromise;
        conn.close();
        expect(() => conn.sendAudio(Buffer.from([3, 4]))).not.toThrow();
    });
});
