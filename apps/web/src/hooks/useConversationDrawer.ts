import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

const CLOSE_CHATS = 'goobster-close-chats';
const CLOSE_ROOMS = 'goobster-close-rooms';

export function closeConversationDrawer(): void {
    window.dispatchEvent(new Event(CLOSE_CHATS));
}

export function closeRoomDrawer(): void {
    window.dispatchEvent(new Event(CLOSE_ROOMS));
}

/** Side-column width bounds (px) and the default the double-click restores. */
export const CONVS_WIDTH_DEFAULT = 260;
export const CONVS_WIDTH_MIN = 200;
export const CONVS_WIDTH_MAX = 480;
/** Dragging this far below the minimum hides the column, like other chat apps. */
const COLLAPSE_DRAG_PX = 80;

const clampWidth = (value: number) => Math.round(Math.min(CONVS_WIDTH_MAX, Math.max(CONVS_WIDTH_MIN, value)));

function readStored(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeStored(key: string, value: string): void {
    try { window.localStorage.setItem(key, value); } catch { /* private window: this session only */ }
}

/**
 * The Study / Parlor conversation library. On a wide pane it is a side
 * column the reader can hide and drag to any width between 200 and 480px
 * (remembered on this device per surface); on a narrow pane it becomes a
 * slide-over drawer. Opening the drawer closes the house-rooms drawer, and
 * vice versa — two overlays must not stack.
 *
 * `toggle` does the right thing for the current layout: it opens/closes
 * the drawer when the library is a slide-over, and shows/hides the column
 * otherwise. Spread `paneClassName` / `paneStyle` on the pane, `panelRef`
 * on the library `<aside>` and `resizerProps` on the drag handle.
 */
export function useConversationDrawer(surface: 'chat' | 'parlor' = 'chat') {
    const collapsedKey = `goobster-convs-collapsed-${surface}`;
    const widthKey = `goobster-convs-width-${surface}`;
    const [open, setOpen] = useState(false);
    const [collapsed, setCollapsedState] = useState(() => readStored(collapsedKey) === '1');
    const [width, setWidth] = useState(() => {
        const stored = Number(readStored(widthKey));
        return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : CONVS_WIDTH_DEFAULT;
    });
    const [dragging, setDragging] = useState(false);
    const panelRef = useRef<HTMLElement | null>(null);
    const drag = useRef<{ startX: number; startWidth: number; raw: number } | null>(null);

    const close = useCallback(() => setOpen(false), []);
    const setCollapsed = useCallback((next: boolean) => {
        setCollapsedState(next);
        writeStored(collapsedKey, next ? '1' : '0');
    }, [collapsedKey]);
    const commitWidth = useCallback((next: number) => {
        const clamped = clampWidth(next);
        setWidth(clamped);
        writeStored(widthKey, String(clamped));
    }, [widthKey]);

    // The narrow layout positions the library as a fixed slide-over.
    const isDrawer = useCallback(() => {
        const el = panelRef.current;
        return !el || window.getComputedStyle(el).position === 'fixed';
    }, []);
    const toggle = useCallback(() => {
        if (isDrawer()) setOpen((current) => !current);
        else setCollapsed(!collapsed);
    }, [isDrawer, setCollapsed, collapsed]);

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

    const resizerProps = {
        role: 'separator' as const,
        'aria-orientation': 'vertical' as const,
        'aria-label': 'Resize the conversation list',
        'aria-valuemin': CONVS_WIDTH_MIN,
        'aria-valuemax': CONVS_WIDTH_MAX,
        'aria-valuenow': width,
        tabIndex: 0,
        title: 'Drag to resize · double-click to reset',
        className: `convs-resizer${dragging ? ' dragging' : ''}`,
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { startX: event.clientX, startWidth: width, raw: width };
            setDragging(true);
        },
        onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
            if (!drag.current) return;
            const raw = drag.current.startWidth + event.clientX - drag.current.startX;
            drag.current.raw = raw;
            setWidth(clampWidth(raw));
        },
        onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
            const state = drag.current;
            drag.current = null;
            setDragging(false);
            try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
            if (!state) return;
            if (state.raw < CONVS_WIDTH_MIN - COLLAPSE_DRAG_PX) {
                setWidth(state.startWidth);
                setCollapsed(true);
                return;
            }
            commitWidth(state.raw);
        },
        onPointerCancel: () => {
            if (drag.current) setWidth(drag.current.startWidth);
            drag.current = null;
            setDragging(false);
        },
        onDoubleClick: () => commitWidth(CONVS_WIDTH_DEFAULT),
        onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
            const step = event.shiftKey ? 48 : 16;
            if (event.key === 'ArrowLeft') { event.preventDefault(); commitWidth(width - step); }
            else if (event.key === 'ArrowRight') { event.preventDefault(); commitWidth(width + step); }
            else if (event.key === 'Home') { event.preventDefault(); commitWidth(CONVS_WIDTH_MIN); }
            else if (event.key === 'End') { event.preventDefault(); commitWidth(CONVS_WIDTH_MAX); }
            else if (event.key === 'Enter') { event.preventDefault(); setCollapsed(true); }
        }
    };

    return {
        open,
        close,
        toggle,
        collapsed,
        expand: useCallback(() => setCollapsed(false), [setCollapsed]),
        collapse: useCallback(() => setCollapsed(true), [setCollapsed]),
        panelRef,
        resizerProps,
        paneClassName: `${collapsed ? ' convs-collapsed' : ''}${dragging ? ' convs-resizing' : ''}`,
        paneStyle: { '--convs-width': `${width}px` } as CSSProperties
    };
}

export function useRoomDrawerClose(close: () => void): void {
    useEffect(() => {
        window.addEventListener(CLOSE_ROOMS, close);
        return () => window.removeEventListener(CLOSE_ROOMS, close);
    }, [close]);
}
