import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

const openDialogs: HTMLElement[] = [];
const focusable = 'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]';
const tabStops = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLElement>(focusable))
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]')
        && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');

export function Modal({
    children,
    onClose,
    wide = false,
    className = '',
    labelledBy,
    label
}: {
    children: ReactNode;
    onClose: () => void;
    wide?: boolean;
    className?: string;
    labelledBy?: string;
    label?: string;
}) {
    const backdrop = useRef<HTMLDivElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const headingId = useId();
    const opener = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null);
    const close = useRef(onClose);
    close.current = onClose;

    useLayoutEffect(() => {
        const node = dialog.current;
        if (!node || labelledBy || label) return;
        const heading = node.querySelector<HTMLElement>('h1, h2, h3, [role="heading"]');
        if (heading) {
            if (!heading.id) heading.id = headingId;
            node.setAttribute('aria-labelledby', heading.id);
        }
    });

    useLayoutEffect(() => {
        const node = dialog.current;
        if (!node) return;
        openDialogs.push(node);
        const topmost = () => openDialogs.at(-1) === node;
        if (!node.contains(document.activeElement)) (tabStops(node)[0] || node).focus();
        const onKey = (event: KeyboardEvent) => {
            if (!topmost() || event.defaultPrevented) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                close.current();
            } else if (event.key === 'Tab') {
                const stops = tabStops(node);
                const first = stops[0];
                const last = stops.at(-1);
                if (!first) { event.preventDefault(); node.focus(); }
                else if (event.shiftKey && (document.activeElement === first || !stops.includes(document.activeElement as HTMLElement))) {
                    event.preventDefault(); last!.focus();
                } else if (!event.shiftKey && (document.activeElement === last || !stops.includes(document.activeElement as HTMLElement))) {
                    event.preventDefault(); first.focus();
                }
            }
        };
        const onFocus = (event: FocusEvent) => {
            if (topmost() && !node.contains(event.target as Node)) (tabStops(node)[0] || node).focus();
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('focusin', onFocus);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('focusin', onFocus);
            const index = openDialogs.indexOf(node);
            if (index >= 0) openDialogs.splice(index, 1);
            const target = opener.current;
            if (target?.isConnected && (!openDialogs.length || openDialogs.at(-1)!.contains(target))) target.focus();
        };
    }, []);
    return (
        <div
            ref={backdrop}
            className="modal-backdrop"
            onClick={(event) => { if (event.target === backdrop.current) onClose(); }}
        >
            <div ref={dialog} tabIndex={-1} className={`modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-label={label}>
                {children}
            </div>
        </div>
    );
}
