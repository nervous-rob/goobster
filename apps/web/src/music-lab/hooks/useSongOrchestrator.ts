import { useCallback, useEffect, useRef, useState } from 'react';
import { GRID_NOTATION, totalSubdivisions, type GridResolution } from '@music-lab/lib/rhythmTheory';
import { strongSubIndices, type PerformerRole } from '@music-lab/lib/stageData';
import type { ResolvedNote } from '@music-lab/lib/melodyTheory';
import type { ChordEvent } from '@music-lab/lib/songTheory';
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

export interface SongRuntimeTrack {
  id: string;
  role: PerformerRole;
  mute: boolean;
  /** Channel level in dB. */
  volume: number;
  voiceId?: string;
  /** Per absolute measure: clip coverage × solo logic. */
  audible: boolean[];
  /** Drum roles: one step per subdivision of a bar (loops every measure). */
  drumSteps?: boolean[];
  /** Bass/melody roles: note lanes for the whole song, [measure][sub]. */
  melodyNotes?: (ResolvedNote | null)[][];
  /** Chord roles: strum events per absolute measure. */
  chordEvents?: (ChordEvent | null)[];
}

export interface SongOrchestratorConfig {
  bpm: number;
  swing: number;
  /** Grouping in grid steps (already scaled to the resolution, see gridGrouping). */
  grouping: number[];
  /** Duration of one grid step; defaults to eighth notes. */
  resolution?: GridResolution;
  totalMeasures: number;
  /** Fraction of each chord window held. */
  harmonyHold: number;
  /** Per absolute measure: does an automatic drum fill end this bar? */
  fillMeasures?: boolean[];
  /** Grid steps the fill occupies before the bar line (0 = fills off). */
  fillLengthSubs?: number;
  loop: boolean;
  /** Loop / play region in absolute measures (end exclusive). */
  loopStartMeasure: number;
  loopEndMeasure: number;
  masterVolume: number;
  reverbWet: number;
  tracks: SongRuntimeTrack[];
}

export interface SongOrchestratorCallbacks {
  onStep?: (measure: number, subIndex: number) => void;
  onPlayState?: (playing: boolean) => void;
  onTrigger?: (trackId: string, intensity: number, midi?: number) => void;
}

const DEFAULT_CONFIG: SongOrchestratorConfig = {
  bpm: 100,
  swing: 0,
  grouping: [2, 2, 2, 2],
  totalMeasures: 0,
  harmonyHold: 0.96,
  loop: true,
  loopStartMeasure: 0,
  loopEndMeasure: 0,
  masterVolume: -2,
  reverbWet: 0.28,
  tracks: []
};

interface PlayRegion {
  startStep: number;
  endStep: number;
  subs: number;
}

function playRegion(cfg: SongOrchestratorConfig): PlayRegion {
  const subs = Math.max(1, totalSubdivisions(cfg.grouping));
  const total = Math.max(1, cfg.totalMeasures);
  const start = Math.max(0, Math.min(cfg.loopStartMeasure, total - 1));
  const end = Math.max(start + 1, Math.min(cfg.loopEndMeasure || total, total));
  return { startStep: start * subs, endStep: end * subs, subs };
}

/**
 * Whole-song Transport conductor for the Studio. Unlike the Stage's uniform
 * looping phrase, songs are heterogeneous: an internal step counter walks the
 * absolute-measure timeline, every track is gated per measure by its clip
 * coverage, and chord strums fire wherever a flattened chord window begins.
 * Supports seeking to any measure and looping the song or a sub-region.
 */
