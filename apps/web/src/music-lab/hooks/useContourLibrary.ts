import { useMemo, useSyncExternalStore } from 'react';
import {
  CONTOUR_PRESETS,
  getCustomContoursSnapshot,
  getServerContoursSnapshot,
  removeCustomContour,
  saveCustomContour,
  subscribeCustomContours
} from '@music-lab/lib/stageData';

/**
 * Reactive view of the contour library: core + genre-library presets merged
 * with user-drawn contours. All components share one store, so saving in the
 * Contour Designer immediately updates every contour dropdown on the page.
 */
export function useContourLibrary() {
  const customContours = useSyncExternalStore(
    subscribeCustomContours,
    getCustomContoursSnapshot,
    getServerContoursSnapshot
  );

  const allContours = useMemo(() => [...CONTOUR_PRESETS, ...customContours], [customContours]);

  return { customContours, allContours, saveContour: saveCustomContour, deleteContour: removeCustomContour };
}
