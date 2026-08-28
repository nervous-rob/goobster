import type { MelodyContourStep } from './melodyTheory';
import type { FoundrySettings } from './harmonyTheory';
import type { RegisterId, VoicingId } from './harmonyData';
import { LIBRARY_CONTOUR_PRESETS } from './genreLibrary';
import { readConservatoryStorage, writeConservatoryStorage } from './storage';

/**
 * Ensemble Stage cast data: performer roles, creature metadata, default
 * patterns, the contour preset library, and the saved-creature library types.
 */

export type PerformerRole = 'kick' | 'snare' | 'hihat' | 'chords' | 'bass' | 'melody';
export type DrumRole = 'kick' | 'snare' | 'hihat';
export type CreatureKind = 'bass' | 'lead';

export const DRUM_ROLES: DrumRole[] = ['kick', 'snare', 'hihat'];

export function isDrumRole(role: PerformerRole): role is DrumRole {
  return role === 'kick' || role === 'snare' || role === 'hihat';
}

/**
 * One explicitly written melody note (Studio lead sheets). Pitch is stored
 * relative to the song's key root so written leads transpose with the key.
 */
export interface WrittenNote {
  id: string;
  /** 0-based absolute measure within the song. */
  measure: number;
  /** Grid subdivision within the measure. */
  sub: number;
  /** Semitones above the key root at the creature's base register. */
  pitch: number;
  /** Held length in grid subdivisions (may ring past the bar line). */
  durSubs: number;
}

export interface PerformerState {
  /** Unique within the cast; core six use their role as id. */
  id: string;
  role: PerformerRole;
  /** Custom display name (hired creatures); falls back to ROLE_META. */
  displayName?: string;
  enabled: boolean;
  mute: boolean;
  /** Channel level in dB. */
  volume: number;
  /** Tonal roles: voice preset id (see lib/voiceData.ts). */
  voiceId?: string;
  /** Drum roles: one step per subdivision of the current bar. */
  drumSteps?: boolean[];
  /** Bass/melody roles: contour preset id. */
  contourId?: string;
  /** Bass/melody roles: octave nudge applied to the base register. */
  octaveShift?: number;
  /** Melody tracks: ride a repeating contour or play a written lead sheet. */
  melodyMode?: 'contour' | 'written';
  /** Melody tracks in 'written' mode: the authored notes. */
  writtenNotes?: WrittenNote[];
  /** Chord organisms: follow the shared song lane or play their own. */
  harmonyMode?: 'follow' | 'own';
  /** Chord organisms in 'own' mode: their private chord lane. */
  customChords?: FoundrySettings[];
  /** Chord organisms in 'follow' mode: optional re-voicing of the song lane. */
  voicingOverride?: VoicingId;
  registerOverride?: RegisterId;
}

export interface RoleMeta {
  name: string;
  short: string;
  flavor: string;
}

export const ROLE_META: Record<PerformerRole, RoleMeta> = {
  kick: { name: 'Kick Stomper', short: 'KCK', flavor: 'Heavy-footed floor shaker' },
  snare: { name: 'Snare Snapper', short: 'SNR', flavor: 'Backbeat jaw-snap' },
  hihat: { name: 'Hat Skitterer', short: 'HAT', flavor: 'Restless metallic scuttler' },
  chords: { name: 'Harmonic Organism', short: 'CHD', flavor: 'Gravity-fed rib stack' },
  bass: { name: 'Bass Serpent', short: 'BAS', flavor: 'Low-end undulator' },
  melody: { name: 'Melody Wisp', short: 'MEL', flavor: 'High-register dart of light' }
};

export function performerName(p: PerformerState): string {
  return p.displayName ?? ROLE_META[p.role].name;
}

/** Base registers for the single-note creatures (octave shift is added on top). */
export const MELODY_BASE_OCTAVE: Record<'bass' | 'melody', number> = {
  bass: 2,
  melody: 5
};

export interface ContourPreset {
  id: string;
  name: string;
  flavor: string;
  steps: MelodyContourStep[];
}

