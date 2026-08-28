import type { NoteName } from './musicData';
import { buildDrumVariant } from './creatureRecommend';
import { LIBRARY_SONG_TEMPLATES } from './genreLibrary';
import { seedSectionChords } from './songTheory';
import {
  makeClip,
  makeSection,
  makeSongId,
  makeTrackFromRole,
  type SectionKind,
  type SongClip,
  type SongProject,
  type SongSection,
  type SongTrack
} from './songData';
import { CUSTOM_RHYTHM_ID, RHYTHMS, loadCustomRhythm } from './rhythmData';
import { gridGrouping, type GridResolution } from './rhythmTheory';
import type { DrumRole, PerformerRole } from './stageData';

/**
 * Song structure templates for the wizard: ordered section specs with energy
 * tags, suggested progressions, and an arrangement matrix (which parts play
 * in which section) used to seed the timeline clips.
 */

export type StudioPartId = 'drums' | 'chords' | 'bass' | 'lead';

export const STUDIO_PARTS: { id: StudioPartId; label: string }[] = [
  { id: 'drums', label: 'Drum trio' },
  { id: 'chords', label: 'Harmonic organism' },
  { id: 'bass', label: 'Bass creature' },
  { id: 'lead', label: 'Lead creature' }
];

export interface TemplateSectionSpec {
  kind: SectionKind;
  name?: string;
  measures: number;
  /** Target intensity for the section (0 calm .. 1 peak). */
  energy: number;
  /** Progression preset id used to seed the section's chord lane. */
  progressionId: string;
  measuresPerChord: number;
  /** Arrangement matrix row: which parts play in this section. */
  parts: StudioPartId[];
}

/** Part choices a template can pre-fill in the wizard (genre library songs). */
export interface TemplatePartSuggestions {
  /** Core or genre-library drum pattern id. */
  drumVariantId?: string;
  chordsVoiceId?: string;
  bass?: GeneratedTonalPart;
  lead?: GeneratedTonalPart;
}

export interface SongTemplate {
  id: string;
  name: string;
  blurb: string;
  bpm: number;
  rhythmId: string;
  /** Swing amount baked into generated projects (0..1). */
  swing?: number;
  /** Grid step length for generated projects; defaults to eighths. */
  resolution?: GridResolution;
  /** Genre label for library templates; core templates leave it unset. */
  genre?: string;
  suggest?: TemplatePartSuggestions;
  sections: TemplateSectionSpec[];
}

