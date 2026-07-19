/**
 * PCM helpers for the realtime voice pipeline (services/voice/pcmUtils.js):
 * 48kHz stereo -> 16kHz mono downsampling and RMS energy measurement.
 */
const { stereo48kToMono16k, pcmRms } = require('../services/voice/pcmUtils');

/** Build a 48kHz stereo s16le buffer from a per-frame sample function. */
function buildStereo(frames, fn) {
    const buf = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
        const [left, right] = fn(i);
        buf.writeInt16LE(left, i * 4);
        buf.writeInt16LE(right, i * 4 + 2);
    }
    return buf;
}

describe('stereo48kToMono16k', () => {
    test('produces one mono frame per three stereo frames', () => {
        const input = buildStereo(48000, () => [100, 200]); // 1s of audio
        const out = stereo48kToMono16k(input);
        expect(out.length).toBe(16000 * 2); // 1s at 16kHz mono s16le
    });

    test('averages channels and adjacent frames', () => {
        // L=1000, R=3000 everywhere -> mono average 2000
        const input = buildStereo(6, () => [1000, 3000]);
        const out = stereo48kToMono16k(input);
        expect(out.length).toBe(4); // 2 output frames
        expect(out.readInt16LE(0)).toBe(2000);
        expect(out.readInt16LE(2)).toBe(2000);
    });

    test('clamps to the s16 range', () => {
        const input = buildStereo(3, () => [32767, 32767]);
        const out = stereo48kToMono16k(input);
        expect(out.readInt16LE(0)).toBe(32767);
    });

    test('preserves a low-frequency tone (no destructive aliasing)', () => {
        // 200Hz sine at 48kHz, amplitude 10000
        const frames = 4800;
        const input = buildStereo(frames, (i) => {
            const v = Math.round(10000 * Math.sin(2 * Math.PI * 200 * i / 48000));
            return [v, v];
        });
        const out = stereo48kToMono16k(input);
        // Energy should survive the downsample (boxcar filter attenuates
        // 200Hz negligibly)
        expect(pcmRms(out, 1)).toBeGreaterThan(6000);
    });
});

describe('pcmRms', () => {
    test('is zero for silence and large for loud audio', () => {
        expect(pcmRms(Buffer.alloc(3200))).toBe(0);
        const loud = buildStereo(800, () => [20000, 20000]);
        expect(pcmRms(loud)).toBeGreaterThan(15000);
    });

    test('handles empty buffers', () => {
        expect(pcmRms(Buffer.alloc(0))).toBe(0);
    });
});
