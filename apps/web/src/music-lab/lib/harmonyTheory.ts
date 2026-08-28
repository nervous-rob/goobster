import { NOTE_NAMES, type NoteName } from './musicData';
import {
  CHORD_QUALITIES,
  CHORD_SUFFIXES,
  DEGREE_INFO,
  DIATONIC_TARGET_QUALITY,
  EXTENSIONS,
  FN_TENSION_BONUS,
  FUNCTION_LABELS,
  GRAVITY_MAP_LAYOUT,
  RESOLUTION_RULES,
  REGISTER_OCTAVES,
  TONE_ANATOMY,
  type ChordQualityId,
  type ExtensionId,
  type HarmonicFunction,
  type ProgressionPreset,
  type QuizLevel,
  type QuizOption,
  type RegisterId,
  type ScaleMode,
  type VoicingId
} from './harmonyData';

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// --- Pitch model (MIDI-based; NoteName has no octave) ---

export function pcOf(note: NoteName): number {
  return NOTE_NAMES.indexOf(note);
}

export function noteOfPc(pc: number): NoteName {
  return NOTE_NAMES[((pc % 12) + 12) % 12];
}

export function midiFromNote(root: NoteName, octave: number): number {
  return 12 * (octave + 1) + pcOf(root);
}

export function chordIntervals(quality: ChordQualityId, extension: ExtensionId): number[] {
  const base = CHORD_QUALITIES.find(q => q.id === quality)?.intervals ?? [0, 4, 7];
  const ext = EXTENSIONS.find(e => e.id === extension);
  return [...base, ...(ext?.adds ?? [])];
}

export function allowedExtensionsFor(quality: ChordQualityId) {
  return EXTENSIONS.filter(e => e.allowed.includes(quality));
}

export interface VoicingOptions {
  inversion: number;
  voicing: VoicingId;
  octave: number;
}

/**
 * Voices a chord into concrete MIDI notes: closed stack → inversion → voicing
 * transform → range normalization. Returns notes sorted ascending.
 */
export function voiceChord(rootPc: number, intervals: number[], opts: VoicingOptions): number[] {
  const rootMidi = 12 * (opts.octave + 1) + rootPc;
  let notes = intervals.map(i => rootMidi + i).sort((a, b) => a - b);

  const inv = Math.max(0, Math.min(opts.inversion, notes.length - 1));
  for (let k = 0; k < inv; k++) {
    const low = notes.shift();
    if (low !== undefined) notes.push(low + 12);
  }
  notes.sort((a, b) => a - b);

  switch (opts.voicing) {
    case 'open':
      notes = notes.map((n, i) => (i % 2 === 1 ? n + 12 : n));
      break;
    case 'drop2':
      if (notes.length >= 3) {
        notes[notes.length - 2] -= 12;
      }
      break;
    case 'spread':
      if (notes.length >= 2) {
        notes[0] -= 12;
        notes[notes.length - 1] += 12;
      }
      break;
    case 'cluster': {
      // Pull every voice to its nearest position around the root: sevenths sit
      // just below it, creating the characteristic crushed seconds.
      notes = intervals.map(offset => {
        const rel = ((offset % 12) + 12) % 12;
        return rootMidi + (rel > 6 ? rel - 12 : rel);
      });
      break;
    }
    case 'closed':
    default:
      break;
  }

  notes.sort((a, b) => a - b);
  while (notes.length && notes[0] < 36) notes = notes.map(n => n + 12);
  while (notes.length && notes[notes.length - 1] > 89) notes = notes.map(n => n - 12);
  return notes;
}

// --- The harmony genome ---

export interface FoundrySettings {
  root: NoteName;
  quality: ChordQualityId;
  extension: ExtensionId;
  inversion: number;
  voicing: VoicingId;
  register: RegisterId;
}

export interface HarmonyGenome extends FoundrySettings {
  id: string;
  rootPc: number;
  intervals: number[];
  pitchClasses: number[];
  midi: number[];
  bassPc: number;
  bassName: NoteName;
  noteNames: NoteName[];
  name: string;
  tension: number;
  brightness: number;
  instability: number;
  ambiguity: number;
}

