import type { CSSProperties } from 'react';
import { SECTION_KIND_META } from '@music-lab/lib/songData';
import type { FlattenedSong } from '@music-lab/lib/songTheory';

interface SectionStripProps {
  flat: FlattenedSong;
  zoom: number;
  selectedSectionId: string | null;
  loopRegion: { start: number; end: number } | null;
  onSelectSection: (id: string) => void;
  onSeek: (measure: number) => void;
  onEditChord: (sectionId: string, chordIndex: number) => void;
}

/**
 * The timeline ruler: section blocks (the song's structure), the chord lane
 * flattened beneath them, and a measure tick row that seeks on click.
 */
export function SectionStrip({
  flat,
  zoom,
  selectedSectionId,
  loopRegion,
  onSelectSection,
  onSeek,
  onEditChord
}: SectionStripProps) {
  const width = flat.totalMeasures * zoom;
  const tickEvery = zoom >= 28 ? 1 : zoom >= 16 ? 2 : 4;

  return (
    <div className="st-ruler" style={{ width }}>
      <div className="st-ruler-sections">
        {flat.sectionSpans.map(span => {
          const meta = SECTION_KIND_META[span.section.kind];
          const isSelected = span.section.id === selectedSectionId;
          const style: CSSProperties = {
            left: span.startMeasure * zoom,
            width: (span.endMeasure - span.startMeasure) * zoom,
            '--st-section-hue': meta.hue
          } as CSSProperties;
          return (
            <button
              key={span.section.id}
              type="button"
              className={`st-section-block${isSelected ? ' selected' : ''}`}
              style={style}
              onClick={() => onSelectSection(span.section.id)}
              title={`${span.section.name} · ${span.section.measures} measures`}
            >
              <span className="st-section-name">{span.section.name}</span>
              <span className="st-section-len">{span.section.measures}m</span>
            </button>
          );
        })}
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
