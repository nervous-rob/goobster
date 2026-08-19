/**
 * Parlor Live microphone worklet: mixes the input to mono, resamples from
 * the AudioContext rate (usually 48kHz) down to 16kHz with linear
 * interpolation (the Scribe realtime STT input format, mirroring the
 * server-side stereo48kToMono16k precedent), and posts ~256ms Int16 PCM
 * chunks to the main thread.
 *
 * Plain worklet script - not an ES module import; loaded with
 * audioWorklet.addModule('/app/liveAudioWorklet.js').
 */

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 4096; // 256ms at 16kHz

class LiveMicProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.step = sampleRate / TARGET_RATE;
        this.frac = 0;                 // fractional read position carryover
        this.pending = null;           // source samples left from the last block
        this.out = new Int16Array(CHUNK_SAMPLES);
        this.outLen = 0;
    }

    _flush() {
        if (this.outLen === 0) return;
        const copy = this.out.slice(0, this.outLen);
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.outLen = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0] || input[0].length === 0) return true;

        // Mono mix
        const mono = Float32Array.from(input[0]);
        for (let c = 1; c < input.length; c++) {
            const data = input[c];
            for (let i = 0; i < data.length && i < mono.length; i++) mono[i] += data[i];
        }
        if (input.length > 1) {
            for (let i = 0; i < mono.length; i++) mono[i] /= input.length;
        }

        // Prepend leftover source samples so interpolation spans blocks
        let src = mono;
        if (this.pending && this.pending.length > 0) {
            src = new Float32Array(this.pending.length + mono.length);
            src.set(this.pending, 0);
            src.set(mono, this.pending.length);
        }

        let pos = this.frac;
        while (pos + 1 < src.length) {
            const i0 = Math.floor(pos);
            const t = pos - i0;
            const sample = src[i0] * (1 - t) + src[i0 + 1] * t;
            const clamped = Math.max(-1, Math.min(1, sample));
            this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
            if (this.outLen === this.out.length) this._flush();
            pos += this.step;
        }
        const consumed = Math.floor(pos);
        this.frac = pos - consumed;
        this.pending = src.slice(consumed);
        return true;
    }
}

registerProcessor('live-mic', LiveMicProcessor);
