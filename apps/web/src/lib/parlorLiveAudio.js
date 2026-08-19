// ESM façade so Vite/TS named-import the CommonJS helpers.
import audio from './parlorLiveAudio.cjs';

export const VAD_RMS_THRESHOLD = audio.VAD_RMS_THRESHOLD;
export const VAD_SILENCE_MS = audio.VAD_SILENCE_MS;
export const MAX_UTTERANCE_MS = audio.MAX_UTTERANCE_MS;
export const PREROLL_CHUNKS = audio.PREROLL_CHUNKS;
export const int16Rms = audio.int16Rms;
export const int16ToBase64 = audio.int16ToBase64;
export const UtteranceGate = audio.UtteranceGate;
