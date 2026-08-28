import { Link } from '@tanstack/react-router';
import { conservatoryPath } from '@music-lab/lib/paths';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NOTE_NAMES, type NoteName } from '@music-lab/lib/musicData';
import { PROGRESSION_PRESETS } from '@music-lab/lib/harmonyData';
import { buildPresetProgression } from '@music-lab/lib/harmonyTheory';
import { buildMelodyLane } from '@music-lab/lib/melodyTheory';
import { findVoice } from '@music-lab/lib/voiceData';
import { useVoiceLibrary } from '@music-lab/hooks/useVoiceLibrary';
import { useContourLibrary } from '@music-lab/hooks/useContourLibrary';
import { VoiceBuilder } from '@music-lab/components/shared/VoiceBuilder';
import { ContourDesigner } from '@music-lab/components/shared/ContourDesigner';
import {
  CREATURE_LIBRARY_KEY,
  MELODY_BASE_OCTAVE,
  findContour,
  makeCreatureId,
  type CreatureKind,
  type PerformerRole,
  type SavedCreature
} from '@music-lab/lib/stageData';
import { useLocalStorage } from '@music-lab/hooks/useLocalStorage';
import { useStageOrchestrator, type StagePerformerTrack } from '@music-lab/hooks/useStageOrchestrator';
import { EngineSwitch } from '@music-lab/components/shared/EngineSwitch';
import {
  createStageScene,
  renderStageScene,
  triggerStageCreature,
  SW,
  SH,
  type StagePerformerVisual
} from '@music-lab/components/stage/stageSceneRenderer';

function IconPlay() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 1.6v12.8c0 .9 1 1.4 1.7 1L15 8.9c.7-.4.7-1.4 0-1.8L4.7.6C4 .2 3 .7 3 1.6z" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <rect x="1" y="1" width="12" height="12" rx="2" />
    </svg>
  );
}

function IconWisp() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="14" cy="8" r="4" />
      <path d="M10.5 10.5C8 13 5 14 2 13.5c1.5 2.5 4.5 4 7.5 3.2" />
      <path d="M14 12c0 4-2 7-5 9" />
    </svg>
  );
}

const AUDITION_GROUPING = [2, 2, 2, 2];
const AUDITION_SUBDIVISIONS = 8;

