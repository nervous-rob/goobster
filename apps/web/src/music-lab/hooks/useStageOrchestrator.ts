import { useCallback, useEffect, useRef, useState } from 'react';
import { GRID_NOTATION, buildSequenceArray, type GridResolution, type SequenceStep } from '@music-lab/lib/rhythmTheory';
import type { PerformerRole } from '@music-lab/lib/stageData';
import type { ResolvedNote } from '@music-lab/lib/melodyTheory';
import { findVoice } from '@music-lab/lib/voiceData';
import {
  buildMonoSynth,
  buildPolySynth,
  createDrumSynths,
  createSharedNodes,
  dbToGain,
  disposeDrumSynths,
  disposeSharedNodes,
  preloadSampleBuffers,
  resolveTone,
  samplerPendingFor,
  triggerFillStep,
  type DrumSynths,
  type SharedNodes,
  type TonalInstrument,
  type TonalSynth,
  type ToneModule
} from '@music-lab/lib/stageInstruments';

export interface StagePerformerTrack {
  id: string;
  role: PerformerRole;
  enabled: boolean;
  mute: boolean;
  volume: number;
  voiceId?: string;
  /** Drum roles: one step per subdivision of the bar. */
  drumSteps?: boolean[];
  /** Bass/melody roles: precomputed note lanes, [measureIndex][subIndex]. */
  melodyNotes?: (ResolvedNote | null)[][];
  /** Chord organisms: voiced midi per chord window. */
  chordSteps?: number[][];
}

export interface StageOrchestratorConfig {
  bpm: number;
  swing: number;
  /** Grouping in grid steps (already scaled to the resolution, see gridGrouping). */
  grouping: number[];
  /** Duration of one grid step; defaults to eighth notes. */
  resolution?: GridResolution;
  /** Total logical measures in the phrase. */
  phraseLength: number;
  /** Logical measures each chord window occupies. */
  measuresPerChord: number;
  /** Fraction of the chord window held (0.4–1). */
  harmonyHold: number;
  /** Per phrase measure: does an automatic drum fill end this bar? */
  fillMeasures?: boolean[];
  /** Grid steps the fill occupies before the bar line (0 = fills off). */
  fillLengthSubs?: number;
  loop: boolean;
  masterVolume: number;
  reverbWet: number;
  performers: StagePerformerTrack[];
}

export interface StageOrchestratorCallbacks {
  onRhythmStep?: (step: SequenceStep) => void;
  onHarmonyStep?: (index: number) => void;
  onPlayState?: (playing: boolean) => void;
  /** Fired whenever a creature actually makes a sound, keyed by performer id. */
  onTrigger?: (performerId: string, intensity: number, midi?: number) => void;
}

const DEFAULT_CONFIG: StageOrchestratorConfig = {
  bpm: 100,
  swing: 0,
  grouping: [2, 2, 2, 2],
  phraseLength: 4,
  measuresPerChord: 1,
  harmonyHold: 0.96,
  loop: true,
  masterVolume: -2,
  reverbWet: 0.28,
  performers: []
};

/**
 * Shared Transport conductor for a dynamic creature troupe. Every performer
 * gets an id-keyed gain bus; tonal performers get an instrument built from
 * their voice preset, reconciled whenever the cast changes. Drums and
 * single-note creatures fire from one step sequence at the configured grid
 * resolution (eighths or sixteenths); chord organisms strum on chord-window
 * boundaries (shared song lane or their own).
 */
