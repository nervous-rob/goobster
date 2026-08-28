import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useContourLibrary } from '@music-lab/hooks/useContourLibrary';
import { buildHarmonyGenome } from '@music-lab/lib/harmonyTheory';
import { GENERIC_BAR_SUBS, resolveContour, type ContourTone, type MelodyContourStep } from '@music-lab/lib/melodyTheory';
import { makeContourId, type ContourPreset } from '@music-lab/lib/stageData';
import { resolveTone, type TonalSynth } from '@music-lab/lib/stageInstruments';

interface ContourDesignerProps {
  /** Unique prefix for element ids (the designer can mount on several pages). */
  idPrefix: string;
}

interface GridRow {
  tone: ContourTone;
  octave: -1 | 0 | 1;
  label: string;
}

const TONE_ORDER: { tone: ContourTone; label: string }[] = [
  { tone: 'seventh', label: '7' },
  { tone: 'fifth', label: '5' },
  { tone: 'third', label: '3' },
  { tone: 'root', label: 'R' }
];

const ROWS: GridRow[] = [
  ...([1, 0, -1] as const).flatMap(octave =>
    TONE_ORDER.map(t => ({
      tone: t.tone,
      octave,
      label: octave === 0 ? t.label : `${t.label}${octave > 0 ? '+' : '−'}`
    }))
  ),
  { tone: 'approach', octave: 0, label: '≈' }
];

/** Click-to-lengthen cycle: 1 → 2 → 3 → 4 → 6 → 8 → removed. */
const LENGTH_CYCLE = [1, 2, 3, 4, 6, 8];

const STARTER_STEPS: MelodyContourStep[] = [
  { sub: 0, tone: 'root', octave: 0, lengthSubs: 2 },
  { sub: 2, tone: 'third', octave: 0, lengthSubs: 2 },
  { sub: 4, tone: 'fifth', octave: 0, lengthSubs: 2 },
  { sub: 6, tone: 'seventh', octave: 0, lengthSubs: 2 }
];

/**
 * Contour Designer: draw a playing pattern on the generic 8-step bar —
 * chord degrees across three octaves plus an approach-tone lane. Saved
 * contours join the contour library everywhere (creatures, stage, studio).
 */
