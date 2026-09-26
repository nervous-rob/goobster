// ESM façade over the CommonJS patch helpers (`songPatch.cjs` mirrors
// packages/core/utils/songPatch.js so the server and every browser apply
// the same patch the same way).
import songPatch from './songPatch.cjs';
import type { SongClip, SongProject, SongSection, SongTrack } from './songData';

export interface CollectionPatch<T> {
  upsert?: T[];
  remove?: string[];
  order?: string[];
}

export type SongSettingsPatch = Partial<{
  [K in 'name' | 'bpm' | 'swing' | 'keyRoot' | 'rhythmId' | 'resolution' | 'grooveId' | 'fills' | 'masterVolume' | 'reverbWet']:
    SongProject[K] | null;
}>;

export interface SongPatch {
  settings?: SongSettingsPatch;
  sections?: CollectionPatch<SongSection>;
  tracks?: CollectionPatch<SongTrack>;
  clips?: CollectionPatch<SongClip>;
}

export const diffProject = songPatch.diffProject as (prev: SongProject, next: SongProject) => SongPatch | null;
export const applyPatch = songPatch.applyPatch as (project: SongProject, patch: SongPatch) => SongProject;
export const isEmptyPatch = songPatch.isEmptyPatch as (patch: unknown) => boolean;
