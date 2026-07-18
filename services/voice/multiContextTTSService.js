const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const prism = require('prism-media');
const {
    createAudioResource,
    createAudioPlayer,
    StreamType,
    NoSubscriberBehavior
} = require('@discordjs/voice');

const MULTI_STREAM_URL = 'wss://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
// Smaller-than-default chunk schedule: first audio after ~50 chars instead
// of 120. Slightly less prosody context, dramatically faster first byte.
const CHUNK_LENGTH_SCHEDULE = [50, 90, 140, 200];
// WebSocket-level inactivity timeout (max 180s); contexts are kept alive
// explicitly while a reply is being generated.
const INACTIVITY_TIMEOUT_SECS = 180;

/**
 * Streaming speech playback over the ElevenLabs multi-context TTS WebSocket.
 *
 * One connection per voice session. Each bot reply runs in its own TTS
 * context: LLM text deltas are appended as they arrive and MP3 chunks come
 * back concurrently, so playback starts long before the reply is finished.
 * Barge-in closes the context server-side and kills local playback
 * immediately.
 *
 * Playback path: base64 MP3 chunks -> PassThrough -> FFmpeg (decode to
 * 48kHz stereo PCM) -> AudioResource -> the session's audio player.
 */
class MultiContextTTSService extends EventEmitter {
    /**
     * @param {Object} opts - { apiKey, voiceId, modelId, baseUrl }
     */
    constructor({ apiKey, voiceId, modelId = DEFAULT_MODEL_ID, baseUrl = MULTI_STREAM_URL }) {
        super();
        this.apiKey = apiKey;
        this.voiceId = voiceId;
        this.modelId = modelId;
        this.baseUrl = baseUrl;
        this.ws = null;
        this.closed = false;
        this.contexts = new Map(); // contextId -> { mp3Stream, transcoder, resource, done, finalResolvers }
        this.contextCounter = 0;
        this.player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
        });
    }

    /**
     * Open the WebSocket connection. Must be called before speak().
     */
    connect(timeoutMs = 8000) {
        const params = new URLSearchParams({
            model_id: this.modelId,
            output_format: 'mp3_44100_128', // PCM output needs Pro+; MP3 works on all plans
            inactivity_timeout: String(INACTIVITY_TIMEOUT_SECS),
            auto_mode: 'false'
        });
        this.ws = new WebSocket(
            `${this.baseUrl}/${this.voiceId}/multi-stream-input?${params}`,
            { headers: { 'xi-api-key': this.apiKey }, maxPayload: 16 * 1024 * 1024 }
        );

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('TTS WebSocket connection timed out'));
                this.destroy();
            }, timeoutMs);
            this.ws.on('open', () => {
                clearTimeout(timer);
                resolve();
            });
            this.ws.on('message', (raw) => this._handleMessage(raw));
            this.ws.on('error', (error) => {
                clearTimeout(timer);
                this.emit('error', error);
                reject(error);
            });
            this.ws.on('close', () => {
                this.closed = true;
                for (const contextId of [...this.contexts.keys()]) {
                    this._endContext(contextId);
                }
            });
        });
    }

    _handleMessage(raw) {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            return;
        }
        const contextId = data.contextId || data.context_id;
        const ctx = this.contexts.get(contextId);
        if (!ctx) return;

        if (data.audio) {
            ctx.mp3Stream.write(Buffer.from(data.audio, 'base64'));
        }
        if (data.isFinal || data.is_final) {
            this._endContext(contextId);
        }
        if (typeof data.error === 'string') {
            console.error(`[MultiContextTTS] Context ${contextId} error:`, data.error);
            this._endContext(contextId);
        }
    }

    _send(payload) {
        if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify(payload));
        return true;
    }

    /**
     * Whether the connection is usable.
     */
    isConnected() {
        return !this.closed && this.ws?.readyState === WebSocket.OPEN;
    }

    /**
     * Begin a spoken reply. Returns a handle used to stream text in and to
     * abort on barge-in.
     *
     * @param {Object} connection - Discord voice connection to play into
     * @returns {{
     *   contextId: string,
     *   appendText: function(string): void,
     *   finish: function(): Promise<void>,
     *   abort: function(): void
     * }}
     */
    speak(connection) {
        if (!this.isConnected()) {
            throw new Error('TTS WebSocket is not connected');
        }
        const contextId = `reply-${++this.contextCounter}`;

        // Initialize the context; voice settings only on the first message.
        this._send({
            text: ' ',
            context_id: contextId,
            voice_settings: { stability: 0.35, similarity_boost: 0.85, speed: 1.0 },
            generation_config: { chunk_length_schedule: CHUNK_LENGTH_SCHEDULE }
        });

        const mp3Stream = new PassThrough();
        const transcoder = new prism.FFmpeg({
            args: [
                '-i', 'pipe:0',
                '-analyzeduration', '0',
                '-loglevel', '0',
                '-acodec', 'pcm_s16le',
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
                '-af', 'volume=1.5'
            ]
        });
        mp3Stream.pipe(transcoder);

        const resource = createAudioResource(transcoder, {
            inputType: StreamType.Raw,
            inlineVolume: false
        });

        const ctx = {
            mp3Stream,
            transcoder,
            resource,
            done: false,
            playbackStarted: false,
            finalResolvers: []
        };
        this.contexts.set(contextId, ctx);

        // Start playback as soon as the first PCM is decoded
        transcoder.once('readable', () => {
            if (ctx.done && !ctx.playbackStarted) return; // aborted before audio arrived
            ctx.playbackStarted = true;
            this.player.play(resource);
            connection.subscribe(this.player);
            this.emit('playbackStart', contextId);
        });

        const service = this;
        return {
            contextId,
            appendText(text) {
                if (!text) return;
                service._send({ text, context_id: contextId });
            },
            /**
             * Signal end of input and resolve once playback has fully
             * finished (or the context was aborted).
             *
             * Protocol note (verified live): the server only emits
             * isFinal:true after close_context; a flushed-but-open context
             * keeps streaming audio with isFinal:null. A context closed
             * while flushing still delivers all remaining audio first.
             */
            async finish() {
                service._send({ context_id: contextId, flush: true });
                service._send({ context_id: contextId, close_context: true });
                await new Promise((resolve) => {
                    if (ctx.done) return resolve();
                    ctx.finalResolvers.push(resolve);
                });
                // Context finished server-side; wait for local playback to drain
                await service._waitForPlaybackEnd(ctx);
                service.contexts.delete(contextId);
            },
            /**
             * Barge-in: stop generation and playback instantly.
             */
            abort() {
                service._send({ context_id: contextId, close_context: true });
                service._stopPlayback(ctx);
                service._endContext(contextId);
                service.contexts.delete(contextId);
            }
        };
    }

    /**
     * Resolve when the audio player goes idle for this context's resource
     * (all decoded audio has been played out).
     */
    _waitForPlaybackEnd(ctx) {
        return new Promise((resolve) => {
            if (!ctx.playbackStarted) {
                // No audio ever arrived (e.g. empty reply)
                this._stopPlayback(ctx);
                return resolve();
            }
            if (ctx.resource.ended) return resolve();
            const handler = (oldState, newState) => {
                if (newState.status === 'idle') {
                    this.player.removeListener('stateChange', handler);
                    resolve();
                }
            };
            this.player.on('stateChange', handler);
        });
    }

    _stopPlayback(ctx) {
        try { ctx.mp3Stream.destroy(); } catch { /* already gone */ }
        try { ctx.transcoder.destroy(); } catch { /* already gone */ }
        if (ctx.playbackStarted) {
            try { this.player.stop(true); } catch { /* already stopped */ }
        }
    }

    /** Mark a context finished and settle finish() waiters. */
    _endContext(contextId) {
        const ctx = this.contexts.get(contextId);
        if (!ctx || ctx.done) return;
        ctx.done = true;
        ctx.mp3Stream.end();
        for (const resolve of ctx.finalResolvers.splice(0)) resolve();
    }

    /**
     * Close everything (end of session).
     */
    destroy() {
        for (const [contextId, ctx] of this.contexts) {
            this._stopPlayback(ctx);
            this._endContext(contextId);
        }
        this.contexts.clear();
        try { this.player.stop(true); } catch { /* already stopped */ }
        this._send({ close_socket: true }); // must go out before closed is set
        this.closed = true;
        try { this.ws?.close(); } catch { /* already closed */ }
    }
}

module.exports = { MultiContextTTSService, DEFAULT_MODEL_ID };
