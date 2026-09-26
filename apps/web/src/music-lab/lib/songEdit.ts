// ESM façade so Vite/TS named-import the CommonJS Studio editing helpers
// (`songEdit.cjs` stays plain CommonJS so Jest can require() it).
import songEdit from './songEdit.cjs';
import type { SongClip, SongProject, SongSection, SongTrack } from './songData';
import type { GridResolution } from './rhythmTheory';

export interface EditHistory<T> {
  past: T[];
  future: T[];
  lastPushAt: number;
  limit: number;
}

export type ParsedSongFile = { ok: true; project: SongProject } | { ok: false; error: string };

type MakeId = (prefix: string) => string;

interface ClockInput {
  subdivisions: number;
  bpm: number;
  resolution: GridResolution;
}

export const SONG_FILE_FORMAT = songEdit.SONG_FILE_FORMAT as string;
export const SONG_FILE_VERSION = songEdit.SONG_FILE_VERSION as number;

export const createHistory = songEdit.createHistory as <T>(limit?: number) => EditHistory<T>;
export const recordHistory = songEdit.recordHistory as <T>(
  history: EditHistory<T>,
  snapshot: T,
  now: number,
  coalesceMs?: number
) => EditHistory<T>;
export const undoHistory = songEdit.undoHistory as <T>(
  history: EditHistory<T>,
  current: T
) => { history: EditHistory<T>; snapshot: T } | null;
export const redoHistory = songEdit.redoHistory as <T>(
  history: EditHistory<T>,
  current: T
) => { history: EditHistory<T>; snapshot: T } | null;

export const splitClipAt = songEdit.splitClipAt as (
  clips: SongClip[],
  clipId: string,
  measure: number,
  makeId: MakeId
) => SongClip[];
export const mergeAdjacentClips = songEdit.mergeAdjacentClips as (clips: SongClip[], trackId: string) => SongClip[];
export const pasteClip = songEdit.pasteClip as (
  clips: SongClip[],
  clip: Pick<SongClip, 'lengthMeasures'>,
  target: { trackId: string; startMeasure: number; totalMeasures: number },
  makeId: MakeId
) => SongClip[];
export const duplicateClip = songEdit.duplicateClip as (
  clips: SongClip[],
  clipId: string,
  totalMeasures: number,
  makeId: MakeId
) => SongClip[];

export interface SectionSpan {
  id: string;
  start: number;
  end: number;
}

/** A section plus the clips inside it, offsets relative to the section start. */
export interface SectionPayload {
  section: SongSection;
  pieces: { trackId: string; offset: number; length: number }[];
}

export const sectionSpans = songEdit.sectionSpans as (sections: SongSection[]) => SectionSpan[];
export const reorderSections = songEdit.reorderSections as (
  project: SongProject,
  sectionId: string,
  toIndex: number,
  makeId: MakeId
) => SongProject;
export const duplicateSection = songEdit.duplicateSection as (
  project: SongProject,
  sectionId: string,
  makeId: MakeId
) => SongProject;
export const copySectionPayload = songEdit.copySectionPayload as (
  project: SongProject,
  sectionId: string
) => SectionPayload | null;
export const pasteSection = songEdit.pasteSection as (
  project: SongProject,
  payload: SectionPayload,
  afterIndex: number,
  makeId: MakeId
) => SongProject;

export const moveTrack = songEdit.moveTrack as (tracks: SongTrack[], trackId: string, direction: -1 | 1) => SongTrack[];
export const copyName = songEdit.copyName as (name: string, taken?: string[]) => string;
export const duplicateTrack = songEdit.duplicateTrack as (
  project: SongProject,
  trackId: string,
  makeId: MakeId
) => SongProject;

export const stepSeconds = songEdit.stepSeconds as (bpm: number, resolution: GridResolution) => number;
export const songDurationSeconds = songEdit.songDurationSeconds as (
  input: ClockInput & { totalMeasures: number }
) => number;
export const elapsedSeconds = songEdit.elapsedSeconds as (input: ClockInput & { measure: number; sub: number }) => number;
export const formatClock = songEdit.formatClock as (seconds: number) => string;

export const serializeSongProject = songEdit.serializeSongProject as (project: SongProject, exportedAt?: string) => string;
export const parseSongProjectFile = songEdit.parseSongProjectFile as (text: string, makeId: MakeId) => ParsedSongFile;
export const songFileName = songEdit.songFileName as (name: string, extension: string) => string;
