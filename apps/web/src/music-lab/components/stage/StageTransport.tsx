interface StageTransportProps {
  isPlaying: boolean;
  audioReady: boolean;
  bpm: number;
  swing: number;
  loop: boolean;
  rhythmLabel: string;
  phraseLength: number;
  chordCount: number;
  measuresPerChord: number;
  transportMeasure: number | null;
  transportSub: number | null;
  onPlay: () => void;
  onStop: () => void;
  onBpmChange: (bpm: number) => void;
  onBpmNudge: (delta: number) => void;
  onSwingChange: (swing: number) => void;
  onLoopChange: (loop: boolean) => void;
}

function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 1.6v12.8c0 .9 1 1.4 1.7 1L15 8.9c.7-.4.7-1.4 0-1.8L4.7.6C4 .2 3 .7 3 1.6z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <rect x="2" y="1" width="3.5" height="12" rx="1" />
      <rect x="8.5" y="1" width="3.5" height="12" rx="1" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <rect x="1" y="1" width="12" height="12" rx="2" />
    </svg>
  );
}

export function StageTransport({
  isPlaying,
  audioReady,
  bpm,
  swing,
  loop,
  rhythmLabel,
  phraseLength,
  chordCount,
  measuresPerChord,
  transportMeasure,
  transportSub,
  onPlay,
  onStop,
  onBpmChange,
  onBpmNudge,
  onSwingChange,
  onLoopChange
}: StageTransportProps) {
  const positionLabel =
    transportMeasure !== null
      ? `${transportMeasure}.${transportSub ?? 1} / ${phraseLength}`
      : `1.1 / ${phraseLength}`;

  return (
    <div className="stage-transport" role="toolbar" aria-label="Transport">
      <div className="stage-transport-transport">
        <button
          type="button"
          className={`stage-transport-btn play${isPlaying ? ' on' : ''}`}
          onClick={onPlay}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <IconPause /> : <IconPlay />}
        </button>
        <button type="button" className="stage-transport-btn stop" onClick={onStop} aria-label="Stop and rewind">
          <IconStop />
        </button>
        <span className={`stage-transport-led${isPlaying ? ' on' : audioReady ? ' ready' : ''}`} aria-hidden />
      </div>

      <div className="stage-transport-field">
        <label className="stage-transport-label" htmlFor="transport-bpm">
          BPM
        </label>
        <div className="stage-transport-bpm">
          <button type="button" className="stage-transport-nudge" onClick={() => onBpmNudge(-1)} aria-label="Decrease BPM">
            −
          </button>
          <input
            id="transport-bpm"
            type="number"
            min={40}
            max={200}
            value={bpm}
            onChange={e => {
              const v = parseInt(e.target.value, 10);
              if (!Number.isNaN(v)) onBpmChange(Math.min(200, Math.max(40, v)));
            }}
          />
          <button type="button" className="stage-transport-nudge" onClick={() => onBpmNudge(1)} aria-label="Increase BPM">
            +
          </button>
        </div>
      </div>

      <div className="stage-transport-field stage-transport-swing">
        <label className="stage-transport-label" htmlFor="transport-swing">
          Swing {Math.round(swing * 100)}%
        </label>
        <input
          id="transport-swing"
          type="range"
          min={0}
          max={0.5}
          step={0.01}
          value={swing}
          onChange={e => onSwingChange(parseFloat(e.target.value))}
        />
      </div>

      <button
        type="button"
        className={`stage-transport-loop${loop ? ' on' : ''}`}
        onClick={() => onLoopChange(!loop)}
        aria-pressed={loop}
      >
        Loop
      </button>

      <div className="stage-transport-position">
        <span className="stage-transport-label">Position</span>
        <strong>{positionLabel}</strong>
        <span className="stage-transport-meta">
          {rhythmLabel} · {chordCount} chords × {measuresPerChord}m
        </span>
      </div>
    </div>
  );
}
