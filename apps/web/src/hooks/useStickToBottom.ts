import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/** How close to the end still counts as "reading the latest". */
const PIN_SLACK_PX = 80;

/**
 * Keep a transcript scrolled to its newest message while the reader is
 * already there, and leave it alone once they scroll up to read. `version`
 * is anything that changes when the transcript does (the message array,
 * streamed text). `pin()` re-attaches - call it when the reader sends a
 * message or switches conversation. Spread `onScroll` on the scroller.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, version: unknown) {
    const pinned = useRef(true);

    const onScroll = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
    }, [ref]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (el && pinned.current) el.scrollTop = el.scrollHeight;
    }, [ref, version]);

    const pin = useCallback(() => {
        pinned.current = true;
        const el = ref.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [ref]);

    return { onScroll, pin };
}
