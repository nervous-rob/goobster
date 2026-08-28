/**
 * Curated voice presets for tonal creatures. Each preset describes both a
 * polyphonic variant (chord organisms) and a monophonic variant (bass/lead
 * creatures); the hue colors the creature on the stage canvas.
 *
 * Users can extend the library with custom voices (synth knobs or uploaded
 * sample clips) built in the Voice Builder; those persist in localStorage
 * (sample audio itself lives in IndexedDB, see lib/sampleStore.ts) and merge
 * into every voice lookup below.
 */

import { readConservatoryStorage, writeConservatoryStorage } from './storage';

export type VoiceOsc = 'sine' | 'triangle' | 'sawtooth' | 'square' | 'fatsawtooth' | 'fatsine';

export interface VoiceEnvelope {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

export interface VoicePreset {
  id: string;
  name: string;
  blurb: string;
  hue: number;
  engine: 'synth' | 'fm' | 'sample';
  /** Oscillator for engine === 'synth' (fallback timbre for 'sample'). */
  osc: VoiceOsc;
  /** FM parameters for engine === 'fm'. */
  fm?: { harmonicity: number; modulationIndex: number };
  /** Sample parameters for engine === 'sample'. */
  sample?: { sampleId: string; rootMidi: number };
  polyEnvelope: VoiceEnvelope;
  monoEnvelope: VoiceEnvelope;
  polyVolume: number;
  monoVolume: number;
}

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: 'glass-pad',
    name: 'Glass Pad',
    blurb: 'Clear triangle shimmer — the original organism voice',
    hue: 165,
    engine: 'synth',
    osc: 'triangle',
    polyEnvelope: { attack: 0.02, decay: 0.25, sustain: 0.55, release: 1.4 },
    monoEnvelope: { attack: 0.015, decay: 0.18, sustain: 0.45, release: 0.5 },
    polyVolume: -9,
    monoVolume: -6
  },
  {
    id: 'warm-organ',
    name: 'Warm Organ',
    blurb: 'Fat sine drone with a chapel hum',
    hue: 35,
    engine: 'synth',
    osc: 'fatsine',
    polyEnvelope: { attack: 0.04, decay: 0.1, sustain: 0.9, release: 0.6 },
    monoEnvelope: { attack: 0.03, decay: 0.08, sustain: 0.85, release: 0.3 },
    polyVolume: -10,
    monoVolume: -8
  },
  {
    id: 'pluck-choir',
    name: 'Pluck Choir',
    blurb: 'Short plucked attacks that fall away fast',
    hue: 95,
    engine: 'synth',
    osc: 'triangle',
    polyEnvelope: { attack: 0.005, decay: 0.3, sustain: 0.12, release: 0.5 },
    monoEnvelope: { attack: 0.004, decay: 0.22, sustain: 0.08, release: 0.35 },
    polyVolume: -8,
    monoVolume: -6
  },
  {
    id: 'saw-swell',
    name: 'Saw Swell',
    blurb: 'Slow-blooming detuned saws — cinematic weight',
    hue: 215,
    engine: 'synth',
    osc: 'fatsawtooth',
    polyEnvelope: { attack: 0.5, decay: 0.3, sustain: 0.8, release: 1.8 },
    monoEnvelope: { attack: 0.12, decay: 0.2, sustain: 0.7, release: 0.8 },
    polyVolume: -12,
    monoVolume: -9
  },
  {
    id: 'bell-choir',
    name: 'Bell Choir',
    blurb: 'FM bells with a long metallic bloom',
    hue: 48,
    engine: 'fm',
    osc: 'sine',
    fm: { harmonicity: 3.01, modulationIndex: 14 },
    polyEnvelope: { attack: 0.004, decay: 0.7, sustain: 0.05, release: 1.3 },
    monoEnvelope: { attack: 0.003, decay: 0.5, sustain: 0.04, release: 0.9 },
    polyVolume: -12,
    monoVolume: -10
  },
  {
    id: 'soft-brass',
    name: 'Soft Brass',
    blurb: 'Rounded sawtooth breath — warm low-end push',
    hue: 20,
    engine: 'synth',
    osc: 'sawtooth',
    polyEnvelope: { attack: 0.09, decay: 0.18, sustain: 0.7, release: 0.45 },
    monoEnvelope: { attack: 0.03, decay: 0.15, sustain: 0.6, release: 0.3 },
    polyVolume: -11,
    monoVolume: -8
  }
];

// --- Custom voice store (localStorage-backed, subscribable) ---

export const CUSTOM_VOICES_KEY = 'customVoices';

let customVoices: VoicePreset[] = [];
let hydrated = false;
const listeners = new Set<() => void>();

function hydrate(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = readConservatoryStorage(CUSTOM_VOICES_KEY);
    customVoices = raw ? (JSON.parse(raw) as VoicePreset[]) : [];
  } catch {
    customVoices = [];
  }
}

function persist(): void {
  try {
    writeConservatoryStorage(CUSTOM_VOICES_KEY, JSON.stringify(customVoices));
  } catch {
    // Storage full or unavailable; the in-memory registry still works.
  }
}

function notify(): void {
  listeners.forEach(listener => listener());
}

export function subscribeCustomVoices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for useSyncExternalStore; only replaced on mutation. */
export function getCustomVoicesSnapshot(): VoicePreset[] {
  hydrate();
  return customVoices;
}

const EMPTY_VOICES: VoicePreset[] = [];

export function getServerVoicesSnapshot(): VoicePreset[] {
  return EMPTY_VOICES;
}

export function saveCustomVoice(preset: VoicePreset): void {
  hydrate();
  customVoices = [...customVoices.filter(v => v.id !== preset.id), preset];
  persist();
  notify();
}

export function removeCustomVoice(id: string): void {
  hydrate();
  customVoices = customVoices.filter(v => v.id !== id);
  persist();
  notify();
}

export function makeVoiceId(): string {
  return `voice-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Core presets plus every user-built voice. */
export function getAllVoices(): VoicePreset[] {
  hydrate();
  return [...VOICE_PRESETS, ...customVoices];
}

export function findVoice(id: string | undefined): VoicePreset {
  hydrate();
  return VOICE_PRESETS.find(v => v.id === id) ?? customVoices.find(v => v.id === id) ?? VOICE_PRESETS[0];
}
