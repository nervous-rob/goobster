import { CUSTOM_RHYTHM_ID, GROUP_WORDS, type RhythmDefinition } from './rhythmData';

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// --- Grid resolution ---

/**
 * How finely the bar's grid is sliced. Groupings are authored in eighth
 * notes; at 'sixteenth' every grid step is half as long and there are twice
 * as many of them, which is how funk pockets, trap hats, and double-kick
 * walls get their subdivision.
 */
export type GridResolution = 'eighth' | 'sixteenth';

/** Tone.js notation for one grid step at each resolution. */
export const GRID_NOTATION: Record<GridResolution, '8n' | '16n'> = {
  eighth: '8n',
  sixteenth: '16n'
};

export const GRID_STEP_LABEL: Record<GridResolution, string> = {
  eighth: 'eighths',
  sixteenth: 'sixteenths'
};

/** Scales an eighth-note grouping onto the grid (e.g. [3,2] → [6,4] at 16ths). */
export function gridGrouping(grouping: number[], resolution: GridResolution = 'eighth'): number[] {
  return resolution === 'sixteenth' ? grouping.map(g => g * 2) : grouping;
}

// --- Sequencing ---

export interface SequenceStep {
  measure: number;
  subIndex: number;
  absIndex: number;
  groupStartAbs: number;
  isStrong: boolean;
  side: 0 | 1;
  isFillTarget: boolean;
  groupSize: number;
  posInGroup: number;
}

export function totalSubdivisions(grouping: number[]): number {
  return grouping.reduce((a, b) => a + b, 0);
}

/**
 * Expands a grouping into a flat array of per-eighth-note steps across the
 * whole phrase, tagging strong beats, alternating L/R sides per group, and
 * marking the final two steps of the last measure as drum-fill targets.
 */
export function buildSequenceArray(grouping: number[], phraseLength: number): SequenceStep[] {
  const steps: SequenceStep[] = [];
  const total = totalSubdivisions(grouping);
  let absIndex = 0;
  for (let measure = 1; measure <= phraseLength; measure++) {
    let subdivisionIndex = 0;
    let sideToggle: 0 | 1 = 0;
    grouping.forEach(groupSize => {
      const groupStartAbs = absIndex;
      for (let i = 0; i < groupSize; i++) {
        const isLastInMeasure = subdivisionIndex === total - 1;
        const isSecondToLast = subdivisionIndex === total - 2;
        steps.push({
          measure,
          subIndex: subdivisionIndex,
          absIndex,
          groupStartAbs,
          isStrong: i === 0,
          side: sideToggle,
          isFillTarget: measure === phraseLength && (isLastInMeasure || isSecondToLast),
          groupSize,
          posInGroup: i
        });
        subdivisionIndex++;
        absIndex++;
      }
      sideToggle = sideToggle === 0 ? 1 : 0;
    });
  }
  return steps;
}

// --- Euclidean foundry ---

export function makeEuclideanPattern(steps: number, pulses: number, offset = 0): boolean[] {
  const safePulses = clamp(pulses, 1, steps);
  const pattern: boolean[] = Array(steps).fill(false);
  let bucket = 0;
  for (let i = 0; i < steps; i++) {
    bucket += safePulses;
    if (bucket >= steps) {
      bucket -= steps;
      pattern[i] = true;
    }
  }
  const firstPulse = pattern.indexOf(true);
  let finalPattern = firstPulse <= 0 ? pattern : pattern.slice(firstPulse).concat(pattern.slice(0, firstPulse));
  if (offset > 0) {
    const shift = offset % steps;
    finalPattern = finalPattern.slice(steps - shift).concat(finalPattern.slice(0, steps - shift));
  }
  return finalPattern;
}

export function patternToGrouping(pattern: boolean[]): number[] {
  const onsets = pattern.map((on, i) => (on ? i : -1)).filter(i => i >= 0);
  if (!onsets.length) {
    return [pattern.length];
  }
  return onsets.map((idx, i) => {
    const next = onsets[(i + 1) % onsets.length] + (i === onsets.length - 1 ? pattern.length : 0);
    return next - idx;
  });
}

export function formatGroupWord(size: number): string {
  return GROUP_WORDS[size] ?? `<b>${size}</b>-step`;
}

export function groupingToMnemonic(grouping: number[]): string {
  return grouping.map(formatGroupWord).join(', ');
}