/** Dissonance weight per interval class (0..6). */
const IC_WEIGHTS = [0, 1.0, 0.45, 0.12, 0.08, 0.05, 0.85];

function intervalClass(a: number, b: number): number {
  const d = Math.abs(a - b) % 12;
  return d > 6 ? 12 - d : d;
}

interface MetricInputs {
  pcs: number[];
  quality: ChordQualityId;
  extension: ExtensionId;
  voicing: VoicingId;
  register: RegisterId;
  inversion: number;
}

function computeMetrics(m: MetricInputs) {
  const { pcs } = m;
  let weightSum = 0;
  let pairCount = 0;
  let tritonePairs = 0;
  for (let i = 0; i < pcs.length; i++) {
    for (let j = i + 1; j < pcs.length; j++) {
      const ic = intervalClass(pcs[i], pcs[j]);
      weightSum += IC_WEIGHTS[ic];
      pairCount++;
      if (ic === 6) tritonePairs++;
    }
  }
  const avg = pairCount ? weightSum / pairCount : 0;

  const has = (rel: number) => pcs.includes(rel);
  const hasDomEngine = has(4) && has(10);
  const symmetric = m.quality === 'augmented' || m.extension === 'dim7';
  const lacksFifth = !has(7);
  const noThird = !has(3) && !has(4);

  const voicingAdj = m.voicing === 'cluster' ? 0.12 : m.voicing === 'open' || m.voicing === 'spread' ? -0.05 : m.voicing === 'drop2' ? -0.02 : 0;
  const tension = clamp01(1.3 * (avg + 0.18 * tritonePairs + (hasDomEngine ? 0.09 : 0)) + voicingAdj);

  let brightness = 0.5;
  if (has(4)) brightness += 0.22;
  if (has(3)) brightness -= 0.2;
  if (has(11)) brightness += 0.1;
  if (has(10)) brightness -= 0.05;
  if (has(9)) brightness += 0.06;
  if (has(8)) brightness += 0.05;
  if (has(6) && has(3)) brightness -= 0.12;
  if (noThird) brightness += 0.03;
  brightness += m.register === 'low' ? -0.07 : m.register === 'high' ? 0.07 : 0;
  brightness = clamp01(brightness);

  const instability = clamp01(
    0.5 * tritonePairs +
      (hasDomEngine && tritonePairs ? 0.15 : 0) +
      (symmetric ? 0.28 : 0) +
      (lacksFifth ? 0.18 : 0) +
      (noThird && !symmetric ? 0.15 : 0) +
      0.04
  );

  const ambiguity = clamp01(
    0.06 + (noThird ? 0.42 : 0) + (symmetric ? 0.5 : 0) + (m.inversion > 0 ? 0.08 : 0) + (m.voicing === 'cluster' ? 0.1 : 0)
  );

  return { tension, brightness, instability, ambiguity, tritonePairs };
}

export function nameChord(root: NoteName, quality: ChordQualityId, extension: ExtensionId): string {
  const suffix = CHORD_SUFFIXES[quality]?.[extension];
  if (suffix !== undefined) return `${root}${suffix}`;
  const fallback = CHORD_SUFFIXES[quality]?.none ?? '';
  return `${root}${fallback}`;
}

export function buildHarmonyGenome(settings: FoundrySettings): HarmonyGenome {
  const rootPc = pcOf(settings.root);
  const intervals = chordIntervals(settings.quality, settings.extension);
  const inversion = Math.max(0, Math.min(settings.inversion, intervals.length - 1));
  const midi = voiceChord(rootPc, intervals, {
    inversion,
    voicing: settings.voicing,
    octave: REGISTER_OCTAVES[settings.register]
  });
  const pcs = Array.from(new Set(intervals.map(i => ((i % 12) + 12) % 12))).sort((a, b) => a - b);
  const metrics = computeMetrics({
    pcs,
    quality: settings.quality,
    extension: settings.extension,
    voicing: settings.voicing,
    register: settings.register,
    inversion
  });

  return {
    ...settings,
    inversion,
    id: `${settings.root}_${settings.quality}_${settings.extension}_${inversion}_${settings.voicing}_${settings.register}`,
    rootPc,
    intervals,
    pitchClasses: pcs,
    midi,
    bassPc: midi.length ? midi[0] % 12 : rootPc,
    bassName: noteOfPc(midi.length ? midi[0] % 12 : rootPc),
    noteNames: midi.map(m => noteOfPc(m % 12)),
    name: nameChord(settings.root, settings.quality, settings.extension),
    tension: metrics.tension,
    brightness: metrics.brightness,
    instability: metrics.instability,
    ambiguity: metrics.ambiguity
  };
}

