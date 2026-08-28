import type { PerformerRole } from './stageData';
import { getAllVoices, type VoicePreset } from './voiceData';
import { ensureSampleBuffer, getCachedSampleBuffer } from './sampleStore';

/**
 * Shared Tone.js instrument layer for the Stage and Studio orchestrators:
 * lazy Tone resolution, the drum kit, the shared sweetening buses, and the
 * per-voice synth builders. Both hooks build identical audio graphs from here.
 */

export type ToneModule = typeof import('tone');

export interface DrumSynths {
  kick: import('tone').MembraneSynth;
  snareNoise: import('tone').NoiseSynth;
  snareBody: import('tone').MembraneSynth;
  hihat: import('tone').MetalSynth;
  /** Fill tom — rides the snare bus so it follows the snare's mix level. */
  tom: import('tone').MembraneSynth;
}

export type TonalSynth =
  | import('tone').PolySynth
  | import('tone').Synth
  | import('tone').FMSynth
  | import('tone').Sampler;

export interface TonalInstrument {
  voiceId: string;
  role: PerformerRole;
  synth: TonalSynth;
  bus: import('tone').Gain;
  /** Sample voice whose buffer wasn't loaded yet — rebuilt once it arrives. */
  samplerPending?: boolean;
}

export interface SharedNodes {
  master: import('tone').Gain;
  compressor: import('tone').Compressor;
  drumBuses: Record<'kick' | 'snare' | 'hihat', import('tone').Gain>;
  chordChorus: import('tone').Chorus;
  chordReverb: import('tone').Reverb;
  leadChorus: import('tone').Chorus;
}

/**
 * Resolves the Tone.js module across webpack/UMD interop shapes and starts
 * the audio context (must be called from a user gesture).
 */
export async function resolveTone(): Promise<ToneModule> {
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
  return Tone;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** True while a sample voice's audio hasn't been decoded into the cache yet. */
export function samplerPendingFor(voice: VoicePreset): boolean {
  if (voice.engine !== 'sample' || !voice.sample) return false;
  return !getCachedSampleBuffer(voice.sample.sampleId);
}

/** Builds a pitched sampler from the cached clip; null while still loading. */
function buildSampler(Tone: ToneModule, voice: VoicePreset, volume: number, release: number): TonalSynth | null {
  if (!voice.sample) return null;
  const buffer = getCachedSampleBuffer(voice.sample.sampleId);
  if (!buffer) return null;
  const rootNote = Tone.Frequency(voice.sample.rootMidi, 'midi').toNote();
  const sampler = new Tone.Sampler({
    urls: { [rootNote]: buffer },
    attack: voice.monoEnvelope.attack,
    release
  });
  sampler.volume.value = volume;
  return sampler;
}

/**
 * Preloads (IndexedDB → decode → cache) the clips of any sample-engine
 * voices in the given set so instrument building can stay synchronous.
 */
export async function preloadSampleBuffers(Tone: ToneModule, voiceIds: (string | undefined)[]): Promise<void> {
  const wanted = new Set(voiceIds.filter((id): id is string => Boolean(id)));
  if (!wanted.size) return;
  const tasks: Promise<unknown>[] = [];
  getAllVoices().forEach(voice => {
    if (voice.engine !== 'sample' || !voice.sample || !wanted.has(voice.id)) return;
    const sampleId = voice.sample.sampleId;
    tasks.push(
      ensureSampleBuffer(sampleId, data => (Tone.getContext().rawContext as BaseAudioContext).decodeAudioData(data))
    );
  });
  if (tasks.length) await Promise.all(tasks);
}

export function buildPolySynth(Tone: ToneModule, voice: VoicePreset): TonalSynth {
  if (voice.engine === 'sample') {
    const sampler = buildSampler(Tone, voice, voice.polyVolume, voice.polyEnvelope.release);
    if (sampler) return sampler;
    // Buffer not loaded yet — fall through to a placeholder synth.
  }
  if (voice.engine === 'fm') {
    const synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: voice.fm?.harmonicity ?? 3,
      modulationIndex: voice.fm?.modulationIndex ?? 10,
      oscillator: { type: voice.osc },
      envelope: voice.polyEnvelope
    });
    synth.volume.value = voice.polyVolume;
    return synth;
  }
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: voice.osc },
    envelope: voice.polyEnvelope
  });
  synth.volume.value = voice.polyVolume;
  return synth;
}

