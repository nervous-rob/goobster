import { Link } from '@tanstack/react-router';
import { conservatoryPath } from '@music-lab/lib/paths';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NOTE_NAMES, type NoteName } from '@music-lab/lib/musicData';
import { PROGRESSION_PRESETS, VOICINGS, type RegisterId, type VoicingId } from '@music-lab/lib/harmonyData';
import { buildHarmonyGenome, nameChord, type FoundrySettings } from '@music-lab/lib/harmonyTheory';
import { RHYTHMS } from '@music-lab/lib/rhythmData';
import { useRhythmOptions } from '@music-lab/hooks/useRhythmOptions';
import { GRID_STEP_LABEL, gridGrouping, totalSubdivisions } from '@music-lab/lib/rhythmTheory';
import { hasStudioHandoff, takeStudioHandoff } from '@music-lab/lib/handoff';
import { findLibraryDrumPattern, stretchDrumSteps, type LibraryGroove } from '@music-lab/lib/genreLibrary';
import { downloadBlob, recordingToWavBlob } from '@music-lab/lib/audioExport';
import {
  copyName,
  copySectionPayload,
  createHistory,
  duplicateClip,
  duplicateSection,
  duplicateTrack,
  elapsedSeconds,
  moveTrack,
  parseSongProjectFile,
  pasteClip,
  pasteSection,
  recordHistory,
  redoHistory,
  reorderSections,
  serializeSongProject,
  songDurationSeconds,
  songFileName,
  splitClipAt,
  undoHistory,
  type EditHistory,
  type SectionPayload
} from '@music-lab/lib/songEdit';
import {
  CREATURE_LIBRARY_KEY,
  MELODY_BASE_OCTAVE,
  findContour,
  isDrumRole,
  seedDrumPattern,
  strongSubIndices,
  type PerformerRole,
  type SavedCreature
} from '@music-lab/lib/stageData';
import { useContourLibrary } from '@music-lab/hooks/useContourLibrary';
import { findVoice, type VoicePreset } from '@music-lab/lib/voiceData';
import { useVoiceLibrary } from '@music-lab/hooks/useVoiceLibrary';
import {
  CORE_STUDIO_ROLES,
  MAX_SECTION_CHORDS,
  MAX_SECTION_MEASURES,
  MIN_SECTION_CHORDS,
  MIN_SECTION_MEASURES,
  SECTION_KINDS,
  SECTION_KIND_META,
  STUDIO_CURRENT_KEY,
  STUDIO_PROJECTS_KEY,
  VOICE_TRACK_ROLES,
  makeClip,
  makeSongId,
  makeTrackFromCreature,
  makeTrackFromRole,
  makeTrackFromVoice,
  type FillFrequency,
  type SongClip,
  type SongProject,
  type SongSection,
  type SongTrack,
  type SectionKind,
  type VoiceTrackRole
} from '@music-lab/lib/songData';
import {
  buildChordEvents,
  buildClipCoverage,
  buildSongMelodyLane,
  buildWrittenMelodyLane,
  flattenSong,
  sectionAtMeasure,
  seedSectionChords
} from '@music-lab/lib/songTheory';
import { makeBlankProject } from '@music-lab/lib/songTemplates';
import { useLocalStorage } from '@music-lab/hooks/useLocalStorage';
import { useSongOrchestrator, type SongRuntimeTrack } from '@music-lab/hooks/useSongOrchestrator';
import { ChordSlotEditor } from '@music-lab/components/stage/ChordSlotEditor';
import { BPM_MAX, BPM_MIN, StudioTransport } from './StudioTransport';
import { SongTimeline, type StudioMenuTarget } from './SongTimeline';
import type { MenuPoint } from './SectionStrip';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { SongWizard } from './SongWizard';
import { MelodyEditor } from './MelodyEditor';

function IconStudio() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="2" y="5" width="20" height="4" rx="1" />
      <rect x="2" y="11" width="12" height="4" rx="1" />
      <rect x="2" y="17" width="16" height="4" rx="1" />
    </svg>
  );
}

interface ChordEditTarget {
  sectionId: string;
  chordIndex: number;
}

/** In-memory clipboard: survives switching songs, not a reload. */
type StudioClipboard = { kind: 'clip'; clip: SongClip; trackName: string } | { kind: 'section'; payload: SectionPayload };

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const ROLE_LABEL: Record<PerformerRole, string> = {
  kick: 'kick',
  snare: 'snare',
  hihat: 'hihat',
  chords: 'chords',
  bass: 'bass',
  melody: 'lead'
};

function formatPan(pan: number): string {
  const pct = Math.round(Math.abs(pan) * 100);
  if (pct === 0) return 'C';
  return pan < 0 ? `L${pct}` : `R${pct}`;
}

function voiceEngineLabel(voice: VoicePreset): string {
  return voice.engine === 'sample' ? 'Sample' : voice.engine === 'fm' ? 'FM synth' : 'Analog synth';
}

const HARMONY_HOLD = 0.96;
const MIN_ZOOM = 12;
const MAX_ZOOM = 96;
const ZOOM_STEP = 4;
const HISTORY_LIMIT = 100;
const NOTICE_MS = 7000;
const DELETE_CONFIRM_MS = 4000;

