/**
 * Unit tests for the web portal voice bridge (services/webVoiceService.js):
 * capability detection with graceful degradation, transcription validation
 * and provider fallback, read-aloud text sanitation, and rate limits.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-webvoice-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { WebVoiceService, WebVoiceError, speechTextFromMarkdown } = require('@goobster/core/services/webVoiceService');

const USER = '100000000000000001';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM web_rate_events');
});

function makeService({ openaiConfigured = false, elevenKey = null, tts = null, fetchImpl = null, transcribe = null } = {}) {
    return new WebVoiceService({
        transcription: {
            isConfigured: () => openaiConfigured,
            transcribe: transcribe || jest.fn().mockResolvedValue('hello world')
        },
        ttsService: () => tts,
        elevenLabsKey: () => elevenKey,
        fetch: fetchImpl || jest.fn()
    });
}

const WEBM_BASE64 = Buffer.from('fake webm audio bytes').toString('base64');

describe('capabilities', () => {
    test('no keys at all: all features off, never an error', () => {
        expect(makeService().capabilities()).toEqual({ stt: false, tts: false, live: false });
    });

    test('OpenAI only: STT on, TTS and live off', () => {
        expect(makeService({ openaiConfigured: true }).capabilities())
            .toEqual({ stt: true, tts: false, live: false });
    });

    test('ElevenLabs key only: everything on (Scribe STT fallback + direct TTS + live)', () => {
        expect(makeService({ elevenKey: 'xi-key' }).capabilities())
            .toEqual({ stt: true, tts: true, live: true });
    });

    test('shared TTS service present: TTS on even without a key lookup', () => {
        expect(makeService({ tts: { fetchStream: jest.fn() } }).capabilities().tts).toBe(true);
    });
});

describe('transcribe', () => {
    test('rejects unsupported mime types', async () => {
        const service = makeService({ openaiConfigured: true });
        await expect(service.transcribe({ userId: USER, audioBase64: WEBM_BASE64, mimeType: 'video/mp4' }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_AUDIO' });
    });

    test('rejects missing/empty/oversized audio', async () => {
        const service = makeService({ openaiConfigured: true });
        await expect(service.transcribe({ userId: USER, audioBase64: '', mimeType: 'audio/webm' }))
            .rejects.toMatchObject({ code: 'BAD_AUDIO' });
        await expect(service.transcribe({ userId: USER, audioBase64: 42, mimeType: 'audio/webm' }))
            .rejects.toMatchObject({ code: 'BAD_AUDIO' });
        await expect(service.transcribe({
            userId: USER, audioBase64: 'a'.repeat(16 * 1024 * 1024 + 1), mimeType: 'audio/webm'
        })).rejects.toMatchObject({ code: 'BAD_AUDIO' });
    });

    test('prefers OpenAI transcription and passes the clip format through', async () => {
        const transcribe = jest.fn().mockResolvedValue('  dictated text  '.trim());
        const service = makeService({ openaiConfigured: true, transcribe });

        const result = await service.transcribe({
            userId: USER, audioBase64: WEBM_BASE64, mimeType: 'audio/webm;codecs=opus'
        });
        expect(result.text).toBe('dictated text');
        const [buffer, options] = transcribe.mock.calls[0];
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(buffer.toString()).toBe('fake webm audio bytes');
        expect(options.mimeType).toBe('audio/webm'); // codec suffix stripped
        expect(options.filename).toBe('clip.webm');
        expect(options.usageContext).toEqual({ guildId: null, userId: USER });
    });

    test('falls back to ElevenLabs Scribe when OpenAI is unconfigured', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ text: ' scribe transcript ' })
        });
        const service = makeService({ elevenKey: 'xi-key', fetchImpl });

        const result = await service.transcribe({ userId: USER, audioBase64: WEBM_BASE64, mimeType: 'audio/webm' });
        expect(result.text).toBe('scribe transcript');

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toContain('speech-to-text');
        expect(init.headers['xi-api-key']).toBe('xi-key');
        const body = init.body.toString('latin1');
        expect(body).toContain('name="model_id"');
        expect(body).toContain('scribe_v1');
        expect(body).toContain('filename="clip.webm"');
        expect(body).toContain('fake webm audio bytes');
    });

    test('a failing ElevenLabs call surfaces as 502 STT_FAILED', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
        const service = makeService({ elevenKey: 'xi-key', fetchImpl });
        await expect(service.transcribe({ userId: USER, audioBase64: WEBM_BASE64, mimeType: 'audio/webm' }))
            .rejects.toMatchObject({ status: 502, code: 'STT_FAILED' });
    });

    test('no provider at all: 503 STT_UNAVAILABLE (graceful degradation)', async () => {
        const service = makeService();
        await expect(service.transcribe({ userId: USER, audioBase64: WEBM_BASE64, mimeType: 'audio/webm' }))
            .rejects.toMatchObject({ status: 503, code: 'STT_UNAVAILABLE' });
    });

    test('rate limits after 10 transcriptions in a minute', async () => {
        const service = makeService({ openaiConfigured: true });
        for (let i = 0; i < 10; i++) {
            await service.transcribe({ userId: USER, audioBase64: WEBM_BASE64, mimeType: 'audio/webm' });
        }
        await expect(service.transcribe({ userId: USER, audioBase64: WEBM_BASE64, mimeType: 'audio/webm' }))
            .rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    });
});

describe('speechTextFromMarkdown', () => {
    test('drops code blocks, math, and URLs but keeps prose', () => {
        const text = speechTextFromMarkdown([
            '# The answer',
            'Here is **bold** and `inline code` and a [link](https://example.com).',
            '```js\nconst x = 1;\n```',
            'Math: $$\\int_0^1 x dx$$ and more prose. See https://example.com/docs too.'
        ].join('\n'));
        expect(text).toContain('The answer');
        expect(text).toContain('bold');
        expect(text).toContain('inline code');
        expect(text).toContain('link');
        expect(text).toContain('(code omitted)');
        expect(text).toContain('(math omitted)');
        expect(text).not.toContain('const x = 1');
        expect(text).not.toContain('https://');
        expect(text).not.toContain('**');
        expect(text).not.toContain('#');
    });

    test('caps speech length at a sentence boundary', () => {
        const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
        const text = speechTextFromMarkdown(long);
        expect(text.length).toBeLessThanOrEqual(4000);
        expect(text.endsWith('.')).toBe(true);
    });

    test('returns empty for unspeakable content', () => {
        expect(speechTextFromMarkdown('```\ncode only\n```')).toBe('(code omitted)'.trim() ? '(code omitted)' : '');
    });
});

describe('synthesize', () => {
    test('rejects empty and oversized text', async () => {
        const service = makeService({ elevenKey: 'xi-key' });
        await expect(service.synthesize({ userId: USER, text: '   ' }))
            .rejects.toMatchObject({ status: 400, code: 'EMPTY_TEXT' });
        await expect(service.synthesize({ userId: USER, text: 'x'.repeat(20001) }))
            .rejects.toMatchObject({ status: 400, code: 'TEXT_TOO_LONG' });
    });

    test('rejects content with nothing speakable', async () => {
        const service = makeService({ elevenKey: 'xi-key' });
        await expect(service.synthesize({ userId: USER, text: 'https://example.com/only-a-link' }))
            .rejects.toMatchObject({ status: 400, code: 'NOTHING_SPEAKABLE' });
    });

    test('prefers the shared TTS service (default voice when no preference)', async () => {
        const fetchStream = jest.fn().mockResolvedValue({ body: 'fake-stream' });
        const service = makeService({ tts: { fetchStream } });

        const result = await service.synthesize({ userId: USER, text: 'Hello **there**, friend.' });
        expect(result.stream).toBe('fake-stream');
        expect(result.contentType).toBe('audio/mpeg');
        expect(fetchStream).toHaveBeenCalledWith('Hello there, friend.', { voiceId: null });
    });

    test("speaks with the user's saved voice preference", async () => {
        const fetchStream = jest.fn().mockResolvedValue({ body: 'fake-stream' });
        const tts = {
            fetchStream,
            resolveVoice: jest.fn().mockResolvedValue({ id: 'voiceABC123456789012', name: 'Custom Voice' })
        };
        const userId = '100000000000000042';
        const service = makeService({ tts });

        await service.setVoiceSettings({ userId, voiceId: 'Custom Voice' });
        await service.synthesize({ userId, text: 'Say it in my voice.' });
        expect(fetchStream).toHaveBeenCalledWith('Say it in my voice.', { voiceId: 'voiceABC123456789012' });
    });

    test('degrades to a direct ElevenLabs call when the shared service is down', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: true, body: 'direct-stream' });
        const service = makeService({ elevenKey: 'xi-key', fetchImpl });

        const result = await service.synthesize({ userId: USER, text: 'Read this aloud.' });
        expect(result.stream).toBe('direct-stream');
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toContain('text-to-speech');
        expect(JSON.parse(init.body).text).toBe('Read this aloud.');
    });

    test('no TTS anywhere: 503 TTS_UNAVAILABLE', async () => {
        const service = makeService();
        await expect(service.synthesize({ userId: USER, text: 'Read this.' }))
            .rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' });
    });

    test('rate limits after 15 read-alouds in a minute', async () => {
        const service = makeService({ tts: { fetchStream: jest.fn().mockResolvedValue({ body: 's' }) } });
        for (let i = 0; i < 15; i++) {
            await service.synthesize({ userId: USER, text: `Read number ${i}.` });
        }
        await expect(service.synthesize({ userId: USER, text: 'One more.' }))
            .rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    });
});

describe('voice settings', () => {
    const resolveVoice = jest.fn().mockResolvedValue({ id: 'voiceXYZ987654321098', name: 'Resolved Name' });
    const makeWithCatalog = () => makeService({
        tts: { fetchStream: jest.fn(), resolveVoice, listVoices: jest.fn().mockResolvedValue([
            { id: 'voiceXYZ987654321098', name: 'Resolved Name', category: 'premade' }
        ]) }
    });

    test('defaults: no voice, speed 1', async () => {
        const settings = await makeService().getVoiceSettings({ userId: '100000000000000050' });
        expect(settings).toEqual({ voiceId: null, voiceName: null, speed: 1 });
    });

    test('set resolves names at save time and persists id + display name', async () => {
        const userId = '100000000000000051';
        const service = makeWithCatalog();
        const saved = await service.setVoiceSettings({ userId, voiceId: 'resolved name', speed: 1.25 });
        expect(resolveVoice).toHaveBeenCalledWith('resolved name');
        expect(saved).toEqual({ voiceId: 'voiceXYZ987654321098', voiceName: 'Resolved Name', speed: 1.25 });
        // A fresh read comes back identical (persisted, not just echoed)
        expect(await service.getVoiceSettings({ userId })).toEqual(saved);
    });

    test('clearing the voice goes back to defaults, keeping speed', async () => {
        const userId = '100000000000000052';
        const service = makeWithCatalog();
        await service.setVoiceSettings({ userId, voiceId: 'resolved name', speed: 1.5 });
        const cleared = await service.setVoiceSettings({ userId, voiceId: null });
        expect(cleared).toEqual({ voiceId: null, voiceName: null, speed: 1.5 });
    });

    test('rejects out-of-range speeds', async () => {
        const service = makeWithCatalog();
        await expect(service.setVoiceSettings({ userId: '100000000000000053', speed: 3 }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_SPEED' });
        await expect(service.setVoiceSettings({ userId: '100000000000000053', speed: 0.1 }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_SPEED' });
    });

    test('an unresolvable voice fails at save time as BAD_VOICE', async () => {
        const service = makeService({
            tts: { fetchStream: jest.fn(), resolveVoice: jest.fn().mockRejectedValue(new Error('no such voice')) }
        });
        await expect(service.setVoiceSettings({ userId: '100000000000000054', voiceId: 'Nope' }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_VOICE' });
    });

    test('setting a voice with no TTS anywhere: 503 TTS_UNAVAILABLE', async () => {
        await expect(makeService().setVoiceSettings({ userId: '100000000000000055', voiceId: 'Rachel' }))
            .rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' });
    });
});

describe('listVoices', () => {
    test('returns the shared service catalog', async () => {
        const service = makeService({
            tts: { fetchStream: jest.fn(), listVoices: jest.fn().mockResolvedValue([
                { id: 'v1aaaaaaaaaaaaaaaaaa', name: 'Rachel', category: 'premade' }
            ]) }
        });
        expect(await service.listVoices()).toEqual({
            voices: [{ id: 'v1aaaaaaaaaaaaaaaaaa', name: 'Rachel', category: 'premade' }]
        });
    });

    test('no TTS anywhere: 503 TTS_UNAVAILABLE', async () => {
        await expect(makeService().listVoices())
            .rejects.toMatchObject({ status: 503, code: 'TTS_UNAVAILABLE' });
    });
});

describe('error shape', () => {
    test('WebVoiceError carries status + machine-readable code', () => {
        const error = new WebVoiceError(400, 'BAD_AUDIO', 'nope');
        expect(error.status).toBe(400);
        expect(error.code).toBe('BAD_AUDIO');
        expect(error.name).toBe('WebVoiceError');
    });
});
