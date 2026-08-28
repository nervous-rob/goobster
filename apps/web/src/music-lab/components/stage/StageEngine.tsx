import { Link } from '@tanstack/react-router';
import { conservatoryPath } from '@music-lab/lib/paths';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { NOTE_NAMES, type NoteName } from '@music-lab/lib/musicData';
import { PROGRESSION_PRESETS } from '@music-lab/lib/harmonyData';
import {
  buildHarmonyGenome,
  buildPresetProgression,
  classifyOrganism,
  type FoundrySettings,
  type HarmonyGenome
} from '@music-lab/lib/harmonyTheory';
import { RHYTHMS } from '@music-lab/lib/rhythmData';
import { useRhythmOptions } from '@music-lab/hooks/useRhythmOptions';
import { GRID_STEP_LABEL, gridGrouping, totalSubdivisions, type GridResolution } from '@music-lab/lib/rhythmTheory';
import { findLibraryDrumPattern, stretchDrumSteps, type LibraryGroove } from '@music-lab/lib/genreLibrary';
import { buildMelodyLane } from '@music-lab/lib/melodyTheory';
import { VOICE_PRESETS, findVoice } from '@music-lab/lib/voiceData';
import {
  CORE_IDS,
  CREATURE_LIBRARY_KEY,
  MELODY_BASE_OCTAVE,
  addChordOrganism,
  findContour,
  hireCreature,
  isDrumRole,
  makeDefaultCast,
  performerName,
  seedDrumPattern,
  strongSubIndices,
  type PerformerRole,
  type PerformerState,
  type SavedCreature
} from '@music-lab/lib/stageData';
import { useLocalStorage } from '@music-lab/hooks/useLocalStorage';
import { useStageOrchestrator, type StagePerformerTrack } from '@music-lab/hooks/useStageOrchestrator';
import {
  createStageScene,
  renderStageScene,
  triggerStageCreature,
  SW,
  SH,
  type StagePerformerVisual
} from './stageSceneRenderer';
import { PerformerCard } from './PerformerCard';
import { StageTransport } from './StageTransport';
import { ChordSlotEditor } from './ChordSlotEditor';
import { GroovePicker } from '@music-lab/components/shared/GroovePicker';

function IconStage() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 18h16M6 18V8l6-4 6 4v10" />
      <path d="M9 13h6M9 10h6" />
    </svg>
  );
}

interface MasterSettings {
  volume: number;
  reverbWet: number;
}

interface EditorTarget {
  /** 'song' edits the shared lane; otherwise a chord organism's performer id. */
  target: 'song' | string;
  index: number;
}

function extractFoundry(genome: HarmonyGenome): FoundrySettings {
  return {
    root: genome.root,
    quality: genome.quality,
    extension: genome.extension,
    inversion: genome.inversion,
    voicing: genome.voicing,
    register: genome.register
  };
}

const MAX_SONG_SLOTS = 8;
const MIN_SONG_SLOTS = 2;

