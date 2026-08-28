import {
  CHORD_TYPES,
  DURATIONS,
  INTERVALS,
  NOTE_NAMES,
  TEMPLATES,
  type ChordType,
  type DurationDefinition,
  type IntervalDefinition,
  type NoteName,
  type ProgressionTemplate,
  type ScaleQuality,
  type TemplateEntry
} from './musicData';

export interface DiatonicChord {
  id: string;
  degree: string;
  root: NoteName;
  intervals: number[];
  quality: 'major' | 'minor' | 'diminished';
  name: string;
}

export interface SecondaryChord {
  id: string;
  degree: string;
  root: NoteName;
  intervals: number[];
  name: string;
}

export interface ProgressionChord {
  id: string;
  root: NoteName;
  intervals: number[];
  name: string;
  duration: DurationDefinition['id'];
}

export interface ChordSuggestion {
  id: string;
  root: NoteName;
  intervals: number[];
  name: string;
  reason: string;
}

export interface IntervalDetail extends IntervalDefinition {
  secondNote: NoteName;
}

const MAJOR_SCALE_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE_STEPS = [0, 2, 3, 5, 7, 8, 10];
const MAJOR_TRIADS: DiatonicChord['quality'][] = ['major', 'minor', 'minor', 'major', 'major', 'minor', 'diminished'];
const MINOR_TRIADS: DiatonicChord['quality'][] = ['minor', 'diminished', 'major', 'minor', 'minor', 'major', 'major'];
const ROMAN_MAJOR = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const ROMAN_MINOR = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];
const TRIAD_FROM_ROMAN: Record<string, 'maj' | 'min' | 'dim'> = {
  I: 'maj',
  ii: 'min',
  iii: 'min',
  IV: 'maj',
  V: 'maj',
  vi: 'min',
  'vii°': 'dim',
  i: 'min',
  'ii°': 'dim',
  III: 'maj',
  iv: 'min',
  v: 'min',
  VI: 'maj',
  VII: 'maj'
};

const MAJOR_SUGGESTION_RULES: Record<string, { target: string; reason: string }[]> = {
  I: [
    { target: 'IV', reason: 'Move from tonic to the subdominant for motion.' },
    { target: 'V', reason: 'Set up a dominant to resolve back to the tonic.' },
    { target: 'vi', reason: 'Try a relative minor for a softer contrast.' }
  ],
  ii: [
    { target: 'V', reason: 'Classic pre-dominant leading into the dominant (ii–V).' },
    { target: 'vii°', reason: 'Heighten tension with the leading-tone diminished chord.' },
    { target: 'IV', reason: 'Circle back to the subdominant for a plagal movement.' }
  ],
  iii: [
    { target: 'vi', reason: 'Move to the relative minor tonic (iii→vi).' },
    { target: 'IV', reason: 'Use the mediant as a passing chord into the subdominant.' }
  ],
  IV: [
    { target: 'I', reason: 'Resolve the plagal motion back to the tonic.' },
    { target: 'ii', reason: 'Step down into the predominant for ii–V.' },
    { target: 'V', reason: 'Push forward with a subdominant → dominant motion.' }
  ],
  V: [
    { target: 'I', reason: 'Resolve the dominant tension to the tonic.' },
    { target: 'vi', reason: 'Use a deceptive cadence for surprise.' },
    { target: 'IV', reason: 'Loop back through the subdominant for longer cycles.' }
  ],
  vi: [
    { target: 'ii', reason: 'Walk the circle of fifths vi→ii→V→I.' },
    { target: 'IV', reason: 'Move to the subdominant to brighten the colour.' },
    { target: 'iii', reason: 'Use mediant motion for a smoother descent.' }
  ],
  'vii°': [
    { target: 'I', reason: 'Resolve the leading-tone diminished chord to tonic.' },
    { target: 'iii', reason: 'Chromatic mediant option for colour.' }
  ]
};

