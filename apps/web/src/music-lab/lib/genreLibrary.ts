import jazz from '@music-lab/data/genres/jazz.json';
import bigband from '@music-lab/data/genres/bigband.json';
import blues from '@music-lab/data/genres/blues.json';
import rock from '@music-lab/data/genres/rock.json';
import metal from '@music-lab/data/genres/metal.json';
import punk from '@music-lab/data/genres/punk.json';
import folk from '@music-lab/data/genres/folk.json';
import country from '@music-lab/data/genres/country.json';
import funk from '@music-lab/data/genres/funk.json';
import soul from '@music-lab/data/genres/soul.json';
import reggae from '@music-lab/data/genres/reggae.json';
import latin from '@music-lab/data/genres/latin.json';
import electronic from '@music-lab/data/genres/electronic.json';
import hiphop from '@music-lab/data/genres/hiphop.json';

import type { ProgressionPreset, ScaleMode } from './harmonyData';
import type { MelodyContourStep } from './melodyTheory';
import type { GridResolution } from './rhythmTheory';
import type { ContourPreset, CreatureKind, DrumRole } from './stageData';
import type { SongTemplate, TemplateSectionSpec, StudioPartId } from './songTemplates';
import type { SectionKind } from './songData';
import { GENERIC_BAR_SUBS } from './melodyTheory';
import { VOICE_PRESETS } from './voiceData';
import { RHYTHMS } from './rhythmData';

/**
 * Genre library loader. Reads the JSON files in data/genres/ — a growing,
 * key-agnostic catalogue of musical idioms — and exposes them in the shapes
 * the rest of the app already understands:
 *
 * - progressions: Roman-numeral interval recipes (voiced in any key later)
 * - contours: chord-degree patterns on the generic 8-sub bar (any chord, key)
 * - drum patterns: generic-bar boolean grids (8 steps for eighth feels, 16
 *   for sixteenth feels), stretched to any meter grouping
 * - creatures: a tone (voice preset + register) married to a playing pattern
 * - grooves: one-tap feels — BPM, swing, meter, grid resolution, drum pattern
 * - songs: full structure templates (sections, energy, harmony, arrangement)
 *
 * IMPORTANT: this module must stay a runtime leaf (only JSON + leaf data
 * modules as value imports; everything else type-only). harmonyData,
 * stageData, creatureRecommend, and songTemplates import from it to merge the
 * library into their preset arrays — value imports back into those modules
 * would create cycles.
 */

// --- Raw JSON shapes (loosely typed; validated then narrowed below) ---

interface RawContourStep {
  sub: number;
  tone: string;
  octave: number;
  lengthSubs: number;
}

interface RawContour {
  id: string;
  name: string;
  flavor: string;
  tags?: { density: number; energy: number; bass: number; lead: number };
  steps: RawContourStep[];
}

interface RawProgression {
  id: string;
  name: string;
  mode: string;
  numerals: string[];
  feel: string;
}

interface RawDrumPattern {
  id: string;
  name: string;
  energy: number;
  blurb: string;
  steps: { kick: boolean[]; snare: boolean[]; hihat: boolean[] };
}

interface RawCreature {
  id: string;
  name: string;
  kind: string;
  voiceId: string;
  contourId: string;
  octaveShift: number;
  flavor: string;
}

interface RawSection {
  kind: string;
  name?: string;
  measures: number;
  energy: number;
  progressionId: string;
  measuresPerChord: number;
  parts: string[];
}

interface RawGroove {
  id: string;
  name: string;
  blurb: string;
  bpm: number;
  swing: number;
  rhythmId: string;
  resolution?: string;
  drumPatternId: string;
}

interface RawSong {
  id: string;
  name: string;
  blurb: string;
  bpm: number;
  rhythmId: string;
  swing?: number;
  resolution?: string;
  suggest?: {
    drumPatternId?: string;
    chordsVoiceId?: string;
    bassCreatureId?: string;
    leadCreatureId?: string;
  };
  sections: RawSection[];
}