export function buildEuclideanRhythm(steps: number, pulses: number, offset: number): RhythmDefinition {
  const pattern = makeEuclideanPattern(steps, pulses, offset);
  const grouping = patternToGrouping(pattern);
  return {
    id: CUSTOM_RHYTHM_ID,
    label: `E(${pulses},${steps}) R${offset}`,
    name: 'Euclidean Pulse Machine',
    grouping,
    feel: `A generated rhythm with ${pulses} evenly distributed pulse engines across ${steps} eighth-note slots. The result is mathematically balanced, but it can feel alien until your body locks onto the repeating gap pattern: ${grouping.join('+')}.`,
    mnemonic: groupingToMnemonic(grouping)
  };
}

// --- Pulse physics ---

export interface GroovePhysics {
  total: number;
  density: number;
  asymmetry: number;
  longShortRatio: number;
  maxGroup: number;
  minGroup: number;
}

export function computeGroovePhysics(grouping: number[]): GroovePhysics {
  const total = totalSubdivisions(grouping) || 1;
  const count = Math.max(1, grouping.length);
  const mean = total / count;
  const variance = grouping.reduce((a, g) => a + Math.pow(g - mean, 2), 0) / count;
  const maxGroup = grouping.length ? Math.max(...grouping) : 1;
  const minGroup = grouping.length ? Math.min(...grouping) : 1;
  return {
    total,
    density: count / total,
    asymmetry: Math.sqrt(variance) / mean,
    longShortRatio: maxGroup / Math.max(1, minGroup),
    maxGroup,
    minGroup
  };
}

// --- Biological & procedural creature generation pipeline ---

export interface CreatureGenome {
  grouping: number[];
  total: number;
  groupCount: number;
  density: number;
  asymmetry: number;
  longShortRatio: number;
  bpm: number;
  swing: number;
  phraseLength: number;
  ghostMode: boolean;
  drumsEnabled: boolean;
  polyRatio: number;
  euclidean: { steps: number; pulses: number; offset: number } | null;
}

export interface GenomeInputs {
  grouping: number[];
  bpm: number;
  swing: number;
  phraseLength: number;
  ghostMode: boolean;
  drumsEnabled: boolean;
  polyRatio: number;
  isEuclidean: boolean;
  euclidSteps: number;
  euclidPulses: number;
  euclidOffset: number;
}

export interface CreatureLimb {
  index: number;
  side: 'left' | 'right';
  length: number;
  thickness: number;
  phaseOffset: number;
  startSubdivision: number;
  strideDuration: number;
  force: number;
}

export interface CreatureFootfall {
  limbIndex: number;
  startSubdivision: number;
  duration: number;
  side: 'left' | 'right';
  force: number;
}

export interface Creature {
  id: string;
  name: string;
  genome: CreatureGenome;
  body: {
    spine: { baseX: number; baseY: number; radius: number }[];
    limbs: CreatureLimb[];
    head: { size: number; forwardLean: number; eyeCount: number };
    tail: { segments: number; curl: number; glowEvery: number };
    satellites: { angle: number; radius: number; pulseIndex: number }[];
  };
  gait: { footfalls: CreatureFootfall[] };
  pose: {
    activeLimb: number;
    bodyLean: number;
    compression: number;
    stepReach: number;
    breath: number;
    flare: number;
  };
}

export function makeCreatureGenome(inputs: GenomeInputs): CreatureGenome {
  const grouping = inputs.grouping.length ? inputs.grouping : [2, 2, 2, 2];
  const physics = computeGroovePhysics(grouping);
  return {
    grouping,
    total: physics.total,
    groupCount: grouping.length,
    density: physics.density,
    asymmetry: physics.asymmetry,
    longShortRatio: physics.longShortRatio,
    bpm: inputs.bpm,
    swing: inputs.swing,
    phraseLength: inputs.phraseLength,
    ghostMode: inputs.ghostMode,
    drumsEnabled: inputs.drumsEnabled,
    polyRatio: inputs.polyRatio,
    euclidean: inputs.isEuclidean
      ? { steps: inputs.euclidSteps, pulses: inputs.euclidPulses, offset: inputs.euclidOffset }
      : null
  };
}

export function getGenomeId(g: CreatureGenome): string {
  return `${g.grouping.join('-')}_${g.swing}_${g.phraseLength}_${g.polyRatio}_${g.ghostMode}_${g.drumsEnabled}_${g.euclidean ? 'E' : 'N'}`;
}

