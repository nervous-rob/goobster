import { useNavigate } from '@tanstack/react-router';
import { conservatoryPath } from '@music-lab/lib/paths';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { NOTE_NAMES, type NoteName } from '@music-lab/lib/musicData';
import { appendChordToStage, queueStudioHandoff, sendChordsToStage } from '@music-lab/lib/handoff';
import {
  CHORD_QUALITIES,
  PROGRESSION_PRESETS,
  QUIZ_LEVELS,
  VOICINGS,
  type ChordQualityId,
  type ExtensionId,
  type RegisterId,
  type ScaleMode,
  type VoicingId
} from '@music-lab/lib/harmonyData';
import {
  allowedExtensionsFor,
  analyzeChord,
  buildGravityMapView,
  buildHarmonyGenome,
  buildPresetProgression,
  chordIntervals,
  classifyOrganism,
  describeChordTones,
  makeQuizQuestion,
  quizFeedback,
  type FoundrySettings,
  type HarmonyGenome,
  type QuizQuestion
} from '@music-lab/lib/harmonyTheory';
import { useLocalStorage } from '@music-lab/hooks/useLocalStorage';
import { useToneHarmony } from '@music-lab/hooks/useToneHarmony';
import { EngineSwitch } from '@music-lab/components/shared/EngineSwitch';
import { VoiceBuilder } from '@music-lab/components/shared/VoiceBuilder';
import {
  createOrganismState,
  flinchOrganism,
  glowOrganism,
  pulseOrganism,
  renderGravityMap,
  renderOrganism,
  HH,
  HMAP_H,
  HW
} from './organismRenderer';

type QuizPhase = 'idle' | 'listening' | 'answered';

function toFoundry(genome: HarmonyGenome): FoundrySettings {
  return {
    root: genome.root,
    quality: genome.quality,
    extension: genome.extension,
    inversion: genome.inversion,
    voicing: genome.voicing,
    register: genome.register
  };
}

const INVERSION_LABELS = ['Root', '1st', '2nd', '3rd', '4th'];
const REGISTER_OPTIONS: { id: RegisterId; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'mid', label: 'Mid' },
  { id: 'high', label: 'High' }
];

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

function IconOrbit() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="10" ry="4.2" />
      <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)" />
      <circle cx="20.6" cy="9" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconEar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M6 9a6 6 0 1 1 12 0c0 3-2 4-3.5 5.5S13 18 12.5 20a2.6 2.6 0 0 1-5-.5" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-1 2-1.8 2.8" />
    </svg>
  );
}

