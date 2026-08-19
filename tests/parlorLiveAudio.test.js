/**
 * Parlor Live client VAD + PCM helpers (apps/web/src/lib/parlorLiveAudio.cjs).
 */
const {
    int16Rms,
    int16ToBase64,
    UtteranceGate,
    VAD_RMS_THRESHOLD,
    VAD_SILENCE_MS,
    MAX_UTTERANCE_MS
} = require('../apps/web/src/lib/parlorLiveAudio.cjs');

function loudChunk(n = 64) {
    return Int16Array.from({ length: n }, () => 2000);
}
function quietChunk(n = 64) {
    return Int16Array.from({ length: n }, () => 10);
}

describe('parlorLiveAudio', () => {
    test('int16Rms is near zero for silence and high for speech-scale samples', () => {
        expect(int16Rms(quietChunk())).toBeLessThan(VAD_RMS_THRESHOLD);
        expect(int16Rms(loudChunk())).toBeGreaterThan(VAD_RMS_THRESHOLD);
    });

    test('int16ToBase64 round-trips through Buffer', () => {
        const samples = Int16Array.from([0, -1, 32767, -32768]);
        const encoded = int16ToBase64(samples);
        const buf = Buffer.from(encoded, 'base64');
        const decoded = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
        expect([...decoded]).toEqual([...samples]);
    });

    test('UtteranceGate opens on speech energy and commits after silence', () => {
        const started = [];
        const chunks = [];
        let ended = 0;
        const gate = new UtteranceGate({
            onStartChunks: (list) => started.push(list.length),
            onChunk: () => chunks.push(1),
            onEnd: () => { ended += 1; }
        });
        const t0 = 1_000;
        expect(gate.push(quietChunk(), t0)).toBe(false);
        expect(gate.push(loudChunk(), t0 + 10)).toBe(true);
        expect(started).toEqual([2]); // preroll quiet + opening loud
        expect(gate.push(loudChunk(), t0 + 20)).toBe(true);
        expect(chunks).toHaveLength(1);
        expect(gate.push(quietChunk(), t0 + 20 + VAD_SILENCE_MS + 1)).toBe(false);
        expect(ended).toBe(1);
    });

    test('UtteranceGate commits at the max utterance cap', () => {
        let ended = 0;
        const gate = new UtteranceGate({ onEnd: () => { ended += 1; } });
        const t0 = 5_000;
        gate.push(loudChunk(), t0);
        expect(gate.active).toBe(true);
        gate.push(loudChunk(), t0 + MAX_UTTERANCE_MS + 1);
        expect(gate.active).toBe(false);
        expect(ended).toBe(1);
    });
});
