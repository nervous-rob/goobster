import { useMemo } from 'react';
import { INTERVALS, type IntervalDefinition, type NoteName, type ScaleQuality } from '@music-lab/lib/musicData';
import { computeIntervalNote } from '@music-lab/lib/musicTheory';
import { useLocalStorage } from '@music-lab/hooks/useLocalStorage';
import { useAudioEngine } from '@music-lab/hooks/useAudioEngine';
import { MusicControls } from '@music-lab/components/shared/MusicControls';
import { LabShell } from '@music-lab/components/shared/LabShell';

type PlayMode = 'sequential' | 'together';

interface IntervalSection {
  title: string;
  items: IntervalDefinition[];
}

function IconInterval() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function IntervalExplorer() {
  const [root, setRoot] = useLocalStorage<NoteName>('selectedRoot', 'C');
  const [quality, setQuality] = useLocalStorage<ScaleQuality>('selectedQuality', 'major');
  const [playMode, setPlayMode] = useLocalStorage<PlayMode>('playMode', 'sequential');
  const [tempo, setTempo] = useLocalStorage<number>('tempo', 120);
  const [selectedIntervalId, setSelectedIntervalId] = useLocalStorage<string>('selectedInterval', INTERVALS[0].id);
  const { playInterval } = useAudioEngine();

  const sections = useMemo<IntervalSection[]>(
    () => [
      { title: 'Ascending', items: INTERVALS.filter(interval => interval.id.startsWith('asc')) },
      { title: 'Descending', items: INTERVALS.filter(interval => interval.id.startsWith('desc')) }
    ],
    []
  );

  const selectedInterval = useMemo(() => {
    return INTERVALS.find(interval => interval.id === selectedIntervalId) ?? INTERVALS[0];
  }, [selectedIntervalId]);

  const semitoneLabel = useMemo(() => {
    const semitones = Math.abs(selectedInterval.semitones);
    const unit = semitones === 1 ? 'semitone' : 'semitones';
    return `${semitones} ${unit}`;
  }, [selectedInterval]);

  const targetNote = useMemo(() => computeIntervalNote(root, selectedInterval.semitones), [root, selectedInterval]);

  return (
    <LabShell
      title="Intervals Explorer"
      badge="EAR"
      subtitle="Ascending + Descending Interval Laboratory"
      icon={<IconInterval />}
    >
      <MusicControls
        root={root}
        quality={quality}
        playMode={playMode}
        tempo={tempo}
        onRootChange={setRoot}
        onQualityChange={setQuality}
        onPlayModeChange={setPlayMode}
        onTempoChange={setTempo}
      />
      <div className="music-content">
        <aside className="music-list" role="navigation" aria-label="Interval list">
          {sections.map(section => (
            <div key={section.title}>
              <div className="section-header">{section.title}</div>
              <div className="music-items">
                {section.items.map(interval => {
                  const isSelected = interval.id === selectedIntervalId;
                  return (
                    <button
                      type="button"
                      key={interval.id}
                      className={`music-item${isSelected ? ' selected' : ''}`}
                      onClick={() => setSelectedIntervalId(interval.id)}
                      aria-pressed={isSelected}
                    >
                      <span>{interval.name}</span>
                      <small>{interval.semitones} st</small>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </aside>
        <article className="music-detail" aria-live="polite">
          <h2>{selectedInterval.name}</h2>
          <div className="detail-row">
            <strong>Degree:</strong> {selectedInterval.degree}
          </div>
          <div className="detail-row">
            <strong>Semitones:</strong> {semitoneLabel}
          </div>
          <div className="detail-row">
            <strong>Character:</strong> {selectedInterval.descriptors}
          </div>
          <div className="detail-row">
            <strong>Chords & uses:</strong> {selectedInterval.chords.join('; ')}
          </div>
          <div className="detail-row">
            <strong>Notes:</strong> {root}
            {quality === 'minor' ? ' (minor context)' : ''} → {targetNote}
          </div>
          <button
            type="button"
            className="play-button"
            onClick={() => playInterval(root, selectedInterval.semitones)}
          >
            Play Interval
          </button>
        </article>
      </div>
    </LabShell>
  );
}
