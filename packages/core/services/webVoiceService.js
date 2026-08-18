/**
 * Web portal voice bridge: microphone speech-to-text for the composer and
 * read-aloud text-to-speech for replies.
 *
 * Reuses the bot's existing voice stack instead of growing a parallel one:
 *  - STT prefers OpenAI batch transcription (services/transcriptionService,
 *    the same service classic /voicechat uses), falling back to ElevenLabs
 *    Scribe batch transcription when only an ElevenLabs key is configured.
 *  - TTS reuses the live ElevenLabs TTS service (serviceManager.voiceService
 *    .tts) so the web voice matches the /setvoice-configured Discord voice;
 *    when the shared service is unavailable it degrades to a direct
 *    ElevenLabs call with the same config resolution.
 *
 * Everything degrades gracefully: no keys means capabilities() reports both
 * features off and the client hides the buttons - never an error. Nothing
 * here persists state (audio is transcoded and forgotten), so there is no
 * new /forget-me surface; OpenAI transcriptions are usage-logged like every
 * other AI call.
 */

const fetch = require('node-fetch');
const crypto = require('node:crypto');
const { stripUrlsForSpeech } = require('./voice/speechText');

// Browser MediaRecorder output formats (Chrome/Firefox webm+opus, Safari
// mp4/aac) plus plain wave/ogg for exotic clients.
const AUDIO_MIME_ALLOWLIST = new Map([
    ['audio/webm', 'clip.webm'],
    ['audio/ogg', 'clip.ogg'],
    ['audio/mp4', 'clip.mp4'],
    ['audio/mpeg', 'clip.mp3'],
    ['audio/wav', 'clip.wav'],
    ['audio/x-wav', 'clip.wav']
]);
// ~12MB of audio (base64 inflates by 4/3) - minutes of opus speech, far
// below OpenAI's 25MB transcription cap.
const MAX_AUDIO_BASE64_CHARS = 16 * 1024 * 1024;
const MAX_TTS_INPUT_CHARS = 20000;   // accept a whole reply...
const MAX_SPEECH_CHARS = 4000;       // ...but only narrate this much of it
const STT_RATE_LIMIT = 10;           // transcriptions per user per minute
const TTS_RATE_LIMIT = 15;           // syntheses per user per minute
const RATE_WINDOW_MS = 60 * 1000;

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVENLABS_STT_MODEL = 'scribe_v1';

/** Machine-readable web app error (the PanelError status+code contract). */
class WebVoiceError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WebVoiceError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Reduce a Markdown reply to something worth speaking: code blocks are
 * announced rather than read character-by-character, markup syntax is
 * dropped, and (per the voice-stack rule) URLs never reach the audio path.
 * @param {string} markdown
 * @returns {string} speakable text ('' when nothing speakable remains)
 */
