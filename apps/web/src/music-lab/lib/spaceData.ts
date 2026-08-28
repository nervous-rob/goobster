export type ModeId =
  | 'lydian'
  | 'ionian'
  | 'mixolydian'
  | 'dorian'
  | 'aeolian'
  | 'phrygian'
  | 'locrian';

export type ArrangementId = 'fifths' | 'chromatic';

export interface ModeDefinition {
  id: ModeId;
  name: string;
  alias?: string;
  /** Which degree of the parent major scale this mode starts on (0-based). */
  majorDegree: number;
  /** 0 = brightest (Lydian) … 6 = darkest (Locrian). */
  brightnessRank: number;
  feel: string;
}

/** The seven diatonic modes, ordered bright → dark (one flat at a time). */
export const MODES: ModeDefinition[] = [
  {
    id: 'lydian',
    name: 'Lydian',
    majorDegree: 3,
    brightnessRank: 0,
    feel: 'Floating, dreamlike lift — every star in the constellation sits on the bright side of home.'
  },
  {
    id: 'ionian',
    name: 'Ionian',
    alias: 'Major',
    majorDegree: 0,
    brightnessRank: 1,
    feel: 'The familiar major scale: sunny and settled, with one star (the 4th) hanging just below home.'
  },
  {
    id: 'mixolydian',
    name: 'Mixolydian',
    majorDegree: 4,
    brightnessRank: 2,
    feel: 'Major with a relaxed, bluesy slouch — the flattened 7th pulls the ceiling down a notch.'
  },
  {
    id: 'dorian',
    name: 'Dorian',
    majorDegree: 1,
    brightnessRank: 3,
    feel: 'The perfectly balanced mode: home sits dead-centre, three fifths of light above and three of shadow below.'
  },
  {
    id: 'aeolian',
    name: 'Aeolian',
    alias: 'Natural minor',
    majorDegree: 5,
    brightnessRank: 4,
    feel: 'The natural minor scale: most of the constellation hangs below home, giving it that familiar shaded weight.'
  },
  {
    id: 'phrygian',
    name: 'Phrygian',
    majorDegree: 2,
    brightnessRank: 5,
    feel: 'Dark and Spanish-tinged — the flat 2nd presses in a half-step above home like a shadow at the door.'
  },
  {
    id: 'locrian',
    name: 'Locrian',
    majorDegree: 6,
    brightnessRank: 6,
    feel: 'The darkest mode: even the 5th has collapsed, so home itself feels unstable — nothing sits above it.'
  }
];

export interface SpaceIntervalDefinition {
  /** 1..12 semitones above the tonic. */
  semitones: number;
  short: string;
  name: string;
  /** Signed steps around the circle of fifths (-5..+6); |fifths| is the harmonic distance. */
  fifths: number;
  /** Acoustic consonance 0 (rough) .. 1 (smooth). */
  smoothness: number;
  feel: string;
  spatial: string;
}

/**
 * The twelve ascending intervals as the space sees them: chromatic distance,
 * harmonic (circle-of-fifths) distance, and acoustic smoothness. Feel text
 * mirrors the Intervals Explorer descriptors.
 */
export const SPACE_INTERVALS: SpaceIntervalDefinition[] = [
  {
    semitones: 1,
    short: 'm2',
    name: 'Minor second',
    fifths: -5,
    smoothness: 0.08,
    feel: 'Melancholy, displeasure, anguish, darkness',
    spatial: 'Neighbours in pitch but five fifths apart — close to the ear, far in the harmony.'
  },
  {
    semitones: 2,
    short: 'M2',
    name: 'Major second',
    fifths: 2,
    smoothness: 0.38,
    feel: 'Pleasurable longing, a neutral passing tone',
    spatial: 'Two fifths of separation: near enough to feel related, rubbing shoulders in pitch.'
  },
  {
    semitones: 3,
    short: 'm3',
    name: 'Minor third',
    fifths: -3,
    smoothness: 0.7,
    feel: 'Tragedy, sadness',
    spatial: 'Three fifths toward the flat side — the shaded leg of every minor chord.'
  },
  {
    semitones: 4,
    short: 'M3',
    name: 'Major third',
    fifths: 4,
    smoothness: 0.75,
    feel: 'Joy, happiness, brightness',
    spatial: 'Four fifths toward the sharp side — the sunlit leg of every major chord.'
  },
  {
    semitones: 5,
    short: 'P4',
    name: 'Perfect fourth',
    fifths: -1,
    smoothness: 0.82,
    feel: 'Buoyancy, pathos',
    spatial: 'One single fifth, counter-clockwise: home’s nearest neighbour on the dark side.'
  },
  {
    semitones: 6,
    short: 'TT',
    name: 'Tritone',
    fifths: 6,
    smoothness: 0.12,
    feel: 'Violence, danger, tension — “the devil in music”',
    spatial: 'The exact far pole of the ring: six fifths away, as remote as harmony gets.'
  },
  {
    semitones: 7,
    short: 'P5',
    name: 'Perfect fifth',
    fifths: 1,
    smoothness: 0.9,
    feel: 'Cheerfulness, stability',
    spatial: 'One single fifth, clockwise: the shortest harmonic step that exists.'
  },
  {
    semitones: 8,
    short: 'm6',
    name: 'Minor sixth',
    fifths: -4,
    smoothness: 0.58,
    feel: 'Anguish, sadness',
    spatial: 'Four fifths into the flat side — the major third’s shadowed mirror image.'
  },
  {
    semitones: 9,
    short: 'M6',
    name: 'Major sixth',
    fifths: 3,
    smoothness: 0.66,
    feel: 'Winsomeness, pleasurable longing',
    spatial: 'Three fifths sunward — the minor third flipped into the light.'
  },
  {
    semitones: 10,
    short: 'm7',
    name: 'Minor seventh',
    fifths: -2,
    smoothness: 0.35,
    feel: 'Irresolution, mournfulness',
    spatial: 'Two fifths flatward: harmonically near, which is why it loves to resolve.'
  },
  {
    semitones: 11,
    short: 'M7',
    name: 'Major seventh',
    fifths: 5,
    smoothness: 0.2,
    feel: 'Aspiration, violent longing',
    spatial: 'Five fifths sunward and one semitone shy of home — leaning hard on the door.'
  },
  {
    semitones: 12,
    short: 'P8',
    name: 'Octave',
    fifths: 0,
    smoothness: 0.98,
    feel: 'Lightheartedness, unity',
    spatial: 'Zero fifths: the same star seen again. Distance in pitch, none in harmony.'
  }
];

export const TRIAD_FEEL: Record<'major' | 'minor' | 'diminished', string> = {
  major: 'a tight, sunlit triangle leaning sharp-side',
  minor: 'the same tight triangle, tilted into shadow',
  diminished: 'a stretched sliver reaching across the ring — maximum reach, minimum rest'
};