export function useSongOrchestrator() {
  const toneRef = useRef<ToneModule | null>(null);
  const drumsRef = useRef<DrumSynths | null>(null);
  const sharedRef = useRef<SharedNodes | null>(null);
  const instrumentsRef = useRef<Map<string, TonalInstrument>>(new Map());
  const repeatEventRef = useRef<number | null>(null);
  const repeatNotationRef = useRef<'8n' | '16n'>('8n');
  const recorderRef = useRef<import('tone').Recorder | null>(null);
  const configRef = useRef<SongOrchestratorConfig>(DEFAULT_CONFIG);
  const callbacksRef = useRef<SongOrchestratorCallbacks>({});
  const stepRef = useRef(0);
  const playingRef = useRef(false);
  const pausedRef = useRef(false);

  const [audioReady, setAudioReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  /** Creates/destroys tonal instruments so the audio graph matches the tracks. */
  const ensureInstruments = useCallback(() => {
    const Tone = toneRef.current;
    const shared = sharedRef.current;
    if (!Tone || !shared) return;

    const cfg = configRef.current;
    const wanted = new Map(cfg.tracks.filter(t => !['kick', 'snare', 'hihat'].includes(t.role)).map(t => [t.id, t]));
    const instruments = instrumentsRef.current;

    Array.from(instruments.entries()).forEach(([id, inst]) => {
      const track = wanted.get(id);
      if (
        !track ||
        (track.voiceId ?? 'glass-pad') !== inst.voiceId ||
        track.role !== inst.role ||
        (inst.samplerPending && !samplerPendingFor(findVoice(inst.voiceId)))
      ) {
        inst.synth.dispose();
        inst.bus.dispose();
        instruments.delete(id);
      }
    });

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
  }, []);

  const applyMix = useCallback(() => {
    const shared = sharedRef.current;
    if (!shared) return;
    const cfg = configRef.current;
    shared.master.gain.rampTo(dbToGain(cfg.masterVolume), 0.05);
    shared.chordReverb.wet.rampTo(cfg.reverbWet, 0.05);

    cfg.tracks.forEach(t => {
      const level = t.mute ? 0 : dbToGain(t.volume);
      if (t.role === 'kick' || t.role === 'snare' || t.role === 'hihat') {
        // Drum tracks share role buses; the loudest unmuted track wins the bus.
        return;
      }
      instrumentsRef.current.get(t.id)?.bus.gain.rampTo(level, 0.05);
    });

    (['kick', 'snare', 'hihat'] as const).forEach(role => {
      const live = cfg.tracks.filter(t => t.role === role && !t.mute);
      const level = live.length ? Math.max(...live.map(t => dbToGain(t.volume))) : 0;
      shared.drumBuses[role].gain.rampTo(level, 0.05);
    });
  }, []);

  const applyTransportSettings = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone) return;
    const cfg = configRef.current;
    Tone.Transport.bpm.value = cfg.bpm;
    Tone.Transport.swing = cfg.swing;
    Tone.Transport.swingSubdivision = GRID_NOTATION[cfg.resolution ?? 'eighth'];
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

  const releaseAllChords = useCallback(() => {
    instrumentsRef.current.forEach(inst => {
      if (inst.role === 'chords') {
        (inst.synth as import('tone').PolySynth).releaseAll?.();
      }
    });
  }, []);

  const clearRepeat = useCallback(() => {
    const Tone = toneRef.current;
    if (Tone && repeatEventRef.current !== null) {
      Tone.Transport.clear(repeatEventRef.current);
    }
    repeatEventRef.current = null;
  }, []);

  const haltPlayback = useCallback(
    (resetToRegionStart: boolean) => {
      const Tone = toneRef.current;
      playingRef.current = false;
      pausedRef.current = false;
      setIsPlaying(false);
      if (resetToRegionStart) {
        stepRef.current = playRegion(configRef.current).startStep;
      }
      if (Tone) {
        Tone.Transport.stop();
        clearRepeat();
        releaseAllChords();
        Tone.Transport.position = 0;
      }
      callbacksRef.current.onPlayState?.(false);
    },
    [clearRepeat, releaseAllChords]
  );

  const tick = useCallback(
    (time: number) => {
      const Tone = toneRef.current;
      const drums = drumsRef.current;
      if (!Tone || !drums) return;

      const cfg = configRef.current;
      const region = playRegion(cfg);
      let step = stepRef.current;

      if (step < region.startStep) step = region.startStep;
      if (step >= region.endStep) {
        if (cfg.loop) {
          step = region.startStep;
        } else {
          Tone.Draw.schedule(() => {
            if (playingRef.current) haltPlayback(true);
          }, time);
          return;
        }
      }

      const subs = region.subs;
      const measure = Math.floor(step / subs);
      const sub = step % subs;
      const strongSubs = strongSubIndices(cfg.grouping);
      const isStrong = strongSubs.includes(sub);
      const stepSeconds = Tone.Time(GRID_NOTATION[cfg.resolution ?? 'eighth']).toSeconds();
      const measureSeconds = subs * stepSeconds;
      const fired: { id: string; intensity: number; midi?: number }[] = [];

      // Automatic drum fill: occupies the tail of designated measures.
      // Snare and hats yield to the fill run; the kick keeps driving.
      const fillLength = Math.min(cfg.fillLengthSubs ?? 0, Math.max(0, subs - 1));
      const fillStart = subs - fillLength;
      const inFill = fillLength > 0 && (cfg.fillMeasures?.[measure] ?? false) && sub >= fillStart;

      if (inFill) {
        const liveDrums = cfg.tracks.filter(
          t => (t.role === 'kick' || t.role === 'snare' || t.role === 'hihat') && !t.mute && t.audible[measure]
        );
        if (liveDrums.length) {
          const velocity = triggerFillStep(drums, sub - fillStart, fillLength, time);
          const visual = liveDrums.find(t => t.role === 'snare') ?? liveDrums[0];
          fired.push({ id: visual.id, intensity: velocity });
        }
      }

      cfg.tracks.forEach(t => {
        if (t.mute || !t.audible[measure]) return;

        if (t.role === 'kick' || t.role === 'snare' || t.role === 'hihat') {
          if (inFill && t.role !== 'kick') return;
          if (!t.drumSteps?.[sub]) return;
          if (t.role === 'kick') {
            drums.kick.triggerAttackRelease('C1', '8n', time);
            fired.push({ id: t.id, intensity: isStrong ? 1 : 0.7 });
          } else if (t.role === 'snare') {
            drums.snareNoise.triggerAttackRelease('8n', time);
            drums.snareBody.triggerAttackRelease('G3', '8n', time);
            fired.push({ id: t.id, intensity: 0.85 });
          } else {
            drums.hihat.triggerAttackRelease(400, '32n', time);
            fired.push({ id: t.id, intensity: 0.5 });
          }
          return;
        }

        const inst = instrumentsRef.current.get(t.id);
        if (!inst) return;

        if (t.role === 'chords') {
          if (sub !== 0) return;
          const event = t.chordEvents?.[measure];
          if (!event?.midi.length) return;
          const seconds = event.holdMeasures * measureSeconds * cfg.harmonyHold;
          event.midi.forEach((m, i) => {
            const freq = Tone.Frequency(m, 'midi').toFrequency();
            inst.synth.triggerAttackRelease(freq, seconds, time + i * 0.018, 0.85);
          });
          fired.push({ id: t.id, intensity: 0.9 });
          return;
        }

        const note = t.melodyNotes?.[measure]?.[sub];
        if (!note) return;
        const freq = Tone.Frequency(note.midi, 'midi').toFrequency();
        const dur = Math.max(0.05, note.durSubs * stepSeconds * 0.9);
        inst.synth.triggerAttackRelease(freq, dur, time, 0.8);
        fired.push({ id: t.id, intensity: t.role === 'bass' ? 0.75 : 0.65, midi: note.midi });
      });

      stepRef.current = step + 1;

      Tone.Draw.schedule(() => {
        callbacksRef.current.onStep?.(measure, sub);
        fired.forEach(f => callbacksRef.current.onTrigger?.(f.id, f.intensity, f.midi));
      }, time);
    },
    [haltPlayback]
  );

  const stop = useCallback(() => {
    haltPlayback(true);
  }, [haltPlayback]);

  const pause = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone || !playingRef.current) return;
    Tone.Transport.pause();
    playingRef.current = false;
    pausedRef.current = true;
    setIsPlaying(false);
    callbacksRef.current.onPlayState?.(false);
  }, []);

  const start = useCallback(async () => {
    await initAudio();
    const Tone = toneRef.current;
    if (!Tone) return;
    const cfg = configRef.current;
    if (!cfg.totalMeasures || !cfg.tracks.length) return;

    // Sample-engine voices need their clips decoded before instruments build.
    await preloadSampleBuffers(Tone, cfg.tracks.map(t => t.voiceId));

    applyTransportSettings();
    ensureInstruments();
    applyMix();

    if (pausedRef.current) {
      Tone.Transport.start();
      playingRef.current = true;
      pausedRef.current = false;
      setIsPlaying(true);
      callbacksRef.current.onPlayState?.(true);
      return;
    }

    Tone.Transport.stop();
    clearRepeat();
    Tone.Transport.position = 0;

    const region = playRegion(cfg);
    if (stepRef.current < region.startStep || stepRef.current >= region.endStep) {
      stepRef.current = region.startStep;
    }

    repeatNotationRef.current = GRID_NOTATION[cfg.resolution ?? 'eighth'];
    repeatEventRef.current = Tone.Transport.scheduleRepeat(tick, repeatNotationRef.current, 0);
    // Headroom so freshly-built instruments don't push the first beats late.
    Tone.Transport.start('+0.1');

    playingRef.current = true;
    pausedRef.current = false;
    setIsPlaying(true);
    callbacksRef.current.onPlayState?.(true);
  }, [applyMix, applyTransportSettings, clearRepeat, ensureInstruments, initAudio, tick]);

  const toggle = useCallback(async () => {
    if (playingRef.current) {
      pause();
    } else {
      await start();
    }
  }, [pause, start]);

  // --- Recording (captures everything routed through the master chain) ---

  const startRecording = useCallback(async (): Promise<boolean> => {
    await initAudio();
    const Tone = toneRef.current;
    const shared = sharedRef.current;
    if (!Tone || !shared || recorderRef.current) return false;
    const recorder = new Tone.Recorder();
    shared.compressor.connect(recorder);
    recorderRef.current = recorder;
    void recorder.start();
    setIsRecording(true);
    return true;
  }, [initAudio]);

  /** Stops the recorder and returns the captured audio (null if idle). */
  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;
    recorderRef.current = null;
    setIsRecording(false);
    let blob: Blob | null = null;
    try {
      blob = await recorder.stop();
    } catch {
      blob = null;
    }
    try {
      sharedRef.current?.compressor.disconnect(recorder);
    } catch {
      // Already disconnected.
    }
    recorder.dispose();
    return blob;
  }, []);

  /** Moves the playhead to the start of a measure (live or while stopped). */
  const seek = useCallback((measure: number) => {
    const cfg = configRef.current;
    const subs = Math.max(1, totalSubdivisions(cfg.grouping));
    const clamped = Math.max(0, Math.min(measure, Math.max(0, cfg.totalMeasures - 1)));
    stepRef.current = clamped * subs;
    releaseAllChords();
  }, [releaseAllChords]);

  const setConfig = useCallback(
    (config: SongOrchestratorConfig) => {
      configRef.current = config;
      const Tone = toneRef.current;
      if (!Tone) return;
      applyTransportSettings();
      ensureInstruments();
      applyMix();
      // Late-loading sample clips: decode, then swap placeholders for samplers.
      void preloadSampleBuffers(Tone, config.tracks.map(t => t.voiceId)).then(() => {
        ensureInstruments();
        applyMix();
      });
      // A resolution change mid-flight needs the repeat event rebuilt at the new step length.
      const notation = GRID_NOTATION[config.resolution ?? 'eighth'];
      if (repeatEventRef.current !== null && notation !== repeatNotationRef.current) {
        Tone.Transport.clear(repeatEventRef.current);
        repeatNotationRef.current = notation;
        // Anchored at 0 so the rebuilt repeat stays on the step grid instead
        // of re-anchoring at the current (mid-step) transport position.
        repeatEventRef.current = Tone.Transport.scheduleRepeat(tick, notation, 0);
      }
      // Keep the playhead inside the song if it shrank under us.
      const region = playRegion(config);
      if (stepRef.current >= region.endStep && !config.loop) {
        stepRef.current = Math.min(stepRef.current, region.endStep - 1);
      }
    },
    [applyMix, applyTransportSettings, ensureInstruments, tick]
  );

  const setCallbacks = useCallback((callbacks: SongOrchestratorCallbacks) => {
    callbacksRef.current = callbacks;
  }, []);

  useEffect(() => {
    return () => {
      const Tone = toneRef.current;
      if (Tone) {
        Tone.Transport.stop();
        if (repeatEventRef.current !== null) Tone.Transport.clear(repeatEventRef.current);
      }
      repeatEventRef.current = null;

      recorderRef.current?.dispose();
      recorderRef.current = null;

      instrumentsRef.current.forEach(inst => {
        inst.synth.dispose();
        inst.bus.dispose();
      });
      instrumentsRef.current.clear();

      const drums = drumsRef.current;
      if (drums) disposeDrumSynths(drums);
      const shared = sharedRef.current;
      if (shared) disposeSharedNodes(shared);

      drumsRef.current = null;
      sharedRef.current = null;
      toneRef.current = null;
    };
  }, []);

  return {
    audioReady,
    isPlaying,
    isRecording,
    setConfig,
    setCallbacks,
    start,
    stop,
    pause,
    toggle,
    seek,
    startRecording,
    stopRecording
  };
}
