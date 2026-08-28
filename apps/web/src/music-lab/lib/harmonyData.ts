import { LIBRARY_PROGRESSION_PRESETS } from './genreLibrary';

/**
 * Harmony Engine seed data.
 *
 * The guiding metaphor (see docs/HARMONY_ENGINE_PLAN.md): rhythm is locomotion,
 * harmony is gravity. Every harmonic object answers three questions —
 * what is it made of, how does it feel, where does it want to go.
 */

export type ChordQualityId = 'major' | 'minor' | 'diminished' | 'augmented' | 'sus2' | 'sus4';
export type ExtensionId = 'none' | '6' | '7' | 'maj7' | '9' | 'dim7';
export type VoicingId = 'closed' | 'open' | 'drop2' | 'spread' | 'cluster';
export type RegisterId = 'low' | 'mid' | 'high';
export type ScaleMode = 'major' | 'minor';
export type HarmonicFunction =
  | 'tonic'
  | 'predominant'
  | 'dominant'
  | 'substitute'
  | 'leading'
  | 'modal'
  | 'chromatic';

export interface ChordQualityDefinition {
  id: ChordQualityId;
  label: string;
  intervals: number[];
  feel: string;
  organism: string;
}

export const CHORD_QUALITIES: ChordQualityDefinition[] = [
  {
    id: 'major',
    label: 'Major',
    intervals: [0, 4, 7],
    feel: 'Bright identity resting on a structural beam. At rest.',
    organism: 'Stable triad creature — symmetrical rib cage'
  },
  {
    id: 'minor',
    label: 'Minor',
    intervals: [0, 3, 7],
    feel: 'Same skeleton as major, darker internal glow.',
    organism: 'Shadow-lit creature — dimmed core'
  },
  {
    id: 'diminished',
    label: 'Dim',
    intervals: [0, 3, 6],
    feel: 'Two stacked minor thirds; the floor caves inward.',
    organism: 'Collapsed triangular creature — coiled and tense'
  },
  {
    id: 'augmented',
    label: 'Aug',
    intervals: [0, 4, 8],
    feel: 'A raised fifth with no ground to push against.',
    organism: 'Floating unstable prism'
  },
  {
    id: 'sus2',
    label: 'Sus 2',
    intervals: [0, 2, 7],
    feel: 'The third is replaced by open air above the root.',
    organism: 'Creature on tiptoe — undecided'
  },
  {
    id: 'sus4',
    label: 'Sus 4',
    intervals: [0, 5, 7],
    feel: 'A suspended platform where the third should be.',
    organism: 'Creature holding its breath'
  }
];

export interface ExtensionDefinition {
  id: ExtensionId;
  label: string;
  adds: number[];
  allowed: ChordQualityId[];
}

export const EXTENSIONS: ExtensionDefinition[] = [
  { id: 'none', label: 'None', adds: [], allowed: ['major', 'minor', 'diminished', 'augmented', 'sus2', 'sus4'] },
  { id: '6', label: '6 — warm halo', adds: [9], allowed: ['major', 'minor'] },
  { id: '7', label: '7 — forward engine', adds: [10], allowed: ['major', 'minor', 'diminished', 'augmented', 'sus2', 'sus4'] },
  { id: 'maj7', label: 'maj7 — almost-home ache', adds: [11], allowed: ['major', 'minor', 'augmented'] },
  { id: '9', label: '9 — air', adds: [10, 14], allowed: ['major', 'minor', 'sus4'] },
  { id: 'dim7', label: '°7 — symmetry lock', adds: [9], allowed: ['diminished'] }
];

/** Chord-symbol suffix for each (quality, extension) pair the foundry allows. */
export const CHORD_SUFFIXES: Record<ChordQualityId, Partial<Record<ExtensionId, string>>> = {
  major: { none: '', '6': '6', '7': '7', maj7: 'maj7', '9': '9' },
  minor: { none: 'm', '6': 'm6', '7': 'm7', maj7: 'm(maj7)', '9': 'm9' },
  diminished: { none: 'dim', '7': 'm7♭5', dim7: 'dim7' },
  augmented: { none: 'aug', '7': 'aug7', maj7: 'maj7♯5' },
  sus2: { none: 'sus2', '7': '7sus2' },
  sus4: { none: 'sus4', '7': '7sus4', '9': '9sus4' }
};

