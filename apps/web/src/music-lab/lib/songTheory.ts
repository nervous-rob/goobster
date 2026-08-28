import type { NoteName } from './musicData';
import { PROGRESSION_PRESETS } from './harmonyData';
import {
  buildHarmonyGenome,
  buildPresetProgression,
  pcOf,
  type FoundrySettings,
  type HarmonyGenome
} from './harmonyTheory';
import { resolveContour, type MelodyContourStep, type ResolvedNote } from './melodyTheory';
import type { WrittenNote } from './stageData';
import type { SongClip, SongSection } from './songData';

/**
 * Song flattening: walks the ordered sections of a project and produces an
 * absolute-measure view of the whole song — which chord is active in every
 * measure, where chord windows start, and where sections begin. Everything the
 * song orchestrator and the timeline UI need to address time by measure.
 */

export interface SectionSpan {
  section: SongSection;
  /** 0-based absolute measure where the section begins. */
  startMeasure: number;
  /** Exclusive end measure. */
  endMeasure: number;
}

export interface ChordSpan {
  genome: HarmonyGenome;
  sectionId: string;
  /** Index of the chord within its section's lane. */
  chordIndex: number;
  startMeasure: number;
  /** Exclusive end measure. */
  endMeasure: number;
}

export interface FlattenedSong {
  totalMeasures: number;
  sectionSpans: SectionSpan[];
  chordSpans: ChordSpan[];
  /** Active chord genome per absolute measure (null in chordless sections). */
  chordByMeasure: (HarmonyGenome | null)[];
  /** Chord of the following measure — feeds approach-tone resolution. */
  nextChordByMeasure: (HarmonyGenome | null)[];
  /** Index into chordSpans per measure (-1 where no chord is active). */
  spanIndexByMeasure: number[];
}

export function flattenSong(sections: SongSection[]): FlattenedSong {
  const sectionSpans: SectionSpan[] = [];
  const chordSpans: ChordSpan[] = [];
  const chordByMeasure: (HarmonyGenome | null)[] = [];
  const spanIndexByMeasure: number[] = [];

  let cursor = 0;
  sections.forEach(section => {
    const measures = Math.max(1, Math.round(section.measures));
    sectionSpans.push({ section, startMeasure: cursor, endMeasure: cursor + measures });

    const perChord = Math.max(1, Math.round(section.measuresPerChord));
    const genomes = section.chords.map(buildHarmonyGenome);
    let local = 0;
    let chordIndex = 0;
    while (local < measures) {
      const length = Math.min(perChord, measures - local);
      const genome = genomes.length ? genomes[chordIndex % genomes.length] : null;
      if (genome) {
        chordSpans.push({
          genome,
          sectionId: section.id,
          chordIndex: chordIndex % genomes.length,
          startMeasure: cursor + local,
          endMeasure: cursor + local + length
        });
      }
      for (let m = 0; m < length; m++) {
        chordByMeasure.push(genome);
        spanIndexByMeasure.push(genome ? chordSpans.length - 1 : -1);
      }
      local += length;
      chordIndex += 1;
    }

    cursor += measures;
  });

  const totalMeasures = cursor;
  const nextChordByMeasure: (HarmonyGenome | null)[] = [];
  for (let m = 0; m < totalMeasures; m++) {
    nextChordByMeasure.push(chordByMeasure[m + 1] ?? chordByMeasure[0] ?? null);
  }

  return { totalMeasures, sectionSpans, chordSpans, chordByMeasure, nextChordByMeasure, spanIndexByMeasure };
}

export function sectionAtMeasure(flat: FlattenedSong, measure: number): SectionSpan | null {
  return flat.sectionSpans.find(s => measure >= s.startMeasure && measure < s.endMeasure) ?? null;
}

// --- Per-track runtime material ---

/** One boolean per absolute measure: is the track's pattern audible there? */
export function buildClipCoverage(clips: SongClip[], trackId: string, totalMeasures: number): boolean[] {
  const coverage = Array<boolean>(totalMeasures).fill(false);
  clips.forEach(clip => {
    if (clip.trackId !== trackId) return;
    const start = Math.max(0, clip.startMeasure);
    const end = Math.min(totalMeasures, clip.startMeasure + clip.lengthMeasures);
    for (let m = start; m < end; m++) coverage[m] = true;
  });
  return coverage;
}

