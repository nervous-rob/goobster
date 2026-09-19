import { useEffect, useMemo, useRef } from 'react';
import { renderMarkdown } from '../renderers/markdown.js';
import { renderMathIn } from '../renderers/math.js';
import { decorateCodeBlocks } from '../renderers/codeblocks.js';
import { renderAttachments, disposeAttachments, attachmentsSignature } from '../renderers/attachments.js';

export type MarkdownAttachment = { url: string; name?: string; caption?: string; sourceUrl?: string; kind?: string };

type PinInfo = { source: string; language: string; title?: string; grants?: { observatoryRead: string[] } };

type Callbacks = {
    onNotify?: (message: string, isError?: boolean) => void;
    onPin?: (info: PinInfo) => void;
    onSaveToProject?: (info: PinInfo) => void;
    requestGrant?: (message: string) => Promise<boolean>;
};

/**
 * Message body + attachments.
 *
 * The Markdown/math/code blocks and the file attachments live in two
 * separate containers with separate effects:
 *
 *  - the body is re-rendered only when `source` changes (or a callback
 *    appears/disappears, which changes which buttons exist). Callback
 *    *identity* changes are absorbed by a ref, so a parent that recreates
 *    `onSaveToProject` on every render does not wipe the message DOM;
 *  - attachments are reconciled by durable key on a content signature, so
 *    a new array instance with the same files, or a body re-render, never
 *    refetches a preview or resets its collapsed/sort state. Unmounting
 *    aborts any in-flight preview fetch.
 */
export function Markdown({
    source,
    className,
    attachments,
    onNotify,
    onPin,
    onSaveToProject,
    requestGrant
}: {
    source: string;
    className?: string;
    attachments?: MarkdownAttachment[];
} & Callbacks) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const filesRef = useRef<HTMLDivElement>(null);

    const callbacks = useRef<Callbacks>({});
    callbacks.current = { onNotify, onPin, onSaveToProject, requestGrant };
    const hasPin = typeof onPin === 'function';
    const hasSave = typeof onSaveToProject === 'function';
    const hasGrant = typeof requestGrant === 'function';
    // Stable proxies: their identity never changes, they forward to the
    // latest props. Only presence is reflected so the decorator can still
    // decide which buttons to draw.
    const stable = useMemo(() => ({
        onNotify: (message: string, isError?: boolean) => callbacks.current.onNotify?.(message, isError),
        onPin: hasPin ? (info: PinInfo) => callbacks.current.onPin?.(info) : undefined,
        onSaveToProject: hasSave ? (info: PinInfo) => callbacks.current.onSaveToProject?.(info) : undefined,
        requestGrant: hasGrant
            ? (message: string) => callbacks.current.requestGrant?.(message) ?? Promise.resolve(false)
            : undefined
    }), [hasPin, hasSave, hasGrant]);

    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        el.innerHTML = renderMarkdown(source || '');
        decorateCodeBlocks(el, stable.onNotify, {
            onPin: stable.onPin,
            onSaveToProject: stable.onSaveToProject,
            requestGrant: stable.requestGrant
        });
        renderMathIn(el);
    }, [source, stable]);

    const latestAttachments = useRef<MarkdownAttachment[] | undefined>(attachments);
    latestAttachments.current = attachments;
    const signature = attachmentsSignature(attachments);
    useEffect(() => {
        const el = filesRef.current;
        if (!el) return;
        renderAttachments(el, latestAttachments.current || []);
    }, [signature]);
    useEffect(() => {
        const el = filesRef.current;
        return () => { disposeAttachments(el); };
    }, []);

    return (
        <div className={className}>
            <div ref={bodyRef} className="md-body" />
            <div ref={filesRef} className="msg-attachments" />
        </div>
    );
}
