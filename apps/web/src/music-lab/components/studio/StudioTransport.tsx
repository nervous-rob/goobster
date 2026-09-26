import { useEffect, useState, type KeyboardEvent } from 'react';
import { GroovePicker } from '@music-lab/components/shared/GroovePicker';
import type { LibraryGroove } from '@music-lab/lib/genreLibrary';
import { formatClock } from '@music-lab/lib/songEdit';

export const BPM_MIN = 40;
export const BPM_MAX = 200;

interface StudioTransportProps {
  isPlaying: boolean;
  audioReady: boolean;
  isRecording: boolean;
  onRecord: () => void;
  bpm: number;
  swing: number;
  loop: boolean;
  loopRegionLabel: string;
  metronome: boolean;
  onMetronomeChange: (on: boolean) => void;
  positionMeasure: number | null;
  positionSub: number | null;
  totalMeasures: number;
  /** Wall-clock position and length of the song at the current tempo. */
  elapsedSeconds: number;
  totalSeconds: number;
  rhythmLabel: string;
  grooveId: string;
  onGrooveSelect: (groove: LibraryGroove) => void;
  onGrooveClear: () => void;
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

export function StudioTransport({
  isPlaying,
  audioReady,
  isRecording,
  onRecord,
  bpm,
  swing,
  loop,
  loopRegionLabel,
  metronome,
  onMetronomeChange,
  positionMeasure,
  positionSub,
  totalMeasures,
  elapsedSeconds,
  totalSeconds,
  rhythmLabel,
  grooveId,
  onGrooveSelect,
  onGrooveClear,
  onPlay,
  onStop,
  onBpmChange,
  onBpmNudge,
  onSwingChange,
  onLoopChange
}: StudioTransportProps) {
  const positionLabel =
    positionMeasure !== null
      ? `${positionMeasure + 1}.${(positionSub ?? 0) + 1} / ${totalMeasures}`
      : `1.1 / ${totalMeasures}`;

  // The BPM box is a draft while focused: clamping on every keystroke made
  // "120" impossible to type (the "1" snapped to 40). Commit on blur/Enter.
  const [bpmDraft, setBpmDraft] = useState(String(bpm));
  useEffect(() => {
    setBpmDraft(String(bpm));
  }, [bpm]);

  const commitBpm = () => {
    const parsed = parseInt(bpmDraft, 10);
    if (Number.isNaN(parsed)) {
      setBpmDraft(String(bpm));
      return;
    }
    const next = Math.min(BPM_MAX, Math.max(BPM_MIN, parsed));
    setBpmDraft(String(next));
    if (next !== bpm) onBpmChange(next);
  };

  const onBpmKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setBpmDraft(String(bpm));
      e.currentTarget.blur();
    }
  };

  return (
    <div className="stage-transport" role="toolbar" aria-label="Studio transport">
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
        <button
          type="button"
          className={`stage-transport-btn record${isRecording ? ' on' : ''}`}
          onClick={onRecord}
          aria-pressed={isRecording}
          aria-label={isRecording ? 'Finish recording and download' : 'Record the song to a WAV file'}
          title={isRecording ? 'Finish recording and download' : 'Record from the top and download as WAV'}
        >
          ●
        </button>
        <span className={`stage-transport-led${isPlaying ? ' on' : audioReady ? ' ready' : ''}`} aria-hidden />
      </div>

      <div className="stage-transport-field stage-transport-groove">
        <label className="stage-transport-label" htmlFor="studio-groove">
          Groove
        </label>
        <GroovePicker id="studio-groove" value={grooveId} onSelect={onGrooveSelect} onClear={onGrooveClear} />
      </div>

      <div className="stage-transport-field">
        <label className="stage-transport-label" htmlFor="studio-bpm">
          BPM
        </label>
        <div className="stage-transport-bpm">
          <button type="button" className="stage-transport-nudge" onClick={() => onBpmNudge(-1)} aria-label="Decrease BPM">
            −
          </button>
          <input
            id="studio-bpm"
            type="number"
            inputMode="numeric"
            min={BPM_MIN}
            max={BPM_MAX}
            value={bpmDraft}
            onChange={e => setBpmDraft(e.target.value)}
            onBlur={commitBpm}
            onKeyDown={onBpmKey}
          />
          <button type="button" className="stage-transport-nudge" onClick={() => onBpmNudge(1)} aria-label="Increase BPM">
            +
          </button>
        </div>
      </div>

      <div className="stage-transport-field stage-transport-swing">
        <label className="stage-transport-label" htmlFor="studio-swing">
          Swing {Math.round(swing * 100)}%
        </label>
        <input
          id="studio-swing"
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
        title={loop ? `Looping: ${loopRegionLabel} (L to toggle)` : 'Loop is off — the song plays once (L to toggle)'}
      >
        Loop · {loopRegionLabel}
      </button>

      <button
        type="button"
        className={`stage-transport-loop st-click${metronome ? ' on' : ''}`}
        onClick={() => onMetronomeChange(!metronome)}
        aria-pressed={metronome}
        title={metronome ? 'Metronome click is on (not recorded)' : 'Metronome click on every beat — never in the recording'}
      >
        Click
      </button>

      <div className="stage-transport-position">
        <span className="stage-transport-label">Position</span>
        <strong>{positionLabel}</strong>
        <span className="stage-transport-meta st-clock" aria-label="Elapsed time and song length">
          {formatClock(elapsedSeconds)} / {formatClock(totalSeconds)}
        </span>
        <span className="stage-transport-meta">
          {rhythmLabel} · {totalMeasures} measures
        </span>
      </div>
    </div>
  );
}