/**
 * Resolves a contour across the entire flattened song: one lane per absolute
 * measure, following whichever chord is active there.
 */
export function buildSongMelodyLane(
  steps: MelodyContourStep[],
  flat: FlattenedSong,
  subdivisions: number,
  baseOctave: number
): (ResolvedNote | null)[][] {
  const lanes: (ResolvedNote | null)[][] = [];
  for (let m = 0; m < flat.totalMeasures; m++) {
    const genome = flat.chordByMeasure[m];
    if (!genome) {
      lanes.push(Array(subdivisions).fill(null));
      continue;
    }
    lanes.push(resolveContour(steps, genome, flat.nextChordByMeasure[m], baseOctave, subdivisions));
  }
  return lanes;
}

/**
 * Places written lead-sheet notes into the per-measure note lanes the
 * orchestrator plays. Pitches are key-relative, so the lead transposes with
 * the song; notes outside the current grid are skipped (not deleted), so a
 * meter or resolution change is non-destructive.
 */
export function buildWrittenMelodyLane(
  notes: WrittenNote[],
  totalMeasures: number,
  subdivisions: number,
  keyRoot: NoteName,
  baseOctave: number
): (ResolvedNote | null)[][] {
  const lanes: (ResolvedNote | null)[][] = Array.from({ length: totalMeasures }, () =>
    Array<ResolvedNote | null>(subdivisions).fill(null)
  );
  const rootMidi = 12 * (baseOctave + 1) + pcOf(keyRoot);
  notes.forEach(note => {
    if (note.measure < 0 || note.measure >= totalMeasures) return;
    if (note.sub < 0 || note.sub >= subdivisions) return;
    lanes[note.measure][note.sub] = { midi: rootMidi + note.pitch, durSubs: Math.max(1, note.durSubs) };
  });
  return lanes;
}

export interface ChordEvent {
  midi: number[];
  /** How many measures the strum is held (clipped to coverage and span). */
  holdMeasures: number;
}

/**
 * Chord-track strums per measure: a strum fires where a chord window begins,
 * or where a clip fades the track back in mid-window. Hold is clipped to both
 * the chord window and the contiguous clip coverage.
 */
export function buildChordEvents(
  flat: FlattenedSong,
  coverage: boolean[],
  reVoice?: (settings: FoundrySettings) => HarmonyGenome
): (ChordEvent | null)[] {
  const events: (ChordEvent | null)[] = Array(flat.totalMeasures).fill(null);
  for (let m = 0; m < flat.totalMeasures; m++) {
    if (!coverage[m]) continue;
    const spanIndex = flat.spanIndexByMeasure[m];
    if (spanIndex < 0) continue;
    const span = flat.chordSpans[spanIndex];
    const isWindowStart = m === span.startMeasure;
    const isCoverageStart = m === 0 || !coverage[m - 1];
    if (!isWindowStart && !isCoverageStart) continue;

    let hold = 0;
    for (let k = m; k < span.endMeasure && coverage[k]; k++) hold += 1;
    const genome = reVoice ? reVoice(span.genome) : span.genome;
    events[m] = { midi: genome.midi, holdMeasures: Math.max(1, hold) };
  }
  return events;
}

// --- Section chord seeding ---

export function extractFoundry(genome: HarmonyGenome): FoundrySettings {
  return {
    root: genome.root,
    quality: genome.quality,
    extension: genome.extension,
    inversion: genome.inversion,
    voicing: genome.voicing,
    register: genome.register
  };
}

/** Seeds a section chord lane from a progression preset, voiced in the key. */
export function seedSectionChords(progressionId: string, keyRoot: NoteName): FoundrySettings[] {
  const preset = PROGRESSION_PRESETS.find(p => p.id === progressionId) ?? PROGRESSION_PRESETS[0];
  return buildPresetProgression(preset, keyRoot).map(step => extractFoundry(step.genome));
}
