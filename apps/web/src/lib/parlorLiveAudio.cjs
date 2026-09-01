/**
 * Parlor Live microphone helpers (VAD + PCM encoding).
 * Shared by the React session and Jest. CommonJS so tests can require()
 * it from the type:module @goobster/web workspace.
 *
 * Same tuning as the pre-React client's parlorLive.js: RMS threshold, 900ms
 * silence gate, 55s max utterance, ~0.5s preroll.
 */

const VAD_RMS_THRESHOLD = 300;
const VAD_SILENCE_MS = 900;
const MAX_UTTERANCE_MS = 55000;
const PREROLL_CHUNKS = 2;

function int16Rms(samples) {
    let sum = 0;
    let counted = 0;
    for (let i = 0; i < samples.length; i += 8) {
        sum += samples[i] * samples[i];
        counted++;
    }
    return counted === 0 ? 0 : Math.sqrt(sum / counted);
}

function int16ToBase64(samples) {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return (typeof btoa === 'function')
        ? btoa(binary)
        : Buffer.from(bytes).toString('base64');
}

/**
 * Client-side voice-activity gate. Feeds Int16 chunks; emits start/chunk/end.
 */
class UtteranceGate {
    constructor({ onStartChunks, onChunk, onEnd } = {}) {
        this.onStartChunks = onStartChunks;
        this.onChunk = onChunk;
        this.onEnd = onEnd;
        this.reset();
    }

    reset() {
        this.utteranceActive = false;
        this.lastVoiceAt = 0;
        this.utteranceStartedAt = 0;
        this.preroll = [];
    }

    get active() {
        return this.utteranceActive;
    }

    push(samples, now = Date.now()) {
        const rms = int16Rms(samples);
        if (!this.utteranceActive) {
            this.preroll.push(samples);
            if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift();
            if (rms >= VAD_RMS_THRESHOLD) {
                this.utteranceActive = true;
                this.lastVoiceAt = now;
                this.utteranceStartedAt = now;
                const started = this.preroll.splice(0);
                this.onStartChunks?.(started);
            }
            return this.utteranceActive;
        }

        this.onChunk?.(samples);
        if (rms >= VAD_RMS_THRESHOLD) this.lastVoiceAt = now;
        if (now - this.lastVoiceAt > VAD_SILENCE_MS || now - this.utteranceStartedAt > MAX_UTTERANCE_MS) {
            this.end();
        }
        return this.utteranceActive;
    }

    end() {
        if (!this.utteranceActive) return;
        this.utteranceActive = false;
        this.preroll = [];
        this.onEnd?.();
    }
}

module.exports = {
    VAD_RMS_THRESHOLD,
    VAD_SILENCE_MS,
    MAX_UTTERANCE_MS,
    PREROLL_CHUNKS,
    int16Rms,
    int16ToBase64,
    UtteranceGate
};
