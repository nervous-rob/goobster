export type NoteName =
  | 'C'
  | 'C#'
  | 'D'
  | 'D#'
  | 'E'
  | 'F'
  | 'F#'
  | 'G'
  | 'G#'
  | 'A'
  | 'A#'
  | 'B';

export type ScaleQuality = 'major' | 'minor';

export interface IntervalDefinition {
  id: string;
  name: string;
  degree: string;
  semitones: number;
  descriptors: string;
  chords: string[];
}

export interface ChordType {
  id: string;
  name: string;
  intervals: number[];
  description: string;
  uses: string[];
}

export interface DurationDefinition {
  id: string;
  label: string;
  beats: number;
}

export interface TemplateEntry {
  symbol: string;
  duration?: DurationDefinition['id'];
  intervals?: number[];
  label?: string;
}

export interface ProgressionTemplate {
  id: string;
  label: string;
  mode: ScaleQuality;
  entries: TemplateEntry[];
}

export const NOTE_FREQUENCIES: Record<NoteName, number> = {
  C: 261.63,
  'C#': 277.18,
  D: 293.66,
  'D#': 311.13,
  E: 329.63,
  F: 349.23,
  'F#': 369.99,
  G: 392.0,
  'G#': 415.3,
  A: 440.0,
  'A#': 466.16,
  B: 493.88
};

export const NOTE_NAMES = Object.keys(NOTE_FREQUENCIES) as NoteName[];

