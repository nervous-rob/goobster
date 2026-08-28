import { useMemo, useState, type DragEvent } from 'react';
import {
  CHORD_TYPES,
  DURATIONS,
  NOTE_NAMES,
  TEMPLATES,
  type ChordType,
  type DurationDefinition,
  type NoteName,
  type ScaleQuality
} from '@music-lab/lib/musicData';
import {
  buildTemplateProgression,
  computeChordNotes,
  computeDiatonicChords,
  computeSecondaryChords,
  describeDuration,
  findChordType,
  getDynamicChordName,
  suggestChordsForProgression,
  type ChordSuggestion,
  type ProgressionChord
} from '@music-lab/lib/musicTheory';
import { useLocalStorage } from '@music-lab/hooks/useLocalStorage';
import { useAudioEngine } from '@music-lab/hooks/useAudioEngine';
import { MusicControls } from '@music-lab/components/shared/MusicControls';
import { LabShell } from '@music-lab/components/shared/LabShell';

type PlayMode = 'sequential' | 'together';

const builderOffsets = Array.from({ length: 36 }, (_, index) => index - 12).filter(value => value !== 0);

const semitoneNameMap = (() => {
  const map = new Map<number, string>();
  map.set(0, 'Unison');
  map.set(1, 'Minor 2nd');
  map.set(2, 'Major 2nd');
  map.set(3, 'Minor 3rd');
  map.set(4, 'Major 3rd');
  map.set(5, 'Perfect 4th');
  map.set(6, 'Tritone');
  map.set(7, 'Perfect 5th');
  map.set(8, 'Minor 6th');
  map.set(9, 'Major 6th');
  map.set(10, 'Minor 7th');
  map.set(11, 'Major 7th');
  map.set(12, 'Octave');
  return map;
})();

function formatOffsetLabel(value: number): string {
  const abs = Math.abs(value);
  const base = semitoneNameMap.get(abs) ?? `${abs} st`;
  if (value > 12) {
    return `+${value} (${base})`;
  }
  if (value < -12) {
    return `${value} (${base})`;
  }
  if (value > 0) {
    return `+${value} (${base})`;
  }
  return `${value} (${base})`;
}

function IconChord() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="10" width="4" height="11" rx="1" />
      <rect x="10" y="6" width="4" height="15" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
    </svg>
  );
}

function createProgressionEntry(chord: { id: string; root: NoteName; intervals: number[]; name: string }): ProgressionChord {
  return {
    id: `${chord.id}-${Date.now()}`,
    root: chord.root,
    intervals: chord.intervals,
    name: chord.name,
    duration: 'whole'
  };
}

