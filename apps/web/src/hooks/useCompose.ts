import { useEffect } from 'react';

/**
 * Put text into the chat composer that is on screen, for the person to
 * review and send (a tool card's "Ask Goobster to fix"). Never sends.
 */
const COMPOSE_EVENT = 'goobster-compose';

export function requestCompose(text: string) {
    window.dispatchEvent(new CustomEvent<{ text: string }>(COMPOSE_EVENT, { detail: { text } }));
}

/** Composers listen: an empty composer takes the text, a draft keeps it and gets the text appended. */
export function useComposeListener(setComposer: (update: (current: string) => string) => void, enabled = true) {
    useEffect(() => {
        if (!enabled) return undefined;
        const onCompose = (event: Event) => {
            const text = (event as CustomEvent<{ text: string }>).detail?.text;
            if (!text) return;
            setComposer((current) => (current.trim() ? `${current.trimEnd()}\n\n${text}` : text));
        };
        window.addEventListener(COMPOSE_EVENT, onCompose);
        return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
    }, [setComposer, enabled]);
}