export interface VoicingDefinition {
  id: VoicingId;
  label: string;
  blurb: string;
}

export const VOICINGS: VoicingDefinition[] = [
  { id: 'closed', label: 'Closed', blurb: 'Notes packed in one hand-span' },
  { id: 'open', label: 'Open', blurb: 'Inner voices lifted an octave' },
  { id: 'drop2', label: 'Drop 2', blurb: 'Second voice from the top dropped down' },
  { id: 'spread', label: 'Spread', blurb: 'Wide frame: deep bass, high crown' },
  { id: 'cluster', label: 'Cluster', blurb: 'Voices crushed toward the root' }
];

export const REGISTER_OCTAVES: Record<RegisterId, number> = { low: 3, mid: 4, high: 5 };

/** Semantic anatomy for each semitone offset above the chord root. */
export interface ToneAnatomy {
  degree: string;
  role: string;
  force: string;
}

export const TONE_ANATOMY: Record<number, ToneAnatomy> = {
  0: { degree: 'R', role: 'Identity', force: 'Gravity core — the self' },
  1: { degree: '♭9', role: 'Toxic color', force: 'Grinding edge' },
  2: { degree: '9', role: 'Air', force: 'Soft updraft above the frame' },
  3: { degree: '♭3', role: 'Emotional polarity', force: 'Shadow identity' },
  4: { degree: '3', role: 'Emotional polarity', force: 'Bright identity' },
  5: { degree: '4', role: 'Suspension', force: 'Suspended platform' },
  6: { degree: '♭5', role: 'Destabilizer', force: 'Split magnet' },
  7: { degree: '5', role: 'Structural support', force: 'Structural beam' },
  8: { degree: '♯5', role: 'Lift / strain', force: 'Floating prism edge' },
  9: { degree: '6', role: 'Warmth', force: 'Warm halo' },
  10: { degree: '♭7', role: 'Tension / color', force: 'Forward engine' },
  11: { degree: '7', role: 'Tension / color', force: 'Almost-home ache' }
};

/** Functional identity of each scale-degree pitch class within a key. */
export interface DegreeInfo {
  numeral: string;
  fn: HarmonicFunction;
  word: string;
  blurb: string;
}

export const DEGREE_INFO: Record<string, DegreeInfo> = {
  'major:0': { numeral: 'I', fn: 'tonic', word: 'Home', blurb: 'Total rest. The gravity well everything else orbits.' },
  'major:1': { numeral: '♭II', fn: 'chromatic', word: 'Lean', blurb: 'A chromatic shadow a half step above home.' },
  'major:2': { numeral: 'ii', fn: 'predominant', word: 'Prepare', blurb: 'Directed preparation — it aims the harmony at the dominant.' },
  'major:3': { numeral: '♭III', fn: 'modal', word: 'Shade', blurb: 'Borrowed darkness from the parallel minor.' },
  'major:4': { numeral: 'iii', fn: 'substitute', word: 'Shadow', blurb: 'Tonic-adjacent shadow. Shares two notes with home.' },
  'major:5': { numeral: 'IV', fn: 'predominant', word: 'Open', blurb: 'Expansion. The door swings outward but home stays visible.' },
  'major:6': { numeral: '♯IV', fn: 'chromatic', word: 'Knife', blurb: 'Tritone distance from home — maximum strangeness.' },
  'major:7': { numeral: 'V', fn: 'dominant', word: 'Pull', blurb: 'Dominant gravity. It stores pressure that wants to fall home.' },
  'major:8': { numeral: '♭VI', fn: 'modal', word: 'Ache', blurb: 'Borrowed warmth-in-sorrow from the parallel minor.' },
  'major:9': { numeral: 'vi', fn: 'substitute', word: 'Ache', blurb: 'The relative minor — a soft emotional landing.' },
  'major:10': { numeral: '♭VII', fn: 'modal', word: 'Open', blurb: 'Rock / Mixolydian gravity — it sidesteps the leading tone.' },
  'major:11': { numeral: 'vii°', fn: 'leading', word: 'Spike', blurb: 'Leading-tone shard. Pure instability pointed at home.' },
  'minor:0': { numeral: 'i', fn: 'tonic', word: 'Home', blurb: 'Home, in shadow.' },
  'minor:2': { numeral: 'ii°', fn: 'predominant', word: 'Prepare', blurb: 'An unstable preparation that leans into the dominant.' },
  'minor:3': { numeral: '♭III', fn: 'substitute', word: 'Lift', blurb: 'The relative major — light inside the minor key.' },
  'minor:5': { numeral: 'iv', fn: 'predominant', word: 'Pull-in', blurb: 'The minor subdominant draws the harmony inward.' },
  'minor:7': { numeral: 'V', fn: 'dominant', word: 'Demand', blurb: 'The raised leading tone gives minor its dominant engine.' },
  'minor:8': { numeral: '♭VI', fn: 'substitute', word: 'Ache', blurb: 'Cinematic weight — a soft cliff above the dominant.' },
  'minor:10': { numeral: '♭VII', fn: 'modal', word: 'Open', blurb: 'The subtonic — modal momentum without a leading tone.' },
  'minor:11': { numeral: 'vii°', fn: 'leading', word: 'Spike', blurb: 'Borrowed leading-tone shard from harmonic minor.' }
};