export function ChordWorkbench() {
  const [root, setRoot] = useLocalStorage<NoteName>('selectedRoot', 'C');
  const [quality, setQuality] = useLocalStorage<ScaleQuality>('selectedQuality', 'major');
  const [playMode, setPlayMode] = useLocalStorage<PlayMode>('playMode', 'sequential');
  const [tempo, setTempo] = useLocalStorage<number>('tempo', 120);
  const [selectedChordId, setSelectedChordId] = useLocalStorage<string>('selectedChord', CHORD_TYPES[0].id);
  const [progression, setProgression] = useLocalStorage<ProgressionChord[]>('progression', []);
  const [loopProgression, setLoopProgression] = useLocalStorage<boolean>('loopProgression', false);
  const [drumEnabled, setDrumEnabled] = useLocalStorage<boolean>('drumEnabled', false);
  const [selectedTemplate, setSelectedTemplate] = useLocalStorage<string>('selectedTemplate', '');
  const [builderIntervals, setBuilderIntervals] = useLocalStorage<number[]>('builderIntervals', [0, 4, 7]);
  const [builderBase, setBuilderBase] = useState<NoteName>(root);
  const [builderBaseTouched, setBuilderBaseTouched] = useState(false);
  const { playChord, playProgression, stopProgression } = useAudioEngine();
  const [isPlaying, setIsPlaying] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const selectedChord = useMemo<ChordType | undefined>(() => findChordType(selectedChordId), [selectedChordId]);
  const chordNotes = useMemo(() => (selectedChord ? computeChordNotes(root, selectedChord.intervals) : []), [root, selectedChord]);
  const diatonicChords = useMemo(() => computeDiatonicChords(root, quality), [root, quality]);
  const secondaryChords = useMemo(() => computeSecondaryChords(diatonicChords), [diatonicChords]);
  const builderOffsetsSet = useMemo(() => new Set(builderIntervals), [builderIntervals]);
  const builderChordName = useMemo(() => getDynamicChordName(builderBase, builderIntervals), [builderBase, builderIntervals]);
  const builderChordNotes = useMemo(() => computeChordNotes(builderBase, builderIntervals), [builderBase, builderIntervals]);
  const chordSuggestions = useMemo<ChordSuggestion[]>(
    () => suggestChordsForProgression(progression, root, quality),
    [progression, root, quality]
  );

  const handlePlaySelectedChord = () => {
    if (!selectedChord) return;
    playChord(root, selectedChord.intervals, playMode, 1, tempo);
  };

  const handleAddChordToProgression = (chord: { id: string; root: NoteName; intervals: number[]; name: string }) => {
    setProgression(prev => [...prev, createProgressionEntry(chord)]);
  };

  const handleDurationChange = (index: number, durationId: DurationDefinition['id']) => {
    setProgression(prev => {
      const next = [...prev];
      if (!next[index]) return prev;
      next[index] = { ...next[index], duration: durationId };
      return next;
    });
  };

  const handleRemoveChord = (index: number) => {
    setProgression(prev => prev.filter((_, idx) => idx !== index));
  };

  const handlePlayProgression = () => {
    if (!progression.length) return;
    setIsPlaying(true);
    playProgression(
      progression,
      { tempo, playMode, loop: loopProgression, drumEnabled },
      () => setIsPlaying(false)
    );
  };

  const handleStopProgression = () => {
    setIsPlaying(false);
    stopProgression();
  };

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplate(templateId);
    if (!templateId) return;
    const generated = buildTemplateProgression(templateId, root, quality);
    if (generated.length) {
      setProgression(generated);
    }
  };

  const toggleBuilderInterval = (value: number) => {
    setBuilderIntervals(prev => {
      const set = new Set(prev);
      if (set.has(value)) {
        set.delete(value);
      } else {
        set.add(value);
      }
      set.add(0);
      return Array.from(set).sort((a, b) => a - b);
    });
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.dataTransfer.effectAllowed = 'move';
    setDraggingIndex(index);
  };

  const handleDragEnd = () => {
    setDraggingIndex(null);
    setDropIndex(null);
  };

  const handleDropZone = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    if (draggingIndex === null) {
      return;
    }
    setProgression(prev => {
      const next = [...prev];
      const [moved] = next.splice(draggingIndex, 1);
      next.splice(index, 0, moved);
      return next;
    });
    setDraggingIndex(null);
    setDropIndex(null);
  };

  const handleDragOverZone = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropIndex !== index) {
      setDropIndex(index);
    }
  };

  const handleDragLeaveZone = (index: number) => {
    if (dropIndex === index) {
      setDropIndex(null);
    }
  };

  return (
    <LabShell
      title="Chord Workbench"
      badge="BUILD"
      subtitle="Diatonic Harmony + Progression Studio"
      icon={<IconChord />}
    >
      <MusicControls
        root={root}
        quality={quality}
        playMode={playMode}
        tempo={tempo}
        onRootChange={value => {
          setRoot(value);
          if (!builderBaseTouched) {
            setBuilderBase(value);
          }
        }}
        onQualityChange={setQuality}
        onPlayModeChange={setPlayMode}
        onTempoChange={setTempo}
      >
        <label htmlFor="loop-progression">
          Loop progression
          <input
            id="loop-progression"
            type="checkbox"
            checked={loopProgression}
            onChange={event => setLoopProgression(event.target.checked)}
          />
        </label>
        <label htmlFor="drum-enabled">
          Drums
          <input
            id="drum-enabled"
            type="checkbox"
            checked={drumEnabled}
            onChange={event => setDrumEnabled(event.target.checked)}
          />
        </label>
      </MusicControls>

      <div className="music-content">
        <aside className="music-list" role="navigation" aria-label="Chord types">
          <div className="section-header">Chord library</div>
          <div className="music-items">
            {CHORD_TYPES.map(chord => {
              const isSelected = chord.id === selectedChordId;
              return (
                <button
                  type="button"
                  key={chord.id}
                  className={`music-item${isSelected ? ' selected' : ''}`}
                  onClick={() => setSelectedChordId(chord.id)}
                  aria-pressed={isSelected}
                >
                  <span>{chord.name}</span>
                  <small>{chord.intervals.join(', ')} st</small>
                </button>
              );
            })}
          </div>
        </aside>

        <article className="music-detail" aria-live="polite">
          {selectedChord ? (
            <>
              <h2>{selectedChord.name}</h2>
              <div className="detail-row">
                <strong>Description:</strong> {selectedChord.description}
              </div>
              <div className="detail-row">
                <strong>Notes:</strong> {chordNotes.join(' – ')}
              </div>
              <div className="detail-row">
                <strong>Uses:</strong> {selectedChord.uses.join('; ')}
              </div>
              <div className="detail-row">
                <strong>Intervals:</strong> {selectedChord.intervals.join(', ')} st
              </div>
              <div className="progression-actions">
                <button type="button" className="play-button" onClick={handlePlaySelectedChord}>
                  Play chord
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    handleAddChordToProgression({
                      id: selectedChord.id,
                      root,
                      intervals: selectedChord.intervals,
                      name: `${root} ${selectedChord.name}`
                    })
                  }
                >
                  Add to progression
                </button>
              </div>

              <div className="chord-builder" aria-label="Custom chord builder">
                <h3>Custom chord builder</h3>
                <label htmlFor="builder-root">
                  Base note
                  <select
                    id="builder-root"
                    value={builderBase}
                    onChange={event => {
                      setBuilderBase(event.target.value as NoteName);
                      setBuilderBaseTouched(true);
                    }}
                  >
                    {NOTE_NAMES.map(note => (
                      <option key={note} value={note}>
                        {note}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="builder-grid">
                  {builderOffsets.map(offset => (
                    <label key={offset}>
                      <input
                        type="checkbox"
                        checked={builderOffsetsSet.has(offset)}
                        onChange={() => toggleBuilderInterval(offset)}
                      />
                      {formatOffsetLabel(offset)}
                    </label>
                  ))}
                </div>
                <div className="detail-row">
                  <strong>Result:</strong> {builderChordName} — Notes: {builderChordNotes.join(' – ')}
                </div>
                <div className="progression-actions">
                  <button
                    type="button"
                    className="play-button"
                    onClick={() => playChord(builderBase, builderIntervals, playMode, 1, tempo)}
                  >
                    Play custom chord
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      handleAddChordToProgression({
                        id: 'custom',
                        root: builderBase,
                        intervals: builderIntervals,
                        name: builderChordName
                      })
                    }
                  >
                    Add to progression
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p>Select a chord to see details.</p>
          )}
        </article>
      </div>

      <div className="chord-selection-row" aria-label="Chord palette">
        <section className="key-chords" aria-label="Diatonic chords">
          <h3>Diatonic chords in {root} {quality === 'major' ? 'Major' : 'Minor'}</h3>
          <div className="key-chords-list">
            {diatonicChords.map(chord => (
              <button
                type="button"
                key={chord.id}
                className="chord-pill"
                onClick={() =>
                  handleAddChordToProgression({
                    id: chord.id,
                    root: chord.root,
                    intervals: chord.intervals,
                    name: chord.name
                  })
                }
              >
                <span>{chord.degree}</span>
                <span>{chord.name}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="secondary-chords" aria-label="Secondary chords">
          <h3>Secondary options</h3>
          <div className="secondary-chords-list">
            {secondaryChords.length ? (
              secondaryChords.map(chord => (
                <button
                  type="button"
                  key={chord.id}
                  className="chord-pill"
                  onClick={() =>
                    handleAddChordToProgression({
                      id: chord.id,
                      root: chord.root,
                      intervals: chord.intervals,
                      name: chord.name
                    })
                  }
                >
                  <span>{chord.degree}</span>
                  <span>{chord.name}</span>
                </button>
              ))
            ) : (
              <p>No secondary chords for this key.</p>
            )}
          </div>
        </section>
      </div>

      <section className="progression-builder" aria-label="Chord progression builder">
        <div className="builder-toolbar">
          <div className="template-select compact">
            <label htmlFor="template-select">Templates</label>
            <select
              id="template-select"
              value={selectedTemplate}
              onChange={event => handleTemplateChange(event.target.value)}
            >
              <option value="">Choose a progression</option>
              {TEMPLATES.map(template => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
          </div>
          {progression.length ? (
            <div className="timeline-summary" aria-live="polite">
              <span>{progression.length} chord{progression.length === 1 ? '' : 's'} arranged</span>
            </div>
          ) : null}
        </div>

        <div className="progression-timeline" role="list">
          {progression.length === 0 ? (
            <p className="timeline-empty">Add chords to begin building your progression timeline.</p>
          ) : (
            progression.map((chord, index) => {
              const durationInfo = describeDuration(chord.duration);
              return (
                <div className="timeline-segment" key={`${chord.id}-${index}`} role="listitem">
                  <div
                    className={`timeline-dropzone${dropIndex === index ? ' active' : ''}`}
                    onDragOver={event => handleDragOverZone(event, index)}
                    onDrop={event => handleDropZone(event, index)}
                    onDragLeave={() => handleDragLeaveZone(index)}
                    aria-hidden="true"
                  />
                  <div
                    className={`timeline-chord${draggingIndex === index ? ' dragging' : ''}`}
                    style={{ flexGrow: durationInfo.beats, flexBasis: 0 }}
                    draggable
                    onDragStart={event => handleDragStart(event, index)}
                    onDragEnd={handleDragEnd}
                  >
                    <div className="timeline-chord__label">
                      <strong>{chord.name}</strong>
                      <span>{durationInfo.label}</span>
                    </div>
                    <div className="timeline-chord__controls">
                      <select
                        value={chord.duration}
                        onChange={event => handleDurationChange(index, event.target.value as DurationDefinition['id'])}
                        aria-label={`Set duration for ${chord.name}`}
                      >
                        {DURATIONS.map(duration => (
                          <option key={duration.id} value={duration.id}>
                            {duration.label}
                          </option>
                        ))}
                      </select>
                      <button type="button" onClick={() => handleRemoveChord(index)} aria-label={`Remove ${chord.name}`}>
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
          <div
            className={`timeline-dropzone tail${dropIndex === progression.length ? ' active' : ''}`}
            onDragOver={event => handleDragOverZone(event, progression.length)}
            onDrop={event => handleDropZone(event, progression.length)}
            onDragLeave={() => handleDragLeaveZone(progression.length)}
            aria-hidden="true"
          />
        </div>

        <div className="progression-actions">
          <button type="button" className="play-button" onClick={handlePlayProgression} disabled={!progression.length}>
            Play progression
          </button>
          <button type="button" className="secondary-button" onClick={handleStopProgression} disabled={!isPlaying}>
            Stop
          </button>
          <button type="button" className="secondary-button" onClick={() => setProgression([])} disabled={!progression.length}>
            Clear progression
          </button>
        </div>
      </section>

      {chordSuggestions.length ? (
        <section className="suggested-chords" aria-label="Suggested next chords">
          <h3>Suggested next chords</h3>
          <div className="suggested-chords-grid">
            {chordSuggestions.map(suggestion => (
              <div key={suggestion.id} className="suggested-card">
                <div className="suggested-card__header">
                  <strong>{suggestion.name}</strong>
                  <button
                    type="button"
                    onClick={() =>
                      handleAddChordToProgression({
                        id: suggestion.id,
                        root: suggestion.root,
                        intervals: suggestion.intervals,
                        name: suggestion.name
                      })
                    }
                  >
                    Add
                  </button>
                </div>
                <p>{suggestion.reason}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </LabShell>
  );
}