export function classifyOrganism(g: HarmonyGenome): string {
  if (g.quality === 'diminished') {
    if (g.extension === 'dim7') return 'Symmetric Vortex';
    if (g.extension === '7') return 'Anxious Drifter';
    return 'Collapsed Triangle';
  }
  if (g.quality === 'augmented') return g.extension === 'maj7' ? 'Radiant Prism' : 'Floating Prism';
  if (g.quality === 'sus2') return 'Tiptoe Breather';
  if (g.quality === 'sus4') return g.extension === 'none' ? 'Breath-Holder' : 'Suspended Engine';
  if (g.quality === 'major') {
    switch (g.extension) {
      case '6':
        return 'Gilded Strider';
      case '7':
        return 'Forward-Leaning Beast';
      case 'maj7':
        return 'Haloed Monolith';
      case '9':
        return 'Nine-Eyed Dominant';
      default:
        return 'Stable Strider';
    }
  }
  switch (g.extension) {
    case '6':
      return 'Nostalgic Croucher';
    case '7':
      return 'Velvet Drifter';
    case 'maj7':
      return 'Haunted Monolith';
    case '9':
      return 'Deep-Sea Drifter';
    default:
      return 'Shadow Strider';
  }
}

// --- Chord anatomy ---

export interface ChordToneInfo {
  midi: number;
  note: NoteName;
  octave: number;
  rel: number;
  degree: string;
  role: string;
  force: string;
  isBass: boolean;
}

export function describeChordTones(genome: HarmonyGenome): ChordToneInfo[] {
  const hasSeventh = genome.pitchClasses.includes(10) || genome.pitchClasses.includes(11);
  return genome.midi.map((m, idx) => {
    const rel = (((m % 12) - genome.rootPc) % 12 + 12) % 12;
    let anatomy = TONE_ANATOMY[rel] ?? { degree: '?', role: 'Color', force: 'Unmapped force' };
    if (rel === 2 && genome.quality === 'sus2') {
      anatomy = { degree: '2', role: 'Suspension', force: 'Open platform replacing the 3rd' };
    } else if (rel === 2 && hasSeventh) {
      anatomy = TONE_ANATOMY[2];
    } else if (rel === 9 && genome.extension === 'dim7') {
      anatomy = { degree: '♭♭7', role: 'Symmetry lock', force: 'Vortex blade' };
    }
    return {
      midi: m,
      note: noteOfPc(m % 12),
      octave: Math.floor(m / 12) - 1,
      rel,
      degree: anatomy.degree,
      role: anatomy.role,
      force: anatomy.force,
      isBass: idx === 0
    };
  });
}

export interface TritonePair {
  a: NoteName;
  b: NoteName;
}

export function findTritones(genome: HarmonyGenome): TritonePair[] {
  const pcs = Array.from(new Set(genome.midi.map(m => m % 12)));
  const pairs: TritonePair[] = [];
  for (let i = 0; i < pcs.length; i++) {
    for (let j = i + 1; j < pcs.length; j++) {
      if (intervalClass(pcs[i], pcs[j]) === 6) {
        pairs.push({ a: noteOfPc(pcs[i]), b: noteOfPc(pcs[j]) });
      }
    }
  }
  return pairs;
}

// --- Functional analysis & resolution expectation engine ---

export interface ResolutionExpectation {
  numeral: string;
  chordName: string;
  kind: string;
  strength: number;
  why: string;
  targetPc: number;
}

