import { useCallback, useEffect, useRef } from 'react';
import { NOTE_FREQUENCIES, type NoteName } from '@music-lab/lib/musicData';
import { computeFrequency, describeDuration, type ProgressionChord } from '@music-lab/lib/musicTheory';

type PlayMode = 'sequential' | 'together';

interface ProgressionOptions {
  tempo: number;
  playMode: PlayMode;
  loop: boolean;
  drumEnabled: boolean;
}

const isBrowser = typeof window !== 'undefined';

export function useAudioEngine() {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const progressionTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noiseBufferRef = useRef<AudioBuffer | null>(null);

  const getContext = useCallback(() => {
    if (!isBrowser) {
      throw new Error('AudioContext is unavailable on the server');
    }
    if (!audioCtxRef.current) {
      const AudioCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) {
        throw new Error('Web Audio API is not supported in this browser');
      }
      audioCtxRef.current = new AudioCtor();
    }
    return audioCtxRef.current;
  }, []);

  const ensureContext = useCallback(async () => {
    const context = getContext();
    const state = String(context.state);
    if (state !== 'running' && state !== 'closed') {
      const resume = context.resume();
      await resume;
    }
    if (String(context.state) !== 'running') {
      throw new Error(`Unable to start the audio context (state: ${context.state})`);
    }
    return context;
  }, [getContext]);

  const clearTimers = useCallback(() => {
    progressionTimersRef.current.forEach(timer => clearTimeout(timer));
    progressionTimersRef.current = [];
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
  }, []);

  const getNoiseBuffer = useCallback((ctx: AudioContext) => {
    if (noiseBufferRef.current) {
      return noiseBufferRef.current;
    }
    const length = ctx.sampleRate * 0.5;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    noiseBufferRef.current = buffer;
    return buffer;
  }, []);

  const playKick = useCallback(
    (ctx: AudioContext, start: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, start);
      osc.frequency.exponentialRampToValueAtTime(50, start + 0.15);
      gain.gain.setValueAtTime(1, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    },
    []
  );

  const playSnare = useCallback(
    (ctx: AudioContext, start: number) => {
      const src = ctx.createBufferSource();
      src.buffer = getNoiseBuffer(ctx);
      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 1000;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.8, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
      src.connect(bandpass).connect(gain).connect(ctx.destination);
      src.start(start);
      src.stop(start + 0.2);
    },
    [getNoiseBuffer]
  );

  const playHiHat = useCallback(
    (ctx: AudioContext, start: number) => {
      const src = ctx.createBufferSource();
      src.buffer = getNoiseBuffer(ctx);
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 8000;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.3, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.05);
      src.connect(highpass).connect(gain).connect(ctx.destination);
      src.start(start);
      src.stop(start + 0.05);
    },
    [getNoiseBuffer]
  );

  const playDrumsForChord = useCallback(
    (ctx: AudioContext, beats: number, tempo: number, startTime?: number) => {
      if (beats <= 0) {
        return;
      }
      const beatSeconds = 60 / tempo;
      const baseTime = typeof startTime === 'number' ? startTime : ctx.currentTime;
      for (let beat = 0; beat < beats; beat++) {
        const time = baseTime + beat * beatSeconds;
        playHiHat(ctx, time);
        if (beat === 0) {
          playKick(ctx, time);
        }
        if (beat % 2 === 1) {
          playSnare(ctx, time);
        }
      }
    },
    [playHiHat, playKick, playSnare]
  );

  const scheduleChord = useCallback(
    (
      ctx: AudioContext,
      root: NoteName,
      offsets: number[],
      mode: PlayMode,
      durationBeats = 1,
      tempo = 120,
      startTime?: number
    ) => {
      if (!isBrowser) {
        return;
      }
      const baseFreq = NOTE_FREQUENCIES[root];
      if (!baseFreq) {
        return;
      }
      const now = typeof startTime === 'number' ? startTime : ctx.currentTime;
      const freqs = offsets.map(offset => computeFrequency(baseFreq, offset));
      const safeTempo = Math.max(tempo, 1);
      const beats = Math.max(durationBeats, 0);
      const beatSeconds = 60 / safeTempo;
      const chordDurationSeconds = beats > 0 ? beats * beatSeconds : 0;
      if (mode === 'together') {
        const sustainSeconds = chordDurationSeconds > 0 ? chordDurationSeconds : 0.8;
        const noteCount = Math.max(freqs.length, 1);
        const fallbackSpacing = 0.15;
        const rawSpacing = chordDurationSeconds > 0 ? chordDurationSeconds / noteCount : fallbackSpacing;
        const spacing = Math.max(Math.min(rawSpacing, 0.35), 0.02);
        const attackSeconds = Math.min(0.05, sustainSeconds / 2);
        const minTotalTime = (noteCount - 1) * spacing + attackSeconds + 0.1;
        const releaseEndTime = now + Math.max(sustainSeconds, minTotalTime);
        const releaseStartOffset = 0.1;
        freqs.forEach((freq, index) => {
          const startTime = now + index * spacing;
          const releaseStartTime = Math.max(startTime + attackSeconds, releaseEndTime - releaseStartOffset);
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, startTime);
          gain.gain.setValueAtTime(0, startTime);
          gain.gain.linearRampToValueAtTime(0.6, startTime + attackSeconds);
          gain.gain.setValueAtTime(0.6, releaseStartTime);
          gain.gain.linearRampToValueAtTime(0, releaseEndTime);
          osc.connect(gain).connect(ctx.destination);
          osc.start(startTime);
          osc.stop(releaseEndTime);
        });
      } else {
        const noteCount = Math.max(freqs.length, 1);
        const fallbackSpacing = 0.35;
        const spacing = chordDurationSeconds > 0 ? chordDurationSeconds / noteCount : fallbackSpacing;
        const actualSpacing = Math.max(spacing, 0.01);
        const minDuration = Math.min(actualSpacing * 0.9, 0.02);
        let noteDuration = chordDurationSeconds > 0 ? actualSpacing * 0.8 : fallbackSpacing * 0.8;
        noteDuration = Math.max(noteDuration, minDuration);
        noteDuration = Math.min(noteDuration, actualSpacing);
        const attackPortion = Math.min(0.05, noteDuration / 2);
        freqs.forEach((freq, index) => {
          const start = now + index * actualSpacing;
          const end = start + noteDuration;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, start);
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.6, start + attackPortion);
          gain.gain.linearRampToValueAtTime(0, end);
          osc.connect(gain).connect(ctx.destination);
          osc.start(start);
          osc.stop(end);
        });
      }
    },
    []
  );

  const playChord = useCallback(
    async (
      root: NoteName,
      offsets: number[],
      mode: PlayMode,
      durationBeats = 1,
      tempo = 120,
      startTime?: number
    ) => {
      const ctx = await ensureContext();
      scheduleChord(ctx, root, offsets, mode, durationBeats, tempo, startTime);
    },
    [ensureContext, scheduleChord]
  );

  const playInterval = useCallback(
    async (root: NoteName, semitoneOffset: number) => {
      if (!isBrowser) {
        return;
      }
      const ctx = await ensureContext();
      const baseFreq = NOTE_FREQUENCIES[root];
      if (!baseFreq) {
        return;
      }
      const secondFreq = computeFrequency(baseFreq, semitoneOffset);
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(baseFreq, now);
      gain1.gain.setValueAtTime(0, now);
      gain1.gain.linearRampToValueAtTime(0.6, now + 0.05);
      gain1.gain.linearRampToValueAtTime(0, now + 0.5);
      osc1.connect(gain1).connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.5);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(secondFreq, now + 0.5);
      gain2.gain.setValueAtTime(0, now + 0.5);
      gain2.gain.linearRampToValueAtTime(0.6, now + 0.55);
      gain2.gain.linearRampToValueAtTime(0, now + 1.0);
      osc2.connect(gain2).connect(ctx.destination);
      osc2.start(now + 0.5);
      osc2.stop(now + 1.0);
    },
    [ensureContext]
  );

  const playProgression = useCallback(
    async (progression: ProgressionChord[], options: ProgressionOptions, onComplete?: () => void) => {
      clearTimers();
      if (!progression.length) {
        return;
      }
      const ctx = await ensureContext();
      const beatSeconds = 60 / options.tempo;
      const startOffsetSeconds = 0.2;
      const scheduleLeadSeconds = 0.05;
      const contextNow = ctx.currentTime;
      const baseStartTime = contextNow + startOffsetSeconds;
      let accumulatedBeats = 0;

      progression.forEach(chord => {
        const duration = describeDuration(chord.duration);
        const chordStartTime = baseStartTime + accumulatedBeats * beatSeconds;
        const scheduleDelaySeconds = Math.max(chordStartTime - scheduleLeadSeconds - contextNow, 0);
        const timer = setTimeout(() => {
          scheduleChord(
            ctx,
            chord.root,
            chord.intervals,
            options.playMode,
            duration.beats,
            options.tempo,
            chordStartTime
          );
          if (options.drumEnabled) {
            playDrumsForChord(ctx, duration.beats, options.tempo, chordStartTime);
          }
        }, scheduleDelaySeconds * 1000);
        progressionTimersRef.current.push(timer);
        accumulatedBeats += duration.beats;
      });

      const totalDurationSeconds = accumulatedBeats * beatSeconds + startOffsetSeconds;

      if (options.loop) {
        loopTimerRef.current = setTimeout(() => {
          void playProgression(progression, options, onComplete);
        }, totalDurationSeconds * 1000);
      } else if (onComplete) {
        const completionTimer = setTimeout(onComplete, totalDurationSeconds * 1000);
        progressionTimersRef.current.push(completionTimer);
      }
    },
    [clearTimers, ensureContext, playDrumsForChord, scheduleChord]
  );

  const stopProgression = useCallback(() => {
    clearTimers();
  }, [clearTimers]);

  useEffect(() => {
    return () => {
      clearTimers();
      audioCtxRef.current?.close().catch(() => undefined);
    };
  }, [clearTimers]);

  return { playInterval, playChord, playProgression, stopProgression };
}
