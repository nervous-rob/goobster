import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { NOTE_NAMES, type NoteName } from '@music-lab/lib/musicData';
import { MODES, SPACE_INTERVALS, TRIAD_FEEL, type ArrangementId, type ModeId } from '@music-lab/lib/spaceData';
import {
  brightnessK,
  buildDiatonicTriads,
  buildScaleLadder,
  fifthsSteps,
  intervalForSemitones,
  midiNear,
  modeById,
  noteOfPc,
  pcOf,
  relativeSpellings,
  scaleMidiSequence,
  type TriadQuality
} from '@music-lab/lib/spaceTheory';
import { useLocalStorage } from '@music-lab/hooks/useLocalStorage';
import { useToneHarmony } from '@music-lab/hooks/useToneHarmony';
import {
  createSpaceScene,
  orbitSpace,
  pickSpaceNode,
  pulseSpaceNode,
  renderSpace,
  zoomSpace,
  SPH,
  SPW,
  type SpaceView
} from './spaceRenderer';

const TRIAD_HUE: Record<TriadQuality, number> = { major: 160, minor: 265, diminished: 356 };
const QUALITY_WORD: Record<TriadQuality, string> = { major: 'major', minor: 'minor', diminished: 'diminished' };

function formatK(k: number): string {
  if (k === 0) return '0';
  return k > 0 ? `+${k}` : `−${Math.abs(k)}`;
}

function IconGalaxy() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="10" ry="4" />
      <circle cx="3.4" cy="10.6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="20.4" cy="13.6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="8.3" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 1.6v12.8c0 .9 1 1.4 1.7 1L15 8.9c.7-.4.7-1.4 0-1.8L4.7.6C4 .2 3 .7 3 1.6z" />
    </svg>
  );
}