export const SONG_TEMPLATES: SongTemplate[] = [
  {
    id: 'pop-anthem',
    name: 'Pop Anthem',
    blurb: 'Intro · Verse · Chorus · Verse · Chorus · Bridge · Chorus · Outro. The full arc.',
    bpm: 104,
    rhythmId: '4-4',
    sections: [
      { kind: 'intro', measures: 4, energy: 0.25, progressionId: 'axis', measuresPerChord: 1, parts: ['chords'] },
      { kind: 'verse', name: 'Verse 1', measures: 8, energy: 0.45, progressionId: 'axis', measuresPerChord: 2, parts: ['drums', 'chords', 'bass'] },
      { kind: 'chorus', name: 'Chorus 1', measures: 8, energy: 0.85, progressionId: 'axis', measuresPerChord: 1, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'verse', name: 'Verse 2', measures: 8, energy: 0.5, progressionId: 'axis', measuresPerChord: 2, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'chorus', name: 'Chorus 2', measures: 8, energy: 0.9, progressionId: 'axis', measuresPerChord: 1, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'bridge', measures: 4, energy: 0.4, progressionId: 'axis-emotional', measuresPerChord: 1, parts: ['chords', 'bass', 'lead'] },
      { kind: 'chorus', name: 'Final Chorus', measures: 8, energy: 1, progressionId: 'axis', measuresPerChord: 1, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'outro', measures: 4, energy: 0.2, progressionId: 'folk-145', measuresPerChord: 1, parts: ['chords', 'lead'] }
    ]
  },
  {
    id: 'loop-jam',
    name: 'Loop Jam',
    blurb: 'A · B · A · B. Two alternating grooves — the quickest path to a full song.',
    bpm: 96,
    rhythmId: '4-4',
    sections: [
      { kind: 'verse', name: 'Groove A', measures: 8, energy: 0.5, progressionId: 'axis', measuresPerChord: 2, parts: ['drums', 'chords', 'bass'] },
      { kind: 'chorus', name: 'Groove B', measures: 8, energy: 0.75, progressionId: 'doo-wop', measuresPerChord: 2, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'verse', name: 'Groove A2', measures: 8, energy: 0.55, progressionId: 'axis', measuresPerChord: 2, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'chorus', name: 'Groove B2', measures: 8, energy: 0.85, progressionId: 'doo-wop', measuresPerChord: 2, parts: ['drums', 'chords', 'bass', 'lead'] }
    ]
  },
  {
    id: 'aaba',
    name: 'AABA Standard',
    blurb: 'Two statements, a contrasting middle eight, then home. The Tin Pan Alley skeleton.',
    bpm: 92,
    rhythmId: '4-4',
    sections: [
      { kind: 'verse', name: 'A1', measures: 8, energy: 0.45, progressionId: 'doo-wop', measuresPerChord: 2, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'verse', name: 'A2', measures: 8, energy: 0.5, progressionId: 'doo-wop', measuresPerChord: 2, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'bridge', name: 'B (middle eight)', measures: 8, energy: 0.7, progressionId: 'jazz-251', measuresPerChord: 2, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'verse', name: 'A3', measures: 8, energy: 0.55, progressionId: 'doo-wop', measuresPerChord: 2, parts: ['drums', 'chords', 'bass', 'lead'] }
    ]
  },
  {
    id: 'twelve-bar',
    name: '12-Bar Blues',
    blurb: 'Two choruses of the eternal form. Every chord is a dominant beast.',
    bpm: 112,
    rhythmId: '4-4',
    sections: [
      { kind: 'verse', name: 'Chorus 1', measures: 12, energy: 0.55, progressionId: 'blues-12', measuresPerChord: 1, parts: ['drums', 'chords', 'bass'] },
      { kind: 'verse', name: 'Chorus 2', measures: 12, energy: 0.8, progressionId: 'blues-12', measuresPerChord: 1, parts: ['drums', 'chords', 'bass', 'lead'] }
    ]
  },
  {
    id: 'cinematic',
    name: 'Minor Cinematic',
    blurb: 'A wide-lens minor build: slow open, swelling middle, Andalusian fall.',
    bpm: 84,
    rhythmId: '6-8',
    sections: [
      { kind: 'intro', measures: 4, energy: 0.15, progressionId: 'minor-cinematic', measuresPerChord: 2, parts: ['chords'] },
      { kind: 'verse', name: 'Scene 1', measures: 8, energy: 0.4, progressionId: 'minor-cinematic', measuresPerChord: 2, parts: ['chords', 'bass', 'lead'] },
      { kind: 'chorus', name: 'Swell', measures: 8, energy: 0.8, progressionId: 'minor-cinematic', measuresPerChord: 1, parts: ['drums', 'chords', 'bass', 'lead'] },
      { kind: 'outro', name: 'Descent', measures: 8, energy: 0.35, progressionId: 'andalusian', measuresPerChord: 2, parts: ['chords', 'bass'] }
    ]
  }
];

/** Core structural templates plus every song in the genre library. */
export const ALL_SONG_TEMPLATES: SongTemplate[] = [...SONG_TEMPLATES, ...LIBRARY_SONG_TEMPLATES];

export function findTemplate(id: string): SongTemplate {
  return ALL_SONG_TEMPLATES.find(t => t.id === id) ?? SONG_TEMPLATES[0];
}

/** Average energy across a template — the wizard's default recommendation target. */
export function templateEnergy(template: SongTemplate): number {
  if (!template.sections.length) return 0.5;
  return template.sections.reduce((a, s) => a + s.energy, 0) / template.sections.length;
}

// --- Project generation ---

export interface GeneratedTonalPart {
  name: string;
  voiceId: string;
  contourId: string;
  octaveShift: number;
}

export interface GeneratedParts {
  /** Drum pattern variant id (see DRUM_VARIANTS); 'classic' = house groove. */
  drumVariantId: string;
  chordsVoiceId: string;
  bass: GeneratedTonalPart;
  lead: GeneratedTonalPart;
}

export interface GenerateOptions {
  name: string;
  keyRoot: NoteName;
  bpm: number;
  rhythmId: string;
  parts: GeneratedParts;
}

function groupingFor(rhythmId: string): number[] {
  const preset = RHYTHMS.find(r => r.id === rhythmId);
  if (preset) return preset.grouping;
  if (rhythmId === CUSTOM_RHYTHM_ID) {
    const custom = loadCustomRhythm();
    if (custom) return custom.grouping;
  }
  return RHYTHMS[0].grouping;
}

function rolesForPart(part: StudioPartId): PerformerRole[] {
  switch (part) {
    case 'drums':
      return ['kick', 'snare', 'hihat'];
    case 'chords':
      return ['chords'];
    case 'bass':
      return ['bass'];
    case 'lead':
      return ['melody'];
  }
}

