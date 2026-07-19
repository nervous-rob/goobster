const WebSocket = require('ws');
const { EventEmitter } = require('events');

const DEFAULT_STT_MODEL = 'scribe_v2_realtime';
const REALTIME_STT_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const SAMPLE_RATE = 16000;

/**
 * One realtime transcription stream (ElevenLabs Scribe v2 Realtime) for a
 * single speaker's utterance. Audio chunks are streamed in as they arrive
 * from Discord and partial transcripts flow back while the user is still
 * talking; `commit()` at end-of-utterance returns the final text almost
 * immediately (vs. a full batch STT round trip).
 *
 * Events:
 *   'partial'   (text) - live transcript update
 *   'committed' (text) - final transcript for the utterance
 *   'error'     (Error) - fatal connection/protocol error
 *
 * Lifecycle: connect() -> sendAudio()* -> commit() -> resolves with the
 * committed text -> close(). One connection per utterance keeps well under
 * concurrency limits (connections only exist while someone is speaking).
 */
class ScribeRealtimeConnection extends EventEmitter {
    /**
     * @param {Object} opts - { apiKey, modelId, keyterms, baseUrl }
     */
    constructor({ apiKey, modelId = DEFAULT_STT_MODEL, keyterms = [], baseUrl = REALTIME_STT_URL }) {
        super();
        this.apiKey = apiKey;
        this.modelId = modelId;
        this.keyterms = keyterms;
        this.baseUrl = baseUrl;
        this.ws = null;
        this.ready = false;
        this.closed = false;
        this.partialText = '';
        this.committedText = null;
        this._commitResolvers = [];
    }

    /**
     * Open the WebSocket and wait for session_started.
     * @returns {Promise<void>}
     */
    connect(timeoutMs = 8000) {
        const params = new URLSearchParams({
            model_id: this.modelId,
            audio_format: `pcm_${SAMPLE_RATE}`,
            commit_strategy: 'manual'
        });
        for (const term of this.keyterms.slice(0, 20)) {
            params.append('keyterms', term);
        }

        this.ws = new WebSocket(`${this.baseUrl}?${params}`, {
            headers: { 'xi-api-key': this.apiKey }
        });

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Realtime STT connection timed out'));
                this.close();
            }, timeoutMs);

            this.ws.on('message', (raw) => {
                let data;
                try {
                    data = JSON.parse(raw.toString());
                } catch {
                    return;
                }
                this._handleMessage(data, () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            this.ws.on('error', (error) => {
                clearTimeout(timer);
                this.closed = true;
                this.emit('error', error);
                reject(error);
            });
            this.ws.on('close', () => {
                this.closed = true;
                this._settleCommit();
            });
        });
    }

    _handleMessage(data, onSessionStarted) {
        switch (data.message_type) {
            case 'session_started':
                this.ready = true;
                if (onSessionStarted) onSessionStarted();
                break;
            case 'partial_transcript':
                this.partialText = data.text || '';
                if (this.partialText) this.emit('partial', this.partialText);
                break;
            case 'committed_transcript':
                this.committedText = (data.text || '').trim();
                this.emit('committed', this.committedText);
                this._settleCommit();
                break;
            case 'committed_transcript_with_timestamps':
            case 'committed_transcript_entities':
                break; // not requested, ignore defensively
            default:
                if (typeof data.error === 'string') {
                    const error = new Error(`Realtime STT ${data.message_type}: ${data.error}`);
                    error.messageType = data.message_type;
                    // insufficient_audio_activity just means the server hung up
                    // on a quiet stream - treat as a silent close, not a failure.
                    if (data.message_type !== 'insufficient_audio_activity') {
                        this.emit('error', error);
                    }
                    this._settleCommit();
                }
        }
    }

    /**
     * Stream one chunk of 16kHz mono s16le PCM.
     * @param {Buffer} pcm16kMono
     */
    sendAudio(pcm16kMono) {
        if (this.closed || !this.ready || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: pcm16kMono.toString('base64'),
            commit: false,
            sample_rate: SAMPLE_RATE
        }));
    }

    /**
     * Commit the utterance and resolve with the final transcript.
     * Resolves with '' when the connection drops without a committed
     * transcript (e.g. pure noise).
     * @returns {Promise<string>}
     */
    commit(timeoutMs = 6000) {
        if (this.committedText !== null) return Promise.resolve(this.committedText);
        if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.resolve(this.committedText ?? '');
        }
        this.ws.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: '',
            commit: true,
            sample_rate: SAMPLE_RATE
        }));
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                // Fall back to the best partial we saw rather than dropping speech
                resolve(this.committedText ?? this.partialText ?? '');
            }, timeoutMs);
            this._commitResolvers.push({ resolve, timer });
        });
    }

    _settleCommit() {
        for (const { resolve, timer } of this._commitResolvers.splice(0)) {
            clearTimeout(timer);
            resolve(this.committedText ?? this.partialText ?? '');
        }
    }

    close() {
        this.closed = true;
        this._settleCommit();
        try { this.ws?.close(); } catch { /* already closed */ }
    }
}

module.exports = { ScribeRealtimeConnection, DEFAULT_STT_MODEL, REALTIME_STT_URL };
