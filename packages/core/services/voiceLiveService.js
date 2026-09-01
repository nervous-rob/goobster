/**
 * Voice Live: streaming speech-to-text for the web portal's voice chat.
 *
 * One WebSocket per browser voice-chat session (path /api/app/voice/live).
 * The client streams microphone audio up (16kHz mono s16le PCM, resampled
 * in the browser - the Parlor Live format); the server runs an RMS energy
 * gate (open-mic noise never reaches paid STT), streams hot audio into
 * ElevenLabs Scribe v2 Realtime while the user is still talking, and
 * commits the utterance on the client's silence gate (or an explicit
 * "send now" in press-to-send mode). Partial transcripts stream back as
 * stt_partial so the user can see what is being heard, live.
 *
 * Unlike Parlor Live this is transcription-only: the committed text goes
 * back to the client, which sends it through the NORMAL web chat SSE
 * route - never a parallel generation path - so tools, memory, history,
 * and the per-user turn lock all apply unchanged.
 *
 * All state is per-connection and in-memory; nothing persists, so there
 * is no new privacy surface. Realtime STT usage is logged to the user's
 * DM scope like every other AI call. When Scribe fails mid-utterance the
 * buffered PCM falls back to batch transcription (webVoiceService - the
 * same ladder the composer mic uses).
 */

const { pcmRms } = require('./voice/pcmUtils');
const { dmScopeId } = require('../utils/dmScope');

// Live audio arrives as 16kHz mono s16le PCM (32 bytes/ms)
const SAMPLE_RATE = 16000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
// Segments quieter than this RMS are treated as mic noise: buffered but
// never streamed to the STT API (the realtime engine's gate).
const NOISE_RMS_THRESHOLD = 250;
// Hard cap per utterance (90s of PCM ≈ 2.9MB); longer speech auto-commits.
// More generous than Parlor's 60s: press-to-send mode holds one utterance
// open for as long as the user keeps talking.
const MAX_UTTERANCE_MS = 90000;
const MAX_UTTERANCE_BYTES = MAX_UTTERANCE_MS * BYTES_PER_MS;
// One WS audio message may carry at most ~6s of PCM (base64)
const MAX_AUDIO_CHUNK_BASE64 = 256 * 1024;
// Cost guardrails (transient in-memory sliding windows)
const CONNECT_RATE_LIMIT = 12;
const CONNECT_RATE_WINDOW_MS = 10 * 60 * 1000;
const COMMIT_RATE_LIMIT = 20;
const COMMIT_RATE_WINDOW_MS = 60 * 1000;

const WORDS_REGEX = /[\p{L}\p{N}]{2,}/u;

/** Machine-readable web app error (the PanelError status+code contract). */
class VoiceLiveError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'VoiceLiveError';
        this.status = status;
        this.code = code;
    }
}

class VoiceLiveService {
    /**
     * @param {Object} [deps] - injectable for tests:
     *   { createScribe: (opts) => connection, webVoice,
     *     elevenLabsKey: () => string|null, usageTracker, logger }
     */
    constructor(deps = {}) {
        this._deps = deps;
    }

    _webVoice() {
        return this._deps.webVoice || require('./webVoiceService');
    }

    _usage() {
        return this._deps.usageTracker || require('./usageTracker');
    }

