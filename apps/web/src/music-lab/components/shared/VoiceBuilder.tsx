import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceLibrary } from '@music-lab/hooks/useVoiceLibrary';
import { makeVoiceId, type VoiceOsc, type VoicePreset } from '@music-lab/lib/voiceData';
import { buildMonoSynth, buildPolySynth, resolveTone, type TonalSynth } from '@music-lab/lib/stageInstruments';
import { audioBufferToWavBlob, blobToAudioBuffer, sliceAudioBuffer } from '@music-lab/lib/audioExport';
import { cacheSampleBuffer, makeSampleId, saveSampleBlob } from '@music-lab/lib/sampleStore';

interface VoiceBuilderProps {
  /** Unique prefix for element ids (the builder mounts on several pages). */
  idPrefix: string;
}

type BuilderTab = 'synth' | 'sample';

const OSC_OPTIONS: { id: VoiceOsc; label: string }[] = [
  { id: 'sine', label: 'Sine — pure' },
  { id: 'triangle', label: 'Triangle — glassy' },
  { id: 'sawtooth', label: 'Saw — buzzy' },
  { id: 'square', label: 'Square — hollow' },
  { id: 'fatsawtooth', label: 'Fat saw — detuned wall' },
  { id: 'fatsine', label: 'Fat sine — chapel drone' }
];

