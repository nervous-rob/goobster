/**
 * PCM helpers shared by the voice pipeline.
 *
 * Discord voice delivers 48kHz stereo s16le PCM after opus decoding; the
 * realtime STT API wants 16kHz mono. Conversion is a boxcar average over
 * each 3-frame window (cheap low-pass) plus channel averaging - plenty for
 * speech and light enough for a Raspberry Pi.
 */

const SOURCE_RATE = 48000;
const TARGET_RATE = 16000;
const DECIMATION = SOURCE_RATE / TARGET_RATE; // 3

/**
 * Convert 48kHz stereo s16le PCM to 16kHz mono s16le PCM.
 * @param {Buffer} pcm - 48kHz stereo 16-bit little-endian PCM
 * @returns {Buffer} 16kHz mono 16-bit little-endian PCM
 */
function stereo48kToMono16k(pcm) {
    const frames = Math.floor(pcm.length / 4); // 2 channels * 2 bytes
    const outFrames = Math.floor(frames / DECIMATION);
    const out = Buffer.alloc(outFrames * 2);
    for (let i = 0; i < outFrames; i++) {
        let sum = 0;
        for (let j = 0; j < DECIMATION; j++) {
            const offset = (i * DECIMATION + j) * 4;
            sum += pcm.readInt16LE(offset) + pcm.readInt16LE(offset + 2);
        }
        const sample = Math.round(sum / (DECIMATION * 2));
        out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
    }
    return out;
}

/**
 * Root-mean-square amplitude of s16le PCM - a cheap "is this actual speech
 * or just an open mic?" energy check. Speech typically lands well above
 * 1000; breathing, hum, and keyboard bleed sit far lower.
 * @param {Buffer} pcmBuffer - 16-bit little-endian PCM (any rate/channels)
 * @param {number} [stride=8] - sample every Nth value (precision is not needed)
 */
function pcmRms(pcmBuffer, stride = 8) {
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    if (sampleCount === 0) return 0;
    let sumSquares = 0;
    let counted = 0;
    for (let i = 0; i < sampleCount; i += stride) {
        const sample = pcmBuffer.readInt16LE(i * 2);
        sumSquares += sample * sample;
        counted++;
    }
    return Math.sqrt(sumSquares / counted);
}

module.exports = { stereo48kToMono16k, pcmRms, TARGET_RATE };