export function StageEngine() {
  const [bpm, setBpm] = useLocalStorage<number>('stageBpm', 100);
  const [swing, setSwing] = useLocalStorage<number>('stageSwing', 0);
  const [loop, setLoop] = useLocalStorage<boolean>('stageLoop', true);
  const [rhythmId, setRhythmId] = useLocalStorage<string>('stageRhythmId', '4-4');
  const [resolution, setResolution] = useLocalStorage<GridResolution>('stageResolution', 'eighth');
  const [grooveId, setGrooveId] = useLocalStorage<string>('stageGrooveId', '');
  /** 0 = off, -1 = last bar of the phrase, otherwise every N bars. */
  const [fillEvery, setFillEvery] = useLocalStorage<number>('stageFillEvery', 0);
  const [fillLong, setFillLong] = useLocalStorage<boolean>('stageFillLong', false);
  const [presetId, setPresetId] = useLocalStorage<string>('stagePresetId', 'axis');
  const [keyRoot, setKeyRoot] = useLocalStorage<NoteName>('stageKeyRoot', 'C');
  const [harmonyHold, setHarmonyHold] = useLocalStorage<number>('stageHarmonyHold', 0.96);
  const [measuresPerChord, setMeasuresPerChord] = useLocalStorage<number>('stageMeasuresPerChord', 1);
  const [master, setMaster] = useLocalStorage<MasterSettings>('stageMaster', { volume: -2, reverbWet: 0.28 });
  const [castRaw, setCastRaw] = useLocalStorage<PerformerState[]>('stageCast', makeDefaultCast([2, 2, 2, 2]));
  const [songChords, setSongChords] = useLocalStorage<FoundrySettings[]>('stageSongChords', []);
  const [library] = useLocalStorage<SavedCreature[]>(CREATURE_LIBRARY_KEY, []);

  const [activeHarmonyStep, setActiveHarmonyStep] = useState<number | null>(null);
  const [activeMeasure, setActiveMeasure] = useState<number | null>(null);
  const [activeSubIndex, setActiveSubIndex] = useState<number | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [hireOpen, setHireOpen] = useState(false);

  const { audioReady, isPlaying, setConfig, setCallbacks, stop, toggle } = useStageOrchestrator();

  const { rhythms, findRhythm } = useRhythmOptions();
  const rhythm = useMemo(() => findRhythm(rhythmId), [findRhythm, rhythmId]);
  /** Grouping scaled to the grid resolution — the source of truth for all step math. */
  const grid = useMemo(() => gridGrouping(rhythm.grouping, resolution), [rhythm.grouping, resolution]);
  const subdivisions = useMemo(() => totalSubdivisions(grid), [grid]);
  const strongSubs = useMemo(() => strongSubIndices(grid), [grid]);

  // --- Cast: merge stored entries with core defaults, keep hired extras ---
  const cast = useMemo<PerformerState[]>(() => {
    const defaults = makeDefaultCast(grid);
    const migrated = castRaw.map(p => ({ ...p, id: p.id ?? p.role }));
    const merged: PerformerState[] = defaults.map(def => {
      const stored = migrated.find(p => p.id === def.id);
      if (!stored) return def;
      const next = { ...def, ...stored };
      if (isDrumRole(next.role) && next.drumSteps?.length !== subdivisions) {
        next.drumSteps = seedDrumPattern(next.role, grid);
      }
      return next;
    });
    migrated.forEach(p => {
      if (!CORE_IDS.has(p.id)) merged.push(p);
    });
    return merged;
  }, [castRaw, grid, subdivisions]);

  // --- Shared song lane (seeded from preset, slot-editable) ---
  const preset = useMemo(
    () => PROGRESSION_PRESETS.find(p => p.id === presetId) ?? PROGRESSION_PRESETS[0],
    [presetId]
  );

  const seedSongChords = useCallback(
    (nextPresetId: string, nextKey: NoteName): FoundrySettings[] => {
      const p = PROGRESSION_PRESETS.find(x => x.id === nextPresetId) ?? PROGRESSION_PRESETS[0];
      return buildPresetProgression(p, nextKey).map(step => extractFoundry(step.genome));
    },
    []
  );

  const effectiveSong = useMemo<FoundrySettings[]>(
    () => (songChords.length ? songChords : seedSongChords(presetId, keyRoot)),
    [songChords, seedSongChords, presetId, keyRoot]
  );

  const songGenomes = useMemo(() => effectiveSong.map(buildHarmonyGenome), [effectiveSong]);
  const chordCount = songGenomes.length;
  const phraseLength = chordCount * measuresPerChord;

  const handlePresetChange = useCallback(
    (id: string) => {
      setPresetId(id);
      setSongChords(seedSongChords(id, keyRoot));
      setEditor(null);
    },
    [keyRoot, seedSongChords, setPresetId, setSongChords]
  );

  const handleKeyChange = useCallback(
    (root: NoteName) => {
      setKeyRoot(root);
      setSongChords(seedSongChords(presetId, root));
      setEditor(null);
    },
    [presetId, seedSongChords, setKeyRoot, setSongChords]
  );

  const updateSongSlot = useCallback(
    (index: number, settings: FoundrySettings) => {
      setSongChords(() => effectiveSong.map((slot, i) => (i === index ? settings : slot)));
    },
    [effectiveSong, setSongChords]
  );

  const addSongSlot = useCallback(() => {
    if (effectiveSong.length >= MAX_SONG_SLOTS) return;
    const last = effectiveSong[effectiveSong.length - 1];
    setSongChords(() => [...effectiveSong, { ...last }]);
  }, [effectiveSong, setSongChords]);

  const removeSongSlot = useCallback(
    (index: number) => {
      if (effectiveSong.length <= MIN_SONG_SLOTS) return;
      setSongChords(() => effectiveSong.filter((_, i) => i !== index));
      setEditor(null);
    },
    [effectiveSong, setSongChords]
  );

  // --- Grooves: one tap sets feel + reseeds the drum trio ---
  const applyGroove = useCallback(
    (groove: LibraryGroove) => {
      const nextRhythm = RHYTHMS.find(r => r.id === groove.rhythmId) ?? RHYTHMS[0];
      const nextGrid = gridGrouping(nextRhythm.grouping, groove.resolution);
      const pattern = findLibraryDrumPattern(groove.drumPatternId);

      setGrooveId(groove.id);
      setBpm(groove.bpm);
      setSwing(groove.swing);
      setRhythmId(groove.rhythmId);
      setResolution(groove.resolution);
      if (pattern) {
        setCastRaw(() =>
          cast.map(p =>
            isDrumRole(p.role) ? { ...p, drumSteps: stretchDrumSteps(pattern.steps[p.role], nextGrid) } : p
          )
        );
      }
    },
    [cast, setBpm, setCastRaw, setGrooveId, setResolution, setRhythmId, setSwing]
  );

  const handleResolutionChange = useCallback(
    (next: GridResolution) => {
      setResolution(next);
      setGrooveId('');
    },
    [setGrooveId, setResolution]
  );

  // --- Performer updates ---
  const updatePerformer = useCallback(
    (id: string, partial: Partial<PerformerState>) => {
      setCastRaw(() =>
        cast.map(p => {
          if (p.id !== id) return p;
          const next = { ...p, ...partial };
          // Switching to a private lane seeds it from the current song.
          if (partial.harmonyMode === 'own' && !next.customChords?.length) {
            next.customChords = effectiveSong.map(s => ({ ...s }));
          }
          return next;
        })
      );
    },
    [cast, effectiveSong, setCastRaw]
  );

  const handleAddOrganism = useCallback(() => {
    const usedVoices = cast.filter(p => p.role === 'chords').map(p => p.voiceId);
    const nextVoice = VOICE_PRESETS.find(v => !usedVoices.includes(v.id)) ?? VOICE_PRESETS[0];
    setCastRaw(() => [...cast, addChordOrganism(cast.map(p => p.id), nextVoice.id)]);
  }, [cast, setCastRaw]);

  const handleHire = useCallback(
    (saved: SavedCreature) => {
      setCastRaw(() => [...cast, hireCreature(saved, cast.map(p => p.id))]);
      setHireOpen(false);
    },
    [cast, setCastRaw]
  );

  const handleRemovePerformer = useCallback(
    (id: string) => {
      setCastRaw(() => cast.filter(p => p.id !== id));
      setEditor(e => (e && e.target === id ? null : e));
    },
    [cast, setCastRaw]
  );

  // --- Chord lanes per organism ---
  const organismLanes = useMemo(() => {
    const map = new Map<string, HarmonyGenome[]>();
    cast.forEach(p => {
      if (p.role !== 'chords') return;
      if (p.harmonyMode === 'own' && p.customChords?.length) {
        map.set(p.id, p.customChords.map(buildHarmonyGenome));
      } else {
        map.set(
          p.id,
          effectiveSong.map(s =>
            buildHarmonyGenome({
              ...s,
              voicing: p.voicingOverride ?? s.voicing,
              register: p.registerOverride ?? s.register
            })
          )
        );
      }
    });
    return map;
  }, [cast, effectiveSong]);

  // --- Orchestrator tracks ---
  const performerTracks = useMemo<StagePerformerTrack[]>(
    () =>
      cast.map(p => {
        const base = {
          id: p.id,
          role: p.role,
          enabled: p.enabled,
          mute: p.mute,
          volume: p.volume,
          voiceId: p.voiceId
        };
        if (isDrumRole(p.role)) {
          return { ...base, drumSteps: p.drumSteps };
        }
        if (p.role === 'chords') {
          return { ...base, chordSteps: (organismLanes.get(p.id) ?? []).map(g => g.midi) };
        }
        const lane = buildMelodyLane(
          findContour(p.contourId).steps,
          songGenomes,
          measuresPerChord,
          subdivisions,
          MELODY_BASE_OCTAVE[p.role] + (p.octaveShift ?? 0)
        );
        return { ...base, melodyNotes: lane };
      }),
    [cast, organismLanes, songGenomes, measuresPerChord, subdivisions]
  );

  // --- Stage scene canvas ---
  const stageGenome = useMemo(() => {
    const index = activeHarmonyStep ?? 0;
    return songGenomes[index % Math.max(1, songGenomes.length)] ?? null;
  }, [activeHarmonyStep, songGenomes]);

  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef(createStageScene());
  const visRef = useRef({ scale: 1, lastTime: 0, t: 0 });

  const roleByIdRef = useRef<Map<string, PerformerRole>>(new Map());
  roleByIdRef.current = new Map(cast.map(p => [p.id, p.role]));

  const visualsRef = useRef<StagePerformerVisual[]>([]);
  visualsRef.current = cast.map(p => {
    const lane = p.role === 'chords' ? organismLanes.get(p.id) : undefined;
    const laneIndex = (activeHarmonyStep ?? 0) % Math.max(1, lane?.length ?? 1);
    return {
      id: p.id,
      role: p.role,
      enabled: p.enabled,
      mute: p.mute,
      label: performerName(p),
      hue: isDrumRole(p.role) ? undefined : findVoice(p.voiceId).hue,
      ribs: lane ? lane[laneIndex]?.midi.length ?? 3 : undefined
    };
  });

  const resizeCanvas = useCallback(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = cv.clientWidth || SW;
    const cssH = (cssW * SH) / SW;
    cv.style.height = `${cssH}px`;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    visRef.current.scale = (cssW / SW) * dpr;
  }, []);

  useEffect(() => {
    let raf = 0;
    resizeCanvas();
    const onResize = () => resizeCanvas();
    window.addEventListener('resize', onResize);

    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      const v = visRef.current;
      if (!v.lastTime) v.lastTime = ts;
      let dt = (ts - v.lastTime) / 1000;
      v.lastTime = ts;
      if (dt > 0.05) dt = 0.05;
      v.t += dt;

      const ctx = cvRef.current?.getContext('2d');
      if (ctx) {
        ctx.setTransform(v.scale, 0, 0, v.scale, 0, 0);
        ctx.clearRect(0, 0, SW, SH);
        renderStageScene(ctx, sceneRef.current, visualsRef.current, v.t, dt);
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [resizeCanvas]);

  useEffect(() => {
    setCallbacks({
      onRhythmStep: step => {
        setActiveMeasure(step.measure);
        setActiveSubIndex(step.subIndex);
      },
      onHarmonyStep: index => {
        setActiveHarmonyStep(index);
      },
      onTrigger: (id, intensity, midi) => {
        const role = roleByIdRef.current.get(id) ?? 'melody';
        triggerStageCreature(sceneRef.current, id, role, intensity, midi);
      },
      onPlayState: playing => {
        if (!playing) {
          setActiveHarmonyStep(null);
          setActiveMeasure(null);
          setActiveSubIndex(null);
        }
      }
    });
  }, [setCallbacks]);

  // --- Automatic drum fills ---
  const fillMeasures = useMemo(() => {
    if (!fillEvery || phraseLength <= 0) return undefined;
    return Array.from({ length: phraseLength }, (_, m) =>
      fillEvery === -1 ? m === phraseLength - 1 : (m + 1) % fillEvery === 0
    );
  }, [fillEvery, phraseLength]);

  const fillLengthSubs = useMemo(
    () => (fillEvery ? Math.max(2, Math.round(subdivisions * (fillLong ? 0.5 : 0.25))) : 0),
    [fillEvery, fillLong, subdivisions]
  );

  useEffect(() => {
    setConfig({
      bpm,
      swing,
      grouping: grid,
      resolution,
      phraseLength,
      measuresPerChord,
      harmonyHold,
      fillMeasures,
      fillLengthSubs,
      loop,
      masterVolume: master.volume,
      reverbWet: master.reverbWet,
      performers: performerTracks
    });
  }, [
    bpm,
    swing,
    grid,
    resolution,
    phraseLength,
    measuresPerChord,
    harmonyHold,
    fillMeasures,
    fillLengthSubs,
    loop,
    master,
    performerTracks,
    setConfig
  ]);

  const organismLabel = stageGenome ? classifyOrganism(stageGenome) : 'Waiting for harmony…';

  const lamps = useMemo(() => {
    const out: { index: number; sideLabel: string | null }[] = [];
    let idx = 0;
    let side = 0;
    grid.forEach(groupSize => {
      for (let i = 0; i < groupSize; i++) {
        out.push({ index: idx, sideLabel: i === 0 ? (side === 0 ? 'L' : 'R') : null });
        idx++;
      }
      side = side === 0 ? 1 : 0;
    });
    return out;
  }, [grid]);

  const onStageCount = cast.filter(p => p.enabled).length;

  // --- Chord editor wiring ---
  const editorValue: FoundrySettings | null = useMemo(() => {
    if (!editor) return null;
    if (editor.target === 'song') return effectiveSong[editor.index] ?? null;
    const p = cast.find(x => x.id === editor.target);
    return p?.customChords?.[editor.index] ?? null;
  }, [editor, effectiveSong, cast]);

  const editorTitle = useMemo(() => {
    if (!editor) return '';
    if (editor.target === 'song') return `Song chord ${editor.index + 1}`;
    const p = cast.find(x => x.id === editor.target);
    return `${p ? performerName(p) : 'Organism'} · chord ${editor.index + 1}`;
  }, [editor, cast]);

  const handleEditorChange = useCallback(
    (settings: FoundrySettings) => {
      if (!editor) return;
      if (editor.target === 'song') {
        updateSongSlot(editor.index, settings);
        return;
      }
      const p = cast.find(x => x.id === editor.target);
      if (!p?.customChords) return;
      updatePerformer(editor.target, {
        customChords: p.customChords.map((slot, i) => (i === editor.index ? settings : slot))
      });
    },
    [editor, cast, updateSongSlot, updatePerformer]
  );

  return (
    <section className="rhythm-engine stage-engine">
      <header className="re-header">
        <div className="re-brand">
          <span className="re-brand-icon">
            <IconStage />
          </span>
          <div>
            <h2 className="re-title">
              Ensemble Stage <span className="re-accent-text">TROUPE</span>
            </h2>
            <p className="re-subtitle">A composable creature band · one transport · your song</p>
          </div>
        </div>
        <div className="stage-links">
          <Link to={conservatoryPath('/rhythm') as never}>Rhythm Engine</Link>
          <Link to={conservatoryPath('/harmony') as never}>Harmony Engine</Link>
          <Link to={conservatoryPath('/melody') as never}>Melody Engine</Link>
        </div>
        <div className="re-status">
          <span className={`re-status-dot${audioReady ? ' on' : ''}`} />
          <span className={audioReady ? 're-status-text on' : 're-status-text'}>
            {isPlaying ? 'Troupe Performing' : audioReady ? 'Troupe Ready' : 'Stage Cold'}
          </span>
        </div>
      </header>

      <StageTransport
        isPlaying={isPlaying}
        audioReady={audioReady}
        bpm={bpm}
        swing={swing}
        loop={loop}
        rhythmLabel={rhythm.label}
        phraseLength={phraseLength}
        chordCount={chordCount}
        measuresPerChord={measuresPerChord}
        transportMeasure={activeMeasure}
        transportSub={activeSubIndex !== null ? activeSubIndex + 1 : null}
        onPlay={() => void toggle()}
        onStop={stop}
        onBpmChange={setBpm}
        onBpmNudge={delta => setBpm(v => Math.min(200, Math.max(40, v + delta)))}
        onSwingChange={setSwing}
        onLoopChange={setLoop}
      />

      <div className="re-grid">
        <div className="re-col-left re-stack">
          <div className="re-panel re-stack stage-master-panel">
            <div className="re-panel-head">
              <div>
                <h3>Song and Master</h3>
                <p>Key, gravity path, groove blueprint</p>
              </div>
            </div>

            <div className="he-row-2">
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="stage-key">
                  Key center
                </label>
                <select
                  id="stage-key"
                  className="re-select"
                  value={keyRoot}
                  onChange={e => handleKeyChange(e.target.value as NoteName)}
                >
                  {NOTE_NAMES.map(n => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="stage-preset">
                  Gravity path
                </label>
                <select
                  id="stage-preset"
                  className="re-select"
                  value={presetId}
                  onChange={e => handlePresetChange(e.target.value)}
                >
                  {PROGRESSION_PRESETS.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="re-stack-sm">
              <label className="re-micro-label" htmlFor="stage-groove">
                Groove preset
              </label>
              <GroovePicker
                id="stage-groove"
                value={grooveId}
                onSelect={applyGroove}
                onClear={() => setGrooveId('')}
              />
            </div>

            <div className="re-stack-sm">
              <label className="re-micro-label" htmlFor="stage-rhythm">
                Locomotion pattern
              </label>
              <select
                id="stage-rhythm"
                className="re-select"
                value={rhythmId}
                onChange={e => {
                  setRhythmId(e.target.value);
                  setGrooveId('');
                }}
              >
                {rhythms.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.label} · {r.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="stage-arrange">
              <span className="re-micro-label">Grid resolution</span>
              <div className="re-pills">
                {(['eighth', 'sixteenth'] as GridResolution[]).map(r => (
                  <button
                    key={r}
                    type="button"
                    className={`re-pill${resolution === r ? ' on' : ''}`}
                    onClick={() => handleResolutionChange(r)}
                    title={r === 'sixteenth' ? 'Twice the grid steps — funk pockets, trap hats, double kick' : 'Classic eighth-note grid'}
                  >
                    {r === 'eighth' ? 'Eighths' : 'Sixteenths'}
                  </button>
                ))}
              </div>
            </div>

            <div className="stage-arrange">
              <span className="re-micro-label">Drum fills</span>
              <div className="re-pills">
                {([
                  { value: 0, label: 'Off' },
                  { value: 2, label: 'Every 2' },
                  { value: 4, label: 'Every 4' },
                  { value: -1, label: 'Phrase end' }
                ] as const).map(option => (
                  <button
                    key={option.value}
                    type="button"
                    className={`re-pill${fillEvery === option.value ? ' on' : ''}`}
                    onClick={() => setFillEvery(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {fillEvery !== 0 ? (
                <div className="re-pills">
                  {([false, true] as const).map(long => (
                    <button
                      key={String(long)}
                      type="button"
                      className={`re-pill${fillLong === long ? ' on' : ''}`}
                      onClick={() => setFillLong(long)}
                    >
                      {long ? '½ bar fill' : '¼ bar fill'}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="stage-arrange">
              <span className="re-micro-label">Measures per chord</span>
              <div className="re-pills">
                {[1, 2, 4].map(n => (
                  <button
                    key={n}
                    type="button"
                    className={`re-pill${measuresPerChord === n ? ' on' : ''}`}
                    onClick={() => setMeasuresPerChord(n)}
                  >
                    {n} bar{n > 1 ? 's' : ''}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="re-slider-head sm">
                <label htmlFor="stage-hold">Chord hold</label>
                <span className="re-slider-val sm">{Math.round(harmonyHold * 100)}%</span>
              </div>
              <input
                id="stage-hold"
                type="range"
                min={0.4}
                max={1}
                step={0.01}
                value={harmonyHold}
                onChange={e => setHarmonyHold(parseFloat(e.target.value))}
              />
            </div>

            <div>
              <div className="re-slider-head sm">
                <label htmlFor="stage-master-vol">Master</label>
                <span className="re-slider-val sm">{master.volume} dB</span>
              </div>
              <input
                id="stage-master-vol"
                type="range"
                min={-24}
                max={0}
                step={1}
                value={master.volume}
                onChange={e => setMaster(m => ({ ...m, volume: parseInt(e.target.value, 10) }))}
              />
            </div>
            <div>
              <div className="re-slider-head sm">
                <label htmlFor="stage-reverb">Reverb send</label>
                <span className="re-slider-val sm">{Math.round(master.reverbWet * 100)}%</span>
              </div>
              <input
                id="stage-reverb"
                type="range"
                min={0}
                max={0.6}
                step={0.01}
                value={master.reverbWet}
                onChange={e => setMaster(m => ({ ...m, reverbWet: parseFloat(e.target.value) }))}
              />
            </div>
          </div>

          <div className="stage-roster">
            {cast.map(performer => (
              <PerformerCard
                key={performer.id}
                performer={performer}
                subdivisions={subdivisions}
                strongSubs={strongSubs}
                onChange={partial => updatePerformer(performer.id, partial)}
                onRemove={CORE_IDS.has(performer.id) ? undefined : () => handleRemovePerformer(performer.id)}
                onEditOwnChord={
                  performer.role === 'chords'
                    ? index => setEditor({ target: performer.id, index })
                    : undefined
                }
              />
            ))}

            <div className="stage-add-panel re-panel">
              <button type="button" className="re-secondary-btn" onClick={handleAddOrganism}>
                + Add chord organism
              </button>
              <button
                type="button"
                className="re-secondary-btn"
                onClick={() => setHireOpen(v => !v)}
                aria-expanded={hireOpen}
              >
                {hireOpen ? 'Close library' : `Hire from library (${library.length})`}
              </button>
              {hireOpen ? (
                library.length ? (
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
                        <button type="button" className="stage-perf-btn on" onClick={() => handleHire(saved)}>
                          Hire
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="stage-perf-flavor">
                    No saved creatures yet — build one in the <Link to={conservatoryPath('/melody') as never}>Melody Engine</Link>.
                  </p>
                )
              ) : null}
            </div>
          </div>
        </div>

        <div className="re-col-right re-stack">
          <div className="stage-floor">
            <div className="stage-chrome">
              <div>
                <div className="stage-chrome-label">Current chord</div>
                <div className="stage-chrome-value">{stageGenome?.name ?? '—'}</div>
                <div className="stage-chrome-sub">{organismLabel}</div>
              </div>
              <div>
                <div className="stage-chrome-label">Troupe</div>
                <div className="stage-chrome-value">{onStageCount} / {cast.length} on stage</div>
                <div className="stage-chrome-sub">
                  {preset.name} in {keyRoot}
                </div>
              </div>
              <div>
                <div className="stage-chrome-label">Playhead</div>
                <div className="stage-chrome-value">
                  {activeMeasure ?? '—'}
                  {activeSubIndex !== null ? `.${activeSubIndex + 1}` : ''}
                </div>
                <div className="stage-chrome-sub">
                  {isPlaying ? 'Rolling' : 'Stopped'} · {rhythm.label}
                </div>
              </div>
            </div>

            <div className="re-canvas-main he-canvas-main">
              <canvas ref={cvRef} className="re-canvas" aria-label="Creature troupe performing on stage" />
            </div>

            <div className="stage-lamps-wrap">
              <div className="stage-lamps-head">
                <span>Subdivision grid</span>
                <span>
                  {subdivisions} {GRID_STEP_LABEL[resolution]} · {rhythm.label}
                </span>
              </div>
              <div className="re-lamps">
                {lamps.map(lamp => {
                  const isActive = isPlaying && activeSubIndex === lamp.index;
                  return (
                    <div key={lamp.index} className={`re-lamp${isActive ? ' active' : ''}`}>
                      <div className="re-lamp-n">{lamp.index + 1}</div>
                      <div className={`re-lamp-lab${lamp.sideLabel ? '' : ' blank'}`}>{lamp.sideLabel ?? '·'}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="stage-timeline-wrap">
              <div className="stage-lamps-head">
                <span>Song lane — tap a chord to forge it</span>
                <button
                  type="button"
                  className="stage-perf-btn"
                  onClick={addSongSlot}
                  disabled={effectiveSong.length >= MAX_SONG_SLOTS}
                  title="Add chord slot"
                >
                  +
                </button>
              </div>
              <div
                className="stage-timeline"
                style={{ '--stage-measures': phraseLength } as CSSProperties}
                aria-label="Phrase timeline"
              >
                {songGenomes.map((genome, chordIndex) => {
                  const isHarmonyActive = activeHarmonyStep === chordIndex;
                  const isEditing = editor?.target === 'song' && editor.index === chordIndex;
                  const measureStart = chordIndex * measuresPerChord + 1;
                  const measureEnd = measureStart + measuresPerChord - 1;
                  const isRhythmMeasure =
                    isPlaying &&
                    activeMeasure !== null &&
                    activeMeasure >= measureStart &&
                    activeMeasure <= measureEnd;

                  return (
                    <button
                      key={`${genome.id}-${chordIndex}`}
                      type="button"
                      className={`stage-measure${isHarmonyActive ? ' active' : ''}${isRhythmMeasure ? ' rhythm-hit' : ''}${isEditing ? ' editing' : ''}`}
                      style={{ gridColumn: `span ${measuresPerChord}` }}
                      onClick={() => setEditor({ target: 'song', index: chordIndex })}
                    >
                      <span className="stage-measure-num">
                        Bars {measureStart}
                        {measuresPerChord > 1 ? `–${measureEnd}` : ''}
                      </span>
                      <span className="stage-measure-chord">{genome.name}</span>
                      <span className="stage-measure-word">{genome.noteNames.join(' ')}</span>
                      <span className="stage-measure-fn">
                        {genome.voicing} · {genome.register}
                      </span>
                    </button>
                  );
                })}
              </div>

              {editor && editorValue ? (
                <ChordSlotEditor
                  title={editorTitle}
                  value={editorValue}
                  onChange={handleEditorChange}
                  onClose={() => setEditor(null)}
                  onRemove={
                    editor.target === 'song' && effectiveSong.length > MIN_SONG_SLOTS
                      ? () => removeSongSlot(editor.index)
                      : undefined
                  }
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