export function MelodyEngine() {
  // --- Builder draft ---
  const [name, setName] = useLocalStorage<string>('melodyDraftName', '');
  const [kind, setKind] = useLocalStorage<CreatureKind>('melodyDraftKind', 'lead');
  const [voiceId, setVoiceId] = useLocalStorage<string>('melodyDraftVoice', 'glass-pad');
  const [contourId, setContourId] = useLocalStorage<string>('melodyDraftContour', 'arpeggio-rise');
  const [octaveShift, setOctaveShift] = useLocalStorage<number>('melodyDraftOctave', 0);

  // --- Audition context ---
  const [keyRoot, setKeyRoot] = useLocalStorage<NoteName>('melodyKeyRoot', 'C');
  const [presetId, setPresetId] = useLocalStorage<string>('melodyPresetId', 'axis');
  const [bpm, setBpm] = useLocalStorage<number>('melodyBpm', 96);
  const [chordsAudible, setChordsAudible] = useLocalStorage<boolean>('melodyChordsAudible', true);

  // --- Library ---
  const [library, setLibrary] = useLocalStorage<SavedCreature[]>(CREATURE_LIBRARY_KEY, []);

  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  const { allVoices } = useVoiceLibrary();
  const { allContours } = useContourLibrary();
  const { audioReady, isPlaying, setConfig, setCallbacks, stop, toggle } = useStageOrchestrator();

  const voice = findVoice(voiceId);
  const contour = findContour(contourId);
  const role: PerformerRole = kind === 'bass' ? 'bass' : 'melody';
  const defaultName = `${voice.name} ${kind === 'bass' ? 'Serpent' : 'Wisp'}`;

  const preset = useMemo(
    () => PROGRESSION_PRESETS.find(p => p.id === presetId) ?? PROGRESSION_PRESETS[0],
    [presetId]
  );
  const genomes = useMemo(
    () => buildPresetProgression(preset, keyRoot).map(s => s.genome),
    [preset, keyRoot]
  );

  const draftLane = useMemo(
    () =>
      buildMelodyLane(
        contour.steps,
        genomes,
        1,
        AUDITION_SUBDIVISIONS,
        MELODY_BASE_OCTAVE[role] + octaveShift
      ),
    [contour, genomes, role, octaveShift]
  );

  const performerTracks = useMemo<StagePerformerTrack[]>(
    () => [
      {
        id: 'audition-chords',
        role: 'chords',
        enabled: chordsAudible,
        mute: false,
        volume: -16,
        voiceId: 'glass-pad',
        chordSteps: genomes.map(g => g.midi)
      },
      {
        id: 'draft',
        role,
        enabled: true,
        mute: false,
        volume: -5,
        voiceId,
        melodyNotes: draftLane
      }
    ],
    [chordsAudible, genomes, role, voiceId, draftLane]
  );

  useEffect(() => {
    setConfig({
      bpm,
      swing: 0,
      grouping: AUDITION_GROUPING,
      phraseLength: genomes.length,
      measuresPerChord: 1,
      harmonyHold: 0.96,
      loop: true,
      masterVolume: -2,
      reverbWet: 0.3,
      performers: performerTracks
    });
  }, [bpm, genomes.length, performerTracks, setConfig]);

  // --- Preview canvas ---
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef(createStageScene());
  const visRef = useRef({ scale: 1, lastTime: 0, t: 0 });

  const visualsRef = useRef<StagePerformerVisual[]>([]);
  visualsRef.current = [
    {
      id: 'audition-chords',
      role: 'chords',
      enabled: chordsAudible,
      mute: false,
      label: 'House Organism',
      hue: findVoice('glass-pad').hue,
      ribs: genomes[0]?.midi.length ?? 3
    },
    {
      id: 'draft',
      role,
      enabled: true,
      mute: false,
      label: name.trim() || defaultName,
      hue: voice.hue
    }
  ];

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

  const roleRef = useRef<PerformerRole>(role);
  roleRef.current = role;

  useEffect(() => {
    setCallbacks({
      onTrigger: (id, intensity, midi) => {
        const triggerRole: PerformerRole = id === 'audition-chords' ? 'chords' : roleRef.current;
        triggerStageCreature(sceneRef.current, id, triggerRole, intensity, midi);
      }
    });
  }, [setCallbacks]);

  // --- Library actions ---
  const handleSave = useCallback(() => {
    const creature: SavedCreature = {
      id: makeCreatureId(),
      name: name.trim() || defaultName,
      kind,
      voiceId,
      contourId,
      octaveShift
    };
    setLibrary(prev => [...prev, creature]);
    setSavedFlash(creature.name);
    window.setTimeout(() => setSavedFlash(null), 2400);
  }, [name, defaultName, kind, voiceId, contourId, octaveShift, setLibrary]);

  const handleLoad = useCallback(
    (saved: SavedCreature) => {
      setName(saved.name);
      setKind(saved.kind);
      setVoiceId(saved.voiceId);
      setContourId(saved.contourId);
      setOctaveShift(saved.octaveShift);
    },
    [setName, setKind, setVoiceId, setContourId, setOctaveShift]
  );

  const handleDelete = useCallback(
    (id: string) => {
      setLibrary(prev => prev.filter(c => c.id !== id));
    },
    [setLibrary]
  );

  return (
    <section className="rhythm-engine stage-engine melody-engine">
      <header className="re-header">
        <div className="re-brand">
          <span className="re-brand-icon">
            <IconWisp />
          </span>
          <div>
            <h2 className="re-title">
              Melody Engine <span className="re-accent-text">HATCHERY</span>
            </h2>
            <p className="re-subtitle">Breed single-note creatures · audition · store for the Stage</p>
          </div>
        </div>
        <EngineSwitch active="melody" />
        <div className="re-status">
          <span className={`re-status-dot${audioReady ? ' on' : ''}`} />
          <span className={audioReady ? 're-status-text on' : 're-status-text'}>
            {isPlaying ? 'Auditioning' : audioReady ? 'Hatchery Ready' : 'Hatchery Cold'}
          </span>
        </div>
      </header>

      <div className="re-grid">
        <div className="re-col-left re-stack">
          <div className="re-panel re-stack">
            <div className="re-panel-head">
              <div>
                <h3>Creature Builder</h3>
                <p>Shape its voice, contour and register</p>
              </div>
            </div>

            <div className="re-stack-sm">
              <label className="re-micro-label" htmlFor="me-name">
                Name
              </label>
              <input
                id="me-name"
                className="re-select"
                type="text"
                value={name}
                maxLength={28}
                placeholder={defaultName}
                onChange={e => setName(e.target.value)}
              />
            </div>

            <div className="stage-perf-octaves">
              <span className="re-micro-label">Species</span>
              <div className="re-pills">
                <button
                  type="button"
                  className={`re-pill${kind === 'lead' ? ' on' : ''}`}
                  onClick={() => setKind('lead')}
                >
                  Melody Wisp
                </button>
                <button
                  type="button"
                  className={`re-pill${kind === 'bass' ? ' on' : ''}`}
                  onClick={() => setKind('bass')}
                >
                  Bass Serpent
                </button>
              </div>
            </div>

            <div className="re-stack-sm">
              <label className="re-micro-label" htmlFor="me-voice">
                Voice
              </label>
              <select id="me-voice" className="re-select" value={voiceId} onChange={e => setVoiceId(e.target.value)}>
                {allVoices.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.name} — {v.blurb}
                  </option>
                ))}
              </select>
            </div>

            <div className="re-stack-sm">
              <label className="re-micro-label" htmlFor="me-contour">
                Contour
              </label>
              <select
                id="me-contour"
                className="re-select"
                value={contourId}
                onChange={e => setContourId(e.target.value)}
              >
                {allContours.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className="stage-perf-flavor">{contour.flavor}</p>
            </div>

            <div className="stage-perf-octaves">
              <span className="re-micro-label">Register</span>
              <div className="re-pills">
                {([-1, 0, 1] as const).map(shift => (
                  <button
                    key={shift}
                    type="button"
                    className={`re-pill${octaveShift === shift ? ' on' : ''}`}
                    onClick={() => setOctaveShift(shift)}
                  >
                    {shift > 0 ? `+${shift}` : shift} oct
                  </button>
                ))}
              </div>
            </div>

            <button type="button" className="re-play-btn" onClick={handleSave}>
              Save to library
            </button>
            {savedFlash ? <p className="stage-perf-flavor">Saved “{savedFlash}” — hire it on the Stage.</p> : null}
          </div>

          <div className="re-panel re-stack">
            <div className="re-panel-head">
              <div>
                <h3>Creature Library</h3>
                <p>{library.length ? `${library.length} stored` : 'Nothing hatched yet'}</p>
              </div>
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
                    <div className="stage-perf-buttons">
                      <button type="button" className="stage-perf-btn on" onClick={() => handleLoad(saved)} title="Load into builder">
                        ↺
                      </button>
                      <button
                        type="button"
                        className="stage-perf-btn remove"
                        onClick={() => handleDelete(saved.id)}
                        title="Delete"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="stage-perf-flavor">
                Sculpt a creature above and save it. Stored creatures can be hired into the{' '}
                <Link to={conservatoryPath('/stage') as never}>Ensemble Stage</Link> troupe.
              </p>
            )}
          </div>
        </div>

        <div className="re-col-right re-stack">
          <div className="stage-floor">
            <div className="stage-chrome">
              <div>
                <div className="stage-chrome-label">On the bench</div>
                <div className="stage-chrome-value">{name.trim() || defaultName}</div>
                <div className="stage-chrome-sub">
                  {voice.name} · {contour.name} · {octaveShift > 0 ? `+${octaveShift}` : octaveShift} oct
                </div>
              </div>
              <div>
                <div className="stage-chrome-label">Audition loop</div>
                <div className="stage-chrome-value">
                  {preset.name} in {keyRoot}
                </div>
                <div className="stage-chrome-sub">{isPlaying ? 'Rolling · 4/4' : 'Stopped · 4/4'}</div>
              </div>
            </div>

            <div className="re-canvas-main he-canvas-main">
              <canvas ref={cvRef} className="re-canvas" aria-label="Creature audition stage" />
            </div>

            <div className="stage-lamps-wrap">
              <div className="melody-audition-row">
                <button
                  type="button"
                  className={`re-play-btn melody-audition-play${isPlaying ? ' halt' : ''}`}
                  onClick={() => void toggle()}
                >
                  {isPlaying ? <IconStop /> : <IconPlay />}
                  <span>{isPlaying ? 'Stop audition' : 'Audition'}</span>
                </button>
                <button type="button" className="re-secondary-btn melody-audition-stop" onClick={stop}>
                  Rewind
                </button>
              </div>

              <div className="melody-audition-grid">
                <div className="re-stack-sm">
                  <label className="re-micro-label" htmlFor="me-key">
                    Key
                  </label>
                  <select
                    id="me-key"
                    className="re-select"
                    value={keyRoot}
                    onChange={e => setKeyRoot(e.target.value as NoteName)}
                  >
                    {NOTE_NAMES.map(n => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="re-stack-sm">
                  <label className="re-micro-label" htmlFor="me-preset">
                    Progression
                  </label>
                  <select
                    id="me-preset"
                    className="re-select"
                    value={presetId}
                    onChange={e => setPresetId(e.target.value)}
                  >
                    {PROGRESSION_PRESETS.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="re-stack-sm">
                  <div className="re-slider-head sm">
                    <label htmlFor="me-bpm">BPM</label>
                    <span className="re-slider-val sm">{bpm}</span>
                  </div>
                  <input
                    id="me-bpm"
                    type="range"
                    min={60}
                    max={160}
                    step={1}
                    value={bpm}
                    onChange={e => setBpm(parseInt(e.target.value, 10))}
                  />
                </div>
                <div className="stage-perf-octaves">
                  <span className="re-micro-label">House chords</span>
                  <div className="re-pills">
                    <button
                      type="button"
                      className={`re-pill${chordsAudible ? ' on' : ''}`}
                      onClick={() => setChordsAudible(true)}
                    >
                      On
                    </button>
                    <button
                      type="button"
                      className={`re-pill${!chordsAudible ? ' on' : ''}`}
                      onClick={() => setChordsAudible(false)}
                    >
                      Solo
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="re-workbench">
        <ContourDesigner idPrefix="me" />
        <VoiceBuilder idPrefix="me" />
      </div>
    </section>
  );
}
