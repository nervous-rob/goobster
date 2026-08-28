import { useCallback, useMemo } from 'react';
import { CUSTOM_RHYTHM_STORAGE_KEY, RHYTHMS, type RhythmDefinition } from '@music-lab/lib/rhythmData';
import { useLocalStorage } from '@music-lab/hooks/useLocalStorage';

/**
 * The rhythm presets plus the custom Euclidean blueprint synthesized in the
 * Rhythm Engine — so a rhythm forged there is selectable on the Stage, in the
 * Studio, and in the Song Wizard.
 */
export function useRhythmOptions() {
  const [custom] = useLocalStorage<RhythmDefinition | null>(CUSTOM_RHYTHM_STORAGE_KEY, null);

  const rhythms = useMemo(
    () => (custom?.grouping?.length ? [...RHYTHMS, custom] : RHYTHMS),
    [custom]
  );

  const findRhythm = useCallback(
    (id: string | undefined): RhythmDefinition => rhythms.find(r => r.id === id) ?? RHYTHMS[0],
    [rhythms]
  );

  return { rhythms, findRhythm };
}
