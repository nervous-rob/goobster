import { useNavigate } from '@tanstack/react-router';
import { conservatoryPath } from '@music-lab/lib/paths';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CUSTOM_RHYTHM_ID, CUSTOM_RHYTHM_STORAGE_KEY, RHYTHMS, type RhythmDefinition } from '@music-lab/lib/rhythmData';
import { queueStudioHandoff, sendGrooveToStage } from '@music-lab/lib/handoff';
import {
  buildCreature,
  buildEuclideanRhythm,
  buildSequenceArray,
  clamp,
  computeGroovePhysics,
  getGenomeId,
  makeCreatureGenome,
  makeEuclideanPattern,
  totalSubdivisions,
  type Creature,
  type SequenceStep
} from '@music-lab/lib/rhythmTheory';
import { useLocalStorage } from '@music-lab/hooks/useLocalStorage';
import { EngineSwitch } from '@music-lab/components/shared/EngineSwitch';
import { resolveTone, type ToneModule } from '@music-lab/lib/stageInstruments';
import {
  renderBackdrop,
  renderCreatureScene,
  renderOverhead,
  renderTrainScene,
  spawnPuff,
  updatePuffs,
  WH,
  WH_OVER,
  WW,
  type Puff,
  type VisualSnapshot
} from './renderers';

interface EngineSynths {
  mechStrong: import('tone').MembraneSynth;
  mechWeak: import('tone').MetalSynth;
  kick: import('tone').MembraneSynth;
  snareNoise: import('tone').NoiseSynth;
  snareBody: import('tone').MembraneSynth;
  hihat: import('tone').MetalSynth;
  tom: import('tone').MembraneSynth;
  bell: import('tone').FMSynth;
}

type VisualMode = 'train' | 'creature';

interface ActiveStepInfo {
  subIndex: number;
  measure: number;
  side: 0 | 1;
  fill: boolean;
  ghost: boolean;
}

interface TapStats {
  hits: number;
  streak: number;
  lastMs: number | null;
  history: number[];
}

interface EngineStateSnapshot {
  visualMode: VisualMode;
  isPlaying: boolean;
  bpm: number;
  swing: number;
  phraseLength: number;
  drumsEnabled: boolean;
  ghostMode: boolean;
  polyRatio: number;
  grouping: number[];
  total: number;
  isEuclidean: boolean;
  euclidSteps: number;
  euclidPulses: number;
  euclidOffset: number;
}

const WHEEL_R = 45;
const INITIAL_TAP_STATS: TapStats = { hits: 0, streak: 0, lastMs: null, history: [] };

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

function IconDrum() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <ellipse cx="12" cy="9" rx="9" ry="4" />
      <path d="M3 9v7c0 2.2 4 4 9 4s9-1.8 9-4V9" />
      <path d="M19 3l-5.5 6.5M5 3l5.5 6.5" />
    </svg>
  );
}

function IconWave() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M2 12h3l2-7 4 14 4-10 2 3h5" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </svg>
  );
}

