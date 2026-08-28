import { useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { isDrumRole } from '@music-lab/lib/stageData';
import { findVoice } from '@music-lab/lib/voiceData';
import { makeClip, type SongClip, type SongProject, type SongTrack } from '@music-lab/lib/songData';
import type { FlattenedSong } from '@music-lab/lib/songTheory';
import { SectionStrip } from './SectionStrip';
import { TrackHeader } from './TrackHeader';

export const TIMELINE_HEADER_W = 184;

interface ClipDrag {
  mode: 'move' | 'resize-l' | 'resize-r' | 'create';
  trackId: string;
  clipId?: string;
  /** Pointer-down position in fractional measures. */
  anchor: number;
  origStart: number;
  origLength: number;
  start: number;
  length: number;
  moved: boolean;
}

interface SongTimelineProps {
  project: SongProject;
  flat: FlattenedSong;
  zoom: number;
  subdivisions: number;
  playhead: { measure: number; sub: number } | null;
  loopRegion: { start: number; end: number } | null;
  selectedSectionId: string | null;
  selectedTrackId: string | null;
  selectedClipId: string | null;
  onSeek: (measure: number) => void;
  onSelectSection: (id: string) => void;
  onSelectTrack: (id: string | null) => void;
  onSelectClip: (id: string | null) => void;
  onEditChord: (sectionId: string, chordIndex: number) => void;
  onClipsChange: (clips: SongClip[]) => void;
  onTrackChange: (id: string, partial: Partial<SongTrack>) => void;
  onRemoveTrack: (id: string) => void;
  onAddTrack: () => void;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * The arrangement grid: a sticky header column of tracks beside measure-
 * snapped clip lanes, under the section/chord/tick ruler. Clips are created
 * by dragging on empty lane space, moved/resized by their body and edge
 * handles, and deleted with a double-click.
 */
export function SongTimeline({
  project,
  flat,
  zoom,
  subdivisions,
  playhead,
  loopRegion,
  selectedSectionId,
  selectedTrackId,
  selectedClipId,
  onSeek,
  onSelectSection,
  onSelectTrack,
  onSelectClip,
  onEditChord,
  onClipsChange,
  onTrackChange,
  onRemoveTrack,
  onAddTrack
}: SongTimelineProps) {
  const dragRef = useRef<ClipDrag | null>(null);
  const [dragView, setDragView] = useState<ClipDrag | null>(null);

  const total = flat.totalMeasures;
  const laneWidth = total * zoom;

  const measureAt = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      return (e.clientX - rect.left) / zoom;
    },
    [zoom]
  );

  const handleLaneDown = useCallback(
    (track: SongTrack) => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || total === 0) return;
      const measureFloat = measureAt(e);
      const target = e.target as HTMLElement;
      const clipEl = target.closest('[data-clip-id]') as HTMLElement | null;

      let drag: ClipDrag;
      if (clipEl) {
        const clipId = clipEl.dataset.clipId as string;
        const clip = project.clips.find(c => c.id === clipId);
        if (!clip) return;
        const handle = target.dataset.handle;
        drag = {
          mode: handle === 'l' ? 'resize-l' : handle === 'r' ? 'resize-r' : 'move',
          trackId: track.id,
          clipId,
          anchor: measureFloat,
          origStart: clip.startMeasure,
          origLength: clip.lengthMeasures,
          start: clip.startMeasure,
          length: clip.lengthMeasures,
          moved: false
        };
        onSelectClip(clipId);
        onSelectTrack(track.id);
      } else {
        const startM = clamp(Math.floor(measureFloat), 0, total - 1);
        drag = {
          mode: 'create',
          trackId: track.id,
          anchor: measureFloat,
          origStart: startM,
          origLength: 1,
          start: startM,
          length: 1,
          moved: false
        };
        onSelectTrack(track.id);
        onSelectClip(null);
      }

      dragRef.current = drag;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [measureAt, onSelectClip, onSelectTrack, project.clips, total]
  );

  const handleLaneMove = useCallback(
    (track: SongTrack) => (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.trackId !== track.id) return;
      const measureFloat = measureAt(e);
      const deltaFloat = measureFloat - drag.anchor;
      if (Math.abs(deltaFloat * zoom) > 4) drag.moved = true;
      if (!drag.moved) return;

      if (drag.mode === 'move') {
        drag.start = clamp(drag.origStart + Math.round(deltaFloat), 0, total - drag.origLength);
        drag.length = drag.origLength;
      } else if (drag.mode === 'resize-r') {
        drag.length = clamp(Math.round(measureFloat - drag.origStart), 1, total - drag.origStart);
        drag.start = drag.origStart;
      } else if (drag.mode === 'resize-l') {
        const origEnd = drag.origStart + drag.origLength;
        drag.start = clamp(Math.round(measureFloat), 0, origEnd - 1);
        drag.length = origEnd - drag.start;
      } else {
        const from = clamp(Math.min(Math.floor(drag.anchor), Math.floor(measureFloat)), 0, total - 1);
        const to = clamp(Math.max(Math.floor(drag.anchor), Math.floor(measureFloat)), 0, total - 1);
        drag.start = from;
        drag.length = to - from + 1;
      }
      setDragView({ ...drag });
    },
    [measureAt, total, zoom]
  );

  const handleLaneUp = useCallback(
    (track: SongTrack) => () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDragView(null);
      if (!drag || drag.trackId !== track.id) return;

      if (drag.mode === 'create') {
        if (drag.moved) {
          const clip = makeClip(track.id, drag.start, drag.length);
          onClipsChange([...project.clips, clip]);
          onSelectClip(clip.id);
        }
        return;
      }
      if (!drag.moved || !drag.clipId) return;
      onClipsChange(
        project.clips.map(c =>
          c.id === drag.clipId ? { ...c, startMeasure: drag.start, lengthMeasures: drag.length } : c
        )
      );
    },
    [onClipsChange, onSelectClip, project.clips]
  );

  const handleLaneDoubleClick = useCallback(
    (track: SongTrack) => (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const clipEl = target.closest('[data-clip-id]') as HTMLElement | null;
      if (clipEl) {
        const clipId = clipEl.dataset.clipId as string;
        onClipsChange(project.clips.filter(c => c.id !== clipId));
        onSelectClip(null);
        return;
      }
      if (total === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const m = clamp(Math.floor((e.clientX - rect.left) / zoom), 0, total - 1);
      const clip = makeClip(track.id, m, 1);
      onClipsChange([...project.clips, clip]);
      onSelectClip(clip.id);
    },
    [onClipsChange, onSelectClip, project.clips, total, zoom]
  );

  const playheadLeft =
    playhead && subdivisions > 0
      ? TIMELINE_HEADER_W + (playhead.measure + playhead.sub / subdivisions) * zoom
      : null;

  const laneStyle: CSSProperties = {
    width: laneWidth,
    backgroundSize: `${zoom}px 100%`
  };

  return (
    <div className="st-timeline-scroll">
      <div className="st-timeline-inner" style={{ width: TIMELINE_HEADER_W + laneWidth }}>
        <div className="st-row st-ruler-row">
          <div className="st-track-head st-corner">
            <span className="re-micro-label">Sections / Bars</span>
          </div>
          <SectionStrip
            flat={flat}
            zoom={zoom}
            selectedSectionId={selectedSectionId}
            loopRegion={loopRegion}
            onSelectSection={onSelectSection}
            onSeek={onSeek}
            onEditChord={onEditChord}
          />
        </div>

        {project.tracks.map(track => {
          const hue = isDrumRole(track.role) ? 210 : findVoice(track.performer.voiceId).hue;
          const trackClips = project.clips.filter(c => c.trackId === track.id);
          const isCreateGhost = dragView?.mode === 'create' && dragView.trackId === track.id && dragView.moved;
          const dimmed = track.mute;

          return (
            <div key={track.id} className="st-row">
              <TrackHeader
                track={track}
                isSelected={selectedTrackId === track.id}
                onSelect={() => onSelectTrack(selectedTrackId === track.id ? null : track.id)}
                onChange={partial => onTrackChange(track.id, partial)}
                onRemove={() => onRemoveTrack(track.id)}
              />
              <div
                className="st-lane"
                style={laneStyle}
                onPointerDown={handleLaneDown(track)}
                onPointerMove={handleLaneMove(track)}
                onPointerUp={handleLaneUp(track)}
                onDoubleClick={handleLaneDoubleClick(track)}
              >
                {flat.sectionSpans.slice(1).map(span => (
                  <span
                    key={span.section.id}
                    className="st-section-line"
                    style={{ left: span.startMeasure * zoom }}
                    aria-hidden
                  />
                ))}
                {trackClips.map(clip => {
                  const isDragging = dragView?.clipId === clip.id && dragView.moved;
                  const start = isDragging ? (dragView as ClipDrag).start : clip.startMeasure;
                  const length = isDragging ? (dragView as ClipDrag).length : clip.lengthMeasures;
                  return (
                    <div
                      key={clip.id}
                      data-clip-id={clip.id}
                      className={`st-clip${selectedClipId === clip.id ? ' selected' : ''}${isDragging ? ' dragging' : ''}${dimmed ? ' muted' : ''}`}
                      style={
                        {
                          left: start * zoom,
                          width: length * zoom,
                          '--st-clip-hue': hue
                        } as CSSProperties
                      }
                      title={`${track.name} · bars ${start + 1}–${start + length} (double-click to delete)`}
                    >
                      <span className="st-clip-handle l" data-handle="l" />
                      <span className="st-clip-label">{track.name}</span>
                      <span className="st-clip-handle r" data-handle="r" />
                    </div>
                  );
                })}
                {isCreateGhost && dragView ? (
                  <div
                    className="st-clip ghost"
                    style={
                      {
                        left: dragView.start * zoom,
                        width: dragView.length * zoom,
                        '--st-clip-hue': hue
                      } as CSSProperties
                    }
                    aria-hidden
                  />
                ) : null}
              </div>
            </div>
          );
        })}

        <div className="st-row st-add-row">
          <div className="st-track-head st-add-head">
            <button type="button" className="re-secondary-btn st-add-track-btn" onClick={onAddTrack}>
              + Add track
            </button>
          </div>
          <div className="st-lane st-lane-empty" style={{ width: laneWidth }} />
        </div>

        {playheadLeft !== null ? <div className="st-playhead" style={{ left: playheadLeft }} aria-hidden /> : null}
      </div>
    </div>
  );
}