export const INTERVALS: IntervalDefinition[] = [
  { id: 'asc-0', name: 'Unison (Perfect)', degree: '1st', semitones: 0, descriptors: 'Neutral, unity, stable', chords: ['Unison doubling in melodies', 'Useful for reinforcement'] },
  { id: 'asc-1', name: 'Minor second (m2)', degree: '2nd', semitones: 1, descriptors: 'Melancholy, displeasure, anguish, darkness', chords: ['Major 7th chords feature this interval between the 7th and root', 'Cluster chords and jazz tensions'] },
  { id: 'asc-2', name: 'Major second (M2)', degree: '2nd', semitones: 2, descriptors: 'Pleasurable longing, neutral passing tone', chords: ['Sus2 chords: root, major 2nd, perfect 5th', 'Ninth chords and add2 chords'] },
  { id: 'asc-3', name: 'Minor third (m3)', degree: '3rd', semitones: 3, descriptors: 'Tragedy, sadness', chords: ['Minor chords: root + minor 3rd + perfect 5th', 'Diminished chords (root, minor 3rd, diminished 5th)'] },
  { id: 'asc-4', name: 'Major third (M3)', degree: '3rd', semitones: 4, descriptors: 'Joy, happiness, brightness', chords: ['Major chords: root + major 3rd + perfect 5th', 'Augmented chords (root, major 3rd, augmented 5th)'] },
  { id: 'asc-5', name: 'Perfect fourth (P4)', degree: '4th', semitones: 5, descriptors: 'Buoyancy, pathos', chords: ['Sus4 chords: root, perfect 4th, perfect 5th', 'Plagal cadences (IV→I) in progressions'] },
  { id: 'asc-6', name: 'Tritone (TT)', degree: 'Augmented 4th / Diminished 5th', semitones: 6, descriptors: 'Violence, danger, tension, “devil in music”', chords: ['Diminished chords: root, minor 3rd, diminished 5th (the tritone)', 'Dominant 7th chords contain a tritone between the 3rd and 7th'] },
  { id: 'asc-7', name: 'Perfect fifth (P5)', degree: '5th', semitones: 7, descriptors: 'Cheerfulness, stability', chords: ['Power chords: root + perfect 5th (no 3rd)', 'Foundation of major/minor triads'] },
  { id: 'asc-8', name: 'Minor sixth (m6)', degree: '6th', semitones: 8, descriptors: 'Anguish, sadness', chords: ['Minor 6 chords: root, minor 3rd, perfect 5th, major 6th', 'Used to tonicize the relative major'] },
  { id: 'asc-9', name: 'Major sixth (M6)', degree: '6th', semitones: 9, descriptors: 'Winsomeness, pleasurable longing', chords: ['Major 6 chords: root, major 3rd, perfect 5th, major 6th', 'Often used in jazz and pop ballads'] },
  { id: 'asc-10', name: 'Minor seventh (m7)', degree: '7th', semitones: 10, descriptors: 'Irresolution, displeasure, mournfulness', chords: ['Minor 7 chords: root, minor 3rd, perfect 5th, minor 7th', 'Dominant 7 chords: root, major 3rd, perfect 5th, minor 7th'] },
  { id: 'asc-11', name: 'Major seventh (M7)', degree: '7th', semitones: 11, descriptors: 'Aspiration, violent longing', chords: ['Major 7 chords: root, major 3rd, perfect 5th, major 7th', 'Adds dreaminess and jazz colour'] },
  { id: 'asc-12', name: 'Octave (P8)', degree: '8th', semitones: 12, descriptors: 'Lightheartedness', chords: ['Octave doubling for power and fullness', 'Used in melodies for leaps'] },
  { id: 'desc-1', name: 'Descending minor second (m2)', degree: '2nd', semitones: -1, descriptors: 'Melancholy, displeasure, anguish, darkness', chords: ['Used in voice-leading from major 7th back to tonic', 'Cluster chords'] },
  { id: 'desc-2', name: 'Descending major second (M2)', degree: '2nd', semitones: -2, descriptors: 'Pleasurable longing, neutral passing tone', chords: ['Resolution from 9th to root in extended chords', 'Sus2 resolutions'] },
  { id: 'desc-3', name: 'Descending minor third (m3)', degree: '3rd', semitones: -3, descriptors: 'Tragedy, sadness', chords: ['Descending resolution from dominant to major chord', 'Minor chords (descending arpeggio)'] },
  { id: 'desc-4', name: 'Descending major third (M3)', degree: '3rd', semitones: -4, descriptors: 'Joy, happiness, brightness', chords: ['Descending bass motion in major chords', 'Picardy thirds'] },
  { id: 'desc-5', name: 'Descending perfect fourth (P4)', degree: '4th', semitones: -5, descriptors: 'Buoyancy, pathos', chords: ['Plagal cadences (IV→I) descending motion', 'Sus4 resolutions'] },
  { id: 'desc-6', name: 'Descending tritone (TT)', degree: 'Augmented 4th / Diminished 5th', semitones: -6, descriptors: 'Violence, danger, tension', chords: ['Tritone substitution in jazz progressions', 'Descending diminished chords'] },
  { id: 'desc-7', name: 'Descending perfect fifth (P5)', degree: '5th', semitones: -7, descriptors: 'Cheerfulness, stability', chords: ['Common bass motion in circle-of-fifths progressions', 'Power chord descent'] },
  { id: 'desc-8', name: 'Descending minor sixth (m6)', degree: '6th', semitones: -8, descriptors: 'Anguish, sadness', chords: ['Descending bass leaps in minor 6 chords', 'Melodic minor descending leaps'] },
  { id: 'desc-9', name: 'Descending major sixth (M6)', degree: '6th', semitones: -9, descriptors: 'Winsomeness, pleasurable longing', chords: ['Descending leaps in major 6 chords', 'Pentatonic scale resolution'] },
  { id: 'desc-10', name: 'Descending minor seventh (m7)', degree: '7th', semitones: -10, descriptors: 'Irresolution, mournfulness', chords: ['Descending motion in dominant 7th chords', 'Minor 7 descending arpeggios'] },
  { id: 'desc-11', name: 'Descending major seventh (M7)', degree: '7th', semitones: -11, descriptors: 'Aspiration, violent longing', chords: ['Resolution from root back to major 7th (leading tone)', 'Descending jazz melodies'] },
  { id: 'desc-12', name: 'Descending octave (P8)', degree: '8th', semitones: -12, descriptors: 'Lightheartedness', chords: ['Octave leaps downward in melodies', 'Bass lines outlining octaves'] }
];

