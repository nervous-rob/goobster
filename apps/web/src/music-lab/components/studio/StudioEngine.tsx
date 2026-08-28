import { Link } from '@tanstack/react-router';
import { conservatoryPath } from '@music-lab/lib/paths';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NOTE_NAMES, type NoteName } from '@music-lab/lib/musicData';
import { PROGRESSION_PRESETS, VOICINGS, type RegisterId, type VoicingId } from '@music-lab/lib/harmonyData';
import { buildHarmonyGenome, nameChord, type FoundrySettings } from '@music-lab/lib/harmonyTheory';
import { RHYTHMS } from '@music-lab/lib/rhythmData';
import { useRhythmOptions } from '@music-lab/hooks/useRhythmOptions';
import { GRID_STEP_LABEL, gridGrouping, totalSubdivisions } from '@music-lab/lib/rhythmTheory';
import { takeStudioHandoff } from '@music-lab/lib/handoff';
import { findLibraryDrumPattern, stretchDrumSteps, type LibraryGroove } from '@music-lab/lib/genreLibrary';
import { downloadBlob, recordingToWavBlob } from '@music-lab/lib/audioExport';
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
import { findVoice } from '@music-lab/lib/voiceData';
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
  makeClip,
  makeSongId,
  makeTrackFromCreature,
  makeTrackFromRole,
  type FillFrequency,
  type SongClip,
  type SongProject,
  type SongSection,
  type SongTrack,
  type SectionKind
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
import { StudioTransport } from './StudioTransport';
import { SongTimeline } from './SongTimeline';
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

const HARMONY_HOLD = 0.96;
const MIN_ZOOM = 12;
const MAX_ZOOM = 96;