const CORE_CONTOUR_PRESETS: ContourPreset[] = [
  {
    id: 'root-anchor',
    name: 'Root Anchor',
    flavor: 'One deep root held across the bar. The floor of the song.',
    steps: [{ sub: 0, tone: 'root', octave: 0, lengthSubs: 8 }]
  },
  {
    id: 'walking-pulse',
    name: 'Walking Pulse',
    flavor: 'Root, third, fifth, then a chromatic walk into the next chord.',
    steps: [
      { sub: 0, tone: 'root', octave: 0, lengthSubs: 2 },
      { sub: 2, tone: 'third', octave: 0, lengthSubs: 2 },
      { sub: 4, tone: 'fifth', octave: 0, lengthSubs: 2 },
      { sub: 6, tone: 'approach', octave: 0, lengthSubs: 2 }
    ]
  },
  {
    id: 'arpeggio-rise',
    name: 'Arpeggio Rise',
    flavor: 'Climbs the chord one tone at a time, bottom to top.',
    steps: [
      { sub: 0, tone: 'root', octave: 0, lengthSubs: 2 },
      { sub: 2, tone: 'third', octave: 0, lengthSubs: 2 },
      { sub: 4, tone: 'fifth', octave: 0, lengthSubs: 2 },
      { sub: 6, tone: 'seventh', octave: 0, lengthSubs: 2 }
    ]
  },
  {
    id: 'pendulum',
    name: 'Pendulum',
    flavor: 'Swings between the root and fifth, lifting an octave mid-bar.',
    steps: [
      { sub: 0, tone: 'root', octave: 0, lengthSubs: 2 },
      { sub: 2, tone: 'fifth', octave: 0, lengthSubs: 2 },
      { sub: 4, tone: 'root', octave: 1, lengthSubs: 2 },
      { sub: 6, tone: 'fifth', octave: 0, lengthSubs: 2 }
    ]
  },
  {
    id: 'pulse-eighths',
    name: 'Pulse Eighths',
    flavor: 'Driving root notes on every subdivision. Relentless.',
    steps: [
      { sub: 0, tone: 'root', octave: 0, lengthSubs: 1 },
      { sub: 1, tone: 'root', octave: 0, lengthSubs: 1 },
      { sub: 2, tone: 'root', octave: 0, lengthSubs: 1 },
      { sub: 3, tone: 'root', octave: 0, lengthSubs: 1 },
      { sub: 4, tone: 'root', octave: 0, lengthSubs: 1 },
      { sub: 5, tone: 'root', octave: 0, lengthSubs: 1 },
      { sub: 6, tone: 'root', octave: 0, lengthSubs: 1 },
      { sub: 7, tone: 'root', octave: 0, lengthSubs: 1 }
    ]
  },
  {
    id: 'sparse-call',
    name: 'Sparse Call',
    flavor: 'A held call, a short answer, then air. Leaves room to breathe.',
    steps: [
      { sub: 0, tone: 'fifth', octave: 0, lengthSubs: 3 },
      { sub: 4, tone: 'third', octave: 0, lengthSubs: 2 },
      { sub: 7, tone: 'approach', octave: 0, lengthSubs: 1 }
    ]
  }
];

/** Core contours plus every playing pattern contributed by the genre library. */
export const CONTOUR_PRESETS: ContourPreset[] = [...CORE_CONTOUR_PRESETS, ...LIBRARY_CONTOUR_PRESETS];

// --- Custom contour store (localStorage-backed, subscribable) ---

export const CUSTOM_CONTOURS_KEY = 'customContours';

let customContours: ContourPreset[] = [];
let contoursHydrated = false;
const contourListeners = new Set<() => void>();

function hydrateContours(): void {
  if (contoursHydrated || typeof window === 'undefined') return;
  contoursHydrated = true;
  try {
    const raw = readConservatoryStorage(CUSTOM_CONTOURS_KEY);
    customContours = raw ? (JSON.parse(raw) as ContourPreset[]) : [];
  } catch {
    customContours = [];
  }
}

function persistContours(): void {
  try {
    writeConservatoryStorage(CUSTOM_CONTOURS_KEY, JSON.stringify(customContours));
  } catch {
    // Storage unavailable; the in-memory registry still works.
  }
}

export function subscribeCustomContours(listener: () => void): () => void {
  contourListeners.add(listener);
  return () => contourListeners.delete(listener);
}

/** Stable snapshot for useSyncExternalStore; only replaced on mutation. */
export function getCustomContoursSnapshot(): ContourPreset[] {
  hydrateContours();
  return customContours;
}

const EMPTY_CONTOURS: ContourPreset[] = [];

export function getServerContoursSnapshot(): ContourPreset[] {
  return EMPTY_CONTOURS;
}

export function saveCustomContour(preset: ContourPreset): void {
  hydrateContours();
  customContours = [...customContours.filter(c => c.id !== preset.id), preset];
  persistContours();
  contourListeners.forEach(listener => listener());
}

