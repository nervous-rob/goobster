/**
 * Client-side audio encoding helpers: PCM/WAV export for recordings and
 * sample clips, buffer slicing for the sample editor, and file downloads.
 */

/** Encodes an AudioBuffer as a 16-bit PCM WAV blob (mono or stereo). */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const dataBytes = frames * channels * 2;
  const arrayBuffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(arrayBuffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const channelData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/** Decodes any browser-supported audio blob (wav/mp3/webm…) to an AudioBuffer. */
export async function blobToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  const data = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(data);
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

/**
 * Copies a fractional region of a buffer into a new AudioBuffer, applying a
 * linear gain. Used by the sample editor's trim + normalize step.
 */
export function sliceAudioBuffer(source: AudioBuffer, startFraction: number, endFraction: number, gain = 1): AudioBuffer {
  const start = Math.max(0, Math.min(1, startFraction));
  const end = Math.max(start, Math.min(1, endFraction));
  const startFrame = Math.floor(start * source.length);
  const endFrame = Math.max(startFrame + 1, Math.floor(end * source.length));
  const frames = endFrame - startFrame;
  const channels = Math.min(2, Math.max(1, source.numberOfChannels));

  const out = new AudioBuffer({ length: frames, numberOfChannels: channels, sampleRate: source.sampleRate });
  for (let c = 0; c < channels; c++) {
    const src = source.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      dst[i] = Math.max(-1, Math.min(1, src[startFrame + i] * gain));
    }
  }
  return out;
}

/**
 * Converts a MediaRecorder blob (Tone.Recorder output, usually webm/opus)
 * into a WAV blob. Returns null if the browser can't decode it.
 */
export async function recordingToWavBlob(recording: Blob): Promise<Blob | null> {
  try {
    const buffer = await blobToAudioBuffer(recording);
    return audioBufferToWavBlob(buffer);
  } catch {
    return null;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
