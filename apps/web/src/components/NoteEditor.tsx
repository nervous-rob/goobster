import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal } from './Modal';
import { useToast } from '../hooks/useToast';
import { api } from '../lib/api';
import type { UserNote } from '../lib/types';

const NODE_TYPES = [
    'concept', 'fact', 'opinion', 'experience',
    'person', 'place', 'event', 'thing', 'artifact'
] as const;

const MAX_CONTENT = 1000;

function parseTags(value: string): string[] {
    return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

export function NoteEditor({
    scope,
    note,
    onClose,
    onSaved
}: {
    scope: string;
    note: UserNote | null;
    onClose: () => void;
    onSaved: (note: UserNote) => void;
}) {
    const toast = useToast();
    const [label, setLabel] = useState(note?.label || '');
    const [content, setContent] = useState(note?.content || '');
    const [type, setType] = useState(note?.type || 'concept');
    const [tags, setTags] = useState((note?.tags || []).join(', '));
    const save = useMutation({
        mutationFn: async () => {
            const fields = {
                label: label.trim(),
                content: content.trim(),
                type,
                tags: parseTags(tags)
            };
            if (note) {
                return api.spitballUpdateNote(scope, note.id, fields) as Promise<{ note: UserNote }>;
            }
            return api.spitballCreateNote(scope, fields) as Promise<{ note: UserNote }>;
        },
        onSuccess: (result) => {
            toast(note ? 'Note updated.' : 'Note added.');
            onSaved(result.note);
        },
        onError: (error) => toast((error as Error).message, true)
    });
    return (
        <Modal onClose={onClose} wide className="note-editor-modal">
            <h2>{note ? 'Edit note' : 'New note'}</h2>
            <div className="note-editor-grid">
                <div className="field">
                    <label htmlFor="note-title">Title</label>
                    <input
                        id="note-title"
                        className="input"
                        maxLength={120}
                        placeholder="A short, unique title"
                        value={label}
                        onChange={(event) => setLabel(event.target.value)}
                    />
                </div>
                <div className="field">
                    <label htmlFor="note-type">Type</label>
                    <select
                        id="note-type"
                        className="select"
                        value={type}
                        onChange={(event) => setType(event.target.value)}
                    >
                        {NODE_TYPES.map((item) => (
                            <option key={item} value={item}>{item}</option>
                        ))}
                    </select>
                </div>
            </div>
            <div className="field">
                <label htmlFor="note-content">Content</label>
                <textarea
                    id="note-content"
                    className="input"
                    rows={8}
                    maxLength={MAX_CONTENT}
                    placeholder="What this note should say"
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                />
                <div className="hint">{content.length}/{MAX_CONTENT}</div>
            </div>
            <div className="field">
                <label htmlFor="note-tags">Tags</label>
                <input
                    id="note-tags"
                    className="input"
                    placeholder="Tags, comma-separated"
                    value={tags}
                    onChange={(event) => setTags(event.target.value)}
                />
            </div>
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn primary"
                    disabled={save.isPending || !label.trim()}
                    onClick={() => save.mutate()}
                >
                    {note ? 'Save' : 'Add note'}
                </button>
            </div>
        </Modal>
    );
}