export const CHORD_TYPES: ChordType[] = [
  { id: 'maj', name: 'Major triad', intervals: [0, 4, 7], description: 'Major chords sound happy and simple', uses: ['Widely used in pop, rock and classical music'] },
  { id: 'min', name: 'Minor triad', intervals: [0, 3, 7], description: 'Minor chords sound sad and serious', uses: ['Create somber or serious moods'] },
  { id: 'dim', name: 'Diminished triad', intervals: [0, 3, 6], description: 'Diminished triads are crunchy and tense, built from two minor thirds and a diminished fifth', uses: ['Introduce tension that resolves to more stable chords'] },
  { id: 'aug', name: 'Augmented triad', intervals: [0, 4, 8], description: 'Augmented chords have a sharpened fifth; they sound angsty and suspenseful', uses: ['Spice up progressions and create anticipation'] },
  { id: 'maj7', name: 'Major seventh', intervals: [0, 4, 7, 11], description: 'Major seventh chords are thoughtful, soft and jazzy', uses: ['Common in jazz, soul and R&B for a dreamy colour'] },
  { id: 'min7', name: 'Minor seventh', intervals: [0, 3, 7, 10], description: 'Minor seventh chords sound moody and contemplative', uses: ['Used in jazz, soul and pop to add depth'] },
  { id: 'dom7', name: 'Dominant seventh', intervals: [0, 4, 7, 10], description: 'Dominant seventh chords sound strong and restless', uses: ['Lead to resolution; prevalent in blues and jazz'] },
  { id: 'sus2', name: 'Suspended 2 (sus2)', intervals: [0, 2, 7], description: 'Sus2 chords sound bright and nervous', uses: ['Create openness and resolve to major or minor chords'] },
  { id: 'sus4', name: 'Suspended 4 (sus4)', intervals: [0, 5, 7], description: 'Sus4 chords replace the third with a perfect fourth creating a suspended feeling', uses: ['Resolve to major or minor chords for tension and release'] },
  { id: 'maj6', name: 'Major sixth', intervals: [0, 4, 7, 9], description: 'Major 6 chords add a major sixth to a major triad for a mellow colour', uses: ['Jazz and pop ballads'] },
  { id: 'min6', name: 'Minor sixth', intervals: [0, 3, 7, 9], description: 'Minor 6 chords add a major sixth to a minor triad; they sound nostalgic', uses: ['Used to tonicize the relative major and in jazz progressions'] }
];

export const DURATIONS: DurationDefinition[] = [
  { id: 'whole', label: 'Whole (4)', beats: 4 },
  { id: 'half', label: 'Half (2)', beats: 2 },
  { id: 'dotted_half', label: 'Dotted Half (3)', beats: 3 },
  { id: 'quarter', label: 'Quarter (1)', beats: 1 },
  { id: 'eighth', label: 'Eighth (1/2)', beats: 0.5 },
  { id: 'triplet', label: 'Triplet (2/3)', beats: 2 / 3 }
];

