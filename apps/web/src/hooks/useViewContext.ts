import { useEffect, useSyncExternalStore } from 'react';
import { languageFromPath, type EditorSelection } from '../components/CodeEditor';

/**
 * What the person is looking at on a project page (the open file, the
 * selected lines, the current app), published by the views and shown in
 * the chat dock as removable chips; what is kept goes with the next
 * message. Client-side only: nothing is stored, and a view's entry goes
 * away when the view does.
 */
export type ViewContextItem = {
    /** Stable per thing shown (a new file or selection is a new id). */
    id: string;
    kind: 'file' | 'selection' | 'app';
    /** Chip text. */
    label: string;
    /** What goes into the message. */
    text: string;
};

/** Selected text sent with a message is capped (the transcript is shared). */
export const VIEW_CONTEXT_SELECTION_MAX = 4000;

const slots = new Map<string, ViewContextItem>();
const listeners = new Set<() => void>();
let snapshot: ViewContextItem[] = [];

function emit() {
    snapshot = [...slots.values()];
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Publish (or with null, withdraw) one view's entry under `slot`. */
export function usePublishViewContext(slot: string, item: ViewContextItem | null) {
    const id = item?.id ?? null;
    const label = item?.label ?? null;
    const text = item?.text ?? null;
    const kind = item?.kind ?? null;
    useEffect(() => {
        if (id == null || kind == null) {
            if (slots.delete(slot)) emit();
            return undefined;
        }
        slots.set(slot, { id, kind, label: label || '', text: text || '' });
        emit();
        return () => {
            if (slots.get(slot)?.id === id && slots.delete(slot)) emit();
        };
    }, [slot, id, kind, label, text]);
}

/** Every published entry, in publishing order. */
export function useViewContext(): ViewContextItem[] {
    return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** The context entries for an open file and its selection (the editors). */
export function fileContextItems(fullPath: string, selection: EditorSelection | null, note = ''): {
    file: ViewContextItem;
    selection: ViewContextItem | null;
} {
    const file: ViewContextItem = {
        id: `file:${fullPath}`,
        kind: 'file',
        label: fullPath,
        text: `Open file: ${fullPath}${note}`
    };
    if (!selection || selection.empty || !selection.text.trim()) return { file, selection: null };
    const lines = selection.fromLine === selection.toLine ? `line ${selection.fromLine}` : `lines ${selection.fromLine}–${selection.toLine}`;
    const lang = languageFromPath(fullPath);
    const body = selection.text.length > VIEW_CONTEXT_SELECTION_MAX
        ? `${selection.text.slice(0, VIEW_CONTEXT_SELECTION_MAX)}\n… (cut)`
        : selection.text;
    return {
        file,
        selection: {
            id: `selection:${fullPath}:${selection.fromLine}-${selection.toLine}:${selection.text.length}`,
            kind: 'selection',
            label: lines,
            text: `Selected ${lines} of ${fullPath}${note}:\n\`\`\`${lang === 'text' ? '' : lang}\n${body}\n\`\`\``
        }
    };
}

/**
 * The block that goes in front of a message for the kept entries; an entry
 * whose content the message already quotes (an "Ask Goobster about lines"
 * request) is left out.
 */
export function viewContextBlock(items: ViewContextItem[], message: string): string {
    const kept = items.filter((item) => {
        if (item.kind !== 'selection') return true;
        const code = item.text.split('\n').slice(1, 4).join('\n').trim();
        return !(code && message.includes(code));
    });
    if (!kept.length) return '';
    const plain = kept.filter((item) => item.kind !== 'selection').map((item) => item.text);
    const selections = kept.filter((item) => item.kind === 'selection').map((item) => item.text);
    return [...(plain.length ? [`(Context: ${plain.join(' · ')})`] : []), ...selections].join('\n');
}