    _logger() {
        return this._deps.logger || console;
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

    _createScribe(opts) {
        if (this._deps.createScribe) return this._deps.createScribe(opts);
        const { ScribeRealtimeConnection } = require('./voice/scribeRealtimeService');
        return new ScribeRealtimeConnection(opts);
    }

    /** Whether live transcription can work at all on this server. */
    capabilities() {
        return { live: Boolean(this._elevenLabsKey()) };
    }

    async _checkRateLimit(scope, userId, max, windowMs, what) {
        const { consumeWindow } = require('../utils/slidingWindowLimit');
        const ok = await consumeWindow({ scope, subject: userId, max, windowMs });
        if (!ok) {
            throw new VoiceLiveError(429, 'RATE_LIMITED', `Slow down - too many ${what}.`);
        }
    }

    /**
     * Drive one authenticated live-transcription WebSocket. The web layer
     * has already resolved the session cookie.
     *
     * Client -> server: { type: 'audio', data: base64PCM },
     *   { type: 'utterance-end' } (commit), { type: 'cancel' } (discard).
     * Server -> client: ready, stt_partial { text }, utterance { text },
     *   utterance_empty, error { code, message }.
     *
     * @param {Object} socket - a ws socket
     * @param {Object} identity - { userId }
     */
    handleConnection(socket, { userId }) {
        const client = { userId, utterance: null, closed: false };

        const send = (type, data = {}) => {
            if (socket.readyState === socket.OPEN) {
                try { socket.send(JSON.stringify({ type, ...data })); } catch { /* closing */ }
            }
        };
        const sendError = (code, message) => send('error', { code, message });

        this._checkRateLimit('web_voice_live_connect', userId,
            CONNECT_RATE_LIMIT, CONNECT_RATE_WINDOW_MS, 'voice sessions started')
            .then(() => {
                if (!this.capabilities().live) {
                    sendError('LIVE_UNAVAILABLE',
                        'Live transcription needs an ElevenLabs API key on this server.');
                    socket.close();
                    return;
                }
                send('ready', { sampleRate: SAMPLE_RATE });
            })
            .catch((error) => {
                sendError(error.code || 'INTERNAL', error.message);
                socket.close();
            });

        socket.on('message', async (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                sendError('BAD_JSON', 'Messages must be JSON.');
                return;
            }
            try {
                if (message.type === 'audio') {
                    this._handleAudio(client, send, message.data);
                } else if (message.type === 'utterance-end') {
                    await this._commitUtterance(client, send);
                } else if (message.type === 'cancel') {
                    this._closeUtterance(client);
                } else {
                    sendError('BAD_TYPE', 'Unknown message type.');
                }
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(error.code, error.message);
                } else {
                    this._logger().error?.('[VoiceLive] WS error:', error.message);
                    sendError('INTERNAL', 'Something went wrong.');
                }
            }
        });

