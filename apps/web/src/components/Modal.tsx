import { useEffect, useRef, type ReactNode } from 'react';

export function Modal({
    children,
    onClose,
    wide = false
}: {
    children: ReactNode;
    onClose: () => void;
    wide?: boolean;
}) {
    const backdrop = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div
            ref={backdrop}
            className="modal-backdrop"
            onClick={(event) => { if (event.target === backdrop.current) onClose(); }}
        >
            <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
                {children}
            </div>
        </div>
    );
}
