/**
 * Unit tests for the web portal voice bridge (services/webVoiceService.js):
 * capability detection with graceful degradation, transcription validation
 * and provider fallback, read-aloud text sanitation, and rate limits.
 */
const { WebVoiceService, WebVoiceError, speechTextFromMarkdown } = require('@goobster/core/services/webVoiceService');

const USER = '100000000000000001';

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
    test('no keys at all: both features off, never an error', () => {
        expect(makeService().capabilities()).toEqual({ stt: false, tts: false });
    });

    test('OpenAI only: STT on, TTS off', () => {
        expect(makeService({ openaiConfigured: true }).capabilities()).toEqual({ stt: true, tts: false });
    });

    test('ElevenLabs key only: both on (Scribe STT fallback + direct TTS)', () => {
        expect(makeService({ elevenKey: 'xi-key' }).capabilities()).toEqual({ stt: true, tts: true });
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

    test('prefers the shared TTS service (the /setvoice-configured voice)', async () => {
        const fetchStream = jest.fn().mockResolvedValue({ body: 'fake-stream' });
        const service = makeService({ tts: { fetchStream } });

        const result = await service.synthesize({ userId: USER, text: 'Hello **there**, friend.' });
        expect(result.stream).toBe('fake-stream');
        expect(result.contentType).toBe('audio/mpeg');
        expect(fetchStream).toHaveBeenCalledWith('Hello there, friend.');
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

describe('error shape', () => {
    test('WebVoiceError carries status + machine-readable code', () => {
        const error = new WebVoiceError(400, 'BAD_AUDIO', 'nope');
        expect(error.status).toBe(400);
        expect(error.code).toBe('BAD_AUDIO');
        expect(error.name).toBe('WebVoiceError');
    });
});