export function useStageOrchestrator() {
  const toneRef = useRef<ToneModule | null>(null);
  const drumsRef = useRef<DrumSynths | null>(null);
  const sharedRef = useRef<SharedNodes | null>(null);
  const instrumentsRef = useRef<Map<string, TonalInstrument>>(new Map());
  const sequenceRef = useRef<import('tone').Sequence<SequenceStep> | null>(null);
  const harmonyEventRef = useRef<number | null>(null);
  const phraseEndRef = useRef<number | null>(null);
  const seqStepsRef = useRef<SequenceStep[]>([]);
  const configRef = useRef<StageOrchestratorConfig>(DEFAULT_CONFIG);
  const callbacksRef = useRef<StageOrchestratorCallbacks>({});
  const playingRef = useRef(false);
  const pausedRef = useRef(false);

  const [audioReady, setAudioReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  const disposeInstrument = useCallback((inst: TonalInstrument) => {
    inst.synth.dispose();
    inst.bus.dispose();
  }, []);

  /** Creates/destroys tonal instruments so the audio graph matches the cast. */
  const ensureInstruments = useCallback(() => {
    const Tone = toneRef.current;
    const shared = sharedRef.current;
    if (!Tone || !shared) return;

    const cfg = configRef.current;
    const wanted = new Map(cfg.performers.filter(p => !['kick', 'snare', 'hihat'].includes(p.role)).map(p => [p.id, p]));
    const instruments = instrumentsRef.current;

    // Remove instruments for performers no longer in the cast, whose voice or
    // role changed, or whose sample clip has finished loading (placeholder →
    // real sampler).
    Array.from(instruments.entries()).forEach(([id, inst]) => {
      const track = wanted.get(id);
      if (
        !track ||
        (track.voiceId ?? 'glass-pad') !== inst.voiceId ||
        track.role !== inst.role ||
        (inst.samplerPending && !samplerPendingFor(findVoice(inst.voiceId)))
      ) {
        disposeInstrument(inst);
        instruments.delete(id);
      }
    });

    // Create missing instruments.
    wanted.forEach((track, id) => {
      if (instruments.has(id)) return;
      const voice = findVoice(track.voiceId);
      const bus = new Tone.Gain(0);
      let synth: TonalSynth;
      if (track.role === 'chords') {
        synth = buildPolySynth(Tone, voice);
        synth.connect(bus);
        bus.connect(shared.chordChorus);
      } else {
        synth = buildMonoSynth(Tone, voice);
        synth.connect(bus);
        if (track.role === 'melody') {
          bus.connect(shared.leadChorus);
        } else {
          bus.connect(shared.master);
        }
      }
      instruments.set(id, { voiceId: voice.id, role: track.role, synth, bus, samplerPending: samplerPendingFor(voice) });
    });
  }, [disposeInstrument]);

  const applyMix = useCallback(() => {
    const shared = sharedRef.current;
    if (!shared) return;
    const cfg = configRef.current;
    shared.master.gain.rampTo(dbToGain(cfg.masterVolume), 0.05);
    shared.chordReverb.wet.rampTo(cfg.reverbWet, 0.05);

    cfg.performers.forEach(p => {
      const level = p.mute || !p.enabled ? 0 : dbToGain(p.volume);
      if (p.role === 'kick' || p.role === 'snare' || p.role === 'hihat') {
        shared.drumBuses[p.role]?.gain.rampTo(level, 0.05);
      } else {
        instrumentsRef.current.get(p.id)?.bus.gain.rampTo(level, 0.05);
      }
    });
  }, []);

  const initAudio = useCallback(async (): Promise<ToneModule> => {
    if (toneRef.current && drumsRef.current && sharedRef.current) {
      await toneRef.current.start();
      ensureInstruments();
      applyMix();
      return toneRef.current;
    }

    const Tone = await resolveTone();
    const shared = await createSharedNodes(Tone, DEFAULT_CONFIG.masterVolume, DEFAULT_CONFIG.reverbWet);

    toneRef.current = Tone;
    drumsRef.current = createDrumSynths(Tone, shared);
    sharedRef.current = shared;
    setAudioReady(true);
    ensureInstruments();
    applyMix();
    return Tone;
  }, [applyMix, ensureInstruments]);

  const strumChords = useCallback(
    (Tone: ToneModule, synth: TonalSynth, midi: number[], seconds: number, startTime: number) => {
      midi.forEach((m, i) => {
        const freq = Tone.Frequency(m, 'midi').toFrequency();
        synth.triggerAttackRelease(freq, seconds, startTime + i * 0.018, 0.85);
      });
    },
    []
  );

  const clearScheduledEvents = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone) return;
    if (harmonyEventRef.current !== null) {
      Tone.Transport.clear(harmonyEventRef.current);
      harmonyEventRef.current = null;
    }
    if (phraseEndRef.current !== null) {
      Tone.Transport.clear(phraseEndRef.current);
      phraseEndRef.current = null;
    }
  }, []);

  const rebuildRhythmSequence = useCallback(() => {
    const Tone = toneRef.current;
    const drums = drumsRef.current;
    if (!Tone || !drums) return;

    sequenceRef.current?.dispose();
    const config = configRef.current;
    seqStepsRef.current = buildSequenceArray(config.grouping, config.phraseLength);

    sequenceRef.current = new Tone.Sequence<SequenceStep>(
      (time, step) => {
        const cfg = configRef.current;
        const stepSeconds = Tone.Time(GRID_NOTATION[cfg.resolution ?? 'eighth']).toSeconds();
        const fired: { id: string; intensity: number; midi?: number }[] = [];

        // Automatic drum fill: occupies the tail of designated measures.
        // Snare and hats yield to the fill run; the kick keeps driving.
        const subsPerBar = cfg.grouping.reduce((a, b) => a + b, 0);
        const fillLength = Math.min(cfg.fillLengthSubs ?? 0, Math.max(0, subsPerBar - 1));
        const fillStart = subsPerBar - fillLength;
        const inFill =
          fillLength > 0 && (cfg.fillMeasures?.[step.measure - 1] ?? false) && step.subIndex >= fillStart;

        if (inFill) {
          const liveDrums = cfg.performers.filter(
            p => (p.role === 'kick' || p.role === 'snare' || p.role === 'hihat') && p.enabled && !p.mute
          );
          if (liveDrums.length) {
            const velocity = triggerFillStep(drums, step.subIndex - fillStart, fillLength, time);
            const visual = liveDrums.find(p => p.role === 'snare') ?? liveDrums[0];
            fired.push({ id: visual.id, intensity: velocity });
          }
        }

        cfg.performers.forEach(p => {
          if (!p.enabled || p.mute) return;

          if (p.role === 'kick' || p.role === 'snare' || p.role === 'hihat') {
            if (inFill && p.role !== 'kick') return;
            if (!p.drumSteps?.[step.subIndex]) return;
            if (p.role === 'kick') {
              drums.kick.triggerAttackRelease('C1', '8n', time);
              fired.push({ id: p.id, intensity: step.isStrong ? 1 : 0.7 });
            } else if (p.role === 'snare') {
              drums.snareNoise.triggerAttackRelease('8n', time);
              drums.snareBody.triggerAttackRelease('G3', '8n', time);
              fired.push({ id: p.id, intensity: 0.85 });
            } else {
              drums.hihat.triggerAttackRelease(400, '32n', time);
              fired.push({ id: p.id, intensity: 0.5 });
            }
            return;
          }

          if (p.role === 'bass' || p.role === 'melody') {
            const note = p.melodyNotes?.[step.measure - 1]?.[step.subIndex];
            if (!note) return;
            const inst = instrumentsRef.current.get(p.id);
            if (!inst) return;
            const freq = Tone.Frequency(note.midi, 'midi').toFrequency();
            const dur = Math.max(0.05, note.durSubs * stepSeconds * 0.9);
            inst.synth.triggerAttackRelease(freq, dur, time, 0.8);
            fired.push({ id: p.id, intensity: p.role === 'bass' ? 0.75 : 0.65, midi: note.midi });
          }
        });

        Tone.Draw.schedule(() => {
          callbacksRef.current.onRhythmStep?.(step);
          fired.forEach(f => callbacksRef.current.onTrigger?.(f.id, f.intensity, f.midi));
        }, time);
      },
      seqStepsRef.current,
      GRID_NOTATION[config.resolution ?? 'eighth']
    );
  }, []);

  const rebuildHarmonySchedule = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone) return;

    if (harmonyEventRef.current !== null) {
      Tone.Transport.clear(harmonyEventRef.current);
      harmonyEventRef.current = null;
    }

    const config = configRef.current;
    const hasChordLane = config.performers.some(p => p.role === 'chords' && p.chordSteps?.length);
    if (!hasChordLane) return;

    const subdivisions = config.grouping.reduce((a, b) => a + b, 0);
    const ticksPerStep = Tone.Transport.PPQ / (config.resolution === 'sixteenth' ? 4 : 2);
    const ticksPerMeasure = Math.max(1, subdivisions * ticksPerStep);
    const ticksPerChord = ticksPerMeasure * Math.max(1, config.measuresPerChord);
    const chordSeconds = Tone.Time(`${ticksPerChord}i`).toSeconds();

    // Anchored at tick 0 so the repeat stays on the measure grid even when
    // schedules are rebuilt mid-flight (without an explicit start time,
    // scheduleRepeat anchors at the *current* transport position). The chord
    // index is derived from the transport grid for the same reason: a
    // counter would restart at 0 on every live rebuild.
    harmonyEventRef.current = Tone.Transport.scheduleRepeat(
      time => {
        const cfg = configRef.current;
        const index = Math.max(0, Math.round(Tone.Transport.getTicksAtTime(time) / ticksPerChord));
        const audibleIds: string[] = [];

        cfg.performers.forEach(p => {
          if (p.role !== 'chords' || !p.enabled || p.mute) return;
          const lane = p.chordSteps;
          if (!lane?.length) return;
          const inst = instrumentsRef.current.get(p.id);
          if (!inst) return;
          const midi = lane[index % lane.length];
          if (midi?.length) {
            strumChords(Tone, inst.synth, midi, chordSeconds * cfg.harmonyHold, time);
            audibleIds.push(p.id);
          }
        });

        Tone.Draw.schedule(() => {
          callbacksRef.current.onHarmonyStep?.(index % Math.max(1, Math.round(cfg.phraseLength / Math.max(1, cfg.measuresPerChord))));
          audibleIds.forEach(id => callbacksRef.current.onTrigger?.(id, 0.9));
        }, time);
      },
      `${ticksPerChord}i`,
      0
    );
  }, [strumChords]);

  const schedulePhraseEnd = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone) return;
    if (phraseEndRef.current !== null) {
      Tone.Transport.clear(phraseEndRef.current);
      phraseEndRef.current = null;
    }

    const cfg = configRef.current;
    if (cfg.loop) return;

    const subdivisions = cfg.grouping.reduce((a, b) => a + b, 0);
    const ticksPerStep = Tone.Transport.PPQ / (cfg.resolution === 'sixteenth' ? 4 : 2);
    const phraseTicks = cfg.phraseLength * subdivisions * ticksPerStep;

    phraseEndRef.current = Tone.Transport.scheduleOnce(time => {
      Tone.Draw.schedule(() => {
        if (!configRef.current.loop && playingRef.current) {
          playingRef.current = false;
          pausedRef.current = false;
          setIsPlaying(false);
          Tone.Transport.pause();
          sequenceRef.current?.stop(0);
          callbacksRef.current.onPlayState?.(false);
        }
      }, time);
    }, `${phraseTicks}i`);
  }, []);

  const applyTransportSettings = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone) return;
    const config = configRef.current;
    Tone.Transport.bpm.value = config.bpm;
    Tone.Transport.swing = config.swing;
    Tone.Transport.swingSubdivision = GRID_NOTATION[config.resolution ?? 'eighth'];
  }, []);

  const rebuildSchedules = useCallback(() => {
    applyTransportSettings();
    ensureInstruments();
    applyMix();
    rebuildRhythmSequence();
    rebuildHarmonySchedule();
    schedulePhraseEnd();
  }, [applyMix, applyTransportSettings, ensureInstruments, rebuildHarmonySchedule, rebuildRhythmSequence, schedulePhraseEnd]);

  const releaseAllChords = useCallback(() => {
    instrumentsRef.current.forEach(inst => {
      if (inst.role === 'chords') {
        (inst.synth as import('tone').PolySynth).releaseAll?.();
      }
    });
  }, []);

  const stop = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone) {
      playingRef.current = false;
      pausedRef.current = false;
      setIsPlaying(false);
      return;
    }

    Tone.Transport.stop();
    sequenceRef.current?.stop(0);
    clearScheduledEvents();
    releaseAllChords();
    Tone.Transport.position = 0;
    playingRef.current = false;
    pausedRef.current = false;
    setIsPlaying(false);
    callbacksRef.current.onPlayState?.(false);
  }, [clearScheduledEvents, releaseAllChords]);

  const pause = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone || !playingRef.current) return;
    Tone.Transport.pause();
    sequenceRef.current?.stop(0);
    playingRef.current = false;
    pausedRef.current = true;
    setIsPlaying(false);
    callbacksRef.current.onPlayState?.(false);
  }, []);

  const start = useCallback(async () => {
    await initAudio();
    const hasContent = configRef.current.performers.some(
      p => p.chordSteps?.length || p.melodyNotes?.length || p.drumSteps?.length
    );
    if (!hasContent) return;

    const Tone = toneRef.current;
    if (!Tone) return;

    // Sample-engine voices need their clips decoded before instruments build.
    await preloadSampleBuffers(Tone, configRef.current.performers.map(p => p.voiceId));

    if (pausedRef.current) {
      applyTransportSettings();
      applyMix();
      sequenceRef.current?.start(0);
      Tone.Transport.start();
      playingRef.current = true;
      pausedRef.current = false;
      setIsPlaying(true);
      callbacksRef.current.onPlayState?.(true);
      return;
    }

    stop();
    rebuildSchedules();

    Tone.Transport.position = 0;
    sequenceRef.current?.start(0);
    // A little scheduling headroom: instruments may have just been rebuilt
    // (each audition swaps synths), and starting exactly at `now()` lets a
    // busy main thread push the first beats late.
    Tone.Transport.start('+0.1');

    playingRef.current = true;
    pausedRef.current = false;
    setIsPlaying(true);
    callbacksRef.current.onPlayState?.(true);
  }, [applyMix, applyTransportSettings, initAudio, rebuildSchedules, stop]);

  const toggle = useCallback(async () => {
    if (playingRef.current) {
      pause();
    } else {
      await start();
    }
  }, [pause, start]);

  const setConfig = useCallback(
    (config: StageOrchestratorConfig) => {
      configRef.current = config;
      const Tone = toneRef.current;
      if (!Tone) return;
      applyTransportSettings();
      ensureInstruments();
      applyMix();
      // Late-loading sample clips: decode, then swap placeholders for samplers.
      void preloadSampleBuffers(Tone, config.performers.map(p => p.voiceId)).then(() => {
        ensureInstruments();
        applyMix();
      });
      if (playingRef.current || pausedRef.current) {
        rebuildSchedules();
        if (playingRef.current) {
          sequenceRef.current?.start(0);
        }
      } else {
        rebuildRhythmSequence();
        rebuildHarmonySchedule();
        schedulePhraseEnd();
      }
    },
    [
      applyMix,
      applyTransportSettings,
      ensureInstruments,
      rebuildHarmonySchedule,
      rebuildRhythmSequence,
      rebuildSchedules,
      schedulePhraseEnd
    ]
  );

  const setCallbacks = useCallback((callbacks: StageOrchestratorCallbacks) => {
    callbacksRef.current = callbacks;
  }, []);

  useEffect(() => {
    return () => {
      const Tone = toneRef.current;
      if (Tone) {
        Tone.Transport.stop();
        if (harmonyEventRef.current !== null) Tone.Transport.clear(harmonyEventRef.current);
        if (phraseEndRef.current !== null) Tone.Transport.clear(phraseEndRef.current);
      }
      sequenceRef.current?.dispose();
      sequenceRef.current = null;
      harmonyEventRef.current = null;
      phraseEndRef.current = null;

      instrumentsRef.current.forEach(inst => {
        inst.synth.dispose();
        inst.bus.dispose();
      });
      instrumentsRef.current.clear();

      const drums = drumsRef.current;
      if (drums) {
        disposeDrumSynths(drums);
      }

      const shared = sharedRef.current;
      if (shared) {
        disposeSharedNodes(shared);
      }

      drumsRef.current = null;
      sharedRef.current = null;
      toneRef.current = null;
    };
  }, []);

  return {
    audioReady,
    isPlaying,
    setConfig,
    setCallbacks,
    start,
    stop,
    pause,
    toggle
  };
}
