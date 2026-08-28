import { readConservatoryStorage } from './storage';

export interface RhythmDefinition {
  id: string;
  label: string;
  name: string;
  /** Pulse groupings in eighth-note subdivisions, e.g. [3, 2] for 5/4 long-short. */
  grouping: number[];
  feel: string;
  /** Mnemonic string. Strong syllables are wrapped in <b></b>. */
  mnemonic: string;
}

export const RHYTHMS: RhythmDefinition[] = [
  {
    id: '4-4',
    label: '4/4',
    name: 'Standard Locomotive',
    grouping: [2, 2, 2, 2],
    feel:
      'Perfect symmetry. The weight shifts cleanly left and right in equal measure. This is a balanced engine with continuous, unhindered forward momentum.',
    mnemonic: '<b>Ap</b>-ple, <b>Ap</b>-ple, <b>Ap</b>-ple, <b>Ap</b>-ple'
  },
  {
    id: '5-4-32',
    label: '5/4 (3+2)',
    name: 'Offset Flywheel (Long-Short)',
    grouping: [3, 2],
    feel:
      'An asymmetrical gallop. You experience a deep, heavy, sustained mechanical pull for the first half, followed by a quick, snappy counterbalance stroke to reset the cycle.',
    mnemonic: '<b>Pine</b>-ap-ple, <b>Ap</b>-ple'
  },
  {
    id: '5-4-23',
    label: '5/4 (2+3)',
    name: 'Reverse Flywheel (Short-Long)',
    grouping: [2, 3],
    feel:
      'A quick snap followed by a dragging hang. The engine kicks fast and then forces you to ride out the momentum before the cycle begins again.',
    mnemonic: '<b>Ap</b>-ple, <b>Pine</b>-ap-ple'
  },
  {
    id: '7-8',
    label: '7/8',
    name: 'The Heavy Limp',
    grouping: [2, 2, 3],
    feel:
      'Two standard, balanced strides followed by an extended lurch. It feels like a massive machine operating with one slightly longer linkage arm. It leans into the last beat.',
    mnemonic: '<b>Ap</b>-ple, <b>Ap</b>-ple, <b>Pine</b>-ap-ple'
  },
  {
    id: '9-8',
    label: '9/8',
    name: 'The Stutter Step',
    grouping: [2, 2, 2, 3],
    feel:
      'Often found in Eastern European folk or complex prog. It feels like 4/4 time where the very last beat gets mysteriously stretched out, forcing a drag before resetting.',
    mnemonic: '<b>Ap</b>-ple, <b>Ap</b>-ple, <b>Ap</b>-ple, <b>Pine</b>-ap-ple'
  },
  {
    id: '6-8',
    label: '6/8',
    name: 'The Sway',
    grouping: [3, 3],
    feel:
      'A sweeping, circular momentum. Instead of the piston-like chunk of 4/4, this operates like a waltz on steroids. A heavy anchor on 1 and 4, riding the wave between them.',
    mnemonic: '<b>Pine</b>-ap-ple, <b>Pine</b>-ap-ple'
  }
];

export const CUSTOM_RHYTHM_ID = 'euclid-custom';

/** localStorage key for the Rhythm Engine's synthesized Euclidean blueprint. */
export const CUSTOM_RHYTHM_STORAGE_KEY = 'rhythmCustomBlueprint';

/** Reads the synthesized custom rhythm (null on the server or if unset). */
export function loadCustomRhythm(): RhythmDefinition | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = readConservatoryStorage(CUSTOM_RHYTHM_STORAGE_KEY);
    const custom = raw ? (JSON.parse(raw) as RhythmDefinition) : null;
    return custom?.grouping?.length ? custom : null;
  } catch {
    return null;
  }
}

export const GROUP_WORDS: Record<number, string> = {
  1: '<b>Tap</b>',
  2: '<b>Ap</b>-ple',
  3: '<b>Pine</b>-ap-ple',
  4: '<b>Wa</b>-ter-mel-on',
  5: '<b>Hip</b>-po-pot-a-mus',
  6: '<b>Cat</b>-er-pil-lar-crawl',
  7: '<b>Ele</b>-phant-on-rol-ler-skates'
};