export function StudioEngine() {
  const [projects, setProjects] = useLocalStorage<SongProject[]>(STUDIO_PROJECTS_KEY, []);
  const [currentId, setCurrentId] = useLocalStorage<string | null>(STUDIO_CURRENT_KEY, null);
  const [library, setLibrary] = useLocalStorage<SavedCreature[]>(CREATURE_LIBRARY_KEY, []);
  const [zoom, setZoom] = useLocalStorage<number>('studioZoom', 40);
  const [loop, setLoop] = useLocalStorage<boolean>('studioLoop', true);

  const { allVoices } = useVoiceLibrary();
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

  const updateProject = useCallback(
    (updater: (p: SongProject) => SongProject) => {
      if (!project) return;
      setProjects(prev => prev.map(p => (p.id === project.id ? updater(p) : p)));
    },
    [project, setProjects]
  );

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
      tracks: runtimeTracks
    });
  }, [project, grid, resolution, flat.totalMeasures, fillMeasures, fillLengthSubs, loop, loopRegion, runtimeTracks, setConfig]);

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
    adoptProject({ ...project, id: makeSongId('song'), name: `${project.name} (copy)` });
  }, [adoptProject, project]);

  const handleDelete = useCallback(() => {
    if (!project) return;
    stop();
    setProjects(prev => prev.filter(p => p.id !== project.id));
    setCurrentId(null);
    setSelectedSectionId(null);
    setSelectedTrackId(null);
    setSelectedClipId(null);
    setChordEdit(null);
  }, [project, setCurrentId, setProjects, stop]);

  const handleSwitchProject = useCallback(
    (id: string) => {
      stop();
      setCurrentId(id);
      setSelectedSectionId(null);
      setSelectedTrackId(null);
      setSelectedClipId(null);
      setChordEdit(null);
      setPlayhead(null);
    },
    [setCurrentId, stop]
  );

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

  const moveSection = useCallback(
    (id: string, dir: -1 | 1) => {
      updateProject(p => {
        const index = p.sections.findIndex(s => s.id === id);
        const target = index + dir;
        if (index < 0 || target < 0 || target >= p.sections.length) return p;
        const sections = [...p.sections];
        const [moved] = sections.splice(index, 1);
        sections.splice(target, 0, moved);
        return { ...p, sections };
      });
    },
    [updateProject]
  );

  // --- Handoff inbox: payloads queued by the Rhythm / Harmony engines ---
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const handoffAppliedRef = useRef(false);

  useEffect(() => {
    if (handoffAppliedRef.current || !project) return;
    handoffAppliedRef.current = true;
    const handoff = takeStudioHandoff();
    if (!handoff) return;

    if (handoff.type === 'groove') {
      updateProject(p => ({
        ...p,
        bpm: Math.min(200, Math.max(40, Math.round(handoff.bpm))),
        swing: Math.max(0, Math.min(0.5, handoff.swing)),
        rhythmId: handoff.rhythmId,
        grooveId: undefined
      }));
      setHandoffNotice(`Groove from the Rhythm Engine applied: ${handoff.label} at ${Math.round(handoff.bpm)} BPM.`);
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
      setHandoffNotice(`“${handoff.name}” from the Harmony Engine landed as a new section at the end of the song.`);
    }
    window.setTimeout(() => setHandoffNotice(null), 7000);
  }, [project, updateProject]);

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

  const addTrack = useCallback(
    (role: PerformerRole | { creature: SavedCreature } | { writtenLead: true }) => {
      if (!project) return;
      let track: SongTrack;
      if (typeof role === 'string') {
        track = makeTrackFromRole(role, grid);
      } else if ('creature' in role) {
        track = makeTrackFromCreature(role.creature);
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
              <p className="re-subtitle">Arrange your creatures into a full song · sections · clips · one timeline</p>
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
            <p className="re-subtitle">Arrange your creatures into a full song · sections · clips · one timeline</p>
          </div>
        </div>
        <div className="stage-links">
          <Link to={conservatoryPath('/stage') as never}>Ensemble Stage</Link>
          <Link to={conservatoryPath('/melody') as never}>Melody Engine</Link>
          <Link to={conservatoryPath('/harmony') as never}>Harmony Engine</Link>
        </div>
        <div className="re-status">
          <span className={`re-status-dot${audioReady ? ' on' : ''}`} />
          <span className={audioReady ? 're-status-text on' : 're-status-text'}>
            {isPlaying ? 'Song Rolling' : audioReady ? 'Studio Ready' : 'Studio Cold'}
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
        positionMeasure={playhead?.measure ?? null}
        positionSub={playhead?.sub ?? null}
        totalMeasures={flat.totalMeasures}
        rhythmLabel={`${rhythm.label}${resolution === 'sixteenth' ? ' · 16ths' : ''}`}
        grooveId={project.grooveId ?? ''}
        onGrooveSelect={applyGroove}
        onGrooveClear={() => updateProject(p => ({ ...p, grooveId: undefined }))}
        onPlay={() => void toggle()}
        onStop={handleStop}
        onBpmChange={bpm => updateProject(p => ({ ...p, bpm }))}
        onBpmNudge={delta => updateProject(p => ({ ...p, bpm: Math.min(200, Math.max(40, p.bpm + delta)) }))}
        onSwingChange={swing => updateProject(p => ({ ...p, swing }))}
        onLoopChange={setLoop}
      />

      {handoffNotice ? (
        <p className="st-handoff-note" role="status">
          {handoffNotice}
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
          <button type="button" className="re-secondary-btn" onClick={handleOpenWizard}>
            ✨ Wizard
          </button>
          <button type="button" className="re-secondary-btn" onClick={handleBlankSong}>
            + Blank
          </button>
          <button type="button" className="re-secondary-btn" onClick={handleDuplicate}>
            Duplicate
          </button>
          <button type="button" className="re-secondary-btn st-danger" onClick={handleDelete}>
            Delete
          </button>
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
          <input
            id="st-zoom"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={4}
            value={zoom}
            onChange={e => setZoom(parseInt(e.target.value, 10))}
          />
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
        loopRegion={loopRegion}
        selectedSectionId={selectedSectionId}
        selectedTrackId={selectedTrackId}
        selectedClipId={selectedClipId}
        onSeek={handleSeek}
        onSelectSection={id => {
          setSelectedSectionId(prev => (prev === id ? null : id));
          setChordEdit(null);
        }}
        onSelectTrack={setSelectedTrackId}
        onSelectClip={setSelectedClipId}
        onEditChord={handleEditChord}
        onClipsChange={clips => updateProject(p => ({ ...p, clips }))}
        onTrackChange={updateTrack}
        onRemoveTrack={removeTrack}
        onAddTrack={() => setAddTrackOpen(v => !v)}
      />

      {addTrackOpen ? (
        <div className="st-add-menu re-panel">
          <div className="re-panel-head">
            <div>
              <h3>Add a track</h3>
              <p>Core roles, extra organisms, or hire from your creature library</p>
            </div>
          </div>
          <div className="re-pills">
            {CORE_STUDIO_ROLES.map(role => (
              <button key={role} type="button" className="re-pill" onClick={() => addTrack(role)}>
                + {role === 'melody' ? 'lead' : role}
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
              <p>Identity, key seed, groove, master bus</p>
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
                Key (seeds new chords)
              </label>
              <select
                id="st-key"
                className="re-select"
                value={project.keyRoot}
                onChange={e => updateProject(p => ({ ...p, keyRoot: e.target.value as NoteName }))}
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
                Locomotion
              </label>
              <select
                id="st-rhythm"
                className="re-select"
                value={project.rhythmId}
                onChange={e => updateProject(p => ({ ...p, rhythmId: e.target.value }))}
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
              <p>{selectedSection ? `${selectedSection.name} · ${selectedSection.measures} measures` : 'Select a section block in the ruler'}</p>
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
                    Measures
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
                <span className="re-micro-label">Chord lane — tap to forge</span>
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
                <button type="button" className="re-pill" onClick={() => moveSection(selectedSection.id, -1)}>
                  ← Move
                </button>
                <button type="button" className="re-pill" onClick={() => moveSection(selectedSection.id, 1)}>
                  Move →
                </button>
                <button type="button" className="re-pill" onClick={() => addSectionAfter(selectedSection.id)}>
                  + Add after
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
              <p>{selectedTrack ? selectedTrack.name : 'Select a track header in the timeline'}</p>
            </div>
          </div>

          {selectedTrack ? (
            isDrumRole(selectedTrack.role) ? (
              <div className="re-stack-sm">
                <span className="re-micro-label">Step pattern · {subdivisions} {GRID_STEP_LABEL[resolution]}</span>
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
              </div>
            ) : (
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
              Click a track name to edit its creature: drum grids for the rhythm trio, voice / contour / register for
              the tonal performers.
            </p>
          )}
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
