import { useEffect, useRef, useState, type DragEvent } from 'react';
import { isAttachmentDrag, readAttachmentDrop, resolveAttachmentDrop, type AttachmentDrop } from '../lib/attachmentDrop';
import { useToast } from './useToast';

export function useAttachmentDrop({ onDrop, disabled = false, label, resetKey = '' }: {
    onDrop: (drop: AttachmentDrop) => void | Promise<void>;
    disabled?: boolean;
    label: string;
    resetKey?: string;
}) {
    const toast = useToast();
    const [active, setActive] = useState(false);
    const [busy, setBusy] = useState(false);
    const depth = useRef(0);
    const pending = useRef(false);
    const controller = useRef<AbortController | null>(null);
    const current = useRef({ onDrop, disabled, resetKey });
    current.current = { onDrop, disabled, resetKey };
    useEffect(() => {
        pending.current = false;
        setBusy(false);
        setActive(false);
        depth.current = 0;
        const reset = () => { depth.current = 0; setActive(false); };
        window.addEventListener('dragend', reset);
        window.addEventListener('drop', reset, true);
        window.addEventListener('blur', reset);
        return () => {
            controller.current?.abort();
            window.removeEventListener('dragend', reset);
            window.removeEventListener('drop', reset, true);
            window.removeEventListener('blur', reset);
        };
    }, [resetKey]);
    function claim(event: DragEvent<HTMLElement>) {
        if (!isAttachmentDrag(event.dataTransfer)) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
    }
    const dropProps = {
        'data-attachment-drop': label,
        onDragEnter(event: DragEvent<HTMLElement>) {
            if (!claim(event)) return;
            depth.current++;
            if (!disabled && !pending.current) setActive(true);
        },
        onDragOver(event: DragEvent<HTMLElement>) {
            if (claim(event)) event.dataTransfer.dropEffect = disabled || pending.current ? 'none' : 'copy';
        },
        onDragLeave(event: DragEvent<HTMLElement>) {
            if (!claim(event)) return;
            depth.current = Math.max(0, depth.current - 1);
            if (!depth.current) setActive(false);
        },
        onDrop(event: DragEvent<HTMLElement>) {
            if (!claim(event)) return;
            depth.current = 0;
            setActive(false);
            if (disabled || pending.current) { toast('Wait for the current attachment operation to finish.', true); return; }
            const snapshot = readAttachmentDrop(event.dataTransfer);
            const abort = new AbortController();
            controller.current = abort;
            pending.current = true;
            setBusy(true);
            void resolveAttachmentDrop(snapshot, abort.signal).then(async drop => {
                if (abort.signal.aborted || current.current.resetKey !== resetKey) return;
                if (current.current.disabled) { toast('The attachment destination changed. Drop the files again when it is ready.', true); return; }
                drop.warnings.forEach(message => toast(message, true));
                if (drop.files.length || drop.links.length) await current.current.onDrop(drop);
            }).catch(error => {
                if (!abort.signal.aborted) toast((error as Error).message, true);
            }).finally(() => {
                if (controller.current === abort) {
                    pending.current = false;
                    if (!abort.signal.aborted) setBusy(false);
                }
            });
        }
    };
    const indicator = (active || busy) ? <div className="attachment-drop-indicator" role="status">{busy ? 'Preparing attachments…' : label}</div> : null;
    return { dropProps, indicator, busy };
}
