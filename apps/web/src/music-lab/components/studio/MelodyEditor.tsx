import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { NoteName } from '@music-lab/lib/musicData';
import { pcOf } from '@music-lab/lib/harmonyTheory';
import type { FlattenedSong } from '@music-lab/lib/songTheory';
import { MELODY_BASE_OCTAVE, type WrittenNote } from '@music-lab/lib/stageData';
import { resolveTone } from '@music-lab/lib/stageInstruments';

/** Where another person's pointer is on this track's roll. */
export interface PeerCursor {
  peerId: string;
  name: string;
  /** Hue (degrees) of that person's colour everywhere else in the studio. */
  hue: number;
  measure: number;
  sub: number;
  pitch: number;
}

export interface RollCell {
  measure: number;
  sub: number;
  pitch: number;
}

interface MelodyEditorProps {
  trackName: string;
  notes: WrittenNote[];
  /** Other people's cursors on this track (shared songs). */
  peerCursors?: PeerCursor[];
  /** Fired when our pointer moves onto a different cell, or off the roll (null). */
  onHoverCell?: (cell: RollCell | null) => void;
  flat: FlattenedSong;
  /** Grid subdivisions per measure (already scaled to the resolution). */
  subdivisions: number;
  /** Subdivision indices that start a pulse group. */
  strongSubs: number[];
  keyRoot: NoteName;
  octaveShift: number;
  playhead: { measure: number; sub: number } | null;
  onChange: (notes: WrittenNote[]) => void;
  onClose: () => void;
}

const NOTE_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** Pitch rows, top to bottom, in semitones relative to the key root. */
const PITCH_TOP = 16;
const PITCH_BOTTOM = -8;
/** Longest note the sanitizer accepts (songEdit LIMITS). */
const MAX_DUR_SUBS = 64;

/**
 * One pointer gesture on the roll. A press that never crosses into another
 * column is a tap (place on an empty step, erase an existing note); a press
 * that does becomes a resize of the note it started on.
 */
interface DragState {
  noteId: string;
  /** Absolute onset column of the note being drawn or resized. */
  startAbs: number;
  lastAbs: number;
  /** The note was placed by this very gesture (release never erases it). */
  fresh: boolean;
  resized: boolean;
}

let noteCounter = 0;

function makeNoteId(): string {
  noteCounter += 1;
  return `wn-${Date.now().toString(36)}-${noteCounter.toString(36)}`;
}