function speechTextFromMarkdown(markdown) {
    let text = String(markdown || '');
    // Attachment blocks folded into stored user messages
    text = text.replace(/\[Attached file: [^\]\n]{1,120}\]\n````\n[\s\S]*?\n````/g, ' (attached file) ');
    // Fenced code blocks: announce, don't spell out
    text = text.replace(/```[\s\S]*?```/g, ' (code omitted) ');
    // LaTeX display/inline math reads as noise
    text = text.replace(/\$\$[\s\S]*?\$\$/g, ' (math omitted) ');
    text = text.replace(/\\\[[\s\S]*?\\\]/g, ' (math omitted) ');
    text = text.replace(/\\\([\s\S]*?\\\)/g, ' ');
    // Markdown images: keep the alt text
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Inline markup: keep the content, drop the syntax
    text = text.replace(/`([^`\n]+)`/g, '$1');
    text = text.replace(/^#{1,6}\s+/gm, '');
    text = text.replace(/^\s*[-*+]\s+/gm, '');
    text = text.replace(/^\s*>\s?/gm, '');
    text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
    text = text.replace(/(\*|_)([^*_\n]+)\1/g, '$2');
    text = text.replace(/^\s*\|.*\|\s*$/gm, ' ');   // table rows
    text = text.replace(/^[-=_]{3,}\s*$/gm, ' ');   // rules / table separators
    // The voice-stack invariant: spoken text never contains URLs
    text = stripUrlsForSpeech(text);
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_SPEECH_CHARS) {
        const cut = text.slice(0, MAX_SPEECH_CHARS);
        const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
        text = lastStop > MAX_SPEECH_CHARS / 2 ? cut.slice(0, lastStop + 1) : cut;
    }
    return text;
}

class WebVoiceService {
    /**
     * @param {Object} [deps] - injectable for tests:
     *   { transcription, ttsService: () => service|null, elevenLabsKey: () => string|null, fetch }
     */
    constructor(deps = {}) {
        this._deps = deps;
        /** @type {Map<string, number[]>} transient sliding-window rate limits */
        this._recentStt = new Map();
        this._recentTts = new Map();
    }

    _transcription() {
        return this._deps.transcription || require('./transcriptionService');
    }

    _fetch() {
        return this._deps.fetch || fetch;
    }

    /** The live shared ElevenLabs TTS service, when the bot has one. */
    _ttsService() {
        if (this._deps.ttsService) return this._deps.ttsService();
        try {
            // Lazy: serviceManager instantiates the whole voice stack; only
            // touch it when a voice feature is actually used.
            const { voiceService } = require('./serviceManager');
            const tts = voiceService?.tts;
            return tts && !tts.disabled ? tts : null;
        } catch {
            return null;
        }
    }

    _elevenLabsKey() {
        if (this._deps.elevenLabsKey) return this._deps.elevenLabsKey();
        if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
        try {
            return require('../../../config.json').elevenlabs?.apiKey || null;
        } catch {
            return null;
        }
    }

    /**
     * What the browser may offer: mic input and/or read-aloud. Missing keys
     * turn features off - the graceful-degradation contract.
     * @returns {{ stt: boolean, tts: boolean }}
     */
    capabilities() {
        let stt = false;
        try {
            stt = this._transcription().isConfigured();
        } catch { /* unconfigured */ }
        if (!stt) stt = Boolean(this._elevenLabsKey());
        const tts = Boolean(this._ttsService()) || Boolean(this._elevenLabsKey());
        return { stt, tts };
    }

    /** Sliding-window rate limit; throws 429 when exceeded. */
    _checkRateLimit(map, userId, max, what) {
        const now = Date.now();
        const stamps = (map.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
        if (stamps.length >= max) {
            throw new WebVoiceError(429, 'RATE_LIMITED',
                `Slow down - at most ${max} ${what} per minute.`);
        }
        stamps.push(now);
        map.set(userId, stamps);
    }

    /**
     * Transcribe one recorded clip from the browser microphone.
     * @param {Object} params - { userId, audioBase64, mimeType }
     * @returns {Promise<{ text: string }>}
     */
    async transcribe({ userId, audioBase64, mimeType }) {
        const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
        const filename = AUDIO_MIME_ALLOWLIST.get(mime);
        if (!filename) {
            throw new WebVoiceError(400, 'BAD_AUDIO',
                `Unsupported audio type "${mime || 'unknown'}" - record as webm, ogg, mp4, mp3, or wav.`);
        }
        if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
            throw new WebVoiceError(400, 'BAD_AUDIO', 'audio must be a base64 string.');
        }
        if (audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
            throw new WebVoiceError(400, 'BAD_AUDIO', 'The recording is too large - keep clips under a few minutes.');
        }
        let buffer;
        try {
            buffer = Buffer.from(audioBase64, 'base64');
        } catch {
            throw new WebVoiceError(400, 'BAD_AUDIO', 'The audio payload could not be decoded.');
        }
        if (buffer.length === 0) {
            throw new WebVoiceError(400, 'BAD_AUDIO', 'The recording is empty.');
        }

        this._checkRateLimit(this._recentStt, userId, STT_RATE_LIMIT, 'transcriptions');

        const transcription = this._transcription();
        let configured = false;
        try {
            configured = transcription.isConfigured();
        } catch { /* unconfigured */ }

        if (configured) {
            const text = await transcription.transcribe(buffer, {
                filename,
                mimeType: mime,
                prompt: 'A user is dictating a chat message to Goobster through the web portal.',
                usageContext: { guildId: null, userId }
            });
            return { text };
        }

        const elevenKey = this._elevenLabsKey();
        if (elevenKey) {
            return { text: await this._elevenLabsTranscribe({ buffer, mime, filename, apiKey: elevenKey }) };
        }

        throw new WebVoiceError(503, 'STT_UNAVAILABLE',
            'Speech-to-text needs an OpenAI or ElevenLabs API key on this server.');
    }

    /**
     * ElevenLabs Scribe batch transcription (multipart built by hand - not
     * worth a form-data dependency for one endpoint).
     */
    async _elevenLabsTranscribe({ buffer, mime, filename, apiKey }) {
        const boundary = `goobster-${crypto.randomBytes(12).toString('hex')}`;
        const body = Buffer.concat([
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\n${ELEVENLABS_STT_MODEL}\r\n` +
                `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
                `Content-Type: ${mime}\r\n\r\n`
            ),
            buffer,
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);
        const res = await this._fetch()(ELEVENLABS_STT_URL, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body
        });
        if (!res.ok) {
            let detail = '';
            try { detail = ` - ${await res.text()}`; } catch { /* no body */ }
            throw new WebVoiceError(502, 'STT_FAILED', `ElevenLabs transcription failed (${res.status})${detail.slice(0, 200)}`);
        }
        const data = await res.json();
        return String(data.text || '').trim();
    }

    /**
     * Synthesize a reply into speech. Returns the upstream MP3 stream so the
     * route can pipe it straight to the browser.
     * @param {Object} params - { userId, text }
     * @returns {Promise<{ stream: NodeJS.ReadableStream, contentType: string }>}
     */
    async synthesize({ userId, text }) {
        const raw = String(text ?? '');
        if (!raw.trim()) {
            throw new WebVoiceError(400, 'EMPTY_TEXT', 'Nothing to read aloud.');
        }
        if (raw.length > MAX_TTS_INPUT_CHARS) {
            throw new WebVoiceError(400, 'TEXT_TOO_LONG', 'That message is too long to read aloud.');
        }
        const speakable = speechTextFromMarkdown(raw);
        if (!speakable) {
            throw new WebVoiceError(400, 'NOTHING_SPEAKABLE',
                'That message is all code, math, or links - nothing to read aloud.');
        }

        this._checkRateLimit(this._recentTts, userId, TTS_RATE_LIMIT, 'read-alouds');

        const tts = this._ttsService();
        if (tts) {
            // The shared service resolves the /setvoice-configured voice and
            // already falls back to the default voice on a stale config.
            const response = await tts.fetchStream(speakable);
            return { stream: response.body, contentType: 'audio/mpeg' };
        }

        const apiKey = this._elevenLabsKey();
        if (!apiKey) {
            throw new WebVoiceError(503, 'TTS_UNAVAILABLE',
                'Read-aloud needs an ElevenLabs API key on this server.');
        }
        return this._directElevenLabsTts({ text: speakable, apiKey });
    }

    /**
     * Direct ElevenLabs synthesis for the no-shared-service path (e.g. the
     * voice stack failed to initialize but the key exists). Same voice and
     * model resolution rules as ElevenLabsTTSService's defaults.
     */
    async _directElevenLabsTts({ text, apiKey }) {
        const voiceId = process.env.ELEVENLABS_VOICE_ID || this._configVoiceId() || '21m00Tcm4TlvDq8ikWAM';
        const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
        const res = await this._fetch()(
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
            {
                method: 'POST',
                headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    model_id: modelId,
                    voice_settings: { stability: 0.35, similarity_boost: 0.85 }
                })
            }
        );
        if (!res.ok) {
            let detail = '';
            try { detail = ` - ${await res.text()}`; } catch { /* no body */ }
            throw new WebVoiceError(502, 'TTS_FAILED', `ElevenLabs synthesis failed (${res.status})${detail.slice(0, 200)}`);
        }
        return { stream: res.body, contentType: 'audio/mpeg' };
    }

    _configVoiceId() {
        try {
            return require('../../../config.json').elevenlabs?.voiceId || null;
        } catch {
            return null;
        }
    }
}

module.exports = new WebVoiceService();
module.exports.WebVoiceService = WebVoiceService;
module.exports.WebVoiceError = WebVoiceError;
module.exports.speechTextFromMarkdown = speechTextFromMarkdown;