export interface ChordAnalysis {
  degreePc: number;
  numeral: string | null;
  fn: HarmonicFunction;
  fnLabel: string;
  word: string;
  blurb: string;
  inField: boolean;
  tritones: TritonePair[];
  resolutions: ResolutionExpectation[];
  gravity: number;
  landingSummary: string;
}

function qualitySuffix(quality: ChordQualityId): string {
  switch (quality) {
    case 'minor':
      return 'm';
    case 'diminished':
      return 'dim';
    case 'augmented':
      return 'aug';
    case 'sus2':
      return 'sus2';
    case 'sus4':
      return 'sus4';
    default:
      return '';
  }
}

function numeralForGenome(base: string, genome: HarmonyGenome): string {
  const flat = base.startsWith('♭') ? '♭' : '';
  const core = base.replace('♭', '').replace('°', '');
  let label: string;
  if (genome.quality === 'minor' || genome.quality === 'diminished') {
    label = core.toLowerCase();
  } else {
    label = core.toUpperCase();
  }
  if (genome.quality === 'diminished') label += genome.extension === '7' ? 'ø' : '°';
  if (genome.quality === 'augmented') label += '+';
  if (genome.quality === 'sus2' || genome.quality === 'sus4') label = core.toUpperCase() + genome.quality;
  let ext = '';
  if (genome.extension === '7' || genome.extension === 'dim7') ext = '7';
  else if (genome.extension === 'maj7') ext = 'maj7';
  else if (genome.extension === '6') ext = '6';
  else if (genome.extension === '9') ext = '9';
  return `${flat}${label}${ext}`;
}

export function analyzeChord(genome: HarmonyGenome, keyRoot: NoteName, mode: ScaleMode): ChordAnalysis {
  const keyPc = pcOf(keyRoot);
  const degreePc = ((genome.rootPc - keyPc) % 12 + 12) % 12;
  const info = DEGREE_INFO[`${mode}:${degreePc}`];
  const tritones = findTritones(genome);
  const isDominantQuality = genome.pitchClasses.includes(4) && genome.pitchClasses.includes(10);

  let resolutions: ResolutionExpectation[] = [];
  if (info) {
    const rules = RESOLUTION_RULES[`${mode}:${degreePc}`] ?? [];
    resolutions = rules.map(rule => {
      const targetInfo = DEGREE_INFO[`${mode}:${rule.targetPc}`];
      const targetQuality = DIATONIC_TARGET_QUALITY[`${mode}:${rule.targetPc}`] ?? 'major';
      const targetRoot = noteOfPc(keyPc + rule.targetPc);
      return {
        numeral: targetInfo?.numeral ?? '?',
        chordName: `${targetRoot}${qualitySuffix(targetQuality)}`,
        kind: rule.kind,
        strength: rule.strength,
        why: rule.why,
        targetPc: rule.targetPc
      };
    });
    // A dominant-quality chord on a non-dominant degree (e.g. the blues I7) also
    // points a perfect fifth down — it has become a secondary dominant.
    if (isDominantQuality && info.fn !== 'dominant' && info.fn !== 'leading') {
      const targetPcAbs = (genome.rootPc + 5) % 12;
      const targetRel = ((targetPcAbs - keyPc) % 12 + 12) % 12;
      const targetInfo = DEGREE_INFO[`${mode}:${targetRel}`];
      const targetQuality = DIATONIC_TARGET_QUALITY[`${mode}:${targetRel}`] ?? 'major';
      resolutions.push({
        numeral: targetInfo ? `V7 of ${targetInfo.numeral}` : `V7 → ${noteOfPc(targetPcAbs)}`,
        chordName: `${noteOfPc(targetPcAbs)}${qualitySuffix(targetQuality)}`,
        kind: 'secondary dominant',
        strength: 0.7,
        why: 'The added ♭7 turns this chord into a launched arrow: it points a perfect fifth down.',
        targetPc: targetRel
      });
    }
  } else if (isDominantQuality) {
    const targetPcAbs = (genome.rootPc + 5) % 12;
    const targetRoot = noteOfPc(targetPcAbs);
    resolutions = [
      {
        numeral: `V7 → ${targetRoot}`,
        chordName: `${targetRoot} / ${targetRoot}m`,
        kind: 'secondary dominant',
        strength: 0.8,
        why: 'Any dominant 7 is a launched arrow: it points a perfect fifth down, regardless of key.',
        targetPc: ((targetPcAbs - keyPc) % 12 + 12) % 12
      }
    ];
  }

  resolutions.sort((a, b) => b.strength - a.strength);
  let gravity = resolutions.length ? resolutions[0].strength : 0.2;
  if (tritones.length && (info?.fn === 'dominant' || info?.fn === 'leading' || !info)) gravity += 0.05;
  gravity = Math.min(0.98, gravity);

  const landingSummary = resolutions.length
    ? resolutions
        .slice(0, 2)
        .map(r => r.chordName)
        .join('  /  ')
    : 'Resolve by ear — no map for this one';

  return {
    degreePc,
    numeral: info ? numeralForGenome(info.numeral, genome) : null,
    fn: info?.fn ?? 'chromatic',
    fnLabel: FUNCTION_LABELS[info?.fn ?? 'chromatic'],
    word: info?.word ?? 'Drift',
    blurb: info?.blurb ?? 'This chord lives outside the key’s gravity field. It pulls the music somewhere new.',
    inField: Boolean(info),
    tritones,
    resolutions,
    gravity,
    landingSummary
  };
}

