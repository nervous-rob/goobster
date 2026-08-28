import { useCallback, useEffect, useRef, useState } from 'react';

type ToneModule = typeof import('tone');

interface HarmonyChain {
  synth: import('tone').PolySynth;
  chorus: import('tone').Chorus;
  reverb: import('tone').Reverb;
  compressor: import('tone').Compressor;
}

export interface LoopController {
  getMidi: (stepIndex: number) => number[] | null;
  getLength: () => number;
  onStep: (stepIndex: number) => void;
}

/**
 * Lazy Tone.js layer for the Harmony Engine: PolySynth → Chorus → Reverb →
 * Compressor, with measure-level progression scheduling on the shared
 * Transport (rhythm schedules at subdivision level, harmony at measure level).
 */
export function useToneHarmony() {
  const toneRef = useRef<ToneModule | null>(null);
  const chainRef = useRef<HarmonyChain | null>(null);
  const loopEventRef = useRef<number | null>(null);
  const controllerRef = useRef<LoopController | null>(null);
  const stepIndexRef = useRef(0);
  const [audioReady, setAudioReady] = useState(false);

  const initAudio = useCallback(async (): Promise<ToneModule> => {
    if (toneRef.current && chainRef.current) {
      await toneRef.current.start();
      return toneRef.current;
    }
    // Webpack resolves tone's "browser" field to the UMD build, and because the
    // package declares "type": "module" the bundle is parsed as ESM, where the
    // UMD wrapper falls through to assigning the API onto the global object.
    // Probe every interop location so the engine works regardless of bundler.
    const imported = (await import('tone')) as unknown as Partial<ToneModule> & {
      default?: Partial<ToneModule>;
    };
    const globalTone = (globalThis as { Tone?: Partial<ToneModule> }).Tone;
    const Tone = [imported, imported.default, globalTone].find(
      candidate => candidate && typeof candidate.start === 'function'
    ) as ToneModule | undefined;
    if (!Tone) {
      throw new Error('Unable to resolve the Tone.js module namespace');
    }
    await Tone.start();

    const compressor = new Tone.Compressor({ threshold: -20, ratio: 3 }).toDestination();
    const reverb = new Tone.Reverb({ decay: 2.8, wet: 0.28 }).connect(compressor);
    const chorus = new Tone.Chorus({ frequency: 1.6, delayTime: 3.2, depth: 0.4, wet: 0.3 }).connect(reverb).start();
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.25, sustain: 0.55, release: 1.4 }
    }).connect(chorus);
    synth.volume.value = -9;
    await reverb.generate().catch(() => undefined);

    toneRef.current = Tone;
    chainRef.current = { synth, chorus, reverb, compressor };
    setAudioReady(true);
    return Tone;
  }, []);

  const strum = useCallback((Tone: ToneModule, midi: number[], seconds: number, startTime: number) => {
    const chain = chainRef.current;
    if (!chain) return;
    midi.forEach((m, i) => {
      const freq = Tone.Frequency(m, 'midi').toFrequency();
      chain.synth.triggerAttackRelease(freq, seconds, startTime + i * 0.018, 0.85);
    });
  }, []);

  const playChord = useCallback(
    async (midi: number[], seconds = 1.8) => {
      const Tone = await initAudio();
      strum(Tone, midi, seconds, Tone.now());
    },
    [initAudio, strum]
  );

  const playSequence = useCallback(
    async (steps: number[][], stepSeconds = 0.32, noteSeconds = 0.55) => {
      const Tone = await initAudio();
      const chain = chainRef.current;
      if (!chain) return;
      const start = Tone.now() + 0.02;
      steps.forEach((midi, i) => {
        midi.forEach(m => {
          const freq = Tone.Frequency(m, 'midi').toFrequency();
          chain.synth.triggerAttackRelease(freq, noteSeconds, start + i * stepSeconds, 0.8);
        });
      });
    },
    [initAudio]
  );

  const stopLoop = useCallback(() => {
    const Tone = toneRef.current;
    if (!Tone) return;
    if (loopEventRef.current !== null) {
      Tone.Transport.clear(loopEventRef.current);
      loopEventRef.current = null;
    }
    controllerRef.current = null;
    Tone.Transport.stop();
    Tone.Transport.position = 0;
    chainRef.current?.synth.releaseAll();
  }, []);

  const startLoop = useCallback(
    async (controller: LoopController, bpm: number) => {
      const Tone = await initAudio();
      stopLoop();
      controllerRef.current = controller;
      stepIndexRef.current = 0;
      Tone.Transport.bpm.value = bpm;
      Tone.Transport.swing = 0;

      loopEventRef.current = Tone.Transport.scheduleRepeat(time => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;
        const length = Math.max(1, ctrl.getLength());
        const index = stepIndexRef.current % length;
        const midi = ctrl.getMidi(index);
        if (midi && midi.length) {
          const seconds = Tone.Time('1m').toSeconds() * 0.96;
          strum(Tone, midi, seconds, time);
        }
        Tone.Draw.schedule(() => ctrl.onStep(index), time);
        stepIndexRef.current += 1;
      }, '1m');

      Tone.Transport.position = 0;
      Tone.Transport.start();
    },
    [initAudio, stopLoop, strum]
  );

  const updateBpm = useCallback((bpm: number) => {
    const Tone = toneRef.current;
    if (Tone) {
      Tone.Transport.bpm.value = bpm;
    }
  }, []);

  // Tear the audio graph down when leaving the page (the Transport is global).
  useEffect(() => {
    return () => {
      const Tone = toneRef.current;
      if (!Tone) return;
      Tone.Transport.stop();
      if (loopEventRef.current !== null) Tone.Transport.clear(loopEventRef.current);
      loopEventRef.current = null;
      const chain = chainRef.current;
      if (chain) {
        chain.synth.dispose();
        chain.chorus.dispose();
        chain.reverb.dispose();
        chain.compressor.dispose();
      }
      chainRef.current = null;
      toneRef.current = null;
    };
  }, []);

  return { audioReady, initAudio, playChord, playSequence, startLoop, stopLoop, updateBpm };
}