function midiLabel(midi: number): string {
  return `${NOTE_LABELS[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * Piano-roll lead-sheet editor: one section at a time, pitch rows relative to
 * the key root (so written leads transpose with the song), chord tones shaded
 * per measure, and the playhead sweeping live while the song plays.
 */
export function MelodyEditor({
  trackName,
  notes,
  peerCursors,
  onHoverCell,
  flat,
  subdivisions,
  strongSubs,
  keyRoot,
  octaveShift,
  playhead,
  onChange,
  onClose
}: MelodyEditorProps) {
  const [spanIndex, setSpanIndex] = useState(0);
  const previewRef = useRef<import('tone').Synth | null>(null);

  useEffect(() => {
    return () => {
      previewRef.current?.dispose();
      previewRef.current = null;
    };
  }, []);

  const spans = flat.sectionSpans;
  const span = spans[Math.min(spanIndex, Math.max(0, spans.length - 1))] ?? null;

  // Follow the playhead into whichever section is sounding.
  useEffect(() => {
    if (!playhead) return;
    const index = spans.findIndex(s => playhead.measure >= s.startMeasure && playhead.measure < s.endMeasure);
    if (index >= 0) setSpanIndex(index);
  }, [playhead, spans]);

  const keyPc = pcOf(keyRoot);
  const rootMidi = 12 * (MELODY_BASE_OCTAVE.melody + octaveShift + 1) + keyPc;
  const pitchRows = useMemo(() => {
    const rows: number[] = [];
    for (let pitch = PITCH_TOP; pitch >= PITCH_BOTTOM; pitch--) rows.push(pitch);
    return rows;
  }, []);

  /** Absolute onset positions (any pitch) — written leads are monophonic. */
  const sortedOnsets = useMemo(
    () => [...notes.map(n => n.measure * subdivisions + n.sub)].sort((a, b) => a - b),
    [notes, subdivisions]
  );

  const effectiveLength = useCallback(
    (note: WrittenNote): number => {
      const absStart = note.measure * subdivisions + note.sub;
      const nextOnset = sortedOnsets.find(abs => abs > absStart);
      return Math.min(note.durSubs, (nextOnset ?? Infinity) - absStart);
    },
    [sortedOnsets, subdivisions]
  );

  const previewPitch = useCallback(
    async (pitch: number) => {
      const Tone = await resolveTone();
      if (!previewRef.current) {
        previewRef.current = new Tone.Synth({
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.005, decay: 0.12, sustain: 0.4, release: 0.25 }
        }).toDestination();
        previewRef.current.volume.value = -8;
      }
      previewRef.current.triggerAttackRelease(Tone.Frequency(rootMidi + pitch, 'midi').toFrequency(), 0.2);
    },
    [rootMidi]
  );

  // Pointer gestures span several renders; read the newest notes through a
  // ref so a drag never resizes against a stale array.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const dragRef = useRef<DragState | null>(null);

  /** The note sounding at a cell of this pitch — its head or any held step. */
  const noteAt = useCallback(
    (measure: number, sub: number, pitch: number): WrittenNote | undefined => {
      const absCell = measure * subdivisions + sub;
      return notesRef.current.find(n => {
        if (n.pitch !== pitch) return false;
        const absStart = n.measure * subdivisions + n.sub;
        return absStart === absCell || (absStart < absCell && absStart + effectiveLength(n) > absCell);
      });
    },
    [effectiveLength, subdivisions]
  );

  // Commit through the ref first so a gesture that fires several events
  // before React re-renders (place, then resize) builds on its own edits.
  const commit = useCallback(
    (next: WrittenNote[]) => {
      notesRef.current = next;
      onChange(next);
    },
    [onChange]
  );

  const eraseNote = useCallback(
    (noteId: string) => {
      commit(notesRef.current.filter(n => n.id !== noteId));
    },
    [commit]
  );

  const placeNote = useCallback(
    (measure: number, sub: number, pitch: number): WrittenNote => {
      // Monophonic lane: one note per grid step — the newest wins.
      const without = notesRef.current.filter(n => !(n.measure === measure && n.sub === sub));
      const note = { id: makeNoteId(), measure, sub, pitch, durSubs: 1 };
      commit([...without, note]);
      void previewPitch(pitch);
      return note;
    },
    [commit, previewPitch]
  );

  const resizeNote = useCallback(
    (noteId: string, durSubs: number) => {
      const clamped = Math.max(1, Math.min(MAX_DUR_SUBS, durSubs));
      const current = notesRef.current;
      if (current.some(n => n.id === noteId && n.durSubs === clamped)) return;
      commit(current.map(n => (n.id === noteId ? { ...n, durSubs: clamped } : n)));
    },
    [commit]
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    // A press that never moved is a tap: a tap on an existing note erases it.
    if (!drag.fresh && !drag.resized) eraseNote(drag.noteId);
  }, [eraseNote]);

  useEffect(() => {
    const finish = () => endDrag();
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [endDrag]);

  // The cell under our pointer, shared with the room as our cursor. Only
  // changes are reported; the hook throttles the wire.
  const hoverRef = useRef<RollCell | null>(null);
  const reportHover = useCallback(
    (cell: RollCell | null) => {
      const prev = hoverRef.current;
      if (prev === cell) return;
      if (prev && cell && prev.measure === cell.measure && prev.sub === cell.sub && prev.pitch === cell.pitch) return;
      hoverRef.current = cell;
      onHoverCell?.(cell);
    },
    [onHoverCell]
  );
  useEffect(() => {
    return () => {
      if (hoverRef.current) onHoverCell?.(null);
    };
  }, [onHoverCell]);

  const handleCellPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, measure: number, sub: number, pitch: number) => {
      if (event.button !== 0) return;
      reportHover({ measure, sub, pitch });
      const hit = noteAt(measure, sub, pitch);
      const note = hit ?? placeNote(measure, sub, pitch);
      const startAbs = note.measure * subdivisions + note.sub;
      dragRef.current = {
        noteId: note.id,
        startAbs,
        lastAbs: measure * subdivisions + sub,
        fresh: !hit,
        resized: false
      };
    },
    [noteAt, placeNote, reportHover, subdivisions]
  );

  /**
   * Resize follows the pointer across columns. Hit-testing from the grid
   * (instead of per-cell enter events) works for touch too, where the
   * browser pins pointer events to the cell that was first pressed.
   */
  const handleGridPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const cell = target instanceof Element ? target.closest<HTMLElement>('[data-abs]') : null;
      if (!cell) {
        reportHover(null);
        return;
      }
      const abs = Number(cell.dataset.abs);
      const pitch = Number(cell.dataset.pitch);
      if (!Number.isFinite(abs) || !Number.isFinite(pitch)) return;
      reportHover({ measure: Math.floor(abs / subdivisions), sub: abs % subdivisions, pitch });
      const drag = dragRef.current;
      if (!drag || abs === drag.lastAbs) return;
      drag.lastAbs = abs;
      drag.resized = true;
      resizeNote(drag.noteId, abs - drag.startAbs + 1);
    },
    [reportHover, resizeNote, subdivisions]
  );
  const handleGridPointerLeave = useCallback(() => reportHover(null), [reportHover]);

  /** Right-click erases, the way every piano roll does. */
  const handleCellContextMenu = useCallback(
    (event: { preventDefault(): void }, measure: number, sub: number, pitch: number) => {
      const hit = noteAt(measure, sub, pitch);
      if (!hit) return;
      event.preventDefault();
      dragRef.current = null;
      eraseNote(hit.id);
    },
    [eraseNote, noteAt]
  );

  /** Keyboard: Enter/Space toggles the step, Shift+arrows resize a note. */
  const handleCellKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, measure: number, sub: number, pitch: number) => {
      const hit = noteAt(measure, sub, pitch);
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (hit) eraseNote(hit.id);
        else placeNote(measure, sub, pitch);
        return;
      }
      if (hit && event.shiftKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
        event.preventDefault();
        resizeNote(hit.id, hit.durSubs + (event.key === 'ArrowRight' ? 1 : -1));
      }
    },
    [eraseNote, noteAt, placeNote, resizeNote]
  );

  const clearSection = useCallback(() => {
    if (!span) return;
    onChange(notes.filter(n => n.measure < span.startMeasure || n.measure >= span.endMeasure));
  }, [notes, onChange, span]);

  /** Peer cursors keyed by cell, for the rows to paint. */
  const cursorsByCell = useMemo(() => {
    const map = new Map<string, PeerCursor[]>();
    for (const cursor of peerCursors ?? []) {
      const key = `${cursor.measure}:${cursor.sub}:${cursor.pitch}`;
      const list = map.get(key);
      if (list) list.push(cursor);
      else map.set(key, [cursor]);
    }
    return map;
  }, [peerCursors]);

  const jumpToCursor = useCallback(
    (cursor: PeerCursor) => {
      const index = spans.findIndex(s => cursor.measure >= s.startMeasure && cursor.measure < s.endMeasure);
      if (index >= 0) setSpanIndex(index);
    },
    [spans]
  );

  if (!span) return null;

  const measures = Array.from({ length: span.endMeasure - span.startMeasure }, (_, i) => span.startMeasure + i);
  const sectionNotes = notes.filter(n => n.measure >= span.startMeasure && n.measure < span.endMeasure).length;

  return (
    <div className="re-panel re-stack st-melody-editor">
      <div className="re-panel-head">
        <div>
          <h3>Lead Sheet — {trackName}</h3>
          <p>
            Key of {keyRoot} · rows follow the key, chord tones glow · {notes.length} notes written
          </p>
          {peerCursors?.length ? (
            <div className="st-me-peers" data-testid="melody-peer-cursors" aria-label="People on this track">
              {peerCursors.map(cursor => {
                const inView = cursor.measure >= span.startMeasure && cursor.measure < span.endMeasure;
                return (
                  <button
                    key={cursor.peerId}
                    type="button"
                    className={`st-me-peer${inView ? ' in-view' : ''}`}
                    style={{ '--peer-hue': cursor.hue } as CSSProperties}
                    onClick={() => jumpToCursor(cursor)}
                    title={inView ? `${cursor.name} is on bar ${cursor.measure + 1}` : `${cursor.name} is on bar ${cursor.measure + 1} — click to go there`}
                  >
                    <span className="st-peer-dot here" aria-hidden />
                    {cursor.name} · bar {cursor.measure + 1}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="st-me-nav">
          <button
            type="button"
            className="vb-icon-btn"
            onClick={() => setSpanIndex(i => Math.max(0, i - 1))}
            disabled={spanIndex === 0}
            aria-label="Previous section"
          >
            ‹
          </button>
          <span className="st-me-section">
            {span.section.name} · bars {span.startMeasure + 1}–{span.endMeasure}
          </span>
          <button
            type="button"
            className="vb-icon-btn"
            onClick={() => setSpanIndex(i => Math.min(spans.length - 1, i + 1))}
            disabled={spanIndex >= spans.length - 1}
            aria-label="Next section"
          >
            ›
          </button>
          <button type="button" className="re-secondary-btn st-me-clear" onClick={clearSection} disabled={!sectionNotes}>
            Clear section
          </button>
          <button type="button" className="vb-icon-btn remove" onClick={onClose} aria-label="Close melody editor">
            ×
          </button>
        </div>
      </div>

      <div className="st-me-scroll">
        <div
          className="st-me-grid"
          style={{ gridTemplateColumns: `52px repeat(${measures.length * subdivisions}, 20px)` }}
          role="grid"
          aria-label="Melody piano roll"
          onPointerMove={handleGridPointerMove}
          onPointerLeave={handleGridPointerLeave}
        >
          <span className="st-me-corner" aria-hidden />
          {measures.map(measure => {
            const genome = flat.chordByMeasure[measure];
            return (
              <span key={`head-${measure}`} className="st-me-measure-head" style={{ gridColumn: `span ${subdivisions}` }}>
                <strong>{measure + 1}</strong> {genome?.name ?? '—'}
              </span>
            );
          })}

          {pitchRows.map(pitch => {
            const isRoot = ((pitch % 12) + 12) % 12 === 0;
            return (
              <RowCells
                key={pitch}
                pitch={pitch}
                isRoot={isRoot}
                label={midiLabel(rootMidi + pitch)}
                measures={measures}
                subdivisions={subdivisions}
                strongSubs={strongSubs}
                keyPc={keyPc}
                flat={flat}
                notes={notes}
                effectiveLength={effectiveLength}
                playhead={playhead}
                cursorsByCell={cursorsByCell}
                onCellPointerDown={handleCellPointerDown}
                onCellContextMenu={handleCellContextMenu}
                onCellKeyDown={handleCellKeyDown}
              />
            );
          })}
        </div>
      </div>

      <p className="vb-note">
        Tap an empty step to place a note (it plays as you place it) and drag to the right to set its length. Tap a note
        anywhere along it to erase it — right-click works too. One note per step. Glowing cells are chord tones of that
        measure; the lead transposes if you change the song key.
      </p>
    </div>
  );
}

interface RowCellsProps {
  pitch: number;
  isRoot: boolean;
  label: string;
  measures: number[];
  subdivisions: number;
  strongSubs: number[];
  keyPc: number;
  flat: FlattenedSong;
  notes: WrittenNote[];
  effectiveLength: (note: WrittenNote) => number;
  playhead: { measure: number; sub: number } | null;
  cursorsByCell: Map<string, PeerCursor[]>;
  onCellPointerDown: (event: PointerEvent<HTMLButtonElement>, measure: number, sub: number, pitch: number) => void;
  onCellContextMenu: (event: { preventDefault(): void }, measure: number, sub: number, pitch: number) => void;
  onCellKeyDown: (event: KeyboardEvent<HTMLButtonElement>, measure: number, sub: number, pitch: number) => void;
}

function RowCells({
  pitch,
  isRoot,
  label,
  measures,
  subdivisions,
  strongSubs,
  keyPc,
  flat,
  notes,
  effectiveLength,
  playhead,
  cursorsByCell,
  onCellPointerDown,
  onCellContextMenu,
  onCellKeyDown
}: RowCellsProps) {
  const pitchPc = ((keyPc + pitch) % 12 + 12) % 12;
  return (
    <>
      <span className={`st-me-row-label${isRoot ? ' root' : ''}`}>{label}</span>
      {measures.map(measure => {
        const genome = flat.chordByMeasure[measure];
        const isChordTone = genome?.pitchClasses.includes(pitchPc) ?? false;
        return Array.from({ length: subdivisions }, (_, sub) => {
          const head = notes.find(n => n.measure === measure && n.sub === sub && n.pitch === pitch);
          const absCell = measure * subdivisions + sub;
          const tail = head
            ? undefined
            : notes.find(n => {
                if (n.pitch !== pitch) return false;
                const absStart = n.measure * subdivisions + n.sub;
                return absStart < absCell && absStart + effectiveLength(n) > absCell;
              });
          const classes = ['st-me-cell'];
          if (strongSubs.includes(sub)) classes.push('strong');
          if (sub === 0) classes.push('barline');
          if (isChordTone) classes.push('ct');
          if (head) classes.push('head');
          else if (tail) classes.push('tail');
          if (playhead && playhead.measure === measure && playhead.sub === sub) classes.push('now');
          const cursors = cursorsByCell.get(`${measure}:${sub}:${pitch}`);
          if (cursors) classes.push('peer-cursor');
          const note = head ?? tail;
          const who = cursors ? cursors.map(c => c.name).join(', ') : null;
          return (
            <button
              key={`${measure}-${sub}`}
              type="button"
              className={classes.join(' ')}
              data-abs={absCell}
              data-pitch={pitch}
              data-peer={who ?? undefined}
              style={cursors ? ({ '--peer-hue': cursors[0].hue } as CSSProperties) : undefined}
              onPointerDown={event => onCellPointerDown(event, measure, sub, pitch)}
              onContextMenu={event => onCellContextMenu(event, measure, sub, pitch)}
              onKeyDown={event => onCellKeyDown(event, measure, sub, pitch)}
              aria-label={`${label}, bar ${measure + 1} step ${sub + 1}${head ? `, length ${head.durSubs}` : ''}${who ? `, ${who} here` : ''}`}
              title={[note ? `Length ${note.durSubs} — tap to erase, drag to resize` : null, who ? `${who} here` : null].filter(Boolean).join(' · ') || undefined}
            />
          );
        });
      })}
    </>
  );
}