const MINOR_SUGGESTION_RULES: Record<string, { target: string; reason: string }[]> = {
  i: [
    { target: 'iv', reason: 'Move from tonic to minor subdominant for contrast.' },
    { target: 'VI', reason: 'Borrow warmth from the relative major (VI).' },
    { target: 'v', reason: 'Set up a dominant cadence with v or V.' }
  ],
  'ii°': [
    { target: 'V', reason: 'Leading-tone diminished pushes into the dominant.' },
    { target: 'v', reason: 'Stay in minor dominant territory before resolving.' }
  ],
  III: [
    { target: 'VI', reason: 'Common mediant → submediant motion in minor progressions.' },
    { target: 'iv', reason: 'Shift to iv to prepare a dominant cadence.' }
  ],
  iv: [
    { target: 'V', reason: 'Subdominant to dominant builds classic minor tension.' },
    { target: 'i', reason: 'Resolve plagal motion back to the tonic minor.' }
  ],
  v: [
    { target: 'i', reason: 'Resolve the dominant to tonic minor.' },
    { target: 'VI', reason: 'Deceptive cadence into the relative major.' }
  ],
  VI: [
    { target: 'ii°', reason: 'Use the leading-tone diminished to move toward V.' },
    { target: 'iv', reason: 'Circle motion VI→ii°→V→i.' }
  ],
  VII: [
    { target: 'III', reason: 'Return to the mediant for modal colour.' },
    { target: 'i', reason: 'Resolve the flat VII back to tonic.' }
  ]
};

export function computeFrequency(baseFreq: number, semitoneOffset: number): number {
  return baseFreq * Math.pow(2, semitoneOffset / 12);
}

export function computeIntervalNote(rootNote: NoteName, semitoneOffset: number): NoteName {
  const idx = NOTE_NAMES.indexOf(rootNote);
  if (idx < 0) {
    return 'C';
  }
  const length = NOTE_NAMES.length;
  const newIndex = ((idx + semitoneOffset) % length + length) % length;
  return NOTE_NAMES[newIndex];
}

export function computeChordNotes(rootNote: NoteName, offsets: number[]): NoteName[] {
  return offsets.map(off => computeIntervalNote(rootNote, off));
}

export function getIntervalDetail(root: NoteName, intervalId: string): IntervalDetail | null {
  const interval = INTERVALS.find(i => i.id === intervalId);
  if (!interval) {
    return null;
  }
  return { ...interval, secondNote: computeIntervalNote(root, interval.semitones) };
}

export function computeDiatonicChords(root: NoteName, quality: ScaleQuality): DiatonicChord[] {
  const rootIndex = NOTE_NAMES.indexOf(root);
  if (rootIndex < 0) {
    return [];
  }
  const scale = quality === 'major' ? MAJOR_SCALE_STEPS : MINOR_SCALE_STEPS;
  const triads = quality === 'major' ? MAJOR_TRIADS : MINOR_TRIADS;
  const roman = quality === 'major' ? ROMAN_MAJOR : ROMAN_MINOR;
  const diatonic: DiatonicChord[] = [];
  for (let i = 0; i < 7; i++) {
    const degreeRoot = (rootIndex + scale[i]) % 12;
    const thirdInterval = ((scale[(i + 2) % 7] - scale[i]) + 12) % 12;
    const fifthInterval = ((scale[(i + 4) % 7] - scale[i]) + 12) % 12;
    const qualityForDegree = triads[i];
    const chordRoot = NOTE_NAMES[degreeRoot];
    let name = chordRoot;
    if (qualityForDegree === 'minor') {
      name += 'm';
    } else if (qualityForDegree === 'diminished') {
      name += 'dim';
    }
    diatonic.push({
      id: `${chordRoot}_${qualityForDegree}`,
      degree: roman[i],
      root: chordRoot,
      intervals: [0, thirdInterval, fifthInterval],
      quality: qualityForDegree,
      name
    });
  }
  return diatonic;
}

export function computeSecondaryChords(diatonic: DiatonicChord[]): SecondaryChord[] {
  return diatonic
    .filter(dc => dc.quality !== 'major')
    .map(dc => ({
      id: `${dc.root}_maj`,
      degree: dc.degree.replace('°', '').toUpperCase(),
      root: dc.root,
      intervals: [0, 4, 7],
      name: dc.root
    }));
}

interface RomanInfo {
  degree: number | null;
  quality: 'maj' | 'min' | 'dim' | null;
}