/** Merges contiguous covered measure ranges into single clips per track. */
function clipsFromCoverage(trackId: string, coverage: boolean[]): SongClip[] {
  const clips: SongClip[] = [];
  let start = -1;
  for (let m = 0; m <= coverage.length; m++) {
    const on = m < coverage.length && coverage[m];
    if (on && start < 0) start = m;
    if (!on && start >= 0) {
      clips.push(makeClip(trackId, start, m - start));
      start = -1;
    }
  }
  return clips;
}

export function buildProjectFromTemplate(template: SongTemplate, options: GenerateOptions): SongProject {
  const resolution = template.resolution ?? 'eighth';
  const grouping = gridGrouping(groupingFor(options.rhythmId), resolution);

  const sections: SongSection[] = template.sections.map(spec =>
    makeSection(
      spec.kind,
      spec.measures,
      seedSectionChords(spec.progressionId, options.keyRoot),
      spec.measuresPerChord,
      spec.name
    )
  );

  const tracks: SongTrack[] = [];
  (['kick', 'snare', 'hihat'] as DrumRole[]).forEach(role => {
    const track = makeTrackFromRole(role, grouping);
    track.performer.drumSteps = buildDrumVariant(role, grouping, options.parts.drumVariantId);
    tracks.push(track);
  });

  const chordsTrack = makeTrackFromRole('chords', grouping);
  chordsTrack.performer.voiceId = options.parts.chordsVoiceId;
  tracks.push(chordsTrack);

  const bassTrack = makeTrackFromRole('bass', grouping);
  bassTrack.name = options.parts.bass.name;
  bassTrack.performer.displayName = options.parts.bass.name;
  bassTrack.performer.voiceId = options.parts.bass.voiceId;
  bassTrack.performer.contourId = options.parts.bass.contourId;
  bassTrack.performer.octaveShift = options.parts.bass.octaveShift;
  tracks.push(bassTrack);

  const leadTrack = makeTrackFromRole('melody', grouping);
  leadTrack.name = options.parts.lead.name;
  leadTrack.performer.displayName = options.parts.lead.name;
  leadTrack.performer.voiceId = options.parts.lead.voiceId;
  leadTrack.performer.contourId = options.parts.lead.contourId;
  leadTrack.performer.octaveShift = options.parts.lead.octaveShift;
  tracks.push(leadTrack);

  // Arrangement matrix → coverage per role → merged clips.
  const totalMeasures = template.sections.reduce((a, s) => a + s.measures, 0);
  const coverageByRole = new Map<PerformerRole, boolean[]>();
  tracks.forEach(t => coverageByRole.set(t.role, Array<boolean>(totalMeasures).fill(false)));

  let cursor = 0;
  template.sections.forEach(spec => {
    spec.parts.forEach(part => {
      rolesForPart(part).forEach(role => {
        const coverage = coverageByRole.get(role);
        if (!coverage) return;
        for (let m = cursor; m < cursor + spec.measures; m++) coverage[m] = true;
      });
    });
    cursor += spec.measures;
  });

  const clips: SongClip[] = [];
  tracks.forEach(track => {
    const coverage = coverageByRole.get(track.role);
    if (coverage) clips.push(...clipsFromCoverage(track.id, coverage));
  });

  return {
    id: makeSongId('song'),
    name: options.name,
    bpm: options.bpm,
    swing: template.swing ?? 0,
    keyRoot: options.keyRoot,
    rhythmId: options.rhythmId,
    resolution,
    sections,
    tracks,
    clips,
    masterVolume: -2,
    reverbWet: 0.28
  };
}

/** A simple 8-measure starter song with the full core cast playing throughout. */
export function makeBlankProject(name: string, keyRoot: NoteName): SongProject {
  const rhythmId = '4-4';
  const grouping = groupingFor(rhythmId);
  const section = makeSection('verse', 8, seedSectionChords('axis', keyRoot), 2, 'Verse');
  const tracks = (['kick', 'snare', 'hihat', 'chords', 'bass', 'melody'] as PerformerRole[]).map(role =>
    makeTrackFromRole(role, grouping)
  );
  const clips = tracks.map(t => makeClip(t.id, 0, section.measures));

  return {
    id: makeSongId('song'),
    name,
    bpm: 100,
    swing: 0,
    keyRoot,
    rhythmId,
    resolution: 'eighth',
    sections: [section],
    tracks,
    clips,
    masterVolume: -2,
    reverbWet: 0.28
  };
}