export function HarmonyEngine() {
  // --- Persistent settings ---
  const [keyRoot, setKeyRoot] = useLocalStorage<NoteName>('harmonyKeyRoot', 'C');
  const [keyMode, setKeyMode] = useLocalStorage<ScaleMode>('harmonyKeyMode', 'major');
  const [root, setRoot] = useLocalStorage<NoteName>('harmonyRoot', 'C');
  const [quality, setQuality] = useLocalStorage<ChordQualityId>('harmonyQuality', 'major');
  const [extension, setExtension] = useLocalStorage<ExtensionId>('harmonyExtension', 'none');
  const [inversion, setInversion] = useLocalStorage<number>('harmonyInversion', 0);
  const [voicing, setVoicing] = useLocalStorage<VoicingId>('harmonyVoicing', 'closed');
  const [register, setRegister] = useLocalStorage<RegisterId>('harmonyRegister', 'mid');
  const [presetId, setPresetId] = useLocalStorage<string>('harmonyPresetId', 'axis');
  const [loopBpm, setLoopBpm] = useLocalStorage<number>('harmonyLoopBpm', 84);
  const [quizLevelId, setQuizLevelId] = useLocalStorage<'triads' | 'sevenths'>('harmonyQuizLevel', 'triads');
  const [quizBest, setQuizBest] = useLocalStorage<number>('harmonyQuizBest', 0);

  // --- Session state ---
  const [isLooping, setIsLooping] = useState(false);
  const [loopStep, setLoopStep] = useState<number | null>(null);
  const [quizQuestion, setQuizQuestion] = useState<QuizQuestion | null>(null);
  const [quizPhase, setQuizPhase] = useState<QuizPhase>('idle');
  const [quizGuessId, setQuizGuessId] = useState<string | null>(null);
  const [quizText, setQuizText] = useState('Deal a mystery chord, then name its color.');
  const [quizStreak, setQuizStreak] = useState(0);
  const [quizScore, setQuizScore] = useState({ right: 0, total: 0 });
  const [revealGenome, setRevealGenome] = useState<HarmonyGenome | null>(null);

  const { audioReady, playChord, startLoop, stopLoop, updateBpm } = useToneHarmony();

  // --- Foundry constraints ---
  const allowedExts = useMemo(() => allowedExtensionsFor(quality), [quality]);
  useEffect(() => {
    setExtension(ext => (allowedExts.some(e => e.id === ext) ? ext : 'none'));
  }, [allowedExts, setExtension]);
  const safeExtension = allowedExts.some(e => e.id === extension) ? extension : 'none';
  const chordSize = chordIntervals(quality, safeExtension).length;
  const maxInversion = Math.min(chordSize - 1, 3);
  useEffect(() => {
    setInversion(i => Math.min(i, maxInversion));
  }, [maxInversion, setInversion]);

  const foundryGenome = useMemo(
    () =>
      buildHarmonyGenome({
        root,
        quality,
        extension: safeExtension,
        inversion: Math.min(inversion, maxInversion),
        voicing,
        register
      }),
    [root, quality, safeExtension, inversion, maxInversion, voicing, register]
  );

  // --- Progression ---
  const preset = useMemo(
    () => PROGRESSION_PRESETS.find(p => p.id === presetId) ?? PROGRESSION_PRESETS[0],
    [presetId]
  );
  const progressionSteps = useMemo(() => buildPresetProgression(preset, keyRoot), [preset, keyRoot]);
  const stepsRef = useRef(progressionSteps);
  stepsRef.current = progressionSteps;

  // --- Stage: what the organism, anatomy and meters currently show ---
  const activeLoopStep = isLooping && loopStep !== null ? progressionSteps[loopStep % progressionSteps.length] : null;
  const stageGenome = activeLoopStep ? activeLoopStep.genome : quizPhase === 'answered' && revealGenome ? revealGenome : foundryGenome;
  const stageMode: ScaleMode = activeLoopStep ? preset.mode : keyMode;
  const analysis = useMemo(() => analyzeChord(stageGenome, keyRoot, stageMode), [stageGenome, keyRoot, stageMode]);
  const tones = useMemo(() => describeChordTones(stageGenome), [stageGenome]);
  const mapView = useMemo(
    () => buildGravityMapView(keyRoot, stageMode, stageGenome, analysis),
    [keyRoot, stageMode, stageGenome, analysis]
  );

  // --- Canvas refs & animation ---
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const cvMapRef = useRef<HTMLCanvasElement | null>(null);
  const orgStateRef = useRef(createOrganismState());
  const stageRef = useRef(stageGenome);
  stageRef.current = stageGenome;
  const mapViewRef = useRef(mapView);
  mapViewRef.current = mapView;
  const visRef = useRef({ scaleMain: 1, scaleMap: 1, lastTime: 0, t: 0 });
  const quizPhaseRef = useRef<QuizPhase>(quizPhase);
  quizPhaseRef.current = quizPhase;

  const resizeCanvases = useCallback(() => {
    const cv = cvRef.current;
    const cvMap = cvMapRef.current;
    if (!cv || !cvMap) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = cv.clientWidth || HW;
    const cssH = (cssW * HH) / HW;
    cv.style.height = `${cssH}px`;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    visRef.current.scaleMain = (cssW / HW) * dpr;
    const cssHMap = (cssW * HMAP_H) / HW;
    cvMap.style.height = `${cssHMap}px`;
    cvMap.width = Math.round(cssW * dpr);
    cvMap.height = Math.round(cssHMap * dpr);
    visRef.current.scaleMap = (cssW / HW) * dpr;
  }, []);

  useEffect(() => {
    let raf = 0;
    resizeCanvases();
    const onResize = () => resizeCanvases();
    window.addEventListener('resize', onResize);

    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      const v = visRef.current;
      if (!v.lastTime) v.lastTime = ts;
      let dt = (ts - v.lastTime) / 1000;
      v.lastTime = ts;
      if (dt > 0.05) dt = 0.05;
      v.t += dt;

      const ctx = cvRef.current?.getContext('2d');
      if (ctx) {
        ctx.setTransform(v.scaleMain, 0, 0, v.scaleMain, 0, 0);
        ctx.clearRect(0, 0, HW, HH);
        renderOrganism(ctx, stageRef.current, orgStateRef.current, v.t, dt);
      }
      const ctxMap = cvMapRef.current?.getContext('2d');
      if (ctxMap) {
        ctxMap.setTransform(v.scaleMap, 0, 0, v.scaleMap, 0, 0);
        ctxMap.clearRect(0, 0, HW, HMAP_H);
        renderGravityMap(ctxMap, mapViewRef.current, v.t);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [resizeCanvases]);

  // --- Audio interactions ---
  const handlePlayChord = useCallback(() => {
    void playChord(foundryGenome.midi, 2.0);
    pulseOrganism(orgStateRef.current);
  }, [playChord, foundryGenome]);

  // Auto-audition the foundry while sculpting (only once audio is unlocked).
  const prevFoundryIdRef = useRef(foundryGenome.id);
  useEffect(() => {
    if (prevFoundryIdRef.current === foundryGenome.id) return;
    prevFoundryIdRef.current = foundryGenome.id;
    if (!audioReady || isLooping || quizPhaseRef.current === 'listening') return;
    setRevealGenome(null);
    if (quizPhaseRef.current === 'answered') setQuizPhase('idle');
    void playChord(foundryGenome.midi, 1.3);
    pulseOrganism(orgStateRef.current, 0.7);
  }, [foundryGenome, audioReady, isLooping, playChord]);

  const toggleLoop = useCallback(async () => {
    if (isLooping) {
      stopLoop();
      setIsLooping(false);
      setLoopStep(null);
      return;
    }
    await startLoop(
      {
        getMidi: index => stepsRef.current[index % Math.max(1, stepsRef.current.length)]?.genome.midi ?? null,
        getLength: () => stepsRef.current.length,
        onStep: index => {
          setLoopStep(index);
          pulseOrganism(orgStateRef.current, 0.85);
        }
      },
      loopBpm
    );
    setIsLooping(true);
  }, [isLooping, startLoop, stopLoop, loopBpm]);

  useEffect(() => {
    if (isLooping) updateBpm(loopBpm);
  }, [loopBpm, isLooping, updateBpm]);

  // Restart the loop cleanly when the underlying progression changes.
  const loopRestartRef = useRef(false);
  useEffect(() => {
    if (!isLooping) return;
    if (!loopRestartRef.current) {
      loopRestartRef.current = true;
      return;
    }
    setLoopStep(0);
    void startLoop(
      {
        getMidi: index => stepsRef.current[index % Math.max(1, stepsRef.current.length)]?.genome.midi ?? null,
        getLength: () => stepsRef.current.length,
        onStep: index => {
          setLoopStep(index);
          pulseOrganism(orgStateRef.current, 0.85);
        }
      },
      loopBpm
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressionSteps]);

  const selectPreset = useCallback(
    (id: string) => {
      setPresetId(id);
      const next = PROGRESSION_PRESETS.find(p => p.id === id);
      if (next) setKeyMode(next.mode);
    },
    [setPresetId, setKeyMode]
  );

  // --- Handoffs: chords forged here travel to the Stage or the Studio ---
  const navigate = useNavigate();
  const [handoffFlash, setHandoffFlash] = useState<string | null>(null);

  const handleSendProgressionToStage = useCallback(() => {
    sendChordsToStage(progressionSteps.map(step => toFoundry(step.genome)), keyRoot);
    void navigate({ to: conservatoryPath('/stage') as never });
  }, [progressionSteps, keyRoot, navigate]);

  const handleSendProgressionToStudio = useCallback(() => {
    queueStudioHandoff({
      type: 'chords',
      name: `${preset.name} in ${keyRoot}`,
      keyRoot,
      chords: progressionSteps.map(step => toFoundry(step.genome))
    });
    void navigate({ to: conservatoryPath('/studio') as never });
  }, [preset.name, progressionSteps, keyRoot, navigate]);

  const handleAddChordToStage = useCallback(() => {
    const count = appendChordToStage(toFoundry(foundryGenome));
    setHandoffFlash(`${foundryGenome.name} appended — the Stage song lane now holds ${count} chord${count === 1 ? '' : 's'}.`);
    window.setTimeout(() => setHandoffFlash(null), 3200);
  }, [foundryGenome]);

  // --- Quiz ---
  const quizLevel = useMemo(() => QUIZ_LEVELS.find(l => l.id === quizLevelId) ?? QUIZ_LEVELS[0], [quizLevelId]);
  const lastOptionRef = useRef<string | null>(null);

  const dealQuiz = useCallback(() => {
    const q = makeQuizQuestion(quizLevel, lastOptionRef.current);
    lastOptionRef.current = q.option.id;
    setQuizQuestion(q);
    setQuizPhase('listening');
    setQuizGuessId(null);
    setRevealGenome(null);
    setQuizText('Listening… what color is this force?');
    void playChord(q.genome.midi, 2.2);
  }, [quizLevel, playChord]);

  const replayQuiz = useCallback(() => {
    if (quizQuestion) void playChord(quizQuestion.genome.midi, 2.2);
  }, [quizQuestion, playChord]);

  const answerQuiz = useCallback(
    (optionId: string) => {
      if (!quizQuestion || quizPhase !== 'listening') return;
      const guess = quizLevel.options.find(o => o.id === optionId);
      if (!guess) return;
      const correct = optionId === quizQuestion.option.id;
      setQuizGuessId(optionId);
      setQuizPhase('answered');
      setRevealGenome(quizQuestion.genome);
      setQuizText(quizFeedback(correct, guess, quizQuestion.option));
      setQuizScore(s => ({ right: s.right + (correct ? 1 : 0), total: s.total + 1 }));
      if (correct) {
        const nextStreak = quizStreak + 1;
        setQuizStreak(nextStreak);
        setQuizBest(best => Math.max(best, nextStreak));
        glowOrganism(orgStateRef.current);
      } else {
        setQuizStreak(0);
        flinchOrganism(orgStateRef.current);
      }
    },
    [quizQuestion, quizPhase, quizLevel, quizStreak, setQuizBest]
  );

  const inspectQuizChord = useCallback(() => {
    if (!quizQuestion) return;
    setRoot(quizQuestion.root);
    setQuality(quizQuestion.option.quality);
    setExtension(quizQuestion.option.extension);
    setInversion(0);
    setVoicing('closed');
    setRegister('mid');
  }, [quizQuestion, setRoot, setQuality, setExtension, setInversion, setVoicing, setRegister]);

  // --- Render helpers ---
  const gravityPct = Math.round(analysis.gravity * 100);
  const tritoneText = analysis.tritones.length
    ? analysis.tritones.map(p => `${p.a}–${p.b}`).join(', ')
    : '—';
  const stageTones = [...tones].reverse();
  const quizAccuracy = quizScore.total ? Math.round((quizScore.right / quizScore.total) * 100) : null;

  return (
    <section className="rhythm-engine harmony-engine">
      <header className="re-header">
        <div className="re-brand">
          <span className="re-brand-icon">
            <IconOrbit />
          </span>
          <div>
            <h2 className="re-title">
              Harmony Engine <span className="re-accent-text">GRAVITY</span>
            </h2>
            <p className="re-subtitle">Gravity Field Simulator + Harmonic Organisms</p>
          </div>
        </div>
        <EngineSwitch active="harmony" />
        <div className="re-status">
          <span className={`re-status-dot${audioReady ? ' on' : ''}`} />
          <span className={audioReady ? 're-status-text on' : 're-status-text'}>
            {audioReady ? 'Field Active' : 'Field Cold'}
          </span>
        </div>
      </header>

      <div className="re-grid">
        {/* Left sidebar: foundry + progression + ear lab */}
        <div className="re-col-left">
          <div className="re-panel re-stack">
            <div className="re-panel-head">
              <div>
                <h3>Chord Foundry</h3>
                <p>Forge a harmonic organism</p>
              </div>
            </div>

            <div className="he-row-2">
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="he-key">
                  Key center
                </label>
                <select id="he-key" className="re-select" value={keyRoot} onChange={e => setKeyRoot(e.target.value as NoteName)}>
                  {NOTE_NAMES.map(n => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="re-stack-sm">
                <span className="re-micro-label">Mode</span>
                <div className="he-pill-row">
                  {(['major', 'minor'] as ScaleMode[]).map(m => (
                    <button
                      key={m}
                      type="button"
                      className={`re-pill he-pill-btn${keyMode === m ? ' on' : ''}`}
                      onClick={() => setKeyMode(m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="he-row-2">
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="he-root">
                  Chord root
                </label>
                <select id="he-root" className="re-select" value={root} onChange={e => setRoot(e.target.value as NoteName)}>
                  {NOTE_NAMES.map(n => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="re-stack-sm">
                <span className="re-micro-label">Register</span>
                <div className="he-pill-row">
                  {REGISTER_OPTIONS.map(r => (
                    <button
                      key={r.id}
                      type="button"
                      className={`re-pill he-pill-btn${register === r.id ? ' on' : ''}`}
                      onClick={() => setRegister(r.id)}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="re-stack-sm">
              <span className="re-micro-label">Quality</span>
              <div className="he-quality-grid">
                {CHORD_QUALITIES.map(q => (
                  <button
                    key={q.id}
                    type="button"
                    className={`he-quality-btn${quality === q.id ? ' active' : ''}`}
                    onClick={() => setQuality(q.id)}
                    title={q.feel}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="he-row-2">
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="he-ext">
                  Extension
                </label>
                <select
                  id="he-ext"
                  className="re-select"
                  value={safeExtension}
                  onChange={e => setExtension(e.target.value as ExtensionId)}
                >
                  {allowedExts.map(e => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="he-voicing">
                  Voicing
                </label>
                <select id="he-voicing" className="re-select" value={voicing} onChange={e => setVoicing(e.target.value as VoicingId)}>
                  {VOICINGS.map(v => (
                    <option key={v.id} value={v.id} title={v.blurb}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="re-stack-sm">
              <span className="re-micro-label">Inversion · weight distribution</span>
              <div className="he-pill-row">
                {INVERSION_LABELS.slice(0, maxInversion + 1).map((label, i) => (
                  <button
                    key={label}
                    type="button"
                    className={`re-pill he-pill-btn${Math.min(inversion, maxInversion) === i ? ' on' : ''}`}
                    onClick={() => setInversion(i)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <button type="button" className="re-play-btn" onClick={handlePlayChord}>
              <IconPlay />
              <span>Play Chord · {foundryGenome.name}</span>
            </button>
            <button type="button" className="re-secondary-btn" onClick={handleAddChordToStage}>
              + Add to Stage song lane
            </button>
            {handoffFlash ? <p className="vb-flash">{handoffFlash}</p> : null}
          </div>

          <div className="re-panel re-stack">
            <div className="re-panel-head">
              <div>
                <h3>Progression Engine</h3>
                <p>Loops scheduled at measure level</p>
              </div>
            </div>
            <div className="re-sig-list he-preset-list">
              {PROGRESSION_PRESETS.map(p => (
                <button
                  type="button"
                  key={p.id}
                  className={`re-sig-btn${p.id === preset.id ? ' active' : ''}`}
                  onClick={() => selectPreset(p.id)}
                >
                  <span>
                    {p.name} <small>{p.numerals.length > 6 ? '12-bar form' : p.numerals.join('–')}</small>
                  </span>
                  <span className="re-chevron">›</span>
                </button>
              ))}
            </div>
            <div>
              <div className="re-slider-head sm">
                <label htmlFor="he-bpm">Pulse (BPM)</label>
                <span className="re-slider-val sm">{loopBpm}</span>
              </div>
              <input
                id="he-bpm"
                type="range"
                min={56}
                max={140}
                step={1}
                value={loopBpm}
                onChange={e => setLoopBpm(parseInt(e.target.value, 10))}
              />
            </div>
            <button type="button" className={`re-play-btn${isLooping ? ' halt' : ''}`} onClick={() => void toggleLoop()}>
              {isLooping ? <IconStop /> : <IconPlay />}
              <span>{isLooping ? 'Halt Loop' : `Loop in ${keyRoot} ${preset.mode}`}</span>
            </button>
            <div className="re-stack-sm">
              <span className="re-micro-label">Take this progression elsewhere</span>
              <div className="re-pills">
                <button type="button" className="re-pill" onClick={handleSendProgressionToStage}>
                  Stage song lane →
                </button>
                <button type="button" className="re-pill" onClick={handleSendProgressionToStudio}>
                  Studio section →
                </button>
              </div>
            </div>
          </div>

          <div className="re-panel re-stack">
            <div className="re-panel-head">
              <div>
                <h3>Ear Lab — Chord Color Quiz</h3>
                <p>Name the force, not the notes</p>
              </div>
              <span className="re-accent-text">
                <IconEar />
              </span>
            </div>
            <div className="he-pill-row">
              {QUIZ_LEVELS.map(level => (
                <button
                  key={level.id}
                  type="button"
                  className={`re-pill he-pill-btn${quizLevelId === level.id ? ' on' : ''}`}
                  onClick={() => {
                    setQuizLevelId(level.id);
                    setQuizPhase('idle');
                    setQuizQuestion(null);
                    setRevealGenome(null);
                    setQuizText('Deal a mystery chord, then name its color.');
                  }}
                >
                  {level.label}
                </button>
              ))}
            </div>
            <div className="he-row-2">
              <button type="button" className="re-secondary-btn he-deal-btn" onClick={dealQuiz}>
                {quizPhase === 'idle' ? 'Deal Mystery Chord' : 'Next Chord'}
              </button>
              <button type="button" className="re-secondary-btn" onClick={replayQuiz} disabled={!quizQuestion}>
                Replay
              </button>
            </div>
            <div className="he-quiz-grid">
              {quizLevel.options.map(option => {
                const classes = ['he-quiz-btn'];
                if (quizPhase === 'answered' && quizQuestion) {
                  if (option.id === quizQuestion.option.id) classes.push('correct');
                  else if (option.id === quizGuessId) classes.push('wrong');
                }
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={classes.join(' ')}
                    disabled={quizPhase !== 'listening'}
                    onClick={() => answerQuiz(option.id)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <div className="he-feedback">
              <p>{quizText}</p>
              {quizPhase === 'answered' && quizQuestion ? (
                <button type="button" className="he-inspect-btn" onClick={inspectQuizChord}>
                  Load {quizQuestion.genome.name} into the foundry ›
                </button>
              ) : null}
            </div>
            <div className="re-tap-stats he-quiz-stats">
              <div className="re-micro-card">
                <div className="re-micro-label">Streak</div>
                <div className="re-big-number">{quizStreak}</div>
              </div>
              <div className="re-micro-card">
                <div className="re-micro-label">Best</div>
                <div className="re-big-number">{quizBest}</div>
              </div>
              <div className="re-micro-card">
                <div className="re-micro-label">Accuracy</div>
                <div className="re-big-number">{quizAccuracy === null ? '—' : `${quizAccuracy}%`}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right content: organism, gravity map, meters */}
        <div className="re-col-right">
          <div className="re-viz">
            <div className="re-viz-overlay">
              <h2 className="re-viz-title">{stageGenome.name}</h2>
              <p className="re-viz-subtitle">{classifyOrganism(stageGenome)}</p>
              <p className="he-chip">
                {analysis.numeral ? `${analysis.numeral} · ${analysis.fnLabel}` : 'Chromatic visitor'} · key of {keyRoot}{' '}
                {stageMode}
              </p>
            </div>
            {isLooping ? (
              <div className="re-measure-dots">
                {progressionSteps.map((_, i) => (
                  <span key={i} className={`re-dot${loopStep !== null && i === loopStep % progressionSteps.length ? ' now' : ''}`} />
                ))}
              </div>
            ) : null}
            <div className="re-canvas-main he-canvas-main">
              <canvas ref={cvRef} className="re-canvas" />
            </div>
            <div className="re-overhead">
              <div className="re-overhead-label">
                <span className="re-micro-label">Gravity map — where it wants to go</span>
              </div>
              <canvas ref={cvMapRef} className="re-canvas" />
            </div>
          </div>

          <div className="re-panel">
            <div className="re-panel-title">
              <h3>Resolution Meter</h3>
            </div>
            <div className="he-res-grid">
              <div className="re-micro-card he-gravity-card">
                <div className="re-micro-label">Gravity</div>
                <div className="re-big-number">{gravityPct}%</div>
                <div className="re-card-note">{analysis.word} · {analysis.fnLabel}</div>
              </div>
              <div className="he-res-facts">
                <div className="he-fact">
                  <span className="re-micro-label">Current chord</span>
                  <span className="he-fact-val">
                    {stageGenome.name}
                    {stageGenome.inversion > 0 ? ` / ${stageGenome.bassName}` : ''}
                  </span>
                </div>
                <div className="he-fact">
                  <span className="re-micro-label">Contains tritone</span>
                  <span className="he-fact-val">{tritoneText}</span>
                </div>
                <div className="he-fact">
                  <span className="re-micro-label">Expected landing</span>
                  <span className="he-fact-val">{analysis.landingSummary}</span>
                </div>
                <p className="he-blurb">{analysis.blurb}</p>
              </div>
            </div>
            {analysis.resolutions.length ? (
              <div className="he-res-list">
                {analysis.resolutions.map(res => (
                  <div key={`${res.numeral}-${res.kind}`} className="he-res-row" title={res.why}>
                    <span className="he-res-target">
                      → {res.numeral} <small>{res.chordName}</small>
                    </span>
                    <span className="he-res-kind">{res.kind}</span>
                    <span className="he-res-bar">
                      <span className="he-res-fill" style={{ '--w': `${Math.round(res.strength * 100)}%` } as CSSProperties} />
                    </span>
                    <span className="he-res-pct">{Math.round(res.strength * 100)}%</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="re-panel">
            <div className="re-panel-title">
              <h3>Harmonic Physics</h3>
            </div>
            <div className="he-physics-grid">
              <div className="re-micro-card">
                <div className="re-micro-label">Tension</div>
                <div className="re-big-number">{stageGenome.tension.toFixed(2)}</div>
                <div className="re-card-note">grind &amp; pull toward release</div>
              </div>
              <div className="re-micro-card">
                <div className="re-micro-label">Brightness</div>
                <div className="re-big-number">{stageGenome.brightness.toFixed(2)}</div>
                <div className="re-card-note">major-third lift / luminance</div>
              </div>
              <div className="re-micro-card">
                <div className="re-micro-label">Instability</div>
                <div className="re-big-number">{stageGenome.instability.toFixed(2)}</div>
                <div className="re-card-note">wobble, tritones, symmetry</div>
              </div>
              <div className="re-micro-card">
                <div className="re-micro-label">Ambiguity</div>
                <div className="re-big-number">{stageGenome.ambiguity.toFixed(2)}</div>
                <div className="re-card-note">identity blur / double image</div>
              </div>
            </div>
          </div>

          <div className="re-panel">
            <div className="re-panel-title">
              <h3>Chord Anatomy</h3>
            </div>
            <div className="he-anatomy">
              {stageTones.map(tone => (
                <div key={`${tone.midi}`} className={`he-anatomy-row${tone.isBass ? ' bass' : ''}`}>
                  <span className="he-anatomy-note">
                    {tone.note}
                    <small>{tone.octave}</small>
                  </span>
                  <span className="he-anatomy-degree">{tone.degree}</span>
                  <span className="he-anatomy-role">{tone.role}</span>
                  <span className="he-anatomy-force">
                    {tone.force}
                    {tone.isBass ? ' · gravitational anchor' : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="re-panel">
            <div className="re-panel-title">
              <h3>Tension Timeline</h3>
            </div>
            <div className="re-row-between">
              <span className="re-micro-label">{preset.name} · key of {keyRoot} {preset.mode}</span>
              <span className="re-readout">{progressionSteps.map(s => s.displayNumeral).join(' – ')}</span>
            </div>
            <div className="he-timeline">
              {progressionSteps.map((step, i) => {
                const h = 18 + step.tensionHeight * 78;
                const active = isLooping && loopStep !== null && i === loopStep % progressionSteps.length;
                return (
                  <button
                    type="button"
                    key={`${step.numeral}-${i}`}
                    className={`he-timeline-seg${active ? ' active' : ''}`}
                    style={{ '--h': `${h}%` } as CSSProperties}
                    onClick={() => {
                      void playChord(step.genome.midi, 1.4);
                      pulseOrganism(orgStateRef.current, 0.7);
                    }}
                    title={`${step.chordName} · ${step.word}`}
                  >
                    <span className="he-timeline-chord">{step.chordName}</span>
                    <span className="he-timeline-word">{step.word}</span>
                  </button>
                );
              })}
            </div>
            <p className="he-feel">{preset.feel}</p>
          </div>
        </div>
      </div>

      <div className="re-workbench">
        <VoiceBuilder idPrefix="he" />
      </div>
    </section>
  );
}
