import type { HarmonyGenome } from './harmonyTheory';

/**
 * Melody engine core: contour patterns are authored against a generic bar and
 * resolved into concrete MIDI lanes by following the active chord genome.
 * Bass lines and lead melodies are the same machinery at different registers.
 */

export type ContourTone = 'root' | 'third' | 'fifth' | 'seventh' | 'approach' | 'rest';

/** Contours are authored against this many subdivisions and stretched to fit the bar. */
export const GENERIC_BAR_SUBS = 8;

export interface MelodyContourStep {
  /** Onset position within the generic bar (0..GENERIC_BAR_SUBS-1). */
  sub: number;
  tone: ContourTone;
  /** Octave offset relative to the performer's base register. */
  octave: -1 | 0 | 1;
  /** Held length in generic subdivisions. */
  lengthSubs: number;
}

export interface ResolvedNote {
  midi: number;
  /** Held length in actual subdivisions of the current bar. */
  durSubs: number;
}

function chordTonePc(genome: HarmonyGenome, tone: 'root' | 'third' | 'fifth' | 'seventh'): number {
  const intervals = genome.intervals;
  switch (tone) {
    case 'root':
      return genome.rootPc;
    case 'third':
      return genome.rootPc + (intervals[1] ?? 4);
    case 'fifth':
      return genome.rootPc + (intervals[2] ?? 7);
    case 'seventh':
      // No seventh in the stack: voice the color tone an octave up instead.
      return intervals.length > 3 ? genome.rootPc + intervals[3] : genome.rootPc + (intervals[1] ?? 4) + 12;
  }
}

function toneMidi(
  genome: HarmonyGenome,
  tone: 'root' | 'third' | 'fifth' | 'seventh',
  baseOctave: number,
  octaveShift: number
): number {
  return (baseOctave + 1 + octaveShift) * 12 + chordTonePc(genome, tone);
}

/**
 * Resolves a contour against one chord into a per-subdivision note lane.
 * Approach tones walk a half-step into the next sounded tone (or into the
 * next chord's root at the bar line).
 */
export function resolveContour(
  steps: MelodyContourStep[],
  genome: HarmonyGenome,
  nextGenome: HarmonyGenome | null,
  baseOctave: number,
  subdivisions: number
): (ResolvedNote | null)[] {
  const lane: (ResolvedNote | null)[] = Array(subdivisions).fill(null);
  if (subdivisions <= 0) return lane;
  const scale = subdivisions / GENERIC_BAR_SUBS;

  steps.forEach(step => {
    if (step.tone === 'rest') return;
    const index = Math.min(subdivisions - 1, Math.max(0, Math.round(step.sub * scale)));
    if (lane[index] !== null) return;
    const durSubs = Math.max(1, Math.round(step.lengthSubs * scale));
    if (step.tone === 'approach') {
      // Placeholder midi; filled in once chord tones are placed.
      lane[index] = { midi: -1, durSubs };
    } else {
      lane[index] = { midi: toneMidi(genome, step.tone, baseOctave, step.octave), durSubs };
    }
  });

  for (let i = 0; i < subdivisions; i++) {
    const note = lane[i];
    if (!note || note.midi !== -1) continue;
    let target: number | null = null;
    for (let j = i + 1; j < subdivisions; j++) {
      const later = lane[j];
      if (later && later.midi !== -1) {
        target = later.midi;
        break;
      }
    }
    if (target === null) {
      target = toneMidi(nextGenome ?? genome, 'root', baseOctave, 0);
    }
    note.midi = target - 1;
  }

  // Trim held lengths so no note rings past the next onset.
  for (let i = 0; i < subdivisions; i++) {
    const note = lane[i];
    if (!note) continue;
    for (let j = i + 1; j < subdivisions; j++) {
      if (lane[j]) {
        note.durSubs = Math.min(note.durSubs, j - i);
        break;
      }
    }
    note.durSubs = Math.min(note.durSubs, subdivisions - i);
  }

  return lane;
}

/**
 * Expands a contour across a whole progression phrase:
 * one lane per logical measure, following the chord active in that measure.
 */
export function buildMelodyLane(
  steps: MelodyContourStep[],
  progression: HarmonyGenome[],
  measuresPerChord: number,
  subdivisions: number,
  baseOctave: number
): (ResolvedNote | null)[][] {
  const chordCount = progression.length;
  if (!chordCount) return [];
  const perChord = Math.max(1, measuresPerChord);
  const totalMeasures = chordCount * perChord;
  const lanes: (ResolvedNote | null)[][] = [];
  for (let m = 0; m < totalMeasures; m++) {
    const chordIndex = Math.floor(m / perChord) % chordCount;
    const isLastMeasureOfChord = m % perChord === perChord - 1;
    const next = isLastMeasureOfChord ? progression[(chordIndex + 1) % chordCount] : progression[chordIndex];
    lanes.push(resolveContour(steps, progression[chordIndex], next, baseOctave, subdivisions));
  }
  return lanes;
}