export function removeCustomContour(id: string): void {
  hydrateContours();
  customContours = customContours.filter(c => c.id !== id);
  persistContours();
  contourListeners.forEach(listener => listener());
}

export function makeContourId(): string {
  return `contour-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function findContour(id: string | undefined): ContourPreset {
  hydrateContours();
  return CONTOUR_PRESETS.find(c => c.id === id) ?? customContours.find(c => c.id === id) ?? CONTOUR_PRESETS[0];
}

/**
 * Seeds a sensible default drum pattern from the grouping: kick stomps group
 * starts, snare snaps the right-side group starts, hats skitter every sub.
 */
export function seedDrumPattern(role: DrumRole, grouping: number[]): boolean[] {
  const steps: boolean[] = [];
  let side: 0 | 1 = 0;
  grouping.forEach(groupSize => {
    for (let i = 0; i < groupSize; i++) {
      const isStrong = i === 0;
      if (role === 'kick') steps.push(isStrong);
      else if (role === 'snare') steps.push(isStrong && side === 1);
      else steps.push(true);
    }
    side = side === 0 ? 1 : 0;
  });
  return steps;
}

/** Subdivision indices that start a group — highlighted in the step grids. */
export function strongSubIndices(grouping: number[]): number[] {
  const out: number[] = [];
  let idx = 0;
  grouping.forEach(groupSize => {
    out.push(idx);
    idx += groupSize;
  });
  return out;
}

export function makeDefaultCast(grouping: number[]): PerformerState[] {
  return [
    { id: 'kick', role: 'kick', enabled: true, mute: false, volume: -2, drumSteps: seedDrumPattern('kick', grouping) },
    { id: 'snare', role: 'snare', enabled: true, mute: false, volume: -6, drumSteps: seedDrumPattern('snare', grouping) },
    { id: 'hihat', role: 'hihat', enabled: true, mute: false, volume: -14, drumSteps: seedDrumPattern('hihat', grouping) },
    {
      id: 'chords',
      role: 'chords',
      enabled: true,
      mute: false,
      volume: -9,
      voiceId: 'glass-pad',
      harmonyMode: 'follow'
    },
    {
      id: 'bass',
      role: 'bass',
      enabled: true,
      mute: false,
      volume: -7,
      voiceId: 'soft-brass',
      contourId: 'root-anchor',
      octaveShift: 0
    },
    {
      id: 'melody',
      role: 'melody',
      enabled: true,
      mute: false,
      volume: -8,
      voiceId: 'glass-pad',
      contourId: 'arpeggio-rise',
      octaveShift: 0
    }
  ];
}

/** Ids of the always-present core cast (cannot be removed from the stage). */
export const CORE_IDS = new Set(['kick', 'snare', 'hihat', 'chords', 'bass', 'melody']);

let organismCounter = 0;

const ORGANISM_NAMES = ['Echo Organism', 'Shadow Organism', 'Aurora Organism', 'Drift Organism', 'Ember Organism'];

export function addChordOrganism(existingIds: string[], voiceId: string): PerformerState {
  organismCounter += 1;
  let id = `chords-${organismCounter}`;
  while (existingIds.includes(id)) {
    organismCounter += 1;
    id = `chords-${organismCounter}`;
  }
  const nameIndex = existingIds.filter(e => e.startsWith('chords-')).length % ORGANISM_NAMES.length;
  return {
    id,
    role: 'chords',
    displayName: ORGANISM_NAMES[nameIndex],
    enabled: true,
    mute: false,
    volume: -12,
    voiceId,
    harmonyMode: 'follow'
  };
}

// --- Creature library (built on the Melody Engine page, hired by the Stage) ---

export interface SavedCreature {
  id: string;
  name: string;
  kind: CreatureKind;
  voiceId: string;
  contourId: string;
  octaveShift: number;
}

export const CREATURE_LIBRARY_KEY = 'creatureLibrary';

export function makeCreatureId(): string {
  return `creature-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function hireCreature(saved: SavedCreature, existingIds: string[]): PerformerState {
  let id = `hired-${saved.id}`;
  let n = 1;
  while (existingIds.includes(id)) {
    id = `hired-${saved.id}-${n}`;
    n += 1;
  }
  return {
    id,
    role: saved.kind === 'bass' ? 'bass' : 'melody',
    displayName: saved.name,
    enabled: true,
    mute: false,
    volume: -10,
    voiceId: saved.voiceId,
    contourId: saved.contourId,
    octaveShift: saved.octaveShift
  };
}