export function buildMonoSynth(Tone: ToneModule, voice: VoicePreset): TonalSynth {
  if (voice.engine === 'sample') {
    const sampler = buildSampler(Tone, voice, voice.monoVolume, voice.monoEnvelope.release);
    if (sampler) return sampler;
  }
  if (voice.engine === 'fm') {
    const synth = new Tone.FMSynth({
      harmonicity: voice.fm?.harmonicity ?? 3,
      modulationIndex: voice.fm?.modulationIndex ?? 10,
      oscillator: { type: voice.osc },
      envelope: voice.monoEnvelope
    });
    synth.volume.value = voice.monoVolume;
    return synth;
  }
  const synth = new Tone.Synth({
    oscillator: { type: voice.osc },
    envelope: voice.monoEnvelope
  });
  synth.volume.value = voice.monoVolume;
  return synth;
}

/**
 * Builds the shared bus graph: compressor → destination, master gain, drum
 * buses, and the chorus/reverb sweetening chains used by chord organisms and
 * lead creatures.
 */
export async function createSharedNodes(
  Tone: ToneModule,
  masterVolumeDb: number,
  reverbWet: number
): Promise<SharedNodes> {
  const compressor = new Tone.Compressor({ threshold: -20, ratio: 3 }).toDestination();
  const master = new Tone.Gain(dbToGain(masterVolumeDb)).connect(compressor);

  const drumBuses = {
    kick: new Tone.Gain(0).connect(master),
    snare: new Tone.Gain(0).connect(master),
    hihat: new Tone.Gain(0).connect(master)
  };

  // Shared sweetening: all chord organisms run chorus → reverb → master;
  // lead creatures share a light chorus. Per-creature level lives on its bus.
  const chordReverb = new Tone.Reverb({ decay: 2.8, wet: reverbWet }).connect(master);
  const chordChorus = new Tone.Chorus({ frequency: 1.6, delayTime: 3.2, depth: 0.4, wet: 0.3 })
    .connect(chordReverb)
    .start();
  const leadChorus = new Tone.Chorus({ frequency: 2.2, delayTime: 2.4, depth: 0.3, wet: 0.25 })
    .connect(master)
    .start();
  await chordReverb.generate().catch(() => undefined);

  return { master, compressor, drumBuses, chordChorus, chordReverb, leadChorus };
}

export function createDrumSynths(Tone: ToneModule, shared: SharedNodes): DrumSynths {
  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.1,
    octaves: 5,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.4, sustain: 0.01, release: 1.4 }
  }).connect(shared.drumBuses.kick);

  const snareNoise = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 }
  }).connect(shared.drumBuses.snare);

  const snareBody = new Tone.MembraneSynth({
    pitchDecay: 0.01,
    octaves: 2,
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1 }
  }).connect(shared.drumBuses.snare);
  snareBody.volume.value = -2;

  const hihat = new Tone.MetalSynth({
    envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5
  }).connect(shared.drumBuses.hihat);
  hihat.frequency.value = 400;

  const tom = new Tone.MembraneSynth({
    pitchDecay: 0.05,
    octaves: 4,
    oscillator: { type: 'sine' },
    envelope: { attack: 0.005, decay: 0.35, sustain: 0, release: 0.4 }
  }).connect(shared.drumBuses.snare);
  tom.volume.value = -3;

  return { kick, snareNoise, snareBody, hihat, tom };
}

const FILL_TOM_NOTES = ['A2', 'G2', 'F2', 'D2'];

/**
 * Plays one step of an automatic drum fill: toms walking down on the even
 * steps, ghosted snare on the odd ones, velocity ramping into the bar line.
 * Returns the velocity so callers can drive the visuals with it.
 */
export function triggerFillStep(drums: DrumSynths, fillIndex: number, fillLength: number, time: number): number {
  const velocity = 0.5 + 0.5 * (fillIndex / Math.max(1, fillLength - 1));
  if (fillIndex % 2 === 0) {
    const note = FILL_TOM_NOTES[Math.floor(fillIndex / 2) % FILL_TOM_NOTES.length];
    drums.tom.triggerAttackRelease(note, '16n', time, velocity);
  } else {
    drums.snareNoise.triggerAttackRelease('16n', time, velocity * 0.75);
    drums.snareBody.triggerAttackRelease('G3', '16n', time, velocity * 0.75);
  }
  return velocity;
}

export function disposeDrumSynths(drums: DrumSynths): void {
  drums.kick.dispose();
  drums.snareNoise.dispose();
  drums.snareBody.dispose();
  drums.hihat.dispose();
  drums.tom.dispose();
}

export function disposeSharedNodes(shared: SharedNodes): void {
  shared.chordChorus.dispose();
  shared.chordReverb.dispose();
  shared.leadChorus.dispose();
  Object.values(shared.drumBuses).forEach(bus => bus.dispose());
  shared.master.dispose();
  shared.compressor.dispose();
}
