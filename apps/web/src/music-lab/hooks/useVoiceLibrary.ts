import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  VOICE_PRESETS,
  getCustomVoicesSnapshot,
  getServerVoicesSnapshot,
  removeCustomVoice,
  saveCustomVoice,
  subscribeCustomVoices,
  type VoicePreset
} from '@music-lab/lib/voiceData';
import { deleteSampleBlob } from '@music-lab/lib/sampleStore';

/**
 * Reactive view of the voice library: core presets merged with user-built
 * custom voices. All components share one store, so saving a voice in the
 * Voice Builder immediately updates every voice dropdown on the page.
 */
export function useVoiceLibrary() {
  const customVoices = useSyncExternalStore(subscribeCustomVoices, getCustomVoicesSnapshot, getServerVoicesSnapshot);

  const allVoices = useMemo(() => [...VOICE_PRESETS, ...customVoices], [customVoices]);

  const deleteVoice = useCallback((preset: VoicePreset) => {
    removeCustomVoice(preset.id);
    if (preset.engine === 'sample' && preset.sample) {
      void deleteSampleBlob(preset.sample.sampleId).catch(() => undefined);
    }
  }, []);

  return { customVoices, allVoices, saveVoice: saveCustomVoice, deleteVoice };
}