export function ContourDesigner({ idPrefix }: ContourDesignerProps) {
  const { customContours, allContours, saveContour, deleteContour } = useContourLibrary();

  const [steps, setSteps] = useState<MelodyContourStep[]>(STARTER_STEPS);
  const [name, setName] = useState('');
  const [flavor, setFlavor] = useState('');
  const [flash, setFlash] = useState<string | null>(null);

  const previewSynthsRef = useRef<TonalSynth[]>([]);

  useEffect(() => {
    return () => {
      previewSynthsRef.current.forEach(s => s.dispose());
      previewSynthsRef.current = [];
    };
  }, []);

  // Effective note lengths: a note rings until its length runs out, the next
  // onset arrives, or the bar ends — exactly how resolveContour trims them.
  const onsetSubs = useMemo(() => [...new Set(steps.map(s => s.sub))].sort((a, b) => a - b), [steps]);
  const effectiveLength = useCallback(
    (step: MelodyContourStep): number => {
      const nextOnset = onsetSubs.find(sub => sub > step.sub) ?? GENERIC_BAR_SUBS;
      return Math.min(step.lengthSubs, nextOnset - step.sub, GENERIC_BAR_SUBS - step.sub);
    },
    [onsetSubs]
  );

  const handleCell = useCallback((row: GridRow, sub: number) => {
    setSteps(prev => {
      const atSub = prev.find(s => s.sub === sub);
      if (atSub && atSub.tone === row.tone && atSub.octave === row.octave) {
        const index = LENGTH_CYCLE.indexOf(atSub.lengthSubs);
        const next = LENGTH_CYCLE[index + 1];
        if (next === undefined) return prev.filter(s => s.sub !== sub);
        return prev.map(s => (s.sub === sub ? { ...s, lengthSubs: next } : s));
      }
      // One onset per subdivision: placing a note replaces whatever was there.
      const without = prev.filter(s => s.sub !== sub);
      return [...without, { sub, tone: row.tone, octave: row.octave, lengthSubs: 1 }].sort((a, b) => a.sub - b.sub);
    });
  }, []);

  const handleStartFrom = useCallback(
    (contourId: string) => {
      const preset = allContours.find(c => c.id === contourId);
      if (!preset) return;
      setSteps(preset.steps.map(s => ({ ...s })));
      setName('');
      setFlavor(preset.flavor);
    },
    [allContours]
  );

  const previewContour = useCallback(async () => {
    if (!steps.length) return;
    const Tone = await resolveTone();
    previewSynthsRef.current.forEach(s => s.dispose());
    previewSynthsRef.current = [];

    const genome = buildHarmonyGenome({
      root: 'C',
      quality: 'major',
      extension: 'maj7',
      inversion: 0,
      voicing: 'closed',
      register: 'mid'
    });
    const lane = resolveContour(steps, genome, null, 4, GENERIC_BAR_SUBS);

    const lead = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.01, decay: 0.15, sustain: 0.5, release: 0.4 }
    }).toDestination();
    lead.volume.value = -6;
    const pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.03, decay: 0.3, sustain: 0.5, release: 0.8 }
    }).toDestination();
    pad.volume.value = -18;
    previewSynthsRef.current = [lead, pad];

    const stepSeconds = 0.22;
    const now = Tone.now() + 0.06;
    genome.midi.forEach((midi, i) => {
      pad.triggerAttackRelease(Tone.Frequency(midi, 'midi').toFrequency(), GENERIC_BAR_SUBS * stepSeconds, now + i * 0.015, 0.7);
    });
    lane.forEach((note, i) => {
      if (!note) return;
      lead.triggerAttackRelease(
        Tone.Frequency(note.midi, 'midi').toFrequency(),
        Math.max(0.1, note.durSubs * stepSeconds * 0.9),
        now + i * stepSeconds,
        0.85
      );
    });

    window.setTimeout(() => {
      previewSynthsRef.current.forEach(s => s.dispose());
      previewSynthsRef.current = [];
    }, (GENERIC_BAR_SUBS * stepSeconds + 1.5) * 1000);
  }, [steps]);

  const handleSave = useCallback(() => {
    if (!steps.length) return;
    const preset: ContourPreset = {
      id: makeContourId(),
      name: name.trim() || 'Custom Contour',
      flavor: flavor.trim() || 'Hand-drawn in the contour designer.',
      steps: [...steps].sort((a, b) => a.sub - b.sub)
    };
    saveContour(preset);
    setFlash(`Saved “${preset.name}” — it's now in every contour menu.`);
    window.setTimeout(() => setFlash(null), 2600);
  }, [flavor, name, saveContour, steps]);

  const handleLoad = useCallback((preset: ContourPreset) => {
    setSteps(preset.steps.map(s => ({ ...s })));
    setName(preset.name);
    setFlavor(preset.flavor);
  }, []);

  return (
    <div className="re-panel re-stack cd-panel">
      <div className="re-panel-head">
        <div>
          <h3>Contour Designer</h3>
          <p>Draw how a creature rides any chord, in any key</p>
        </div>
      </div>

      <div className="cd-grid" role="grid" aria-label="Contour step grid">
        <span className="cd-corner" aria-hidden />
        {Array.from({ length: GENERIC_BAR_SUBS }, (_, sub) => (
          <span key={`head-${sub}`} className={`cd-col-head${sub % 2 === 0 ? ' strong' : ''}`}>
            {sub + 1}
          </span>
        ))}
        {ROWS.map(row => (
          <RowCells
            key={`${row.tone}-${row.octave}`}
            row={row}
            steps={steps}
            effectiveLength={effectiveLength}
            onCell={handleCell}
          />
        ))}
      </div>

      <p className="vb-note">
        Tap a cell to place a note (R/3/5/7 across three octaves, ≈ slides a half-step into the next note). Tap a note
        again to lengthen it: 1 → 2 → 3 → 4 → 6 → 8 steps, then off. One note per step — the newest wins.
      </p>

      <div className="vb-row">
        <div className="re-stack-sm vb-grow">
          <label className="re-micro-label" htmlFor={`${idPrefix}-cd-start`}>
            Start from
          </label>
          <select
            id={`${idPrefix}-cd-start`}
            className="re-select"
            value=""
            onChange={e => {
              if (e.target.value) handleStartFrom(e.target.value);
            }}
          >
            <option value="">— copy an existing contour —</option>
            {allContours.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="re-secondary-btn" onClick={() => setSteps([])}>
          Clear
        </button>
      </div>

      <div className="vb-row">
        <div className="re-stack-sm vb-grow">
          <label className="re-micro-label" htmlFor={`${idPrefix}-cd-name`}>
            Contour name
          </label>
          <input
            id={`${idPrefix}-cd-name`}
            className="re-select"
            type="text"
            maxLength={28}
            placeholder="My Contour"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </div>
        <div className="re-stack-sm vb-grow">
          <label className="re-micro-label" htmlFor={`${idPrefix}-cd-flavor`}>
            Flavor text
          </label>
          <input
            id={`${idPrefix}-cd-flavor`}
            className="re-select"
            type="text"
            maxLength={90}
            placeholder="What does it feel like?"
            value={flavor}
            onChange={e => setFlavor(e.target.value)}
          />
        </div>
      </div>

      <div className="vb-row">
        <button type="button" className="re-secondary-btn" onClick={() => void previewContour()} disabled={!steps.length}>
          ▶ Preview on Cmaj7
        </button>
        <button type="button" className="re-play-btn vb-grow" onClick={handleSave} disabled={!steps.length}>
          Save contour
        </button>
      </div>

      {flash ? <p className="vb-flash">{flash}</p> : null}

      <div className="re-stack-sm">
        <span className="re-micro-label">Your contours ({customContours.length})</span>
        {customContours.length ? (
          <div className="vb-voice-list">
            {customContours.map(contour => (
              <div key={contour.id} className="vb-voice-row">
                <div className="vb-voice-info">
                  <strong>{contour.name}</strong>
                  <span>{contour.steps.length} notes</span>
                </div>
                <button
                  type="button"
                  className="vb-icon-btn"
                  onClick={() => handleLoad(contour)}
                  title="Load into the designer"
                >
                  ↺
                </button>
                <button
                  type="button"
                  className="vb-icon-btn remove"
                  onClick={() => deleteContour(contour.id)}
                  title="Delete contour"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="vb-note">Nothing drawn yet — contours you save here appear in every contour menu.</p>
        )}
      </div>
    </div>
  );
}

interface RowCellsProps {
  row: GridRow;
  steps: MelodyContourStep[];
  effectiveLength: (step: MelodyContourStep) => number;
  onCell: (row: GridRow, sub: number) => void;
}

function RowCells({ row, steps, effectiveLength, onCell }: RowCellsProps) {
  const isApproach = row.tone === 'approach';
  return (
    <>
      <span className={`cd-row-label${isApproach ? ' approach' : ''}${row.octave !== 0 ? ' shifted' : ''}`}>
        {row.label}
      </span>
      {Array.from({ length: GENERIC_BAR_SUBS }, (_, sub) => {
        const head = steps.find(s => s.sub === sub && s.tone === row.tone && s.octave === row.octave);
        const tailOwner = head
          ? undefined
          : steps.find(
              s => s.tone === row.tone && s.octave === row.octave && s.sub < sub && s.sub + effectiveLength(s) > sub
            );
        const classes = ['cd-cell'];
        if (sub % 2 === 0) classes.push('strong');
        if (isApproach) classes.push('approach');
        if (head) classes.push('head');
        else if (tailOwner) classes.push('tail');
        return (
          <button
            key={sub}
            type="button"
            className={classes.join(' ')}
            onClick={() => onCell(row, sub)}
            aria-label={`${row.label} at step ${sub + 1}${head ? `, length ${head.lengthSubs}` : ''}`}
            title={head ? `Length ${head.lengthSubs} — tap to lengthen` : undefined}
          />
        );
      })}
    </>
  );
}