export function parseRomanNumeral(rn: string): RomanInfo {
  if (!rn) {
    return { degree: null, quality: null };
  }
  let quality: RomanInfo['quality'] = null;
  let numeral = rn;
  if (rn.endsWith('°')) {
    quality = 'dim';
    numeral = rn.slice(0, -1);
  }
  if (!quality) {
    const firstChar = numeral.charAt(0);
    quality = firstChar === firstChar.toLowerCase() ? 'min' : 'maj';
  }
  const normalized = numeral.toUpperCase();
  const romanMap: Record<string, number> = {
    I: 0,
    II: 1,
    III: 2,
    IV: 3,
    V: 4,
    VI: 5,
    VII: 6
  };
  const degree = romanMap[normalized] ?? null;
  return { degree, quality };
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function getDynamicChordName(root: NoteName, offsets: number[]): string {
  const normalized = offsets
    .map(o => ((o % 12) + 12) % 12)
    .sort((a, b) => a - b);
  const unique = Array.from(new Set(normalized));
  const match = CHORD_TYPES.find(ch => arraysEqual(ch.intervals, unique));
  if (match) {
    return `${root} ${match.name}`;
  }
  const ints = offsets.filter(o => o !== 0).sort((a, b) => a - b);
  const has = (semitone: number) => ints.includes(semitone);
  let quality = '';
  if (has(3) && has(6)) {
    quality = 'dim';
  } else if (has(4) && has(8)) {
    quality = 'aug';
  } else if (has(4)) {
    quality = '';
  } else if (has(3)) {
    quality = 'm';
  } else if (has(2) && !has(4) && !has(3)) {
    quality = 'sus2';
  } else if (has(5) && !has(4) && !has(3)) {
    quality = 'sus4';
  }
  let suffix = '';
  if (has(11)) {
    suffix = 'maj7';
  } else if (has(10)) {
    suffix = '7';
  } else if (has(9)) {
    suffix = '6';
  } else if (has(8) && quality === 'm') {
    suffix = 'm6';
  }
  const additions: string[] = [];
  if (has(2) && quality !== 'sus2' && !ints.includes(11)) additions.push('9');
  if (has(5) && quality !== 'sus4') additions.push('11');
  if (has(9) && suffix !== '6') additions.push('13');
  if (has(1)) additions.push('b9');
  if (has(6) && quality !== 'dim') additions.push('#11');
  if (has(8) && quality !== 'aug' && suffix !== 'm6') additions.push('#5');
  let name = root;
  if (quality) {
    name += quality;
  }
  if (suffix) {
    name += suffix;
  }
  if (additions.length > 0) {
    additions.forEach(ext => {
      name += ` add${ext}`;
    });
  }
  return name.trim();
}

export function buildTemplateProgression(
  templateId: ProgressionTemplate['id'],
  root: NoteName,
  quality: ScaleQuality
): ProgressionChord[] {
  const tpl = TEMPLATES.find(t => t.id === templateId);
  if (!tpl) {
    return [];
  }
  const rootIndex = NOTE_NAMES.indexOf(root);
  if (rootIndex < 0) {
    return [];
  }
  const mode: ScaleQuality = tpl.mode ?? quality;
  const scale = mode === 'major' ? MAJOR_SCALE_STEPS : MINOR_SCALE_STEPS;
  const progression: ProgressionChord[] = [];
  const entries: TemplateEntry[] = tpl.entries ?? [];
  entries.forEach(entry => {
    const info = parseRomanNumeral(entry.symbol);
    if (info.degree == null) {
      return;
    }
    const triadQuality = info.quality ?? TRIAD_FROM_ROMAN[entry.symbol] ?? 'maj';
    const stepOffset = scale[info.degree];
    const chordRootIndex = (rootIndex + stepOffset) % 12;
    const chordRoot = NOTE_NAMES[chordRootIndex];
    let intervals: number[] = [0, 4, 7];
    if (entry.intervals && entry.intervals.length) {
      intervals = entry.intervals;
    } else if (triadQuality === 'dim') {
      intervals = [0, 3, 6];
    } else if (triadQuality === 'min') {
      intervals = [0, 3, 7];
    }

    let name: string = chordRoot;
    if (entry.label) {
      name = entry.label.includes(chordRoot) ? entry.label : `${chordRoot} ${entry.label}`.trim();
    } else if (triadQuality === 'dim') {
      name = `${chordRoot}dim`;
    } else if (triadQuality === 'min') {
      name = `${chordRoot}m`;
    }

    progression.push({
      id: `${chordRoot}_${entry.symbol}`,
      root: chordRoot,
      intervals,
      name,
      duration: entry.duration ?? 'whole'
    });
  });
  return progression;
}

export function describeDuration(durationId: DurationDefinition['id']): DurationDefinition {
  const fallback = DURATIONS.find(d => d.id === durationId);
  return fallback ?? DURATIONS[0];
}

export function findChordType(chordId: string): ChordType | undefined {
  return CHORD_TYPES.find(ch => ch.id === chordId);
}

export function findInterval(intervalId: string): IntervalDefinition | undefined {
  return INTERVALS.find(intv => intv.id === intervalId);
}

function normalizeIntervals(intervals: number[]): number[] {
  return Array.from(new Set(intervals.map(intv => ((intv % 12) + 12) % 12))).sort((a, b) => a - b);
}

function inferTriadQuality(intervals: number[]): 'major' | 'minor' | 'diminished' | 'other' {
  const normalized = normalizeIntervals(intervals);
  if (normalized.includes(3) && normalized.includes(6)) {
    return 'diminished';
  }
  if (normalized.includes(4) && normalized.includes(7)) {
    return 'major';
  }
  if (normalized.includes(3) && normalized.includes(7)) {
    return 'minor';
  }
  return 'other';
}

function matchRomanForChord(
  chord: ProgressionChord,
  diatonic: DiatonicChord[]
): { symbol: string; quality: DiatonicChord['quality'] } | null {
  const triadQuality = inferTriadQuality(chord.intervals);
  if (triadQuality === 'other') {
    return null;
  }
  const match = diatonic.find(dc => dc.root === chord.root && dc.quality === triadQuality);
  if (!match) {
    return null;
  }
  return { symbol: match.degree, quality: match.quality };
}

function ensureUniqueSuggestions(items: ChordSuggestion[]): ChordSuggestion[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.root}-${item.intervals.join('-')}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildSuggestionFromDiatonic(
  symbol: string,
  diatonic: DiatonicChord[],
  reason: string
): ChordSuggestion | null {
  const match = diatonic.find(dc => dc.degree === symbol);
  if (!match) {
    return null;
  }
  return {
    id: `${match.root}_${symbol}`,
    root: match.root,
    intervals: match.intervals,
    name: match.name,
    reason
  };
}

export function suggestChordsForProgression(
  progression: ProgressionChord[],
  root: NoteName,
  quality: ScaleQuality
): ChordSuggestion[] {
  const diatonic = computeDiatonicChords(root, quality);
  if (!diatonic.length) {
    return [];
  }

  const lastChord = progression.at(-1);
  let baseSymbol: string | null = null;
  if (lastChord) {
    const match = matchRomanForChord(lastChord, diatonic);
    baseSymbol = match?.symbol ?? null;
  }

  const rules = quality === 'major' ? MAJOR_SUGGESTION_RULES : MINOR_SUGGESTION_RULES;
  const defaultTargets = quality === 'major' ? ['I', 'V', 'vi', 'IV'] : ['i', 'VI', 'III', 'iv'];
  const suggestions: ChordSuggestion[] = [];

  if (baseSymbol && rules[baseSymbol]) {
    rules[baseSymbol].forEach(rule => {
      const suggestion = buildSuggestionFromDiatonic(rule.target, diatonic, rule.reason);
      if (suggestion) {
        suggestions.push(suggestion);
      }
    });
  } else {
    defaultTargets.forEach(target => {
      const suggestion = buildSuggestionFromDiatonic(
        target,
        diatonic,
        'Common starting chord in this key.'
      );
      if (suggestion) {
        suggestions.push(suggestion);
      }
    });
  }

  // Check for cadence completion opportunities (e.g. ii–V → I)
  if (progression.length >= 2) {
    const lastTwo = progression.slice(-2);
    const symbols = lastTwo
      .map(chord => matchRomanForChord(chord, diatonic)?.symbol)
      .filter((symbol): symbol is string => Boolean(symbol));
    if (symbols.length === 2) {
      const joined = `${symbols[0]}-${symbols[1]}`;
      if (joined === 'ii-V' || joined === 'iv-V') {
        const tonic = buildSuggestionFromDiatonic('I', diatonic, 'Resolve the cadence back to tonic.');
        if (tonic) {
          suggestions.unshift(tonic);
        }
      }
      if (joined === 'V-I') {
        const relative = buildSuggestionFromDiatonic('vi', diatonic, 'Try a deceptive cadence after V–I.');
        if (relative) {
          suggestions.push(relative);
        }
      }
    }
  }

  if (lastChord) {
    const circleTargetRoot = computeIntervalNote(lastChord.root, 5);
    const circleMatch = diatonic.find(dc => dc.root === circleTargetRoot);
    if (circleMatch) {
      suggestions.push({
        id: `${circleMatch.root}_circle`,
        root: circleMatch.root,
        intervals: circleMatch.intervals,
        name: circleMatch.name,
        reason: 'Circle-of-fifths motion keeps the harmony flowing.'
      });
    }
  }

  const unique = ensureUniqueSuggestions(suggestions);
  return unique.slice(0, 6);
}
