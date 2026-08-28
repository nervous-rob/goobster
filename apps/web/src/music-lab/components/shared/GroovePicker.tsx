import { useMemo } from 'react';
import { LIBRARY_GROOVES, type LibraryGroove } from '@music-lab/lib/genreLibrary';
import { RHYTHMS } from '@music-lab/lib/rhythmData';

interface GroovePickerProps {
  id: string;
  /** Currently applied groove id ('' = custom / none). */
  value: string;
  onSelect: (groove: LibraryGroove) => void;
  onClear?: () => void;
}

function grooveLabel(groove: LibraryGroove): string {
  const rhythm = RHYTHMS.find(r => r.id === groove.rhythmId);
  const bits = [`${groove.bpm} BPM`, rhythm?.label ?? groove.rhythmId];
  if (groove.resolution === 'sixteenth') bits.push('16ths');
  if (groove.swing > 0) bits.push(`${Math.round(groove.swing * 100)}% swing`);
  return `${groove.name} · ${bits.join(' · ')}`;
}

/**
 * Genre-library groove select: one tap sets BPM, swing, meter, grid
 * resolution, and the drum pattern. Grouped by genre.
 */
export function GroovePicker({ id, value, onSelect, onClear }: GroovePickerProps) {
  const groups = useMemo(() => {
    const out: { genre: string; grooves: LibraryGroove[] }[] = [];
    LIBRARY_GROOVES.forEach(groove => {
      let group = out.find(g => g.genre === groove.genre);
      if (!group) {
        group = { genre: groove.genre, grooves: [] };
        out.push(group);
      }
      group.grooves.push(groove);
    });
    return out;
  }, []);

  return (
    <select
      id={id}
      className="re-select"
      value={value}
      onChange={e => {
        const groove = LIBRARY_GROOVES.find(g => g.id === e.target.value);
        if (groove) onSelect(groove);
        else onClear?.();
      }}
    >
      <option value="">— custom (dial it in yourself) —</option>
      {groups.map(group => (
        <optgroup key={group.genre} label={group.genre}>
          {group.grooves.map(groove => (
            <option key={groove.id} value={groove.id} title={groove.blurb}>
              {grooveLabel(groove)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
