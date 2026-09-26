import { useCallback, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { SECTION_KIND_META } from '@music-lab/lib/songData';
import type { FlattenedSong } from '@music-lab/lib/songTheory';

export interface MenuPoint {
  x: number;
  y: number;
}

interface SectionDrag {
  id: string;
  index: number;
  pointerId: number;
  startX: number;
  dx: number;
  /** Index the section would occupy on drop, or null before the drag threshold. */
  toIndex: number | null;
  /** Insertion marker x (px) in strip space. */
  markerX: number;
}

interface SectionStripProps {
  flat: FlattenedSong;
  zoom: number;
  selectedSectionId: string | null;
  loopRegion: { start: number; end: number } | null;
  onSelectSection: (id: string) => void;
  onReorderSection: (id: string, toIndex: number) => void;
  onSectionContextMenu: (sectionId: string, at: MenuPoint) => void;
  onSeek: (measure: number) => void;
  onEditChord: (sectionId: string, chordIndex: number) => void;
}

const DRAG_THRESHOLD_PX = 6;

/**
 * The timeline ruler: section blocks (the song's structure), the chord lane
 * flattened beneath them, and a measure tick row that seeks on click.
 * Section blocks drag to reorder (mouse / pen; touch keeps scrolling the
 * timeline and uses the inspector's Move buttons) and right-click for actions.
 */
export function SectionStrip({
  flat,
  zoom,
  selectedSectionId,
  loopRegion,
  onSelectSection,
  onReorderSection,
  onSectionContextMenu,
  onSeek,
  onEditChord
}: SectionStripProps) {
  const width = flat.totalMeasures * zoom;
  const tickEvery = zoom >= 28 ? 1 : zoom >= 16 ? 2 : 4;
  const dragRef = useRef<SectionDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<SectionDrag | null>(null);

  const dropTarget = useCallback(
    (dragId: string, stripX: number) => {
      const measure = stripX / zoom;
      const others = flat.sectionSpans.filter(s => s.section.id !== dragId);
      let insertBefore = others.length;
      for (let i = 0; i < others.length; i += 1) {
        if (measure < (others[i].startMeasure + others[i].endMeasure) / 2) {
          insertBefore = i;
          break;
        }
      }
      const markerX = insertBefore < others.length ? others[insertBefore].startMeasure * zoom : width;
      return { toIndex: insertBefore, markerX };
    },
    [flat.sectionSpans, width, zoom]
  );

  const handleDown = useCallback(
    (id: string, index: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || e.pointerType === 'touch') return;
      suppressClickRef.current = false;
      dragRef.current = { id, index, pointerId: e.pointerId, startX: e.clientX, dx: 0, toIndex: null, markerX: 0 };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    []
  );

  const handleMove = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      if (d.toIndex === null && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      const strip = e.currentTarget.parentElement;
      if (!strip) return;
      const rect = strip.getBoundingClientRect();
      const { toIndex, markerX } = dropTarget(d.id, e.clientX - rect.left);
      const next = { ...d, dx, toIndex, markerX };
      dragRef.current = next;
      setDrag(next);
    },
    [dropTarget]
  );

  const handleUp = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      dragRef.current = null;
      setDrag(null);
      if (d.toIndex === null) return;
      suppressClickRef.current = true;
      if (d.toIndex !== d.index) onReorderSection(d.id, d.toIndex);
    },
    [onReorderSection]
  );

  const handleClick = useCallback(
    (id: string) => () => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      onSelectSection(id);
    },
    [onSelectSection]
  );

  const handleContext = useCallback(
    (id: string) => (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      onSectionContextMenu(id, { x: e.clientX, y: e.clientY });
    },
    [onSectionContextMenu]
  );

  const dragging = drag && drag.toIndex !== null ? drag : null;

  return (
    <div className="st-ruler" style={{ width }}>
      <div className={`st-ruler-sections${dragging ? ' dragging' : ''}`}>
        {flat.sectionSpans.map((span, index) => {
          const meta = SECTION_KIND_META[span.section.kind];
          const isSelected = span.section.id === selectedSectionId;
          const isDragged = dragging?.id === span.section.id;
          const style: CSSProperties = {
            left: span.startMeasure * zoom,
            width: (span.endMeasure - span.startMeasure) * zoom,
            '--st-section-hue': meta.hue,
            ...(isDragged ? { transform: `translateX(${dragging.dx}px)` } : null)
          } as CSSProperties;
          return (
            <button
              key={span.section.id}
              type="button"
              data-section-id={span.section.id}
              className={`st-section-block${isSelected ? ' selected' : ''}${isDragged ? ' dragged' : ''}`}
              style={style}
              onClick={handleClick(span.section.id)}
              onPointerDown={handleDown(span.section.id, index)}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
              onContextMenu={handleContext(span.section.id)}
              title={`${span.section.name} · ${span.section.measures} measures · drag to reorder, right-click for actions`}
            >
              <span className="st-section-name">{span.section.name}</span>
              <span className="st-section-len">{span.section.measures}m</span>
            </button>
          );
        })}
        {dragging ? (
          <span
            className="st-section-drop"
            style={{ left: Math.min(dragging.markerX, Math.max(0, width - 2)) }}
            aria-hidden
          />
        ) : null}
      </div>

      <div className="st-ruler-chords">
        {flat.chordSpans.map((span, i) => (
          <button
            key={`${span.sectionId}-${span.startMeasure}-${i}`}
            type="button"
            className="st-chord-span"
            style={{ left: span.startMeasure * zoom, width: (span.endMeasure - span.startMeasure) * zoom }}
            onClick={() => onEditChord(span.sectionId, span.chordIndex)}
            title={`${span.genome.name} — tap to forge`}
          >
            {span.genome.name}
          </button>
        ))}
      </div>

      <div className="st-ruler-ticks">
        {loopRegion ? (
          <div
            className="st-loop-region"
            style={{ left: loopRegion.start * zoom, width: (loopRegion.end - loopRegion.start) * zoom }}
            aria-hidden
          />
        ) : null}
        {Array.from({ length: flat.totalMeasures }, (_, m) => (
          <button
            key={m}
            type="button"
            className="st-tick"
            style={{ left: m * zoom, width: zoom }}
            onClick={() => onSeek(m)}
            title={`Jump to measure ${m + 1}`}
          >
            {m % tickEvery === 0 ? m + 1 : ''}
          </button>
        ))}
      </div>
    </div>
  );
}