export const FUNCTION_LABELS: Record<HarmonicFunction, string> = {
  tonic: 'Tonic — home',
  predominant: 'Predominant — preparation',
  dominant: 'Dominant — gravity',
  substitute: 'Tonic substitute — soft landing',
  leading: 'Leading-tone — instability',
  modal: 'Modal / borrowed color',
  chromatic: 'Chromatic — outside the field'
};

/** How much each function inflates the progression tension timeline. */
export const FN_TENSION_BONUS: Record<HarmonicFunction, number> = {
  tonic: 0.05,
  substitute: 0.18,
  predominant: 0.3,
  modal: 0.26,
  dominant: 0.55,
  leading: 0.62,
  chromatic: 0.4
};

/** Diatonic triad quality used when naming resolution targets. */
export const DIATONIC_TARGET_QUALITY: Record<string, ChordQualityId> = {
  'major:0': 'major',
  'major:1': 'major',
  'major:2': 'minor',
  'major:3': 'major',
  'major:4': 'minor',
  'major:5': 'major',
  'major:6': 'diminished',
  'major:7': 'major',
  'major:8': 'major',
  'major:9': 'minor',
  'major:10': 'major',
  'major:11': 'diminished',
  'minor:0': 'minor',
  'minor:2': 'diminished',
  'minor:3': 'major',
  'minor:5': 'minor',
  'minor:7': 'major',
  'minor:8': 'major',
  'minor:10': 'major',
  'minor:11': 'diminished'
};

/** Probable resolutions per (mode, degree pitch class). targetPc is relative to the key root. */
export interface ResolutionRule {
  targetPc: number;
  kind: string;
  strength: number;
  why: string;
}