const NOTE_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiLabel(midi: number): string {
  return `${NOTE_LABELS[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

const PREVIEW_CHORD = [60, 64, 67, 71];

/**
 * Voice Builder: design synth voices with knobs, or upload a .wav/.mp3 clip,
 * trim it, and turn it into a pitched sampler voice. Saved voices join the
 * voice library everywhere (creatures, chord organisms, stage, studio).
 */
export function VoiceBuilder({ idPrefix }: VoiceBuilderProps) {
  const { customVoices, saveVoice, deleteVoice } = useVoiceLibrary();

  const [tab, setTab] = useState<BuilderTab>('synth');
  const [flash, setFlash] = useState<string | null>(null);

  // --- Synth knobs ---
  const [name, setName] = useState('');
  const [hue, setHue] = useState(290);
  const [engineMode, setEngineMode] = useState<'synth' | 'fm'>('synth');
  const [osc, setOsc] = useState<VoiceOsc>('triangle');
  const [fmHarmonicity, setFmHarmonicity] = useState(3);
  const [fmModIndex, setFmModIndex] = useState(10);
  const [attack, setAttack] = useState(0.02);
  const [decay, setDecay] = useState(0.2);
  const [sustain, setSustain] = useState(0.6);
  const [release, setRelease] = useState(0.8);
  const [volume, setVolume] = useState(-8);

  // --- Sample editor ---
  const [fileName, setFileName] = useState<string | null>(null);
  const [sampleBuffer, setSampleBuffer] = useState<AudioBuffer | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(1);
  const [sampleGain, setSampleGain] = useState(1);
  const [rootMidi, setRootMidi] = useState(60);
  const [sampleRelease, setSampleRelease] = useState(0.3);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [micRecording, setMicRecording] = useState(false);
  const [micSeconds, setMicSeconds] = useState(0);

  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const previewSynthRef = useRef<TonalSynth | null>(null);
  const previewCtxRef = useRef<AudioContext | null>(null);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      previewSynthRef.current?.dispose();
      previewSynthRef.current = null;
      void previewCtxRef.current?.close().catch(() => undefined);
      previewCtxRef.current = null;
      if (micTimerRef.current !== null) window.clearInterval(micTimerRef.current);
      if (micRecorderRef.current?.state === 'recording') micRecorderRef.current.stop();
      micStreamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  const showFlash = useCallback((message: string) => {
    setFlash(message);
    window.setTimeout(() => setFlash(null), 2600);
  }, []);

  // --- Synth preview / save ---

  const draftSynthPreset = useCallback(
    (): VoicePreset => ({
      id: 'vb-preview',
      name: name.trim() || 'Custom Voice',
      blurb: 'Hand-built in the Voice Builder',
      hue,
      engine: engineMode,
      osc,
      fm: engineMode === 'fm' ? { harmonicity: fmHarmonicity, modulationIndex: fmModIndex } : undefined,
      polyEnvelope: { attack, decay, sustain, release },
      monoEnvelope: { attack, decay, sustain, release: Math.min(release, 0.9) },
      polyVolume: volume - 3,
      monoVolume: volume
    }),
    [attack, decay, engineMode, fmHarmonicity, fmModIndex, hue, name, osc, release, sustain, volume]
  );

  const playPreview = useCallback(
    async (kind: 'note' | 'chord') => {
      const Tone = await resolveTone();
      previewSynthRef.current?.dispose();
      const preset = draftSynthPreset();
      const synth = kind === 'chord' ? buildPolySynth(Tone, preset) : buildMonoSynth(Tone, preset);
      synth.toDestination();
      previewSynthRef.current = synth;
      const now = Tone.now();
      const midis = kind === 'chord' ? PREVIEW_CHORD : [60];
      midis.forEach((midi, i) => {
        synth.triggerAttackRelease(Tone.Frequency(midi, 'midi').toFrequency(), 1.1, now + i * 0.02, 0.85);
      });
    },
    [draftSynthPreset]
  );

  const handleSaveSynth = useCallback(() => {
    const preset: VoicePreset = { ...draftSynthPreset(), id: makeVoiceId() };
    saveVoice(preset);
    showFlash(`Saved “${preset.name}” — it's now in every voice menu.`);
  }, [draftSynthPreset, saveVoice, showFlash]);

  // --- Sample upload / editor ---

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setSampleError(null);
    try {
      const data = await file.arrayBuffer();
      const ctx = new AudioContext();
      try {
        const decoded = await ctx.decodeAudioData(data);
        if (decoded.duration > 30) {
          setSampleError('Clip is longer than 30s — trim it below before saving.');
        }
        setSampleBuffer(decoded);
        setFileName(file.name);
        setTrimStart(0);
        setTrimEnd(1);
      } finally {
        void ctx.close().catch(() => undefined);
      }
    } catch {
      setSampleError('Could not decode that file. Use a .wav or .mp3 clip.');
    }
  }, []);

  // --- Mic recording (capped at 10s, feeds the same trim/save pipeline) ---

  const stopMicRecording = useCallback(() => {
    if (micRecorderRef.current?.state === 'recording') micRecorderRef.current.stop();
  }, []);

  const startMicRecording = useCallback(async () => {
    setSampleError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = event => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        micRecorderRef.current = null;
        stream.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
        if (micTimerRef.current !== null) {
          window.clearInterval(micTimerRef.current);
          micTimerRef.current = null;
        }
        setMicRecording(false);
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const decoded = await blobToAudioBuffer(blob);
          setSampleBuffer(decoded);
          setFileName('Mic recording');
          setTrimStart(0);
          setTrimEnd(1);
        } catch {
          setSampleError('Could not decode the mic recording in this browser.');
        }
      };
      micRecorderRef.current = recorder;
      recorder.start();
      setMicRecording(true);
      setMicSeconds(0);
      const startedAt = Date.now();
      micTimerRef.current = window.setInterval(() => {
        const seconds = (Date.now() - startedAt) / 1000;
        setMicSeconds(seconds);
        if (seconds >= 10) stopMicRecording();
      }, 200);
    } catch {
      setSampleError('Microphone unavailable — check the browser permission prompt.');
    }
  }, [stopMicRecording]);

  // Waveform with trim shading.
  useEffect(() => {
    const canvas = waveRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || 480;
    const cssH = canvas.clientHeight || 96;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!sampleBuffer) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Upload a .wav or .mp3 clip to see its waveform', cssW / 2, cssH / 2);
      return;
    }

    const data = sampleBuffer.getChannelData(0);
    const mid = cssH / 2;
    const step = Math.max(1, Math.floor(data.length / cssW));
    ctx.strokeStyle = `hsl(${hue} 70% 62%)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < cssW; x++) {
      let min = 1;
      let max = -1;
      const base = Math.floor((x / cssW) * data.length);
      for (let i = 0; i < step; i++) {
        const v = data[Math.min(data.length - 1, base + i)];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      ctx.moveTo(x + 0.5, mid + min * (mid - 2));
      ctx.lineTo(x + 0.5, mid + max * (mid - 2));
    }
    ctx.stroke();

    // Dim everything outside the trim region.
    ctx.fillStyle = 'rgba(10, 10, 10, 0.72)';
    ctx.fillRect(0, 0, trimStart * cssW, cssH);
    ctx.fillRect(trimEnd * cssW, 0, cssW - trimEnd * cssW, cssH);
    ctx.strokeStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(trimStart * cssW + 0.5, 0);
    ctx.lineTo(trimStart * cssW + 0.5, cssH);
    ctx.moveTo(trimEnd * cssW - 0.5, 0);
    ctx.lineTo(trimEnd * cssW - 0.5, cssH);
    ctx.stroke();
  }, [sampleBuffer, trimStart, trimEnd, hue]);

  const previewSlice = useCallback(async () => {
    if (!sampleBuffer) return;
    const ctx = previewCtxRef.current ?? new AudioContext();
    previewCtxRef.current = ctx;
    setSampleError(null);
    try {
      const state = String(ctx.state);
      if (state !== 'running' && state !== 'closed') {
        const resume = ctx.resume();
        await resume;
      }
      if (String(ctx.state) !== 'running') throw new Error(`Audio context is ${ctx.state}`);
      const slice = sliceAudioBuffer(sampleBuffer, trimStart, trimEnd, sampleGain);
      const source = ctx.createBufferSource();
      source.buffer = slice;
      source.connect(ctx.destination);
      source.start();
    } catch {
      setSampleError('Could not start audio. Tap preview again or check the browser media permission.');
    }
  }, [sampleBuffer, sampleGain, trimEnd, trimStart]);

  const trimmedSeconds = sampleBuffer ? (trimEnd - trimStart) * sampleBuffer.duration : 0;

  const handleSaveSample = useCallback(async () => {
    if (!sampleBuffer || saving) return;
    if (trimmedSeconds > 30) {
      setSampleError('Trimmed clip is still longer than 30s — tighten the trim.');
      return;
    }
    setSaving(true);
    try {
      const slice = sliceAudioBuffer(sampleBuffer, trimStart, trimEnd, sampleGain);
      const sampleId = makeSampleId();
      await saveSampleBlob(sampleId, audioBufferToWavBlob(slice));
      cacheSampleBuffer(sampleId, slice);

      const baseName = fileName?.replace(/\.[^.]+$/, '') ?? 'Sample';
      const preset: VoicePreset = {
        id: makeVoiceId(),
        name: name.trim() || baseName,
        blurb: `Sampled from ${fileName ?? 'an uploaded clip'}`,
        hue,
        engine: 'sample',
        osc: 'triangle',
        sample: { sampleId, rootMidi },
        polyEnvelope: { attack: 0.002, decay: 0.1, sustain: 1, release: sampleRelease },
        monoEnvelope: { attack: 0.002, decay: 0.1, sustain: 1, release: sampleRelease },
        polyVolume: -10,
        monoVolume: -7
      };
      saveVoice(preset);
      showFlash(`Saved “${preset.name}” — the clip is now a playable voice.`);
    } catch {
      setSampleError('Saving failed — the browser blocked IndexedDB storage.');
    } finally {
      setSaving(false);
    }
  }, [fileName, hue, name, rootMidi, sampleBuffer, sampleGain, sampleRelease, saveVoice, saving, showFlash, trimEnd, trimStart, trimmedSeconds]);

  // --- Custom voice list ---

  const handleLoadVoice = useCallback((preset: VoicePreset) => {
    if (preset.engine === 'sample') return;
    setTab('synth');
    setName(preset.name);
    setHue(preset.hue);
    setEngineMode(preset.engine === 'fm' ? 'fm' : 'synth');
    setOsc(preset.osc);
    if (preset.fm) {
      setFmHarmonicity(preset.fm.harmonicity);
      setFmModIndex(preset.fm.modulationIndex);
    }
    setAttack(preset.polyEnvelope.attack);
    setDecay(preset.polyEnvelope.decay);
    setSustain(preset.polyEnvelope.sustain);
    setRelease(preset.polyEnvelope.release);
    setVolume(preset.monoVolume);
  }, []);

  const renderKnob = (
    id: string,
    label: string,
    value: number,
    display: string,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void
  ) => (
    <div key={id}>
      <div className="re-slider-head sm">
        <label htmlFor={`${idPrefix}-${id}`}>{label}</label>
        <span className="re-slider-val sm">{display}</span>
      </div>
      <input
        id={`${idPrefix}-${id}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
      />
    </div>
  );

  return (
    <div className="re-panel re-stack vb-panel">
      <div className="re-panel-head">
        <div>
          <h3>Voice Builder</h3>
          <p>Design a synth voice or sample a sound clip</p>
        </div>
        <span className="vb-swatch" style={{ background: `hsl(${hue} 70% 58%)` }} aria-hidden />
      </div>

      <div className="re-pills">
        <button type="button" className={`re-pill${tab === 'synth' ? ' on' : ''}`} onClick={() => setTab('synth')}>
          Synth knobs
        </button>
        <button type="button" className={`re-pill${tab === 'sample' ? ' on' : ''}`} onClick={() => setTab('sample')}>
          Sample clip
        </button>
      </div>

      <div className="re-stack-sm">
        <label className="re-micro-label" htmlFor={`${idPrefix}-vb-name`}>
          Voice name
        </label>
        <input
          id={`${idPrefix}-vb-name`}
          className="re-select"
          type="text"
          maxLength={28}
          placeholder={tab === 'sample' ? fileName?.replace(/\.[^.]+$/, '') ?? 'My Sample Voice' : 'My Synth Voice'}
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </div>

      {tab === 'synth' ? (
        <>
          <div className="vb-row">
            <div className="re-stack-sm vb-grow">
              <label className="re-micro-label" htmlFor={`${idPrefix}-vb-osc`}>
                Oscillator
              </label>
              <select
                id={`${idPrefix}-vb-osc`}
                className="re-select"
                value={osc}
                onChange={e => setOsc(e.target.value as VoiceOsc)}
              >
                {OSC_OPTIONS.map(o => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="re-stack-sm">
              <span className="re-micro-label">Engine</span>
              <div className="re-pills">
                <button
                  type="button"
                  className={`re-pill${engineMode === 'synth' ? ' on' : ''}`}
                  onClick={() => setEngineMode('synth')}
                >
                  Analog
                </button>
                <button
                  type="button"
                  className={`re-pill${engineMode === 'fm' ? ' on' : ''}`}
                  onClick={() => setEngineMode('fm')}
                >
                  FM
                </button>
              </div>
            </div>
          </div>

          <div className="vb-knobs">
            {renderKnob('vb-attack', 'Attack', attack, `${attack.toFixed(2)}s`, 0.001, 1.5, 0.001, setAttack)}
            {renderKnob('vb-decay', 'Decay', decay, `${decay.toFixed(2)}s`, 0.01, 1.5, 0.01, setDecay)}
            {renderKnob('vb-sustain', 'Sustain', sustain, sustain.toFixed(2), 0, 1, 0.01, setSustain)}
            {renderKnob('vb-release', 'Release', release, `${release.toFixed(2)}s`, 0.05, 3, 0.01, setRelease)}
            {renderKnob('vb-volume', 'Volume', volume, `${volume} dB`, -24, 0, 1, setVolume)}
            {renderKnob('vb-hue', 'Creature hue', hue, `${hue}°`, 0, 360, 1, setHue)}
            {engineMode === 'fm'
              ? renderKnob('vb-harm', 'FM ratio', fmHarmonicity, fmHarmonicity.toFixed(2), 0.5, 8, 0.01, setFmHarmonicity)
              : null}
            {engineMode === 'fm'
              ? renderKnob('vb-mod', 'FM depth', fmModIndex, fmModIndex.toFixed(0), 1, 40, 1, setFmModIndex)
              : null}
          </div>

          <div className="vb-row">
            <button type="button" className="re-secondary-btn" onClick={() => void playPreview('note')}>
              ▶ Test note
            </button>
            <button type="button" className="re-secondary-btn" onClick={() => void playPreview('chord')}>
              ▶ Test chord
            </button>
            <button type="button" className="re-play-btn vb-grow" onClick={handleSaveSynth}>
              Save voice
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="vb-row">
            <label className="re-secondary-btn vb-file-btn" htmlFor={`${idPrefix}-vb-file`}>
              {fileName ? `↺ Replace clip (${fileName})` : '⤒ Upload .wav / .mp3'}
            </label>
            <input
              id={`${idPrefix}-vb-file`}
              type="file"
              accept=".wav,.mp3,audio/wav,audio/mpeg,audio/x-wav"
              className="vb-file-input"
              onChange={e => void handleFile(e.target.files?.[0])}
            />
            <button
              type="button"
              className={`re-secondary-btn vb-rec${micRecording ? ' on' : ''}`}
              onClick={() => (micRecording ? stopMicRecording() : void startMicRecording())}
              title="Record up to 10 seconds from your microphone"
            >
              {micRecording ? `■ Stop (${micSeconds.toFixed(1)}s / 10s)` : '● Record mic'}
            </button>
          </div>

          <canvas ref={waveRef} className="vb-wave" aria-label="Sample waveform with trim region" />

          {sampleBuffer ? (
            <>
              <div className="vb-knobs">
                {renderKnob('vb-trim-start', 'Trim start', trimStart, `${(trimStart * sampleBuffer.duration).toFixed(2)}s`, 0, 1, 0.001, v =>
                  setTrimStart(Math.min(v, trimEnd - 0.01))
                )}
                {renderKnob('vb-trim-end', 'Trim end', trimEnd, `${(trimEnd * sampleBuffer.duration).toFixed(2)}s`, 0, 1, 0.001, v =>
                  setTrimEnd(Math.max(v, trimStart + 0.01))
                )}
                {renderKnob('vb-gain', 'Clip gain', sampleGain, `×${sampleGain.toFixed(2)}`, 0.25, 3, 0.01, setSampleGain)}
                {renderKnob('vb-root', 'Root pitch', rootMidi, midiLabel(rootMidi), 24, 84, 1, v => setRootMidi(Math.round(v)))}
                {renderKnob('vb-srelease', 'Release', sampleRelease, `${sampleRelease.toFixed(2)}s`, 0.05, 2, 0.01, setSampleRelease)}
                {renderKnob('vb-shue', 'Creature hue', hue, `${hue}°`, 0, 360, 1, setHue)}
              </div>
              <p className="vb-note">
                Keep the clip tight ({trimmedSeconds.toFixed(2)}s selected). Set the root pitch to the note the clip
                actually sounds — the sampler re-pitches it to every other note from there.
              </p>
              <div className="vb-row">
                <button type="button" className="re-secondary-btn" onClick={() => void previewSlice()}>
                  ▶ Preview trim
                </button>
                <button type="button" className="re-play-btn vb-grow" onClick={() => void handleSaveSample()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save sample voice'}
                </button>
              </div>
            </>
          ) : null}
          {sampleError ? <p className="vb-error">{sampleError}</p> : null}
        </>
      )}

      {flash ? <p className="vb-flash">{flash}</p> : null}

      <div className="re-stack-sm">
        <span className="re-micro-label">Your voices ({customVoices.length})</span>
        {customVoices.length ? (
          <div className="vb-voice-list">
            {customVoices.map(voice => (
              <div key={voice.id} className="vb-voice-row">
                <span className="vb-swatch sm" style={{ background: `hsl(${voice.hue} 70% 58%)` }} aria-hidden />
                <div className="vb-voice-info">
                  <strong>{voice.name}</strong>
                  <span>{voice.engine === 'sample' ? 'Sample' : voice.engine === 'fm' ? 'FM synth' : 'Analog synth'}</span>
                </div>
                {voice.engine !== 'sample' ? (
                  <button
                    type="button"
                    className="vb-icon-btn"
                    onClick={() => handleLoadVoice(voice)}
                    title="Load into the builder"
                  >
                    ↺
                  </button>
                ) : null}
                <button
                  type="button"
                  className="vb-icon-btn remove"
                  onClick={() => deleteVoice(voice)}
                  title="Delete voice"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="vb-note">Nothing saved yet — voices you build here appear in every voice menu.</p>
        )}
      </div>
    </div>
  );
}