export const TEMPLATES: ProgressionTemplate[] = [
  {
    id: 'I-V-vi-IV',
    label: 'I–V–vi–IV',
    mode: 'major',
    entries: [
      { symbol: 'I', duration: 'whole' },
      { symbol: 'V', duration: 'whole' },
      { symbol: 'vi', duration: 'whole' },
      { symbol: 'IV', duration: 'whole' }
    ]
  },
  {
    id: 'ii-V-I',
    label: 'ii–V–I',
    mode: 'major',
    entries: [
      { symbol: 'ii', duration: 'whole' },
      { symbol: 'V', duration: 'whole', intervals: [0, 4, 7, 10], label: 'Dominant 7th' },
      { symbol: 'I', duration: 'whole' }
    ]
  },
  {
    id: 'I-IV-V',
    label: 'I–IV–V',
    mode: 'major',
    entries: [
      { symbol: 'I', duration: 'whole' },
      { symbol: 'IV', duration: 'whole' },
      { symbol: 'V', duration: 'whole' }
    ]
  },
  {
    id: 'I-vi-IV-V',
    label: 'I–vi–IV–V',
    mode: 'major',
    entries: [
      { symbol: 'I', duration: 'whole' },
      { symbol: 'vi', duration: 'whole' },
      { symbol: 'IV', duration: 'whole' },
      { symbol: 'V', duration: 'whole' }
    ]
  },
  {
    id: 'i-VII-VI-VII',
    label: 'i–VII–VI–VII (minor)',
    mode: 'minor',
    entries: [
      { symbol: 'i', duration: 'whole', intervals: [0, 3, 7], label: 'A minor' },
      { symbol: 'VII', duration: 'whole', intervals: [0, 4, 7], label: 'G major' },
      { symbol: 'VI', duration: 'whole', intervals: [0, 4, 7], label: 'F major' },
      { symbol: 'VII', duration: 'whole', intervals: [0, 4, 7], label: 'G major' }
    ]
  },
  {
    id: 'let-it-be-verse',
    label: 'Let It Be – Verse',
    mode: 'major',
    entries: [
      { symbol: 'I', duration: 'whole', intervals: [0, 4, 7], label: 'C major' },
      { symbol: 'V', duration: 'whole', intervals: [0, 4, 7], label: 'G major' },
      { symbol: 'vi', duration: 'whole', intervals: [0, 3, 7], label: 'A minor' },
      { symbol: 'IV', duration: 'whole', intervals: [0, 4, 7], label: 'F major' },
      { symbol: 'I', duration: 'whole', intervals: [0, 4, 7], label: 'C major' },
      { symbol: 'V', duration: 'whole', intervals: [0, 4, 7, 10], label: 'G7' },
      { symbol: 'IV', duration: 'whole', intervals: [0, 4, 7], label: 'F major' },
      { symbol: 'I', duration: 'whole', intervals: [0, 4, 7], label: 'C major' }
    ]
  },
  {
    id: 'stand-by-me',
    label: 'Stand By Me – Progression',
    mode: 'major',
    entries: [
      { symbol: 'I', duration: 'whole', intervals: [0, 4, 7], label: 'C major' },
      { symbol: 'vi', duration: 'whole', intervals: [0, 3, 7], label: 'A minor' },
      { symbol: 'IV', duration: 'whole', intervals: [0, 4, 7], label: 'F major' },
      { symbol: 'V', duration: 'whole', intervals: [0, 4, 7, 10], label: 'G7' }
    ]
  },
  {
    id: 'house-of-the-rising-sun',
    label: 'House of the Rising Sun – Verse',
    mode: 'minor',
    entries: [
      { symbol: 'i', duration: 'whole', intervals: [0, 3, 7], label: 'A minor' },
      { symbol: 'III', duration: 'whole', intervals: [0, 4, 7], label: 'C major' },
      { symbol: 'IV', duration: 'whole', intervals: [0, 4, 7], label: 'D major' },
      { symbol: 'VI', duration: 'whole', intervals: [0, 4, 7], label: 'F major' },
      { symbol: 'i', duration: 'whole', intervals: [0, 3, 7], label: 'A minor' },
      { symbol: 'III', duration: 'whole', intervals: [0, 4, 7], label: 'C major' },
      { symbol: 'VII', duration: 'whole', intervals: [0, 4, 7], label: 'G major' },
      { symbol: 'i', duration: 'whole', intervals: [0, 3, 7], label: 'A minor' }
    ]
  }
];