export const RESOLUTION_RULES: Record<string, ResolutionRule[]> = {
  'major:0': [
    { targetPc: 5, kind: 'expansion', strength: 0.4, why: 'Home is free to leave; IV opens the room without tension.' },
    { targetPc: 7, kind: 'build pressure', strength: 0.38, why: 'Moving to V winds the spring for a return.' },
    { targetPc: 9, kind: 'soft slide', strength: 0.32, why: 'vi keeps two common tones and dims the lights.' }
  ],
  'major:1': [
    { targetPc: 7, kind: 'neapolitan lean', strength: 0.7, why: 'The ♭II classically tips into the dominant.' },
    { targetPc: 0, kind: 'chromatic fall', strength: 0.5, why: 'A half-step slide collapses back onto home.' }
  ],
  'major:2': [
    { targetPc: 7, kind: 'gravity chain', strength: 0.85, why: 'ii aims at V — the classic preparation in ii–V–I.' },
    { targetPc: 11, kind: 'sharpen', strength: 0.5, why: 'vii° heightens the leading-tone pressure first.' },
    { targetPc: 5, kind: 'sidestep', strength: 0.35, why: 'Sliding to IV keeps the predominant color alive.' }
  ],
  'major:3': [
    { targetPc: 8, kind: 'borrowed descent', strength: 0.5, why: '♭III often falls through ♭VI in borrowed progressions.' },
    { targetPc: 5, kind: 'reopen', strength: 0.45, why: 'IV restores diatonic light after the borrowed shade.' }
  ],
  'major:4': [
    { targetPc: 9, kind: 'shadow walk', strength: 0.6, why: 'iii drifts naturally into vi — shadow to soft landing.' },
    { targetPc: 5, kind: 'open out', strength: 0.5, why: 'iii can pass through IV as a brightening pivot.' }
  ],
  'major:5': [
    { targetPc: 7, kind: 'escalation', strength: 0.65, why: 'IV → V stacks expansion into demand.' },
    { targetPc: 0, kind: 'plagal resolution', strength: 0.6, why: 'The “amen” fall: open space settles directly home.' },
    { targetPc: 2, kind: 'darken', strength: 0.4, why: 'Stepping down to ii sharpens the aim at V.' }
  ],
  'major:6': [
    { targetPc: 7, kind: 'chromatic wedge', strength: 0.7, why: '♯IV exists to lean a half step into the dominant.' }
  ],
  'major:7': [
    { targetPc: 0, kind: 'authentic resolution', strength: 0.87, why: 'The leading tone climbs home while the bass falls a fifth.' },
    { targetPc: 9, kind: 'deceptive resolution', strength: 0.55, why: 'vi catches the fall — the trapdoor under the tonic.' },
    { targetPc: 5, kind: 'retreat', strength: 0.3, why: 'Backing into IV defers the cadence for longer loops.' }
  ],
  'major:8': [
    { targetPc: 10, kind: 'cinematic climb', strength: 0.6, why: '♭VI → ♭VII → I is the borrowed staircase ascent.' },
    { targetPc: 7, kind: 'half-step drop', strength: 0.5, why: '♭VI sits one semitone above V and loves to fall onto it.' }
  ],
  'major:9': [
    { targetPc: 2, kind: 'circle motion', strength: 0.6, why: 'vi → ii → V → I walks the circle of fifths.' },
    { targetPc: 5, kind: 'brighten', strength: 0.55, why: 'IV lifts the relative-minor ache back into open air.' },
    { targetPc: 7, kind: 'direct demand', strength: 0.4, why: 'Jumping to V trades softness for pull.' }
  ],
  'major:10': [
    { targetPc: 5, kind: 'rock gravity chain', strength: 0.6, why: 'I–♭VII–IV: the modal engine of rock and folk.' },
    { targetPc: 0, kind: 'backdoor landing', strength: 0.55, why: '♭VII can settle home without any leading tone.' }
  ],
  'major:11': [
    { targetPc: 0, kind: 'sharp resolution', strength: 0.95, why: 'Every note of vii° leans a half step toward home.' },
    { targetPc: 4, kind: 'shadow swerve', strength: 0.35, why: 'A softer exit through the mediant shadow.' }
  ],
  'minor:0': [
    { targetPc: 5, kind: 'departure', strength: 0.4, why: 'iv pulls home deeper into shadow.' },
    { targetPc: 8, kind: 'cinematic step', strength: 0.36, why: '♭VI widens the frame — minor-key scope.' },
    { targetPc: 7, kind: 'build pressure', strength: 0.38, why: 'V loads the spring that snaps back to i.' }
  ],
  'minor:2': [
    { targetPc: 7, kind: 'gravity chain', strength: 0.85, why: 'ii° is the minor key’s sharpened preparation for V.' },
    { targetPc: 0, kind: 'collapse home', strength: 0.4, why: 'Its instability can also fold straight back into i.' }
  ],
  'minor:3': [
    { targetPc: 8, kind: 'mediant walk', strength: 0.55, why: '♭III → ♭VI: the relative-major light slides into ache.' },
    { targetPc: 5, kind: 'pull inward', strength: 0.45, why: 'iv re-darkens the borrowed light.' }
  ],
  'minor:5': [
    { targetPc: 7, kind: 'escalation', strength: 0.75, why: 'iv → V is the classic minor build before resolution.' },
    { targetPc: 0, kind: 'plagal resolution', strength: 0.5, why: 'The minor “amen”: inward pull settles back home.' }
  ],
  'minor:7': [
    { targetPc: 0, kind: 'authentic resolution', strength: 0.88, why: 'The raised leading tone demands the minor tonic.' },
    { targetPc: 8, kind: 'deceptive resolution', strength: 0.55, why: '♭VI catches the fall — minor’s trapdoor cadence.' }
  ],
  'minor:8': [
    { targetPc: 10, kind: 'cinematic climb', strength: 0.6, why: '♭VI → ♭VII → i: the epic staircase.' },
    { targetPc: 7, kind: 'half-step drop', strength: 0.55, why: 'A semitone above the dominant, aching to fall onto it.' }
  ],
  'minor:10': [
    { targetPc: 0, kind: 'modal cadence', strength: 0.55, why: 'The subtonic rolls home without a leading tone.' },
    { targetPc: 8, kind: 'descent', strength: 0.5, why: 'Andalusian gravity: ♭VII keeps falling toward ♭VI.' },
    { targetPc: 3, kind: 'relative lift', strength: 0.4, why: '♭VII is V of the relative major — it can brighten instead.' }
  ],
  'minor:11': [
    { targetPc: 0, kind: 'sharp resolution', strength: 0.95, why: 'The borrowed leading-tone shard snaps onto i.' }
  ]
};

