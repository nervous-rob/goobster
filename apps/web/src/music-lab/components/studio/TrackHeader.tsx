import { ROLE_META, isDrumRole } from '@music-lab/lib/stageData';
import { findVoice } from '@music-lab/lib/voiceData';
import type { SongTrack } from '@music-lab/lib/songData';
import type { MenuPoint } from './SectionStrip';

interface TrackHeaderProps {
  track: SongTrack;
  isSelected: boolean;
  onSelect: () => void;
  onChange: (partial: Partial<SongTrack>) => void;
  onRemove: () => void;
  onContextMenu: (at: MenuPoint) => void;
}

/** Sticky left cell of a timeline row: identity, mute/solo, level. */
export function TrackHeader({ track, isSelected, onSelect, onChange, onRemove, onContextMenu }: TrackHeaderProps) {
  const hue = isDrumRole(track.role) ? null : findVoice(track.performer.voiceId).hue;

  return (
    <div
      className={`st-track-head${isSelected ? ' selected' : ''}`}
      onContextMenu={e => {
        e.preventDefault();
        onContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <button
        type="button"
        className="st-track-name"
        onClick={onSelect}
        title={isSelected ? 'Deselect track' : 'Select track and open it in the Track inspector'}
      >
        <span
          className="st-track-badge"
          style={hue !== null ? { background: `hsla(${hue}, 80%, 60%, 0.25)`, color: `hsl(${hue}, 85%, 72%)` } : undefined}
        >
          {ROLE_META[track.role].short}
        </span>
        <span className="st-track-label">{track.name}</span>
      </button>
      <div className="st-track-controls">
        <button
          type="button"
          className={`st-mini-btn${track.mute ? ' on mute' : ''}`}
          onClick={() => onChange({ mute: !track.mute })}
          aria-pressed={track.mute}
          title={track.mute ? 'Unmute (M with the track selected)' : 'Mute (M with the track selected)'}
        >
          M
        </button>
        <button
          type="button"
          className={`st-mini-btn${track.solo ? ' on solo' : ''}`}
          onClick={() => onChange({ solo: !track.solo })}
          aria-pressed={track.solo}
          title={track.solo ? 'Unsolo (S with the track selected)' : 'Solo (S with the track selected)'}
        >
          S
        </button>
        <input
          className="st-track-vol"
          type="range"
          min={-24}
          max={0}
          step={1}
          value={track.volume}
          onChange={e => onChange({ volume: parseInt(e.target.value, 10) })}
          title={`Level ${track.volume} dB — fine control in the Track inspector`}
          aria-label={`${track.name} level`}
        />
        <button type="button" className="st-mini-btn remove" onClick={onRemove} title="Remove track">
          ×
        </button>
      </div>
    </div>
  );
}
