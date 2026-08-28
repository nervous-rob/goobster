import { NOTE_NAMES, type NoteName, type ScaleQuality } from '@music-lab/lib/musicData';

type PlayMode = 'sequential' | 'together';

interface MusicControlsProps {
  root: NoteName;
  quality: ScaleQuality;
  playMode: PlayMode;
  tempo: number;
  onRootChange: (value: NoteName) => void;
  onQualityChange: (value: ScaleQuality) => void;
  onPlayModeChange?: (value: PlayMode) => void;
  onTempoChange?: (value: number) => void;
  children?: React.ReactNode;
}

export function MusicControls({
  root,
  quality,
  playMode,
  tempo,
  onRootChange,
  onQualityChange,
  onPlayModeChange,
  onTempoChange,
  children
}: MusicControlsProps) {
  return (
    <div className="music-controls" role="region" aria-label="Key and playback controls">
      <label htmlFor="root-note">
        Root note
        <select
          id="root-note"
          value={root}
          onChange={event => onRootChange(event.target.value as NoteName)}
          aria-label="Select root note"
        >
          {NOTE_NAMES.map(note => (
            <option key={note} value={note}>
              {note}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="scale-quality">
        Quality
        <select
          id="scale-quality"
          value={quality}
          onChange={event => onQualityChange(event.target.value as ScaleQuality)}
          aria-label="Select major or minor"
        >
          <option value="major">Major</option>
          <option value="minor">Minor</option>
        </select>
      </label>
      <label htmlFor="play-mode">
        Playback
        <select
          id="play-mode"
          value={playMode}
          onChange={event => onPlayModeChange?.(event.target.value as PlayMode)}
          aria-label="Select playback mode"
        >
          <option value="sequential">Sequential</option>
          <option value="together">Together</option>
        </select>
      </label>
      <label htmlFor="tempo">
        Tempo (BPM)
        <input
          id="tempo"
          type="number"
          min={40}
          max={240}
          step={1}
          value={tempo}
          onChange={event => {
            if (!onTempoChange) return;
            const parsed = Number(event.target.value);
            if (Number.isNaN(parsed)) {
              return;
            }
            const clamped = Math.min(240, Math.max(40, parsed));
            onTempoChange(clamped);
          }}
          aria-label="Set tempo in beats per minute"
        />
      </label>
      {children}
    </div>
  );
}
