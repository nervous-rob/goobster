import { useCallback, useEffect, useState } from 'react';

const CLOSE_CHATS = 'goobster-close-chats';
const CLOSE_ROOMS = 'goobster-close-rooms';

export function closeConversationDrawer(): void {
    window.dispatchEvent(new Event(CLOSE_CHATS));
}

export function closeRoomDrawer(): void {
    window.dispatchEvent(new Event(CLOSE_ROOMS));
}

/**
 * Study / Parlor conversation library as a slide-over on narrow viewports.
 * Opening it closes the house-rooms drawer, and vice versa — two overlays
 * must not stack.
 */
export function useConversationDrawer() {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const toggle = useCallback(() => setOpen((current) => !current), []);

    useEffect(() => {
        window.addEventListener(CLOSE_CHATS, close);
        return () => window.removeEventListener(CLOSE_CHATS, close);
    }, [close]);

    useEffect(() => {
        if (!open) return;
        closeRoomDrawer();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, close]);

    return { open, close, toggle };
}

export function useRoomDrawerClose(close: () => void): void {
    useEffect(() => {
        window.addEventListener(CLOSE_ROOMS, close);
        return () => window.removeEventListener(CLOSE_ROOMS, close);
    }, [close]);
}
