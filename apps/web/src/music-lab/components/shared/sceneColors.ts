/**
 * The portal accent as an "r, g, b" triplet, read from the element's
 * `--re-accent-rgb` (rhythm.css). Inside a scene container that is the
 * dark-surface accent, so a canvas drawn on a night backdrop keeps contrast
 * in either theme.
 */
export function sceneAccentRgb(el: Element): string {
  return getComputedStyle(el).getPropertyValue('--re-accent-rgb').trim() || '245, 158, 11';
}