export function RhythmEngine() {
  // --- Persistent settings ---
  const [visualMode, setVisualMode] = useLocalStorage<VisualMode>('rhythmVisualMode', 'train');
  const [bpm, setBpm] = useLocalStorage<number>('rhythmBpm', 120);
  const [swing, setSwing] = useLocalStorage<number>('rhythmSwing', 0);
  const [phraseLength, setPhraseLength] = useLocalStorage<number>('rhythmPhraseLength', 4);
  const [drumsEnabled, setDrumsEnabled] = useLocalStorage<boolean>('rhythmDrumsEnabled', false);
  const [ghostMode, setGhostMode] = useLocalStorage<boolean>('rhythmGhostMode', false);
  const [polyRatio, setPolyRatio] = useLocalStorage<number>('rhythmPolyRatio', 0);
  const [currentRhythmId, setCurrentRhythmId] = useLocalStorage<string>('rhythmCurrentId', '5-4-32');
  const [customRhythm, setCustomRhythm] = useLocalStorage<RhythmDefinition | null>(CUSTOM_RHYTHM_STORAGE_KEY, null);
  const [euclidSteps, setEuclidSteps] = useLocalStorage<number>('rhythmEuclidSteps', 13);
  const [euclidPulses, setEuclidPulses] = useLocalStorage<number>('rhythmEuclidPulses', 5);
  const [euclidOffset, setEuclidOffset] = useLocalStorage<number>('rhythmEuclidOffset', 0);

  // --- Session state ---
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [activeStep, setActiveStep] = useState<ActiveStepInfo | null>(null);
  const [polyPulseDisplay, setPolyPulseDisplay] = useState<number | null>(null);
  const [tapStats, setTapStats] = useState<TapStats>(INITIAL_TAP_STATS);
  const [tapAdvice, setTapAdvice] = useState('Start engine, then tap space.');
  const [creatureName, setCreatureName] = useState('Pulse Walker');

  // --- Derived ---
  const rhythms = useMemo(() => (customRhythm ? [...RHYTHMS, customRhythm] : RHYTHMS), [customRhythm]);
  const currentRhythm = useMemo(
    () => rhythms.find(r => r.id === currentRhythmId) ?? RHYTHMS[0],
    [rhythms, currentRhythmId]
  );
  const grouping = currentRhythm.grouping;
  const total = useMemo(() => totalSubdivisions(grouping), [grouping]);
  const physics = useMemo(() => computeGroovePhysics(grouping), [grouping]);
  const euclidPattern = useMemo(
    () => makeEuclideanPattern(euclidSteps, euclidPulses, euclidOffset),
    [euclidSteps, euclidPulses, euclidOffset]
  );
  const lamps = useMemo(() => {
    const out: { index: number; sideLabel: string | null }[] = [];
    let idx = 0;
    let side = 0;
    grouping.forEach(groupSize => {
      for (let i = 0; i < groupSize; i++) {
        out.push({ index: idx, sideLabel: i === 0 ? (side === 0 ? 'L' : 'R') : null });
        idx++;
      }
      side = side === 0 ? 1 : 0;
    });
    return out;
  }, [grouping]);

  // --- Mutable engine refs ---
  const toneRef = useRef<ToneModule | null>(null);
  const synthsRef = useRef<EngineSynths | null>(null);
  const sequenceRef = useRef<import('tone').Sequence<SequenceStep> | null>(null);
  const polyEventRef = useRef<number | null>(null);
  const polyCounterRef = useRef(0);
  const seqStepsRef = useRef<SequenceStep[]>([]);
  const creatureRef = useRef<Creature | null>(null);
  const puffsRef = useRef<Puff[]>([]);
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const cvOverRef = useRef<HTMLCanvasElement | null>(null);
  const visRef = useRef({ theta: 0, scrollX: 0, currentSway: 0, lastTime: 0, scale: 1 });
  const playFlagsRef = useRef({ isFillActive: false, ghostMuted: false, currentMeasure: 1, polyPulse: 0 });

  const snapshot: EngineStateSnapshot = {
    visualMode,
    isPlaying,
    bpm,
    swing,
    phraseLength,
    drumsEnabled,
    ghostMode,
    polyRatio,
    grouping,
    total,
    isEuclidean: currentRhythm.id === CUSTOM_RHYTHM_ID,
    euclidSteps,
    euclidPulses,
    euclidOffset
  };
  const stateRef = useRef<EngineStateSnapshot>(snapshot);
  stateRef.current = snapshot;

  // --- Audio engine ---
  const initAudio = useCallback(async (): Promise<ToneModule> => {
    if (toneRef.current && synthsRef.current) {
      await resolveTone();
      return toneRef.current;
    }
    const Tone = await resolveTone();

    const mechStrong = new Tone.MembraneSynth({
      pitchDecay: 0.05,
      octaves: 4,
      oscillator: { type: 'square' },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0, release: 0.1 }
    }).toDestination();
    mechStrong.volume.value = -6;

    const mechWeak = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
      harmonicity: 3.1,
      modulationIndex: 16,
      resonance: 4000,
      octaves: 1.5
    }).toDestination();
    mechWeak.frequency.value = 200;
    mechWeak.volume.value = -18;

    const kick = new Tone.MembraneSynth({
      pitchDecay: 0.1,
      octaves: 5,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 0.4, sustain: 0.01, release: 1.4 }
    }).toDestination();
    kick.volume.value = -2;

    const snareNoise = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 }
    }).toDestination();
    snareNoise.volume.value = -8;

    const snareBody = new Tone.MembraneSynth({
      pitchDecay: 0.01,
      octaves: 2,
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1 }
    }).toDestination();
    snareBody.volume.value = -6;

    const hihat = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
      harmonicity: 5.1,
      modulationIndex: 32,
      resonance: 4000,
      octaves: 1.5
    }).toDestination();
    hihat.frequency.value = 400;
    hihat.volume.value = -14;

    const tom = new Tone.MembraneSynth({
      pitchDecay: 0.05,
      octaves: 4,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.005, decay: 0.4, sustain: 0, release: 0.5 }
    }).toDestination();
    tom.volume.value = -4;

    const bell = new Tone.FMSynth({
      harmonicity: 2,
      modulationIndex: 8,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.12, sustain: 0, release: 0.12 },
      modulation: { type: 'triangle' },
      modulationEnvelope: { attack: 0.002, decay: 0.08, sustain: 0, release: 0.08 }
    }).toDestination();
    bell.volume.value = -15;

    Tone.Transport.bpm.value = stateRef.current.bpm;
    Tone.Transport.swing = stateRef.current.swing;
    Tone.Transport.swingSubdivision = '8n';

    toneRef.current = Tone;
    synthsRef.current = { mechStrong, mechWeak, kick, snareNoise, snareBody, hihat, tom, bell };
    setAudioReady(true);
    return Tone;
  }, []);

  const rebuildSequence = useCallback(() => {
    const Tone = toneRef.current;
    const synths = synthsRef.current;
    if (!Tone || !synths) return;
    sequenceRef.current?.dispose();

    sequenceRef.current = new Tone.Sequence<SequenceStep>(
      (time, step) => {
        const s = stateRef.current;
        const ghostMuted = s.ghostMode && step.measure === s.phraseLength;
        const isFillActive = s.drumsEnabled && step.isFillTarget && !ghostMuted;
        playFlagsRef.current.currentMeasure = step.measure;
        playFlagsRef.current.ghostMuted = ghostMuted;
        playFlagsRef.current.isFillActive = isFillActive;

        if (!ghostMuted) {
          if (step.isStrong) {
            synths.mechStrong.triggerAttackRelease('C2', '8n', time);
            spawnPuff(puffsRef.current);
          } else {
            synths.mechWeak.triggerAttackRelease(200, '32n', time);
          }

          if (s.drumsEnabled) {
            if (isFillActive) {
              synths.tom.triggerAttackRelease('A2', '16n', time);
              synths.tom.triggerAttackRelease('F2', '16n', time + Tone.Time('16n').toSeconds());
            } else {
              if (step.isStrong) {
                synths.kick.triggerAttackRelease('C1', '8n', time);
                if (step.side === 1) {
                  synths.snareNoise.triggerAttackRelease('8n', time);
                  synths.snareBody.triggerAttackRelease('G3', '8n', time);
                }
              } else if (step.groupSize === 3 && step.posInGroup === 2) {
                // Ghost-note snare flick on the tail of triple groupings
                synths.snareNoise.volume.value = -20;
                synths.snareNoise.triggerAttackRelease('16n', time);
                synths.snareNoise.volume.value = -8;
              }
              synths.hihat.triggerAttackRelease(400, '32n', time);
            }
          }
        }

        Tone.Draw.schedule(() => {
          setActiveStep({
            subIndex: step.subIndex,
            measure: step.measure,
            side: step.side,
            fill: isFillActive,
            ghost: ghostMuted
          });
        }, time);
      },
      seqStepsRef.current,
      '8n'
    );
  }, []);

  const rebuildPoly = useCallback(() => {
    const Tone = toneRef.current;
    const synths = synthsRef.current;
    if (!Tone || !synths) return;
    if (polyEventRef.current !== null) {
      Tone.Transport.clear(polyEventRef.current);
      polyEventRef.current = null;
    }
    polyCounterRef.current = 0;
    playFlagsRef.current.polyPulse = 0;
    setPolyPulseDisplay(null);

    const s = stateRef.current;
    if (!s.polyRatio) return;
    const ticksPerEighth = Tone.Transport.PPQ / 2;
    const ticksPerBar = Math.max(1, s.total) * ticksPerEighth;
    const intervalTicks = Math.max(1, Math.round(ticksPerBar / s.polyRatio));
    // Anchored at tick 0 so toggling the ratio mid-play keeps the orbit on
    // the bar grid (the default anchor is the current transport position).
    polyEventRef.current = Tone.Transport.scheduleRepeat(time => {
      const cur = stateRef.current;
      if (!cur.polyRatio) return;
      const idx = polyCounterRef.current % cur.polyRatio;
      playFlagsRef.current.polyPulse = idx;
      polyCounterRef.current += 1;
      if (!(cur.ghostMode && playFlagsRef.current.currentMeasure === cur.phraseLength)) {
        synths.bell.triggerAttackRelease(idx === 0 ? 'C5' : 'G4', '16n', time);
      }
      Tone.Draw.schedule(() => setPolyPulseDisplay(idx), time);
    }, `${intervalTicks}i`, 0);
  }, []);

  const restartTransport = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone || !sequenceRef.current) return;
    Tone.Transport.stop();
    Tone.Transport.position = 0;
    polyCounterRef.current = 0;
    playFlagsRef.current.currentMeasure = 1;
    sequenceRef.current.start(0);
    Tone.Transport.start();
  }, []);

  const togglePlay = useCallback(async () => {
    const Tone = await initAudio();
    if (!sequenceRef.current) {
      rebuildSequence();
      rebuildPoly();
    }
    if (stateRef.current.isPlaying) {
      Tone.Transport.stop();
      sequenceRef.current?.stop(0);
      playFlagsRef.current.isFillActive = false;
      playFlagsRef.current.ghostMuted = false;
      setIsPlaying(false);
      setActiveStep(null);
      setPolyPulseDisplay(null);
    } else {
      restartTransport();
      setIsPlaying(true);
    }
  }, [initAudio, rebuildSequence, rebuildPoly, restartTransport]);

  // Rebuild the step grid (and live sequence) whenever the blueprint changes.
  useEffect(() => {
    seqStepsRef.current = buildSequenceArray(grouping, phraseLength);
    if (toneRef.current && synthsRef.current) {
      rebuildSequence();
      rebuildPoly();
      if (stateRef.current.isPlaying) {
        restartTransport();
      }
    }
  }, [grouping, phraseLength, rebuildSequence, rebuildPoly, restartTransport]);

  useEffect(() => {
    if (audioReady && toneRef.current) {
      rebuildPoly();
    }
  }, [polyRatio, audioReady, rebuildPoly]);

  useEffect(() => {
    if (audioReady && toneRef.current) {
      toneRef.current.Transport.bpm.value = bpm;
    }
  }, [bpm, audioReady]);

  useEffect(() => {
    if (audioReady && toneRef.current) {
      toneRef.current.Transport.swing = swing;
      toneRef.current.Transport.swingSubdivision = '8n';
    }
  }, [swing, audioReady]);

  // Keep generator parameters mutually consistent when segment count shrinks.
  useEffect(() => {
    const maxPulses = Math.min(8, Math.max(2, euclidSteps - 1));
    setEuclidPulses(p => Math.min(p, maxPulses));
    setEuclidOffset(o => Math.min(o, euclidSteps - 1));
  }, [euclidSteps, setEuclidPulses, setEuclidOffset]);

  // --- Tap coach ---
  const handleTap = useCallback(() => {
    const Tone = toneRef.current;
    const s = stateRef.current;
    if (!Tone || !s.isPlaying || !s.total) {
      setTapAdvice('Start engine first, then tap with the pulse.');
      return;
    }
    const currentQuarterNote = Tone.Transport.ticks / Tone.Transport.PPQ;
    const currentEighth = currentQuarterNote * 2;
    const pos = ((currentEighth % s.total) + s.total) % s.total;
    const nearest = Math.round(pos);
    const diffSteps = pos - nearest;
    const msPerEighth = (60 / s.bpm / 2) * 1000;
    const ms = diffSteps * msPerEighth;
    const abs = Math.abs(ms);
    setTapStats(prev => ({
      hits: prev.hits + 1,
      streak: abs <= 35 ? prev.streak + 1 : 0,
      lastMs: ms,
      history: [...prev.history, ms].slice(-28)
    }));
    const tendency = abs < 18 ? 'centered' : ms < 0 ? 'early' : 'late';
    setTapAdvice(abs < 35 ? `locked · ${tendency}` : `drifting ${tendency} by ${Math.round(abs)} ms`);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = (target?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.repeat) return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleTap();
      }
      if (e.key.toLowerCase() === 'g') {
        setGhostMode(g => !g);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleTap, setGhostMode]);

  // --- Handoffs: this groove travels to the Stage or the Studio ---
  const navigate = useNavigate();

  const handleSendToStage = useCallback(() => {
    sendGrooveToStage({ bpm, swing, rhythmId: currentRhythm.id });
    void navigate({ to: conservatoryPath('/stage') as never });
  }, [bpm, swing, currentRhythm.id, navigate]);

  const handleSendToStudio = useCallback(() => {
    queueStudioHandoff({
      type: 'groove',
      bpm,
      swing: Math.min(0.5, swing),
      rhythmId: currentRhythm.id,
      label: currentRhythm.label
    });
    void navigate({ to: conservatoryPath('/studio') as never });
  }, [bpm, swing, currentRhythm.id, currentRhythm.label, navigate]);

  // --- Euclidean foundry ---
  const synthesizeOrganism = useCallback(() => {
    const custom = buildEuclideanRhythm(
      euclidSteps,
      Math.min(euclidPulses, Math.min(8, Math.max(2, euclidSteps - 1))),
      Math.min(euclidOffset, euclidSteps - 1)
    );
    setCustomRhythm(custom);
    setCurrentRhythmId(CUSTOM_RHYTHM_ID);
  }, [euclidSteps, euclidPulses, euclidOffset, setCustomRhythm, setCurrentRhythmId]);

  // --- Canvas animation loop ---
  const resizeCanvases = useCallback(() => {
    const cv = cvRef.current;
    const cvOver = cvOverRef.current;
    if (!cv || !cvOver) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = cv.clientWidth || WW;
    const cssH = (cssW * WH) / WW;
    cv.style.height = `${cssH}px`;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    const cssHOver = (cssW * WH_OVER) / WW;
    cvOver.style.height = `${cssHOver}px`;
    cvOver.width = Math.round(cssW * dpr);
    cvOver.height = Math.round(cssHOver * dpr);
    visRef.current.scale = (cssW / WW) * dpr;
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

      const s = stateRef.current;
      const flags = playFlagsRef.current;
      const Tone = toneRef.current;
      const transportStarted = Boolean(Tone && s.isPlaying && Tone.Transport.state === 'started');

      let overheadPhase = 0;
      let currentQuarterNote = 0;

      if (transportStarted && Tone) {
        currentQuarterNote = Tone.Transport.ticks / Tone.Transport.PPQ;
        v.theta = currentQuarterNote * Math.PI;
        v.scrollX += Math.PI * WHEEL_R * (s.bpm / 60) * dt;

        const steps = seqStepsRef.current;
        const totalLoop = s.phraseLength * s.total;
        if (steps.length && totalLoop > 0) {
          const loop8th = (currentQuarterNote * 2) % totalLoop;
          const stepInfo = steps[Math.floor(loop8th)] ?? steps[0];
          const targetSide = stepInfo.side === 0 ? -1 : 1;
          v.currentSway += (targetSide - v.currentSway) * 12 * dt;

          const groupProgress = (loop8th - stepInfo.groupStartAbs) / stepInfo.groupSize;
          const easedProgress = 1 - Math.pow(1 - groupProgress, 3);
          overheadPhase = stepInfo.groupStartAbs / totalLoop + easedProgress * (stepInfo.groupSize / totalLoop);
        }
      } else {
        v.currentSway += (0 - v.currentSway) * 10 * dt;
      }

      updatePuffs(puffsRef.current, dt);

      const visual: VisualSnapshot = {
        isPlaying: transportStarted,
        isFillActive: flags.isFillActive,
        ghostMuted: flags.ghostMuted,
        phraseLength: s.phraseLength,
        currentMeasure: flags.currentMeasure,
        currentSway: v.currentSway,
        polyRatio: s.polyRatio,
        polyPulse: flags.polyPulse,
        theta: v.theta,
        scrollX: v.scrollX
      };

      const ctx = cvRef.current?.getContext('2d');
      if (ctx) {
        ctx.setTransform(v.scale, 0, 0, v.scale, 0, 0);
        ctx.clearRect(0, 0, WW, WH);
        renderBackdrop(ctx, v.scrollX);
        if (s.visualMode === 'creature') {
          const genome = makeCreatureGenome(s);
          const genomeId = getGenomeId(genome);
          if (!creatureRef.current || creatureRef.current.id !== genomeId) {
            creatureRef.current = buildCreature(genome);
            setCreatureName(creatureRef.current.name);
          }
          renderCreatureScene(ctx, visual, creatureRef.current, dt, currentQuarterNote);
        } else {
          renderTrainScene(ctx, visual, puffsRef.current);
        }
      }

      const ctxOver = cvOverRef.current?.getContext('2d');
      if (ctxOver) {
        ctxOver.setTransform(v.scale, 0, 0, v.scale, 0, 0);
        ctxOver.clearRect(0, 0, WW, WH_OVER);
        renderOverhead(ctxOver, visual, overheadPhase);
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [resizeCanvases]);

  // Tear the audio graph down when leaving the page (the Transport is global).
  useEffect(() => {
    return () => {
      const Tone = toneRef.current;
      if (!Tone) return;
      Tone.Transport.stop();
      if (polyEventRef.current !== null) Tone.Transport.clear(polyEventRef.current);
      sequenceRef.current?.dispose();
      sequenceRef.current = null;
      const synths = synthsRef.current;
      if (synths) {
        Object.values(synths).forEach(synth => synth.dispose());
      }
      synthsRef.current = null;
      toneRef.current = null;
    };
  }, []);

  // --- Render helpers ---
  const tapScore = tapStats.lastMs === null ? null : Math.round(clamp(100 - Math.abs(tapStats.lastMs) * 1.35, 0, 100));
  const maxPulses = Math.min(8, Math.max(2, euclidSteps - 1));
  const polyReadout =
    polyRatio === 0
      ? 'Off'
      : `${polyRatio} over ${total}${polyPulseDisplay !== null ? ` · pulse ${polyPulseDisplay + 1}` : ''}`;

  const dotClass = (i: number): string => {
    if (!isPlaying || !activeStep) return 're-dot';
    if (i < activeStep.measure - 1) return 're-dot done';
    if (i === activeStep.measure - 1) {
      if (activeStep.ghost) return 're-dot ghostnow';
      if (activeStep.fill) return 're-dot fillnow';
      return 're-dot now';
    }
    return 're-dot';
  };

  const leftPillOn = !activeStep || activeStep.side === 0;

  return (
    <section className="rhythm-engine">
      <header className="re-header">
        <div className="re-brand">
          <span className="re-brand-icon">
            <IconGear />
          </span>
          <div>
            <h2 className="re-title">
              Rhythm Engine <span className="re-accent-text">NEXT</span>
            </h2>
            <p className="re-subtitle">Kinetic Groove Simulator + Biological Renderer</p>
          </div>
        </div>
        <EngineSwitch active="rhythm" />
        <div className="re-status">
          <span className={`re-status-dot${audioReady ? ' on' : ''}`} />
          <span className={audioReady ? 're-status-text on' : 're-status-text'}>
            {audioReady ? 'Engine Active' : 'Engine Cold'}
          </span>
        </div>
      </header>

      <div className="re-grid">
        {/* Left sidebar: controls */}
        <div className="re-col-left">
          <div className="re-panel">
            <button type="button" className={`re-play-btn${isPlaying ? ' halt' : ''}`} onClick={togglePlay}>
              {isPlaying ? <IconStop /> : <IconPlay />}
              <span>{isPlaying ? 'Halt Engine' : 'Start Engine'}</span>
            </button>

            <div className="re-sliders">
              <div>
                <div className="re-slider-head">
                  <label htmlFor="re-bpm">
                    Metabolism <span className="re-dim">(BPM)</span>
                  </label>
                  <span className="re-slider-val">{bpm}</span>
                </div>
                <input
                  id="re-bpm"
                  type="range"
                  min={60}
                  max={240}
                  step={1}
                  value={bpm}
                  onChange={e => setBpm(parseInt(e.target.value, 10))}
                />
              </div>
              <div>
                <div className="re-slider-head">
                  <label htmlFor="re-swing">Elasticity / Swing</label>
                  <span className="re-slider-val">{Math.round(swing * 100)}%</span>
                </div>
                <input
                  id="re-swing"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={swing}
                  onChange={e => setSwing(parseFloat(e.target.value))}
                />
              </div>
              <div>
                <div className="re-slider-head">
                  <label htmlFor="re-phrase">
                    Memory Cycle <span className="re-dim">(Measures)</span>
                  </label>
                  <span className="re-slider-val">{phraseLength}</span>
                </div>
                <input
                  id="re-phrase"
                  type="range"
                  min={1}
                  max={8}
                  step={1}
                  value={phraseLength}
                  onChange={e => setPhraseLength(parseInt(e.target.value, 10))}
                />
              </div>
            </div>
          </div>

          <button
            type="button"
            className={`re-panel re-toggle-card${drumsEnabled ? ' on' : ''}`}
            onClick={() => setDrumsEnabled(d => !d)}
            role="switch"
            aria-checked={drumsEnabled}
          >
            <div className="re-toggle-info">
              <span className="re-toggle-icon">
                <IconDrum />
              </span>
              <div>
                <h3>Armor &amp; Claws (Drums)</h3>
                <p>Auto-generates drum patterns</p>
              </div>
            </div>
            <span className={`re-switch${drumsEnabled ? ' on' : ''}`} aria-hidden>
              <span className="re-switch-knob" />
            </span>
          </button>

          <div className="re-panel re-stack">
            <div className="re-panel-head">
              <div>
                <h3>Practice Lab</h3>
                <p>Train the clock, not just the ear</p>
              </div>
              <span className="re-accent-text">
                <IconWave />
              </span>
            </div>

            <button
              type="button"
              className={`re-micro-card re-ghost-btn${ghostMode ? ' on' : ''}`}
              onClick={() => setGhostMode(g => !g)}
            >
              <div>
                <div className="re-ghost-title">Ghost Mode</div>
                <div className="re-ghost-desc">Reveal the inner clock. End of loop goes silent. (G)</div>
              </div>
              <span className={`re-pill${ghostMode ? ' on' : ''}`}>{ghostMode ? 'On' : 'Off'}</span>
            </button>

            <div className="re-micro-card re-stack-sm">
              <div className="re-row-between">
                <span className="re-micro-label">Parasite Orbit (Poly)</span>
                <span className="re-readout">{polyReadout}</span>
              </div>
              <select
                className="re-select"
                value={polyRatio}
                onChange={e => setPolyRatio(parseInt(e.target.value, 10))}
                aria-label="Polyrhythm pulses per bar"
              >
                <option value={0}>Off</option>
                <option value={3}>3 over the bar</option>
                <option value={4}>4 over the bar</option>
                <option value={5}>5 over the bar</option>
                <option value={7}>7 over the bar</option>
              </select>
            </div>

            <div className="re-tap-row">
              <button type="button" className="re-tap-btn" onClick={handleTap}>
                Tap
                <span>Space</span>
              </button>
              <div className="re-micro-card re-tap-stats">
                <div>
                  <div className="re-micro-label">Last</div>
                  <div className="re-big-number">
                    {tapStats.lastMs === null ? '—' : `${tapStats.lastMs > 0 ? '+' : ''}${Math.round(tapStats.lastMs)}`}
                  </div>
                </div>
                <div>
                  <div className="re-micro-label">Score</div>
                  <div className="re-big-number">{tapScore === null ? '—' : tapScore}</div>
                </div>
                <div>
                  <div className="re-micro-label">Streak</div>
                  <div className="re-big-number">{tapStats.streak}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="re-panel re-stack">
            <div>
              <h3>Euclidean Foundry</h3>
              <p className="re-panel-sub">Generate alien pulse blueprints</p>
            </div>
            <div>
              <div className="re-slider-head sm">
                <label htmlFor="re-eu-steps">Segments</label>
                <span className="re-slider-val sm">{euclidSteps}</span>
              </div>
              <input
                id="re-eu-steps"
                type="range"
                min={5}
                max={16}
                step={1}
                value={euclidSteps}
                onChange={e => setEuclidSteps(parseInt(e.target.value, 10))}
              />
            </div>
            <div>
              <div className="re-slider-head sm">
                <label htmlFor="re-eu-pulses">Limbs</label>
                <span className="re-slider-val sm">{euclidPulses}</span>
              </div>
              <input
                id="re-eu-pulses"
                type="range"
                min={2}
                max={maxPulses}
                step={1}
                value={Math.min(euclidPulses, maxPulses)}
                onChange={e => setEuclidPulses(parseInt(e.target.value, 10))}
              />
            </div>
            <div>
              <div className="re-slider-head sm">
                <label htmlFor="re-eu-offset">Chirality (Rotation)</label>
                <span className="re-slider-val sm">{euclidOffset}</span>
              </div>
              <input
                id="re-eu-offset"
                type="range"
                min={0}
                max={euclidSteps - 1}
                step={1}
                value={Math.min(euclidOffset, euclidSteps - 1)}
                onChange={e => setEuclidOffset(parseInt(e.target.value, 10))}
              />
            </div>
            <div className="re-euclid-preview">
              {euclidPattern.map((on, i) => (
                <span key={i} className={`re-euclid-dot${on ? ' on' : ''}`}>
                  {i + 1}
                </span>
              ))}
            </div>
            <button type="button" className="re-secondary-btn" onClick={synthesizeOrganism}>
              Synthesize Organism
            </button>
          </div>

          <div className="re-panel re-stack">
            <h3 className="re-micro-label lg">Select DNA Blueprint</h3>
            <div className="re-sig-list">
              {rhythms.map(rhythm => (
                <button
                  type="button"
                  key={rhythm.id}
                  className={`re-sig-btn${rhythm.id === currentRhythm.id ? ' active' : ''}`}
                  onClick={() => setCurrentRhythmId(rhythm.id)}
                >
                  <span>
                    {rhythm.label} <small>{rhythm.name}</small>
                  </span>
                  <span className="re-chevron">›</span>
                </button>
              ))}
            </div>
          </div>

          <div className="re-panel re-stack">
            <div>
              <h3>Take This Groove Elsewhere</h3>
              <p className="re-panel-sub">
                {currentRhythm.label} at {bpm} BPM{swing > 0 ? ` · ${Math.round(swing * 100)}% swing` : ''} travels
                with you
              </p>
            </div>
            <button type="button" className="re-secondary-btn" onClick={handleSendToStage}>
              Jam it on the Stage →
            </button>
            <button type="button" className="re-secondary-btn" onClick={handleSendToStudio}>
              Set the Studio song →
            </button>
          </div>
        </div>

        {/* Right content: visualizer & details */}
        <div className="re-col-right">
          <div className="re-viz">
            <div className="re-viz-overlay">
              <div className="re-mode-switch">
                <button
                  type="button"
                  className={`re-mode-btn${visualMode === 'train' ? ' on' : ''}`}
                  onClick={() => setVisualMode('train')}
                >
                  Locomotive
                </button>
                <button
                  type="button"
                  className={`re-mode-btn${visualMode === 'creature' ? ' on' : ''}`}
                  onClick={() => setVisualMode('creature')}
                >
                  Organism
                </button>
              </div>
              <h2 className="re-viz-title">{currentRhythm.label}</h2>
              <p className="re-viz-subtitle">{visualMode === 'train' ? currentRhythm.name : creatureName}</p>
            </div>

            <div className="re-measure-dots">
              {Array.from({ length: phraseLength }, (_, i) => (
                <span key={i} className={dotClass(i)} />
              ))}
            </div>

            <div className="re-canvas-main">
              <canvas ref={cvRef} className="re-canvas" />
            </div>

            <div className="re-overhead">
              <div className="re-overhead-label">
                <span className="re-micro-label">Overhead Telemetry</span>
              </div>
              <canvas ref={cvOverRef} className="re-canvas" />
            </div>

            <div className="re-lamps-bar">
              <div className="re-pills">
                <span className={`re-pill${leftPillOn ? ' on' : ''}`}>Left</span>
                <span className={`re-pill${!leftPillOn ? ' on' : ''}`}>Right</span>
              </div>
              <div className="re-lamps">
                {lamps.map(lamp => {
                  const isActive = isPlaying && activeStep?.subIndex === lamp.index;
                  const classes = ['re-lamp'];
                  if (isActive) {
                    classes.push('active');
                    if (activeStep?.fill) classes.push('fill-mode');
                    if (activeStep?.ghost) classes.push('ghost-mode');
                  }
                  return (
                    <div key={lamp.index} className={classes.join(' ')}>
                      <div className="re-lamp-n">{lamp.index + 1}</div>
                      <div className={`re-lamp-lab${lamp.sideLabel ? '' : ' blank'}`}>{lamp.sideLabel ?? '-'}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="re-panel">
            <div className="re-panel-title">
              <h3>Pulse Physics</h3>
            </div>
            <div className="re-dna-grid">
              <div className="re-micro-card">
                <div className="re-micro-label">Density</div>
                <div className="re-big-number">{physics.density.toFixed(2)}</div>
                <div className="re-card-note">pulse groups / step</div>
              </div>
              <div className="re-micro-card">
                <div className="re-micro-label">Asymmetry</div>
                <div className="re-big-number">{physics.asymmetry.toFixed(2)}</div>
                <div className="re-card-note">0 = perfectly even</div>
              </div>
              <div className="re-micro-card">
                <div className="re-micro-label">Long/short</div>
                <div className="re-big-number">{physics.longShortRatio.toFixed(1)}×</div>
                <div className="re-card-note">mechanical leverage</div>
              </div>
            </div>
            <div className="re-block">
              <div className="re-row-between">
                <span className="re-micro-label">Tension map</span>
                <span className="re-readout">{`Blueprint ${grouping.join('+')} across ${total} subdivisions`}</span>
              </div>
              <div className="re-tension-map">
                {grouping.map((g, i) => {
                  const h = 22 + (g / physics.maxGroup) * 68;
                  return (
                    <div key={i} className="re-tension-seg" style={{ '--h': `${h}%` } as CSSProperties}>
                      <span>
                        {i % 2 === 0 ? 'L' : 'R'}:{g}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="re-block">
              <div className="re-row-between">
                <span className="re-micro-label">Tap timing cloud</span>
                <span className="re-readout">{tapAdvice}</span>
              </div>
              <div className="re-coach-lane">
                {tapStats.history.map((v, i) => (
                  <span
                    key={i}
                    className={`re-coach-hit${i === tapStats.history.length - 1 ? ' best' : ''}`}
                    style={{ left: `${clamp(((v + 120) / 240) * 100, 0, 100)}%` }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="re-panel">
            <div className="re-panel-title">
              <h3>Mechanics &amp; Mnemonics</h3>
            </div>
            <div className="re-mnemonics-grid">
              <div>
                <h4 className="re-accent-label">How it feels</h4>
                <p className="re-feel">{currentRhythm.feel}</p>
              </div>
              <div className="re-mnemonic-card">
                <h4 className="re-accent-label">Mnemonic Anchor</h4>
                {/* Mnemonics are app-defined strings with <b> emphasis markers. */}
                <p className="re-mnemonic" dangerouslySetInnerHTML={{ __html: currentRhythm.mnemonic }} />
                <p className="re-mnemonic-note">
                  Say this out loud as the engine plays. The bold syllables land on the strong pulses.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