/** Progression presets. Numerals use ♭ for borrowed roots, ° for diminished, 7/maj7 for sevenths. */
export interface ProgressionPreset {
  id: string;
  name: string;
  mode: ScaleMode;
  numerals: string[];
  feel: string;
}

const CORE_PROGRESSION_PRESETS: ProgressionPreset[] = [
  {
    id: 'axis',
    name: 'Axis Loop',
    mode: 'major',
    numerals: ['I', 'V', 'vi', 'IV'],
    feel: 'Stable, circular, emotionally broad. It leaves home, aches, then opens back out.'
  },
  {
    id: 'axis-emotional',
    name: 'Emotional Axis',
    mode: 'major',
    numerals: ['vi', 'IV', 'I', 'V'],
    feel: 'The same orbit entered through the ache. Home arrives mid-phrase, so the loop never feels finished.'
  },
  {
    id: 'jazz-251',
    name: 'ii–V–I Gravity Well',
    mode: 'major',
    numerals: ['ii7', 'V7', 'Imaj7'],
    feel: 'Preparation, demand, release. The dominant chord stores the most harmonic pressure.'
  },
  {
    id: 'doo-wop',
    name: '50s Doo-Wop',
    mode: 'major',
    numerals: ['I', 'vi', 'IV', 'V'],
    feel: 'Home slides into its shadow, opens outward, then demands a return. The eternal slow-dance engine.'
  },
  {
    id: 'rock-backdoor',
    name: 'Rock Backdoor',
    mode: 'major',
    numerals: ['I', '♭VII', 'IV'],
    feel: 'Mixolydian gravity. No leading tone, no demand — just big modal doors swinging open.'
  },
  {
    id: 'folk-145',
    name: 'Folk Foundation',
    mode: 'major',
    numerals: ['I', 'IV', 'V'],
    feel: 'The three pillars: home, expansion, pull. Nearly all folk and blues stands on these.'
  },
  {
    id: 'minor-cinematic',
    name: 'Minor Cinematic Loop',
    mode: 'minor',
    numerals: ['i', '♭VI', '♭III', '♭VII'],
    feel: 'Wide-lens minor. Each chord is a camera move; none of them resolves, so the scene keeps rolling.'
  },
  {
    id: 'andalusian',
    name: 'Andalusian Descent',
    mode: 'minor',
    numerals: ['i', '♭VII', '♭VI', 'V'],
    feel: 'A staircase falling by whole steps until the dominant catches it. Flamenco’s gravity well.'
  },
  {
    id: 'blues-12',
    name: '12-Bar Blues',
    mode: 'major',
    numerals: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'],
    feel: 'A form-based harmonic engine. Every chord is a dominant beast — tension is the resting state.'
  }
];

/** Core presets plus every progression contributed by the genre library. */
export const PROGRESSION_PRESETS: ProgressionPreset[] = [
  ...CORE_PROGRESSION_PRESETS,
  ...LIBRARY_PROGRESSION_PRESETS
];

