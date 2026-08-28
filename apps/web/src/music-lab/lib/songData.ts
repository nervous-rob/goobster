import type { NoteName } from './musicData';
import type { FoundrySettings } from './harmonyTheory';
import type { GridResolution } from './rhythmTheory';
import { seedDrumPattern, type PerformerRole, type PerformerState, type SavedCreature } from './stageData';

/**
 * Studio song data model: a SongProject is an ordered list of sections (each
 * owning its own chord progression), a set of tracks (creatures wrapped with
 * mix state), and measure-snapped clips that gate when each track plays.
 */

export type SectionKind = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'outro' | 'custom';

export type FillFrequency = 'off' | 'section' | 'every4' | 'every8';

export interface FillSettings {
  /** Where automatic drum fills land. */
  frequency: FillFrequency;
  /** 'short' = last quarter of the bar, 'long' = last half. */
  length: 'short' | 'long';
}

export interface SongSection {
  id: string;
  kind: SectionKind;
  name: string;
  /** Length in measures. */
  measures: number;
  /** Section-local progression; cycles if shorter than the section. */
  chords: FoundrySettings[];
  /** Measures each chord occupies before the lane advances. */
  measuresPerChord: number;
}

export interface SongTrack {
  id: string;
  name: string;
  role: PerformerRole;
  /** Creature payload: voice, contour, drum grid, octave shift, overrides. */
  performer: PerformerState;
  mute: boolean;
  solo: boolean;
  /** Channel level in dB. */
  volume: number;
}

export interface SongClip {
  id: string;
  trackId: string;
  /** 0-based absolute measure within the song. */
  startMeasure: number;
  lengthMeasures: number;
}

export interface SongProject {
  id: string;
  name: string;
  bpm: number;
  swing: number;
  keyRoot: NoteName;
  rhythmId: string;
  /** Grid step length; older saved projects lack it and default to eighths. */
  resolution?: GridResolution;
  /** Last groove preset applied from the genre library (informational). */
  grooveId?: string;
  /** Automatic drum fill behavior; unset = off. */
  fills?: FillSettings;
  sections: SongSection[];
  tracks: SongTrack[];
  clips: SongClip[];
  masterVolume: number;
  reverbWet: number;
}

export const STUDIO_PROJECTS_KEY = 'studioProjects';
export const STUDIO_CURRENT_KEY = 'studioCurrentProjectId';

export const MAX_SECTION_MEASURES = 16;
export const MIN_SECTION_MEASURES = 1;
export const MAX_SECTION_CHORDS = 8;
export const MIN_SECTION_CHORDS = 1;

export interface SectionKindMeta {
  label: string;
  hue: number;
}

export const SECTION_KINDS: SectionKind[] = ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'outro', 'custom'];

export const SECTION_KIND_META: Record<SectionKind, SectionKindMeta> = {
  intro: { label: 'Intro', hue: 200 },
  verse: { label: 'Verse', hue: 160 },
  prechorus: { label: 'Pre-Chorus', hue: 95 },
  chorus: { label: 'Chorus', hue: 35 },
  bridge: { label: 'Bridge', hue: 265 },
  outro: { label: 'Outro', hue: 220 },
  custom: { label: 'Custom', hue: 0 }
};

let idCounter = 0;

export function makeSongId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

// --- Track factories ---

interface RoleTrackDefaults {
  name: string;
  volume: number;
  performer: Omit<PerformerState, 'id'>;
}

function roleDefaults(role: PerformerRole, grouping: number[]): RoleTrackDefaults {
  switch (role) {
    case 'kick':
      return {
        name: 'Kick Stomper',
        volume: -2,
        performer: { role, enabled: true, mute: false, volume: -2, drumSteps: seedDrumPattern('kick', grouping) }
      };
    case 'snare':
      return {
        name: 'Snare Snapper',
        volume: -6,
        performer: { role, enabled: true, mute: false, volume: -6, drumSteps: seedDrumPattern('snare', grouping) }
      };
    case 'hihat':
      return {
        name: 'Hat Skitterer',
        volume: -14,
        performer: { role, enabled: true, mute: false, volume: -14, drumSteps: seedDrumPattern('hihat', grouping) }
      };
    case 'chords':
      return {
        name: 'Harmonic Organism',
        volume: -9,
        performer: { role, enabled: true, mute: false, volume: -9, voiceId: 'glass-pad', harmonyMode: 'follow' }
      };
    case 'bass':
      return {
        name: 'Bass Serpent',
        volume: -7,
        performer: {
          role,
          enabled: true,
          mute: false,
          volume: -7,
          voiceId: 'soft-brass',
          contourId: 'root-anchor',
          octaveShift: 0
        }
      };
    case 'melody':
    default:
      return {
        name: 'Melody Wisp',
        volume: -8,
        performer: {
          role: 'melody',
          enabled: true,
          mute: false,
          volume: -8,
          voiceId: 'glass-pad',
          contourId: 'arpeggio-rise',
          octaveShift: 0
        }
      };
  }
}

export function makeTrackFromRole(role: PerformerRole, grouping: number[]): SongTrack {
  const defaults = roleDefaults(role, grouping);
  const id = makeSongId(`track-${role}`);
  return {
    id,
    name: defaults.name,
    role,
    performer: { ...defaults.performer, id },
    mute: false,
    solo: false,
    volume: defaults.volume
  };
}

export function makeTrackFromCreature(saved: SavedCreature): SongTrack {
  const role: PerformerRole = saved.kind === 'bass' ? 'bass' : 'melody';
  const id = makeSongId('track-hired');
  return {
    id,
    name: saved.name,
    role,
    performer: {
      id,
      role,
      displayName: saved.name,
      enabled: true,
      mute: false,
      volume: -8,
      voiceId: saved.voiceId,
      contourId: saved.contourId,
      octaveShift: saved.octaveShift
    },
    mute: false,
    solo: false,
    volume: role === 'bass' ? -7 : -8
  };
}

// --- Section / clip factories ---

export function makeSection(
  kind: SectionKind,
  measures: number,
  chords: FoundrySettings[],
  measuresPerChord = 1,
  name?: string
): SongSection {
  return {
    id: makeSongId('section'),
    kind,
    name: name ?? SECTION_KIND_META[kind].label,
    measures,
    chords,
    measuresPerChord
  };
}

export function makeClip(trackId: string, startMeasure: number, lengthMeasures: number): SongClip {
  return { id: makeSongId('clip'), trackId, startMeasure, lengthMeasures };
}

export const CORE_STUDIO_ROLES: PerformerRole[] = ['kick', 'snare', 'hihat', 'chords', 'bass', 'melody'];
