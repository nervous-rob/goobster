import { LIBRARY_CONTOUR_TAGS, LIBRARY_DRUM_PATTERNS, findLibraryDrumPattern, stretchDrumSteps } from './genreLibrary';
import { CONTOUR_PRESETS, findContour, makeCreatureId, type CreatureKind, type DrumRole, type SavedCreature } from './stageData';
import { VOICE_PRESETS, findVoice } from './voiceData';

/**
 * Creature recommendation engine for the Song Wizard. Voice and contour
 * presets are tagged with descriptors (energy, brightness, role affinity);
 * given a target energy profile the engine scores combinations and proposes
 * candidate creatures, chord voices, and drum pattern variants.
 */

export interface VoiceTags {
  /** How energetic the voice reads (0 calm .. 1 aggressive). */
  energy: number;
  brightness: number;
  /** Role affinities (0..1). */
  bass: number;
  lead: number;
  chords: number;
}

export const VOICE_TAGS: Record<string, VoiceTags> = {
  'glass-pad': { energy: 0.45, brightness: 0.7, bass: 0.35, lead: 0.8, chords: 0.9 },
  'warm-organ': { energy: 0.35, brightness: 0.5, bass: 0.7, lead: 0.5, chords: 0.85 },
  'pluck-choir': { energy: 0.75, brightness: 0.75, bass: 0.55, lead: 0.85, chords: 0.6 },
  'saw-swell': { energy: 0.3, brightness: 0.4, bass: 0.6, lead: 0.55, chords: 0.8 },
  'bell-choir': { energy: 0.6, brightness: 0.85, bass: 0.2, lead: 0.85, chords: 0.55 },
  'soft-brass': { energy: 0.55, brightness: 0.45, bass: 0.9, lead: 0.6, chords: 0.7 }
};

export interface ContourTags {
  /** Note density across the bar (0 sparse .. 1 every subdivision). */
  density: number;
  energy: number;
  bass: number;
  lead: number;
}

export const CONTOUR_TAGS: Record<string, ContourTags> = {
  'root-anchor': { density: 0.1, energy: 0.15, bass: 0.95, lead: 0.3 },
  'walking-pulse': { density: 0.5, energy: 0.5, bass: 0.9, lead: 0.55 },
  'arpeggio-rise': { density: 0.5, energy: 0.55, bass: 0.5, lead: 0.85 },
  pendulum: { density: 0.5, energy: 0.6, bass: 0.75, lead: 0.7 },
  'pulse-eighths': { density: 1, energy: 0.95, bass: 0.8, lead: 0.6 },
  'sparse-call': { density: 0.3, energy: 0.35, bass: 0.35, lead: 0.9 },
  ...LIBRARY_CONTOUR_TAGS
};

function voiceTags(id: string): VoiceTags {
  return VOICE_TAGS[id] ?? { energy: 0.5, brightness: 0.5, bass: 0.5, lead: 0.5, chords: 0.5 };
}

function contourTags(id: string): ContourTags {
  return CONTOUR_TAGS[id] ?? { density: 0.5, energy: 0.5, bass: 0.5, lead: 0.5 };
}

// --- Candidate creatures ---

export interface CreatureCandidate {
  name: string;
  kind: CreatureKind;
  voiceId: string;
  contourId: string;
  octaveShift: number;
  /** Why the engine proposed it. */
  reason: string;
}

const LOW_ADJECTIVES = ['Velvet', 'Drowsy', 'Misty', 'Hollow'];
const MID_ADJECTIVES = ['Amber', 'Drifting', 'Gilded', 'Tidal'];
const HIGH_ADJECTIVES = ['Blazing', 'Skittering', 'Voltaic', 'Feral'];
const BASS_NOUNS = ['Serpent', 'Rumbler', 'Undertow', 'Burrower'];
const LEAD_NOUNS = ['Wisp', 'Dart', 'Comet', 'Glider'];

function candidateName(kind: CreatureKind, energy: number, index: number): string {
  const adjectives = energy < 0.4 ? LOW_ADJECTIVES : energy < 0.7 ? MID_ADJECTIVES : HIGH_ADJECTIVES;
  const nouns = kind === 'bass' ? BASS_NOUNS : LEAD_NOUNS;
  return `${adjectives[index % adjectives.length]} ${nouns[index % nouns.length]}`;
}

function describeCandidate(kind: CreatureKind, voiceId: string, contourId: string, energy: number): string {
  const voice = findVoice(voiceId);
  const contour = findContour(contourId);
  const mood = energy < 0.4 ? 'a low-glow' : energy < 0.7 ? 'a steady' : 'a high-voltage';
  return `${voice.name} riding ${contour.name} — ${mood} ${kind === 'bass' ? 'low-end' : 'top-line'} fit.`;
}

/**
 * Scores every voice × contour combination for a role against a target
 * energy, avoiding voices already used elsewhere in the song, and returns
 * the top candidates (distinct voices first).
 */