// --- Progression engine ---

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const ROMAN_DEGREES: Record<string, number> = { I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6 };

export interface ParsedNumeral {
  degreePc: number;
  quality: ChordQualityId;
  extension: ExtensionId;
}

export function parsePresetNumeral(numeral: string): ParsedNumeral | null {
  const match = numeral.match(/^(♭*)([ivIV]+)(°?)(maj7|7)?$/);
  if (!match) return null;
  const [, flats, roman, dim, ext] = match;
  const degree = ROMAN_DEGREES[roman.toUpperCase()];
  if (degree === undefined) return null;
  const degreePc = ((MAJOR_STEPS[degree] - flats.length) % 12 + 12) % 12;
  const quality: ChordQualityId = dim === '°' ? 'diminished' : roman === roman.toLowerCase() ? 'minor' : 'major';
  const extension: ExtensionId = ext === 'maj7' ? 'maj7' : ext === '7' ? '7' : 'none';
  return { degreePc, quality, extension };
}

function voiceLeadingCost(prev: number[], candidate: number[]): number {
  let cost = 0;
  candidate.forEach(note => {
    let best = Infinity;
    prev.forEach(p => {
      best = Math.min(best, Math.abs(note - p));
    });
    cost += best;
  });
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  cost += Math.abs(mean(candidate) - mean(prev)) * 0.5;
  return cost;
}

export interface ProgressionStep {
  numeral: string;
  displayNumeral: string;
  chordName: string;
  genome: HarmonyGenome;
  fn: HarmonicFunction;
  word: string;
  tensionHeight: number;
}

/**
 * Translates a preset into voiced chords in the chosen key. Inversions are
 * chosen automatically so each chord moves by the shortest path from the
 * previous one (basic voice-leading).
 */
export function buildPresetProgression(preset: ProgressionPreset, keyRoot: NoteName): ProgressionStep[] {
  const keyPc = pcOf(keyRoot);
  let prevMidi: number[] | null = null;
  const steps: ProgressionStep[] = [];

  preset.numerals.forEach(numeral => {
    const parsed = parsePresetNumeral(numeral);
    if (!parsed) return;
    const rootName = noteOfPc(keyPc + parsed.degreePc);
    const intervals = chordIntervals(parsed.quality, parsed.extension);

    let chosenInversion = 0;
    if (prevMidi) {
      let bestCost = Infinity;
      for (let inv = 0; inv < intervals.length; inv++) {
        const candidate = voiceChord(pcOf(rootName), intervals, { inversion: inv, voicing: 'closed', octave: 4 });
        const cost = voiceLeadingCost(prevMidi, candidate);
        if (cost < bestCost) {
          bestCost = cost;
          chosenInversion = inv;
        }
      }
    }

    const genome = buildHarmonyGenome({
      root: rootName,
      quality: parsed.quality,
      extension: parsed.extension,
      inversion: chosenInversion,
      voicing: 'closed',
      register: 'mid'
    });
    prevMidi = genome.midi;

    const info = DEGREE_INFO[`${preset.mode}:${parsed.degreePc}`];
    const fn: HarmonicFunction = info?.fn ?? 'chromatic';
    steps.push({
      numeral,
      displayNumeral: info ? numeralForGenome(info.numeral, genome) : numeral,
      chordName: genome.name,
      genome,
      fn,
      word: info?.word ?? 'Drift',
      tensionHeight: clamp01(genome.tension * 0.55 + FN_TENSION_BONUS[fn])
    });
  });

  // A tonic that follows a dominant is a release, not just "home".
  steps.forEach((step, i) => {
    const prev = steps[(i - 1 + steps.length) % steps.length];
    if (step.fn === 'tonic' && (prev.fn === 'dominant' || prev.fn === 'leading') && steps.length > 1) {
      step.word = 'Release';
    }
  });

  return steps;
}