export function SpaceEngine() {
  // --- Persistent settings ---
  const [root, setRoot] = useLocalStorage<NoteName>('spaceRoot', 'C');
  const [modeId, setModeId] = useLocalStorage<ModeId>('spaceModeId', 'ionian');
  const [arrangement, setArrangement] = useLocalStorage<ArrangementId>('spaceArrangement', 'fifths');
  const [altitude, setAltitude] = useLocalStorage<number>('spaceAltitude', 55);
  const [autoSpin, setAutoSpin] = useLocalStorage<boolean>('spaceAutoSpin', true);
  const [intervalSemitones, setIntervalSemitones] = useLocalStorage<number>('spaceIntervalSemitones', 7);
  const [chordDegree, setChordDegree] = useLocalStorage<number | null>('spaceChordDegree', 0);

  const { audioReady, playChord, playSequence } = useToneHarmony();

  // --- Derived theory ---
  const mode = useMemo(() => modeById(modeId), [modeId]);
  const tonicPc = pcOf(root);
  const ladder = useMemo(() => buildScaleLadder(root, mode), [root, mode]);
  const triads = useMemo(() => buildDiatonicTriads(root, mode), [root, mode]);
  const relatives = useMemo(() => relativeSpellings(root, mode), [root, mode]);
  const interval = useMemo(() => intervalForSemitones(intervalSemitones), [intervalSemitones]);
  const selectedTriad = chordDegree !== null ? triads[chordDegree] ?? null : null;

  const view = useMemo<SpaceView>(() => {
    const degreeByPc = new Map(ladder.map(d => [d.pc, d.degreeIndex]));
    const lift = (altitude / 100) * 26;
    const nodes = Array.from({ length: 12 }, (_, pc) => {
      const k = brightnessK(pc, tonicPc, mode);
      const around = arrangement === 'fifths' ? fifthsSteps(pc, tonicPc) : ((pc - tonicPc) % 12 + 12) % 12;
      const degreeIndex = degreeByPc.get(pc);
      return {
        pc,
        label: noteOfPc(pc),
        inScale: degreeIndex !== undefined,
        isTonic: pc === tonicPc,
        degreeIndex: degreeIndex ?? null,
        angle: around * (Math.PI / 6),
        height: k * lift,
        hue: (((190 - k * 22) % 360) + 360) % 360
      };
    });
    return {
      nodes,
      scaleOrder: ladder.map(d => d.pc),
      chordPcs: selectedTriad ? [...selectedTriad.pcs] : null,
      chordHue: selectedTriad ? TRIAD_HUE[selectedTriad.quality] : 160,
      intervalPc: (tonicPc + intervalSemitones) % 12,
      intervalHue: interval.smoothness * 165,
      tonicPc
    };
  }, [ladder, altitude, tonicPc, mode, arrangement, selectedTriad, intervalSemitones, interval]);

  // --- Canvas: animation loop + orbit/pick interactions ---
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef(createSpaceScene());
  const viewRef = useRef(view);
  viewRef.current = view;
  const spinRef = useRef(autoSpin);
  spinRef.current = autoSpin;
  const visRef = useRef({ scale: 1, lastTime: 0, t: 0 });
  const timeoutsRef = useRef<number[]>([]);

  const resizeCanvas = useCallback(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssW = cv.clientWidth || SPW;
    const cssH = (cssW * SPH) / SPW;
    cv.style.height = `${cssH}px`;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    visRef.current.scale = (cssW / SPW) * dpr;
  }, []);

  useEffect(() => {
    let raf = 0;
    resizeCanvas();
    const onResize = () => resizeCanvas();
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
        ctx.setTransform(v.scale, 0, 0, v.scale, 0, 0);
        ctx.clearRect(0, 0, SPW, SPH);
        renderSpace(ctx, viewRef.current, sceneRef.current, v.t, dt, spinRef.current);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [resizeCanvas]);

  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => timeouts.forEach(id => window.clearTimeout(id));
  }, []);

  const schedulePulse = useCallback((pc: number, delayMs: number, amount = 1) => {
    timeoutsRef.current.push(window.setTimeout(() => pulseSpaceNode(sceneRef.current, pc, amount), delayMs));
  }, []);

  const auditionInterval = useCallback(
    (semitones: number) => {
      const tonicMidi = midiNear(tonicPc);
      const other = tonicMidi + semitones;
      void playSequence([[tonicMidi], [other], [tonicMidi, other]], 0.42, 0.6);
      pulseSpaceNode(sceneRef.current, tonicPc);
      schedulePulse((tonicPc + semitones) % 12, 420);
      schedulePulse(tonicPc, 840, 0.8);
      schedulePulse((tonicPc + semitones) % 12, 840, 0.8);
    },
    [tonicPc, playSequence, schedulePulse]
  );

  const handleNodeClick = useCallback(
    (pc: number) => {
      if (pc === tonicPc) {
        void playSequence([[midiNear(tonicPc)]], 0.3, 0.9);
        pulseSpaceNode(sceneRef.current, tonicPc);
        return;
      }
      const semitones = ((pc - tonicPc) % 12 + 12) % 12;
      setIntervalSemitones(semitones);
      auditionInterval(semitones);
    },
    [tonicPc, playSequence, setIntervalSemitones, auditionInterval]
  );

  const nodeClickRef = useRef(handleNodeClick);
  nodeClickRef.current = handleNodeClick;

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;

    const toCanvas = (e: PointerEvent) => {
      const rect = cv.getBoundingClientRect();
      return { x: ((e.clientX - rect.left) * SPW) / rect.width, y: ((e.clientY - rect.top) * SPH) / rect.height };
    };
    const onDown = (e: PointerEvent) => {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      cv.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX;
      lastY = e.clientY;
      orbitSpace(sceneRef.current, dx, dy);
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (moved < 6) {
        const { x, y } = toCanvas(e);
        const pc = pickSpaceNode(sceneRef.current, x, y);
        if (pc !== null) nodeClickRef.current(pc);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomSpace(sceneRef.current, e.deltaY);
    };

    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('wheel', onWheel);
    };
  }, []);

  // --- Audio interactions ---
  const handlePlayScale = useCallback(() => {
    const midi = scaleMidiSequence(root, mode);
    void playSequence(midi.map(m => [m]), 0.3, 0.5);
    const pcs = [...ladder].sort((a, b) => a.degreeIndex - b.degreeIndex).map(d => d.pc);
    [...pcs, tonicPc].forEach((pc, i) => schedulePulse(pc, i * 300));
  }, [root, mode, playSequence, ladder, tonicPc, schedulePulse]);

  const handleSelectInterval = useCallback(
    (semitones: number) => {
      setIntervalSemitones(semitones);
      auditionInterval(semitones);
    },
    [setIntervalSemitones, auditionInterval]
  );

  const handlePlayInterval = useCallback(
    (style: 'melodic' | 'harmonic') => {
      const tonicMidi = midiNear(tonicPc);
      const other = tonicMidi + intervalSemitones;
      if (style === 'melodic') {
        void playSequence([[tonicMidi], [other]], 0.42, 0.6);
        pulseSpaceNode(sceneRef.current, tonicPc);
        schedulePulse((tonicPc + intervalSemitones) % 12, 420);
      } else {
        void playChord([tonicMidi, other], 1.6);
        pulseSpaceNode(sceneRef.current, tonicPc);
        pulseSpaceNode(sceneRef.current, (tonicPc + intervalSemitones) % 12);
      }
    },
    [tonicPc, intervalSemitones, playSequence, playChord, schedulePulse]
  );

  const handleSelectChord = useCallback(
    (degreeIndex: number) => {
      const triad = triads[degreeIndex];
      if (!triad) return;
      setChordDegree(prev => (prev === degreeIndex ? null : degreeIndex));
      void playChord(triad.midi, 1.8);
      triad.pcs.forEach(pc => pulseSpaceNode(sceneRef.current, pc));
    },
    [triads, setChordDegree, playChord]
  );

  const handleLadderClick = useCallback(
    (pc: number) => {
      void playSequence([[midiNear(pc)]], 0.3, 0.8);
      pulseSpaceNode(sceneRef.current, pc);
    },
    [playSequence]
  );

  const handleRelative = useCallback(
    (relRoot: NoteName, relMode: ModeId) => {
      setRoot(relRoot);
      setModeId(relMode);
      pulseSpaceNode(sceneRef.current, pcOf(relRoot));
    },
    [setRoot, setModeId]
  );

  // --- Field notes copy ---
  const starsAbove = ladder.filter(d => d.k > 0).length;
  const starsBelow = ladder.filter(d => d.k < 0).length;
  const modeLabel = mode.alias ? `${mode.name} (${mode.alias})` : mode.name;
  const arrangementNote =
    arrangement === 'fifths'
      ? 'Neighbouring stars are a perfect fifth apart, so the seven notes of any major-family scale form one unbroken glowing arc. Slide that window one star clockwise and you add a sharp — that is the whole circle of fifths.'
      : 'Neighbouring stars are a semitone apart — the piano unrolled into a ring. Notice how the scale’s seven stars scatter: stepwise closeness and harmonic closeness are different things. Morph to the fifths ring to see them gather.';
  const altitudeNote =
    altitude < 8
      ? 'The ring is flat. Raise the lift to stretch it into a helix where height = brightness: each star climbs by how many fifths sharp of home it sits.'
      : 'Height is brightness: each fifth clockwise lifts a star, each fifth counter-clockwise sinks it. Look from the side and the scale becomes a ladder of seven consecutive fifths.';

  return (
    <section className="rhythm-engine space-engine">
      <header className="re-header">
        <div className="re-brand">
          <span className="re-brand-icon">
            <IconGalaxy />
          </span>
          <div>
            <h2 className="re-title">
              Harmonic Space <span className="re-accent-text">ORBIT</span>
            </h2>
            <p className="re-subtitle">A 3-D constellation of keys, modes &amp; intervals</p>
          </div>
        </div>
        <div className="re-status">
          <span className={`re-status-dot${audioReady ? ' on' : ''}`} />
          <span className={audioReady ? 're-status-text on' : 're-status-text'}>
            {audioReady ? 'Signal Live' : 'Signal Cold'}
          </span>
        </div>
      </header>

      <div className="re-grid">
        {/* Left sidebar: home key, interval lens, constellations */}
        <div className="re-col-left">
          <div className="re-panel re-stack">
            <div className="re-panel-head">
              <div>
                <h3>Home Star</h3>
                <p>Pick where gravity points</p>
              </div>
            </div>
            <div className="re-stack-sm">
              <label className="re-micro-label" htmlFor="sp-root">
                Root note
              </label>
              <select id="sp-root" className="re-select" value={root} onChange={e => setRoot(e.target.value as NoteName)}>
                {NOTE_NAMES.map(n => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="re-stack-sm">
              <span className="re-micro-label">Mode · bright → dark</span>
              <div className="sp-mode-list">
                {MODES.map(m => (
                  <button
                    key={m.id}
                    type="button"
                    className={`sp-mode-btn${m.id === modeId ? ' active' : ''}`}
                    onClick={() => setModeId(m.id)}
                    title={m.feel}
                  >
                    <span className="sp-mode-name">
                      {m.name}
                      {m.alias ? <small> · {m.alias}</small> : null}
                    </span>
                    <span className="sp-mode-k">{formatK(3 - m.brightnessRank)}</span>
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="re-play-btn" onClick={handlePlayScale}>
              <IconPlay />
              <span>
                Play {root} {mode.name}
              </span>
            </button>
            <p className="sp-blurb">{mode.feel}</p>
            <div className="re-stack-sm">
              <span className="re-micro-label">Same seven stars, different home</span>
              <div className="sp-relative-list">
                {relatives.map(rel => {
                  const isCurrent = rel.mode.id === modeId;
                  return (
                    <button
                      key={rel.mode.id}
                      type="button"
                      className={`sp-relative-btn${isCurrent ? ' active' : ''}`}
                      onClick={() => handleRelative(rel.root, rel.mode.id)}
                      title={`Keep these notes, make ${rel.root} home`}
                    >
                      {rel.root} {rel.mode.name}
                    </button>
                  );
                })}
              </div>
              <p className="sp-hint">
                One constellation, seven names — a mode is just the same scale heard from a different home star.
              </p>
            </div>
          </div>

          <div className="re-panel re-stack">
            <div className="re-panel-head">
              <div>
                <h3>Interval Lens</h3>
                <p>Feelings as distances from home</p>
              </div>
            </div>
            <div className="sp-interval-grid">
              {SPACE_INTERVALS.map(def => (
                <button
                  key={def.semitones}
                  type="button"
                  className={`sp-interval-btn${def.semitones === intervalSemitones ? ' active' : ''}`}
                  onClick={() => handleSelectInterval(def.semitones)}
                  title={def.name}
                >
                  {def.short}
                </button>
              ))}
            </div>
            <div className="sp-interval-info">
              <div className="re-row-between">
                <span className="sp-interval-name">
                  {root} → {noteOfPc((tonicPc + intervalSemitones) % 12)} · {interval.name}
                </span>
                <span className="re-readout">{intervalSemitones} st</span>
              </div>
              <div className="sp-meter">
                <span className="re-micro-label">Harmonic distance</span>
                <span className="sp-meter-bar">
                  <span className="sp-meter-fill dist" style={{ '--w': `${(Math.abs(interval.fifths) / 6) * 100}%` } as CSSProperties} />
                </span>
                <span className="sp-meter-val">
                  {Math.abs(interval.fifths)} fifth{Math.abs(interval.fifths) === 1 ? '' : 's'}
                  {interval.fifths === 0 ? '' : interval.fifths > 0 ? ' sharp' : ' flat'}
                </span>
              </div>
              <div className="sp-meter">
                <span className="re-micro-label">Smoothness</span>
                <span className="sp-meter-bar">
                  <span className="sp-meter-fill smooth" style={{ '--w': `${interval.smoothness * 100}%` } as CSSProperties} />
                </span>
                <span className="sp-meter-val">{Math.round(interval.smoothness * 100)}%</span>
              </div>
              <p className="sp-blurb">“{interval.feel}.” {interval.spatial}</p>
            </div>
            <div className="he-row-2">
              <button type="button" className="re-secondary-btn" onClick={() => handlePlayInterval('melodic')}>
                Play melodic
              </button>
              <button type="button" className="re-secondary-btn" onClick={() => handlePlayInterval('harmonic')}>
                Play harmonic
              </button>
            </div>
            <p className="sp-hint">Or click any star in the space to hear it against home.</p>
          </div>

          <div className="re-panel re-stack">
            <div className="re-panel-head">
              <div>
                <h3>Constellations</h3>
                <p>Diatonic triads as triangles</p>
              </div>
            </div>
            <div className="sp-chord-grid">
              {triads.map(triad => (
                <button
                  key={triad.degreeIndex}
                  type="button"
                  className={`sp-chord-btn q-${triad.quality}${chordDegree === triad.degreeIndex ? ' active' : ''}`}
                  onClick={() => handleSelectChord(triad.degreeIndex)}
                  title={`${triad.name} — ${QUALITY_WORD[triad.quality]}`}
                >
                  <span className="sp-chord-numeral">{triad.numeral}</span>
                  <span className="sp-chord-name">{triad.name}</span>
                </button>
              ))}
            </div>
            {selectedTriad ? (
              <div className="sp-interval-info">
                <div className="re-row-between">
                  <span className="sp-interval-name">
                    {selectedTriad.numeral} · {selectedTriad.name} {QUALITY_WORD[selectedTriad.quality]}
                  </span>
                  <span className="re-readout">{selectedTriad.pcs.map(pc => noteOfPc(pc)).join('–')}</span>
                </div>
                <div className="sp-meter">
                  <span className="re-micro-label">Harmonic reach</span>
                  <span className="sp-meter-bar">
                    <span
                      className="sp-meter-fill dist"
                      style={{ '--w': `${Math.min(100, (selectedTriad.spread / 14) * 100)}%` } as CSSProperties}
                    />
                  </span>
                  <span className="sp-meter-val">{selectedTriad.spread} fifths total</span>
                </div>
                <p className="sp-blurb">In the space it draws {TRIAD_FEEL[selectedTriad.quality]}.</p>
              </div>
            ) : (
              <p className="sp-hint">Select a numeral to draw its triangle between the stars and hear it.</p>
            )}
          </div>
        </div>

        {/* Right: the space itself + ladder + field notes */}
        <div className="re-col-right">
          <div className="re-viz">
            <div className="re-viz-overlay">
              <h2 className="re-viz-title">
                {root} {modeLabel}
              </h2>
              <p className="re-viz-subtitle">
                {arrangement === 'fifths' ? 'Circle of fifths' : 'Chromatic ring'}
                {altitude >= 8 ? ' · brightness helix' : ''}
              </p>
            </div>
            <div className="re-canvas-main sp-canvas-main">
              <canvas ref={cvRef} className="re-canvas sp-canvas" />
            </div>
            <div className="sp-controls">
              <div className="sp-control">
                <span className="re-micro-label">Arrangement</span>
                <div className="he-pill-row">
                  {(
                    [
                      { id: 'fifths', label: 'Fifths' },
                      { id: 'chromatic', label: 'Chromatic' }
                    ] as { id: ArrangementId; label: string }[]
                  ).map(a => (
                    <button
                      key={a.id}
                      type="button"
                      className={`re-pill he-pill-btn${arrangement === a.id ? ' on' : ''}`}
                      onClick={() => setArrangement(a.id)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sp-control sp-control-grow">
                <div className="re-slider-head sm">
                  <label htmlFor="sp-altitude">Lift · flat ring → brightness helix</label>
                  <span className="re-slider-val sm">{altitude}%</span>
                </div>
                <input
                  id="sp-altitude"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={altitude}
                  onChange={e => setAltitude(parseInt(e.target.value, 10))}
                />
              </div>
              <div className="sp-control">
                <span className="re-micro-label">Drift</span>
                <button
                  type="button"
                  className={`re-pill he-pill-btn${autoSpin ? ' on' : ''}`}
                  onClick={() => setAutoSpin(v => !v)}
                >
                  {autoSpin ? 'Orbiting' : 'Held'}
                </button>
              </div>
            </div>
            <p className="sp-canvas-hint">drag to orbit · scroll to zoom · click a star to hear it against home</p>
          </div>

          <div className="re-panel">
            <div className="re-panel-title">
              <h3>The Fifths Ladder</h3>
            </div>
            <p className="re-panel-sub">
              Every major-family scale is seven consecutive fifths — one unbroken run, dark end to bright end. The
              run&apos;s centre sits {formatK(3 - mode.brightnessRank)} fifths from your home star; that offset{' '}
              <em>is</em> the mode.
            </p>
            <div className="sp-ladder">
              {ladder.map(deg => (
                <button
                  key={deg.pc}
                  type="button"
                  className={`sp-ladder-chip${deg.k === 0 ? ' home' : ''}`}
                  onClick={() => handleLadderClick(deg.pc)}
                  title={`Degree ${deg.degreeIndex + 1} · ${formatK(deg.k)} fifths from home`}
                >
                  <span className="sp-ladder-note">{deg.note}</span>
                  <span className="sp-ladder-k">{deg.k === 0 ? 'HOME' : formatK(deg.k)}</span>
                  <span className="sp-ladder-deg">deg {deg.degreeIndex + 1}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="re-panel">
            <div className="re-panel-title">
              <h3>Field Notes</h3>
            </div>
            <div className="sp-notes-grid">
              <div className="re-micro-card sp-note-card">
                <div className="re-micro-label">Reading the ring</div>
                <p>{arrangementNote}</p>
              </div>
              <div className="re-micro-card sp-note-card">
                <div className="re-micro-label">The brightness axis</div>
                <p>{altitudeNote}</p>
              </div>
              <div className="re-micro-card sp-note-card">
                <div className="re-micro-label">This constellation</div>
                <p>
                  {root} {modeLabel} keeps {starsAbove} star{starsAbove === 1 ? '' : 's'} above home and {starsBelow}{' '}
                  below — that balance of light and shadow is the mode’s whole personality. Re-home the constellation
                  above to feel it tip.
                </p>
              </div>
              <div className="re-micro-card sp-note-card">
                <div className="re-micro-label">Interval distance</div>
                <p>
                  Two notes can be close to the ear but far in harmony: the minor second sits next door in pitch yet
                  five fifths away around the ring. Short beams feel like rest, long beams feel like reach.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