        socket.on('close', () => {
            client.closed = true;
            this._closeUtterance(client);
        });
    }

    /**
     * One chunk of the speaker's microphone PCM. Audio is buffered locally
     * until a chunk crosses the RMS energy gate; only then does an STT
     * connection open (pure mic noise never costs a cent). The raw PCM is
     * kept (bounded) for the batch fallback.
     */
    _handleAudio(client, send, data) {
        if (typeof data !== 'string' || data.length === 0 || data.length > MAX_AUDIO_CHUNK_BASE64) {
            throw new VoiceLiveError(400, 'BAD_AUDIO', 'Audio chunks must be small base64 PCM strings.');
        }
        let chunk;
        try {
            chunk = Buffer.from(data, 'base64');
        } catch {
            throw new VoiceLiveError(400, 'BAD_AUDIO', 'The audio payload could not be decoded.');
        }
        if (chunk.length === 0) return;

        let utterance = client.utterance;
        if (!utterance) {
            utterance = client.utterance = {
                chunks: [],
                totalBytes: 0,
                hot: false,
                scribe: null,
                scribeReady: null,
                scribeFailed: false,
                preBuffer: [],
                startedAt: Date.now(),
                committing: false
            };
        }
        if (utterance.committing) return; // late chunks after auto-commit

        utterance.chunks.push(chunk);
        utterance.totalBytes += chunk.length;

        if (!utterance.hot && pcmRms(chunk, 4) >= NOISE_RMS_THRESHOLD) {
            utterance.hot = true;
            this._openScribe(client, send, utterance);
            // Stream everything captured so far (context helps accuracy)
            for (const buffered of utterance.chunks) {
                this._feedScribe(utterance, buffered);
            }
        } else if (utterance.hot) {
            this._feedScribe(utterance, chunk);
        }

        // Runaway utterance: commit rather than buffer forever
        if (utterance.totalBytes >= MAX_UTTERANCE_BYTES) {
            utterance.committing = true;
            this._commitUtterance(client, send).catch(error => {
                this._logger().warn?.('[VoiceLive] Auto-commit failed:', error.message);
            });
        }
    }

    _feedScribe(utterance, chunk) {
        if (!utterance.scribe || utterance.scribeFailed) return;
        if (utterance.scribe.ready) utterance.scribe.sendAudio(chunk);
        else utterance.preBuffer.push(chunk);
    }

    _openScribe(client, send, utterance) {
        const apiKey = this._elevenLabsKey();
        if (!apiKey) {
            utterance.scribeFailed = true;
            return;
        }
        const scribe = this._createScribe({ apiKey });
        utterance.scribe = scribe;
        scribe.on('partial', (text) => {
            if (client.closed || client.utterance !== utterance) return;
            send('stt_partial', { text });
        });
        scribe.on('error', (error) => {
            utterance.scribeFailed = true;
            this._logger().warn?.('[VoiceLive] Realtime STT error:', error.message);
        });
        utterance.scribeReady = scribe.connect().then(() => {
            for (const chunk of utterance.preBuffer.splice(0)) scribe.sendAudio(chunk);
        }).catch((error) => {
            utterance.scribeFailed = true;
            this._logger().warn?.('[VoiceLive] Realtime STT connect failed:', error.message);
        });
    }

    _closeUtterance(client) {
        try { client.utterance?.scribe?.close(); } catch { /* already gone */ }
        client.utterance = null;
    }

    /**
     * End-of-speech (the client's silence gate, "send now", or the length
     * cap): commit the realtime transcript, falling back to per-utterance
     * batch STT when the realtime API failed. The final text goes back to
     * the client, which sends it as a normal chat message.
     */
    async _commitUtterance(client, send) {
        const utterance = client.utterance;
        if (!utterance) return;
        client.utterance = null;

        if (!utterance.hot) {
            // Never crossed the energy gate: open mic noise
            send('utterance_empty', {});
            return;
        }

        await this._checkRateLimit('web_voice_live_commit', client.userId,
            COMMIT_RATE_LIMIT, COMMIT_RATE_WINDOW_MS, 'utterances per minute');

        let transcript = '';
        try {
            await utterance.scribeReady;
            if (!utterance.scribeFailed && utterance.scribe) {
                transcript = await utterance.scribe.commit();
                this._usage().log({
                    provider: 'elevenlabs',
                    model: utterance.scribe.modelId,
                    operation: 'transcription-realtime',
                    guildId: dmScopeId(client.userId),
                    userId: client.userId
                });
            }
        } catch (error) {
            utterance.scribeFailed = true;
            this._logger().warn?.('[VoiceLive] Realtime STT commit failed:', error.message);
        } finally {
            try { utterance.scribe?.close(); } catch { /* already gone */ }
        }

        // Fallback: batch-transcribe the buffered PCM when realtime STT
        // produced nothing because of an ERROR (not because of silence).
        if (utterance.scribeFailed && !transcript) {
            try {
                const wav = this._buildWav(Buffer.concat(utterance.chunks, utterance.totalBytes));
                const result = await this._webVoice().transcribe({
                    userId: client.userId,
                    audioBase64: wav.toString('base64'),
                    mimeType: 'audio/wav'
                });
                transcript = result.text;
            } catch (error) {
                this._logger().warn?.('[VoiceLive] Fallback transcription failed:', error.message);
            }
        }

        const text = String(transcript || '').trim();
        if (!text || !WORDS_REGEX.test(text)) {
            send('utterance_empty', {});
            return;
        }
        send('utterance', { text });
    }

    /** RIFF/WAV header for the batch STT fallback (16kHz mono s16le). */
    _buildWav(pcmBuffer) {
        const header = Buffer.alloc(44);
        const byteRate = SAMPLE_RATE * 2;
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + pcmBuffer.length, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(SAMPLE_RATE, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(pcmBuffer.length, 40);
        return Buffer.concat([header, pcmBuffer]);
    }
}

module.exports = new VoiceLiveService();
module.exports.VoiceLiveService = VoiceLiveService;
module.exports.VoiceLiveError = VoiceLiveError;
