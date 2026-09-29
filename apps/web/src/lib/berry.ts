import { useEffect, useState } from 'react';
import { type AccentChoice, getStoredAccent, isAccent } from './theme';

/**
 * The Goobster mark in the accent that is painted right now. The berries
 * live at /app/icons/berry/<accent>.svg (rendered from icons/goobster.svg by
 * scripts/generate-berry-icons.js); Blueberry is the master itself. The
 * painted accent is `html[data-accent]`, so a live preview in Appearance
 * recolours the mark before anything is saved.
 */
export function berryIconSrc(accent: AccentChoice): string {
    return `/app/icons/berry/${accent}.svg`;
}

export function paintedAccent(): AccentChoice {
    const painted = document.documentElement.dataset.accent;
    return isAccent(painted) ? painted : getStoredAccent();
}

/** The painted accent as React state, following `html[data-accent]`. */
export function usePaintedAccent(): AccentChoice {
    const [accent, setAccent] = useState<AccentChoice>(() => paintedAccent());
    useEffect(() => {
        const observer = new MutationObserver(() => setAccent(paintedAccent()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-accent'] });
        setAccent(paintedAccent());
        return () => observer.disconnect();
    }, []);
    return accent;
}