interface RawGenreLibrary {
  id: string;
  label: string;
  blurb: string;
  progressions: RawProgression[];
  contours: RawContour[];
  drumPatterns: RawDrumPattern[];
  creatures: RawCreature[];
  grooves?: RawGroove[];
  songs: RawSong[];
}

const SOURCES: RawGenreLibrary[] = [
  jazz,
  bigband,
  blues,
  rock,
  metal,
  punk,
  folk,
  country,
  funk,
  soul,
  reggae,
  latin,
  electronic,
  hiphop
];

// --- Validation (warn and skip rather than crash on a bad entry) ---

/** Mirrors parsePresetNumeral in harmonyTheory (no value import allowed here). */
const NUMERAL_RE = /^(♭*)([ivIV]+)(°?)(maj7|7)?$/;
const CONTOUR_TONES = new Set(['root', 'third', 'fifth', 'seventh', 'approach', 'rest']);
const SECTION_KIND_IDS = new Set(['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'outro', 'custom']);
const STUDIO_PART_IDS = new Set(['drums', 'chords', 'bass', 'lead']);
/** Core progression ids living in harmonyData (library ids are added below). */
const CORE_PROGRESSION_IDS = new Set([
  'axis',
  'axis-emotional',
  'jazz-251',
  'doo-wop',
  'rock-backdoor',
  'folk-145',
  'minor-cinematic',
  'andalusian',
  'blues-12'
]);

const VOICE_IDS = new Set(VOICE_PRESETS.map(v => v.id));
const RHYTHM_IDS = new Set(RHYTHMS.map(r => r.id));

function warn(genre: string, message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[genreLibrary] ${genre}: ${message}`);
}

function isValidContour(genre: string, contour: RawContour): boolean {
  const ok = contour.steps.every(
    s =>
      CONTOUR_TONES.has(s.tone) &&
      s.sub >= 0 &&
      s.sub < GENERIC_BAR_SUBS &&
      s.lengthSubs >= 1 &&
      (s.octave === -1 || s.octave === 0 || s.octave === 1)
  );
  if (!ok) warn(genre, `contour "${contour.id}" has invalid steps — skipped`);
  return ok;
}

function isValidProgression(genre: string, progression: RawProgression): boolean {
  if (progression.mode !== 'major' && progression.mode !== 'minor') {
    warn(genre, `progression "${progression.id}" has unknown mode "${progression.mode}" — skipped`);
    return false;
  }
  const bad = progression.numerals.filter(n => !NUMERAL_RE.test(n));
  if (bad.length) {
    warn(genre, `progression "${progression.id}" has unparseable numerals (${bad.join(', ')}) — skipped`);
    return false;
  }
  return true;
}

function isValidDrumPattern(genre: string, pattern: RawDrumPattern): boolean {
  const roles: (keyof RawDrumPattern['steps'])[] = ['kick', 'snare', 'hihat'];
  // 8 steps = generic eighth-note bar, 16 = generic sixteenth-note bar.
  const length = pattern.steps.kick.length;
  const ok = (length === GENERIC_BAR_SUBS || length === GENERIC_BAR_SUBS * 2) &&
    roles.every(role => pattern.steps[role].length === length);
  if (!ok) {
    warn(genre, `drum pattern "${pattern.id}" must have ${GENERIC_BAR_SUBS} or ${GENERIC_BAR_SUBS * 2} steps per role — skipped`);
  }
  return ok;
}

function parseResolution(value: string | undefined): GridResolution | null {
  if (value === undefined) return 'eighth';
  return value === 'eighth' || value === 'sixteenth' ? value : null;
}

// --- Typed library exports ---

export interface GenreInfo {
  id: string;
  label: string;
  blurb: string;
}

export interface LibraryDrumPattern {
  id: string;
  name: string;
  energy: number;
  blurb: string;
  genre: string;
  /** Grid feel the pattern was authored at (8 generic steps vs 16). */
  resolution: GridResolution;
  /** Generic-bar steps (8 or 16 per role); stretch with stretchDrumSteps. */
  steps: Record<DrumRole, boolean[]>;
}

/** A one-tap feel: tempo, swing, meter, grid resolution, and a drum pattern. */
export interface LibraryGroove {
  id: string;
  name: string;
  blurb: string;
  genre: string;
  bpm: number;
  swing: number;
  rhythmId: string;
  resolution: GridResolution;
  drumPatternId: string;
}

export interface LibraryCreature {
  id: string;
  name: string;
  kind: CreatureKind;
  voiceId: string;
  contourId: string;
  octaveShift: number;
  flavor: string;
  genre: string;
}

export interface LibraryContourTags {
  density: number;
  energy: number;
  bass: number;
  lead: number;
}

export const GENRES: GenreInfo[] = [];
export const LIBRARY_PROGRESSION_PRESETS: ProgressionPreset[] = [];
export const LIBRARY_CONTOUR_PRESETS: ContourPreset[] = [];
export const LIBRARY_CONTOUR_TAGS: Record<string, LibraryContourTags> = {};
export const LIBRARY_DRUM_PATTERNS: LibraryDrumPattern[] = [];
export const LIBRARY_CREATURES: LibraryCreature[] = [];
export const LIBRARY_GROOVES: LibraryGroove[] = [];
export const LIBRARY_SONG_TEMPLATES: SongTemplate[] = [];

const knownProgressionIds = new Set(CORE_PROGRESSION_IDS);

SOURCES.forEach(source => {
  GENRES.push({ id: source.id, label: source.label, blurb: source.blurb });

  source.progressions.forEach(p => {
    if (!isValidProgression(source.id, p)) return;
    LIBRARY_PROGRESSION_PRESETS.push({
      id: p.id,
      name: `${source.label} · ${p.name}`,
      mode: p.mode as ScaleMode,
      numerals: p.numerals,
      feel: p.feel
    });
    knownProgressionIds.add(p.id);
  });

  source.contours.forEach(c => {
    if (!isValidContour(source.id, c)) return;
    LIBRARY_CONTOUR_PRESETS.push({
      id: c.id,
      name: c.name,
      flavor: c.flavor,
      steps: c.steps as MelodyContourStep[]
    });
    if (c.tags) LIBRARY_CONTOUR_TAGS[c.id] = c.tags;
  });

  source.drumPatterns.forEach(p => {
    if (!isValidDrumPattern(source.id, p)) return;
    LIBRARY_DRUM_PATTERNS.push({
      id: p.id,
      name: p.name,
      energy: p.energy,
      blurb: p.blurb,
      genre: source.label,
      resolution: p.steps.kick.length === GENERIC_BAR_SUBS * 2 ? 'sixteenth' : 'eighth',
      steps: { kick: p.steps.kick, snare: p.steps.snare, hihat: p.steps.hihat }
    });
  });

  source.creatures.forEach(c => {
    if (c.kind !== 'bass' && c.kind !== 'lead') {
      warn(source.id, `creature "${c.id}" has unknown kind "${c.kind}" — skipped`);
      return;
    }
    if (!VOICE_IDS.has(c.voiceId)) {
      warn(source.id, `creature "${c.id}" references unknown voice "${c.voiceId}" — skipped`);
      return;
    }
    LIBRARY_CREATURES.push({
      id: c.id,
      name: c.name,
      kind: c.kind,
      voiceId: c.voiceId,
      contourId: c.contourId,
      octaveShift: c.octaveShift,
      flavor: c.flavor,
      genre: source.label
    });
  });
});

// Grooves and songs are built in a second pass so they can reference
// creatures and drum patterns from any genre, and sections any progression.
SOURCES.forEach(source => {
  (source.grooves ?? []).forEach(groove => {
    const resolution = parseResolution(groove.resolution);
    if (!resolution) {
      warn(source.id, `groove "${groove.id}" has unknown resolution "${groove.resolution}" — skipped`);
      return;
    }
    if (!RHYTHM_IDS.has(groove.rhythmId)) {
      warn(source.id, `groove "${groove.id}" references unknown rhythm "${groove.rhythmId}" — skipped`);
      return;
    }
    if (!LIBRARY_DRUM_PATTERNS.some(p => p.id === groove.drumPatternId)) {
      warn(source.id, `groove "${groove.id}" references unknown drum pattern "${groove.drumPatternId}" — skipped`);
      return;
    }
    LIBRARY_GROOVES.push({
      id: groove.id,
      name: groove.name,
      blurb: groove.blurb,
      genre: source.label,
      bpm: groove.bpm,
      swing: groove.swing,
      rhythmId: groove.rhythmId,
      resolution,
      drumPatternId: groove.drumPatternId
    });
  });

  source.songs.forEach(song => {
    if (!RHYTHM_IDS.has(song.rhythmId)) {
      warn(source.id, `song "${song.id}" references unknown rhythm "${song.rhythmId}" — skipped`);
      return;
    }
    const resolution = parseResolution(song.resolution);
    if (!resolution) {
      warn(source.id, `song "${song.id}" has unknown resolution "${song.resolution}" — skipped`);
      return;
    }

    const sections: TemplateSectionSpec[] = [];
    let sectionsOk = true;
    song.sections.forEach(section => {
      if (!SECTION_KIND_IDS.has(section.kind) || !section.parts.every(p => STUDIO_PART_IDS.has(p))) {
        warn(source.id, `song "${song.id}" has an invalid section (kind/parts) — song skipped`);
        sectionsOk = false;
        return;
      }
      if (!knownProgressionIds.has(section.progressionId)) {
        warn(source.id, `song "${song.id}" section references unknown progression "${section.progressionId}"`);
      }
      sections.push({
        kind: section.kind as SectionKind,
        name: section.name,
        measures: section.measures,
        energy: section.energy,
        progressionId: section.progressionId,
        measuresPerChord: section.measuresPerChord,
        parts: section.parts as StudioPartId[]
      });
    });
    if (!sectionsOk) return;

    const bassCreature = LIBRARY_CREATURES.find(c => c.id === song.suggest?.bassCreatureId);
    const leadCreature = LIBRARY_CREATURES.find(c => c.id === song.suggest?.leadCreatureId);

    LIBRARY_SONG_TEMPLATES.push({
      id: song.id,
      name: song.name,
      blurb: song.blurb,
      bpm: song.bpm,
      rhythmId: song.rhythmId,
      swing: song.swing ?? 0,
      resolution,
      genre: source.label,
      sections,
      suggest: {
        drumVariantId: song.suggest?.drumPatternId,
        chordsVoiceId: song.suggest?.chordsVoiceId,
        bass: bassCreature
          ? {
              name: bassCreature.name,
              voiceId: bassCreature.voiceId,
              contourId: bassCreature.contourId,
              octaveShift: bassCreature.octaveShift
            }
          : undefined,
        lead: leadCreature
          ? {
              name: leadCreature.name,
              voiceId: leadCreature.voiceId,
              contourId: leadCreature.contourId,
              octaveShift: leadCreature.octaveShift
            }
          : undefined
      }
    });
  });
});

export function findLibraryDrumPattern(id: string | undefined): LibraryDrumPattern | null {
  if (!id) return null;
  return LIBRARY_DRUM_PATTERNS.find(p => p.id === id) ?? null;
}

export function findLibraryCreature(id: string | undefined): LibraryCreature | null {
  if (!id) return null;
  return LIBRARY_CREATURES.find(c => c.id === id) ?? null;
}

export function findLibraryGroove(id: string | undefined): LibraryGroove | null {
  if (!id) return null;
  return LIBRARY_GROOVES.find(g => g.id === id) ?? null;
}

/**
 * Stretches a generic-bar boolean step row (8 or 16 steps) onto an arbitrary
 * grid grouping (onset mapping, same rounding scheme as resolveContour): each
 * generic onset lands on its nearest subdivision of the actual bar.
 */
export function stretchDrumSteps(steps: boolean[], grouping: number[]): boolean[] {
  const total = grouping.reduce((a, b) => a + b, 0);
  const out = Array<boolean>(total).fill(false);
  if (total <= 0) return out;
  const source = steps.length || GENERIC_BAR_SUBS;
  steps.forEach((on, genericIndex) => {
    if (!on) return;
    const index = Math.min(total - 1, Math.max(0, Math.round((genericIndex * total) / source)));
    out[index] = true;
  });
  return out;
}
