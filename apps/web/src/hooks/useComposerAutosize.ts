import { useCallback, useEffect, useLayoutEffect, type RefObject } from 'react';

/**
 * Grow a composer textarea with its draft, up to the CSS max-height. At
 * the cap it scrolls inside the box so a long message stays editable.
 * `field-sizing: content` does the same in supporting browsers; this
 * covers the rest and keeps height in sync after a viewport rotate.
 */
export function useComposerAutosize(
    ref: RefObject<HTMLTextAreaElement | null>,
    value: string
): void {
    const fit = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [ref]);

    useLayoutEffect(() => {
        fit();
    }, [fit, value]);

    useEffect(() => {
        window.addEventListener('resize', fit);
        return () => window.removeEventListener('resize', fit);
    }, [fit]);
}
