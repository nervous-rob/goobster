import type { NoteName } from './musicData';
import type { FoundrySettings } from './harmonyTheory';
import { readConservatoryStorage, removeConservatoryStorage, writeConservatoryStorage } from './storage';

/**
 * Cross-engine handoff: every engine's output can travel to the Stage or the
 * Studio with one click.
 *
 * - The Stage's whole state lives in localStorage keys, so handing a groove
 *   or chord lane to it is just writing those keys before navigating.
 * - The Studio owns a rich project document, so it gets an inbox instead:
 *   engines queue a payload here and StudioEngine applies it (with full
 *   project context) on its next mount.
 */

// Keys mirrored from StageEngine's useLocalStorage hooks.
const STAGE_BPM_KEY = 'stageBpm';
const STAGE_SWING_KEY = 'stageSwing';
const STAGE_RHYTHM_KEY = 'stageRhythmId';
const STAGE_GROOVE_KEY = 'stageGrooveId';
const STAGE_SONG_CHORDS_KEY = 'stageSongChords';
const STAGE_KEY_ROOT_KEY = 'stageKeyRoot';

/** The Stage's song lane is capped at this many chord slots. */
const STAGE_MAX_CHORDS = 8;

function write(key: string, value: unknown): void {
  writeConservatoryStorage(key, JSON.stringify(value));
}

export interface GrooveHandoff {
  bpm: number;
  swing: number;
  rhythmId: string;
}

/** Sets the Stage's transport feel; takes effect when /stage mounts. */
export function sendGrooveToStage(groove: GrooveHandoff): void {
  write(STAGE_BPM_KEY, Math.round(groove.bpm));
  write(STAGE_SWING_KEY, Math.max(0, Math.min(0.5, groove.swing)));
  write(STAGE_RHYTHM_KEY, groove.rhythmId);
  write(STAGE_GROOVE_KEY, '');
}

/** Replaces the Stage's shared song lane with a progression, voiced as built. */
export function sendChordsToStage(chords: FoundrySettings[], keyRoot: NoteName): void {
  write(STAGE_SONG_CHORDS_KEY, chords.slice(0, STAGE_MAX_CHORDS));
  write(STAGE_KEY_ROOT_KEY, keyRoot);
}

/** Appends one forged chord to the Stage's song lane; returns the lane size. */
export function appendChordToStage(chord: FoundrySettings): number {
  let lane: FoundrySettings[] = [];
  try {
    const raw = readConservatoryStorage(STAGE_SONG_CHORDS_KEY);
    lane = raw ? (JSON.parse(raw) as FoundrySettings[]) : [];
  } catch {
    lane = [];
  }
  lane = [...lane, chord].slice(-STAGE_MAX_CHORDS);
  write(STAGE_SONG_CHORDS_KEY, lane);
  return lane.length;
}

// --- Studio inbox ---

export const STUDIO_HANDOFF_KEY = 'studioHandoff';

export type StudioHandoff =
  | { type: 'groove'; bpm: number; swing: number; rhythmId: string; label: string }
  | { type: 'chords'; name: string; keyRoot: NoteName; chords: FoundrySettings[] };

export function queueStudioHandoff(handoff: StudioHandoff): void {
  write(STUDIO_HANDOFF_KEY, handoff);
}

/** Reads and clears the pending handoff (consumed by StudioEngine on mount). */
export function takeStudioHandoff(): StudioHandoff | null {
  try {
    const raw = readConservatoryStorage(STUDIO_HANDOFF_KEY);
    if (!raw) return null;
    removeConservatoryStorage(STUDIO_HANDOFF_KEY);
    return JSON.parse(raw) as StudioHandoff;
  } catch {
    return null;
  }
}