// --- Gravity map view ---

export interface GravityMapNode {
  key: string;
  pc: number;
  numeral: string;
  chordName: string;
  x: number;
  y: number;
  isCurrent: boolean;
}

export interface GravityMapArrow {
  fromKey: string;
  toKey: string;
  strength: number;
  kind: string;
}

export interface GravityMapView {
  nodes: GravityMapNode[];
  arrows: GravityMapArrow[];
  chromaticLabel: string | null;
}

export function buildGravityMapView(
  keyRoot: NoteName,
  mode: ScaleMode,
  genome: HarmonyGenome,
  analysis: ChordAnalysis
): GravityMapView {
  const keyPc = pcOf(keyRoot);
  const layout = GRAVITY_MAP_LAYOUT[mode];
  const nodes: GravityMapNode[] = layout.map(spec => {
    const info = DEGREE_INFO[`${mode}:${spec.pc}`];
    const quality = DIATONIC_TARGET_QUALITY[`${mode}:${spec.pc}`] ?? 'major';
    return {
      key: `${mode}:${spec.pc}`,
      pc: spec.pc,
      numeral: info?.numeral ?? '?',
      chordName: `${noteOfPc(keyPc + spec.pc)}${qualitySuffix(quality)}`,
      x: spec.x,
      y: spec.y,
      isCurrent: analysis.inField && spec.pc === analysis.degreePc
    };
  });

  const arrows: GravityMapArrow[] = [];
  if (analysis.inField) {
    const fromKey = `${mode}:${analysis.degreePc}`;
    analysis.resolutions.forEach(res => {
      const toKey = `${mode}:${res.targetPc}`;
      if (nodes.some(n => n.key === toKey) && toKey !== fromKey) {
        arrows.push({ fromKey, toKey, strength: res.strength, kind: res.kind });
      }
    });
  }

  return {
    nodes,
    arrows,
    chromaticLabel: analysis.inField ? null : `${genome.name} — chromatic visitor, outside this key's gravity field`
  };
}

// --- Ear lab (Chord Color Quiz) ---

export interface QuizQuestion {
  option: QuizOption;
  root: NoteName;
  genome: HarmonyGenome;
}

export function makeQuizQuestion(level: QuizLevel, avoidOptionId?: string | null): QuizQuestion {
  const pool = level.options.filter(o => o.id !== avoidOptionId);
  const options = pool.length ? pool : level.options;
  const option = options[Math.floor(Math.random() * options.length)];
  const root = NOTE_NAMES[Math.floor(Math.random() * NOTE_NAMES.length)];
  const genome = buildHarmonyGenome({
    root,
    quality: option.quality,
    extension: option.extension,
    inversion: 0,
    voicing: 'closed',
    register: 'mid'
  });
  return { option, root, genome };
}

export function quizFeedback(correct: boolean, guess: QuizOption, actual: QuizOption): string {
  if (correct) {
    return `Locked in — ${actual.label}. You caught ${actual.trait}. (${actual.listenFor})`;
  }
  return `You guessed ${guess.label}. Actual: ${actual.label}. You heard ${guess.trait}, but missed ${actual.trait}. Listen for: ${actual.listenFor}`;
}
