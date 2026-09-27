// ESM façade over the CommonJS patch helpers (`songPatch.cjs` mirrors
// packages/core/utils/songPatch.js so the server and every browser apply
// the same patch the same way).
import songPatch from './songPatch.cjs';
import type { SongClip, SongProject, SongSection, SongTrack } from './songData';
import type { PerformerState, WrittenNote } from './stageData';

export interface CollectionPatch<T> {
  upsert?: T[];
  remove?: string[];
  order?: string[];
}

/** Field-level edit of one existing track (see songPatch.cjs header). */
export interface TrackEdit {
  id: string;
  set?: Partial<Record<Exclude<keyof SongTrack, 'id' | 'performer'>, unknown>>;
  performer?: {
    set?: Partial<Record<Exclude<keyof PerformerState, 'writtenNotes' | 'drumSteps'>, unknown>>;
    notes?: { upsert?: WrittenNote[]; remove?: string[] };
    steps?: Record<string, boolean>;
  };
}

export interface TrackCollectionPatch extends CollectionPatch<SongTrack> {
  edit?: TrackEdit[];
}

export type SongSettingsPatch = Partial<{
  [K in 'name' | 'bpm' | 'swing' | 'keyRoot' | 'rhythmId' | 'resolution' | 'grooveId' | 'fills' | 'masterVolume' | 'reverbWet']:
    SongProject[K] | null;
}>;

export interface SongPatch {
  settings?: SongSettingsPatch;
  sections?: CollectionPatch<SongSection>;
  tracks?: TrackCollectionPatch;
  clips?: CollectionPatch<SongClip>;
}

export const diffProject = songPatch.diffProject as (prev: SongProject, next: SongProject) => SongPatch | null;
export const applyPatch = songPatch.applyPatch as (project: SongProject, patch: SongPatch) => SongProject;
export const isEmptyPatch = songPatch.isEmptyPatch as (patch: unknown) => boolean;
