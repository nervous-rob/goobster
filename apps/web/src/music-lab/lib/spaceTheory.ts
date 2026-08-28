import { NOTE_NAMES, type NoteName } from './musicData';
import { MODES, SPACE_INTERVALS, type ModeDefinition, type ModeId, type SpaceIntervalDefinition } from './spaceData';

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export function pcOf(note: NoteName): number {
  return NOTE_NAMES.indexOf(note);
}

export function noteOfPc(pc: number): NoteName {
  return NOTE_NAMES[((pc % 12) + 12) % 12];
}

export function modeById(id: ModeId): ModeDefinition {
  return MODES.find(m => m.id === id) ?? MODES[1];
}

/** Ascending semitone offsets of the mode's seven degrees from its tonic. */
export function modeSteps(mode: ModeDefinition): number[] {
  const d = mode.majorDegree;
  return MAJOR_STEPS.map((_, i) => (MAJOR_STEPS[(d + i) % 7] - MAJOR_STEPS[d] + 12) % 12);
}

/** Raw circle-of-fifths steps (0..11, clockwise) from the tonic to a pitch class. */
export function fifthsSteps(pc: number, tonicPc: number): number {
  // 7 is its own inverse mod 12, so multiplying the chromatic distance by 7
  // converts semitone steps into fifth steps.
  return (((pc - tonicPc) * 7) % 12 + 12) % 12;
}

/**
 * Signed brightness of a pitch class relative to the tonic: how many fifths
 * sharp (+) or flat (−) it sits. The 12 chromatic notes are unwrapped into a
 * window centred on the current mode so its seven scale tones always form a
 * contiguous run (Lydian 0..+6 down to Locrian −6..0).
 */
export function brightnessK(pc: number, tonicPc: number, mode: ModeDefinition): number {
  const center = 3 - mode.brightnessRank;
  const lo = center - 6;
  return ((fifthsSteps(pc, tonicPc) - lo) % 12 + 12) % 12 + lo;
}

/** The seven pitch classes of the scale, in degree order. */
export function scalePcs(tonicPc: number, mode: ModeDefinition): number[] {
  return modeSteps(mode).map(s => (tonicPc + s) % 12);
}

/** A MIDI note for the pitch class, kept in a singable band around middle C (G3..F#4). */
export function midiNear(pc: number): number {
  return 60 + ((pc + 5) % 12) - 5;
}

export interface ScaleDegreeInfo {
  pc: number;
  note: NoteName;
  /** 0-based scale degree. */
  degreeIndex: number;
  /** Signed fifths offset from home. */
  k: number;
  semitones: number;
}

/** The scale's seven degrees sorted dark → bright, i.e. the run of consecutive fifths. */
export function buildScaleLadder(root: NoteName, mode: ModeDefinition): ScaleDegreeInfo[] {
  const tonicPc = pcOf(root);
  const steps = modeSteps(mode);
  return steps
    .map((semitones, degreeIndex) => {
      const pc = (tonicPc + semitones) % 12;
      return { pc, note: noteOfPc(pc), degreeIndex, k: brightnessK(pc, tonicPc, mode), semitones };
    })
    .sort((a, b) => a.k - b.k);
}

export type TriadQuality = 'major' | 'minor' | 'diminished';

export interface SpaceTriad {
  degreeIndex: number;
  numeral: string;
  root: NoteName;
  name: string;
  quality: TriadQuality;
  pcs: [number, number, number];
  midi: number[];
  /** Total pairwise circle-of-fifths distance — the triangle's harmonic reach. */
  spread: number;
}

function circularFifthsDistance(a: number, b: number, tonicPc: number): number {
  const d = Math.abs(fifthsSteps(a, tonicPc) - fifthsSteps(b, tonicPc));
  return Math.min(d, 12 - d);
}

export function buildDiatonicTriads(root: NoteName, mode: ModeDefinition): SpaceTriad[] {
  const tonicPc = pcOf(root);
  const steps = modeSteps(mode);
  return steps.map((step, i) => {
    const third = (steps[(i + 2) % 7] - step + 12) % 12;
    const fifth = (steps[(i + 4) % 7] - step + 12) % 12;
    const quality: TriadQuality = third === 4 ? 'major' : fifth === 6 ? 'diminished' : 'minor';
    const rootPc = (tonicPc + step) % 12;
    const pcs: [number, number, number] = [rootPc, (rootPc + third) % 12, (rootPc + fifth) % 12];
    const numeralBase = NUMERALS[i];
    const numeral =
      quality === 'major' ? numeralBase : quality === 'minor' ? numeralBase.toLowerCase() : `${numeralBase.toLowerCase()}°`;
    const rootNote = noteOfPc(rootPc);
    const name = quality === 'major' ? rootNote : quality === 'minor' ? `${rootNote}m` : `${rootNote}dim`;
    const rootMidi = midiNear(rootPc);
    const spread =
      circularFifthsDistance(pcs[0], pcs[1], tonicPc) +
      circularFifthsDistance(pcs[0], pcs[2], tonicPc) +
      circularFifthsDistance(pcs[1], pcs[2], tonicPc);
    return { degreeIndex: i, numeral, root: rootNote, name, quality, pcs, midi: [rootMidi, rootMidi + third, rootMidi + fifth], spread };
  });
}

export interface RelativeSpelling {
  mode: ModeDefinition;
  root: NoteName;
}

/** The seven names for the same seven stars: every mode-root pair sharing this note set. */
export function relativeSpellings(root: NoteName, mode: ModeDefinition): RelativeSpelling[] {
  const parentPc = (pcOf(root) - MAJOR_STEPS[mode.majorDegree] + 12) % 12;
  return MODES.map(m => ({ mode: m, root: noteOfPc((parentPc + MAJOR_STEPS[m.majorDegree]) % 12) }));
}

export function intervalForSemitones(semitones: number): SpaceIntervalDefinition {
  return SPACE_INTERVALS.find(i => i.semitones === semitones) ?? SPACE_INTERVALS[6];
}

/** Tonic-to-tonic ascending scale as MIDI, ready for melodic playback. */
export function scaleMidiSequence(root: NoteName, mode: ModeDefinition): number[] {
  const tonicMidi = midiNear(pcOf(root));
  return [...modeSteps(mode).map(s => tonicMidi + s), tonicMidi + 12];
}
