import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { TransferNoteModal } from './TransferNoteModal';
import type { SaveMessageAsNoteResult, UserNote } from '../lib/types';

const MAX_LABEL = 120;
const MAX_CONTENT = 1000;

/** A title from the answer: its first heading, else its first line, markup stripped. */
export function suggestNoteTitle(text: string): string {
    const source = String(text || '');
    const heading = source.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
    let candidate = heading ? heading[1] : '';
    if (!candidate) {
        const firstLine = source
            .split('\n')
            .map((line) => line.replace(/^[\s>*\-•\d.)]+/, '').trim())
            .find((line) => line.length > 0) || '';
        const sentence = firstLine.match(/^(.+?[.!?])(\s|$)/);
        candidate = sentence ? sentence[1] : firstLine;
    }
    candidate = candidate
        .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/[:\s]+$/, '')
        .trim();
    if (candidate.length <= MAX_LABEL) return candidate;
    return `${candidate.slice(0, MAX_LABEL - 1).trimEnd()}…`;
}

function parseTags(value: string): string[] {
    return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

/**
 * Save an assistant answer as a note (ADR 0010 §2). The note lands in the
 * caller's personal scope with curation `saved` and provenance back to
 * the message, so it appears under Knowledge → Notes and on the Map with
 * no client-side filter. Incognito chats never open this. After saving,
 * the next hop - Add to project… - is offered on the note just made.
 */
export function SaveNoteModal({
    conversationId,
    messageId,
    content,
    onClose
}: {
    conversationId: number;
    messageId: number;
    content: string;
    onClose: () => void;
}) {
    const me = useMe();
    const toast = useToast();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [label, setLabel] = useState(() => suggestNoteTitle(content));
    const [text, setText] = useState(() => content.trim().slice(0, MAX_CONTENT));
    const [tags, setTags] = useState('');
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState<UserNote | null>(null);
    const [transferring, setTransferring] = useState(false);
    const trimmedByCap = content.trim().length > MAX_CONTENT;

    async function save() {
        if (!label.trim()) { toast('Give the note a title.', true); return; }
        setBusy(true);
        try {
            const result = await api.saveMessageAsNote({
                conversationId,
                messageId,
                label: label.trim(),
                content: text,
                tags: parseTags(tags)
            }) as SaveMessageAsNoteResult;
            const scope = `dm:${me.user.id}`;
            await queryClient.invalidateQueries({ queryKey: keys.spitballNotesRoot(scope) });
            await queryClient.invalidateQueries({ queryKey: keys.constellationRoot(scope) });
            setSaved(result.note);
            toast(`Saved “${result.note.label}” to your notes.`);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(false);
        }
    }

    if (saved && transferring) {
        return (
            <TransferNoteModal
                note={saved}
                onClose={onClose}
            />
        );
    }

    if (saved) {
        return (
            <Modal onClose={onClose} className="save-note-modal">
                <h2>Saved as a note</h2>
                <p className="hint" data-testid="save-note-done">
                    “{saved.label}” is in Knowledge → Notes and on your Map, filed with what you kept — not with what Goobster
                    inferred about you. It remembers which answer it came from.
                </p>
                <div className="modal-actions">
                    <button type="button" className="btn" onClick={onClose}>Done</button>
                    <button
                        type="button"
                        className="btn"
                        onClick={() => { onClose(); void navigate({ to: '/knowledge/notes' as never }); }}
                    >
                        Open Notes
                    </button>
                    {me.features?.projects !== false && (
                        <button
                            type="button"
                            className="btn primary"
                            data-testid="save-note-add-to-project"
                            onClick={() => setTransferring(true)}
                        >
                            Add to project…
                        </button>
                    )}
                </div>
            </Modal>
        );
    }

    return (
        <Modal onClose={onClose} wide className="save-note-modal">
            <h2>Save as note</h2>
            <p className="hint">
                Keeps this answer with your knowledge (Knowledge → Notes). It stays private until you add it to a project or a discussion.
            </p>
            <div className="field">
                <label htmlFor="save-note-title">Title</label>
                <input
                    id="save-note-title"
                    className="input"
                    maxLength={MAX_LABEL}
                    value={label}
                    data-testid="save-note-title"
                    onChange={(event) => setLabel(event.target.value)}
                />
            </div>
            <div className="field">
                <label htmlFor="save-note-content">Content</label>
                <textarea
                    id="save-note-content"
                    className="input"
                    rows={8}
                    maxLength={MAX_CONTENT}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                />
                <div className="hint">
                    {text.length}/{MAX_CONTENT}
                    {trimmedByCap ? ' · the answer was longer than a note holds, so it was trimmed - edit as you like.' : ''}
                </div>
            </div>
            <div className="field">
                <label htmlFor="save-note-tags">Tags</label>
                <input
                    id="save-note-tags"
                    className="input"
                    placeholder="Tags, comma-separated (optional)"
                    value={tags}
                    onChange={(event) => setTags(event.target.value)}
                />
            </div>
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn primary"
                    data-testid="save-note-submit"
                    disabled={busy || !label.trim() || !text.trim()}
                    onClick={() => void save()}
                >
                    {busy ? 'Saving…' : 'Save note'}
                </button>
            </div>
        </Modal>
    );
}
