import { NOTE_NAMES, type NoteName } from '@music-lab/lib/musicData';
import {
  CHORD_QUALITIES,
  VOICINGS,
  type ChordQualityId,
  type ExtensionId,
  type RegisterId,
  type VoicingId
} from '@music-lab/lib/harmonyData';
import {
  allowedExtensionsFor,
  buildHarmonyGenome,
  chordIntervals,
  type FoundrySettings
} from '@music-lab/lib/harmonyTheory';

const INVERSION_LABELS = ['Root', '1st', '2nd', '3rd', '4th'];
const REGISTERS: { id: RegisterId; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'mid', label: 'Mid' },
  { id: 'high', label: 'High' }
];

interface ChordSlotEditorProps {
  title: string;
  value: FoundrySettings;
  onChange: (settings: FoundrySettings) => void;
  onClose: () => void;
  onRemove?: () => void;
}

/** Sanitizes a foundry edit: clamps extension and inversion to the new quality. */
function sanitize(settings: FoundrySettings): FoundrySettings {
  const allowed = allowedExtensionsFor(settings.quality);
  const extension = allowed.some(e => e.id === settings.extension) ? settings.extension : 'none';
  const size = chordIntervals(settings.quality, extension).length;
  const inversion = Math.min(settings.inversion, Math.min(size - 1, 3));
  return { ...settings, extension, inversion };
}

export function ChordSlotEditor({ title, value, onChange, onClose, onRemove }: ChordSlotEditorProps) {
  const genome = buildHarmonyGenome(value);
  const allowedExts = allowedExtensionsFor(value.quality);
  const maxInversion = Math.min(chordIntervals(value.quality, value.extension).length - 1, 3);

  const update = (partial: Partial<FoundrySettings>) => {
    onChange(sanitize({ ...value, ...partial }));
  };

  return (
    <div className="stage-chord-editor re-panel" role="dialog" aria-label={`Edit ${title}`}>
      <div className="stage-chord-editor-head">
        <div>
          <span className="re-micro-label">{title}</span>
          <strong className="stage-chord-editor-name">{genome.name}</strong>
        </div>
        <div className="stage-chord-editor-actions">
          {onRemove ? (
            <button type="button" className="stage-perf-btn remove" onClick={onRemove} title="Remove chord">
              ×
            </button>
          ) : null}
          <button type="button" className="stage-perf-btn on" onClick={onClose} title="Done">
            ✓
          </button>
        </div>
      </div>

      <div className="stage-chord-editor-grid">
        <div className="re-stack-sm">
          <label className="re-micro-label" htmlFor="cse-root">
            Root
          </label>
          <select
            id="cse-root"
            className="re-select"
            value={value.root}
            onChange={e => update({ root: e.target.value as NoteName })}
          >
            {NOTE_NAMES.map(n => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <div className="re-stack-sm">
          <label className="re-micro-label" htmlFor="cse-quality">
            Quality
          </label>
          <select
            id="cse-quality"
            className="re-select"
            value={value.quality}
            onChange={e => update({ quality: e.target.value as ChordQualityId })}
          >
            {CHORD_QUALITIES.map(q => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
        </div>

        <div className="re-stack-sm">
          <label className="re-micro-label" htmlFor="cse-extension">
            Extension
          </label>
          <select
            id="cse-extension"
            className="re-select"
            value={value.extension}
            onChange={e => update({ extension: e.target.value as ExtensionId })}
          >
            {allowedExts.map(ext => (
              <option key={ext.id} value={ext.id}>
                {ext.label}
              </option>
            ))}
          </select>
        </div>

        <div className="re-stack-sm">
          <label className="re-micro-label" htmlFor="cse-inversion">
            Inversion
          </label>
          <select
            id="cse-inversion"
            className="re-select"
            value={value.inversion}
            onChange={e => update({ inversion: parseInt(e.target.value, 10) })}
          >
            {Array.from({ length: maxInversion + 1 }, (_, i) => (
              <option key={i} value={i}>
                {INVERSION_LABELS[i] ?? `${i}th`}
              </option>
            ))}
          </select>
        </div>

        <div className="re-stack-sm">
          <label className="re-micro-label" htmlFor="cse-voicing">
            Voicing
          </label>
          <select
            id="cse-voicing"
            className="re-select"
            value={value.voicing}
            onChange={e => update({ voicing: e.target.value as VoicingId })}
          >
            {VOICINGS.map(v => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        <div className="re-stack-sm">
          <label className="re-micro-label" htmlFor="cse-register">
            Register
          </label>
          <select
            id="cse-register"
            className="re-select"
            value={value.register}
            onChange={e => update({ register: e.target.value as RegisterId })}
          >
            {REGISTERS.map(r => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="stage-chord-editor-notes">{genome.noteNames.join(' · ')}</p>
    </div>
  );
}
