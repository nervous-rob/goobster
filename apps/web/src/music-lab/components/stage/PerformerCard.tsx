import { buildHarmonyGenome } from '@music-lab/lib/harmonyTheory';
import { VOICINGS, type RegisterId, type VoicingId } from '@music-lab/lib/harmonyData';
import { findVoice } from '@music-lab/lib/voiceData';
import { useVoiceLibrary } from '@music-lab/hooks/useVoiceLibrary';
import { useContourLibrary } from '@music-lab/hooks/useContourLibrary';
import {
  ROLE_META,
  findContour,
  isDrumRole,
  performerName,
  type PerformerState
} from '@music-lab/lib/stageData';

interface PerformerCardProps {
  performer: PerformerState;
  subdivisions: number;
  strongSubs: number[];
  onChange: (partial: Partial<PerformerState>) => void;
  /** Present only for non-core performers. */
  onRemove?: () => void;
  /** Chord organisms in 'own' mode: open the foundry for one of their slots. */
  onEditOwnChord?: (slotIndex: number) => void;
}

const REGISTER_OPTIONS: { id: RegisterId; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'mid', label: 'Mid' },
  { id: 'high', label: 'High' }
];

export function PerformerCard({
  performer,
  subdivisions,
  strongSubs,
  onChange,
  onRemove,
  onEditOwnChord
}: PerformerCardProps) {
  const meta = ROLE_META[performer.role];
  const active = performer.enabled && !performer.mute;
  const isTonal = !isDrumRole(performer.role);
  const voice = findVoice(performer.voiceId);
  const { allVoices } = useVoiceLibrary();
  const { allContours } = useContourLibrary();

  const toggleStep = (index: number) => {
    const steps = [...(performer.drumSteps ?? Array(subdivisions).fill(false))];
    steps[index] = !steps[index];
    onChange({ drumSteps: steps });
  };

  return (
    <div className={`stage-performer role-${performer.role}${active ? ' on' : ''}${performer.enabled ? '' : ' off'}`}>
      <div className="stage-perf-head">
        <span
          className="stage-perf-badge"
          style={isTonal ? { color: `hsl(${voice.hue}, 75%, 62%)` } : undefined}
        >
          {meta.short}
        </span>
        <div className="stage-perf-id">
          <strong>{performerName(performer)}</strong>
          <span>{isTonal ? `${voice.name} · ${meta.flavor}` : meta.flavor}</span>
        </div>
        <div className="stage-perf-buttons">
          {onRemove ? (
            <button type="button" className="stage-perf-btn remove" onClick={onRemove} title="Remove from troupe">
              ×
            </button>
          ) : null}
          <button
            type="button"
            className={`stage-perf-btn${performer.enabled ? ' on' : ''}`}
            onClick={() => onChange({ enabled: !performer.enabled })}
            aria-pressed={performer.enabled}
            title="On stage"
          >
            E
          </button>
          <button
            type="button"
            className={`stage-perf-btn mute${performer.mute ? ' on' : ''}`}
            onClick={() => onChange({ mute: !performer.mute })}
            aria-pressed={performer.mute}
            title="Mute"
          >
            M
          </button>
        </div>
      </div>

      <div className="stage-perf-volume">
        <input
          type="range"
          min={-36}
          max={0}
          step={1}
          value={performer.volume}
          onChange={e => onChange({ volume: parseInt(e.target.value, 10) })}
          aria-label={`${performerName(performer)} volume`}
        />
        <span className="stage-perf-db">{performer.volume} dB</span>
      </div>

      {isTonal ? (
        <div className="re-stack-sm">
          <label className="re-micro-label" htmlFor={`perf-voice-${performer.id}`}>
            Voice
          </label>
          <select
            id={`perf-voice-${performer.id}`}
            className="re-select"
            value={voice.id}
            onChange={e => onChange({ voiceId: e.target.value })}
          >
            {allVoices.map(v => (
              <option key={v.id} value={v.id}>
                {v.name} — {v.blurb}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {isDrumRole(performer.role) ? (
        <div className="stage-step-grid" role="group" aria-label={`${meta.name} pattern`}>
          {Array.from({ length: subdivisions }, (_, i) => {
            const on = performer.drumSteps?.[i] ?? false;
            const strong = strongSubs.includes(i);
            return (
              <button
                key={i}
                type="button"
                className={`stage-step${on ? ' on' : ''}${strong ? ' strong' : ''}`}
                onClick={() => toggleStep(i)}
                aria-pressed={on}
                aria-label={`Step ${i + 1}`}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
      ) : null}

      {performer.role === 'chords' ? (
        <div className="stage-perf-editor">
          <div className="stage-perf-octaves">
            <span className="re-micro-label">Harmony source</span>
            <div className="re-pills">
              <button
                type="button"
                className={`re-pill${(performer.harmonyMode ?? 'follow') === 'follow' ? ' on' : ''}`}
                onClick={() => onChange({ harmonyMode: 'follow' })}
              >
                Follow song
              </button>
              <button
                type="button"
                className={`re-pill${performer.harmonyMode === 'own' ? ' on' : ''}`}
                onClick={() => onChange({ harmonyMode: 'own' })}
              >
                Own chords
              </button>
            </div>
          </div>

          {(performer.harmonyMode ?? 'follow') === 'follow' ? (
            <div className="he-row-2">
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor={`perf-voicing-${performer.id}`}>
                  Voicing
                </label>
                <select
                  id={`perf-voicing-${performer.id}`}
                  className="re-select"
                  value={performer.voicingOverride ?? 'song'}
                  onChange={e =>
                    onChange({
                      voicingOverride: e.target.value === 'song' ? undefined : (e.target.value as VoicingId)
                    })
                  }
                >
                  <option value="song">As song</option>
                  {VOICINGS.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor={`perf-register-${performer.id}`}>
                  Register
                </label>
                <select
                  id={`perf-register-${performer.id}`}
                  className="re-select"
                  value={performer.registerOverride ?? 'song'}
                  onChange={e =>
                    onChange({
                      registerOverride: e.target.value === 'song' ? undefined : (e.target.value as RegisterId)
                    })
                  }
                >
                  <option value="song">As song</option>
                  {REGISTER_OPTIONS.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <div className="stage-perf-octaves">
              <span className="re-micro-label">Private chord lane — tap to forge</span>
              <div className="stage-chord-chips">
                {(performer.customChords ?? []).map((slot, i) => (
                  <button
                    key={i}
                    type="button"
                    className="stage-chord-chip"
                    onClick={() => onEditOwnChord?.(i)}
                    title="Edit chord"
                  >
                    {buildHarmonyGenome(slot).name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {performer.role === 'bass' || performer.role === 'melody' ? (
        <div className="stage-perf-editor">
          <div className="re-stack-sm">
            <label className="re-micro-label" htmlFor={`perf-contour-${performer.id}`}>
              Contour
            </label>
            <select
              id={`perf-contour-${performer.id}`}
              className="re-select"
              value={performer.contourId ?? allContours[0].id}
              onChange={e => onChange({ contourId: e.target.value })}
            >
              {allContours.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="stage-perf-octaves">
            <span className="re-micro-label">Register</span>
            <div className="re-pills">
              {([-1, 0, 1] as const).map(shift => (
                <button
                  key={shift}
                  type="button"
                  className={`re-pill${(performer.octaveShift ?? 0) === shift ? ' on' : ''}`}
                  onClick={() => onChange({ octaveShift: shift })}
                >
                  {shift > 0 ? `+${shift}` : shift} oct
                </button>
              ))}
            </div>
          </div>
          <p className="stage-perf-flavor">{findContour(performer.contourId).flavor}</p>
        </div>
      ) : null}
    </div>
  );
}