export function classifyCreature(genome: CreatureGenome): string {
  if (genome.euclidean) return 'Euclidean Chimera';
  if (genome.asymmetry < 0.05 && genome.groupCount >= 4) return 'Symmetric Strider';
  if (genome.longShortRatio >= 1.5 && genome.groupCount === 2) return 'Limping Bipod';
  if (genome.groupCount === 3 && genome.longShortRatio >= 1.5) return 'Tripod Lurcher';
  if (genome.groupCount >= 4 && genome.longShortRatio >= 1.5) return 'Stutter-Centipede';
  if (genome.swing > 0.35) return 'Elastic Swaybeast';
  return 'Pulse Walker';
}

function buildSpine(genome: CreatureGenome): Creature['body']['spine'] {
  return Array.from({ length: genome.total }, (_, i) => ({
    baseX: (i - genome.total / 2) * 16,
    baseY: 0,
    radius: 8 + genome.density * 10
  }));
}

function buildLimbs(genome: CreatureGenome): CreatureLimb[] {
  const maxGroup = Math.max(...genome.grouping);
  let t = 0;
  return genome.grouping.map((groupSize, i) => {
    const strength = groupSize / maxGroup;
    const limb: CreatureLimb = {
      index: i,
      side: i % 2 === 0 ? 'left' : 'right',
      length: 25 + groupSize * 12,
      thickness: 4 + strength * 5,
      phaseOffset: (i / genome.groupCount) * 0.8 + 0.1,
      startSubdivision: t,
      strideDuration: groupSize,
      force: strength
    };
    t += groupSize;
    return limb;
  });
}

function buildHead(genome: CreatureGenome): Creature['body']['head'] {
  return {
    size: 18 + genome.density * 12,
    forwardLean: genome.asymmetry * 18,
    eyeCount: genome.euclidean ? genome.euclidean.pulses : 2
  };
}

function buildTail(genome: CreatureGenome): Creature['body']['tail'] {
  return {
    segments: genome.phraseLength,
    curl: genome.swing,
    glowEvery: genome.phraseLength
  };
}

function buildPolyrhythmSatellites(genome: CreatureGenome): Creature['body']['satellites'] {
  if (!genome.polyRatio) return [];
  return Array.from({ length: genome.polyRatio }, (_, i) => ({
    angle: (Math.PI * 2 * i) / genome.polyRatio,
    radius: 45 + genome.polyRatio * 2,
    pulseIndex: i
  }));
}

function buildGait(genome: CreatureGenome): CreatureFootfall[] {
  const maxGroup = Math.max(...genome.grouping);
  let t = 0;
  return genome.grouping.map((groupSize, i) => {
    const event: CreatureFootfall = {
      limbIndex: i,
      startSubdivision: t,
      duration: groupSize,
      side: i % 2 === 0 ? 'left' : 'right',
      force: groupSize / maxGroup
    };
    t += groupSize;
    return event;
  });
}

export function buildCreature(genome: CreatureGenome): Creature {
  return {
    id: getGenomeId(genome),
    name: classifyCreature(genome),
    genome,
    body: {
      spine: buildSpine(genome),
      limbs: buildLimbs(genome),
      head: buildHead(genome),
      tail: buildTail(genome),
      satellites: buildPolyrhythmSatellites(genome)
    },
    gait: { footfalls: buildGait(genome) },
    pose: { activeLimb: 0, bodyLean: 0, compression: 0, stepReach: 0, breath: 0, flare: 0 }
  };
}

export function updateCreaturePose(
  creature: Creature,
  flags: { isFillActive: boolean; ghostMuted: boolean },
  dt: number,
  currentQuarterNote: number
): void {
  const current8th = currentQuarterNote * 2;
  const loop8th = current8th % creature.genome.total;

  const event =
    creature.gait.footfalls.find(f => loop8th >= f.startSubdivision && loop8th < f.startSubdivision + f.duration) ??
    creature.gait.footfalls[0];

  const energy = clamp((creature.genome.bpm - 60) / 180, 0, 1);

  creature.pose.activeLimb = event.limbIndex;
  const targetLean = (event.side === 'left' ? -event.force : event.force) * 15;
  creature.pose.bodyLean += (targetLean - creature.pose.bodyLean) * 10 * dt;

  const targetComp = event.force * 12;
  creature.pose.compression += (targetComp - creature.pose.compression) * 10 * dt;

  creature.pose.breath += dt * (0.8 + energy * 2.0);

  if (flags.isFillActive && !flags.ghostMuted) {
    creature.pose.flare = Math.min(1, creature.pose.flare + 10 * dt);
  } else {
    creature.pose.flare = Math.max(0, creature.pose.flare - 2 * dt);
  }
}