export function StudioEngine() {
  const [projects, setProjects] = useLocalStorage<SongProject[]>(STUDIO_PROJECTS_KEY, []);
  const [currentId, setCurrentId] = useLocalStorage<string | null>(STUDIO_CURRENT_KEY, null);
  const [library, setLibrary] = useLocalStorage<SavedCreature[]>(CREATURE_LIBRARY_KEY, []);
  const [zoom, setZoom] = useLocalStorage<number>('studioZoom', 40);
  const [loop, setLoop] = useLocalStorage<boolean>('studioLoop', true);
  const [followPlayhead, setFollowPlayhead] = useLocalStorage<boolean>('studioFollow', true);
  const [metronome, setMetronome] = useLocalStorage<boolean>('studioClick', false);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);

  const { allVoices, customVoices } = useVoiceLibrary();
  const { allContours } = useContourLibrary();
  const [loopMode, setLoopMode] = useState<'song' | 'section'>('song');
  const [playhead, setPlayhead] = useState<{ measure: number; sub: number } | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [chordEdit, setChordEdit] = useState<ChordEditTarget | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [addTrackOpen, setAddTrackOpen] = useState(false);
  const [melodyEditorTrackId, setMelodyEditorTrackId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [clipboard, setClipboard] = useState<StudioClipboard | null>(null);
  const [menu, setMenu] = useState<{ target: StudioMenuTarget; at: MenuPoint } | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // One transient status line for handoffs, imports, undo, and errors.
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const showNotice = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    setNotice({ text, tone });
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const {
    audioReady,
    isPlaying,
    isRecording,
    setConfig,
    setCallbacks,
    stop,
    toggle,
    seek,
    start,
    startRecording,
    stopRecording
  } = useSongOrchestrator();
  const recordingRef = useRef(false);
  recordingRef.current = isRecording;

  const project = useMemo(
    () => projects.find(p => p.id === currentId) ?? projects[0] ?? null,
    [projects, currentId]
  );

  // --- Edits and undo history ---
  // `latestProjectRef` is the project as of the most recent edit in this
  // tick, so two updateProject calls in one handler chain instead of the
  // second clobbering the first. Histories are per song and per session.
  const latestProjectRef = useRef<SongProject | null>(null);
  latestProjectRef.current = project;
  const historiesRef = useRef<Map<string, EditHistory<SongProject>>>(new Map());
  const [, setHistoryTick] = useState(0);

  const historyFor = useCallback((id: string): EditHistory<SongProject> => {
    let history = historiesRef.current.get(id);
    if (!history) {
      history = createHistory<SongProject>(HISTORY_LIMIT);
      historiesRef.current.set(id, history);
    }
    return history;
  }, []);

  const replaceProject = useCallback(
    (next: SongProject) => {
      latestProjectRef.current = next;
      setProjects(prev => prev.map(p => (p.id === next.id ? next : p)));
    },
    [setProjects]
  );

  const updateProject = useCallback(
    (updater: (p: SongProject) => SongProject) => {
      const current = latestProjectRef.current;
      if (!current) return;
      const next = updater(current);
      if (next === current) return;
      historiesRef.current.set(current.id, recordHistory(historyFor(current.id), current, Date.now()));
      setHistoryTick(t => t + 1);
      replaceProject(next);
    },
    [historyFor, replaceProject]
  );

  const undo = useCallback(() => {
    const current = latestProjectRef.current;
    if (!current) return;
    const result = undoHistory(historyFor(current.id), current);
    if (!result) return;
    historiesRef.current.set(current.id, result.history);
    setHistoryTick(t => t + 1);
    setChordEdit(null);
    replaceProject(result.snapshot);
  }, [historyFor, replaceProject]);

  const redo = useCallback(() => {
    const current = latestProjectRef.current;
    if (!current) return;
    const result = redoHistory(historyFor(current.id), current);
    if (!result) return;
    historiesRef.current.set(current.id, result.history);
    setHistoryTick(t => t + 1);
    setChordEdit(null);
    replaceProject(result.snapshot);
  }, [historyFor, replaceProject]);

  const canUndo = project ? (historiesRef.current.get(project.id)?.past.length ?? 0) > 0 : false;
  const canRedo = project ? (historiesRef.current.get(project.id)?.future.length ?? 0) > 0 : false;

  const { rhythms, findRhythm } = useRhythmOptions();
  const rhythm = useMemo(() => findRhythm(project?.rhythmId ?? '4-4'), [findRhythm, project?.rhythmId]);
  const resolution = project?.resolution ?? 'eighth';
  /** Grouping scaled to the grid resolution — the source of truth for all step math. */
  const grid = useMemo(() => gridGrouping(rhythm.grouping, resolution), [rhythm.grouping, resolution]);
  const subdivisions = useMemo(() => totalSubdivisions(grid), [grid]);
  const strongSubs = useMemo(() => strongSubIndices(grid), [grid]);

  const flat = useMemo(() => flattenSong(project?.sections ?? []), [project?.sections]);

  const selectedSection = useMemo(
    () => project?.sections.find(s => s.id === selectedSectionId) ?? null,
    [project?.sections, selectedSectionId]
  );
  const selectedTrack = useMemo(
    () => project?.tracks.find(t => t.id === selectedTrackId) ?? null,
    [project?.tracks, selectedTrackId]
  );

  const loopRegion = useMemo(() => {
    if (!flat.totalMeasures) return null;
    if (loopMode === 'section' && selectedSection) {
      const span = flat.sectionSpans.find(s => s.section.id === selectedSection.id);
      if (span) return { start: span.startMeasure, end: span.endMeasure };
    }
    return { start: 0, end: flat.totalMeasures };
  }, [flat, loopMode, selectedSection]);

  // --- Runtime tracks for the orchestrator ---
  const runtimeTracks = useMemo<SongRuntimeTrack[]>(() => {
    if (!project) return [];
    const anySolo = project.tracks.some(t => t.solo);

    return project.tracks.map(track => {
      const p = track.performer;
      const coverage = buildClipCoverage(project.clips, track.id, flat.totalMeasures);
      const mute = track.mute || (anySolo && !track.solo);
      const base = {
        id: track.id,
        role: track.role,
        mute,
        volume: track.volume,
        pan: track.pan ?? 0,
        voiceId: p.voiceId,
        audible: coverage
      };

      if (isDrumRole(track.role)) {
        const steps =
          p.drumSteps?.length === subdivisions ? p.drumSteps : seedDrumPattern(track.role, grid);
        return { ...base, drumSteps: steps };
      }
      if (track.role === 'chords') {
        const reVoice =
          p.voicingOverride || p.registerOverride
            ? (settings: FoundrySettings) =>
                buildHarmonyGenome({
                  ...settings,
                  voicing: p.voicingOverride ?? settings.voicing,
                  register: p.registerOverride ?? settings.register
                })
            : undefined;
        return { ...base, chordEvents: buildChordEvents(flat, coverage, reVoice) };
      }
      if (track.role === 'melody' && p.melodyMode === 'written') {
        const lane = buildWrittenMelodyLane(
          p.writtenNotes ?? [],
          flat.totalMeasures,
          subdivisions,
          project.keyRoot,
          MELODY_BASE_OCTAVE.melody + (p.octaveShift ?? 0)
        );
        return { ...base, melodyNotes: lane };
      }
      const lane = buildSongMelodyLane(
        findContour(p.contourId).steps,
        flat,
        subdivisions,
        MELODY_BASE_OCTAVE[track.role === 'bass' ? 'bass' : 'melody'] + (p.octaveShift ?? 0)
      );
      return { ...base, melodyNotes: lane };
    });
  }, [project, flat, subdivisions, grid]);

  // --- Automatic drum fills ---
  const fillMeasures = useMemo(() => {
    const fills = project?.fills;
    if (!fills || fills.frequency === 'off' || !flat.totalMeasures) return undefined;
    const measures = Array<boolean>(flat.totalMeasures).fill(false);
    if (fills.frequency === 'section') {
      flat.sectionSpans.forEach(span => {
        measures[span.endMeasure - 1] = true;
      });
    } else {
      const every = fills.frequency === 'every4' ? 4 : 8;
      for (let m = every - 1; m < flat.totalMeasures; m += every) measures[m] = true;
    }
    return measures;
  }, [project?.fills, flat]);

  const fillLengthSubs = useMemo(() => {
    const fills = project?.fills;
    if (!fills || fills.frequency === 'off') return 0;
    const fraction = fills.length === 'long' ? 0.5 : 0.25;
    return Math.max(2, Math.round(subdivisions * fraction));
  }, [project?.fills, subdivisions]);

  useEffect(() => {
    if (!project) return;
    setConfig({
      bpm: project.bpm,
      swing: project.swing,
      grouping: grid,
      resolution,
      totalMeasures: flat.totalMeasures,
      harmonyHold: HARMONY_HOLD,
      fillMeasures,
      fillLengthSubs,
      loop,
      loopStartMeasure: loopRegion?.start ?? 0,
      loopEndMeasure: loopRegion?.end ?? flat.totalMeasures,
      masterVolume: project.masterVolume,
      reverbWet: project.reverbWet,
      metronome,
      tracks: runtimeTracks
    });
  }, [project, grid, resolution, flat.totalMeasures, fillMeasures, fillLengthSubs, loop, loopRegion, metronome, runtimeTracks, setConfig]);

  // --- Recording: capture the master bus while the song plays, then download ---

  const finalizeRecording = useCallback(async () => {
    const blob = await stopRecording();
    if (!blob || !blob.size) return;
    const base = (project?.name ?? 'song').replace(/[\\/:*?"<>|]+/g, '').trim() || 'song';
    const wav = await recordingToWavBlob(blob);
    if (wav) downloadBlob(wav, `${base}.wav`);
    else downloadBlob(blob, `${base}.webm`);
  }, [project?.name, stopRecording]);

  const handleRecord = useCallback(async () => {
    if (!project) return;
    if (recordingRef.current) {
      stop();
      await finalizeRecording();
      return;
    }
    stop();
    const armed = await startRecording();
    if (!armed) return;
    await start();
  }, [finalizeRecording, project, start, startRecording, stop]);

  useEffect(() => {
    setCallbacks({
      onStep: (measure, sub) => setPlayhead({ measure, sub }),
      onPlayState: playing => {
        if (!playing) {
          setPlayhead(null);
          // Loop-off songs that run to the end finish the take automatically.
          if (recordingRef.current) void finalizeRecording();
        }
      }
    });
  }, [setCallbacks, finalizeRecording]);

  // --- Project management ---
  const adoptProject = useCallback(
    (next: SongProject) => {
      stop();
      setProjects(prev => [...prev, next]);
      setCurrentId(next.id);
      setSelectedSectionId(null);
      setSelectedTrackId(null);
      setSelectedClipId(null);
      setChordEdit(null);
    },
    [setCurrentId, setProjects, stop]
  );

  const handleBlankSong = useCallback(() => {
    adoptProject(makeBlankProject(`Song ${projects.length + 1}`, 'C'));
  }, [adoptProject, projects.length]);

  const handleWizardGenerate = useCallback(
    (generated: SongProject) => {
      setWizardOpen(false);
      adoptProject(generated);
    },
    [adoptProject]
  );

  const handleDuplicate = useCallback(() => {
    if (!project) return;
    adoptProject({ ...project, id: makeSongId('song'), name: copyName(project.name, projects.map(p => p.name)) });
  }, [adoptProject, project, projects]);

  // Delete is two taps: the first arms the button for a few seconds.
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmDelete(false), DELETE_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const handleDelete = useCallback(() => {
    if (!project) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    stop();
    historiesRef.current.delete(project.id);
    setProjects(prev => prev.filter(p => p.id !== project.id));
    setCurrentId(null);
    setSelectedSectionId(null);
    setSelectedTrackId(null);
    setSelectedClipId(null);
    setChordEdit(null);
    showNotice(`Deleted “${project.name}”.`);
  }, [confirmDelete, project, setCurrentId, setProjects, showNotice, stop]);

  const handleExport = useCallback(() => {
    if (!project) return;
    const blob = new Blob([serializeSongProject(project)], { type: 'application/json' });
    downloadBlob(blob, songFileName(project.name, 'json'));
  }, [project]);

  const handleImportFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      let text = '';
      try {
        text = await file.text();
      } catch {
        showNotice('Could not read that file.', 'error');
        return;
      }
      const parsed = parseSongProjectFile(text, makeSongId);
      if (!parsed.ok) {
        showNotice(parsed.error, 'error');
        return;
      }
      adoptProject(parsed.project);
      showNotice(`Imported “${parsed.project.name}” as a new song.`);
    },
    [adoptProject, showNotice]
  );

  const handleSwitchProject = useCallback(
    (id: string) => {
      stop();
      setCurrentId(id);
      setSelectedSectionId(null);
      setSelectedTrackId(null);
      setSelectedClipId(null);
      setChordEdit(null);
      setPlayhead(null);
      setConfirmDelete(false);
    },
    [setCurrentId, stop]
  );

  // --- Clip ops ---
  const removeClip = useCallback(
    (clipId: string) => {
      updateProject(p => ({ ...p, clips: p.clips.filter(c => c.id !== clipId) }));
      setSelectedClipId(prev => (prev === clipId ? null : prev));
    },
    [updateProject]
  );

  const selectedClip = useMemo(
    () => project?.clips.find(c => c.id === selectedClipId) ?? null,
    [project?.clips, selectedClipId]
  );

  /** The bar the playhead sits on, when it is strictly inside the selected clip. */
  const splitMeasure = useMemo(() => {
    if (!selectedClip || !playhead) return null;
    const m = playhead.measure;
    if (m <= selectedClip.startMeasure || m >= selectedClip.startMeasure + selectedClip.lengthMeasures) return null;
    return m;
  }, [playhead, selectedClip]);

  const splitSelectedClip = useCallback(() => {
    if (!selectedClip || splitMeasure === null) return;
    updateProject(p => ({ ...p, clips: splitClipAt(p.clips, selectedClip.id, splitMeasure, makeSongId) }));
  }, [selectedClip, splitMeasure, updateProject]);

  // --- Section ops ---
  const clampClips = useCallback((clips: SongClip[], sections: SongSection[]): SongClip[] => {
    const total = sections.reduce((a, s) => a + s.measures, 0);
    return clips
      .filter(c => c.startMeasure < total)
      .map(c =>
        c.startMeasure + c.lengthMeasures > total ? { ...c, lengthMeasures: total - c.startMeasure } : c
      );
  }, []);

  const updateSection = useCallback(
    (id: string, partial: Partial<SongSection>) => {
      updateProject(p => {
        const sections = p.sections.map(s => (s.id === id ? { ...s, ...partial } : s));
        return { ...p, sections, clips: clampClips(p.clips, sections) };
      });
    },
    [clampClips, updateProject]
  );

  /** Sections carry their clips when they move (see reorderSections). */
  const reorderSection = useCallback(
    (id: string, toIndex: number) => {
      updateProject(p => reorderSections(p, id, toIndex, makeSongId));
    },
    [updateProject]
  );

  const moveSection = useCallback(
    (id: string, dir: -1 | 1) => {
      const index = project?.sections.findIndex(s => s.id === id) ?? -1;
      if (index < 0) return;
      reorderSection(id, index + dir);
    },
    [project?.sections, reorderSection]
  );

  const handleDuplicateSection = useCallback(
    (id: string) => {
      let copyId: string | null = null;
      updateProject(p => {
        const next = duplicateSection(p, id, makeSongId);
        if (next === p) return p;
        const index = p.sections.findIndex(s => s.id === id);
        copyId = next.sections[index + 1]?.id ?? null;
        return next;
      });
      if (copyId) {
        setSelectedSectionId(copyId);
        setChordEdit(null);
      }
    },
    [updateProject]
  );

  // --- Handoff inbox: payloads queued by the Rhythm / Harmony engines ---
  const handoffAppliedRef = useRef(false);

  useEffect(() => {
    if (handoffAppliedRef.current) return;
    if (!project) {
      // Nothing to land on yet: open a blank canvas so the payload is not
      // stranded in storage until the person happens to make a song.
      if (hasStudioHandoff()) adoptProject(makeBlankProject('Song 1', 'C'));
      return;
    }
    handoffAppliedRef.current = true;
    const handoff = takeStudioHandoff();
    if (!handoff) return;

    if (handoff.type === 'groove') {
      updateProject(p => ({
        ...p,
        bpm: Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(handoff.bpm))),
        swing: Math.max(0, Math.min(0.5, handoff.swing)),
        rhythmId: handoff.rhythmId,
        grooveId: undefined
      }));
      showNotice(`Groove from the Rhythm Engine applied: ${handoff.label} at ${Math.round(handoff.bpm)} BPM.`);
    } else {
      const fresh: SongSection = {
        id: makeSongId('section'),
        kind: 'verse',
        name: handoff.name,
        measures: Math.min(MAX_SECTION_MEASURES, Math.max(4, handoff.chords.length)),
        chords: handoff.chords.map(c => ({ ...c })),
        measuresPerChord: 1
      };
      updateProject(p => ({ ...p, sections: [...p.sections, fresh] }));
      setSelectedSectionId(fresh.id);
      showNotice(`“${handoff.name}” from the Harmony Engine landed as a new section at the end of the song.`);
    }
  }, [adoptProject, project, showNotice, updateProject]);

  const addSectionAfter = useCallback(
    (id: string | null) => {
      if (!project) return;
      const reference = project.sections.find(s => s.id === id) ?? project.sections[project.sections.length - 1];
      const fresh: SongSection = {
        id: makeSongId('section'),
        kind: reference?.kind ?? 'verse',
        name: reference ? `${reference.name} +` : 'Verse',
        measures: reference?.measures ?? 8,
        chords: reference ? reference.chords.map(c => ({ ...c })) : seedSectionChords('axis', project.keyRoot),
        measuresPerChord: reference?.measuresPerChord ?? 1
      };
      updateProject(p => {
        const index = id ? p.sections.findIndex(s => s.id === id) : p.sections.length - 1;
        const sections = [...p.sections];
        sections.splice(index + 1, 0, fresh);
        return { ...p, sections };
      });
      setSelectedSectionId(fresh.id);
    },
    [project, updateProject]
  );

  const removeSection = useCallback(
    (id: string) => {
      updateProject(p => {
        if (p.sections.length <= 1) return p;
        const sections = p.sections.filter(s => s.id !== id);
        return { ...p, sections, clips: clampClips(p.clips, sections) };
      });
      setSelectedSectionId(null);
      setChordEdit(null);
    },
    [clampClips, updateProject]
  );

  // --- Clipboard: clips and sections, Ctrl+C / X / V / D and the context menus ---
  const copyClipToClipboard = useCallback(
    (clipId: string) => {
      const clip = project?.clips.find(c => c.id === clipId);
      if (!clip) return;
      const trackName = project?.tracks.find(t => t.id === clip.trackId)?.name ?? 'clip';
      setClipboard({ kind: 'clip', clip: { ...clip }, trackName });
    },
    [project?.clips, project?.tracks]
  );

  const cutClip = useCallback(
    (clipId: string) => {
      copyClipToClipboard(clipId);
      removeClip(clipId);
    },
    [copyClipToClipboard, removeClip]
  );

  const pasteClipAt = useCallback(
    (trackId: string, startMeasure: number) => {
      if (clipboard?.kind !== 'clip') return;
      let pastedId: string | null = null;
      updateProject(p => {
        const total = p.sections.reduce((a, s) => a + s.measures, 0);
        const clips = pasteClip(p.clips, clipboard.clip, { trackId, startMeasure, totalMeasures: total }, makeSongId);
        if (clips === p.clips) return p;
        pastedId = clips[clips.length - 1].id;
        return { ...p, clips };
      });
      if (pastedId) {
        setSelectedClipId(pastedId);
        setSelectedTrackId(trackId);
      }
    },
    [clipboard, updateProject]
  );

  const duplicateSelectedClip = useCallback(
    (clipId: string) => {
      let copyId: string | null = null;
      updateProject(p => {
        const total = p.sections.reduce((a, s) => a + s.measures, 0);
        const clips = duplicateClip(p.clips, clipId, total, makeSongId);
        if (clips === p.clips) return p;
        copyId = clips[clips.length - 1].id;
        return { ...p, clips };
      });
      if (copyId) setSelectedClipId(copyId);
      else showNotice('No room after that clip — the song ends there.');
    },
    [showNotice, updateProject]
  );

  const copySectionToClipboard = useCallback(
    (sectionId: string) => {
      if (!project) return;
      const payload = copySectionPayload(project, sectionId);
      if (payload) setClipboard({ kind: 'section', payload });
    },
    [project]
  );

  const pasteSectionAfter = useCallback(
    (afterId: string | null) => {
      if (clipboard?.kind !== 'section') return;
      let copyId: string | null = null;
      updateProject(p => {
        const afterIndex = afterId ? p.sections.findIndex(s => s.id === afterId) : p.sections.length - 1;
        const next = pasteSection(p, clipboard.payload, afterIndex, makeSongId);
        if (next === p) return p;
        copyId = next.sections[afterIndex + 1]?.id ?? null;
        return next;
      });
      if (copyId) {
        setSelectedSectionId(copyId);
        setChordEdit(null);
      }
    },
    [clipboard, updateProject]
  );

  /** Ctrl+C: the selected clip wins over the selected section. */
  const copySelection = useCallback(() => {
    if (selectedClipId) copyClipToClipboard(selectedClipId);
    else if (selectedSectionId) copySectionToClipboard(selectedSectionId);
  }, [copyClipToClipboard, copySectionToClipboard, selectedClipId, selectedSectionId]);

  const cutSelection = useCallback(() => {
    if (selectedClipId) {
      cutClip(selectedClipId);
    } else if (selectedSectionId && project && project.sections.length > 1) {
      copySectionToClipboard(selectedSectionId);
      removeSection(selectedSectionId);
    }
  }, [copySectionToClipboard, cutClip, project, removeSection, selectedClipId, selectedSectionId]);

  /** Ctrl+V: clips land at the playhead on the selected (else source) track; sections after the selected one. */
  const pasteSelection = useCallback(() => {
    if (!clipboard || !project) return;
    if (clipboard.kind === 'clip') {
      const trackId =
        selectedTrackId ?? (project.tracks.some(t => t.id === clipboard.clip.trackId) ? clipboard.clip.trackId : null);
      if (!trackId) {
        showNotice('Select a track to paste the clip onto.');
        return;
      }
      pasteClipAt(trackId, playhead?.measure ?? 0);
    } else {
      pasteSectionAfter(selectedSectionId);
    }
  }, [clipboard, pasteClipAt, pasteSectionAfter, playhead?.measure, project, selectedSectionId, selectedTrackId, showNotice]);

  const duplicateSelection = useCallback(() => {
    if (selectedClipId) duplicateSelectedClip(selectedClipId);
    else if (selectedSectionId) handleDuplicateSection(selectedSectionId);
  }, [duplicateSelectedClip, handleDuplicateSection, selectedClipId, selectedSectionId]);

  const updateSectionChord = useCallback(
    (sectionId: string, index: number, settings: FoundrySettings) => {
      updateProject(p => ({
        ...p,
        sections: p.sections.map(s =>
          s.id === sectionId ? { ...s, chords: s.chords.map((c, i) => (i === index ? settings : c)) } : s
        )
      }));
    },
    [updateProject]
  );

  // --- Track ops ---
  const updateTrack = useCallback(
    (id: string, partial: Partial<SongTrack>) => {
      updateProject(p => ({ ...p, tracks: p.tracks.map(t => (t.id === id ? { ...t, ...partial } : t)) }));
    },
    [updateProject]
  );

  const updateTrackPerformer = useCallback(
    (id: string, partial: Partial<SongTrack['performer']>) => {
      updateProject(p => ({
        ...p,
        tracks: p.tracks.map(t => (t.id === id ? { ...t, performer: { ...t.performer, ...partial } } : t))
      }));
    },
    [updateProject]
  );

  const removeTrack = useCallback(
    (id: string) => {
      updateProject(p => ({
        ...p,
        tracks: p.tracks.filter(t => t.id !== id),
        clips: p.clips.filter(c => c.trackId !== id)
      }));
      setSelectedTrackId(prev => (prev === id ? null : prev));
      setSelectedClipId(null);
      setMelodyEditorTrackId(prev => (prev === id ? null : prev));
    },
    [updateProject]
  );

  const handleMoveTrack = useCallback(
    (id: string, direction: -1 | 1) => {
      updateProject(p => {
        const tracks = moveTrack(p.tracks, id, direction);
        return tracks === p.tracks ? p : { ...p, tracks };
      });
    },
    [updateProject]
  );

  const handleDuplicateTrack = useCallback(
    (id: string) => {
      let cloneId: string | null = null;
      updateProject(p => {
        const next = duplicateTrack(p, id, makeSongId);
        const index = p.tracks.findIndex(t => t.id === id);
        cloneId = next.tracks[index + 1]?.id ?? null;
        return next;
      });
      if (cloneId) setSelectedTrackId(cloneId);
    },
    [updateProject]
  );

  const addTrack = useCallback(
    (
      role:
        | PerformerRole
        | { creature: SavedCreature }
        | { voice: VoicePreset; role: VoiceTrackRole }
        | { writtenLead: true }
    ) => {
      if (!project) return;
      let track: SongTrack;
      if (typeof role === 'string') {
        track = makeTrackFromRole(role, grid);
      } else if ('creature' in role) {
        track = makeTrackFromCreature(role.creature);
      } else if ('voice' in role) {
        track = makeTrackFromVoice(role.voice, role.role, grid);
      } else {
        track = makeTrackFromRole('melody', grid);
        track.name = 'Lead Sheet';
        track.performer.displayName = 'Lead Sheet';
        track.performer.melodyMode = 'written';
        track.performer.writtenNotes = [];
      }
      const clip = flat.totalMeasures ? [makeClip(track.id, 0, flat.totalMeasures)] : [];
      updateProject(p => ({ ...p, tracks: [...p.tracks, track], clips: [...p.clips, ...clip] }));
      setSelectedTrackId(track.id);
      setAddTrackOpen(false);
      if (typeof role !== 'string' && 'writtenLead' in role) setMelodyEditorTrackId(track.id);
    },
    [flat.totalMeasures, project, grid, updateProject]
  );

  // --- Grooves: one tap sets feel + reseeds the drum tracks ---
  const applyGroove = useCallback(
    (groove: LibraryGroove) => {
      const nextRhythm = RHYTHMS.find(r => r.id === groove.rhythmId) ?? RHYTHMS[0];
      const nextGrid = gridGrouping(nextRhythm.grouping, groove.resolution);
      const pattern = findLibraryDrumPattern(groove.drumPatternId);

      updateProject(p => ({
        ...p,
        bpm: groove.bpm,
        swing: groove.swing,
        rhythmId: groove.rhythmId,
        resolution: groove.resolution,
        grooveId: groove.id,
        tracks: p.tracks.map(t =>
          isDrumRole(t.role) && pattern
            ? {
                ...t,
                performer: { ...t.performer, drumSteps: stretchDrumSteps(pattern.steps[t.role], nextGrid) }
              }
            : t
        )
      }));
    },
    [updateProject]
  );

  // --- Zoom ---
  const zoomBy = useCallback(
    (delta: number) => setZoom(z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta))),
    [setZoom]
  );

  /** Pixels per bar so the whole song sits in the visible lane area. */
  const zoomToFit = useCallback(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller || !flat.totalMeasures) return;
    const headW = scroller.querySelector<HTMLElement>('.st-corner')?.offsetWidth ?? 184;
    const available = scroller.clientWidth - headW - 2;
    if (available <= 0) return;
    const fit = Math.floor(available / flat.totalMeasures / ZOOM_STEP) * ZOOM_STEP;
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fit)));
    scroller.scrollLeft = 0;
  }, [flat.totalMeasures, setZoom]);

  // --- Transport / seek ---
  const handleSeek = useCallback(
    (measure: number) => {
      seek(measure);
      setPlayhead({ measure, sub: 0 });
    },
    [seek]
  );

  const handleStop = useCallback(() => {
    stop();
    setPlayhead(null);
  }, [stop]);

  // Fully stop (not pause) so the song's Transport event is cleared before
  // the wizard's audition orchestrator takes over the shared Transport.
  const handleOpenWizard = useCallback(() => {
    stop();
    setPlayhead(null);
    setWizardOpen(true);
  }, [stop]);

  const handleSaveCreature = useCallback(
    (creature: SavedCreature) => {
      setLibrary(prev => [...prev, creature]);
    },
    [setLibrary]
  );

  // --- Chord editor wiring ---
  const chordEditValue = useMemo<FoundrySettings | null>(() => {
    if (!chordEdit || !project) return null;
    const section = project.sections.find(s => s.id === chordEdit.sectionId);
    return section?.chords[chordEdit.chordIndex] ?? null;
  }, [chordEdit, project]);

  const chordEditTitle = useMemo(() => {
    if (!chordEdit || !project) return '';
    const section = project.sections.find(s => s.id === chordEdit.sectionId);
    return `${section?.name ?? 'Section'} · chord ${chordEdit.chordIndex + 1}`;
  }, [chordEdit, project]);

  const handleEditChord = useCallback((sectionId: string, chordIndex: number) => {
    setSelectedSectionId(sectionId);
    setChordEdit({ sectionId, chordIndex });
  }, []);

  const positionSection = playhead ? sectionAtMeasure(flat, playhead.measure) : null;

  // --- Transport clock ---
  const totalSeconds = useMemo(
    () =>
      project
        ? songDurationSeconds({ totalMeasures: flat.totalMeasures, subdivisions, bpm: project.bpm, resolution })
        : 0,
    [flat.totalMeasures, project, resolution, subdivisions]
  );
  const elapsed =
    project && playhead
      ? elapsedSeconds({ measure: playhead.measure, sub: playhead.sub, subdivisions, bpm: project.bpm, resolution })
      : 0;

  /** Slides the selected clip by whole bars, staying inside the song. */
  const nudgeSelectedClip = useCallback(
    (deltaBars: number) => {
      if (!selectedClipId) return;
      updateProject(p => {
        const total = p.sections.reduce((a, s) => a + s.measures, 0);
        const clip = p.clips.find(c => c.id === selectedClipId);
        if (!clip) return p;
        const start = Math.max(0, Math.min(total - clip.lengthMeasures, clip.startMeasure + deltaBars));
        if (start === clip.startMeasure) return p;
        return { ...p, clips: p.clips.map(c => (c.id === clip.id ? { ...c, startMeasure: start } : c)) };
      });
    },
    [selectedClipId, updateProject]
  );

  const toggleSelectedTrack = useCallback(
    (field: 'mute' | 'solo') => {
      if (!selectedTrackId) return;
      updateProject(p => ({
        ...p,
        tracks: p.tracks.map(t => (t.id === selectedTrackId ? { ...t, [field]: !t[field] } : t))
      }));
    },
    [selectedTrackId, updateProject]
  );

  // --- Keyboard shortcuts (DAW muscle memory) ---
  // Space play/pause · Home stop · Delete/Backspace removes the selected clip
  // · L toggles loop · M/S mute/solo the selected track · ←/→ nudge the
  // selected clip a bar · +/− zoom · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or
  // Ctrl+Y redo. Never while typing, and never while the wizard owns the screen.
  const hasProject = project !== null;
  useEffect(() => {
    if (!hasProject || wizardOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || target?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && (key === 'c' || key === 'x' || key === 'd')) {
        if (!selectedClipId && !selectedSectionId) return;
        e.preventDefault();
        if (key === 'c') copySelection();
        else if (key === 'x') cutSelection();
        else if (!e.repeat) duplicateSelection();
        return;
      }
      if (mod && key === 'v') {
        if (!clipboard) return;
        e.preventDefault();
        if (!e.repeat) pasteSelection();
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === 'Escape' && menu) {
        setMenu(null);
        return;
      }
      if (e.code === 'Space') {
        // A focused button already toggles on Space natively.
        if (tag === 'button') return;
        e.preventDefault();
        if (!e.repeat) void toggle();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        handleStop();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClipId) {
          e.preventDefault();
          removeClip(selectedClipId);
        }
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!selectedClipId) return;
        e.preventDefault();
        nudgeSelectedClip(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (key === '+' || key === '=') {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (key === '-' || key === '_') {
        e.preventDefault();
        zoomBy(-ZOOM_STEP);
        return;
      }
      if (e.repeat) return;
      if (key === 'l') setLoop(v => !v);
      else if (key === 'm') toggleSelectedTrack('mute');
      else if (key === 's') toggleSelectedTrack('solo');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [
    clipboard,
    copySelection,
    cutSelection,
    duplicateSelection,
    handleStop,
    hasProject,
    menu,
    nudgeSelectedClip,
    pasteSelection,
    redo,
    removeClip,
    selectedClipId,
    selectedSectionId,
    setLoop,
    toggle,
    toggleSelectedTrack,
    undo,
    wizardOpen,
    zoomBy
  ]);

  // --- Right-click menus: one builder per target kind ---
  const closeMenu = useCallback(() => setMenu(null), []);

  const playFrom = useCallback(
    (measure: number) => {
      handleSeek(measure);
      if (!isPlaying) void toggle();
    },
    [handleSeek, isPlaying, toggle]
  );

  const openMenu = useCallback((target: StudioMenuTarget, at: MenuPoint) => {
    setMenu({ target, at });
  }, []);

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu || !project) return [];
    const { target } = menu;
    const total = flat.totalMeasures;
    const clipOnClipboard = clipboard?.kind === 'clip';
    const sectionOnClipboard = clipboard?.kind === 'section';

    if (target.kind === 'clip') {
      const clip = project.clips.find(c => c.id === target.clipId);
      if (!clip) return [];
      const inside = target.measure > clip.startMeasure && target.measure < clip.startMeasure + clip.lengthMeasures;
      const sectionHere = sectionAtMeasure(flat, target.measure);
      return [
        { id: 'copy', label: 'Copy clip', shortcut: `${MOD_KEY}+C`, onSelect: () => copyClipToClipboard(clip.id) },
        { id: 'cut', label: 'Cut clip', shortcut: `${MOD_KEY}+X`, onSelect: () => cutClip(clip.id) },
        { id: 'dup', label: 'Duplicate after', shortcut: `${MOD_KEY}+D`, onSelect: () => duplicateSelectedClip(clip.id) },
        { separator: true },
        {
          id: 'split',
          label: `Split at bar ${target.measure + 1}`,
          disabled: !inside,
          onSelect: () => updateProject(p => ({ ...p, clips: splitClipAt(p.clips, clip.id, target.measure, makeSongId) }))
        },
        {
          id: 'fit',
          label: sectionHere ? `Fit to “${sectionHere.section.name}”` : 'Fit to section',
          disabled: !sectionHere,
          onSelect: () => {
            if (!sectionHere) return;
            updateProject(p => ({
              ...p,
              clips: p.clips.map(c =>
                c.id === clip.id
                  ? { ...c, startMeasure: sectionHere.startMeasure, lengthMeasures: sectionHere.endMeasure - sectionHere.startMeasure }
                  : c
              )
            }));
          }
        },
        { id: 'seek', label: 'Play from clip start', onSelect: () => playFrom(clip.startMeasure) },
        { separator: true },
        { id: 'delete', label: 'Delete clip', shortcut: 'Del', danger: true, onSelect: () => removeClip(clip.id) }
      ];
    }

    if (target.kind === 'lane') {
      const sectionHere = sectionAtMeasure(flat, target.measure);
      return [
        {
          id: 'paste',
          label: clipOnClipboard ? `Paste clip at bar ${target.measure + 1}` : 'Paste clip',
          shortcut: `${MOD_KEY}+V`,
          disabled: !clipOnClipboard,
          onSelect: () => pasteClipAt(target.trackId, target.measure)
        },
        {
          id: 'new',
          label: `New 1-bar clip at bar ${target.measure + 1}`,
          onSelect: () => {
            const clip = makeClip(target.trackId, target.measure, 1);
            updateProject(p => ({ ...p, clips: [...p.clips, clip] }));
            setSelectedClipId(clip.id);
          }
        },
        {
          id: 'section-clip',
          label: sectionHere ? `Clip across “${sectionHere.section.name}”` : 'Clip across section',
          disabled: !sectionHere,
          onSelect: () => {
            if (!sectionHere) return;
            const clip = makeClip(target.trackId, sectionHere.startMeasure, sectionHere.endMeasure - sectionHere.startMeasure);
            updateProject(p => ({ ...p, clips: [...p.clips, clip] }));
            setSelectedClipId(clip.id);
          }
        },
        {
          id: 'song-clip',
          label: 'Clip across the whole song',
          disabled: total === 0,
          onSelect: () => {
            const clip = makeClip(target.trackId, 0, total);
            updateProject(p => ({ ...p, clips: [...p.clips, clip] }));
            setSelectedClipId(clip.id);
          }
        },
        { separator: true },
        { id: 'seek', label: `Play from bar ${target.measure + 1}`, onSelect: () => playFrom(target.measure) }
      ];
    }

    if (target.kind === 'track') {
      const index = project.tracks.findIndex(t => t.id === target.trackId);
      const track = project.tracks[index];
      if (!track) return [];
      return [
        { id: 'mute', label: track.mute ? 'Unmute' : 'Mute', onSelect: () => updateTrack(track.id, { mute: !track.mute }) },
        { id: 'solo', label: track.solo ? 'Unsolo' : 'Solo', onSelect: () => updateTrack(track.id, { solo: !track.solo }) },
        { separator: true },
        { id: 'up', label: 'Move up', disabled: index === 0, onSelect: () => handleMoveTrack(track.id, -1) },
        {
          id: 'down',
          label: 'Move down',
          disabled: index === project.tracks.length - 1,
          onSelect: () => handleMoveTrack(track.id, 1)
        },
        { id: 'dup', label: 'Duplicate track', onSelect: () => handleDuplicateTrack(track.id) },
        {
          id: 'paste',
          label: 'Paste clip at playhead',
          shortcut: `${MOD_KEY}+V`,
          disabled: !clipOnClipboard,
          onSelect: () => pasteClipAt(track.id, playhead?.measure ?? 0)
        },
        { separator: true },
        { id: 'delete', label: 'Delete track', danger: true, onSelect: () => removeTrack(track.id) }
      ];
    }

    const index = project.sections.findIndex(s => s.id === target.sectionId);
    const section = project.sections[index];
    if (!section) return [];
    return [
      { id: 'copy', label: 'Copy section', shortcut: `${MOD_KEY}+C`, onSelect: () => copySectionToClipboard(section.id) },
      {
        id: 'cut',
        label: 'Cut section',
        shortcut: `${MOD_KEY}+X`,
        disabled: project.sections.length <= 1,
        onSelect: () => {
          copySectionToClipboard(section.id);
          removeSection(section.id);
        }
      },
      {
        id: 'paste',
        label: 'Paste section after',
        shortcut: `${MOD_KEY}+V`,
        disabled: !sectionOnClipboard,
        onSelect: () => pasteSectionAfter(section.id)
      },
      { id: 'dup', label: 'Duplicate section', shortcut: `${MOD_KEY}+D`, onSelect: () => handleDuplicateSection(section.id) },
      { id: 'add', label: 'Add empty section after', onSelect: () => addSectionAfter(section.id) },
      { separator: true },
      { id: 'left', label: 'Move left', disabled: index === 0, onSelect: () => moveSection(section.id, -1) },
      {
        id: 'right',
        label: 'Move right',
        disabled: index === project.sections.length - 1,
        onSelect: () => moveSection(section.id, 1)
      },
      { separator: true },
      {
        id: 'loop',
        label: `Loop “${section.name}”`,
        onSelect: () => {
          setSelectedSectionId(section.id);
          setLoopMode('section');
          setLoop(true);
        }
      },
      { id: 'seek', label: 'Play from here', onSelect: () => playFrom(flat.sectionSpans[index]?.startMeasure ?? 0) },
      { separator: true },
      {
        id: 'delete',
        label: 'Delete section',
        danger: true,
        disabled: project.sections.length <= 1,
        onSelect: () => removeSection(section.id)
      }
    ];
  }, [
    addSectionAfter,
    clipboard,
    copyClipToClipboard,
    copySectionToClipboard,
    cutClip,
    duplicateSelectedClip,
    flat,
    handleDuplicateSection,
    handleDuplicateTrack,
    handleMoveTrack,
    menu,
    moveSection,
    pasteClipAt,
    pasteSectionAfter,
    playFrom,
    playhead?.measure,
    project,
    removeClip,
    removeSection,
    removeTrack,
    setLoop,
    updateProject,
    updateTrack
  ]);

  // --- Empty state ---
  if (!project) {
    return (
      <section className="rhythm-engine stage-engine studio-engine">
        <header className="re-header">
          <div className="re-brand">
            <span className="re-brand-icon">
              <IconStudio />
            </span>
            <div>
              <h2 className="re-title">
                Song Studio <span className="re-accent-text">TIMELINE</span>
              </h2>
              <p className="re-subtitle">Arrange sections, tracks and clips into a full song on one timeline</p>
            </div>
          </div>
        </header>
        <div className="st-empty re-panel">
          <h3>No songs yet</h3>
          <p>
            Start with the wizard — it builds a full song structure and helps you cast creatures for every part — or
            open a blank 8-bar canvas. Creatures bred in the <Link to={conservatoryPath('/melody') as never}>Melody Engine</Link> are available
            to hire here.
          </p>
          <div className="st-empty-actions">
            <button type="button" className="re-play-btn" onClick={() => setWizardOpen(true)}>
              ✨ New song with the wizard
            </button>
            <button type="button" className="re-secondary-btn" onClick={handleBlankSong}>
              Blank song
            </button>
          </div>
        </div>
        {wizardOpen ? (
          <SongWizard
            library={library}
            onSaveCreature={handleSaveCreature}
            onGenerate={handleWizardGenerate}
            onClose={() => setWizardOpen(false)}
          />
        ) : null}
      </section>
    );
  }

  return (
    <section className="rhythm-engine stage-engine studio-engine">
      <header className="re-header">
        <div className="re-brand">
          <span className="re-brand-icon">
            <IconStudio />
          </span>
          <div>
            <h2 className="re-title">
              Song Studio <span className="re-accent-text">TIMELINE</span>
            </h2>
            <p className="re-subtitle">Arrange sections, tracks and clips into a full song on one timeline</p>
          </div>
        </div>
        <div className="stage-links">
          <Link to={conservatoryPath('/stage') as never}>Ensemble Stage</Link>
          <Link to={conservatoryPath('/melody') as never}>Melody Engine</Link>
          <Link to={conservatoryPath('/harmony') as never}>Harmony Engine</Link>
        </div>
        <div
          className="re-status"
          title={
            isPlaying
              ? 'The song is playing'
              : audioReady
                ? 'Audio is running — press Space or Play'
                : 'Browsers start audio on a click: the first Play wakes it'
          }
        >
          <span className={`re-status-dot${audioReady ? ' on' : ''}`} />
          <span className={audioReady ? 're-status-text on' : 're-status-text'}>
            {isPlaying ? (isRecording ? 'Recording' : 'Playing') : audioReady ? 'Audio ready' : 'Audio off · press Play'}
          </span>
        </div>
      </header>

      <StudioTransport
        isPlaying={isPlaying}
        audioReady={audioReady}
        isRecording={isRecording}
        onRecord={() => void handleRecord()}
        bpm={project.bpm}
        swing={project.swing}
        loop={loop}
        loopRegionLabel={loopMode === 'section' && selectedSection ? selectedSection.name : 'Song'}
        metronome={metronome}
        onMetronomeChange={setMetronome}
        positionMeasure={playhead?.measure ?? null}
        positionSub={playhead?.sub ?? null}
        totalMeasures={flat.totalMeasures}
        elapsedSeconds={elapsed}
        totalSeconds={totalSeconds}
        rhythmLabel={`${rhythm.label}${resolution === 'sixteenth' ? ' · 16ths' : ''}`}
        grooveId={project.grooveId ?? ''}
        onGrooveSelect={applyGroove}
        onGrooveClear={() => updateProject(p => ({ ...p, grooveId: undefined }))}
        onPlay={() => void toggle()}
        onStop={handleStop}
        onBpmChange={bpm => updateProject(p => ({ ...p, bpm }))}
        onBpmNudge={delta => updateProject(p => ({ ...p, bpm: Math.min(BPM_MAX, Math.max(BPM_MIN, p.bpm + delta)) }))}
        onSwingChange={swing => updateProject(p => ({ ...p, swing }))}
        onLoopChange={setLoop}
      />

      {notice ? (
        <p className={`st-handoff-note${notice.tone === 'error' ? ' error' : ''}`} role="status">
          {notice.text}
        </p>
      ) : null}

      <div className="st-toolbar">
        <div className="st-toolbar-group">
          <label className="re-micro-label" htmlFor="st-project">
            Song
          </label>
          <select id="st-project" className="re-select" value={project.id} onChange={e => handleSwitchProject(e.target.value)}>
            {projects.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" className="re-secondary-btn st-tool-btn" onClick={handleOpenWizard}>
            ✨ Wizard
          </button>
          <button type="button" className="re-secondary-btn st-tool-btn" onClick={handleBlankSong}>
            + Blank
          </button>
          <button type="button" className="re-secondary-btn st-tool-btn" onClick={handleDuplicate}>
            Duplicate
          </button>
          <button
            type="button"
            className="re-secondary-btn st-tool-btn"
            onClick={handleExport}
            title="Download this song as a .json file you can back up or share"
          >
            Export
          </button>
          <button
            type="button"
            className="re-secondary-btn st-tool-btn"
            onClick={() => importInputRef.current?.click()}
            title="Import a song exported from the Studio"
          >
            Import
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="st-file-input"
            aria-label="Import a song file"
            onChange={e => {
              void handleImportFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className={`re-secondary-btn st-tool-btn st-danger${confirmDelete ? ' armed' : ''}`}
            onClick={handleDelete}
            aria-live="polite"
            title={confirmDelete ? 'Tap again to delete this song for good' : 'Delete this song'}
          >
            {confirmDelete ? 'Really delete?' : 'Delete'}
          </button>
        </div>
        <div className="st-toolbar-group">
          <span className="re-micro-label">History</span>
          <div className="re-pills">
            <button
              type="button"
              className="re-pill st-history-btn"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl/Cmd+Z)"
              aria-label="Undo"
            >
              ↶ Undo
            </button>
            <button
              type="button"
              className="re-pill st-history-btn"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl/Cmd+Shift+Z)"
              aria-label="Redo"
            >
              ↷ Redo
            </button>
          </div>
        </div>
        <div className="st-toolbar-group">
          <span className="re-micro-label">Loop region</span>
          <div className="re-pills">
            <button
              type="button"
              className={`re-pill${loopMode === 'song' ? ' on' : ''}`}
              onClick={() => setLoopMode('song')}
            >
              Whole song
            </button>
            <button
              type="button"
              className={`re-pill${loopMode === 'section' ? ' on' : ''}`}
              onClick={() => setLoopMode('section')}
              disabled={!selectedSection}
              title={selectedSection ? `Loop ${selectedSection.name}` : 'Select a section first'}
            >
              Section
            </button>
          </div>
        </div>
        <div className="st-toolbar-group st-zoom">
          <label className="re-micro-label" htmlFor="st-zoom">
            Zoom
          </label>
          <button
            type="button"
            className="re-pill st-zoom-btn"
            onClick={() => zoomBy(-ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            title="Zoom out (−)"
            aria-label="Zoom out"
          >
            −
          </button>
          <input
            id="st-zoom"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            value={zoom}
            onChange={e => setZoom(parseInt(e.target.value, 10))}
            title={`${zoom} px per bar`}
          />
          <button
            type="button"
            className="re-pill st-zoom-btn"
            onClick={() => zoomBy(ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            title="Zoom in (+)"
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="re-pill"
            onClick={zoomToFit}
            disabled={!flat.totalMeasures}
            title="Zoom so the whole song fits in view"
          >
            Fit
          </button>
          <button
            type="button"
            className={`re-pill${followPlayhead ? ' on' : ''}`}
            onClick={() => setFollowPlayhead(v => !v)}
            aria-pressed={followPlayhead}
            title="Scroll the timeline to keep the playhead in view while the song plays"
          >
            Follow
          </button>
          <span className="st-position-hint">
            {positionSection ? positionSection.section.name : '—'}
          </span>
        </div>
      </div>

      <SongTimeline
        project={project}
        flat={flat}
        zoom={zoom}
        subdivisions={subdivisions}
        playhead={playhead}
        followPlayhead={followPlayhead}
        scrollerRef={timelineScrollRef}
        loopRegion={loopRegion}
        selectedSectionId={selectedSectionId}
        selectedTrackId={selectedTrackId}
        selectedClipId={selectedClipId}
        onSeek={handleSeek}
        onSelectSection={id => {
          setSelectedSectionId(prev => (prev === id ? null : id));
          setChordEdit(null);
        }}
        onReorderSection={reorderSection}
        onContextMenu={openMenu}
        onSelectTrack={setSelectedTrackId}
        onSelectClip={setSelectedClipId}
        onEditChord={handleEditChord}
        onClipsChange={clips => updateProject(p => ({ ...p, clips }))}
        onTrackChange={updateTrack}
        onRemoveTrack={removeTrack}
        onAddTrack={() => setAddTrackOpen(v => !v)}
      />

      {menu && menuItems.length ? (
        <ContextMenu
          x={menu.at.x}
          y={menu.at.y}
          label={
            menu.target.kind === 'clip'
              ? 'Clip actions'
              : menu.target.kind === 'lane'
                ? 'Lane actions'
                : menu.target.kind === 'track'
                  ? 'Track actions'
                  : 'Section actions'
          }
          items={menuItems}
          onClose={closeMenu}
        />
      ) : null}

      {addTrackOpen ? (
        <div className="st-add-menu re-panel">
          <div className="re-panel-head">
            <div>
              <h3>Add a track</h3>
              <p>Core roles, your saved voices, or hire from your creature library</p>
            </div>
          </div>
          <div className="re-pills">
            {CORE_STUDIO_ROLES.map(role => (
              <button key={role} type="button" className="re-pill" onClick={() => addTrack(role)}>
                + {ROLE_LABEL[role]}
              </button>
            ))}
            <button
              type="button"
              className="re-pill"
              onClick={() => addTrack({ writtenLead: true })}
              title="A lead track with a piano-roll editor — write the melody note by note"
            >
              + written lead ✏
            </button>
          </div>
          <div className="re-stack-sm">
            <span className="re-micro-label">Your voices ({customVoices.length})</span>
            {customVoices.length ? (
              <div className="vb-voice-list st-voice-list" data-testid="studio-voice-list">
                {customVoices.map(voice => (
                  <div key={voice.id} className="vb-voice-row st-voice-row">
                    <span className="vb-swatch sm" style={{ background: `hsl(${voice.hue} 70% 58%)` }} aria-hidden />
                    <div className="vb-voice-info">
                      <strong>{voice.name}</strong>
                      <span>{voiceEngineLabel(voice)}</span>
                    </div>
                    <div className="re-pills st-voice-roles" role="group" aria-label={`Add a track playing ${voice.name}`}>
                      {VOICE_TRACK_ROLES.map(role => (
                        <button
                          key={role}
                          type="button"
                          className="re-pill"
                          onClick={() => addTrack({ voice, role })}
                          title={`Add a ${ROLE_LABEL[role]} track that plays ${voice.name}`}
                        >
                          + {ROLE_LABEL[role]}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="stage-perf-flavor">
                No saved voices yet — build some in the Voice Builder on the{' '}
                <Link to={conservatoryPath('/melody') as never}>Melody</Link> or{' '}
                <Link to={conservatoryPath('/harmony') as never}>Harmony</Link> Engine. Any track&apos;s voice can also be
                changed later in the Track inspector.
              </p>
            )}
          </div>
          <div className="re-stack-sm">
            <span className="re-micro-label">Creature library ({library.length})</span>
            {library.length ? (
              <div className="stage-hire-list">
                {library.map(saved => (
                  <div key={saved.id} className="stage-hire-row">
                    <div>
                      <strong>{saved.name}</strong>
                      <span>
                        {saved.kind === 'bass' ? 'Bass Serpent' : 'Melody Wisp'} · {findVoice(saved.voiceId).name} ·{' '}
                        {findContour(saved.contourId).name}
                      </span>
                    </div>
                    <button type="button" className="stage-perf-btn on" onClick={() => addTrack({ creature: saved })}>
                      Hire
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="stage-perf-flavor">
                No saved creatures yet — breed some in the <Link to={conservatoryPath('/melody') as never}>Melody Engine</Link>.
              </p>
            )}
          </div>
        </div>
      ) : null}

      {(() => {
        const editorTrack = melodyEditorTrackId ? project.tracks.find(t => t.id === melodyEditorTrackId) : null;
        if (!editorTrack || editorTrack.performer.melodyMode !== 'written') return null;
        return (
          <MelodyEditor
            trackName={editorTrack.name}
            notes={editorTrack.performer.writtenNotes ?? []}
            flat={flat}
            subdivisions={subdivisions}
            strongSubs={strongSubs}
            keyRoot={project.keyRoot}
            octaveShift={editorTrack.performer.octaveShift ?? 0}
            playhead={playhead}
            onChange={writtenNotes => updateTrackPerformer(editorTrack.id, { writtenNotes })}
            onClose={() => setMelodyEditorTrackId(null)}
          />
        );
      })()}

      <div className="st-inspectors">
        <div className="re-panel re-stack st-inspector">
          <div className="re-panel-head">
            <div>
              <h3>Song settings</h3>
              <p>Name, key, meter, drum fills, master bus</p>
            </div>
          </div>
          <div className="re-stack-sm">
            <label className="re-micro-label" htmlFor="st-name">
              Name
            </label>
            <input
              id="st-name"
              className="re-select"
              type="text"
              maxLength={40}
              value={project.name}
              onChange={e => updateProject(p => ({ ...p, name: e.target.value }))}
            />
          </div>
          <div className="he-row-2">
            <div className="re-stack-sm">
              <label className="re-micro-label" htmlFor="st-key">
                Key
              </label>
              <select
                id="st-key"
                className="re-select"
                value={project.keyRoot}
                onChange={e => updateProject(p => ({ ...p, keyRoot: e.target.value as NoteName }))}
                title="Seeds new sections' chords and anchors written leads; existing chords stay as forged"
              >
                {NOTE_NAMES.map(n => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="re-stack-sm">
              <label className="re-micro-label" htmlFor="st-rhythm">
                Meter
              </label>
              <select
                id="st-rhythm"
                className="re-select"
                value={project.rhythmId}
                onChange={e => updateProject(p => ({ ...p, rhythmId: e.target.value }))}
                title="Time signature and beat grouping for every bar"
              >
                {rhythms.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.label} · {r.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="he-row-2">
            <div className="re-stack-sm">
              <label className="re-micro-label" htmlFor="st-fills">
                Drum fills
              </label>
              <select
                id="st-fills"
                className="re-select"
                value={project.fills?.frequency ?? 'off'}
                onChange={e => {
                  const frequency = e.target.value as FillFrequency;
                  updateProject(p => ({
                    ...p,
                    fills: frequency === 'off' ? undefined : { frequency, length: p.fills?.length ?? 'short' }
                  }));
                }}
              >
                <option value="off">Off</option>
                <option value="section">End of every section</option>
                <option value="every4">Every 4 bars</option>
                <option value="every8">Every 8 bars</option>
              </select>
            </div>
            <div className="re-stack-sm">
              <span className="re-micro-label">Fill length</span>
              <div className="re-pills">
                {(['short', 'long'] as const).map(length => (
                  <button
                    key={length}
                    type="button"
                    className={`re-pill${(project.fills?.length ?? 'short') === length ? ' on' : ''}`}
                    disabled={!project.fills}
                    onClick={() => updateProject(p => (p.fills ? { ...p, fills: { ...p.fills, length } } : p))}
                  >
                    {length === 'short' ? '¼ bar' : '½ bar'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="re-slider-head sm">
              <label htmlFor="st-master">Master</label>
              <span className="re-slider-val sm">{project.masterVolume} dB</span>
            </div>
            <input
              id="st-master"
              type="range"
              min={-24}
              max={0}
              step={1}
              value={project.masterVolume}
              onChange={e => updateProject(p => ({ ...p, masterVolume: parseInt(e.target.value, 10) }))}
            />
          </div>
          <div>
            <div className="re-slider-head sm">
              <label htmlFor="st-reverb">Reverb send</label>
              <span className="re-slider-val sm">{Math.round(project.reverbWet * 100)}%</span>
            </div>
            <input
              id="st-reverb"
              type="range"
              min={0}
              max={0.6}
              step={0.01}
              value={project.reverbWet}
              onChange={e => updateProject(p => ({ ...p, reverbWet: parseFloat(e.target.value) }))}
            />
          </div>
        </div>

        <div className="re-panel re-stack st-inspector">
          <div className="re-panel-head">
            <div>
              <h3>Section</h3>
              <p>{selectedSection ? `${selectedSection.name} · ${selectedSection.measures} bars` : 'Click a section block in the ruler'}</p>
            </div>
            {selectedSection ? (
              <button
                type="button"
                className="stage-perf-btn remove"
                onClick={() => removeSection(selectedSection.id)}
                disabled={project.sections.length <= 1}
                title="Delete section"
              >
                ×
              </button>
            ) : null}
          </div>

          {selectedSection ? (
            <>
              <div className="he-row-2">
                <div className="re-stack-sm">
                  <label className="re-micro-label" htmlFor="st-sec-name">
                    Name
                  </label>
                  <input
                    id="st-sec-name"
                    className="re-select"
                    type="text"
                    maxLength={24}
                    value={selectedSection.name}
                    onChange={e => updateSection(selectedSection.id, { name: e.target.value })}
                  />
                </div>
                <div className="re-stack-sm">
                  <label className="re-micro-label" htmlFor="st-sec-kind">
                    Kind
                  </label>
                  <select
                    id="st-sec-kind"
                    className="re-select"
                    value={selectedSection.kind}
                    onChange={e => updateSection(selectedSection.id, { kind: e.target.value as SectionKind })}
                  >
                    {SECTION_KINDS.map(k => (
                      <option key={k} value={k}>
                        {SECTION_KIND_META[k].label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="he-row-2">
                <div className="re-stack-sm">
                  <label className="re-micro-label" htmlFor="st-sec-measures">
                    Bars
                  </label>
                  <input
                    id="st-sec-measures"
                    className="re-select"
                    type="number"
                    min={MIN_SECTION_MEASURES}
                    max={MAX_SECTION_MEASURES}
                    value={selectedSection.measures}
                    onChange={e => {
                      const v = parseInt(e.target.value, 10);
                      if (!Number.isNaN(v)) {
                        updateSection(selectedSection.id, {
                          measures: Math.min(MAX_SECTION_MEASURES, Math.max(MIN_SECTION_MEASURES, v))
                        });
                      }
                    }}
                  />
                </div>
                <div className="stage-perf-octaves">
                  <span className="re-micro-label">Bars per chord</span>
                  <div className="re-pills">
                    {[1, 2, 4].map(n => (
                      <button
                        key={n}
                        type="button"
                        className={`re-pill${selectedSection.measuresPerChord === n ? ' on' : ''}`}
                        onClick={() => updateSection(selectedSection.id, { measuresPerChord: n })}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="re-stack-sm">
                <span className="re-micro-label">Chords — click one to edit, + to append</span>
                <div className="st-chord-chips">
                  {selectedSection.chords.map((c, i) => (
                    <button
                      key={`${selectedSection.id}-${i}`}
                      type="button"
                      className={`st-chord-chip${chordEdit?.sectionId === selectedSection.id && chordEdit.chordIndex === i ? ' on' : ''}`}
                      onClick={() => setChordEdit({ sectionId: selectedSection.id, chordIndex: i })}
                    >
                      {nameChord(c.root, c.quality, c.extension)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="st-chord-chip add"
                    disabled={selectedSection.chords.length >= MAX_SECTION_CHORDS}
                    onClick={() => {
                      const last = selectedSection.chords[selectedSection.chords.length - 1];
                      updateSection(selectedSection.id, { chords: [...selectedSection.chords, { ...last }] });
                    }}
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="st-part-row">
                <select
                  className="re-select"
                  aria-label="Seed progression"
                  defaultValue=""
                  onChange={e => {
                    if (!e.target.value) return;
                    updateSection(selectedSection.id, { chords: seedSectionChords(e.target.value, project.keyRoot) });
                    setChordEdit(null);
                    e.target.value = '';
                  }}
                >
                  <option value="">Re-seed from progression…</option>
                  {PROGRESSION_PRESETS.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="re-pills">
                <button
                  type="button"
                  className="re-pill"
                  onClick={() => moveSection(selectedSection.id, -1)}
                  disabled={project.sections[0]?.id === selectedSection.id}
                  title="Move left (or drag the block in the ruler)"
                >
                  ← Move
                </button>
                <button
                  type="button"
                  className="re-pill"
                  onClick={() => moveSection(selectedSection.id, 1)}
                  disabled={project.sections[project.sections.length - 1]?.id === selectedSection.id}
                  title="Move right (or drag the block in the ruler)"
                >
                  Move →
                </button>
                <button type="button" className="re-pill" onClick={() => addSectionAfter(selectedSection.id)}>
                  + Add after
                </button>
                <button
                  type="button"
                  className="re-pill"
                  onClick={() => handleDuplicateSection(selectedSection.id)}
                  title="Duplicate this section with the clips that play in it (Ctrl+D)"
                >
                  ⧉ Duplicate
                </button>
                <button
                  type="button"
                  className="re-pill"
                  onClick={() => copySectionToClipboard(selectedSection.id)}
                  title="Copy this section and its clips (Ctrl+C)"
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="re-pill"
                  onClick={() => pasteSectionAfter(selectedSection.id)}
                  disabled={clipboard?.kind !== 'section'}
                  title={clipboard?.kind === 'section' ? `Paste “${clipboard.payload.section.name}” after this one (Ctrl+V)` : 'Copy a section first'}
                >
                  Paste after
                </button>
              </div>

              {chordEdit && chordEditValue ? (
                <ChordSlotEditor
                  title={chordEditTitle}
                  value={chordEditValue}
                  onChange={settings => updateSectionChord(chordEdit.sectionId, chordEdit.chordIndex, settings)}
                  onClose={() => setChordEdit(null)}
                  onRemove={
                    selectedSection.chords.length > MIN_SECTION_CHORDS
                      ? () => {
                          updateSection(selectedSection.id, {
                            chords: selectedSection.chords.filter((_, i) => i !== chordEdit.chordIndex)
                          });
                          setChordEdit(null);
                        }
                      : undefined
                  }
                />
              ) : null}
            </>
          ) : (
            <div className="re-pills">
              <button type="button" className="re-pill" onClick={() => addSectionAfter(null)}>
                + Add section
              </button>
            </div>
          )}
        </div>

        <div className="re-panel re-stack st-inspector">
          <div className="re-panel-head">
            <div>
              <h3>Track</h3>
              <p>
                {selectedTrack
                  ? `${ROLE_LABEL[selectedTrack.role]} · ${selectedTrack.volume} dB${selectedTrack.mute ? ' · muted' : ''}${selectedTrack.solo ? ' · solo' : ''}`
                  : 'Click a track name in the timeline'}
              </p>
            </div>
            {selectedTrack ? (
              <div className="st-track-actions">
                <button
                  type="button"
                  className="vb-icon-btn"
                  onClick={() => handleMoveTrack(selectedTrack.id, -1)}
                  disabled={project.tracks[0]?.id === selectedTrack.id}
                  title="Move track up"
                  aria-label="Move track up"
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="vb-icon-btn"
                  onClick={() => handleMoveTrack(selectedTrack.id, 1)}
                  disabled={project.tracks[project.tracks.length - 1]?.id === selectedTrack.id}
                  title="Move track down"
                  aria-label="Move track down"
                >
                  ▼
                </button>
                <button
                  type="button"
                  className="vb-icon-btn"
                  onClick={() => handleDuplicateTrack(selectedTrack.id)}
                  title="Duplicate track (with its clips)"
                  aria-label="Duplicate track"
                >
                  ⧉
                </button>
              </div>
            ) : null}
          </div>

          {selectedTrack && selectedClip && selectedClip.trackId === selectedTrack.id ? (
            <div className="st-clip-inspector">
              <span className="re-micro-label">
                Clip · bars {selectedClip.startMeasure + 1}–{selectedClip.startMeasure + selectedClip.lengthMeasures}
              </span>
              <div className="re-pills">
                <button
                  type="button"
                  className="re-pill"
                  onClick={splitSelectedClip}
                  disabled={splitMeasure === null}
                  title={
                    splitMeasure === null
                      ? 'Seek inside the clip (click a bar in the ruler) to split it there'
                      : `Split at bar ${splitMeasure + 1}`
                  }
                >
                  ✂ Split{splitMeasure !== null ? ` at bar ${splitMeasure + 1}` : ''}
                </button>
                <button
                  type="button"
                  className="re-pill"
                  onClick={() => copyClipToClipboard(selectedClip.id)}
                  title="Copy clip (Ctrl+C)"
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="re-pill"
                  onClick={() => duplicateSelectedClip(selectedClip.id)}
                  title="Drop a copy right after this clip (Ctrl+D)"
                >
                  ⧉ Duplicate
                </button>
                <button type="button" className="re-pill st-danger" onClick={() => removeClip(selectedClip.id)} title="Delete clip (Delete key)">
                  Delete clip
                </button>
              </div>
            </div>
          ) : null}

          {selectedTrack && clipboard?.kind === 'clip' && !(selectedClip && selectedClip.trackId === selectedTrack.id) ? (
            <div className="st-clip-inspector">
              <span className="re-micro-label">Clipboard · {clipboard.trackName} clip · {clipboard.clip.lengthMeasures} bars</span>
              <div className="re-pills">
                <button
                  type="button"
                  className="re-pill"
                  onClick={() => pasteClipAt(selectedTrack.id, playhead?.measure ?? 0)}
                  title="Paste onto this track at the playhead (Ctrl+V)"
                >
                  Paste at bar {(playhead?.measure ?? 0) + 1}
                </button>
              </div>
            </div>
          ) : null}

          {selectedTrack ? (
            <>
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="st-track-name">
                  Name
                </label>
                <input
                  id="st-track-name"
                  className="re-select"
                  type="text"
                  maxLength={28}
                  value={selectedTrack.name}
                  onChange={e =>
                    updateProject(p => ({
                      ...p,
                      tracks: p.tracks.map(t =>
                        t.id === selectedTrack.id
                          ? { ...t, name: e.target.value, performer: { ...t.performer, displayName: e.target.value } }
                          : t
                      )
                    }))
                  }
                />
              </div>
              <div className="he-row-2 st-mix-row">
                <div>
                  <div className="re-slider-head sm">
                    <label htmlFor="st-track-level">Level</label>
                    <span className="re-slider-val sm">{selectedTrack.volume} dB</span>
                  </div>
                  <input
                    id="st-track-level"
                    type="range"
                    min={-24}
                    max={0}
                    step={1}
                    value={selectedTrack.volume}
                    onChange={e => updateTrack(selectedTrack.id, { volume: parseInt(e.target.value, 10) })}
                  />
                </div>
                <div>
                  <div className="re-slider-head sm">
                    <label htmlFor="st-track-pan">Pan</label>
                    <span className="re-slider-val sm">{formatPan(selectedTrack.pan ?? 0)}</span>
                  </div>
                  <input
                    id="st-track-pan"
                    type="range"
                    min={-1}
                    max={1}
                    step={0.05}
                    value={selectedTrack.pan ?? 0}
                    disabled={isDrumRole(selectedTrack.role)}
                    onChange={e => updateTrack(selectedTrack.id, { pan: parseFloat(e.target.value) })}
                    onDoubleClick={() => updateTrack(selectedTrack.id, { pan: 0 })}
                    title={
                      isDrumRole(selectedTrack.role)
                        ? 'Drum roles share one bus each and stay centred'
                        : 'Stereo position — double-click to re-centre'
                    }
                  />
                </div>
              </div>
            </>
          ) : null}

          {selectedTrack ? (
            isDrumRole(selectedTrack.role) ? (
              <div className="re-stack-sm">
                <span className="re-micro-label">
                  Step pattern · {subdivisions} {GRID_STEP_LABEL[resolution]} per bar · click to toggle
                </span>
                <div className="st-step-grid">
                  {Array.from({ length: subdivisions }, (_, i) => {
                    const steps =
                      selectedTrack.performer.drumSteps?.length === subdivisions
                        ? selectedTrack.performer.drumSteps
                        : seedDrumPattern(selectedTrack.role as 'kick' | 'snare' | 'hihat', grid);
                    const on = steps[i];
                    return (
                      <button
                        key={i}
                        type="button"
                        className={`st-step${on ? ' on' : ''}${strongSubs.includes(i) ? ' strong' : ''}`}
                        aria-pressed={on}
                        title={`Step ${i + 1}${strongSubs.includes(i) ? ' · on the beat' : ''}`}
                        onClick={() => {
                          const next = steps.map((s, j) => (j === i ? !s : s));
                          updateTrackPerformer(selectedTrack.id, { drumSteps: next });
                        }}
                      >
                        {i + 1}
                      </button>
                    );
                  })}
                </div>
                <div className="re-pills">
                  <button
                    type="button"
                    className="re-pill"
                    onClick={() => updateTrackPerformer(selectedTrack.id, { drumSteps: Array(subdivisions).fill(false) })}
                    title="Silence every step"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    className="re-pill"
                    onClick={() =>
                      updateTrackPerformer(selectedTrack.id, {
                        drumSteps: seedDrumPattern(selectedTrack.role as 'kick' | 'snare' | 'hihat', grid)
                      })
                    }
                    title="Back to the role's default pattern for this meter"
                  >
                    Reset pattern
                  </button>
                  <button
                    type="button"
                    className="re-pill"
                    onClick={() =>
                      updateTrackPerformer(selectedTrack.id, {
                        drumSteps: Array.from({ length: subdivisions }, (_, i) => strongSubs.includes(i))
                      })
                    }
                    title="One hit on every beat"
                  >
                    Every beat
                  </button>
                </div>
                <p className="stage-perf-flavor">
                  The pattern repeats every bar wherever this track has a clip. Drum fills are set per song in Song settings.
                </p>
              </div>
            ) : (
              <>
                <div className="re-stack-sm">
                  <label className="re-micro-label" htmlFor="st-track-voice">
                    Voice
                  </label>
                  <select
                    id="st-track-voice"
                    className="re-select"
                    value={selectedTrack.performer.voiceId ?? 'glass-pad'}
                    onChange={e => updateTrackPerformer(selectedTrack.id, { voiceId: e.target.value })}
                  >
                    {allVoices.map(v => (
                      <option key={v.id} value={v.id}>
                        {v.name} — {v.blurb}
                      </option>
                    ))}
                  </select>
                </div>
                {selectedTrack.role === 'chords' ? (
                  <div className="he-row-2">
                    <div className="re-stack-sm">
                      <label className="re-micro-label" htmlFor="st-track-voicing">
                        Voicing override
                      </label>
                      <select
                        id="st-track-voicing"
                        className="re-select"
                        value={selectedTrack.performer.voicingOverride ?? ''}
                        onChange={e =>
                          updateTrackPerformer(selectedTrack.id, {
                            voicingOverride: (e.target.value || undefined) as VoicingId | undefined
                          })
                        }
                      >
                        <option value="">Follow song</option>
                        {VOICINGS.map(v => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="re-stack-sm">
                      <label className="re-micro-label" htmlFor="st-track-register">
                        Register override
                      </label>
                      <select
                        id="st-track-register"
                        className="re-select"
                        value={selectedTrack.performer.registerOverride ?? ''}
                        onChange={e =>
                          updateTrackPerformer(selectedTrack.id, {
                            registerOverride: (e.target.value || undefined) as RegisterId | undefined
                          })
                        }
                      >
                        <option value="">Follow song</option>
                        <option value="low">Low</option>
                        <option value="mid">Mid</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>
                ) : (
                  <>
                    {selectedTrack.role === 'melody' ? (
                      <div className="stage-perf-octaves">
                        <span className="re-micro-label">Melody source</span>
                        <div className="re-pills">
                          <button
                            type="button"
                            className={`re-pill${(selectedTrack.performer.melodyMode ?? 'contour') === 'contour' ? ' on' : ''}`}
                            onClick={() => updateTrackPerformer(selectedTrack.id, { melodyMode: 'contour' })}
                          >
                            Contour loop
                          </button>
                          <button
                            type="button"
                            className={`re-pill${selectedTrack.performer.melodyMode === 'written' ? ' on' : ''}`}
                            onClick={() => {
                              updateTrackPerformer(selectedTrack.id, {
                                melodyMode: 'written',
                                writtenNotes: selectedTrack.performer.writtenNotes ?? []
                              });
                              setMelodyEditorTrackId(selectedTrack.id);
                            }}
                          >
                            Written lead ✏
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {selectedTrack.role === 'melody' && selectedTrack.performer.melodyMode === 'written' ? (
                      <button
                        type="button"
                        className="re-secondary-btn"
                        onClick={() => setMelodyEditorTrackId(selectedTrack.id)}
                      >
                        ✏ Open melody editor ({selectedTrack.performer.writtenNotes?.length ?? 0} notes)
                      </button>
                    ) : (
                      <div className="re-stack-sm">
                        <label className="re-micro-label" htmlFor="st-track-contour">
                          Contour
                        </label>
                        <select
                          id="st-track-contour"
                          className="re-select"
                          value={selectedTrack.performer.contourId ?? 'root-anchor'}
                          onChange={e => updateTrackPerformer(selectedTrack.id, { contourId: e.target.value })}
                        >
                          {allContours.map(c => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <p className="stage-perf-flavor">{findContour(selectedTrack.performer.contourId).flavor}</p>
                      </div>
                    )}
                    <div className="stage-perf-octaves">
                      <span className="re-micro-label">Register</span>
                      <div className="re-pills">
                        {([-1, 0, 1] as const).map(shift => (
                          <button
                            key={shift}
                            type="button"
                            className={`re-pill${(selectedTrack.performer.octaveShift ?? 0) === shift ? ' on' : ''}`}
                            onClick={() => updateTrackPerformer(selectedTrack.id, { octaveShift: shift })}
                          >
                            {shift > 0 ? `+${shift}` : shift} oct
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            )
          ) : (
            <p className="stage-perf-flavor">
              Click a track name to open it here: name, level and pan for every track, the step grid for drums, voice /
              contour / register for tonal parts. Click a clip to select it, drag empty lane space to paint a new one,
              and right-click anything for more.
            </p>
          )}
        </div>
      </div>

      <p className="st-shortcuts" aria-label="Keyboard shortcuts">
        <kbd>Space</kbd> play / pause · <kbd>Home</kbd> stop · <kbd>L</kbd> loop · <kbd>M</kbd> / <kbd>S</kbd> mute / solo
        track · <kbd>←</kbd> <kbd>→</kbd> nudge clip a bar · <kbd>Del</kbd> remove clip · <kbd>+</kbd> / <kbd>−</kbd> zoom ·{' '}
        <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redo · <kbd>Ctrl</kbd>+<kbd>C</kbd> /{' '}
        <kbd>X</kbd> / <kbd>V</kbd> copy / cut / paste clip or section · <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate · drag a section
        block to reorder · right-click clips, lanes, tracks and sections for more
      </p>

      {wizardOpen ? (
        <SongWizard
          library={library}
          onSaveCreature={handleSaveCreature}
          onGenerate={handleWizardGenerate}
          onClose={() => setWizardOpen(false)}
        />
      ) : null}
    </section>
  );
}
