import { useCallback, useEffect, useState } from 'react';

/**
 * The wizard's place, kept in the URL hash (`#/<journey>/<step>[/<operationId>]`).
 * The hash is never sent to a server, and an operation id is not a secret:
 * reloading the page, or pressing Back, returns to the same step, and a
 * running operation is found again from the id. Nothing else (no answer, no
 * credential) is ever put in the URL.
 */
export type Place = { journey: string; step: string; id: string | null };

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export function parseHash(hash: string): Place {
    const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const [journey = '', step = '', id = ''] = parts;
    return {
        journey: SEGMENT.test(journey) ? journey : '',
        step: SEGMENT.test(step) ? step : '',
        id: SEGMENT.test(id) ? id : null
    };
}

export function hashOf(place: Partial<Place> & { journey: string }): string {
    const parts = [place.journey];
    if (place.step || place.id) parts.push(place.step || '-');
    if (place.id) parts.push(place.id);
    return `#/${parts.join('/')}`;
}

export function useRoute(): { place: Place; go: (place: Partial<Place> & { journey: string }, options?: { replace?: boolean }) => void } {
    const [place, setPlace] = useState<Place>(() => parseHash(window.location.hash));
    useEffect(() => {
        const sync = () => setPlace(parseHash(window.location.hash));
        window.addEventListener('hashchange', sync);
        window.addEventListener('popstate', sync);
        return () => {
            window.removeEventListener('hashchange', sync);
            window.removeEventListener('popstate', sync);
        };
    }, []);
    const go = useCallback((next: Partial<Place> & { journey: string }, options: { replace?: boolean } = {}) => {
        const hash = hashOf(next);
        if (options.replace) {
            window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
            setPlace(parseHash(hash));
        } else {
            window.location.hash = hash;
        }
        window.scrollTo?.({ top: 0 });
    }, []);
    return { place, go };
}
