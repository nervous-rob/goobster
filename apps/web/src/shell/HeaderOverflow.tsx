import { useEffect, useState, type ReactNode } from 'react';

/** Desktop: children sit inline (`display: contents`). Phone: a ⋯ dropdown. */
export function HeaderOverflow({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        const onDoc = (event: MouseEvent) => {
            const target = event.target as Element | null;
            if (!target?.closest('.header-overflow, .more-btn')) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    return (
        <>
            <button
                type="button"
                className="icon-action more-btn"
                title="More actions"
                aria-label="More actions"
                aria-haspopup="true"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
            >⋯</button>
            <div className={`header-overflow${open ? ' open' : ''}`}>
                {children}
            </div>
        </>
    );
}
