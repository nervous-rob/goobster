import { useEffect, useRef } from 'react';
import { renderMarkdown } from '../renderers/markdown.js';
import { renderMathIn } from '../renderers/math.js';
import { decorateCodeBlocks, renderAttachments } from '../renderers/codeblocks.js';

export function Markdown({
    source,
    className,
    attachments,
    onNotify,
    onPin,
    requestGrant
}: {
    source: string;
    className?: string;
    attachments?: Array<{ url: string; name?: string }>;
    onNotify?: (message: string, isError?: boolean) => void;
    onPin?: (info: { source: string; language: string; title?: string; grants?: { observatoryRead: string[] } }) => void;
    requestGrant?: (message: string) => Promise<boolean>;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.innerHTML = renderMarkdown(source || '');
        decorateCodeBlocks(el, onNotify || (() => {}), { onPin, requestGrant });
        renderMathIn(el);
        if (attachments?.length) renderAttachments(el, attachments);
    }, [source, attachments, onNotify, onPin, requestGrant]);
    return <div ref={ref} className={className} />;
}