/** Layout of the functional gravity map (normalized coordinates). */
export interface GravityNodeSpec {
  pc: number;
  x: number;
  y: number;
}

export const GRAVITY_MAP_LAYOUT: Record<ScaleMode, GravityNodeSpec[]> = {
  major: [
    { pc: 5, x: 0.5, y: 0.16 },
    { pc: 10, x: 0.15, y: 0.22 },
    { pc: 2, x: 0.31, y: 0.38 },
    { pc: 9, x: 0.69, y: 0.38 },
    { pc: 0, x: 0.5, y: 0.56 },
    { pc: 4, x: 0.31, y: 0.76 },
    { pc: 7, x: 0.69, y: 0.76 },
    { pc: 11, x: 0.5, y: 0.88 }
  ],
  minor: [
    { pc: 5, x: 0.5, y: 0.16 },
    { pc: 10, x: 0.15, y: 0.22 },
    { pc: 2, x: 0.31, y: 0.38 },
    { pc: 8, x: 0.69, y: 0.38 },
    { pc: 0, x: 0.5, y: 0.56 },
    { pc: 3, x: 0.31, y: 0.76 },
    { pc: 7, x: 0.69, y: 0.76 },
    { pc: 11, x: 0.5, y: 0.88 }
  ]
};

/** Ear-lab quiz catalogue. */
export interface QuizOption {
  id: string;
  label: string;
  quality: ChordQualityId;
  extension: ExtensionId;
  trait: string;
  listenFor: string;
}

export interface QuizLevel {
  id: 'triads' | 'sevenths';
  label: string;
  options: QuizOption[];
}

export const QUIZ_LEVELS: QuizLevel[] = [
  {
    id: 'triads',
    label: 'Triads',
    options: [
      {
        id: 'major',
        label: 'Major',
        quality: 'major',
        extension: 'none',
        trait: 'the bright identity',
        listenFor: 'a sunlit major 3rd over a solid 5th — symmetry at rest.'
      },
      {
        id: 'minor',
        label: 'Minor',
        quality: 'minor',
        extension: 'none',
        trait: 'the dark edge',
        listenFor: 'the shadowed minor 3rd — same skeleton as major, dimmer glow.'
      },
      {
        id: 'diminished',
        label: 'Diminished',
        quality: 'diminished',
        extension: 'none',
        trait: 'the collapsing floor',
        listenFor: 'two stacked minor 3rds — the 5th caves inward into a tritone.'
      },
      {
        id: 'augmented',
        label: 'Augmented',
        quality: 'augmented',
        extension: 'none',
        trait: 'the weightless float',
        listenFor: 'a raised 5th with nothing to push against — a floating prism.'
      },
      {
        id: 'sus',
        label: 'Sus',
        quality: 'sus4',
        extension: 'none',
        trait: 'the held breath',
        listenFor: 'no 3rd at all — a suspended 4th waiting to land.'
      }
    ]
  },
  {
    id: 'sevenths',
    label: 'Sevenths',
    options: [
      {
        id: 'maj7',
        label: 'Major 7',
        quality: 'major',
        extension: 'maj7',
        trait: 'the luminous halo',
        listenFor: 'a bright triad wearing the almost-home ache of the natural 7.'
      },
      {
        id: 'dom7',
        label: 'Dominant 7',
        quality: 'major',
        extension: '7',
        trait: 'the tritone engine',
        listenFor: '3 + ♭7 tension — a major chord leaning hard forward.'
      },
      {
        id: 'min7',
        label: 'Minor 7',
        quality: 'minor',
        extension: '7',
        trait: 'the velvet dark',
        listenFor: 'a minor triad with rounded edges — moody but unbothered.'
      },
      {
        id: 'halfDim7',
        label: 'Half-dim 7',
        quality: 'diminished',
        extension: '7',
        trait: 'the anxious shimmer',
        listenFor: 'a collapsed 5th under a soft minor 7th — worried, not violent.'
      },
      {
        id: 'dim7',
        label: 'Diminished 7',
        quality: 'diminished',
        extension: 'dim7',
        trait: 'the symmetric vortex',
        listenFor: 'stacked minor 3rds all the way up — any note could be the root.'
      }
    ]
  }
];