export function recommendCreatures(
  kind: CreatureKind,
  energy: number,
  excludeVoiceIds: string[] = [],
  count = 3
): CreatureCandidate[] {
  interface Scored {
    voiceId: string;
    contourId: string;
    score: number;
  }

  const scored: Scored[] = [];
  VOICE_PRESETS.forEach(voice => {
    const vt = voiceTags(voice.id);
    CONTOUR_PRESETS.forEach(contour => {
      const ct = contourTags(contour.id);
      const affinity = (kind === 'bass' ? vt.bass + ct.bass : vt.lead + ct.lead) / 2;
      const energyFit = 1 - (Math.abs(vt.energy - energy) + Math.abs(ct.energy - energy)) / 2;
      const duplicatePenalty = excludeVoiceIds.includes(voice.id) ? 0.35 : 0;
      const jitter = Math.random() * 0.08;
      scored.push({
        voiceId: voice.id,
        contourId: contour.id,
        score: affinity * 1.1 + energyFit * 0.9 - duplicatePenalty + jitter
      });
    });
  });

  scored.sort((a, b) => b.score - a.score);

  const picked: Scored[] = [];
  // First pass prefers distinct voices so the three candidates feel different.
  scored.forEach(s => {
    if (picked.length >= count) return;
    if (picked.some(p => p.voiceId === s.voiceId)) return;
    picked.push(s);
  });
  scored.forEach(s => {
    if (picked.length >= count) return;
    if (picked.some(p => p.voiceId === s.voiceId && p.contourId === s.contourId)) return;
    picked.push(s);
  });

  return picked.map((s, i) => ({
    name: candidateName(kind, energy, i),
    kind,
    voiceId: s.voiceId,
    contourId: s.contourId,
    octaveShift: kind === 'bass' ? (energy > 0.7 ? 0 : energy < 0.35 ? -1 : 0) : energy > 0.7 ? 1 : 0,
    reason: describeCandidate(kind, s.voiceId, s.contourId, energy)
  }));
}

export function candidateToSavedCreature(candidate: CreatureCandidate): SavedCreature {
  return {
    id: makeCreatureId(),
    name: candidate.name,
    kind: candidate.kind,
    voiceId: candidate.voiceId,
    contourId: candidate.contourId,
    octaveShift: candidate.octaveShift
  };
}

/** Picks a chord-organism voice matched to the song's energy profile. */
export function recommendChordVoice(energy: number, excludeVoiceIds: string[] = []): { voiceId: string; reason: string } {
  let best = VOICE_PRESETS[0].id;
  let bestScore = -Infinity;
  VOICE_PRESETS.forEach(voice => {
    const vt = voiceTags(voice.id);
    const score =
      vt.chords * 1.2 + (1 - Math.abs(vt.energy - energy)) - (excludeVoiceIds.includes(voice.id) ? 0.3 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = voice.id;
    }
  });
  return { voiceId: best, reason: `${findVoice(best).name} carries the harmony at this energy.` };
}

// --- Drum pattern variants ---

export interface DrumPatternVariant {
  id: string;
  name: string;
  energy: number;
  blurb: string;
}

export const DRUM_VARIANTS: DrumPatternVariant[] = [
  { id: 'heartbeat', name: 'Heartbeat', energy: 0.25, blurb: 'Sparse pulse — kick anchors, hats only on the strong steps.' },
  { id: 'classic', name: 'Classic Backbeat', energy: 0.5, blurb: 'The house groove: stomps, backbeat snaps, skittering hats.' },
  { id: 'driving', name: 'Driving Rush', energy: 0.85, blurb: 'Doubled kicks and relentless hats. Built for choruses.' }
];

/** Core variants plus every named drum pattern in the genre library. */
export const ALL_DRUM_VARIANTS: DrumPatternVariant[] = [
  ...DRUM_VARIANTS,
  ...LIBRARY_DRUM_PATTERNS.map(p => ({ id: p.id, name: p.name, energy: p.energy, blurb: p.blurb }))
];

export function findDrumVariant(id: string | undefined): DrumPatternVariant | null {
  return ALL_DRUM_VARIANTS.find(v => v.id === id) ?? null;
}

export function recommendDrumVariant(energy: number): DrumPatternVariant {
  let best = DRUM_VARIANTS[0];
  let bestDist = Infinity;
  DRUM_VARIANTS.forEach(v => {
    const dist = Math.abs(v.energy - energy);
    if (dist < bestDist) {
      bestDist = dist;
      best = v;
    }
  });
  return best;
}

/**
 * Seeds a drum pattern for a grouping at a named variant intensity. Genre
 * library patterns are authored on the generic bar and stretched to fit; the
 * 'classic' variant matches the Stage's default seeding behavior.
 */
export function buildDrumVariant(role: DrumRole, grouping: number[], variantId: string): boolean[] {
  const libraryPattern = findLibraryDrumPattern(variantId);
  if (libraryPattern) return stretchDrumSteps(libraryPattern.steps[role], grouping);

  const steps: boolean[] = [];
  let side: 0 | 1 = 0;
  grouping.forEach(groupSize => {
    for (let i = 0; i < groupSize; i++) {
      const isStrong = i === 0;
      const isMid = groupSize >= 3 && i === Math.floor(groupSize / 2);
      if (variantId === 'heartbeat') {
        if (role === 'kick') steps.push(isStrong);
        else if (role === 'snare') steps.push(isStrong && side === 1);
        else steps.push(isStrong);
      } else if (variantId === 'driving') {
        if (role === 'kick') steps.push(isStrong || isMid);
        else if (role === 'snare') steps.push((isStrong && side === 1) || (isMid && side === 0));
        else steps.push(true);
      } else {
        if (role === 'kick') steps.push(isStrong);
        else if (role === 'snare') steps.push(isStrong && side === 1);
        else steps.push(true);
      }
    }
    side = side === 0 ? 1 : 0;
  });
  return steps;
}
